require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const axios = require('axios'); // 必须安装: npm install axios

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 环境变量 ---
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const TRON_WALLET_ADDRESS = process.env.TRON_WALLET_ADDRESS; // 新增：你的TRC20收款地址

if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }
if (!TRON_WALLET_ADDRESS) { console.warn("警告: 未设置 TRON_WALLET_ADDRESS，USDT 自动监听将无法工作"); }

// --- 数据库连接 ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- TG Bot ---
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
const ALLOWED_GROUP_ID = TG_CHAT_ID;

// 机器人逻辑：群组安保 + 汇率设置
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';

    // 1. 安保逻辑
    if (msg.chat.type === 'private') return;
    if (chatId !== ALLOWED_GROUP_ID) {
        bot.sendMessage(chatId, "⚠️ 未授权群组，再见！").then(() => bot.leaveChat(chatId));
        return;
    }

    // 2. 汇率设置指令 (格式: 设置汇率 7.2)
    if (text.startsWith('设置汇率 ')) {
        const rate = parseFloat(text.split(' ')[1]);
        if (!isNaN(rate) && rate > 0) {
            try {
                await pool.query("INSERT INTO settings (key, value) VALUES ('exchange_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [rate.toString()]);
                bot.sendMessage(chatId, `✅ 汇率已更新为: 1 USDT = ${rate} CNY`);
            } catch (e) { console.error(e); }
        }
    }
});

// --- 数据库初始化 (自动增量更新) ---
async function initDB() {
    try {
        const client = await pool.connect();

        // 1. 用户表 (新增)
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                contact TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // 2. 产品表 (新增字段)
        await client.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT, price TEXT, stock INTEGER, category TEXT, description TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'virtual'`); // virtual 或 physical
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`);

        // 3. 订单表 (新增字段)
        await client.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_id TEXT UNIQUE, product_name TEXT, contact TEXT, payment_method TEXT, status TEXT DEFAULT '待支付', created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INTEGER`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS usdt_amount NUMERIC`); // 精确的USDT金额(含小数)
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cny_amount NUMERIC`); // 人民币金额
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS snapshot_rate NUMERIC`); // 下单时汇率
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_info TEXT`); // 收货信息 JSON
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`); // 过期时间

        // 4. 其他表
        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, session_id TEXT, sender TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        // 默认设置
        const checkRate = await client.query("SELECT * FROM settings WHERE key = 'exchange_rate'");
        if (checkRate.rowCount === 0) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['exchange_rate', '7.0']);
        
        const checkPop = await client.query("SELECT * FROM settings WHERE key = 'announcement_popup'");
        if (checkPop.rowCount === 0) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['announcement_popup', 'true']);

        console.log("Database Schema Updated Successfully");
        client.release();
    } catch (err) { console.error("DB Init Error:", err); }
}
initDB();

// --- 辅助功能：USDT 监听 (TRC20) ---
async function checkUsdtDeposits() {
    if (!TRON_WALLET_ADDRESS) return;
    try {
        // 查找所有 '待支付' 且是 'USDT' 的订单
        const pending = await pool.query("SELECT * FROM orders WHERE status = '待支付' AND payment_method = 'USDT' AND expires_at > NOW()");
        if (pending.rows.length === 0) return;

        // 调用 TronGrid API (查询最近的 TRC20 交易)
        // 注意：生产环境建议使用自己的 API Key，这里使用公共节点可能偶尔限流
        const url = `https://api.trongrid.io/v1/accounts/${TRON_WALLET_ADDRESS}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
        const res = await axios.get(url);
        const txs = res.data.data;

        for (const order of pending.rows) {
            const expectedAmount = parseFloat(order.usdt_amount);
            
            // 寻找匹配的交易 (金额完全一致，且时间在订单创建之后)
            const match = txs.find(tx => {
                const txAmount = parseFloat(tx.value) / 1000000; // 转换为 USDT
                const txTime = tx.block_timestamp;
                const orderTime = new Date(order.created_at).getTime();
                // 允许 0.000001 的浮点误差，且交易时间必须在订单创建后
                return Math.abs(txAmount - expectedAmount) < 0.000001 && txTime >= orderTime;
            });

            if (match) {
                await pool.query("UPDATE orders SET status = '已支付' WHERE id = $1", [order.id]);
                sendTG(`✅ **USDT 到账成功**\n单号: ${order.order_id}\n金额: ${expectedAmount} USDT`);
                console.log(`Order ${order.order_id} Paid via USDT`);
            }
        }
    } catch (e) {
        console.error("USDT Check Error:", e.message);
    }
}
// 每 30 秒轮询一次
setInterval(checkUsdtDeposits, 30000);

// --- 辅助函数 ---
function sendTG(text) {
    if (bot && TG_CHAT_ID) bot.sendMessage(TG_CHAT_ID, text).catch(e => console.log(e.message));
}

// --- API ---

// 1. 公共数据 (含汇率、弹窗设置)
app.get('/api/public/data', async (req, res) => {
    try {
        const p = await pool.query('SELECT * FROM products ORDER BY id DESC');
        const c = await pool.query('SELECT DISTINCT category FROM products');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const rate = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const popup = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        res.json({
            products: p.rows,
            categories: c.rows.map(r => r.category),
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}'),
            rate: parseFloat(rate.rows[0]?.value || '7.0'),
            showPopup: popup.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 2. 用户注册
app.post('/api/user/register', async (req, res) => {
    const { contact } = req.body; // 简单注册，只存联系方式作为标识
    if(!contact) return res.status(400).json({error: "Need contact"});
    try {
        // 检查是否存在
        let user = await pool.query("SELECT * FROM users WHERE contact = $1", [contact]);
        if (user.rows.length === 0) {
             const ins = await pool.query("INSERT INTO users (username, contact) VALUES ($1, $1) RETURNING id", [contact]);
             return res.json({ success: true, userId: ins.rows[0].id });
        }
        res.json({ success: true, userId: user.rows[0].id });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 3. 下单 (核心修改)
app.post('/api/order', async (req, res) => {
    const { userId, productId, paymentMethod, shippingInfo } = req.body;
    try {
        const prod = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.json({ success: false, msg: '商品不存在' });

        const pData = prod.rows[0];
        const basePrice = parseFloat(pData.price.replace(/[^\d.]/g, ''));
        const orderId = 'ORD-' + Date.now().toString().slice(-6);
        
        // 获取当前汇率
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');

        let usdtAmount = basePrice;
        let cnyAmount = basePrice * rate;
        let finalStatus = '待支付';
        let expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30分钟后过期

        // 如果是 USDT，生成随机小数位以识别唯一性
        if (paymentMethod === 'USDT') {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000; // 0.1000 - 0.9999
            usdtAmount = parseFloat((basePrice + randomDecimal).toFixed(4));
        }

        // 插入订单
        await pool.query(
            `INSERT INTO orders 
            (order_id, product_name, contact, payment_method, status, user_id, usdt_amount, cny_amount, snapshot_rate, shipping_info, expires_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, 
            [orderId, pData.name, 'RegUser', paymentMethod, finalStatus, userId, usdtAmount, cnyAmount.toFixed(2), rate, JSON.stringify(shippingInfo || {}), expiresAt]
        );

        // 获取用户信息用于通知
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';

        let notif = `💰 **新订单**\n单号: ${orderId}\n商品: ${pData.name}\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') notif += `\n需付: ${usdtAmount} USDT`;
        else notif += `\n需付: ¥${cnyAmount.toFixed(2)}`;

        if (pData.type === 'physical') {
            notif += `\n📦 **实物发货**: ${JSON.stringify(shippingInfo)}`;
        }

        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2), wallet: TRON_WALLET_ADDRESS });
    } catch (e) { console.error(e); res.status(500).json({error: e.message}); }
});

// 4. 查询订单
app.get('/api/order/:id', async (req, res) => {
    try {
        // 支持通过 user_id 查询列表，或者 order_id 查询单个
        if (req.query.userId) {
            const list = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
            return res.json(list.rows);
        }
        const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.id]);
        res.json(r.rows.length > 0 ? r.rows[0] : { status: '未找到' });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 5. 管理员确认收款 (微信/支付宝)
app.post('/api/admin/confirm_pay', async (req, res) => {
    const { orderId } = req.body;
    try {
        await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 6. 管理员: 开关弹窗
app.post('/api/admin/update/popup', async (req, res) => {
    try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('announcement_popup', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body.open ? 'true':'false']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 7. 管理员: 商品上架 (支持图片、类型)
app.post('/api/admin/product', async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('INSERT INTO products (name, price, stock, category, description, type, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [name, price, stock, category, desc, type, imageUrl]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// --- 其他原有接口保持不变 (Chat, etc.) ---
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
        const r = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const p = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        let chats = {};
        msgs.rows.forEach(m => {
            if(!chats[m.session_id]) chats[m.session_id] = [];
            chats[m.session_id].push(m);
        });

        res.json({
            orders: orders.rows,
            chats: chats,
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}'),
            rate: r.rows[0]?.value || '7.0',
            popup: p.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/update/announcement', async (req, res) => {
    try { await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [req.body.text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/update/hiring', async (req, res) => {
    try { await pool.query("UPDATE settings SET value = $1 WHERE key = 'hiring'", [JSON.stringify(req.body)]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/reply', async (req, res) => {
    const { sessionId, text } = req.body;
    try { await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'admin', text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
