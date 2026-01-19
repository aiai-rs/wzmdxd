require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 环境变量读取 ---
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID; // 这里稍后在Render填你的群ID: -5197011996
const DATABASE_URL = process.env.DATABASE_URL;

// 检查环境变量
if (!DATABASE_URL) {
    console.error("错误: 请在 Render 环境变量中设置 DATABASE_URL");
    process.exit(1);
}

// --- 数据库连接池 ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- TG 机器人 (开启 polling 以便监听事件) ---
// 注意：Render 免费版有时会休眠，Polling 可能会在休眠时断开，但唤醒后会自动重连
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

// >>>>>> 新增：机器人安保逻辑开始 <<<<<<

// 允许的群 ID (从环境变量获取，确保安全)
const ALLOWED_GROUP_ID = TG_CHAT_ID; 

bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;

    // 1. 拒绝私聊 (Private)
    if (chatType === 'private') {
        // 可以选择回复一句 "禁止私聊"，或者直接 return (装死，推荐装死)
        return; 
    }

    // 2. 检查是否在指定群组
    if (chatId !== ALLOWED_GROUP_ID) {
        console.log(`检测到未授权群组: ${chatId}，正在退出...`);
        bot.sendMessage(chatId, "⚠️ 本机器人仅限特定群组使用，再见！")
           .then(() => bot.leaveChat(chatId))
           .catch(err => console.error("退出群组失败:", err));
    }
});

// 监听被拉入新群组的事件
bot.on('my_chat_member', (msg) => {
    const chatId = msg.chat.id.toString();
    const newStatus = msg.new_chat_member.status;

    // 如果机器人被拉进群 (member) 或被提升为管理员 (administrator)
    if (newStatus === 'member' || newStatus === 'administrator') {
        if (chatId !== ALLOWED_GROUP_ID) {
            bot.sendMessage(chatId, "⚠️ 未授权群组，自动退出。")
               .then(() => bot.leaveChat(chatId));
        }
    }
});

// >>>>>> 机器人安保逻辑结束 <<<<<<


// --- 自动初始化数据库表 ---
async function initDB() {
    try {
        const client = await pool.connect();
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name TEXT,
                price TEXT,
                stock INTEGER,
                category TEXT,
                description TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                order_id TEXT UNIQUE,
                product_name TEXT,
                contact TEXT,
                payment_method TEXT,
                status TEXT DEFAULT '待支付',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                session_id TEXT,
                sender TEXT,
                content TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        const check = await client.query("SELECT * FROM settings WHERE key = 'announcement'");
        if (check.rowCount === 0) {
            await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['announcement', '欢迎来到未来商城！本站支持 USDT 自动支付。']);
            const defaultHiring = JSON.stringify({ title: "招聘前端开发", content: "薪资 5000U 起，需熟悉 Vue/React。", contact: "@rrss0" });
            await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['hiring', defaultHiring]);
        }

        console.log("Database Initialized Successfully");
        client.release();
    } catch (err) {
        console.error("DB Init Error:", err);
    }
}
initDB();

// --- 辅助函数 ---
function sendTG(text) {
    if (bot && TG_CHAT_ID) {
        // 发送到指定群组
        bot.sendMessage(TG_CHAT_ID, text).catch(e => console.log("TG Send Error:", e.message));
    }
}

// --- 业务 API (保持不变) ---

app.get('/api/public/data', async (req, res) => {
    try {
        const p = await pool.query('SELECT * FROM products ORDER BY id DESC');
        const c = await pool.query('SELECT DISTINCT category FROM products');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        
        res.json({
            products: p.rows,
            categories: c.rows.map(r => r.category),
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}')
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/order', async (req, res) => {
    const { contact, productId, paymentMethod } = req.body;
    try {
        const prod = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.json({ success: false });

        const pName = prod.rows[0].name;
        const orderId = 'ORD-' + Date.now().toString().slice(-6);

        await pool.query('INSERT INTO orders (order_id, product_name, contact, payment_method) VALUES ($1, $2, $3, $4)', 
            [orderId, pName, contact, paymentMethod]);

        sendTG(`💰 **新订单**\n单号: ${orderId}\n商品: ${pName}\n客户: ${contact}\n支付: ${paymentMethod}`);
        res.json({ success: true, orderId });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.id]);
        res.json(r.rows.length > 0 ? r.rows[0] : { status: '未找到' });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTG(`💬 **客户消息**\nID: ${sessionId}\n内容: ${text}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/chat/history/:sid', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sid]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/admin/all', async (req, res) => {
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const msgs = await pool.query('SELECT * FROM messages ORDER BY created_at ASC');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        
        let chats = {};
        msgs.rows.forEach(m => {
            if(!chats[m.session_id]) chats[m.session_id] = [];
            chats[m.session_id].push(m);
        });

        res.json({
            orders: orders.rows,
            chats: chats,
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}')
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/product', async (req, res) => {
    const { name, price, stock, category, desc } = req.body;
    try {
        await pool.query('INSERT INTO products (name, price, stock, category, description) VALUES ($1, $2, $3, $4, $5)', 
            [name, price, stock, category, desc]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/announcement', async (req, res) => {
    try {
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [req.body.text]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/hiring', async (req, res) => {
    try {
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'hiring'", [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/reply', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'admin', text]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
