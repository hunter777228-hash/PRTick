require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const nodeCrypto = require('crypto');
const CryptoBotAPI = require('crypto-bot-api');

// ============ ВАЛИДАЦИЯ ENV ============
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
if (Number.isNaN(ADMIN_ID) || ADMIN_ID <= 0) {
    console.error('❌ FATAL: ADMIN_ID не задан');
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
let BOT_USERNAME = null;
let BOT_ID = null;

// ============ CRYPTOBOT ============
let cryptoClient = null;
if (process.env.CRYPTO_PAY_TOKEN) {
    try {
        cryptoClient = new CryptoBotAPI(process.env.CRYPTO_PAY_TOKEN);
        console.log('✅ CryptoBot клиент создан');
    } catch (e) {
        console.error('❌ CryptoBot init:', e.message);
    }
} else {
    console.log('⚠️ CRYPTO_PAY_TOKEN не задан');
}

// ============ EXPRESS ============
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({ status: 'running', bot: BOT_USERNAME }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ===== Webhook от CryptoBot =====
app.post('/crypto/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        if (!process.env.CRYPTO_PAY_TOKEN) return res.sendStatus(500);
        if (!Buffer.isBuffer(req.body)) return res.sendStatus(500);

        const signature = req.headers['crypto-pay-api-signature'];
        if (!signature) return res.sendStatus(403);

        const secret = nodeCrypto.createHash('sha256').update(process.env.CRYPTO_PAY_TOKEN).digest();
        const checkString = req.body.toString();
        const hmac = nodeCrypto.createHmac('sha256', secret).update(checkString).digest('hex');

        if (hmac !== signature) {
            console.error('❌ Неверная подпись вебхука');
            return res.sendStatus(403);
        }

        const update = JSON.parse(checkString);
        console.log('CryptoBot webhook:', update.update_type);

        if (update.update_type === 'invoice_paid' && update.payload) {
            const invoice = update.payload;
            const payload = invoice.payload || '';
            const parts = payload.split('_');
            if (parts[0] !== 'dep' || parts.length < 4) return res.sendStatus(200);

            const userId = parseInt(parts[1], 10);
            const usdt = parseFloat(parts[2]);
            if (!Number.isInteger(userId) || !Number.isFinite(usdt) || usdt <= 0) return res.sendStatus(200);

            const starsToCredit = Math.round(usdt * USDT_TO_STARS * 10000) / 10000;

            const c = await pool.connect();
            let ok = false;
            try {
                await c.query('BEGIN');
                const insert = await c.query(
                    `INSERT INTO processed_payments (payload) VALUES ($1) ON CONFLICT DO NOTHING RETURNING payload`,
                    [payload]
                );
                if (insert.rowCount === 0) {
                    await c.query('ROLLBACK');
                    return res.sendStatus(200);
                }
                await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [starsToCredit, userId]);
                await c.query(
                    `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
                    [userId, starsToCredit, 'crypto_deposit', `Пополнение ${usdt} USDT`]
                );
                await c.query('COMMIT');
                ok = true;
            } catch (e) {
                await c.query('ROLLBACK').catch(() => {});
                console.error('crypto credit:', e);
            } finally { c.release(); }

            if (ok) {
                try { await bot.sendMessage(userId, `✅ Баланс пополнен!\n💵 ${usdt} USDT\n⭐ +${formatStars(starsToCredit)} звёзд`); } catch (e) {}
                try { await bot.sendMessage(ADMIN_ID, `💰 Крипто-пополнение\n👤 <code>${userId}</code>\n💵 ${usdt} USDT → ${formatStars(starsToCredit)}⭐`, { parse_mode: 'HTML' }); } catch (e) {}
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('crypto webhook:', e);
        res.sendStatus(200);
    }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// ============ КОНСТАНТЫ ============
const REFERRAL_BONUS = 1;
const MIN_TASK_REWARD = 0.25;
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
const ADMIN_TASKS_PAGE = 5;
const ADMIN_USERS_PAGE = 10;
const USDT_TO_STARS = 45;
const CRYPTO_PACKAGES = [1, 5, 10, 25, 50];
const CRYPTO_MIN_AMOUNT = 0.1;
const CRYPTO_MAX_AMOUNT = 1000;

const awaitingWithdraw = new Map();
const awaitingScreenshot = new Map();
const awaitingCryptoAmount = new Map();
const broadcastState = new Map();
const broadcastRunning = new Set();

// ============ ХЕЛПЕРЫ ============
function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatStars(n) {
    const num = parseFloat(n);
    if (Number.isNaN(num)) return '0';
    if (Number.isInteger(num)) return String(num);
    return num.toFixed(4).replace(/\.?0+$/, '');
}

async function safeSend(chatId, text, opts = {}) {
    try { return await bot.sendMessage(chatId, text, opts); }
    catch (e) { console.error(`safeSend to ${chatId}:`, e.message); return null; }
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
                `INSERT INTO users (id, username, first_name, referred_by) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
                 RETURNING *`,
                [userId, username, firstName, referredBy]
            );

            if (referredBy && isNew) {
                const refExists = await client.query('SELECT id FROM users WHERE id = $1', [referredBy]);
                if (refExists.rowCount > 0) {
                    await client.query(`UPDATE users SET balance = balance + $1, referral_count = referral_count + 1 WHERE id = $2`, [REFERRAL_BONUS, referredBy]);
                    await client.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [referredBy, REFERRAL_BONUS, 'referral_bonus', `Бонус`]);
                }
            }
            await client.query('COMMIT');
            return r.rows[0];
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { client.release(); }
    },
    async updateBalance(userId, amount, type, description) {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
            await c.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [userId, amount, type, description]);
            await c.query('COMMIT');
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { c.release(); }
    },
    async getActiveTasks(excludeUserId = null, limit = 100) {
        let query = `SELECT t.*, u.username as owner_username FROM tasks t JOIN users u ON t.owner_id = u.id
                     WHERE t.is_active = true AND t.reward > 0 AND t.total_budget >= (t.completed_count + 1) * t.reward`;
        const params = [];
        if (excludeUserId) { query += ' AND t.owner_id != $1'; params.push(excludeUserId); }
        query += ' ORDER BY t.created_at DESC LIMIT $' + (params.length + 1);
        params.push(limit);
        const r = await pool.query(query, params);
        return r.rows;
    },
    async createSubmission(taskId, userId, screenshotFileId) {
        const pendingCount = await pool.query(`SELECT COUNT(*) FROM submissions WHERE user_id = $1 AND status = 'pending'`, [userId]);
        if (parseInt(pendingCount.rows[0].count, 10) >= MAX_PENDING_SUBMISSIONS) throw new Error('TOO_MANY_PENDING');

        const ownCheck = await pool.query(`SELECT owner_id FROM tasks WHERE id = $1`, [taskId]);
        if (ownCheck.rowCount > 0 && ownCheck.rows[0].owner_id === userId) throw new Error('OWN_TASK');

        const sameShot = await pool.query(`SELECT id FROM submissions WHERE user_id = $1 AND screenshot_file_id = $2`, [userId, screenshotFileId]);
        if (sameShot.rowCount > 0) throw new Error('SAME_SCREENSHOT');

        const existing = await pool.query(`SELECT id FROM submissions WHERE task_id = $1 AND user_id = $2 AND status = 'pending'`, [taskId, userId]);
        if (existing.rowCount > 0) throw new Error('ALREADY_PENDING');

        const done = await pool.query(`SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2`, [taskId, userId]);
        if (done.rowCount > 0) throw new Error('ALREADY_DONE');

        const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
        const task = taskRes.rows[0];
        if (!task || !task.is_active) throw new Error('NOT_FOUND');
        if (parseFloat(task.total_budget) < (task.completed_count + 1) * parseFloat(task.reward)) throw new Error('BUDGET_EMPTY');

        const r = await pool.query(`INSERT INTO submissions (user_id, task_id, screenshot_file_id) VALUES ($1, $2, $3) RETURNING id`, [userId, taskId, screenshotFileId]);
        return { id: r.rows[0].id, task };
    },
    async approveSubmission(submissionId) {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            const check = await c.query(`SELECT screenshot_file_id FROM submissions WHERE id = $1 AND status = 'pending'`, [submissionId]);
            if (check.rowCount === 0) { await c.query('ROLLBACK'); throw new Error('NOT_FOUND'); }
            if (!check.rows[0].screenshot_file_id || check.rows[0].screenshot_file_id.length < 10) { await c.query('ROLLBACK'); throw new Error('NO_SCREENSHOT'); }

            const upd = await c.query(`UPDATE submissions SET status = 'approved', processed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`, [submissionId]);
            if (upd.rowCount === 0) { await c.query('ROLLBACK'); throw new Error('ALREADY_DONE'); }
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
            await c.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [sub.user_id, reward, 'task_reward', `Награда за @${task.channel_username}`]);
            await c.query('COMMIT');
            return { task, submission: sub };
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { c.release(); }
    },
    async rejectSubmission(submissionId, reason) {
        const r = await pool.query(`UPDATE submissions SET status = 'rejected', reject_reason = $1, processed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`, [submissionId, reason]);
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
            [{ text: '💳 Пополнить' }, { text: '🔄 Обменять' }],
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
    if (broadcastState.has(userId)) broadcastState.delete(userId);
    if (broadcastRunning.has(userId)) broadcastRunning.delete(userId);

    try {
        let user = await db.getUser(userId);
        if (!user) {
            let referredBy = null;
            const code = match[1] ? match[1].trim() : null;
            if (code && code.startsWith('_')) {
                const parsed = parseInt(code.slice(1), 10);
                if (Number.isInteger(parsed) && parsed > 0 && parsed !== userId) referredBy = parsed;
            }
            user = await db.createUser(userId, msg.from.username, msg.from.first_name, referredBy);
            await safeSend(chatId,
                `🎉 Добро пожаловать!\n\n⭐ Зарабатывайте звёзды\n📸 Отправляйте скриншот\n🎁 Выводите от ${MIN_WITHDRAW}⭐\n💳 Пополняйте криптой\n\nВыберите действие:`,
                mainKeyboard
            );
        } else {
            await safeSend(chatId, `👋 С возвращением, ${escapeHtml(msg.from.first_name)}!`, mainKeyboard);
        }
    } catch (e) { console.error('/start:', e); await safeSend(chatId, '❌ Ошибка.'); }
});

// ============ /cancel ============
bot.onText(/^\/cancel(?:@\w+)?$/, async (msg) => {
    if (msg.chat.type !== 'private') return;
    const userId = msg.from.id;
    let cancelled = false;

    if (awaitingWithdraw.has(userId)) { awaitingWithdraw.delete(userId); cancelled = true; }
    if (awaitingScreenshot.has(userId)) { awaitingScreenshot.delete(userId); cancelled = true; }
    if (awaitingCryptoAmount.has(userId)) { awaitingCryptoAmount.delete(userId); cancelled = true; }
    if (awaitingExchangeAmount.has(userId)) { awaitingExchangeAmount.delete(userId); cancelled = true; }
    if (broadcastState.has(userId)) { broadcastState.delete(userId); cancelled = true; }
    if (broadcastRunning.has(userId)) { broadcastRunning.delete(userId); cancelled = true; }

    await safeSend(msg.chat.id, cancelled ? '❌ Отменено.' : 'Нечего отменять.');
});

// ============ /addbalance ============
bot.onText(/^\/addbalance(?:@\w+)?\s+@?(\w+)\s+([\d.,]+)$/, async (msg, match) => {
    if (msg.from.id !== ADMIN_ID) return;
    const username = match[1];
    const amount = parseFloat(match[2].replace(',', '.'));
    if (Number.isNaN(amount) || amount <= 0 || amount > 100000) return safeSend(msg.chat.id, '❌ Сумма 0.01–100000.');
    const amountR = Math.round(amount * 10000) / 10000;
    try {
        const r = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (r.rowCount === 0) return safeSend(msg.chat.id, `❌ @${username} не найден.`);
        await db.updateBalance(r.rows[0].id, amountR, 'admin_credit', 'Начисление админом');
        await safeSend(msg.chat.id, `✅ +${formatStars(amountR)}⭐ для @${username}`);
        await safeSend(r.rows[0].id, `🎁 Вам начислено ${formatStars(amountR)}⭐`);
    } catch (e) { console.error('/addbalance:', e); await safeSend(msg.chat.id, '❌ Ошибка.'); }
});
// ============ АДМИН-ПАНЕЛЬ ============
async function buildAdminPanelData() {
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const activeTasks = await pool.query(`SELECT COUNT(*) FROM tasks WHERE is_active = true AND reward > 0 AND total_budget >= (completed_count + 1) * reward`);
    const allTasks = await pool.query('SELECT COUNT(*) FROM tasks');
    const pending = await pool.query(`SELECT COUNT(*) FROM submissions WHERE status = 'pending'`);
    const pendingWithdraw = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
    const pendingExchange = await pool.query(`SELECT COUNT(*) FROM exchange_requests WHERE status = 'pending'`);
    const totalStars = await pool.query(`SELECT COALESCE(SUM(balance), 0) AS sum FROM users`);
    return {
        users: users.rows[0].count,
        activeTasks: activeTasks.rows[0].count,
        allTasks: allTasks.rows[0].count,
        pending: pending.rows[0].count,
        pendingWithdraw: parseInt(pendingWithdraw.rows[0].count, 10) + parseInt(pendingExchange.rows[0].count, 10),
        totalStars: totalStars.rows[0].sum,
    };
}

function buildAdminPanelText(d) {
    return `👑 <b>Админ-панель</b>\n\n📊 <b>Статистика:</b>\n` +
        `• Юзеров: <b>${d.users}</b>\n` +
        `• Баланс юзеров: <b>${formatStars(d.totalStars)}⭐</b>\n` +
        `• Заданий: <b>${d.allTasks}</b> (активных: ${d.activeTasks})\n` +
        `• Скриншотов: <b>${d.pending}</b>\n` +
        `• Заявок на вывод: <b>${d.pendingWithdraw}</b>`;
}

function buildAdminPanelKeyboard(d) {
    return {
        inline_keyboard: [
            [
                { text: `📸 Заявки (${d.pending})`, callback_data: 'admin_pending_0' },
                { text: `🎁 Выводы (${d.pendingWithdraw})`, callback_data: 'admin_withdrawals_0' },
            ],
            [
                { text: `📋 Задания`, callback_data: 'admin_tasks_0' },
                { text: `👥 Юзеры`, callback_data: 'admin_users_0' },
            ],
            [{ text: `📢 Рассылка`, callback_data: 'admin_broadcast' }],
        ],
    };
}

bot.onText(/^\/admin(?:@\w+)?$/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    try {
        const d = await buildAdminPanelData();
        await safeSend(msg.chat.id, buildAdminPanelText(d), { parse_mode: 'HTML', reply_markup: buildAdminPanelKeyboard(d) });
    } catch (e) { console.error('/admin:', e); await safeSend(msg.chat.id, '❌ Ошибка.'); }
});

// ============ ГЛАВНЫЙ ОБРАБОТЧИК ============
bot.on('message', async (msg) => {
    pollingErrors = 0;
    if (msg.chat.type !== 'private') return;
    const userId = msg.from?.id;
    if (!userId) return;

    if (await tryHandleBroadcast(msg)) return;

    let fileId = null;
    if (msg.photo && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
    else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) fileId = msg.document.file_id;

    if (fileId) {
        const state = awaitingScreenshot.get(userId);
        if (!state) return;
        if (Date.now() - state.ts > SCREENSHOT_TIMEOUT_MS) {
            awaitingScreenshot.delete(userId);
            return safeSend(msg.chat.id, '⌛ Время истекло.');
        }
        if (fileId.length < 10) return safeSend(msg.chat.id, '❌ Не удалось получить файл.');

        awaitingScreenshot.delete(userId);
        const taskId = state.taskId;

        try {
            const { id: subId, task } = await db.createSubmission(taskId, userId, fileId);
            const user = await db.getUser(userId);
            await safeSend(msg.chat.id, `✅ Скриншот принят!\n⭐ ${formatStars(task.reward)} звёзд после одобрения.`);
            try {
                await bot.sendPhoto(ADMIN_ID, fileId, {
                    caption: `📸 <b>Заявка #${subId}</b>\n👤 ${escapeHtml(user.first_name || '')} (@${escapeHtml(user.username || 'нет')})\n📺 @${escapeHtml(task.channel_username)}\n⭐ ${formatStars(task.reward)}`,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[
                        { text: '✅ Принять', callback_data: `approve_${subId}` },
                        { text: '❌ Отклонить', callback_data: `reject_${subId}` },
                    ]] },
                });
            } catch (e) { console.error('notify admin:', e.message); }
        } catch (e) {
            const map = {
                ALREADY_PENDING: '⏳ Уже на проверке.',
                ALREADY_DONE: '✅ Уже выполнено.',
                NOT_FOUND: '❌ Задание не найдено.',
                BUDGET_EMPTY: '😞 Бюджет исчерпан.',
                TOO_MANY_PENDING: '⚠️ У тебя 5 заявок на проверке.',
                OWN_TASK: '❌ Своё задание нельзя.',
                SAME_SCREENSHOT: '❌ Это фото уже использовалось.',
            };
            await safeSend(msg.chat.id, map[e.message] || '❌ Ошибка.');
        }
        return;
    }

    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    // ===== Ввод своей суммы для крипты =====
    if (awaitingCryptoAmount.has(userId)) {
        if (Date.now() - awaitingCryptoAmount.get(userId) > 5 * 60 * 1000) {
            awaitingCryptoAmount.delete(userId);
            return safeSend(msg.chat.id, '⌛ Время истекло. Попробуй снова.');
        }

        if (!msg.text) return safeSend(msg.chat.id, '📝 Введи сумму числом.');

        const amount = parseFloat(text.replace(',', '.'));
        if (Number.isNaN(amount) || amount < CRYPTO_MIN_AMOUNT || amount > CRYPTO_MAX_AMOUNT) {
            return safeSend(msg.chat.id, `❌ Нужно число от ${CRYPTO_MIN_AMOUNT} до ${CRYPTO_MAX_AMOUNT}.`);
        }

        awaitingCryptoAmount.delete(userId);
        const amountR = Math.round(amount * 100) / 100;

        await sendCryptoInvoice(msg.chat.id, userId, amountR);
        return;
    }

    const wState = awaitingWithdraw.get(userId);
    if (wState) {
        if (!wState.promptSent) return;
        if (['💰 Заработать', '📢 Рекламировать', '👤 Мой кабинет', '💳 Пополнить', '🔄 Обменять'].includes(text)) {
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
            case '💳 Пополнить': return handleCryptoDeposit(msg.chat.id, userId);
            case '🔄 Обменять': return handleExchangeMenu(msg.chat.id, userId);
        }

        if (text.startsWith('создать ')) return handleCreateTask(msg);
        await safeSend(msg.chat.id, 'Используйте кнопки меню.', mainKeyboard);
    } catch (e) { console.error('message:', e); await safeSend(msg.chat.id, '❌ Ошибка.'); }
});

// ============ ЗАРАБОТОК ============
async function handleEarnCommand(chatId, userId, page = 0) {
    const tasks = await db.getActiveTasks(userId, 100);
    if (!tasks.length) return safeSend(chatId, '😔 Нет доступных заданий.');

    const taskIds = tasks.map(t => t.id);
    const completedRes = await pool.query(`SELECT task_id FROM task_completions WHERE user_id = $1 AND task_id = ANY($2::int[])`, [userId, taskIds]);
    const completed = new Set(completedRes.rows.map(r => r.task_id));
    const pendingRes = await pool.query(`SELECT task_id FROM submissions WHERE user_id = $1 AND status = 'pending' AND task_id = ANY($2::int[])`, [userId, taskIds]);
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

        message += `${num}. @${t.channel_username}\n⭐ ${formatStars(reward)} звёзд | 📊 ${t.completed_count}/${maxC}\n`;
        if (isPending) message += `⏳ На проверке\n`;
        message += `\n`;

        keyboard.push([{ text: `🔗 Подписаться на @${chan}`, url: `https://t.me/${chan}` }]);
        if (!isPending) keyboard.push([{ text: `📸 Отправить скриншот (${num})`, callback_data: `send_screenshot_${t.id}` }]);
        else keyboard.push([{ text: `⏳ На проверке (${num})`, callback_data: 'noop' }]);
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
    const message = `📢 Создание задания\n\n⭐ Баланс: ${formatStars(user.balance)} звёзд\n\n📝 Отправьте: <code>создать @канал награда бюджет</code>\n📋 Пример: <code>создать @example 0.05 5</code>\n\n⚖️ Награда: ${MIN_TASK_REWARD}–${MAX_TASK_REWARD} звёзд`;
    await safeSend(chatId, message, { parse_mode: 'HTML' });
}

async function handleCabinetCommand(chatId, user) {
    const link = `https://t.me/${BOT_USERNAME}?start=_${user.id}`;
    const message = `👤 Личный кабинет\n\n🆔 ID: <code>${user.id}</code>\n⭐ Баланс: <b>${formatStars(user.balance)}</b>\n👥 Рефералов: <b>${user.referral_count}</b>\n📅 Регистрация: ${new Date(user.created_at).toLocaleDateString('ru-RU')}\n\n🔗 Ссылка:\n<code>${link}</code>`;
    await safeSend(chatId, message, { parse_mode: 'HTML', ...cabinetKeyboard });
}

// ============ СОЗДАНИЕ ЗАДАНИЯ ============
async function handleCreateTask(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length !== 4) return safeSend(chatId, '❌ Формат: <code>создать @канал награда бюджет</code>', { parse_mode: 'HTML' });

        const channel = parts[1].replace(/^@/, '');
        const reward = parseFloat(parts[2].replace(',', '.'));
        const budget = parseFloat(parts[3].replace(',', '.'));

        if (!CHANNEL_REGEX.test(channel)) return safeSend(chatId, '❌ Некорректное имя канала.');
        if (isNaN(reward) || isNaN(budget) || reward <= 0 || budget <= 0) return safeSend(chatId, '❌ Награда и бюджет — числа.');
        if (reward < MIN_TASK_REWARD || reward > MAX_TASK_REWARD) return safeSend(chatId, `❌ Награда: ${MIN_TASK_REWARD}–${MAX_TASK_REWARD}⭐.`);
        if (budget < reward) return safeSend(chatId, '❌ Бюджет < награды.');

        const rewardR = Math.round(reward * 10000) / 10000;
        const budgetR = Math.round(budget * 10000) / 10000;

        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            const deduct = await c.query(`UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`, [budgetR, userId]);
            if (deduct.rowCount === 0) { await c.query('ROLLBACK'); return safeSend(chatId, `❌ Недостаточно звёзд. Нужно: ${formatStars(budgetR)}.`); }
            await c.query(`INSERT INTO tasks (owner_id, channel_username, reward, total_budget) VALUES ($1, $2, $3, $4)`, [userId, channel, rewardR, budgetR]);
            await c.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [userId, -budgetR, 'task_payment', `Задание для @${channel}`]);
            await c.query('COMMIT');
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            console.error('createTask:', e);
            return safeSend(chatId, '❌ Ошибка при создании задания.');
        } finally { c.release(); }

        await safeSend(chatId, `✅ Задание создано!\n\n📺 @${channel}\n⭐ ${formatStars(rewardR)} за подписку\n💰 Бюджет: ${formatStars(budgetR)}\n👥 Макс: ${Math.floor(budgetR / rewardR)}`);
    } catch (e) { console.error('handleCreateTask:', e); await safeSend(chatId, '❌ Ошибка.'); }
}

// ============ ВЫВОД ============
async function handleWithdrawRequest(chatId, userId) {
    const now = Date.now();
    for (const [uid, st] of awaitingWithdraw.entries()) {
        if (now - st.ts > WITHDRAW_TIMEOUT_MS) awaitingWithdraw.delete(uid);
    }
    const existing = awaitingWithdraw.get(userId);
    if (existing && now - existing.ts < WITHDRAW_TIMEOUT_MS) return safeSend(chatId, '⏳ Ты уже в процессе.');

    const ts = Date.now();
    awaitingWithdraw.set(userId, { ts, promptSent: false });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); awaitingWithdraw.delete(userId); return safeSend(chatId, 'Начните с /start'); }
        if (parseFloat(user.balance) < MIN_WITHDRAW) { await client.query('ROLLBACK'); awaitingWithdraw.delete(userId); return safeSend(chatId, `❌ Нужно ${MIN_WITHDRAW}⭐ (у тебя ${formatStars(user.balance)}).`); }
        const pending = await client.query(`SELECT id FROM withdraw_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`, [userId]);
        if (pending.rowCount > 0) { await client.query('ROLLBACK'); awaitingWithdraw.delete(userId); return safeSend(chatId, `⏳ Уже есть заявка #${pending.rows[0].id}.`); }
        await client.query('COMMIT');
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        awaitingWithdraw.delete(userId);
        console.error('withdraw req:', e);
        return safeSend(chatId, '❌ Ошибка.');
    } finally { if (client) client.release(); }

    if (awaitingWithdraw.get(userId)?.ts === ts) {
        awaitingWithdraw.set(userId, { ts, promptSent: true });
        await safeSend(chatId, `🎁 Вывод подарка «Мишка» (15⭐)\n\n⭐ Стоимость: ${GIFT_COST} звёзд\n📝 Отправь @username\n⏱ 10 минут. Отмена — /cancel`);
    }
}

async function handleUsernameInput(msg, userId, ts) {
    const chatId = msg.chat.id;
    if (Date.now() - ts > WITHDRAW_TIMEOUT_MS) { awaitingWithdraw.delete(userId); return safeSend(chatId, '⌛ Время истекло.'); }
    if (!msg.text) return safeSend(chatId, '📝 Отправь @username.');
    const text = msg.text.trim();
    if (!USERNAME_REGEX.test(text)) return safeSend(chatId, '❌ Некорректный @username.');

    awaitingWithdraw.delete(userId);

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); return safeSend(chatId, 'Начните с /start'); }

        const pending = await client.query(`SELECT id FROM withdraw_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`, [userId]);
        if (pending.rowCount > 0) { await client.query('ROLLBACK'); return safeSend(chatId, `⏳ Уже есть заявка.`); }

        const deduct = await client.query(`UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`, [GIFT_COST, userId]);
        if (deduct.rowCount === 0) { await client.query('ROLLBACK'); return safeSend(chatId, '❌ Недостаточно звёзд.'); }

        const ins = await client.query(`INSERT INTO withdraw_requests (user_id, username, gift) VALUES ($1, $2, $3) RETURNING id`, [userId, text, 'Мишка (15⭐)']);
        const reqId = ins.rows[0].id;
        await client.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [userId, -GIFT_COST, 'withdraw_hold', `Заявка #${reqId}`]);
        await client.query('COMMIT');

        try {
            await bot.sendMessage(ADMIN_ID,
                `🔔 <b>Заявка #${reqId}</b>\n👤 ${escapeHtml(user.first_name || '')} (@${escapeHtml(user.username || 'нет')})\n📮 ${escapeHtml(text)}\n🎁 Мишка | ⭐ -${GIFT_COST}\n💳 Остаток: ${formatStars(deduct.rows[0].balance)}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                    { text: '✅ Принять', callback_data: `admin_accept_${reqId}` },
                    { text: '❌ Отклонить', callback_data: `admin_reject_${reqId}` },
                ]] } }
            );
        } catch (e) { console.error('notify admin:', e.message); }

        await safeSend(chatId, `✅ Заявка #${reqId} создана. Списано ${GIFT_COST}⭐.`);
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('withdraw create:', e);
        await safeSend(chatId, '❌ Ошибка.');
    } finally { if (client) client.release(); }
}
async function handleAdminAccept(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(`UPDATE withdraw_requests SET status = 'accepted', processed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`, [reqId]);
        if (upd.rowCount === 0) { await client.query('ROLLBACK'); return answer({ text: 'Уже обработана.' }); }
        const req = upd.rows[0];
        await client.query('COMMIT');
        try { await bot.sendMessage(req.user_id, `🎉 Заявка #${reqId} принята!`); } catch (e) {}
        try { await bot.sendMessage(ADMIN_ID, `✅ #${reqId}.\n👉 https://t.me/${req.username.replace('@', '')}`); } catch (e) {}
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {}
        await answer({ text: 'Принято!' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('accept:', e);
        await answer({ text: 'Ошибка' });
    } finally { if (client) client.release(); }
}

async function handleAdminReject(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(`UPDATE withdraw_requests SET status = 'rejected', processed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`, [reqId]);
        if (upd.rowCount === 0) { await client.query('ROLLBACK'); return answer({ text: 'Уже обработана.' }); }
        const req = upd.rows[0];
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [GIFT_COST, req.user_id]);
        await client.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [req.user_id, GIFT_COST, 'withdraw_refund', `Возврат #${reqId}`]);
        await client.query('COMMIT');
        try { await bot.sendMessage(req.user_id, `❌ Заявка #${reqId} отклонена. ${GIFT_COST}⭐ возвращены.`); } catch (e) {}
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {}
        await answer({ text: 'Отклонено.' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('reject:', e);
        await answer({ text: 'Ошибка' });
    } finally { if (client) client.release(); }
}

async function handleApproveSubmission(cb, subId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(subId) || subId <= 0) return answer({ text: 'Неверный ID.' });
    try {
        const { task, submission } = await db.approveSubmission(subId);
        try { await bot.sendMessage(submission.user_id, `🎉 @${task.channel_username} одобрено!\n⭐ +${formatStars(task.reward)}`); } catch (e) {}
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {}
        await answer({ text: 'Одобрено!' });
    } catch (e) {
        console.error('approve:', e);
        const map = { ALREADY_DONE: 'Уже обработана', NOT_FOUND: 'Не найдена', NO_SCREENSHOT: 'Нет скриншота', BUDGET_EMPTY: 'Бюджет исчерпан', TASK_CLOSED: 'Задание закрыто' };
        await answer({ text: map[e.message] || 'Ошибка' });
    }
}

async function handleRejectSubmission(cb, subId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(subId) || subId <= 0) return answer({ text: 'Неверный ID.' });
    try {
        const sub = await db.rejectSubmission(subId, 'Скриншот не подтверждает подписку');
        try { await bot.sendMessage(sub.user_id, `❌ Отклонено.`); } catch (e) {}
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {}
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
        const total = parseInt((await pool.query(`SELECT COUNT(*) FROM submissions WHERE status = 'pending'`)).rows[0].count, 10);
        if (total === 0) { await safeSend(cb.message.chat.id, 'Нет заявок.'); return answer(); }
        if (offset >= total) offset = Math.max(0, Math.floor((total - 1) / 5) * 5);
        const pending = await pool.query(
            `SELECT s.id, s.user_id, t.channel_username, t.reward, u.username, u.first_name FROM submissions s
             JOIN tasks t ON s.task_id = t.id JOIN users u ON s.user_id = u.id
             WHERE s.status = 'pending' ORDER BY s.created_at ASC LIMIT 5 OFFSET $1`,
            [offset]
        );
        await safeSend(cb.message.chat.id, `📸 Заявки ${offset + 1}–${offset + pending.rowCount} из ${total}:`);
        for (const s of pending.rows) {
            try {
                const subRes = await pool.query('SELECT screenshot_file_id FROM submissions WHERE id = $1', [s.id]);
                const fileId = subRes.rows[0]?.screenshot_file_id;
                if (fileId) {
                    await bot.sendPhoto(cb.message.chat.id, fileId, {
                        caption: `#${s.id} | @${escapeHtml(s.channel_username)}\n👤 ${escapeHtml(s.first_name || '')} (@${escapeHtml(s.username || 'нет')})\n⭐ ${formatStars(s.reward)}`,
                        reply_markup: { inline_keyboard: [[
                            { text: '✅ Принять', callback_data: `approve_${s.id}` },
                            { text: '❌ Отклонить', callback_data: `reject_${s.id}` },
                        ]] },
                    });
                    await new Promise(r => setTimeout(r, 100));
                }
            } catch (e) { console.error('sendPhoto:', e.message); }
        }
        const nav = [];
        if (offset > 0) nav.push({ text: '⬅️', callback_data: `admin_pending_${Math.max(0, offset - 5)}` });
        if (offset + 5 < total) nav.push({ text: '➡️', callback_data: `admin_pending_${offset + 5}` });
        if (nav.length) await safeSend(cb.message.chat.id, 'Навигация:', { reply_markup: { inline_keyboard: [nav] } });
        await answer();
    } catch (e) { console.error('handleAdminPending:', e); await answer({ text: 'Ошибка' }); }
}

async function handleAdminTasks(cb, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    try {
        const total = parseInt((await pool.query('SELECT COUNT(*) FROM tasks')).rows[0].count, 10);
        if (total === 0) { await safeSend(cb.message.chat.id, '📋 Заданий нет.'); return answer(); }
        if (offset >= total) offset = Math.max(0, Math.floor((total - 1) / ADMIN_TASKS_PAGE) * ADMIN_TASKS_PAGE);
        const tasks = await pool.query(
            `SELECT t.*, u.username as owner_username FROM tasks t JOIN users u ON t.owner_id = u.id
             ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
            [ADMIN_TASKS_PAGE, offset]
        );
        let allText = `📋 <b>Задания</b> (${offset + 1}–${offset + tasks.rowCount} из ${total}):\n\n`;
        const allButtons = [];
        for (const t of tasks.rows) {
            const reward = parseFloat(t.reward);
            const budget = parseFloat(t.total_budget);
            const maxC = Math.floor(budget / reward);
            const spent = t.completed_count * reward;
            allText += `#${t.id} ${t.is_active ? '🟢' : '🔴'} @${t.channel_username}\n⭐ ${formatStars(reward)} | 💰 ${formatStars(budget)} | 📊 ${t.completed_count}/${maxC}\n\n`;
            allButtons.push([
                { text: `${t.is_active ? '⏸' : '▶️'} #${t.id}`, callback_data: `admin_task_toggle_${t.id}_${offset}` },
                { text: `🗑 #${t.id}`, callback_data: `admin_task_delete_${t.id}_${offset}` },
            ]);
        }
        await safeSend(cb.message.chat.id, trimIfLong(allText), { parse_mode: 'HTML' });
        const nav = [];
        if (offset > 0) nav.push({ text: '⬅️', callback_data: `admin_tasks_${Math.max(0, offset - ADMIN_TASKS_PAGE)}` });
        if (offset + ADMIN_TASKS_PAGE < total) nav.push({ text: '➡️', callback_data: `admin_tasks_${offset + ADMIN_TASKS_PAGE}` });
        nav.push({ text: '🔙 В меню', callback_data: 'admin_refresh' });
        await safeSend(cb.message.chat.id, '⚙️ Управление:', { reply_markup: { inline_keyboard: [...allButtons, nav] } });
        await answer();
    } catch (e) { console.error('handleAdminTasks:', e); await answer({ text: 'Ошибка' }); }
}

async function handleAdminTaskToggle(cb, taskId, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    try {
        const r = await pool.query(`UPDATE tasks SET is_active = NOT is_active WHERE id = $1 RETURNING is_active`, [taskId]);
        if (r.rowCount === 0) return answer({ text: 'Не найдено' });
        const isActive = r.rows[0].is_active;
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [[
                { text: isActive ? '⏸ Выключить' : '▶️ Включить', callback_data: `admin_task_toggle_${taskId}_${offset}` },
                { text: '🗑 Удалить', callback_data: `admin_task_delete_${taskId}_${offset}` },
            ]] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
        } catch (e) {}
        await answer({ text: isActive ? '✅ Включено' : '⏸ Выключено' });
    } catch (e) { console.error('toggle:', e); await answer({ text: 'Ошибка' }); }
}

async function handleAdminTaskDelete(cb, taskId, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    try {
        const r = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
        if (r.rowCount === 0) return answer({ text: 'Не найдено' });
        const task = r.rows[0];
        await safeSend(cb.message.chat.id,
            `⚠️ <b>Удалить #${taskId}?</b>\n\n📺 @${task.channel_username}\n⭐ ${formatStars(task.reward)}\n💰 ${formatStars(task.total_budget)}`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                { text: '🗑 Да', callback_data: `admin_task_delete_confirm_${taskId}_${offset}` },
                { text: '↩️ Нет', callback_data: `admin_tasks_${offset}` },
            ]] } }
        );
        await answer();
    } catch (e) { console.error('delete ask:', e); await answer({ text: 'Ошибка' }); }
}

async function handleAdminTaskDeleteConfirm(cb, taskId, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    const c = await pool.connect();
    let task = null;
    let pendingSubs = null;
    try {
        await c.query('BEGIN');
        const r = await c.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
        if (r.rowCount === 0) { await c.query('ROLLBACK'); return answer({ text: 'Уже удалено' }); }
        task = r.rows[0];
        const spent = task.completed_count * parseFloat(task.reward);
        const refund = Math.max(0, parseFloat(task.total_budget) - spent);
        if (refund > 0) {
            await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [refund, task.owner_id]);
            await c.query(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`, [task.owner_id, refund, 'task_refund', `Возврат за удаление #${taskId}`]);
        }
        pendingSubs = await c.query(`SELECT user_id FROM submissions WHERE task_id = $1 AND status = 'pending'`, [taskId]);
        await c.query('DELETE FROM submissions WHERE task_id = $1', [taskId]);
        await c.query('DELETE FROM task_completions WHERE task_id = $1', [taskId]);
        await c.query('DELETE FROM tasks WHERE id = $1', [taskId]);
        await c.query('COMMIT');
        try { await bot.sendMessage(task.owner_id, `⚠️ Задание @${task.channel_username} удалено.\n${refund > 0 ? `💰 Возвращено: ${formatStars(refund)}⭐` : ''}`); } catch (e) {}
        for (const s of pendingSubs.rows) {
            try { await bot.sendMessage(s.user_id, `⚠️ Задание @${task.channel_username} удалено. Скриншот не будет обработан.`); } catch (e) {}
        }
        await answer({ text: '✅ Удалено' });
        await handleAdminTasks(cb, 0, () => {});
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('delete confirm:', e);
        await answer({ text: 'Ошибка' });
    } finally { c.release(); }
}

async function handleAdminUsers(cb, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    try {
        const total = parseInt((await pool.query('SELECT COUNT(*) FROM users')).rows[0].count, 10);
        if (total === 0) { await safeSend(cb.message.chat.id, '👥 Нет.'); return answer(); }
        if (offset >= total) offset = Math.max(0, Math.floor((total - 1) / ADMIN_USERS_PAGE) * ADMIN_USERS_PAGE);
        const users = await pool.query(
            `SELECT id, username, first_name, balance, referral_count FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
            [ADMIN_USERS_PAGE, offset]
        );
        let msg = `👥 <b>Юзеры</b> (${offset + 1}–${offset + users.rowCount} из ${total}):\n\n`;
        for (const u of users.rows) {
            msg += `<code>${u.id}</code> ${escapeHtml(u.first_name || '')} @${escapeHtml(u.username || 'нет')} | ⭐${formatStars(u.balance)} | 👥${u.referral_count}\n`;
        }
        const nav = [];
        if (offset > 0) nav.push({ text: '⬅️', callback_data: `admin_users_${Math.max(0, offset - ADMIN_USERS_PAGE)}` });
        if (offset + ADMIN_USERS_PAGE < total) nav.push({ text: '➡️', callback_data: `admin_users_${offset + ADMIN_USERS_PAGE}` });
        nav.push({ text: '🔙 В меню', callback_data: 'admin_refresh' });
        await safeSend(cb.message.chat.id, trimIfLong(msg), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [nav] } });
        await answer();
    } catch (e) { console.error('users:', e); await answer({ text: 'Ошибка' }); }
}

async function handleAdminWithdrawals(cb, offset, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    if (!Number.isInteger(offset) || offset < 0) offset = 0;

    try {
        const wTotal = parseInt((await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`)).rows[0].count, 10);
        const eTotal = parseInt((await pool.query(`SELECT COUNT(*) FROM exchange_requests WHERE status = 'pending'`)).rows[0].count, 10);
        const total = wTotal + eTotal;

        if (total === 0) {
            await safeSend(cb.message.chat.id, '🎁 Нет активных заявок.');
            return answer();
        }
        if (offset >= total) offset = Math.max(0, Math.floor((total - 1) / 5) * 5);

        const wRows = await pool.query(
            `SELECT w.id, w.user_id, w.username, w.gift, w.created_at,
                    u.username as user_username, u.first_name, 'withdraw' as type
             FROM withdraw_requests w JOIN users u ON w.user_id = u.id
             WHERE w.status = 'pending' ORDER BY w.created_at ASC`
        );
        const eRows = await pool.query(
            `SELECT e.id, e.user_id, e.stars, e.gold, e.created_at,
                    u.username as user_username, u.first_name, 'exchange' as type
             FROM exchange_requests e JOIN users u ON e.user_id = u.id
             WHERE e.status = 'pending' ORDER BY e.created_at ASC`
        );

        const all = [...wRows.rows, ...eRows.rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const slice = all.slice(offset, offset + 5);

        await safeSend(cb.message.chat.id,
            `🎁 <b>Заявки</b> (${offset + 1}–${offset + slice.length} из ${total}):\n` +
            `(подарки: ${wTotal}, обмен: ${eTotal})`,
            { parse_mode: 'HTML' }
        );

        for (const item of slice) {
            if (item.type === 'withdraw') {
                await safeSend(cb.message.chat.id,
                    `🎁 <b>Вывод #${item.id}</b>\n` +
                    `👤 ${escapeHtml(item.first_name || '')} (@${escapeHtml(item.user_username || 'нет')})\n` +
                    `📮 ${escapeHtml(item.username)}\n` +
                    `🎁 ${item.gift}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: `✅ #${item.id}`, callback_data: `admin_accept_${item.id}` },
                                { text: `❌ #${item.id}`, callback_data: `admin_reject_${item.id}` },
                            ]],
                        },
                    }
                );
            } else {
                await safeSend(cb.message.chat.id,
                    `🟡 <b>Обмен #${item.id}</b>\n` +
                    `👤 ${escapeHtml(item.first_name || '')} (@${escapeHtml(item.user_username || 'нет')})\n` +
                    `⭐ Списано: ${formatStars(item.stars)}\n` +
                    `🟡 К начислению: ${formatStars(item.gold)} Голды`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: `✅ #${item.id}`, callback_data: `admin_exch_accept_${item.id}` },
                                { text: `❌ #${item.id}`, callback_data: `admin_exch_reject_${item.id}` },
                            ]],
                        },
                    }
                );
            }
            await new Promise(r => setTimeout(r, 80));
        }

        const nav = [];
        if (offset > 0) nav.push({ text: '⬅️', callback_data: `admin_withdrawals_${Math.max(0, offset - 5)}` });
        if (offset + 5 < total) nav.push({ text: '➡️', callback_data: `admin_withdrawals_${offset + 5}` });
        nav.push({ text: '🔙 В меню', callback_data: 'admin_refresh' });
        if (nav.length) await safeSend(cb.message.chat.id, 'Навигация:', { reply_markup: { inline_keyboard: [nav] } });

        await answer();
    } catch (e) {
        console.error('handleAdminWithdrawals:', e);
        await answer({ text: 'Ошибка' });
    }
}
async function handleAdminBroadcast(cb, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Только для админа.' });
    broadcastState.set(cb.from.id, true);
    await safeSend(cb.message.chat.id, `📢 <b>Рассылка</b>\n\nОтправь текст, фото, видео или стикер.\n❌ Отмена — /cancel`, { parse_mode: 'HTML' });
    await answer();
}

async function tryHandleBroadcast(msg) {
    const userId = msg.from?.id;
    if (userId !== ADMIN_ID) return false;
    if (!broadcastState.get(userId)) return false;
    if (broadcastRunning.has(userId)) { await safeSend(msg.chat.id, '⚠️ Рассылка уже идёт.'); return true; }
    if (!msg.text && !msg.photo && !msg.video && !msg.sticker) {
        await safeSend(msg.chat.id, '⚠️ Поддерживается: текст, фото, видео, стикер.');
        return true;
    }
    broadcastState.delete(userId);
    broadcastRunning.add(userId);
    try {
        const users = await pool.query('SELECT id FROM users');
        let sent = 0, failed = 0, cancelled = false;
        await safeSend(msg.chat.id, `📢 Рассылка для ${users.rowCount}...\n❌ Отмена — /cancel`);
        for (const u of users.rows) {
            if (!broadcastRunning.has(userId)) { cancelled = true; break; }
            try {
                if (msg.text) await bot.sendMessage(u.id, msg.text, { parse_mode: 'HTML' });
                else if (msg.photo) await bot.sendPhoto(u.id, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || '' });
                else if (msg.video) await bot.sendVideo(u.id, msg.video.file_id, { caption: msg.caption || '' });
                else if (msg.sticker) await bot.sendSticker(u.id, msg.sticker.file_id);
                sent++;
                await new Promise(r => setTimeout(r, 30));
            } catch (e) { failed++; }
        }
        await safeSend(msg.chat.id, cancelled ? `⏹ Отменено. Отправлено: ${sent}` : `✅ Готово. Отправлено: ${sent}, ошибок: ${failed}`);
    } finally { broadcastRunning.delete(userId); }
    return true;
}

// ============ КРИПТО ============
async function handleCryptoDeposit(chatId, userId) {
    if (!cryptoClient) return safeSend(chatId, '❌ Крипта недоступна.');

    const message =
        `💳 <b>Пополнение через крипту</b>\n\n` +
        `💵 Курс: 1 USDT = ${USDT_TO_STARS} звёзд\n` +
        `💡 Минимум: ${MIN_WITHDRAW} звёзд для вывода\n` +
        `📉 Мин. сумма: ${CRYPTO_MIN_AMOUNT} USDT\n\n` +
        `Выбери сумму:`;

    const keyboard = CRYPTO_PACKAGES.map(amount => [{
        text: `💵 ${amount} USDT → ${amount * USDT_TO_STARS} звёзд`,
        callback_data: `crypto_buy_${amount}`,
    }]);

    // ✅ Кнопка "своя сумма"
    keyboard.push([{ text: '✏️ Своя сумма', callback_data: 'crypto_custom' }]);

    await safeSend(chatId, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendCryptoInvoice(chatId, userId, usdtAmount) {
    if (!cryptoClient) return safeSend(chatId, '❌ Крипта недоступна.');

    if (!Number.isFinite(usdtAmount) || usdtAmount < CRYPTO_MIN_AMOUNT || usdtAmount > CRYPTO_MAX_AMOUNT) {
        return safeSend(chatId, `❌ Сумма должна быть от ${CRYPTO_MIN_AMOUNT} до ${CRYPTO_MAX_AMOUNT} USDT.`);
    }

    const payload = `dep_${userId}_${usdtAmount}_${Date.now()}`;

    try {
        const invoice = await cryptoClient.createInvoice({
            asset: 'USDT',
            amount: usdtAmount.toString(),
            description: `Пополнение на ${usdtAmount} USDT`,
            payload: payload,
            paid_btn_name: 'callback',
            paid_btn_url: `https://t.me/${BOT_USERNAME}`,
        });

        // Отладка — покажет в логах, что вернул CryptoBot
        console.log('Invoice result:', JSON.stringify(invoice));

        // Проверка: есть ли URL счёта
        if (!invoice || !invoice.botPayUrl) {
            console.error('❌ Пустой botPayUrl:', invoice);
            return safeSend(chatId, '❌ Не удалось создать счёт. Попробуй позже.');
        }

        await safeSend(chatId,
            `💳 <b>Счёт на ${usdtAmount} USDT</b>\n\n` +
            `⭐ Придёт ${Math.round(usdtAmount * USDT_TO_STARS * 10000) / 10000} звёзд.\n` +
            `⏱ Счёт действует 1 час.\n\n` +
            `👇 Нажми кнопку ниже, чтобы оплатить:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `💳 Оплатить ${usdtAmount} USDT`, url: invoice.botPayUrl }
                    ]],
                },
            }
        );
    } catch (e) {
        console.error('sendCryptoInvoice:', e.message);
        await safeSend(chatId, '❌ Ошибка. Попробуй позже.');
    }
}

// ============ CALLBACK ============
bot.on('callback_query', async (cb) => {
    const action = cb.data;
    if (!action || typeof action !== 'string') { try { await bot.answerCallbackQuery(cb.id); } catch (e) {} return; }
    const msg = cb.message;
    if (!msg || !msg.chat) { try { await bot.answerCallbackQuery(cb.id); } catch (e) {} return; }
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
        } else if (action === 'crypto_deposit') {
            await handleCryptoDeposit(chatId, userId);
            await answer();
        } else if (action === 'crypto_custom') {
            awaitingCryptoAmount.set(userId, Date.now());
            await safeSend(chatId,
                `✏️ <b>Своя сумма</b>\n\n` +
                `Введи сумму в USDT (от ${CRYPTO_MIN_AMOUNT} до ${CRYPTO_MAX_AMOUNT}).\n` +
                `Пример: <code>0.5</code>\n\n` +
                `💡 1 USDT = ${USDT_TO_STARS} звёзд\n` +
                `❌ Отмена — /cancel`,
                { parse_mode: 'HTML' }
            );
            await answer();
        } else if (action.startsWith('crypto_buy_')) {
            const amount = parseFloat(action.slice(11));
            await answer();
            await sendCryptoInvoice(chatId, userId, amount);
        } else if (action === 'withdraw_gift') {
            await answer();
            await handleWithdrawRequest(chatId, userId);
        } else if (action.startsWith('send_screenshot_')) {
            const taskId = parseInt(action.slice(16), 10);
            if (!Number.isInteger(taskId) || taskId <= 0) return answer({ text: 'Неверное задание' });
            const existing = awaitingScreenshot.get(userId);
            if (existing && Date.now() - existing.ts < SCREENSHOT_TIMEOUT_MS && existing.taskId !== taskId) {
                return answer({ text: '⚠️ Сначала отправь скриншот или /cancel' });
            }
            awaitingScreenshot.set(userId, { taskId, ts: Date.now() });
            await safeSend(chatId, `📸 Отправь скриншот.\n⏱ 10 минут. Отмена — /cancel`);
            await answer();
        } else if (action === 'noop') {
            await answer({ text: 'Уже на проверке' });
        } else if (action.startsWith('approve_')) {
            await handleApproveSubmission(cb, parseInt(action.slice(8), 10), answer);
        } else if (action.startsWith('reject_')) {
            await handleRejectSubmission(cb, parseInt(action.slice(7), 10), answer);
        } else if (action.startsWith('admin_accept_')) {
            await handleAdminAccept(cb, parseInt(action.slice(13), 10), answer);
        } else if (action.startsWith('admin_reject_')) {
            await handleAdminReject(cb, parseInt(action.slice(13), 10), answer);
        } else if (action.startsWith('admin_pending_')) {
            await handleAdminPending(cb, parseInt(action.slice(14), 10) || 0, answer);
        } else if (action.startsWith('admin_tasks_')) {
            await handleAdminTasks(cb, parseInt(action.slice(12), 10) || 0, answer);
        } else if (action.startsWith('admin_task_toggle_')) {
            const p = action.split('_');
            await handleAdminTaskToggle(cb, parseInt(p[3], 10), parseInt(p[4], 10), answer);
        } else if (action.startsWith('admin_task_delete_confirm_')) {
            const p = action.split('_');
            await handleAdminTaskDeleteConfirm(cb, parseInt(p[4], 10), parseInt(p[5], 10), answer);
        } else if (action.startsWith('admin_task_delete_')) {
            const p = action.split('_');
            await handleAdminTaskDelete(cb, parseInt(p[3], 10), parseInt(p[4], 10), answer);
        } else if (action.startsWith('admin_users_')) {
            await handleAdminUsers(cb, parseInt(action.slice(12), 10) || 0, answer);
        } else if (action.startsWith('admin_withdrawals_')) {
            await handleAdminWithdrawals(cb, parseInt(action.slice(18), 10) || 0, answer);
        } else if (action === 'admin_broadcast') {
            await handleAdminBroadcast(cb, answer);
        } else if (action === 'admin_refresh') {
            await answer();
            try {
                const d = await buildAdminPanelData();
                await bot.editMessageText(buildAdminPanelText(d), {
                    chat_id: cb.message.chat.id,
                    message_id: cb.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: buildAdminPanelKeyboard(d),
                });
            } catch (e) {
                const d = await buildAdminPanelData();
                await safeSend(cb.message.chat.id, buildAdminPanelText(d), {
                    parse_mode: 'HTML',
                    reply_markup: buildAdminPanelKeyboard(d),
                });
            }
        } else {
            await answer();
        }
    } catch (e) {
        console.error('callback:', e);
        await answer({ text: 'Ошибка' });
    }
});

// ============ БД ============
async function initDatabase() {                              
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ БД подключена');
        await createTablesIfNotExist();
    } catch (e) { console.error('❌ Ошибка БД:', e); process.exit(1); }
}

async function createTablesIfNotExist() {
    const check = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users');`);
    if (!check.rows[0].exists) {
        console.log('🔄 Создание таблиц...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY, username VARCHAR(255), first_name VARCHAR(255),
                balance NUMERIC(12,4) DEFAULT 0, referral_count INTEGER DEFAULT 0,
                referred_by BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, channel_username VARCHAR(255) NOT NULL,
                reward NUMERIC(10,4) NOT NULL CHECK (reward >= 0.25 AND reward <= 10),
                total_budget NUMERIC(12,4) NOT NULL, completed_count INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS task_completions (
                id SERIAL PRIMARY KEY, task_id INTEGER NOT NULL, user_id BIGINT NOT NULL,
                completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id), FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(task_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, amount NUMERIC(12,4) NOT NULL,
                type VARCHAR(50) NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);
        console.log('✅ Таблицы созданы');
    } else {
        console.log('✅ Таблицы уже есть');
    }

    try {
        await pool.query(`ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(12,4) USING balance::numeric`);
        await pool.query(`ALTER TABLE tasks ALTER COLUMN reward TYPE NUMERIC(10,4) USING reward::numeric`);
        await pool.query(`ALTER TABLE tasks ALTER COLUMN total_budget TYPE NUMERIC(12,4) USING total_budget::numeric`);
        await pool.query(`ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(12,4) USING amount::numeric`);
        const cc = await pool.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid WHERE t.relname = 'tasks' AND c.conname = 'tasks_reward_check'`);
        if (cc.rowCount > 0 && (cc.rows[0].def.includes('15') || cc.rows[0].def.includes('50'))) {
            await pool.query(`UPDATE tasks SET reward = 10 WHERE reward > 10`);
            await pool.query(`UPDATE tasks SET reward = 0.25 WHERE reward < 0.25`);
            await pool.query(`ALTER TABLE tasks DROP CONSTRAINT tasks_reward_check`);
            await pool.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_reward_check CHECK (reward >= 0.25 AND reward <= 10)`);
            console.log('✅ Миграция CHECK');
        }
    } catch (e) { console.error('⚠️ Миграция:', e.message); }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS withdraw_requests (
            id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            username VARCHAR(64) NOT NULL, gift VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status);

        CREATE TABLE IF NOT EXISTS submissions (
            id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            screenshot_file_id TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reject_reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

        CREATE TABLE IF NOT EXISTS processed_payments (
            payload TEXT PRIMARY KEY, processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS exchange_requests (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            stars NUMERIC(12,4) NOT NULL,
            gold NUMERIC(12,4) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_exchange_requests_status ON exchange_requests(status);
    `);
    console.log('✅ Доп. таблицы готовы');
}

// ============ ОШИБКИ ============
let pollingErrors = 0;
bot.on('polling_error', (error) => {
    console.error('❌ Polling:', error.message);
    pollingErrors++;
    if (error.message.includes('401')) process.exit(1);
    if (pollingErrors >= 10) process.exit(1);
});
process.on('uncaughtException', (e) => { console.error('❌ Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('❌ Unhandled:', e); process.exit(1); });

// ============ ЗАПУСК ============
async function start() {
    await initDatabase();
    try {
        const me = await bot.getMe();
        BOT_USERNAME = me.username;
        BOT_ID = me.id;
        console.log(`🚀 Бот: @${BOT_USERNAME}`);
    } catch (e) { console.error('❌ getMe:', e.message); process.exit(1); }
    try {
        await bot.sendMessage(ADMIN_ID, `🟢 Бот @${BOT_USERNAME} запущен.`);
    } catch (e) { console.error('❌ Не могу написать админу:', e.message); process.exit(1); }
    console.log('🚀 Tick Bot запущен');
}

start().catch(e => { console.error('❌ start:', e); process.exit(1); });


// ============ ОБМЕН НА ГОЛДУ ============
const EXCHANGE_GOLD_RATE = 1.5;                                    // 1⭐ = 1.5 Голды
const EXCHANGE_MIN_GOLD = 20;                                    // минимум 20 Голды
const EXCHANGE_MIN_STARS = Math.ceil((EXCHANGE_MIN_GOLD / EXCHANGE_GOLD_RATE) * 100) / 100;
const awaitingExchangeAmount = new Map();

async function handleExchangeMenu(chatId, userId) {
    const user = await db.getUser(userId);
    await safeSend(chatId,
        `🔄 <b>Обмен звёзд</b>\n\n` +
        `⭐ Твой баланс: <b>${formatStars(user.balance)}</b>\n\n` +
        `Выбери, на что обменять:`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🟡 Обменять на Голду', callback_data: 'exchange_gold' }],
                ],
            },
        }
    );
}

async function handleExchangeGold(chatId, userId) {
    awaitingExchangeAmount.set(userId, Date.now());
    await safeSend(chatId,
        `🟡 <b>Обмен на Голду в Standoff 2</b>\n\n` +
        `Курс: <b>1⭐ = ${EXCHANGE_GOLD_RATE} Голды</b>\n` +
        `Минимум: <b>${EXCHANGE_MIN_GOLD} Голды</b> (= ${EXCHANGE_MIN_STARS.toFixed(2)}⭐)\n\n` +
        `Введи, сколько звёзд хочешь обменять.\n` +
        `Пример: <code>${EXCHANGE_MIN_STARS}</code>\n\n` +
        `❌ Отмена — /cancel`,
        { parse_mode: 'HTML' }
    );
}

async function handleExchangeAmount(msg, userId, ts) {
    const chatId = msg.chat.id;

    if (Date.now() - ts > 10 * 60 * 1000) {
        awaitingExchangeAmount.delete(userId);
        return safeSend(chatId, '⌛ Время истекло. Попробуй снова.');
    }

    const text = (msg.text || '').trim();
    const stars = parseFloat(text.replace(',', '.'));

    if (Number.isNaN(stars) || stars <= 0) return safeSend(chatId, '❌ Введи положительное число.');
    if (stars < EXCHANGE_MIN_STARS) return safeSend(chatId, `❌ Минимум ${EXCHANGE_MIN_STARS}⭐ (= ${EXCHANGE_MIN_GOLD} Голды).`);

    awaitingExchangeAmount.delete(userId);
    const goldToGet = Math.round(stars * EXCHANGE_GOLD_RATE * 100) / 100;

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); return safeSend(chatId, 'Начните с /start'); }

        if (parseFloat(user.balance) < stars) {
            await client.query('ROLLBACK');
            return safeSend(chatId, `❌ Недостаточно звёзд. У тебя ${formatStars(user.balance)}⭐.`);
        }

        const pending = await client.query(
            `SELECT id FROM exchange_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
            [userId]
        );
        if (pending.rowCount > 0) {
            await client.query('ROLLBACK');
            return safeSend(chatId, `⏳ Уже есть активная заявка #${pending.rows[0].id}.`);
        }

        const deduct = await client.query(
            `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
            [stars, userId]
        );
        if (deduct.rowCount === 0) { await client.query('ROLLBACK'); return safeSend(chatId, '❌ Недостаточно звёзд.'); }

        const ins = await client.query(
            `INSERT INTO exchange_requests (user_id, stars, gold, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
            [userId, stars, goldToGet]
        );
        const reqId = ins.rows[0].id;

        await client.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
            [userId, -stars, 'exchange_hold', `Заявка на обмен #${reqId}`]
        );
        await client.query('COMMIT');

        try {
            await bot.sendMessage(ADMIN_ID,
                `🔄 <b>Заявка на обмен #${reqId}</b>\n\n` +
                `👤 ${escapeHtml(user.first_name || '')} (@${escapeHtml(user.username || 'нет')})\n` +
                `🆔 <code>${userId}</code>\n` +
                `⭐ Списано: ${formatStars(stars)}\n` +
                `🟡 К начислению: ${formatStars(goldToGet)} Голды\n` +
                `💳 Остаток: ${formatStars(deduct.rows[0].balance)}⭐`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Принять', callback_data: `admin_exch_accept_${reqId}` },
                            { text: '❌ Отклонить', callback_data: `admin_exch_reject_${reqId}` },
                        ]],
                    },
                }
            );
        } catch (e) { console.error('notify admin:', e.message); }

        await safeSend(chatId,
            `✅ Заявка #${reqId} создана!\n\n` +
            `⭐ Списано: ${formatStars(stars)}\n` +
            `🟡 Получишь: ${formatStars(goldToGet)} Голды\n` +
            `⏳ Ожидай начисления.`
        );
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('exchange amount:', e);
        await safeSend(chatId, '❌ Ошибка. Попробуй позже.');
    } finally { if (client) client.release(); }
}

async function handleAdminExchAccept(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(
            `UPDATE exchange_requests SET status = 'accepted', processed_at = NOW()
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [reqId]
        );
        if (upd.rowCount === 0) { await client.query('ROLLBACK'); return answer({ text: 'Уже обработана.' }); }
        const req = upd.rows[0];
        await client.query('COMMIT');

        try {
            await bot.sendMessage(req.user_id,
                `🎉 Заявка #${reqId} одобрена!\n\n` +
                `🟡 Начислено: ${formatStars(req.gold)} Голды`
            );
        } catch (e) {}

        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            });
        } catch (e) {}

        await answer({ text: 'Принято!' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('exch accept:', e);
        await answer({ text: 'Ошибка' });
    } finally { if (client) client.release(); }
}

async function handleAdminExchReject(cb, reqId, answer) {
    if (cb.from.id !== ADMIN_ID) return answer({ text: 'Не твоя.' });
    if (!Number.isInteger(reqId) || reqId <= 0) return answer({ text: 'Неверный ID.' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const upd = await client.query(
            `UPDATE exchange_requests SET status = 'rejected', processed_at = NOW()
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [reqId]
        );
        if (upd.rowCount === 0) { await client.query('ROLLBACK'); return answer({ text: 'Уже обработана.' }); }
        const req = upd.rows[0];

        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [req.stars, req.user_id]);
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
            [req.user_id, req.stars, 'exchange_refund', `Возврат #${reqId}`]
        );
        await client.query('COMMIT');

        try {
            await bot.sendMessage(req.user_id,
                `❌ Заявка #${reqId} отклонена.\n⭐ ${formatStars(req.stars)} звёзд возвращены.`
            );
        } catch (e) {}

        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            });
        } catch (e) {}

        await answer({ text: 'Отклонено.' });
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('exch reject:', e);
        await answer({ text: 'Ошибка' });
    } finally { if (client) client.release(); }
}

// Обработчик callback обмена
bot.on('callback_query', async (cb) => {
    const action = cb.data;
    if (!action || typeof action !== 'string') return;
    const userId = cb.from.id;
    const chatId = cb.message?.chat?.id;
    if (!chatId) return;

    if (action === 'exchange_menu') {
        await handleExchangeMenu(chatId, userId);
        try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
    } else if (action === 'exchange_gold') {
        await handleExchangeGold(chatId, userId);
        try { await bot.answerCallbackQuery(cb.id); } catch (e) {}
    } else if (action.startsWith('admin_exch_accept_')) {
        const reqId = parseInt(action.slice(18), 10);
        let answered = false;
        const answer = async (opts = {}) => {
            if (answered) return;
            answered = true;
            try { await bot.answerCallbackQuery(cb.id, opts); } catch (e) {}
        };
        await handleAdminExchAccept(cb, reqId, answer);
    } else if (action.startsWith('admin_exch_reject_')) {
        const reqId = parseInt(action.slice(18), 10);
        let answered = false;
        const answer = async (opts = {}) => {
            if (answered) return;
            answered = true;
            try { await bot.answerCallbackQuery(cb.id, opts); } catch (e) {}
        };
        await handleAdminExchReject(cb, reqId, answer);
    }
});

// Обработчик ввода суммы обмена
bot.on('message', async (msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (msg.chat.type !== 'private') return;

    if (awaitingExchangeAmount.has(userId)) {
        const ts = awaitingExchangeAmount.get(userId);
        const text = (msg.text || '').trim();

        if (text.startsWith('/')) {
            awaitingExchangeAmount.delete(userId);
            if (text === '/cancel') await safeSend(msg.chat.id, '❌ Обмен отменён.');
            return;
        }

        await handleExchangeAmount(msg, userId, ts);
    }
});
