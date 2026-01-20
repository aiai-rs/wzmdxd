require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Security: Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Static Files ---
if (!fs.existsSync('uploads')) { fs.mkdirSync('uploads'); }
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Security: File Upload Filter ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only images are allowed'));
    }
};
const upload = multer({ storage: storage, fileFilter: fileFilter });

// --- Environment Variables ---
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const TRON_WALLET_ADDRESS = process.env.TRON_WALLET_ADDRESS;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456'; // Default, change in prod
let ADMIN_TOKEN_STORE = null; // Simple in-memory token store for demo

if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
const ALLOWED_GROUP_ID = TG_CHAT_ID;

// --- Middleware: Admin Auth ---
const authAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token && token === ADMIN_TOKEN_STORE) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// --- TG Bot Logic ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';
    if (msg.chat.type === 'private') return;
    if (chatId !== ALLOWED_GROUP_ID) {
        bot.sendMessage(chatId, "⚠️ 未授权群组，再见！").then(() => bot.leaveChat(chatId));
        return;
    }
    if (text.startsWith('设置汇率 ')) {
        const rate = parseFloat(text.split(' ')[1]);
        if (!isNaN(rate) && rate > 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('exchange_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [rate.toString()]);
            bot.sendMessage(chatId, `✅ 汇率已更新为: 1 USDT = ${rate} CNY`);
        }
    }
    if (text.startsWith('设置手续费 ')) {
        const fee = parseFloat(text.split(' ')[1]);
        if (!isNaN(fee) && fee >= 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('fee_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [fee.toString()]);
            bot.sendMessage(chatId, `✅ 支付手续费已更新为: ${fee}%`);
        }
    }
    if (text === '/sc') {
        try { await pool.query("DELETE FROM orders"); bot.sendMessage(chatId, "🗑️ 所有订单及物流信息已清除。"); } catch (e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
    if (text === '/qc') {
        try { await pool.query("TRUNCATE products, orders, messages, users RESTART IDENTITY"); bot.sendMessage(chatId, "💥 数据库已完全清空。"); } catch (e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
    if (text === '/bz') {
        bot.sendMessage(chatId, "Set Rate: 汇率\nSet Fee: 手续费\n/sc: 删订单\n/qc: 清库");
    }
});

// --- DB Init ---
async function initDB() {
    try {
        const client = await pool.connect();
        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, contact TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT`);

        await client.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT, price TEXT, stock INTEGER, category TEXT, description TEXT, type TEXT DEFAULT 'virtual', image_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        // Upgrade: Add is_pinned
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_id TEXT UNIQUE, product_name TEXT, contact TEXT, payment_method TEXT, status TEXT DEFAULT '待支付', user_id INTEGER, usdt_amount NUMERIC, cny_amount NUMERIC, snapshot_rate NUMERIC, shipping_info TEXT, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount NUMERIC DEFAULT 0`);

        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, session_id TEXT, sender TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        const checkFee = await client.query("SELECT * FROM settings WHERE key = 'fee_rate'");
        if (checkFee.rowCount === 0) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['fee_rate', '0']);

        console.log("Database Schema Updated");
        client.release();
    } catch (err) { console.error("DB Init Error:", err); }
}
initDB();

// --- USDT Check ---
async function checkUsdtDeposits() {
    if (!TRON_WALLET_ADDRESS) return;
    try {
        const pending = await pool.query("SELECT * FROM orders WHERE status = '待支付' AND payment_method = 'USDT' AND expires_at > NOW()");
        if (pending.rows.length === 0) return;
        const url = `https://api.trongrid.io/v1/accounts/${TRON_WALLET_ADDRESS}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
        const res = await axios.get(url);
        const txs = res.data.data;

        for (const order of pending.rows) {
            const expectedAmount = parseFloat(order.usdt_amount);
            const match = txs.find(tx => {
                const txAmount = parseFloat(tx.value) / 1000000;
                const txTime = tx.block_timestamp;
                const orderTime = new Date(order.created_at).getTime();
                return Math.abs(txAmount - expectedAmount) < 0.000001 && txTime >= orderTime;
            });

            if (match) {
                await pool.query("UPDATE orders SET status = '已支付' WHERE id = $1", [order.id]);
                sendTG(`✅ **USDT 到账成功**\n单号: ${order.order_id}\n金额: ${expectedAmount} USDT\n客户已自动发货`);
            }
        }
    } catch (e) { console.error("USDT Check Error:", e.message); }
}
setInterval(checkUsdtDeposits, 30000);

function sendTG(text) {
    if (bot && TG_CHAT_ID) bot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown' }).catch(e => console.log(e.message));
}

// --- APIs ---

// 1. Admin Auth
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if(username === ADMIN_USER && password === ADMIN_PASS) {
        ADMIN_TOKEN_STORE = 'adm_' + Math.random().toString(36).substr(2) + Date.now();
        res.json({ success: true, token: ADMIN_TOKEN_STORE });
    } else {
        res.json({ success: false, msg: 'Invalid Credentials' });
    }
});

// 2. File Upload (Protected)
app.post('/api/upload', authAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or invalid type' });
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// 3. Public Data (Sort by pinned)
app.get('/api/public/data', async (req, res) => {
    try {
        const p = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
        const c = await pool.query('SELECT DISTINCT category FROM products');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const rate = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const fee = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const popup = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        res.json({
            products: p.rows,
            categories: c.rows.map(r => r.category),
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '[]'),
            rate: parseFloat(rate.rows[0]?.value || '7.0'),
            feeRate: parseFloat(fee.rows[0]?.value || '0'),
            showPopup: popup.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 4. User Auth (Hashed)
app.post('/api/user/login', async (req, res) => {
    const { contact, password } = req.body;
    if(!contact || !password) return res.status(400).json({error: "Need contact and password"});
    
    try {
        let user = await pool.query("SELECT * FROM users WHERE contact = $1", [contact]);
        if (user.rows.length === 0) {
            // Register
            const hash = await bcrypt.hash(password, 10);
            const ins = await pool.query("INSERT INTO users (username, contact, password) VALUES ($1, $1, $2) RETURNING id", [contact, hash]);
            return res.json({ success: true, userId: ins.rows[0].id, isNew: true });
        } else {
            // Login
            const match = await bcrypt.compare(password, user.rows[0].password);
            if (!match) return res.json({ success: false, msg: "密码错误" });
            res.json({ success: true, userId: user.rows[0].id });
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 5. Order Logic
app.post('/api/order', async (req, res) => {
    const { userId, productId, paymentMethod, shippingInfo } = req.body;
    try {
        const prod = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.json({ success: false, msg: '商品不存在' });

        const pData = prod.rows[0];
        const basePrice = parseFloat(pData.price.replace(/[^\d.]/g, ''));
        const orderId = 'ORD-' + Date.now().toString().slice(-6);
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');

        let usdtAmount = basePrice;
        let cnyAmount = basePrice * rate;
        let feeAmount = 0;
        let expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        if (paymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        }

        if (paymentMethod === 'USDT') {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((basePrice + randomDecimal).toFixed(4));
        }

        await pool.query(
            `INSERT INTO orders 
            (order_id, product_name, contact, payment_method, status, user_id, usdt_amount, cny_amount, snapshot_rate, shipping_info, expires_at, fee_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, 
            [orderId, pData.name, 'RegUser', paymentMethod, '待支付', userId, usdtAmount, cnyAmount.toFixed(2), rate, JSON.stringify(shippingInfo || {}), expiresAt, feeAmount.toFixed(2)]
        );

        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';

        let notif = `💰 **新订单**\n单号: \`${orderId}\`\n商品: ${pData.name}\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') notif += `\n需付: \`${usdtAmount}\` USDT`;
        else notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;

        if (pData.type === 'physical') {
            notif += `\n\n📦 **发货信息**\n收件人: ${shippingInfo.name}\n电话: ${shippingInfo.tel}\n地址: ${shippingInfo.addr}`;
        }

        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2), wallet: TRON_WALLET_ADDRESS });
    } catch (e) { console.error(e); res.status(500).json({error: e.message}); }
});

// Cancel Order
app.post('/api/order/cancel', async (req, res) => {
    const { orderId, userId } = req.body;
    try {
        const check = await pool.query("SELECT * FROM orders WHERE order_id = $1 AND user_id = $2", [orderId, userId]);
        if(check.rows.length === 0) return res.json({success:false, msg:'订单不存在'});
        if(check.rows[0].status !== '待支付') return res.json({success:false, msg:'无法取消'});
        
        await pool.query("UPDATE orders SET status = '已取消' WHERE order_id = $1", [orderId]);
        res.json({success: true});
    } catch(e) { res.status(500).json({error:e.message}); }
});

// Admin Operations (Protected)
app.post('/api/admin/order/ship', authAdmin, async (req, res) => {
    const { orderId, trackingNumber } = req.body;
    try {
        await pool.query("UPDATE orders SET tracking_number = $1 WHERE order_id = $2", [trackingNumber, orderId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/hiring', authAdmin, async (req, res) => {
    try { 
        const val = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        await pool.query("INSERT INTO settings (key, value) VALUES ('hiring', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [val]); 
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/confirm_pay', authAdmin, async (req, res) => {
    const { orderId } = req.body;
    try {
        await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/popup', authAdmin, async (req, res) => {
    try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('announcement_popup', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body.open ? 'true':'false']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/announcement', authAdmin, async (req, res) => {
    try { await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [req.body.text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});

// Create Product
app.post('/api/admin/product', authAdmin, async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('INSERT INTO products (name, price, stock, category, description, type, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [name, price, stock, category, desc, type, imageUrl]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Edit Product
app.put('/api/admin/product/:id', authAdmin, async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('UPDATE products SET name=$1, price=$2, stock=$3, category=$4, description=$5, type=$6, image_url=$7 WHERE id=$8', 
            [name, price, stock, category, desc, type, imageUrl, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Delete Product
app.delete('/api/admin/product/:id', authAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Pin Product
app.post('/api/admin/product/pin/:id', authAdmin, async (req, res) => {
    try {
        // Toggle pin
        const curr = await pool.query('SELECT is_pinned FROM products WHERE id=$1', [req.params.id]);
        const newVal = !curr.rows[0].is_pinned;
        await pool.query('UPDATE products SET is_pinned=$1 WHERE id=$2', [newVal, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Chat & Admin Data
app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTG(`💬 **客户消息**\nID: \`${sessionId}\`\n内容: ${text}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.get('/api/chat/history/:sid', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sid]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/reply', authAdmin, async (req, res) => {
    const { sessionId, text } = req.body;
    try { await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'admin', text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.id]);
        res.json(r.rows.length > 0 ? r.rows[0] : { status: '未找到' }); // This line seems unused by frontend poll but kept for compatibility
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Get User Orders
app.get('/api/order', async (req, res) => {
    try {
        if (req.query.userId) {
            // Updated: filter by userId specifically
            const list = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
            return res.json(list.rows);
        }
        res.json([]);
    } catch (e) { res.status(500).json({error: e.message}); }
});

// Admin All Data (Protected)
app.get('/api/admin/all', authAdmin, async (req, res) => {
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const msgs = await pool.query('SELECT * FROM messages ORDER BY created_at ASC');
        // Return products for management list as well
        const products = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
        
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const r = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const f = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const p = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        let chats = {};
        msgs.rows.forEach(m => {
            if(!chats[m.session_id]) chats[m.session_id] = [];
            chats[m.session_id].push(m);
        });

        res.json({
            orders: orders.rows,
            products: products.rows, // Added products
            chats: chats,
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '[]'),
            rate: r.rows[0]?.value || '7.0',
            feeRate: f.rows[0]?.value || '0',
            popup: p.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
