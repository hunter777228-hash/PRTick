require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const ChatHandler = require('./chat-handler');

// ============ ВАЛИДАЦИЯ ENV ============
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
if (Number.isNaN(ADMIN_ID) || ADMIN_ID <= 0) {
    console.error('❌ FATAL: ADMIN_ID не задан или некорректен');
    process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.length < 20) {
    console.error('❌ FATAL: TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
}
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgres')) {
    console.error('❌ FATAL: DATABASE_URL не задан');
    process.exit(1);
}

// ============ БАЗА ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// ============ БОТ ============
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const chatHandler = new ChatHandler(bot);
let BOT_USERNAME = null;
let BOT_ID = null;

// ============ EXPRESS ============
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.get('/', (req, res) => res.json({ status: 'running', bot: BOT_USERNAME }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// ============ КОНСТАНТЫ ============
const REFERRAL_BONUS = 0.05;
const MIN_TASK_REWARD = 0.05;
const MAX_TASK_REWARD = 10;
const GIFT_COST = 15;
const MIN_WITHDRAW = 15;
const USERNAME_REGEX = /^@[a-zA-Z0-9_]{5,32}$/;
const CHANNEL_REGEX = /^[a-zA-Z0-9_]{5,32}$/;
const WITHDRAW_TIMEOUT_MS = 10 * 60 * 1000;
const SCREENSHOT_TIMEOUT_MS = 10 * 60 * 1000;
const TASKS_PAGE_SIZE = 5;
const MAX_MSG_LEN = 4000;
const MAX_PENDING_SUBMISSIONS = 5;

// userId -> { ts, promptSent }
const awaitingWithdraw = new Map();
// userId -> { taskId, ts }
const awaitingScreenshot = new Map();

// ============ ХЕЛПЕРЫ ============
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatStars(n) {
    const num = parseFloat(n);
    if (Number.isNaN(num)) return '0';
    // Если целое — показываем без десятичных
    if (Number.isInteger(num)) return String(num);
    // Иначе — обрезаем лишние нули
    return num.toFixed(4).replace(/\.?0+$/, '');
}

async function safeSend(chatId, text, opts = {}) {
    try {
        return await bot.sendMessage(chatId, text, opts);
    } catch (e) {
        console.error(`safeSend to ${chatId}:`, e.message);
        return null;
    }
}

function trimIfLong(text) {
    if (text.length <= MAX_MSG_LEN) return text;
    return text.slice(0, MAX_MSG_LEN - 100) + '\n\n... (обрезано)';
}

// ============ DB ============
const db = {
    async getUser(userId) {
        const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        return r.rows[0];
    },
    async createUser(userId, username, firstName, referredBy = null) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const existing = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
            const isNew = existing.rowCount === 0;

            const r = await client.query(
                `INSERT INTO users (id, username, first_name, referred_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE
                   SET username = EXCLUDED.username,
                       first_name = EXCLUDED.first_name
                 RETURNING *`,
                [userId, username, firstName, referredBy]
            );

            if (referredBy && isNew) {
                const refExists = await client.query('SELECT id FROM users WHERE id = $1', [referredBy]);
                if (refExists.rowCount > 0) {
                    await client.query(
                        `UPDATE users SET balance = balance + $1, referral_count = referral_count + 1 WHERE id = $2`,
                        [REFERRAL_BONUS, referredBy]
                    );
                    await client.query(
                        `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
                        [referredBy, REFERRAL_BONUS, 'referral_bonus', `Бонус за ${username || userId}`]
                    );
                }
            }
            await client.query('COMMIT');
            return r.rows[0];
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    },
    async updateBalance(userId, amount, type, description) {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
            await c.query(
                `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
                [userId, amount, type, description]
            );
            await c.query('COMMIT');
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    },
    async getActiveTasks(excludeUserId = null, limit = 100) {
        let query = `SELECT t.*, u.username as owner_username FROM tasks t
                     JOIN users u ON t.owner_id = u.id
                     WHERE t.is_active = true
                       AND t.total_budget >= (t.completed_count + 1) * t.reward`;
        const params = [];
        if (excludeUserId) {
            query += ' AND t.owner_id != $1';
            params.push(excludeUserId);
        }
        query += ' ORDER BY t.created_at DESC LIMIT $' + (params.length + 1);
        params.push(limit);
        const r = await pool.query(query, params);
        return r.rows;
    },
    async createTask(ownerId, channelUsername, reward, totalBudget) {
        const r = await pool.query(
            `INSERT INTO tasks (owner_id, channel_username, reward, total_budget)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [ownerId, channelUsername, reward, totalBudget]
        );
        return r.rows[0];
    },
    async createSubmission(taskId, userId, screenshotFileId) {
        const pendingCount = await pool.query(
            `SELECT COUNT(*) FROM submissions WHERE user_id = $1 AND status = 'pending'`,
            [userId]
        );
        if (parseInt(pendingCount.rows[0].count, 10) >= MAX_PENDING_SUBMISSIONS) {
            throw new Error('TOO_MANY_PENDING');
        }

        const ownCheck = await pool.query(`SELECT owner_id FROM tasks WHERE id = $1`, [taskId]);
        if (ownCheck.rowCount > 0 && ownCheck.rows[0].owner_id === userId) {
            throw new Error('OWN_TASK');
        }

        const sameShot = await pool.query(
            `SELECT id FROM submissions WHERE user_id = $1 AND screenshot_file_id = $2`,
            [userId, screenshotFileId]
        );
        if (sameShot.rowCount > 0) {
            throw new Error('SAME_SCREENSHOT');
        }

        const existing = await pool.query(
            `SELECT id FROM submissions WHERE task_id = $1 AND user_id = $2 AND status = 'pending'`,
            [taskId, userId]
        );
        if (existing.rowCount > 0) throw new Error('ALREADY_PENDING');

        const done = await pool.query(
            `SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2`,
            [taskId, userId]
        );
        if (done.rowCount > 0) throw new Error('ALREADY_DONE');

        const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
        const task = taskRes.rows[0];
        if (!task || !task.is_active) throw new Error('NOT_FOUND');
        if (parseFloat(task.total_budget) < (task.completed_count + 1) * parseFloat(task.reward)) {
            throw new Error('BUDGET_EMPTY');
        }

        const r = await pool.query(
            `INSERT INTO submissions (user_id, task_id, screenshot_file_id) VALUES ($1, $2, $3) RETURNING id`,
            [userId, taskId, screenshotFileId]
        );
        return { id: r.rows[0].id, task };
    },
    async approveSubmission(submissionId) {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');

            const check = await c.query(
                `SELECT screenshot_file_id FROM submissions WHERE id = $1 AND status = 'pending'`,
                [submissionId]
            );
            if (check.rowCount === 0) {
                await c.query('ROLLBACK');
                throw new Error('NOT_FOUND');
            }
            if (!check.rows[0].screenshot_file_id || check.rows[0].screenshot_file_id.length < 10) {
                await c.query('ROLLBACK');
                throw new Error('NO_SCREENSHOT');
            }

            const upd = await c.query(
                `UPDATE submissions SET status = 'approved', processed_at = NOW()
                 WHERE id = $1 AND status = 'pending' RETURNING *`,
                [submissionId]
            );
            if (upd.rowCount === 0) {
                await c.query('ROLLBACK');
                throw new Error('ALREADY_DONE');
            }
            const sub = upd.rows[0];

            const taskRes = await c.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [sub.task_id]);
            const task = taskRes.rows[0];
            if (!task) throw new Error('NOT_FOUND');
            if (!task.is_active) throw new Error('TASK_CLOSED');
            const reward = parseFloat(task.reward);
            const budget = parseFloat(task.total_budget);
            if (budget < (task.completed_count + 1) * reward) throw new Error('BUDGET_EMPTY');

            await c.query('INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)', [sub.task_id, sub.user_id]);
            await c.query('UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1', [sub.task_id]);
            await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reward, sub.user_id]);
            await c.query(
                `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
                [sub.user_id, reward, 'task_reward', `Награда за @${task.channel_username}`]
            );

            await c.query('COMMIT');
            return { task, submission: sub };
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    },
    async rejectSubmission(submissionId, reason) {
        const r = await pool.query(
            `UPDATE submissions SET status = 'rejected', reject_reason = $1, processed_at = NOW()
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [submissionId, reason]
        );
        if (r.rowCount === 0) throw new Error('ALREADY_DONE');
        return r.rows[0];
    },
    async getUserTasks(userId) {
        const r = await pool.query('SELECT * FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC', [userId]);
        return r.rows;
    },
};

// ============ КЛАВИАТУРЫ ============
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 Заработать' }, { text: '📢 Рекламировать' }],
            [{ text: '👤 Мой кабинет' }],
        ],
        resize_keyboard: true,
    },
};

const cabinetKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '🎁 Вывести подарок', callback_data: 'withdraw_gift' }],
            [{ text: '👥 Реферальная система', callback_data: 'referral' }],
            [{ text: '📋 Мои задания', callback_data: 'my_tasks' }],
            [{ text: '📊 История транзакций', callback_data: 'transactions' }],
        ],
    },
};

// ============ /start ============
bot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (msg.chat.type !== 'private') return;

    if (awaitingWithdraw.has(userId)) awaitingWithdraw.delete(userId);
    if (awaitingScreenshot.has(userId)) awaitingScreenshot.delete(userId);

    try {
        let user = await db.getUser(userId);
        if (!user) {
            let referredBy = null;
            const code = match[1] ? match[1].trim() : null;
            if (code && code.startsWith('_')) {
                const parsed = parseInt(code.slice(1), 10);
                if (Number.isInteger(parsed) && parsed > 0 && parsed !== userId) {
                    referredBy = parsed;
                }
            }
            user = await db.createUser(userId, msg.from.username, msg.from.first_name, referredBy);
            const welcome =
                `🎉 Добро пожаловать в Tick Bot!\n\n` +
                `⭐ Зарабатывайте звёзды за подписки\n` +
                `📸 Отправляйте скриншот — админ проверит\n` +
                `🎁 Выводите от ${MIN_WITHDRAW} звёзд подарком\n` +
                `📢 Рекламодателям — продвижение каналов\n\n` +
                `Выберите действие:`;
            await safeSend(chatId, welcome, mainKeyboard);
        } else {
            await safeSend(chatId, `👋 С возвращением, ${escapeHtml(msg.from.first_name)}!`, mainKeyboard);
        }
    } catch (e) {
        console.error('/start:', e);
        await safeSend(chatId, '❌ Ошибка. Попробуйте позже.');
    }
});

// ============ /cancel ============
bot.onText(/^\/cancel(?:@\w+)?$/, async (msg) => {
    if (msg.chat.type !== 'private') return;
    const userId = msg.from.id;
    let cancelled = false;

    if (awaitingWithdraw.has(userId)) {
        awaitingWithdraw.delete(userId);
        cancelled = true;
    }
    if (awaitingScreenshot.has(userId)) {
        awaitingScreenshot.delete(userId);
        cancelled = true;
    }

    if (cancelled) {
        await safeSend(msg.chat.id, '❌ Действие отменено.', mainKeyboard);
    } else {
        await safeSend(msg.chat.id, 'Нечего отменять.');
    }
});

// ============ /addbalance ============
bot.onText(/^\/addbalance(?:@\w+)?\s+@?(\w+)\s+([\d.,]+)$/, async (msg, match) => {
    if (msg.from.id !== ADMIN_ID) return;
    const username = match[1];
    const amount = parseFloat(match[2].replace(',', '.'));
    if (Number.isNaN(amount) || amount <= 0 || amount > 100000) {
        return safeSend(msg.chat.id, '❌ Сумма 0.01–100000.');
    }
    const amountR = Math.round(amount * 10000) / 10000;
    try {
        const r = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (r.rowCount === 0) return safeSend(msg.chat.id, `❌ @${username} не найден.`);
        await db.updateBalance(r.rows[0].id, amountR, 'admin_credit', 'Начисление админом');
        await safeSend(msg.chat.id, `✅ +${formatStars(amountR)}⭐ для @${username}`);
        await safeSend(r.rows[0].id, `🎁 Вам начислено ${formatStars(amountR)}⭐`);
    } catch (e) {
        console.error('/addbalance:', e);
        await safeSend(msg.chat.id, '❌ Ошибка.');
    }
});

// ============ /admin ============
bot.onText(/^\/admin(?:@\w+)?$/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    const chatId = msg.chat.id;

    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const activeTasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE is_active = true AND total_budget >= (completed_count + 1) * reward');
        const pending = await pool.query(`SELECT COUNT(*) FROM submissions WHERE status = 'pending'`);

        const message =
            `👑 <b>Админ-панель</b>\n\n` +
            `📊 Статистика:\n` +
            `• Юзеров: ${users.rows[0].count}\n` +
            `• Активных заданий: ${activeTasks.rows[0].count}\n` +
            `• На проверке: ${pending.rows[0].count}\n`;

        await safeSend(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `📸 Заявки на проверку (${pending.rows[0].count})`, callback_data: 'admin_pending_0' }],
                ],
            },
        });
    } catch (e) {
        console.error('/admin:', e);
        await safeSend(chatId, '❌ Ошибка.');
    }
});

// ============ ГЛАВНЫЙ ОБРАБОТЧИК ============
bot.on('message', async (msg) => {
    pollingErrors = 0;
    if (msg.chat.type !== 'private') return;
    const userId = msg.from?.id;
    if (!userId) return;

    // ===== ФОТО / ДОКУМЕНТ =====
    let fileId = null;
    if (msg.photo && msg.photo.length) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
        fileId = msg.document.file_id;
    }

    if (fileId) {
        const state = awaitingScreenshot.get(userId);
        if (!state) return;
        if (Date.now() - state.ts > SCREENSHOT_TIMEOUT_MS) {
            awaitingScreenshot.delete(userId);
            return safeSend(msg.chat.id, '⌛ Время истекло. Нажми «📸 Отправить скриншот» заново.');
        }
        if (!fileId || fileId.length < 10) {
            return safeSend(msg.chat.id, '❌ Не удалось получить файл. Попробуй ещё раз.');
        }

        awaitingScreenshot.delete(userId);
        const taskId = state.taskId;

        try {
            const { id: subId, task } = await db.createSubmission(taskId, userId, fileId);
            const user = await db.getUser(userId);

            await safeSend(msg.chat.id, `✅ Скриншот принят!\n⭐ ${formatStars(task.reward)} звёзд поступят после одобрения администратором.\n⏳ Обычно до 24 часов.`);

            try {
                await bot.sendPhoto(ADMIN_ID, fileId, {
                    caption: (
                        `📸 <b>Заявка #${subId}</b>\n\n` +
                        `👤 ${escapeHtml(user.first_name || '')} (@${escapeHtml(user.username || 'нет')})\n` +
                        `🆔 <code>${userId}</code>\n` +
                        `📺 @${escapeHtml(task.channel_username)}\n` +
                        `⭐ Награда: ${formatStars(task.reward)}\n` +
                        `📊 Осталось: ${Math.floor(parseFloat(task.total_budget) / parseFloat(task.reward)) - task.completed_count}`
                    ).slice(0, 1000),
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Принять', callback_data: `approve_${subId}` },
                            { text: '❌ Отклонить', callback_data: `reject_${subId}` },
                        ]],
                    },
                });
            } catch (e) { console.error('notify admin:', e.message); }
        } catch (e) {
            const map = {
                ALREADY_PENDING: '⏳ Скриншот по этому заданию уже на проверке.',
                ALREADY_DONE: '✅ Задание уже выполнено.',
                NOT_FOUND: '❌ Задание не найдено.',
                BUDGET_EMPTY: '😞 Бюджет исчерпан.',
                TOO_MANY_PENDING: '⚠️ У тебя уже 5 заявок на проверке. Дождись обработки.',
                OWN_TASK: '❌ Нельзя выполнять своё задание.',
                SAME_SCREENSHOT: '❌ Это фото уже использовалось. Отправь новый скриншот.',
            };
            await safeSend(msg.chat.id, map[e.message] || '❌ Ошибка.');
        }
        return;
    }

    // ===== ТЕКСТ =====
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const wState = awaitingWithdraw.get(userId);
    if (wState) {
        if (!wState.promptSent) return;
        if (['💰 Заработать', '📢 Рекламировать', '👤 Мой кабинет'].includes(text)) {
            awaitingWithdraw.delete(userId);
        } else {
            return handleUsernameInput(msg, userId, wState.ts);
        }
    }

    try {
        const user = await db.getUser(userId);
        if (!user) return safeSend(msg.chat.id, 'Начните с /start');

        switch (text) {
            case '💰 Заработать': return handleEarnCommand(msg.chat.id, userId, 0);
            case '📢 Рекламировать': return handleAdvertiseCommand(msg.chat.id, userId);
            case '👤 Мой кабинет': return handleCabinetCommand(msg.chat.id, user);
        }

        if (text.startsWith('создать ')) return handleCreateTask(msg);
        await safeSend(msg.chat.id, 'Используйте кнопки меню.', mainKeyboard);
    } catch (e) {
        console.error('message:', e);
        await safeSend(msg.chat.id, '❌ Ошибка.');
    }
});

// ============ ЗАРАБОТОК ============
async function handleEarnCommand(chatId, userId, page = 0) {
    const tasks = await db.getActiveTasks(userId, 100);
    if (!tasks.length) return safeSend(chatId, '😔 Нет доступных заданий.');

    const taskIds = tasks.map(t => t.id);
    const completedRes = await pool.query(
        `SELECT task_id FROM task_completions WHERE user_id = $1 AND task_id = ANY($2::int[])`,
        [userId, taskIds]
    );
    const completed = new Set(completedRes.rows.map(r => r.task_id));

    const pendingRes = await pool.query(
        `SELECT task_id FROM submissions WHERE user_id = $1 AND status = 'pending' AND task_id = ANY($2::int[])`,
        [userId, taskIds]
    );
    const pending = new Set(pendingRes.rows.map(r => r.task_id));

    const available = tasks.filter(t => !completed.has(t.id));
    if (!available.length) return safeSend(chatId, '😔 Все задания выполнены.');

    const totalPages = Math.ceil(available.length / TASKS_PAGE_SIZE);
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;

    const slice = available.slice(page * TASKS_PAGE_SIZE, (page + 1) * TASKS_PAGE_SIZE);
    let message = `💰 Задания (стр. ${page + 1}/${totalPages}):\n\n`;
    const keyboard = [];

    for (let i = 0; i < slice.length; i++) {
        const t = slice[i];
        const num = page * TASKS_PAGE_SIZE + i + 1;
        const chan = t.channel_username.replace(/^@/, '');
        const isPending = pending.has(t.id);
        const reward = parseFloat(t.reward);
        const budget = parseFloat(t.total_budget);
        const maxC = Math.floor(budget / reward);

        message += `${num}. @${t.channel_username}\n`;
        message += `⭐ ${formatStars(reward)} звёзд | 📊 ${t.completed_count}/${maxC}\n`;
        if (isPending) message += `⏳ На проверке\n`;
        message += `\n`;

        keyboard.push([{ text: `🔗 Подписаться на @${chan}`, url: `https://t.me/${chan}` }]);

        if (!isPending) {
            keyboard.push([{ text: `📸 Отправить скриншот (${num})`, callback_data: `send_screenshot_${t.id}` }]);
        } else {
            keyboard.push([{ text: `⏳ На проверке (${num})`, callback_data: 'noop' }]);
        }
    }

    const nav = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `tasks_page_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: '➡️', callback_data: `tasks_page_${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: '🔄 Обновить', callback_data: 'refresh_tasks' }]);

    await safeSend(chatId, trimIfLong(message), { reply_markup: { inline_keyboard: keyboard } });
}

async function handleAdvertiseCommand(chatId, userId) {
    const user = await db.getUser(userId);
    const message =
        `📢 Создание задания\n\n` +
        `⭐ Баланс: ${formatStars(user.balance)} звёзд\n\n` +
        `📝 Отправьте: <code>создать @канал награда бюджет</code>\n` +
        `📋 Пример: <code>создать @example 0.05 5</code>\n\n` +
        `⚖️ Награда: ${MIN_TASK_REWARD}–${MAX_TASK_REWARD} звёзд\n` +
        `💡 Пополнение — напишите админу.`;
    await safeSend(chatId, message, { parse_mode: 'HTML' });
}

async function handleCabinetCommand(chatId, user) {
    const link = `https://t.me/${BOT_USERNAME}?start=_${user.id}`;
    const message =
        `👤 Личный кабинет\n\n` +
        `🆔 ID: <code>${user.id}</code>\n` +
        `⭐ Баланс: <b>${formatStars(user.balance)}</b>\n` +
        `👥 Рефералов: <b>${user.referral_count}</b>\n` +
        `📅 Регистрация: ${new Date(user.created_at).toLocaleDateString('ru-RU')}\n\n` +
        `🔗 Ссылка:\n<code>${link}</code>`;
    await safeSend(chatId, message, { parse_mode: 'HTML', ...cabinetKeyboard });
}

// ============ СОЗДАНИЕ ЗАДАНИЯ ============
async function handleCreateTask(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length !== 4) {
            return safeSend(chatId, '❌ Формат: <code>создать @канал награда бюджет</code>', { parse_mode: 'HTML' });
        }
        const channel = parts[1].replace(/^@/, '');
        const reward = parseFloat(parts[2].replace(',', '.'));
        const budget = parseFloat(parts[3].replace(',', '.'));

        if (!CHANNEL_REGEX.test(channel)) return safeSend(chatId, '❌ Некорректное имя канала.');
        if (isNaN(reward) || isNaN(budget) || reward <= 0 || budget <= 0) {
            return safeSend(chatId, '❌ Награда и бюджет — положительные числа.');
        }
        if (reward < MIN_TASK_REWARD || reward > MAX_TASK_REWARD) {
            return safeSend(chatId, `❌ Награда: ${MIN_TASK_REWARD}–${MAX_TASK_REWARD}⭐.`);
        }
        if (budget < reward) return safeSend(chatId, '❌ Бюджет < награды.');

        const rewardR = Math.round(reward * 10000) / 10000;
        const budgetR = Math.round(budget * 10000) / 10000;

        const c = await pool.connect();
        let task;
        try {
            await c.query('BEGIN');
            const deduct = await c.query(
                `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
                [budgetR, userId]
            );
            if (deduct.rowCount === 0) {
                await c.query('ROLLBACK');
                return safeSend(chatId, `❌ Недостаточно звёзд. Нужно: ${formatStars(budgetR)}.`);
            }
            const ins = await c.query(
                `INSERT INTO tasks (owner_id, channel_username, reward, total_budget)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [userId, channel, rewardR, budgetR]
            );
            task = ins.rows[0];
            await c.query(
                `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
                [userId, -budgetR, 'task_payment', `Задание для @${channel}`]
            );
            await c.query('COMMIT');
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            console.error('createTask:', e);
            return safeSend(chatId, '❌ Ошибка при создании задания.');
        } finally {
            c.release();
        }

        await safeSend(chatId,
            `✅ Задание создано!\n\n` +
            `📺 @${channel}\n⭐ ${formatStars(rewardR)} звёзд за подписку\n` +
            `💰 Бюджет: ${formatStars(budgetR)}\n👥 Макс: ${Math.floor(budgetR / rewardR)}`
        );
    } catch (e) {
        console.error('handleCreateTask:', e);
        await safeSend(chatId, '❌ Ошибка.');
    }
}

// ============ ВЫВОД ============
async function handleWithdrawRequest(chatId, userId) {
    const now = Date.now();
    for (const [uid, st] of awaitingWithdraw.entries()) {
        if (now - st.ts > WITHDRAW_TIMEOUT_MS) awaitingWithdraw.delete(uid);
    }

    const existing = awaitingWithdraw.get(userId);
    if (existing && now - existing.ts < WITHDRAW_TIMEOUT_MS) {
        return safeSend(chatId, '⏳ Ты уже в процессе. Введи @username или /cancel.');
    }

    const ts = Date.now();
    awaitingWithdraw.set(userId, { ts, promptSent: false });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            awaitingWithdraw.delete(userId);
            return safeSend(chatId, 'Начните с /start');
        }
        if (parseFloat(user.balance) < MIN_WITHDRAW) {
            await client.query('ROLLBACK');
            awaitingWithdraw.delete(userId);
            return safeSend(chatId, `❌ Нужно ${MIN_WITHDRAW}⭐ (у тебя ${formatStars(user.balance)}).`);
        }
        const pending = await client.query(
            `SELECT id FROM withdraw_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
            [userId]
        );
        if (pending.rowCount > 0) {
            await client.query('ROLLBACK');
            awaitingWithdraw.delete(userId);
            return safeSend(chatId, `⏳ Уже есть заявка #${pending.rows[0].id}.`);
        }
        await client.query('COMMIT');
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        awaitingWithdraw.delete(userId);
        console.error('withdraw req:', e);
        return safeSend(chatId, '❌ Ошибка.');
    } finally {
        if (client) client.release();
    }

    if (awaitingWithdraw.get(userId)?.ts === ts) {
        awaitingWithdraw.set(userId, { ts, promptSent: true });
        await safeSend(chatId,
            `🎁 Вывод подарка «Мишка» (15⭐)\n\n` +
            `⭐ Стоимость: ${GIFT_COST} звёзд\n` +
            `📝 Отправь @username текстом\n` +
            `⏱ 10 минут. Отмена — /cancel\n\n` +
            `⚠️ Подарок нельзя обменять на звёзды.`
        );
    }
}

async function handleUsernameInput(msg, userId, ts) {
    const chatId = msg.chat.id;
    if (Date.now() - ts > WITHDRAW_TIMEOUT_MS) {
        awaitingWithdraw.delete(userId);
        return safeSend(chatId, '⌛ Время истекло.');
    }
    if (!msg.text) return safeSend(chatId, '📝 Отправь @username текстом.');
    const text = msg.text.trim();
    if (!USERNAME_REGEX.test(text)) {
        return safeSend(chatId, '❌ Некорректный @username (5–32, латиница/цифры/_).');
    }

    awaitingWithdraw.delete(userId);

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return safeSend(chatId, 'Начните с /start');
        }
        const pending = await client.query(
            `SELECT id FROM withdraw_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
            [userId]
        );
        if (pending.rowCount > 0) {
            await client.query('ROLLBACK');
            return safeSend(chatId, `⏳ Уже есть заявка #${pending.rows[0].id}.`);
        }
        const deduct = await client.query(
            `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
            [GIFT_COST, userId]
        );
        if (deduct.rowCount === 0) {
            await client.query('ROLLBACK');
            return safeSend(chatId, '❌ Недостаточно звёзд.');
        }
        const ins = await client.query(
            `INSERT INTO withdraw_requests (user_id, username, gift) VALUES ($1, $2, $3) RETURNING id`,
            [userId, text, 'Мишка (15⭐)']
        );
        const reqId = ins.rows[0].id;
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
            [userId, -GIFT_COST, 'withdraw_hold', `Заявка #${reqId} (заморожено)`]
        );
        await client.query('COMMIT');

        try {
            await bot.sendMessage(ADMIN_ID,
                `🔔 <b>Заявка #${reqId}</b>\n\n` +
                `👤 ${escapeHtml(user.first_name || '')} (@${escapeHtml(user.username || 'нет')})\n` +
                `📮 Куда: ${escapeHtml(text)}\n` +
                `🎁 Мишка (15⭐) | ⭐ -${GIFT_COST}\n` +
                `💳 Остаток: ${formatStars(deduct.rows[0].balance)}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Принять', callback_data: `admin_accept_${reqId}` },
                            { text: '❌ Отклонить', callback_data: `admin_reject_${reqId}` },
                        ]],
                    },
                }
            );
        } catch (e) { console.error('notify admin:', e.message); }

        await safeSend(chatId, `✅ Заявка #${reqId} создана. Списано ${GIFT_COST}⭐.`);
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('withdraw create:', e);
        await safeSend(chatId, '❌ Ошибка. Попробуй позже.');
    } finally {
        if (client) client.release();
    }
}

async function handleAdminAccept(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя заявка.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(
            `UPDATE withdraw_requests SET status = 'accepted', processed_at = NOW()
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [reqId]
        );
        if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return answer({ text: 'Уже обработана.' });
        }
        const req = upd.rows[0];
        await client.query('COMMIT');

        try { await bot.sendMessage(req.user_id, `🎉 Заявка #${reqId} принята!`); } catch (e) {}
        try { await bot.sendMessage(ADMIN_ID, `✅ #${reqId} принята.\n👉 https://t.me/${req.username.replace('@', '')}`); } catch (e) {}
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
            });
        } catch (e) {}
        await answer({ text: 'Принято!' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('accept:', e);
        await answer({ text: 'Ошибка' });
    } finally {
        if (client) client.release();
    }
}

async function handleAdminReject(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя заявка.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(
            `UPDATE withdraw_requests SET status = 'rejected', processed_at = NOW()
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [reqId]
        );
        if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return answer({ text: 'Уже обработана.' });
        }
        const req = upd.rows[0];
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [GIFT_COST, req.user_id]);
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
            [req.user_id, GIFT_COST, 'withdraw_refund', `Возврат #${reqId}`]
        );
        await client.query('COMMIT');

        try { await bot.sendMessage(req.user_id, `❌ Заявка #${reqId} отклонена. ${GIFT_COST}⭐ возвращены.`); } catch (e) {}
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
            });
        } catch (e) {}
        await answer({ text: 'Отклонено.' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('reject:', e);
        await answer({ text: 'Ошибка' });
    } finally {
        if (client) client.release();
    }
}

async function handleApproveSubmission(cb, subId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя заявка.' });
    if (!Number.isInteger(subId) || subId <= 0) return answer({ text: 'Неверный ID.' });
    try {
        const { task, submission } = await db.approveSubmission(subId);
        try {
            await bot.sendMessage(submission.user_id,
                `🎉 Задание @${task.channel_username} одобрено!\n⭐ +${formatStars(task.reward)} звёзд на баланс.`
            );
        } catch (e) {}
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
            });
        } catch (e) {}
        await answer({ text: 'Одобрено!' });
    } catch (e) {
        console.error('approve:', e);
        const map = {
            ALREADY_DONE: 'Уже обработана',
            NOT_FOUND: 'Заявка не найдена',
            NO_SCREENSHOT: '❌ Нет скриншота',
            BUDGET_EMPTY: 'Бюджет исчерпан',
            TASK_CLOSED: '⚠️ Задание закрыто',
        };
        await answer({ text: map[e.message] || 'Ошибка' });
    }
}

async function handleRejectSubmission(cb, subId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя заявка.' });
    if (!Number.isInteger(subId) || subId <= 0) return answer({ text: 'Неверный ID.' });
    try {
        const sub = await db.rejectSubmission(subId, 'Скриншот не подтверждает подписку');
        try {
            await bot.sendMessage(sub.user_id, `❌ Задание отклонено.\nПричина: скриншот не подтверждает подписку.`);
        } catch (e) {}
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
            });
        } catch (e) {}
        await answer({ text: 'Отклонено.' });
    } catch (e) {
        console.error('reject sub:', e);
        await answer({ text: e.message === 'ALREADY_DONE' ? 'Уже обработана' : 'Ошибка' });
    }
}

async function handleAdminPending(cb, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    if (!Number.isInteger(offset) || offset < 0) offset = 0;

    try {
        const pending = await pool.query(
            `SELECT s.id, s.user_id, s.created_at, t.channel_username, t.reward, u.username, u.first_name
             FROM submissions s
             JOIN tasks t ON s.task_id = t.id
             JOIN users u ON s.user_id = u.id
             WHERE s.status = 'pending'
             ORDER BY s.created_at ASC
             LIMIT 5 OFFSET $1`,
            [offset]
        );

        if (pending.rowCount === 0) {
            await answer({ text: offset === 0 ? 'Нет заявок' : 'Конец списка' });
            return;
        }

        const totalRes = await pool.query(`SELECT COUNT(*) FROM submissions WHERE status = 'pending'`);
        const total = parseInt(totalRes.rows[0].count, 10);

        await safeSend(cb.message.chat.id, `📸 Заявки ${offset + 1}–${offset + pending.rowCount} из ${total}:`);

        for (const s of pending.rows) {
            try {
                const subRes = await pool.query('SELECT screenshot_file_id FROM submissions WHERE id = $1', [s.id]);
                const fileId = subRes.rows[0]?.screenshot_file_id;

                if (fileId) {
                    await bot.sendPhoto(cb.message.chat.id, fileId, {
                        caption: (
                            `#${s.id} | @${escapeHtml(s.channel_username)}\n` +
                            `👤 ${escapeHtml(s.first_name || '')} (@${escapeHtml(s.username || 'нет')})\n` +
                            `⭐ ${formatStars(s.reward)}`
                        ).slice(0, 1000),
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Принять', callback_data: `approve_${s.id}` },
                                { text: '❌ Отклонить', callback_data: `reject_${s.id}` },
                            ]],
                        },
                    });
                }
            } catch (e) {
                console.error('sendPhoto:', e.message);
            }
        }

        const nav = [];
        if (offset > 0) nav.push({ text: '⬅️', callback_data: `admin_pending_${Math.max(0, offset - 5)}` });
        if (offset + 5 < total) nav.push({ text: '➡️', callback_data: `admin_pending_${offset + 5}` });
        if (nav.length) {
            await safeSend(cb.message.chat.id, 'Навигация:', { reply_markup: { inline_keyboard: [nav] } });
        }
        await answer();
    } catch (e) {
        console.error('handleAdminPending:', e);
        await answer({ text: 'Ошибка' });
    }
}

// ============ CALLBACK ============
bot.on('callback_query', async (cb) => {
    const action = cb.data;
    if (!action || typeof action !== 'string') {
        try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
        return;
    }
    const msg = cb.message;
    if (!msg || !msg.chat) {
        try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
        return;
    }
    const chatId = msg.chat.id;
    const userId = cb.from.id;

    let answered = false;
    const answer = async (opts = {}) => {
        if (answered) return;
        answered = true;
        try { await bot.answerCallbackQuery(cb.id, opts); } catch (e) {}
    };

    try {
        if (action.startsWith('tasks_page_')) {
            await handleEarnCommand(chatId, userId, parseInt(action.slice(11), 10) || 0);
            await answer();
        } else if (action === 'refresh_tasks') {
            await handleEarnCommand(chatId, userId, 0);
            await answer();
        } else if (action === 'referral') {
            await handleReferral(chatId, userId);
            await answer();
        } else if (action === 'my_tasks') {
            await handleMyTasks(chatId, userId);
            await answer();
        } else if (action === 'transactions') {
            await handleTransactions(chatId, userId);
            await answer();
        } else if (action === 'withdraw_gift') {
            await answer();
            await handleWithdrawRequest(chatId, userId);
        } else if (action.startsWith('send_screenshot_')) {
            const taskId = parseInt(action.slice(16), 10);
            if (!Number.isInteger(taskId) || taskId <= 0) {
                return answer({ text: 'Неверное задание' });
            }
            const existing = awaitingScreenshot.get(userId);
            if (existing && Date.now() - existing.ts < SCREENSHOT_TIMEOUT_MS && existing.taskId !== taskId) {
                return answer({ text: '⚠️ Сначала отправь скриншот для предыдущего задания или /cancel' });
            }
            awaitingScreenshot.set(userId, { taskId, ts: Date.now() });
            await safeSend(chatId,
                `📸 Отправь скриншот подписки на канал.\nСкриншот должен показывать, что ты подписан.\n\n` +
                `⏱ У тебя 10 минут. Отмена — /cancel`
            );
            await answer();
        } else if (action === 'noop') {
            await answer({ text: 'Уже на проверке' });
        } else if (action.startsWith('approve_')) {
            const subId = parseInt(action.slice(8), 10);
            await handleApproveSubmission(cb, subId, answer);
        } else if (action.startsWith('reject_')) {
            const subId = parseInt(action.slice(7), 10);
            await handleRejectSubmission(cb, subId, answer);
        } else if (action.startsWith('admin_accept_')) {
            await handleAdminAccept(cb, parseInt(action.slice(13), 10), answer);
        } else if (action.startsWith('admin_reject_')) {
            await handleAdminReject(cb, parseInt(action.slice(13), 10), answer);
        } else if (action.startsWith('admin_pending_')) {
            await handleAdminPending(cb, parseInt(action.slice(14), 10) || 0, answer);
        } else {
            await answer();
        }
    } catch (e) {
        console.error('callback:', e);
        await answer({ text: 'Ошибка' });
    }
});

async function handleReferral(chatId, userId) {
    const user = await db.getUser(userId);
    const link = `https://t.me/${BOT_USERNAME}?start=_${user.id}`;
    const message =
        `👥 Реферальная система\n\n` +
        `🔗 Ссылка:\n<code>${link}</code>\n\n` +
        `📊 Приглашено: <b>${user.referral_count}</b>\n` +
        `⭐ Заработано: <b>${formatStars(user.referral_count * REFERRAL_BONUS)}</b>\n\n` +
        `💡 ${formatStars(REFERRAL_BONUS)} звёзд за друга`;
    await safeSend(chatId, message, { parse_mode: 'HTML' });
}

async function handleMyTasks(chatId, userId) {
    const tasks = await db.getUserTasks(userId);
    if (!tasks.length) return safeSend(chatId, '📋 У вас нет заданий.');
    let message = '📋 Ваши задания:\n\n';
    const shown = tasks.slice(0, 15);
    shown.forEach((t, i) => {
        const reward = parseFloat(t.reward);
        const budget = parseFloat(t.total_budget);
        const maxC = Math.floor(budget / reward);
        message += `${i + 1}. @${t.channel_username}\n`;
        message += `${t.is_active ? '🟢' : '🔴'} ⭐${formatStars(reward)} | ${t.completed_count}/${maxC}\n\n`;
    });
    if (tasks.length > 15) message += `\n... и ещё ${tasks.length - 15} заданий\n`;
    await safeSend(chatId, trimIfLong(message));
}

async function handleTransactions(chatId, userId) {
    const r = await pool.query(
        `SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [userId]
    );
    if (!r.rows.length) return safeSend(chatId, '📊 История пуста.');
    let message = '📊 Последние 10 операций:\n\n';
    r.rows.forEach(tx => {
        const date = new Date(tx.created_at).toLocaleDateString('ru-RU');
        const amt = tx.amount > 0 ? `+${formatStars(tx.amount)}` : `${formatStars(tx.amount)}`;
        const emoji = tx.amount > 0 ? '💚' : '🔴';
        message += `${emoji} ${amt}⭐ | ${date}\n${tx.description}\n\n`;
    });
    await safeSend(chatId, trimIfLong(message));
}

// ============ БД ============
async function initDatabase() {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ БД подключена');
        await createTablesIfNotExist();
    } catch (e) {
        console.error('❌ Ошибка БД:', e);
        process.exit(1);
    }
}

async function createTablesIfNotExist() {
    const check = await pool.query(`
        SELECT EXISTS (SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users');
    `);
    if (!check.rows[0].exists) {
        console.log('🔄 Создание таблиц...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY,
                username VARCHAR(255),
                first_name VARCHAR(255),
                balance NUMERIC(12,4) DEFAULT 0,
                referral_count INTEGER DEFAULT 0,
                referred_by BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                owner_id BIGINT NOT NULL,
                channel_username VARCHAR(255) NOT NULL,
                reward NUMERIC(10,4) NOT NULL CHECK (reward >= 0.05 AND reward <= 10),
                total_budget NUMERIC(12,4) NOT NULL,
                completed_count INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS task_completions (
                id SERIAL PRIMARY KEY,
                task_id INTEGER NOT NULL,
                user_id BIGINT NOT NULL,
                completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(task_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS chats (
                id BIGINT PRIMARY KEY,
                owner_id BIGINT NOT NULL,
                chat_type VARCHAR(50) NOT NULL,
                title VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS chat_sponsors (
                id SERIAL PRIMARY KEY,
                chat_id BIGINT NOT NULL,
                sponsor_username VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats(id),
                UNIQUE(chat_id, sponsor_username)
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                amount NUMERIC(12,4) NOT NULL,
                type VARCHAR(50) NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);
            CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active);
            CREATE INDEX IF NOT EXISTS idx_task_completions_user_task ON task_completions(user_id, task_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
        `);
        console.log('✅ Таблицы созданы');
    } else {
        console.log('✅ Таблицы уже есть');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS withdraw_requests (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            username VARCHAR(64) NOT NULL,
            gift VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        );
        ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP;
        CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status);
        CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user ON withdraw_requests(user_id, status);
    `);
    console.log('✅ Таблица withdraw_requests готова');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS submissions (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            screenshot_file_id TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reject_reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
        CREATE INDEX IF NOT EXISTS idx_submissions_user_task ON submissions(user_id, task_id);
    `);
    console.log('✅ Таблица submissions готова');
}

// ============ ОШИБКИ ============
let pollingErrors = 0;
bot.on('polling_error', (error) => {
    console.error('❌ Polling:', error.message);
    pollingErrors++;
    if (error.message.includes('401')) process.exit(1);
    if (pollingErrors >= 10) {
        console.error('❌ 10 ошибок polling');
        process.exit(1);
    }
});

process.on('uncaughtException', (e) => {
    console.error('❌ Uncaught:', e);
    process.exit(1);
});
process.on('unhandledRejection', (e) => {
    console.error('❌ Unhandled:', e);
    process.exit(1);
});

// ============ ЗАПУСК ============
async function start() {
    await initDatabase();
    try {
        const me = await bot.getMe();
        BOT_USERNAME = me.username;
        BOT_ID = me.id;
        console.log(`🚀 Бот: @${BOT_USERNAME}`);
    } catch (e) {
        console.error('❌ getMe:', e.message);
        process.exit(1);
    }
    try {
        await bot.sendMessage(ADMIN_ID, `🟢 Бот @${BOT_USERNAME} запущен.`);
    } catch (e) {
        console.error('❌ Не могу написать админу:', e.message);
        process.exit(1);
    }
    console.log('🚀 Tick Bot запущен');
}

start().catch(e => { console.error('❌ start:', e); process.exit(1); });
