const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const TronWeb = require('tronweb');
const energyProvider = require('./energy-provider');

const app = express();
const PORT = process.env.PORT || 3000;

// 部署在反向代理（如 Railway）之后，需要信任代理传来的 X-Forwarded-For，
// 否则 req.ip 拿到的只会是代理自己的内网地址，而不是用户的真实 IP
app.set('trust proxy', true);

// ========== 新增：进程级兜底，防止单个接口里的一个 bug（比如某个 catch 块自己又抛错）
// 直接干掉整个 Node 进程 ==========
// Node 15+ 默认策略是"未处理的 Promise rejection 直接终止进程"，而这是一个跑真实资金业务的
// 服务，一次未捕获的异步错误就把整个进程干掉（所有用户的登录、绑卡、提现全部中断，
// 还会触发 Railway 反复重启/产生备份），代价太大。这里只做日志记录，不再让进程退出。
// 注意：这只是兜底，不代表可以不修 bug——出现这些日志说明确实有地方漏了 try/catch 或写错了，
// 应该按日志定位并修复，而不是依赖这个兜底一直"带病运行"。
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [未处理的 Promise 异常] 请尽快定位修复:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🔥 [未捕获的同步异常] 请尽快定位修复:', err);
});
// ========== 新增结束 ==========

// 获取客户端真实 IP（优先取 X-Forwarded-For 的第一个地址）
function getClientIp(req) {
  // ========== 部署链路：用户 → Cloudflare(小黄云) → Railway → 本服务 ==========
  // 经过 Cloudflare 代理后，X-Forwarded-For 里的地址在多层代理下不完全可靠
  // （可能被 Railway 的边缘代理重写成"上一跳"，也就是 Cloudflare 节点自己的 IP）。
  // Cloudflare 只要是代理模式（小黄云），一定会自带 CF-Connecting-IP，
  // 这个值是 Cloudflare 在自己网络边缘就记录下来的真实访客 IP，最可靠，优先使用。
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) {
    return cfIp.trim();
  }
  // True-Client-IP 是 Cloudflare 企业版 / 部分场景下使用的头，兜底也识别一下
  const trueClientIp = req.headers['true-client-ip'];
  if (trueClientIp) {
    return trueClientIp.trim();
  }
  // 都没有的情况（比如没走Cloudflare，直接访问Railway域名）再退回 X-Forwarded-For
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return xff.split(',')[0].trim();
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || '';
}

app.use(express.json({ limit: '10mb' })); // 提高限额以支持客服聊天图片（base64）等较大请求体
app.use(express.static('public'));
app.use(session({
  secret: 'tron-demo-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ========== SSE 通知推送 ==========
const sseClients = {};

// 推送通知给指定用户
function pushNotification(userId, title, message, type = 'deposit') {
  if (sseClients[userId] && sseClients[userId].length > 0) {
    const amount = message.match(/[\d.]+/)?.[0] || '0';
    const data = JSON.stringify({ title, message, type, amount });
    sseClients[userId].forEach(client => {
      client.write(`data: ${data}\n\n`);
    });
  }
}

// ========== Resend 邮件服务配置 ==========
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'PokePay <service@pokepay.vip>';

// ============= 数据库初始化 =============
const DB_PATH = process.env.DATABASE_PATH || '/data/tron_demo.db';
const db = new sqlite3.Database(DB_PATH);
console.log(`📁 数据库路径: ${DB_PATH}`);

db.serialize(() => {
  // 用户表（使用 uid 作为主键）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    payment_password_hash TEXT,
    invite_code TEXT UNIQUE,
    reward_balance REAL DEFAULT 0,
    invited_by TEXT,
    hkd_balance REAL DEFAULT 0,
    vusdt_balance REAL DEFAULT 0,
    kyc_status TEXT DEFAULT 'pending',
    kyc_requested_at DATETIME,
    pokepay_card_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    address TEXT,
    private_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    from_address TEXT,
    to_address TEXT,
    amount REAL,
    token_type TEXT,
    tx_id TEXT,
    fee REAL,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS reward_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    amount REAL,
    type TEXT,
    related_user_id TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'`, (err) => {
      if (err && !err.message.includes('duplicate column name')) {
          console.log('添加 role 字段失败:', err.message);
      }
  });
  
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS bank_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    card_number TEXT NOT NULL,
    card_holder TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS exchange_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    usdt_amount REAL NOT NULL,
    hkd_amount REAL NOT NULL,
    rate REAL NOT NULL,
    tx_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS withdraw_fiat_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    bank_card_id INTEGER,
    status TEXT DEFAULT 'pending',
    remark TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(uid),
    FOREIGN KEY(bank_card_id) REFERENCES bank_cards(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS collect_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT DEFAULT 'pending',
    total_users INTEGER DEFAULT 0,
    processed_users INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    total_usdt REAL DEFAULT 0,
    total_trx REAL DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS collect_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    user_id TEXT,
    status TEXT,
    token_type TEXT,
    amount REAL,
    error_msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(task_id) REFERENCES collect_tasks(id),
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS vusdt_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    balance REAL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS card_withdraw_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    card_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    remark TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(uid)
  )`);
  
  db.get(`SELECT COUNT(*) as count FROM vusdt_pool`, [], (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO vusdt_pool (balance) VALUES (100000000000)`);
      console.log('✅ vUSDT 系统池已初始化: 1000亿 vUSDT');
    }
  });
  
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('collect_address', '')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('collect_threshold', '10')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_rate', '7.8')`);
  db.run(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('support_quick_replies', ?)`,
    [JSON.stringify([
      { label: '欢迎语', message: '您好，欢迎联系客服，请问有什么可以帮您？' },
      { label: 'KYC处理中', message: '您的KYC认证正在审核中，一般1-3个工作日完成，请耐心等待，我们会尽快为您处理。' },
      { label: '绑卡说明', message: '绑卡需要您先完成KYC认证，认证通过后系统会自动为您绑定卡片，如遇到问题请提供您的注册邮箱，我们协助核实处理。' },
      { label: '结束语', message: '感谢您的耐心等待，如还有其他问题欢迎随时联系我们，祝您生活愉快！' },
      { label: '快捷回复5', message: '' },
      { label: '快捷回复6', message: '' },
      { label: '快捷回复7', message: '' }
    ])]
  );

  db.run(`ALTER TABLE users ADD COLUMN wallet_frozen INTEGER DEFAULT 0`, (err) => {
      if (err && !err.message.includes('duplicate column name')) {
          console.log('添加 wallet_frozen 字段失败:', err.message);
      }
  });

// ========== 邮箱验证码表 ==========
db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  is_used INTEGER DEFAULT 0,
  attempt_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ========== 添加 type 字段（兼容旧表） ==========
db.run(`ALTER TABLE email_verifications ADD COLUMN type TEXT DEFAULT 'register'`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    console.log('添加 type 字段失败:', err.message);
  }
});

// ========== 用户通知表 ==========
db.run(`CREATE TABLE IF NOT EXISTS user_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'deposit',
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

    // ========== 手续费配置表 ==========
  db.run(`CREATE TABLE IF NOT EXISTS user_fee_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    fixed_fee REAL DEFAULT 20,
    fee_percentage REAL DEFAULT 20,
    updated_by TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid)
  )`);
  
  // ========== 异常订单表 ==========
  db.run(`CREATE TABLE IF NOT EXISTS abnormal_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    order_type TEXT NOT NULL,
    usdt_amount REAL,
    trx_fee REAL,
    to_address TEXT,
    txid TEXT,
    error_msg TEXT,
    retry_count INTEGER DEFAULT 0,
    energy_purchased INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    resolved_at DATETIME,
    resolved_by TEXT,
    FOREIGN KEY (user_id) REFERENCES users(uid)
  )`);
  
  console.log('✅ 手续费配置表和异常订单表已创建');
  
  // 添加新字段（兼容性处理）
  const addColumn = (table, column, type) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        console.log(`添加字段 ${table}.${column} 失败:`, err.message);
      }
    });
  };
  
  addColumn('users', 'payment_password_hash', 'TEXT');
  addColumn('users', 'hkd_balance', 'REAL DEFAULT 0');
  addColumn('users', 'vusdt_balance', 'REAL DEFAULT 0');
  addColumn('users', 'kyc_status', "TEXT DEFAULT 'pending'");
  addColumn('users', 'kyc_requested_at', 'DATETIME');
  addColumn('users', 'pokepay_card_id', 'INTEGER');
  addColumn('users', 'card_display_name', "TEXT DEFAULT NULL");
  addColumn('users', 'pending_card_last4', 'TEXT');
  addColumn('users', 'card_bind_status', 'TEXT'); // locked / active / needs_review
  addColumn('users', 'pending_card_id', 'INTEGER'); // 撞号时通过完整卡号消歧义后确认的具体卡片id，不存卡号本身
  addColumn('users', 'register_ip', 'TEXT');   // 注册时的IP
  addColumn('users', 'last_login_ip', 'TEXT'); // 最近一次登录的IP
  // ========== 新增：存量用户绑卡提醒 —— 是否已经发送过提醒（每人只发一次） ==========
  addColumn('users', 'legacy_bind_reminder_sent', 'INTEGER DEFAULT 0');

  // ========== 新增：didit 直连会话缓存（防止重复调用官方接口导致重复计费）==========
  addColumn('users', 'kyc_session_id', 'TEXT');
  addColumn('users', 'kyc_session_url', 'TEXT');
  addColumn('users', 'kyc_session_created_at', 'DATETIME');

  // ========== 新增：用户真实英文姓名（原本提交给 PokePay didit/init 用；改为直连 Didit 后，
  // 这两个字段改为"可选的预填/兜底"——优先用 Didit 证件 OCR 识别出的姓名，这两个字段
  // 只在 OCR 没识别出姓名时兜底使用，不再是发起认证前的硬性前置条件）==========
  addColumn('users', 'kyc_first_name', 'TEXT');
  addColumn('users', 'kyc_last_name', 'TEXT');

  // ========== 新增：直连 Didit 改造 —— 记录 PokePay 侧真正的 KYC ID ==========
  // 现在 KYC 认证结果直接来自 Didit（见 DiditService + /api/webhooks/didit），
  // 不再依赖同步 PokePay 后台"已通过KYC"名单来找 kyc_id。Didit 认证通过后，
  // 我们用"新增KYC（自主）"接口把 Didit 的核验结果提交给 PokePay 换一个 kyc_id 存在这里，
  // 后续随机绑卡、以及任何需要 kyc_id 的地方都直接读这个字段，不用再按邮箱去 PokePay 反查。
  addColumn('users', 'pokepay_kyc_id', 'INTEGER');
  // Didit 会话状态缓存，避免重复创建/方便客服排查（Approved/Declined/In Review/...）
  addColumn('users', 'didit_session_status', 'TEXT');
  // 绑卡异常兜底：随机绑卡失败（比如库存暂时不足、这个KYC已经5张卡打满）时记录原因，方便客服排查
  addColumn('users', 'card_bind_note', 'TEXT');

  // ========== 新增：用户自助注销账户 —— 软删除标记，保留流水记录用于合规追溯 ==========
  addColumn('users', 'account_status', "TEXT DEFAULT 'active'"); // active / deleted
  addColumn('users', 'deleted_at', 'DATETIME');

  // ========== 新增：防止"抢绑" —— 同一张 PokePay card_id 不能被两个不同账号同时处于
  // locked（已提交完整卡号、锁定等待绑定）状态。此前只检查了 PokePay 侧 kyc_id 是否为0，
  // 完全没检查"本地是否已经有别的用户也在走这张卡的绑定流程"，导致有人可以在真正持卡人
  // 还没走完 KYC 的窗口期里，靠猜后4位抢先把卡绑到自己名下。
  // 用局部唯一索引在数据库层面兜底（防止并发请求绕过应用层检查），只约束 locked 状态——
  // active 状态已经在 PokePay 侧真正完成绑定，那边的 kyc_id!==0 检查足够防止二次绑定。
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_locked_card_unique
    ON users(pending_card_id)
    WHERE pending_card_id IS NOT NULL AND card_bind_status = 'locked'`, (err) => {
    if (err) console.log('创建 pending_card_id 唯一索引失败:', err.message);
    else console.log('✅ pending_card_id 防抢绑唯一索引已就绪');
  });
});

// ============= 辅助函数 =============
// 生成唯一邀请码（6位数字，确保不重复）
async function generateInviteCode() {
  let code;
  let exists = true;
  let retryCount = 0;
  const maxRetries = 10;
  
  while (exists && retryCount < maxRetries) {
    // 生成 100000 - 999999 之间的随机数
    code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // 检查是否已存在
    const existing = await new Promise((resolve) => {
      db.get(`SELECT invite_code FROM users WHERE invite_code = ?`, [code], (err, row) => {
        resolve(row);
      });
    });
    
    exists = !!existing;
    retryCount++;
  }
  
  if (exists) {
    // 极端情况：10次重试都重复，使用时间戳作为后备
    code = Date.now().toString().slice(-6);
  }
  
  return code;
}
// ========== 邮箱验证函数 ==========
function isValidEmail(email) {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// 生成10位随机数字ID
async function generateUniqueUid() {
  const min = 1000000000;
  const max = 9999999999;
  
  let uid = null;
  let isUnique = false;
  
  while (!isUnique) {
    uid = Math.floor(min + Math.random() * (max - min + 1)).toString();
    
    const existing = await new Promise((resolve) => {
      db.get(`SELECT uid FROM users WHERE uid = ?`, [uid], (err, row) => resolve(row));
    });
    
    if (!existing) {
      isUnique = true;
    }
  }
  
  return uid;
}

function getBeijingTime(utcTime) {
  const date = new Date(utcTime);
  date.setHours(date.getHours() + 8);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function getCollectAddress() {
  return new Promise((resolve) => {
    db.get(`SELECT value FROM settings WHERE key = 'collect_address'`, [], (err, row) => {
      if (err || !row || !row.value) resolve(null);
      else resolve(row.value);
    });
  });
}

// ========== 新增：汇率短期缓存，避免每次刷新首页都打一次 CoinGecko（它免费额度限流更严格） ==========
let usdtHkdRateCache = { rate: null, fetchedAt: 0 };
const USDT_HKD_RATE_CACHE_TTL = 60 * 1000; // 60秒，汇率没必要秒级更新

async function getUSDTtoHKD(useCache = true) {
  const now = Date.now();
  if (useCache && usdtHkdRateCache.rate && (now - usdtHkdRateCache.fetchedAt) < USDT_HKD_RATE_CACHE_TTL) {
    return usdtHkdRateCache.rate;
  }
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=hkd');
    const data = await response.json();
    if (data && data.tether && data.tether.hkd) {
      usdtHkdRateCache = { rate: data.tether.hkd, fetchedAt: now };
      return data.tether.hkd;
    }
  } catch (error) {
    console.log('获取实时汇率失败:', error.message);
  }
  const backupRate = await new Promise((resolve) => {
    db.get(`SELECT value FROM settings WHERE key = 'backup_rate'`, [], (err, row) => {
      resolve(row ? parseFloat(row.value) : 7.8);
    });
  });
  // CoinGecko 请求失败时也顺手缓存一下兜底汇率，避免短时间内接口一直报错就一直重复请求
  usdtHkdRateCache = { rate: backupRate, fetchedAt: now };
  return backupRate;
}
// ========== 新增结束 ==========

async function checkTronZapBalance() {
  try {
    const balance = await energyProvider.getBalance();
    const minBalance = 5;
    return { sufficient: balance >= minBalance, balance };
  } catch (error) {
    console.error('检查 TronZap 余额失败:', error.message);
    return { sufficient: false, balance: 0, error: error.message };
  }
}

async function ensureFirstAdmin() {
    // 管理员账号
    const admin = await new Promise((resolve) => {
        db.get(`SELECT id FROM admins WHERE username = ?`, ['admin'], (err, row) => resolve(row));
    });
    if (!admin) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        db.run(`INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'admin')`, 
            ['admin', hashedPassword]);
        console.log('========================================');
        console.log('  🔐 默认管理员账号已创建');
        console.log('  用户名: admin');
        console.log('  密码: admin123');
        console.log('========================================');
    }
    
    // 客服账号
    const support = await new Promise((resolve) => {
        db.get(`SELECT id FROM admins WHERE username = ?`, ['kefu'], (err, row) => resolve(row));
    });
    if (!support) {
        const hashedPassword = await bcrypt.hash('kefu123', 10);
        db.run(`INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'support')`, 
            ['kefu', hashedPassword]);
        console.log('========================================');
        console.log('  🔐 客服账号已创建');
        console.log('  用户名: kefu');
        console.log('  密码: kefu123');
        console.log('========================================');
    }
}
ensureFirstAdmin();

// ============= 手续费配置函数 =============

// 获取用户手续费配置
async function getUserFeeConfig(userId) {
  return new Promise((resolve) => {
    db.get(`SELECT fixed_fee FROM user_fee_config WHERE user_id = ?`, [userId], (err, row) => {
      if (err || !row) {
        resolve({ fixedFee: 8 });  // 默认 8 TRX
      } else {
        resolve({ fixedFee: row.fixed_fee });
      }
    });
  });
}

// 计算提币手续费
function calculateWithdrawFee(amount, fee) {
  // 直接使用配置的手续费，不需要计算
  const requiredTrx = fee + 1;  // 预留 1 TRX 用于归集费用
  return { fee, requiredTrx };
}

// 记录异常订单
async function recordAbnormalOrder(userId, orderType, usdtAmount, trxFee, toAddress, errorMsg, energyPurchased = 0) {
  return new Promise((resolve) => {
    db.run(`INSERT INTO abnormal_orders (user_id, order_type, usdt_amount, trx_fee, to_address, error_msg, energy_purchased, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, orderType, usdtAmount, trxFee, toAddress, errorMsg, energyPurchased],
      function(err) {
        if (err) console.error('记录异常订单失败:', err);
        resolve(this?.lastID);
      });
  });
}

// 记录提币成功日志（支持 USDT 和 TRX）
async function recordWithdrawLog(userId, amount, fee, toAddress, txid, status, tokenType = 'USDT') {
  return new Promise((resolve) => {
    db.run(`INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status, fee)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'system', toAddress, amount, tokenType, txid, status, fee],
      () => resolve());
  });
}

// 归集 TRX 手续费
async function collectTrxFee(userPrivateKey, feeAmount, platformAddress) {
  const tronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: userPrivateKey });
  const trxAmountSun = Math.floor(feeAmount * 1e6);
  const tx = await tronWeb.trx.sendTransaction(platformAddress, trxAmountSun);
  return tx;
}

// 带重试的 USDT 转账（不重新购买能量）
async function transferUsdtWithRetry(userPrivateKey, toAddress, amount, maxRetries = 3) {
  const userTronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: userPrivateKey });
  const contract = await userTronWeb.contract().at(USDT_CONTRACT);
  const usdtAmountNum = Math.floor(amount * 1000000);
  
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`USDT 转账尝试 ${attempt}/${maxRetries}...`);
      const tx = await contract.transfer(toAddress, usdtAmountNum).send();
      console.log(`USDT 转账成功，TxID: ${tx}`);
      return { success: true, txid: tx, attempt };
    } catch (error) {
      lastError = error;
      console.log(`USDT 转账尝试 ${attempt} 失败: ${error.message}`);
      if (attempt < maxRetries) {
        console.log(`等待 5 秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  
  return { success: false, error: lastError.message, attempt: maxRetries };
}

// 检查能量是否有效（订单创建时间 < 59 分钟）
function isEnergyValid(orderCreatedAt) {
  const orderTime = new Date(orderCreatedAt).getTime();
  const now = Date.now();
  const fiftyNineMinutes = 59 * 60 * 1000;
  return (now - orderTime) < fiftyNineMinutes;
}

// ============= 网络配置 =============
const NETWORK = process.env.TRON_NETWORK || 'mainnet';
const FULL_HOST = NETWORK === 'mainnet' 
    ? 'https://api.trongrid.io' 
    : 'https://api.shasta.trongrid.io';

// TRC20 USDT 合约地址
const USDT_CONTRACT = NETWORK === 'mainnet'
    ? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    : 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';

// 创建 TronWeb 实例
const tronWeb = new TronWeb({ fullHost: FULL_HOST });

// API Key 配置
const TRON_API_KEY = process.env.TRON_API_KEY || '';

// ========== 新增：链上余额（TRX + USDT）短期缓存 ==========
// /api/assets 和 /api/total-assets 原来是各自独立向 TronGrid 请求一遍 TRX 余额 + USDT 余额，
// 等于同一个钱包地址的余额，一次首页刷新就打了2遍 TronGrid（4个请求）。
// 之前为了防止429，干脆把首页数据改成只在App启动时拉一次——但这样又导致用户切回首页看到的是旧数据。
// 更好的做法是在服务端加一层短期缓存：同一个钱包地址在 CHAIN_BALANCE_CACHE_TTL 时间内的重复查询，
// 直接返回缓存结果，不再打 TronGrid；这样前端可以放心地每次都刷新，
// 而 TronGrid 的实际请求量被摊薄到"每个钱包地址每 20 秒最多查1次"，从根上避免 429，
// 同时用户感知到的数据仍然是接近实时的（最多滞后 20 秒）。
const CHAIN_BALANCE_CACHE_TTL = 20 * 1000; // 20秒
const chainBalanceCache = new Map(); // address -> { trx, usdt, fetchedAt, inFlight(Promise) }

async function getCachedChainBalance(address) {
  const now = Date.now();
  const cached = chainBalanceCache.get(address);
  if (cached && cached.fetchedAt && (now - cached.fetchedAt) < CHAIN_BALANCE_CACHE_TTL) {
    return { trx: cached.trx, usdt: cached.usdt };
  }
  // 同一个地址短时间内可能被 /api/assets 和 /api/total-assets 并发查询（比如首页一次性 Promise.all 触发），
  // 用 inFlight 把并发请求合并成一次真正的网络调用，避免"缓存刚好没命中"时又打两次 TronGrid
  if (cached && cached.inFlight) {
    return cached.inFlight;
  }

  const fetchPromise = (async () => {
    let trxAmount = 0;
    let chainUsdt = 0;
    try {
      const trxBalance = await tronWeb.trx.getBalance(address);
      trxAmount = trxBalance / 1e6;
    } catch (e) {
      console.warn(`⚠️ 查询链上 TRX 余额失败 (${address}):`, e.message);
    }
    try {
      const url = `${FULL_HOST}/v1/accounts/${address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
      const response = await fetch(url, {
        headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
      });
      const data = await response.json();
      if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
        chainUsdt = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
      }
    } catch (e) {
      console.warn(`⚠️ 查询链上 USDT 余额失败 (${address}):`, e.message);
    }
    const result = { trx: trxAmount, usdt: chainUsdt };
    chainBalanceCache.set(address, { ...result, fetchedAt: Date.now(), inFlight: null });
    return result;
  })();

  chainBalanceCache.set(address, { ...(cached || {}), inFlight: fetchPromise });
  return fetchPromise;
}
// ========== 新增结束 ==========

// 能量租赁配置
const USE_ENERGY_RENTAL = (NETWORK === 'mainnet');

console.log(`\n========================================`);
console.log(`  🌐 当前网络: ${NETWORK === 'mainnet' ? '主网' : 'Shasta 测试网'}`);
console.log(`  🔗 API 地址: ${FULL_HOST}`);
console.log(`  🔑 API Key: ${TRON_API_KEY ? '已配置' : '未配置'}`);
console.log(`  ⚡ 能量租赁: ${USE_ENERGY_RENTAL ? '启用' : '禁用'}`);
console.log(`========================================\n`);

// ============= KYC 服务 =============
class KYCService {
  constructor() {
    this.token = null;
    this.tokenExpireTime = 0;
  }

  getCredentials() {
    const email = process.env.POKEPAY_ADMIN_EMAIL;
    const password = process.env.POKEPAY_ADMIN_PASSWORD;
    if (!email || !password) {
      throw new Error('请在环境变量中设置 POKEPAY_ADMIN_EMAIL 和 POKEPAY_ADMIN_PASSWORD');
    }
    return { email, password };
  }

  async fetchToken() {
    const { email, password } = this.getCredentials();
    
    const requestBody = JSON.stringify({
      account: email,
      login_type: "email",
      password: password,
      area_code: 852
    });

    console.log('正在登录 PokePay 获取 Token...');
    
    const response = await fetch('https://dash.pokepay.com/web/auth/login', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://dash.pokepay.com',
        'referer': 'https://dash.pokepay.com/',
        'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
        'x-platform': 'web',
      },
      body: requestBody
    });

    if (!response.ok) {
      throw new Error(`PokePay 登录失败 (${response.status})`);
    }

    const result = await response.json();
    
    if (result.code === 200 && result.data && result.data.token) {
      this.token = result.data.token;
      try {
        const tokenPayload = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64').toString());
        this.tokenExpireTime = tokenPayload.exp * 1000;
        console.log(`✅ Token 获取成功，有效期至: ${new Date(this.tokenExpireTime).toLocaleString()}`);
      } catch (e) {
        console.warn('无法解析 token 过期时间，使用默认 2 小时');
        this.tokenExpireTime = Date.now() + 2 * 60 * 60 * 1000;
      }
      return this.token;
    } else {
      throw new Error(`登录接口返回异常: ${JSON.stringify(result)}`);
    }
  }

  async getValidToken() {
    if (this.token && this.tokenExpireTime > Date.now() + 5 * 60 * 1000) {
      return this.token;
    }
    console.log('Token 已过期或即将过期，正在重新获取...');
    return await this.fetchToken();
  }

  async requestWithAuth(url, options = {}) {
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getValidToken();
        const response = await fetch(url, {
          ...options,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json, text/plain, */*',
            ...options.headers
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        
        if (result.code === 401 || (result.errstr && result.errstr.includes('Insufficient authority'))) {
          console.warn(`权限不足，尝试刷新 Token...`);
          this.tokenExpireTime = 0;
          if (attempt === maxRetries) {
            throw new Error('权限不足，请检查管理员账号');
          }
          continue;
        }
        
        return result;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        console.warn(`请求失败，重试中 (${attempt + 1}/${maxRetries + 1}):`, error.message);
      }
    }
  }

  async getKYCLink() {
    const result = await this.requestWithAuth('https://dash.pokepay.com/web/kyc/token/qr', {
      method: 'GET'
    });
    
    if (result.code === 200 && result.data && result.data.link) {
      return {
        success: true,
        kycLink: result.data.link,
        expiration: result.data.expiration
      };
    }
    throw new Error(result.errstr || '获取 KYC 链接失败');
  }

  // ========== 新增：官方推荐的 didit 直连方式 ==========
  // 相比旧的 web/kyc/token/qr（用户要在第三方页面自己填邮箱+验证码，容易填错，
  // 而且每点一次拉起第三方SDK都计费），这个接口直接把用户资料传给 PokePay，
  // 拿到的链接打开就是已经绑定好邮箱身份的认证页，用户不需要再手动填邮箱。
  //
  // 已实测确认：现有 admin 账号登录拿到的 Bearer Token 可以直接调用
  // https://dash.pokepay.com/api/v1/kyc/didit/init（正式环境API域名与后台域名相同），
  // 不需要额外开通 AppID/AppSecret。
  //
  // 注意：
  // 1) email 字段必须是用户的注册邮箱——KYC状态同步（findVerifiedKYCRecordByEmail /
  //    syncSingleUserKYC）和自动绑卡都是按这个邮箱去 PokePay 的 KYC 名单里匹配的。
  // 2) first_en_name / last_en_name 【必须是调用方传入的真实姓名】，不能再用邮箱前缀猜测：
  //    - PokePay 对这两个字段做格式校验（必须像姓名，纯数字/乱码会报 "first_en_name or
  //      last_en_name invalid"），部分用户邮箱前缀是纯数字/特殊字符，猜测必然失败；
  //    - 而且这两个字段会直接成为 KYC 记录、进而成为卡片持卡人姓名（member_name）里显示的
  //      姓名，didit 的证件核验并不会覆盖/纠正这里预填的姓名——猜错了持卡人姓名也会显示错。
  //    因此调用前必须已经从 user.kyc_first_name / user.kyc_last_name 拿到真实姓名，
  //    拿不到就直接抛错，交给上层路由先引导用户填写，而不是在这里瞎猜生造一个。
  async getDiditSession(user) {
    if (!user.kyc_first_name || !user.kyc_last_name) {
      throw new Error('缺少用户真实姓名，无法生成 KYC 会话');
    }

    const url = 'https://dash.pokepay.com/api/v1/kyc/didit/init';

    const body = {
      agent_uid: user.uid,          // 用我们自己的 uid 做唯一标识，方便对账排查
      email: user.email,            // 关键字段，务必是用户注册邮箱
      first_en_name: user.kyc_first_name,
      last_en_name: user.kyc_last_name,
      phone: '00000000',
      area_code: '852',
      address: 'N/A',
      city: 'Hong Kong',
      state: 'Hong Kong',
      post_code: '000000',
      bill_country_code: 'HK',
      return_url: '',
    };

    const result = await this.requestWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (result.code === 200 && result.data && result.data.url) {
      return {
        success: true,
        sessionId: result.data.session_id,
        kycLink: result.data.url,
      };
    }
    throw new Error(result.errstr || '获取 KYC 认证链接失败（didit）');
  }

  async getCardDetail(cardId) {
    const result = await this.requestWithAuth(`https://dash.pokepay.com/web/card/${cardId}`, {
      method: 'GET'
    });
    
    if (result.code !== 200) {
      throw new Error(result.errstr || '获取卡片详情失败');
    }

    return {
      success: true,
      cardNo: result.data.card_no,
      balance: parseFloat(result.data.balance).toFixed(2),
      currency: result.data.currency_code,
      memberName: result.data.member_name,
      kycId: result.data.kyc_id, // ========== 新增：用于判断这张卡当前是否仍未绑定（0=未绑定）==========
      publicToken: result.data.public_token, // ========== 新增：设置/查询卡片PIN需要用这个token ==========
    };
  }

  // ========== 新增：直接设置卡片取款密码（PIN），不再依赖 PokePay 邮件重置链接 ==========
  // 用现有 admin Bearer Token 即可调用，同一套鉴权体系，不需要 AppID/AppSecret。
  async setCardPin(publicToken, pin) {
    const result = await this.requestWithAuth(`https://dash.pokepay.com/api/v1/card/${publicToken}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (result.code !== 200) {
      throw new Error(result.errstr || '设置取款密码失败');
    }
    return true;
  }

  // 查询PIN是否被锁定（Blocked），用于设置前给出更友好的提示
  async getCardPinStatus(publicToken) {
    const result = await this.requestWithAuth(`https://dash.pokepay.com/api/v1/card/${publicToken}/pin/status`, {
      method: 'GET',
    });
    if (result.code !== 200) {
      throw new Error(result.errstr || '查询PIN状态失败');
    }
    return {
      status: result.data.status, // Unblocked / Blocked
      remainingTries: result.data.remainingTries,
    };
  }

async getCardTransactions(cardId, limit = 20) {
    // 北京时间转换函数（充值/退值接口返回的是 UTC 秒级时间戳）
    const toBeijingTime = (timestamp) => {
        const date = new Date(timestamp * 1000);
        date.setHours(date.getHours() + 8);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    // 交易类型判断（充值 / 退值）
    const getTransactionType = (type, tradeType) => {
        if (type === 2 && tradeType === 3) return '充值';
        if (type === 1 && tradeType === 4) return '退值';
        return '其他';
    };

    // ========== 新增：并行请求 充值/退值记录 与 消费/提现记录 ==========
    const rechargeUrl = `https://dash.pokepay.com/web/card/trade?card_id=${cardId}&limit=${limit}&page=1&trade_types=1,2,3,4`;
    const consumeUrl = `https://dash.pokepay.com/web/card/trade/consume?card_id=${cardId}&limit=${limit}&page=1`;

    const [rechargeResult, consumeResult] = await Promise.all([
        this.requestWithAuth(rechargeUrl, { method: 'GET' }),
        this.requestWithAuth(consumeUrl, { method: 'GET' }).catch(error => {
            // 消费/提现记录接口异常时不影响充值记录的正常展示
            console.warn('获取卡片消费/提现记录失败:', error.message);
            return { code: 200, data: { list: [] } };
        })
    ]);

    if (rechargeResult.code !== 200) {
        throw new Error(rechargeResult.errstr || '获取交易记录失败');
    }

    // 充值 / 退值记录
    const rechargeTransactions = (rechargeResult.data.list || []).map(tx => ({
        id: tx.id,
        amount: tx.amount.toFixed(2),
        fee: tx.fee.toFixed(2),
        balance: tx.balance.toFixed(2),
        currency: tx.currency_code,
        type: getTransactionType(tx.type, tx.trade_type),
        time: toBeijingTime(tx.created_time),
        _sortTime: tx.created_time * 1000,
    }));

    // ========== 新增：消费/提现记录（trade/consume 接口）==========
    // trade_total = 本笔交易对卡片余额的实际影响（已包含 trade_fee/extra_fee/bank_fee 等所有手续费，负数）
    // trade_time 该接口已直接返回“YYYY-MM-DD HH:mm:ss”格式的北京时间字符串，无需再做时区换算
    const consumeList = (consumeResult && consumeResult.code === 200 && consumeResult.data && consumeResult.data.list) || [];
    const consumeTransactions = consumeList.map(tx => {
        const totalAmount = parseFloat(tx.trade_total ?? tx.amount ?? 0);
        const feeAmount = parseFloat(tx.trade_fee || 0) + parseFloat(tx.extra_fee || 0) + parseFloat(tx.bank_fee || 0);
        return {
            id: tx.id,
            amount: totalAmount.toFixed(2),
            fee: feeAmount.toFixed(2),
            balance: tx.clear_amount ? parseFloat(tx.clear_amount).toFixed(2) : '',
            currency: tx.currency_code,
            type: '支出', // 消费/支出/提现类交易，前端统一按支出（红色）展示
            time: tx.trade_time,
            _sortTime: new Date(`${tx.trade_time.replace(' ', 'T')}+08:00`).getTime(),
        };
    });

    // 合并两类记录，按时间倒序排列，并截取到请求的条数
    const transactions = [...rechargeTransactions, ...consumeTransactions]
        .sort((a, b) => b._sortTime - a._sortTime)
        .slice(0, limit)
        .map(({ _sortTime, ...rest }) => rest);

    return { success: true, transactions };
}

  // 比对：dash.pokepay.com 返回的 card_no 是打码的（如 "441353******0140"，中间用 * 代替）。
  // 因此不能用 returnedCardNo !== fullCardNumber 做全等比较（打码串永远不等于明文串，会导致
  // 正确的完整卡号也被拦截）。这里只核对"未被打码的位"是否与用户提交的完整卡号一致，
  // 星号位置直接跳过，同时要求长度一致，避免用短卡号/长卡号绕过。
  cardNoMatchesMasked(fullCardNumber, maskedCardNo) {
    if (!fullCardNumber || !maskedCardNo) return false;
    if (fullCardNumber.length !== maskedCardNo.length) return false;
    for (let i = 0; i < maskedCardNo.length; i++) {
      const maskedChar = maskedCardNo[i];
      if (maskedChar === '*') continue; // 打码位，无法核对，跳过
      if (maskedChar !== fullCardNumber[i]) return false; // 明文位必须逐位相同
    }
    return true;
  }

  // 按卡号查询卡片（last4或完整卡号都可以传，status不传=查所有状态，避免frozen卡被漏掉）
  async searchCardByNumber(cardNo) {
    const url = `https://dash.pokepay.com/web/card?limit=10&page=1&name=&card_no=${cardNo}&status=`;
    const result = await this.requestWithAuth(url, { method: 'GET' });

    if (result.code !== 200) {
      throw new Error(result.errstr || '查询卡片失败');
    }
    return result.data.list;
  }

  // 把卡片绑定到指定的KYC记录（旧接口，走 dash 内部代理，card_id + kyc_id）
  async bindCardToMember(cardId, kycId) {
    const url = `https://dash.pokepay.com/web/card/bind`;
    const result = await this.requestWithAuth(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: cardId, kyc_id: kycId })
    });

    if (result.code !== 200) {
      throw new Error(result.errstr || '绑定卡片失败');
    }
    return result;
  }

  // ========== 新增：直连 Didit 改造 —— 官方文档接口，用 public_token + kyc_id ==========
  // PUT /api/v1/card/bind，随机绑卡流程统一用这个（官方文档明确的接口，而不是上面
  // 那个内部 dash 代理），拿到的候选卡本身就带 public_token，不需要额外转换。
  async bindCardOfficial(publicToken, kycId) {
    if (!publicToken) throw new Error('缺少 publicToken');
    if (!kycId) throw new Error('缺少 kycId');
    const url = `https://dash.pokepay.com/api/v1/card/bind`;
    const result = await this.requestWithAuth(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: publicToken, kyc_id: Number(kycId) })
    });
    if (result.code !== 200) {
      throw new Error(result.errstr || '绑定失败');
    }
    return result.data;
  }

  // ---------- 已开卡列表（官方 GET /api/v1/card，随机绑卡用）----------
  // with_kyc: 1=空白卡未绑定 2=已绑定用卡人；随机绑卡只关心未绑定的空白卡（with_kyc=1）
  async getCardListV1({ page = 1, limit = 20, withKyc = '' } = {}) {
    const params = new URLSearchParams({ page, limit });
    if (withKyc !== '' && withKyc !== undefined && withKyc !== null) params.set('with_kyc', withKyc);
    const url = `https://dash.pokepay.com/api/v1/card?${params.toString()}`;
    const result = await this.requestWithAuth(url, { method: 'GET' });
    if (result.code !== 200) {
      throw new Error(result.errstr || '获取卡片列表失败');
    }
    return { total: result.data.total || 0, list: result.data.list || [] };
  }

  // ---------- 新增KYC（自主），POST /api/v1/kyc ----------
  // 用 Didit 直连认证通过后拿到的证件信息 + 图片直传给 PokePay，换一个 PokePay 侧的 kyc_id，
  // 不再依赖用户在 PokePay 自己的 Didit 代理页面走一遍认证。
  // ⚠️ 官方文档原话："限定客户，如果需开通请联系 Pokepay 商务"——也就是说这个接口默认不一定开通，
  // 上线前务必先跟 PokePay 商务确认代理商账号已经开通"自主KYC"权限，否则这里会一直报错。
  async createSelfKyc(payload) {
    const url = `https://dash.pokepay.com/api/v1/kyc`;
    const result = await this.requestWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (result.code !== 200) {
      throw new Error(result.errstr || '创建KYC失败');
    }
    return result.data; // model.Kyc：包含 id / status 等
  }

  // ---------- 单个KYC详情，GET /api/v1/kyc/{kycId} ----------
  // 随机绑卡前用来读最新的 hold_card_num，核对"每个KYC最多绑定5张卡"这条限制
  async getKycDetailV1(kycId) {
    const url = `https://dash.pokepay.com/api/v1/kyc/${kycId}`;
    const result = await this.requestWithAuth(url, { method: 'GET' });
    if (result.code !== 200) {
      throw new Error(result.errstr || '获取KYC详情失败');
    }
    return result.data;
  }

  // ---------- 按邮箱查KYC（官方 GET /api/v1/kyc?email=，精确匹配）----------
  // createSelfKyc 失败提示"邮箱已存在"时的兜底：说明这个人之前已经建过 KYC 记录了
  // （比如 webhook 重复投递、或者早年间已经在 PokePay 那边有记录），直接查出已有的 kyc_id 复用，
  // 而不是把这次当成失败处理。
  async findKycByEmailV1(email) {
    const params = new URLSearchParams({ page: 1, limit: 20, email: (email || '').trim() });
    const url = `https://dash.pokepay.com/api/v1/kyc?${params.toString()}`;
    const result = await this.requestWithAuth(url, { method: 'GET' });
    if (result.code !== 200) {
      throw new Error(result.errstr || '查询KYC记录失败');
    }
    const list = result.data.list || [];
    return list.find(item => (item.email || '').toLowerCase() === (email || '').toLowerCase().trim()) || null;
  }

  // ---------- 获取所有已通过 KYC 的用卡人列表（status=2），用于随机绑卡 ==========
  // 返回所有 status=2（审核通过）且 hold_card_num < 5 的用卡人
  async getVerifiedKYCListWithAvailableSlots() {
    const pageSize = 100;
    let page = 1;
    let totalPages = 1;
    const availableKYCs = [];

    while (page <= totalPages) {
      const url = `https://dash.pokepay.com/api/v1/kyc?limit=${pageSize}&page=${page}&status=2`;
      const result = await this.requestWithAuth(url, { method: 'GET' });
      if (result.code !== 200) {
        throw new Error(result.errstr || '查询 KYC 列表失败');
      }

      if (page === 1) {
        totalPages = Math.ceil((result.data.total || 0) / pageSize);
      }

      // 筛选出持卡数少于 5 张的用卡人
      const list = result.data.list || [];
      for (const item of list) {
        const holdCardNum = item.hold_card_num || 0;
        if (holdCardNum < 5) {
          availableKYCs.push({
            kycId: item.id,
            email: (item.email || '').toLowerCase(),
            firstNameEn: item.first_name_en,
            lastNameEn: item.last_name_en,
            holdCardNum: holdCardNum
          });
        }
      }

      page++;
      if (page <= totalPages) {
        await new Promise(r => setTimeout(r, 100)); // 请求间隔
      }
    }

    return availableKYCs;
  }

}



const kycService = new KYCService();
const cardService = kycService;

// ============= Didit 直连服务 =============
// 改造说明：以前 KYC 认证是通过 PokePay 代理的 Didit 页面（KYCService.getDiditSession，
// 调用 https://dash.pokepay.com/api/v1/kyc/didit/init），认证结果也是靠定时/实时轮询
// PokePay 后台"已通过KYC"名单（syncKYCStatus / findVerifiedKYCRecordByEmail）反推出来的。
//
// 现在直接对接 Didit 自己的 Sessions API（https://verification.didit.me/v3/session/），
// 认证结果通过 Didit 官方 webhook 实时推送到 /api/webhooks/didit，不再经过 PokePay、
// 也不再靠轮询。Didit 认证通过后，再用 PokePay"新增KYC（自主）"接口（POST /api/v1/kyc）
// 把 Didit 核验出的证件信息+图片提交给 PokePay，换一个 PokePay 侧的 kyc_id 用于绑卡——
// PokePay 的卡片系统本身仍然只认它自己的 kyc_id，这一步免不了。
class DiditService {
  constructor() {
    this.apiKey = process.env.DIDIT_API_KEY;
    this.workflowId = process.env.DIDIT_WORKFLOW_ID;
    this.webhookSecret = process.env.DIDIT_WEBHOOK_SECRET;
  }

  getConfig() {
    if (!this.apiKey || !this.workflowId) {
      throw new Error('请在环境变量中设置 DIDIT_API_KEY 和 DIDIT_WORKFLOW_ID');
    }
    return { apiKey: this.apiKey, workflowId: this.workflowId };
  }

  // ---------- 创建认证会话（POST /v3/session/）----------
  // vendor_data 用本地 uid：webhook 回调时就是靠这个字段把 Didit 的结果和本地用户对上号，
  // 必须保证每次都传同一个用户自己的 uid，不能省略。
  // contact_details.email 预填注册邮箱，减少用户在 Didit 页面里再手动填一遍、填错的概率，
  // 不强制——Didit 允许用户在认证流程里修改。
  async createSession(user, callbackUrl) {
    const { apiKey, workflowId } = this.getConfig();
    const body = {
      workflow_id: workflowId,
      vendor_data: user.uid,
      callback: callbackUrl,
      callback_method: 'both', // 有的浏览器环境回调只在发起认证的那台设备触发不了，both 更保险
      contact_details: {
        email: user.email,
        send_notification_emails: false,
      },
    };

    const response = await fetch('https://verification.didit.me/v3/session/', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || !result.url) {
      const detail = result && (result.detail || JSON.stringify(result));
      throw new Error(detail || `Didit 创建认证会话失败 (HTTP ${response.status})`);
    }

    return { sessionId: result.session_id, kycLink: result.url, status: result.status };
  }

  // ---------- 轮询兜底：查询会话最终判定结果（GET /v3/session/{id}/decision/）----------
  // 正常流程完全靠 webhook 实时推送（见 /api/webhooks/didit），这个方法只用于两种兜底场景：
  // 1）冷启动/重新部署期间可能错过的 webhook；2）人工客服核实用户认证结果时的按需查询。
  // 不要用它做常规轮询——官方明确建议 webhook 优先，轮询更慢、更耗配额。
  async getSessionDecision(sessionId) {
    const { apiKey } = this.getConfig();
    const response = await fetch(`https://verification.didit.me/v3/session/${sessionId}/decision/`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((result && result.detail) || `查询 Didit 认证结果失败 (HTTP ${response.status})`);
    }
    return result;
  }

  // ---------- Webhook 签名验证（X-Signature-V2）----------
  // 官方推荐用这个变体而不是对原始字节签名的 X-Signature：因为 express.json() 已经把
  // request body 解析成了 JS 对象（原始字节已经不在了），X-Signature-V2 的算法刚好是
  // "对解析后的对象递归按 key 排序 + 不转义 Unicode 的 JSON.stringify 再算 HMAC"，
  // 不依赖原始字节，正好匹配这里的中间件情况。
  verifyWebhookSignatureV2(parsedBody, signatureHeader, timestampHeader) {
    if (!this.webhookSecret || !signatureHeader || !timestampHeader) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestampHeader, 10)) > 300) return false; // 超过5分钟视为重放，拒绝

    // 官方签名前会把"整数值的浮点数"规整成整数（如 100.0 -> 100），Node 这边要复现同样的规整，
    // 否则涉及浮点字段的 payload（比如某些分数字段）会验签失败
    const shortenFloats = (data) => {
      if (Array.isArray(data)) return data.map(shortenFloats);
      if (data !== null && typeof data === 'object') {
        return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, shortenFloats(v)]));
      }
      if (typeof data === 'number' && !Number.isInteger(data) && data % 1 === 0) return Math.trunc(data);
      return data;
    };
    const sortKeys = (obj) => {
      if (Array.isArray(obj)) return obj.map(sortKeys);
      if (obj !== null && typeof obj === 'object') {
        return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
      }
      return obj;
    };

    const canonical = JSON.stringify(sortKeys(shortenFloats(parsedBody)));
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(canonical, 'utf8').digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

const diditService = new DiditService();

// ========== 新增：Didit 证件类型 -> PokePay id_type 映射 ==========
// PokePay"新增KYC（自主）"接口的 id_type 枚举只有 1身份证/7驾驶执照/12护照 三种，
// Didit document_type 是 "Identity Card" / "Driver's License" / "Passport" / "Residence Permit" 等，
// 没有对应枚举的类型（比如居留证）目前无法自动提交，转人工处理。
const DIDIT_DOCTYPE_TO_POKEPAY_IDTYPE = {
  'Identity Card': 1,
  "Driver's License": 7,
  'Passport': 12,
};

// PokePay"新增KYC（自主）"要求账单地址字段有最小长度（address>=5, city>=2），
// Didit 的 ID Verification 本身不一定采集到账单地址（除非流程里额外配置了地址证明步骤），
// 这里跟改造前 getDiditSession() 里用的兜底值保持一致，用固定占位账单信息，不影响持卡/消费。
const DEFAULT_BILLING_INFO = {
  address: 'Hong Kong',
  city: 'Hong Kong',
  state: 'Hong Kong',
  post_code: '000000',
  bill_country_code: 'HK',
  area_code: '852',
  phone: '00000000',
};

// ========== 新增：Didit 认证通过后的完整处理 —— 建 PokePay KYC 记录 + 随机绑卡 ==========
// 入口是 /api/webhooks/didit 收到 status="Approved" 的时候调用。
async function handleDiditApproved(webhookBody) {
  const uid = webhookBody.vendor_data;
  if (!uid) {
    console.error('⚠️ [Didit] Approved webhook 缺少 vendor_data，无法定位用户，忽略');
    return;
  }

  const user = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE uid = ?`, [uid], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!user) {
    console.error(`⚠️ [Didit] webhook 里的 vendor_data=${uid} 在本地找不到对应用户，忽略`);
    return;
  }

  // 幂等：同一个 Approved 事件可能因为 Didit 重试、或者我们自己轮询兜底而重复触发，
  // 已经拿到 pokepay_kyc_id 就说明这一步已经处理过，不用再提交一次（提交接口 email/id_number 都要求唯一，重复提交会报错）
  let pokepayKycId = user.pokepay_kyc_id;

  if (!pokepayKycId) {
    const decision = webhookBody.decision || {};
    const idv = (decision.id_verifications && decision.id_verifications[0]) || null;
    if (!idv) {
      console.error(`⚠️ [Didit] 用户 ${user.email} 的 Approved 结果里没有 id_verifications，无法建 PokePay KYC 记录，转人工处理`);
      await markCardBindNeedsReview(uid, '认证通过但缺少证件识别结果，无法自动建档，请人工核实');
      return;
    }

    const idType = DIDIT_DOCTYPE_TO_POKEPAY_IDTYPE[idv.document_type];
    if (!idType) {
      console.error(`⚠️ [Didit] 用户 ${user.email} 的证件类型(${idv.document_type})暂不支持自动建档，转人工处理`);
      await markCardBindNeedsReview(uid, `证件类型(${idv.document_type})暂不支持自动建档，请人工核实`);
      return;
    }
    if (!idv.document_number || !idv.date_of_birth) {
      console.error(`⚠️ [Didit] 用户 ${user.email} 的证件识别缺少必填字段(证件号/出生日期)，转人工处理`);
      await markCardBindNeedsReview(uid, '证件识别缺少证件号或出生日期，请人工核实');
      return;
    }

    // 姓名优先用 Didit OCR 识别出的真实证件姓名（更权威），识别不到才兜底用用户之前自己填的
    const firstName = (idv.first_name || user.kyc_first_name || '').trim().toUpperCase();
    const lastName = (idv.last_name || user.kyc_last_name || '').trim().toUpperCase();
    if (!firstName || !lastName) {
      console.error(`⚠️ [Didit] 用户 ${user.email} 无法确定英文姓名(OCR未识别且未预填)，转人工处理`);
      await markCardBindNeedsReview(uid, 'OCR未能识别姓名且用户未预填，请人工核实');
      return;
    }

    const payload = {
      client_uid: user.uid,
      email: user.email,
      first_en_name: firstName,
      last_en_name: lastName,
      birth_date: idv.date_of_birth,
      id_type: idType,
      id_number: idv.document_number,
      id_front: idv.front_image,   // Didit 签名URL，1小时内有效，足够 PokePay 侧实时读取
      id_back: idv.back_image || idv.front_image, // 部分证件（如护照）没有反面，用正面兜底避免必填校验不通过
      selfie: idv.portrait_image,
      ...DEFAULT_BILLING_INFO,
    };

    let kycRecord;
    try {
      kycRecord = await kycService.createSelfKyc(payload);
    } catch (err) {
      // 邮箱/证件号已存在 -> 说明这个人之前已经建过档（比如 webhook 重复投递），按邮箱找回已有记录，
      // 而不是当成失败处理
      const msg = err.message || '';
      if (/email|邮箱|id_number|证件号|重复|duplicate|exist/i.test(msg)) {
        console.warn(`⚠️ [Didit] 提交建档报重复(${msg})，尝试按邮箱找回已有KYC记录: ${user.email}`);
        try {
          kycRecord = await kycService.findKycByEmailV1(user.email);
        } catch (e2) {
          console.error(`按邮箱找回KYC记录也失败: ${e2.message}`);
        }
      }
      if (!kycRecord) {
        console.error(`❌ [Didit] 用户 ${user.email} 提交"新增KYC（自主）"失败: ${msg}`);
        await markCardBindNeedsReview(uid, `提交PokePay建档失败：${msg}`);
        return;
      }
    }

    pokepayKycId = kycRecord.id;
    await new Promise((resolve, reject) => {
      db.run(`UPDATE users SET pokepay_kyc_id = ?, kyc_status = 'verified' WHERE uid = ?`,
        [pokepayKycId, uid], (err) => (err ? reject(err) : resolve()));
    });
    console.log(`✅ [Didit] 用户 ${user.email} 已在 PokePay 建档成功，kyc_id=${pokepayKycId}`);
  }

  // ========== 绑卡逻辑：此时用户一定已经输入了卡号（pending_card_id 已设置）==========
  // 前端流程：用户点击 KYC → 输入完整卡号（调用 lock-card 设置 pending_card_id）→ 跳转 KYC 认证
  // 所以当 webhook 触发 Approved 时，pending_card_id 一定存在，直接执行自动绑卡
  await assignRandomCardToUser(uid, user.email, pokepayKycId);
}

// 把绑卡状态标成"需要人工处理"，并记录原因，方便客服在后台按这个字段筛出来处理
function markCardBindNeedsReview(uid, note) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE users SET card_bind_status = 'needs_review', card_bind_note = ? WHERE uid = ?`,
      [note, uid], (err) => (err ? reject(err) : resolve()));
  });
}

// ========== 新增：KYC通过后，从"已开卡、未绑定"的卡池里随机挑一张绑定给这个用户 ==========
// 严格遵守官方"每个KYC最多绑定5张卡"的限制：绑定前先读一次这个KYC最新的 hold_card_num，
// 达到5张就不再绑，转人工处理（正常情况下刚建档的新KYC是0张，这个检查主要是防重复处理/极端并发）。
async function assignRandomCardToUser(uid, userEmail, kycId) {
  // 幂等：已经绑定成功过，不再重复处理
  const current = await new Promise((resolve, reject) => {
    db.get(`SELECT card_bind_status, pokepay_card_id FROM users WHERE uid = ?`, [uid], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (current && current.card_bind_status === 'active' && current.pokepay_card_id) {
    return;
  }

  // ========== 核心修改：从 PokePay 后台所有已实名通过且持卡数<5 的用卡人中随机选择一个 ==========
  // 注意：这里的 kycId 是刚创建的本用户的 KYC，但我们要绑定到的是后台其他已有的、有空的用卡人
  let availableKYCs;
  try {
    availableKYCs = await kycService.getVerifiedKYCListWithAvailableSlots();
  } catch (err) {
    console.error(`查询可用 KYC 列表失败：${err.message}`);
    await markCardBindNeedsReview(uid, `查询可用 KYC 列表失败：${err.message}`);
    return;
  }

  if (!availableKYCs || availableKYCs.length === 0) {
    console.error(`⚠️ [绑卡] 没有可用的 KYC 用卡人（所有用卡人均已满 5 张卡或查询失败）`);
    await markCardBindNeedsReview(uid, '当前没有可用的 KYC 用卡人（均已满 5 张卡），请人工核实');
    return;
  }

  // 从可用用卡人中随机选择一个
  const randomIndex = Math.floor(Math.random() * availableKYCs.length);
  const selectedKYC = availableKYCs[randomIndex];
  const targetKycId = selectedKYC.kycId;
  
  console.log(`🎲 [随机选择用卡人] 从 ${availableKYCs.length} 个可用用卡人中随机选择了 kycId=${targetKycId}, 当前持卡数=${selectedKYC.holdCardNum}`);

  // 从数据库读取用户锁定的卡片 ID（pending_card_id）- 这是用户在前端输入的完整卡号对应的卡片
  const lockedCard = await new Promise((resolve, reject) => {
    db.get(`SELECT pending_card_id FROM users WHERE uid = ?`, [uid], (err, row) => (err ? reject(err) : resolve(row)));
  });
  
  if (!lockedCard || !lockedCard.pending_card_id) {
    console.error(`⚠️ [绑卡失败] 用户 ${userEmail} 没有锁定的卡片记录，无法自动绑卡`);
    await markCardBindNeedsReview(uid, '未找到用户锁定的卡片记录，请人工核实并手动绑定');
    return;
  }

  const cardId = lockedCard.pending_card_id;
  
  // 查询卡片详情获取 public_token
  let cardDetail;
  try {
    const cardRes = await kycService.getCardDetail(cardId);
    cardDetail = cardRes;
  } catch (err) {
    console.error(`查询卡片 (card_id=${cardId}) 详情失败：${err.message}`);
    await markCardBindNeedsReview(uid, `查询卡片详情失败：${err.message}`);
    return;
  }

  if (!cardDetail || !cardDetail.publicToken) {
    console.error(`⚠️ [绑卡失败] 卡片 card_id=${cardId} 没有有效的 public_token`);
    await markCardBindNeedsReview(uid, '卡片信息异常，缺少 public_token，请人工核实');
    return;
  }

  // 再次确认卡片未被绑定（防止在 KYC 审核期间被其他人/系统绑定）
  if (cardDetail.kycId !== 0) {
    console.warn(`⚠️ [绑卡失败] 卡片 card_id=${cardId} 已被绑定 (kyc_id=${cardDetail.kycId})，无法再次绑定`);
    await markCardBindNeedsReview(uid, '卡片已被绑定，请人工核实并重新选择卡片');
    return;
  }

  // 调用官方绑卡接口，将用户锁定的这张卡绑定到随机选中的用卡人
  try {
    await kycService.bindCardOfficial(cardDetail.publicToken, targetKycId);
    console.log(`✅ [绑卡成功] 用户 ${userEmail} 的卡片 card_id=${cardId} (public_token=${cardDetail.publicToken}) 已绑定到用卡人 kyc_id=${targetKycId}`);
  } catch (err) {
    console.error(`绑定卡片 (card_id=${cardId}) 到用卡人 (kyc_id=${targetKycId}) 失败：${err.message}`);
    await markCardBindNeedsReview(uid, `绑卡失败：${err.message}`);
    return;
  }

  // 更新本地用户状态为已绑定，清空 pending_card_id
  // 注意：pokepay_card_id 仍然记录用户输入的这张卡的 ID，用于后续查询
  await new Promise((resolve, reject) => {
    db.run(`UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active', pending_card_id = NULL, card_bind_note = NULL WHERE uid = ?`,
      [cardId, uid], (err) => (err ? reject(err) : resolve()));
  });
  
  await sendBindSuccessMessage(uid, userEmail);
  console.log(`✅ [绑卡完成] 用户 ${userEmail} 的卡片 card_id=${cardId} 已成功绑定到用卡人 kyc_id=${targetKycId}`);
}

// ========== KYC 同步配置 ==========
const KYC_SYNC_CONFIG = {
  pageSize: 1000,          // 从 200 改为 1000
  requestInterval: 500,    // 从 300 改为 500（预留安全间隔）
};

// ========== KYC 状态同步 ==========
// 同步锁
let isSyncing = false;
let lastSyncTime = null;

// ========== 获取所有已通过 KYC 的记录（保留完整字段，用于邮箱匹配） ==========
async function getAllVerifiedKYCRecords() {
  const pageSize = KYC_SYNC_CONFIG.pageSize;
  let page = 1;
  let totalPages = 1;
  const allRecords = [];
  let totalRecords = 0;

  while (page <= totalPages) {
    const url = `https://dash.pokepay.com/web/kyc?limit=${pageSize}&page=${page}&status=2`;
    const result = await kycService.requestWithAuth(url, { method: 'GET' });

    if (result.code !== 200) {
      console.error(`API 请求失败: ${result.errstr}`);
      break;
    }

    if (page === 1) {
      totalPages = Math.ceil(result.data.total / pageSize);
      totalRecords = result.data.total;
    }

    allRecords.push(...result.data.list.map(item => ({
      kycId: item.id,
      email: (item.email || '').toLowerCase(),
      firstNameEn: item.first_name_en,
      lastNameEn: item.last_name_en,
    })));

    page++;

    if (page <= totalPages) {
      await new Promise(r => setTimeout(r, KYC_SYNC_CONFIG.requestInterval));
    }
  }

  return { records: allRecords, total: totalRecords, count: allRecords.length };
}

// ========== 按邮箱查找单条"已通过KYC"的记录（用于客服手动绑卡，找到即提前停止翻页） ==========
// ========== 姓名核对：作为卡号打码后无法做到"全卡号精确匹配"的补充信号 ==========
// dash 接口对完整卡号只能核对未打码的位（一般是前6+后4），同一 BIN 下后4位撞车的概率不低，
// 光靠数字位无法保证绑定到的一定是用户本人的那张卡。
// 这里用一个跟卡号完全独立的维度做交叉验证：卡片的持卡人姓名（member_name，创建卡片时
// 由代理/后台预先填写）是否与用户在 PokePay KYC 记录里登记的姓名一致。
// 两者都通过后才认为"这确实是这个人的卡"，而不是仅仅"数字对上了"。
function namesRoughlyMatch(kycFirstName, kycLastName, cardMemberName) {
  const normalize = (s) => (s || '')
    .toString()
    .toUpperCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // 去掉重音符号
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();

  const kycTokens = normalize(`${kycFirstName || ''} ${kycLastName || ''}`);
  const cardTokens = normalize(cardMemberName);

  if (kycTokens.length === 0 || cardTokens.length === 0) {
    // 任一方没有可比对的姓名信息（比如卡片member_name为空），无法核对，交给人工判断
    return null;
  }

  // token 集合完全一致（允许姓/名顺序不同）才算匹配
  return kycTokens.length === cardTokens.length &&
    kycTokens.every((t, i) => t === cardTokens[i]);
}

// ========== 防抢绑：检查某张 PokePay card_id 是否已经被"别的账号"占用 ==========
// 占用包括：别的账号正 locked 状态锁定这张卡（等待自己KYC通过后绑定）、
// 或者已经 needs_review 标记为跟这张卡有关的疑似冲突、或者本地已记录 pokepay_card_id 等于这张卡（已绑定）。
// 任何一种情况，都说明这张卡的"归属权"在本地层面已经有主，不能让另一个账号越过去抢先绑定。
function findConflictingCardClaim(cardId, excludeUid) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT uid, email, card_bind_status FROM users
       WHERE uid != ?
         AND (pending_card_id = ? OR pokepay_card_id = ?)
         AND card_bind_status IN ('locked', 'active', 'needs_review')
       LIMIT 1`,
      [excludeUid, cardId, cardId],
      (err, row) => err ? reject(err) : resolve(row || null)
    );
  });
}

async function findVerifiedKYCRecordByEmail(email) {
  const targetEmail = (email || '').toLowerCase().trim();
  if (!targetEmail) return null;

  const pageSize = KYC_SYNC_CONFIG.pageSize;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `https://dash.pokepay.com/web/kyc?limit=${pageSize}&page=${page}&status=2`;
    const result = await kycService.requestWithAuth(url, { method: 'GET' });

    if (result.code !== 200) {
      throw new Error(result.errstr || '查询 KYC 记录失败');
    }

    if (page === 1) {
      totalPages = Math.ceil(result.data.total / pageSize);
    }

    const hit = (result.data.list || []).find(item => (item.email || '').toLowerCase() === targetEmail);
    if (hit) {
      return {
        kycId: hit.id,
        email: (hit.email || '').toLowerCase(),
        firstNameEn: hit.first_name_en,
        lastNameEn: hit.last_name_en
      };
    }

    page++;
    if (page <= totalPages) {
      await new Promise(r => setTimeout(r, KYC_SYNC_CONFIG.requestInterval));
    }
  }

  return null;
}

// ========== 尝试自动绑定：单个用户 ==========
async function tryAutoBindCard(localUser, kycRecord, source = 'batch') {
  // source: 'realtime'（用户打开App/切回前台时的实时检查触发） 或 'batch'（15分钟定时批量任务触发）
  const sourceTag = source === 'realtime' ? '[实时]' : '[批量]';
  try {
    // ========== 如果之前撞号、已经用完整卡号消歧义确认过具体是哪张卡，直接用这张卡绑定，不用再按后四位搜索 ==========
    if (localUser.pending_card_id) {
      let card;
      try {
        card = await kycService.getCardDetail(localUser.pending_card_id);
      } catch (err) {
        await markNeedsReviewAndNotify(localUser.uid, localUser.email,
          `⚠️ ${sourceTag} 用户 ${localUser.email} 已消歧义的卡片(id=${localUser.pending_card_id})查询失败，转人工审核: ${err.message}`);
        return;
      }

      if (card.kycId !== 0) {
        // ========== 新增：多系统共用同一个 PokePay 账号/KYC 库场景 ==========
        // 不一定是"被别的渠道绑走"，也可能是本人（同一 kyc_id）已经在其他系统绑过这张卡了。
        if (card.kycId === kycRecord.kycId) {
          await new Promise((resolve) => {
            db.run(
              `UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
              [localUser.pending_card_id, localUser.uid],
              () => resolve()
            );
          });
          await sendBindSuccessMessage(localUser.uid, localUser.email);
          console.log(`✅ ${sourceTag} [跨系统关联] ${localUser.email} 已在其他系统绑定此卡，本地直接关联 card_id=${localUser.pending_card_id}`);
          return;
        }
        // 真的被别的渠道绑给了别人，转人工
        await markNeedsReviewAndNotify(localUser.uid, localUser.email,
          `⚠️ ${sourceTag} 用户 ${localUser.email} 已消歧义的卡片(id=${localUser.pending_card_id})已被绑定，转人工审核`);
        return;
        // ========== 新增结束 ==========
      }

      // ========== 防抢绑核心检查：真正调用 bindCardToMember 之前，最后确认一次这张卡
      // 本地没有被"别的账号"占用。理论上这张卡是本人 lock-card 时就已经锁定的（受
      // idx_users_locked_card_unique 唯一索引保护），这里是防御性兜底，成本很低。==========
      let conflict;
      try {
        conflict = await findConflictingCardClaim(localUser.pending_card_id, localUser.uid);
      } catch (err) {
        await markNeedsReviewAndNotify(localUser.uid, localUser.email,
          `⚠️ ${sourceTag} 用户 ${localUser.email} 查询卡片占用状态失败，转人工审核: ${err.message}`);
        return;
      }
      if (conflict) {
        await markNeedsReviewAndNotify(localUser.uid, localUser.email,
          `⚠️ ${sourceTag} [抢绑拦截] 用户 ${localUser.email} 已消歧义的卡片(id=${localUser.pending_card_id})被账号 uid=${conflict.uid}(${conflict.email}) 同时占用，转人工审核`);
        return;
      }

      await kycService.bindCardToMember(localUser.pending_card_id, kycRecord.kycId);
      await new Promise((resolve) => {
        db.run(
          `UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
          [localUser.pending_card_id, localUser.uid],
          () => resolve()
        );
      });
      await sendBindSuccessMessage(localUser.uid, localUser.email);
      console.log(`✅ ${sourceTag} 自动绑卡成功(已消歧义): ${localUser.email} → card_id=${localUser.pending_card_id}, kyc_id=${kycRecord.kycId}`);
      return;
    }
    // ========== 消歧义分支结束，以下是常规按后四位搜索的流程 ==========

    const cards = await kycService.searchCardByNumber(localUser.pending_card_last4);

    // ========== 新增：多系统共用同一个 PokePay 账号/KYC 库场景 ==========
    // 后四位命中的卡里，如果刚好有一张已经绑定给了"本人"（同一 kyc_id），
    // 说明是本人在其他系统已经绑过了，直接本地关联，不用再走"唯一未绑定候选"的逻辑。
    const alreadyMine = cards.find(c => c.kyc_id === kycRecord.kycId);
    if (alreadyMine) {
      await new Promise((resolve) => {
        db.run(
          `UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
          [alreadyMine.id, localUser.uid],
          () => resolve()
        );
      });
      await sendBindSuccessMessage(localUser.uid, localUser.email);
      console.log(`✅ ${sourceTag} [跨系统关联] ${localUser.email} 已在其他系统绑定此卡，本地直接关联 card_id=${alreadyMine.id}`);
      return;
    }
    // ========== 新增结束 ==========

    // 卡片必须唯一，且尚未绑定过任何人（kyc_id === 0）
    const candidates = cards.filter(c => c.kyc_id === 0);

    if (candidates.length !== 1) {
      // 查不到 / 查到多张同后四位的卡 → 转人工审核，不猜
      await markNeedsReviewAndNotify(localUser.uid, localUser.email,
        `⚠️ ${sourceTag} 用户 ${localUser.email} 后四位 ${localUser.pending_card_last4} 匹配到 ${candidates.length} 张待绑定卡，转人工审核`);
      return;
    }

    const card = candidates[0];

    // ========== 姓名交叉核对（观察模式，原因同 manual-bind-card 接口注释）：
    // 未绑定卡片的 member_name 实测并不等于收卡人真实姓名，不能拿来做拦截条件，
    // 先记录日志观察，暂不阻断自动绑卡。==========
    const nameMatch = namesRoughlyMatch(kycRecord.firstNameEn, kycRecord.lastNameEn, card.member_name);
    if (nameMatch === false) {
      console.log(`ℹ️ ${sourceTag} [观察] 卡片 member_name(${card.member_name}) 与用户 KYC 姓名(${kycRecord.firstNameEn} ${kycRecord.lastNameEn}) 不一致，用户 ${localUser.email}，未拦截`);
    }

    // ========== 防抢绑核心检查：真正调用 bindCardToMember 之前，最后确认一次这张卡
    // 本地没有被"别的账号"占用（同一原因见 lock-card 接口注释）。这条是仅按后四位搜索的
    // 遗留分支（没有完整卡号做过精确核对），风险本来就比"消歧义"分支高，这道检查更不能省。==========
    let conflict;
    try {
      conflict = await findConflictingCardClaim(card.id, localUser.uid);
    } catch (err) {
      await markNeedsReviewAndNotify(localUser.uid, localUser.email,
        `⚠️ ${sourceTag} 用户 ${localUser.email} 查询卡片占用状态失败，转人工审核: ${err.message}`);
      return;
    }
    if (conflict) {
      await markNeedsReviewAndNotify(localUser.uid, localUser.email,
        `⚠️ ${sourceTag} [抢绑拦截] 用户 ${localUser.email} 后四位匹配到的卡片(id=${card.id})被账号 uid=${conflict.uid}(${conflict.email}) 同时占用，转人工审核`);
      return;
    }

    await kycService.bindCardToMember(card.id, kycRecord.kycId);

    await new Promise((resolve) => {
      db.run(
        `UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
        [card.id, localUser.uid],
        () => resolve()
      );
    });
    await sendBindSuccessMessage(localUser.uid, localUser.email);
    console.log(`✅ ${sourceTag} 自动绑卡成功: ${localUser.email} → card_id=${card.id}, kyc_id=${kycRecord.kycId}`);

  } catch (error) {
    console.error(`❌ ${sourceTag} 自动绑卡失败 (${localUser.email}):`, error.message);
    await markNeedsReviewAndNotify(localUser.uid, localUser.email, null);
  }
}

// ========== 执行 KYC 同步 ==========
async function syncKYCStatus(manual = false) {
  if (isSyncing) {
    if (manual) {
      return { success: false, message: '⏳ 同步任务正在执行中，请稍后再试' };
    }
    console.log('⏳ 同步任务正在执行中，跳过本次定时触发');
    return { success: false, message: '正在执行中' };
  }

  isSyncing = true;
  const startTime = Date.now();
  console.log(`🔄 [${new Date().toISOString()}] ${manual ? '手动' : '定时'}开始同步 KYC 状态...`);
  
  try {
    const result = await getAllVerifiedKYCRecords();
    const records = result.records;

    if (records.length === 0) {
      console.log('✅ 没有已通过 KYC 的记录');
      isSyncing = false;
      lastSyncTime = new Date();
      return { success: true, message: '没有已通过 KYC 的记录' };
    }
    
    let updatedCount = 0;
    const batchSize = 100;
    const emails = records.map(r => r.email);

    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      
      const res = await new Promise((resolve) => {
        db.run(
          `UPDATE users SET kyc_status = 'verified' 
           WHERE LOWER(email) IN (${placeholders}) AND (kyc_status != 'verified' OR kyc_status IS NULL)`,
          batch,
          function(err) {
            if (err) {
              console.error('批量更新失败:', err);
              resolve({ changes: 0 });
            } else {
              resolve({ changes: this.changes || 0 });
            }
          }
        );
      });
      
      updatedCount += res.changes;
    }

    // 找出"刚通过KYC，且已锁定后四位、还没绑定"的用户，逐个尝试自动绑卡
    const pendingUsers = await new Promise((resolve, reject) => {
      db.all(
        `SELECT uid, email, pending_card_last4, pending_card_id FROM users
         WHERE kyc_status = 'verified' AND card_bind_status = 'locked'`,
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });

    const recordsByEmail = new Map(records.map(r => [r.email, r]));

    for (const user of pendingUsers) {
      const kycRecord = recordsByEmail.get((user.email || '').toLowerCase());
      if (!kycRecord) {
        // 注册邮箱和 KYC 填写的邮箱对不上，无法自动匹配，转人工核实，而不是静默跳过
        await markNeedsReviewAndNotify(user.uid, user.email,
          `⚠️ 用户 ${user.email} 的 kyc_status 已是 verified，但在 KYC 名单里找不到匹配的邮箱记录，转人工审核`);
        continue;
      }
      await tryAutoBindCard(user, kycRecord);
      await new Promise(r => setTimeout(r, KYC_SYNC_CONFIG.requestInterval));
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`📊 找到 ${result.total} 条已通过 KYC 记录，同步完成，更新 ${updatedCount} 人，尝试自动绑卡 ${pendingUsers.length} 人，耗时 ${elapsed} 秒`);

    isSyncing = false;
    lastSyncTime = new Date();
    return { 
      success: true, 
      message: `同步完成: 更新 ${updatedCount} 人，耗时 ${elapsed} 秒`,
      updatedCount,
      elapsed
    };

  } catch (error) {
    console.error('KYC 同步失败:', error);
    isSyncing = false;
    return { success: false, message: '同步失败: ' + error.message };
  }
}

// ========== 启动定时任务 ==========
function startKYCSync() {
  // 启动时立即执行一次
  setTimeout(() => {
    syncKYCStatus(false);
  }, 10000);
  
  // 每小时执行一次
  setInterval(async () => {
    if (lastSyncTime) {
      const elapsed = Date.now() - lastSyncTime.getTime();
      // ========== 修改：15 * 60 * 1000 最前面的15代表间隔分钟数==========
      if (elapsed < 15 * 60 * 1000) {
        return;
      }
    }
    await syncKYCStatus(false);
  }, 60 * 1000); 
}

// ========== 新增：单个用户的"实时"KYC查询 + 绑卡 ==========
// 15分钟批量同步是兜底，不是主要手段。用户做完 PokePay 的 KYC 认证后（那边其实是实时通过的），
// 一回到我们的 App，就应该马上就能查到结果，不用干等最多15分钟。
// 原理：批量同步(syncKYCStatus)每次都要翻遍 pokepay 后台"全部已通过KYC"的分页列表，
// 对全体用户来说这样做没问题，但对"只想查自己"的单个用户来说完全没必要——
// 这里复用了原本只给客服手动绑卡用的 findVerifiedKYCRecordByEmail()，
// 它命中了就会提前停止翻页，单个用户查询通常一两页就能查到，比等15分钟快得多。

// 简单的按用户节流：避免用户疯狂点"查询"按钮、或者切来切去触发很多次，把 pokepay 接口打爆
const kycCheckThrottle = new Map(); // userId -> 上次查询时间戳
const KYC_CHECK_MIN_INTERVAL = 8000; // 至少间隔8秒才允许再查一次

async function syncSingleUserKYC(userId) {
  const user = await new Promise((resolve, reject) => {
    db.get(
      `SELECT uid, email, kyc_status, card_bind_status, pending_card_id, pending_card_last4 FROM users WHERE uid = ?`,
      [userId], (err, row) => err ? reject(err) : resolve(row)
    );
  });
  if (!user) return { status: 'pending', cardBindStatus: null };

  // 已经是 verified 了，本地状态就是最新的，不用再打一次 pokepay 接口
  if (user.kyc_status === 'verified') {
    return { status: 'verified', cardBindStatus: user.card_bind_status || null };
  }

  let kycRecord;
  try {
    console.log(`⚡ [实时] 用户 ${user.email} 触发实时KYC查询...`);
    kycRecord = await findVerifiedKYCRecordByEmail(user.email);
  } catch (err) {
    console.error(`实时查询单个用户KYC失败 (${user.email}):`, err.message);
    // 查询失败（比如接口临时报错），不改变现有状态，等下一次查询或15分钟兜底
    return { status: user.kyc_status || 'pending', cardBindStatus: user.card_bind_status || null };
  }

  if (!kycRecord) {
    // 在 pokepay 那边确实还没查到"已通过"，说明用户可能还没做完，或者刚提交还没审完
    return { status: user.kyc_status || 'pending', cardBindStatus: user.card_bind_status || null };
  }

  // 查到了：更新本地状态为 verified，如果之前已经锁定了卡片，顺手直接尝试绑卡（不用等15分钟批量任务）
  await new Promise((resolve) => {
    db.run(`UPDATE users SET kyc_status = 'verified' WHERE uid = ?`, [user.uid], () => resolve());
  });

  if (user.card_bind_status === 'locked') {
    await tryAutoBindCard(user, kycRecord, 'realtime');
  }

  const fresh = await new Promise((resolve) => {
    db.get(`SELECT kyc_status, card_bind_status FROM users WHERE uid = ?`, [user.uid], (err, row) => resolve(row));
  });
  return { status: fresh?.kyc_status || 'verified', cardBindStatus: fresh?.card_bind_status || null };
}

app.post('/api/kyc/check-now', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const userId = req.session.userId;

  const lastCheck = kycCheckThrottle.get(userId) || 0;
  const elapsed = Date.now() - lastCheck;
  if (elapsed < KYC_CHECK_MIN_INTERVAL) {
    // 查太频繁了：直接把本地当前状态返回，不再打 pokepay 接口
    const row = await new Promise((resolve) => {
      db.get(`SELECT kyc_status, card_bind_status FROM users WHERE uid = ?`, [userId], (err, r) => resolve(r));
    });
    return res.json({
      status: row?.kyc_status || 'pending',
      cardBindStatus: row?.card_bind_status || null,
      throttled: true
    });
  }
  kycCheckThrottle.set(userId, Date.now());

  try {
    const result = await syncSingleUserKYC(userId);
    res.json(result);
  } catch (error) {
    console.error('实时查询KYC状态失败:', error.message);
    res.status(500).json({ error: '查询失败，请稍后重试' });
  }
});
// ========== 新增结束 ==========

// ========== 测试 Pokepay KYC API ==========
app.get('/api/test-kyc-api', async (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '未登录' });
  }
  
  try {
    const results = {};
    
    // 1. 不带时间参数（获取最新20条）
    const url1 = 'https://dash.pokepay.com/web/kyc?limit=1000&page=1&status=2';
    const result1 = await kycService.requestWithAuth(url1, { method: 'GET' });
    results.withoutTime = {
      total: result1.data?.total,
      count: result1.data?.list?.length,
      sample: result1.data?.list?.slice(0, 3).map(item => ({ 
        email: item.email, 
        updated: new Date(item.updated_time * 1000).toLocaleString() 
      }))
    };
    
    // 2. 带 start_time（24小时前）
    const start = Math.floor((Date.now() - 24*60*60*1000) / 1000);
    const url2 = `https://dash.pokepay.com/web/kyc?limit=20&page=1&status=2&start_time=${start}`;
    const result2 = await kycService.requestWithAuth(url2, { method: 'GET' });
    results.withStartTime = {
      total: result2.data?.total,
      count: result2.data?.list?.length
    };
    
    // 3. 带 start_time 和 end_time
    const end = Math.floor(Date.now() / 1000);
    const url3 = `https://dash.pokepay.com/web/kyc?limit=20&page=1&status=2&start_time=${start}&end_time=${end}`;
    const result3 = await kycService.requestWithAuth(url3, { method: 'GET' });
    results.withBothTime = {
      total: result3.data?.total,
      count: result3.data?.list?.length
    };
    
    res.json({
      success: true,
      results: results,
      raw: {
        withoutTime: result1,
        withStartTime: result2,
        withBothTime: result3
      }
    });
    
  } catch (error) {
    console.error('测试 KYC API 失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== 手动触发 KYC 同步 API ==========
app.post('/api/admin/sync-kyc', async (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const result = await syncKYCStatus(true);
  res.json(result);
});

// ========== SSE 通知推送接口 ==========
app.get('/api/notifications/sse', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const userId = req.session.userId;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  if (!sseClients[userId]) {
    sseClients[userId] = [];
  }
  sseClients[userId].push(res);
  
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    if (sseClients[userId]) {
      sseClients[userId] = sseClients[userId].filter(client => client !== res);
      if (sseClients[userId].length === 0) {
        delete sseClients[userId];
      }
    }
  });
});

// ========== 管理员充值 vHKD ==========
app.post('/api/admin/add-vhkd', async (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { userId, amount } = req.body;
  
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: '参数错误' });
  }
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT uid, email FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
  });
  
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  
  // 更新 HKD 余额
  db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [amount, userId]);
  
  // 记录交易流水
  db.run(
    `INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'Poke国际', user.uid, amount, 'HKD', `vHKD_${Date.now()}`, 'confirmed']
  );
  
  // 插入通知
  db.run(
    `INSERT INTO user_notifications (user_id, title, message, type) 
     VALUES (?, ?, ?, ?)`,
    [userId, '💰 充值到账', `您已收到 ${Number(amount).toFixed(2)} vHKD 充值`, 'deposit']
  );
  
  // 实时推送
  pushNotification(userId, '💰 充值到账', `您已收到 ${Number(amount).toFixed(2)} vHKD 充值`);
  
  console.log(`管理员 ${req.session.adminUsername} 给用户 ${user.email} 充值 ${amount} vHKD`);
  
  res.json({ 
    success: true, 
    message: `已为用户 ${user.email} 充值 ${amount} vHKD`,
    amount: amount
  });
});

// ========== 管理员批量充值 vHKD ==========
app.post('/api/admin/batch-add-vhkd', async (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '未登录' });
  }

  const { userIds, amount } = req.body;

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: '请至少选择一个用户' });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: '请输入有效的金额' });
  }

  let successCount = 0;
  let failCount = 0;
  const failedUsers = [];

  for (const userId of userIds) {
    try {
      const user = await new Promise((resolve, reject) => {
        db.get(`SELECT uid, email FROM users WHERE uid = ?`, [userId], (err, row) => err ? reject(err) : resolve(row));
      });

      if (!user) {
        failCount++;
        failedUsers.push(userId);
        continue;
      }

      await new Promise((resolve, reject) => {
        db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [amount, userId],
          (err) => err ? reject(err) : resolve());
      });

      db.run(
        `INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, 'Poke国际', user.uid, amount, 'HKD', `vHKD_${Date.now()}_${userId}`, 'confirmed']
      );

      db.run(
        `INSERT INTO user_notifications (user_id, title, message, type) 
         VALUES (?, ?, ?, ?)`,
        [userId, '💰 充值到账', `您已收到 ${Number(amount).toFixed(2)} vHKD 充值`, 'deposit']
      );

      pushNotification(userId, '💰 充值到账', `您已收到 ${Number(amount).toFixed(2)} vHKD 充值`);

      successCount++;
    } catch (error) {
      console.error(`批量充值失败 (uid=${userId}):`, error.message);
      failCount++;
      failedUsers.push(userId);
    }
  }

  console.log(`管理员 ${req.session.adminUsername} 批量充值 ${amount} vHKD，成功 ${successCount} 人，失败 ${failCount} 人`);

  res.json({
    success: true,
    successCount,
    failCount,
    failedUsers,
    message: `成功给 ${successCount} 个用户充值 ${amount} vHKD${failCount > 0 ? `，${failCount} 个用户失败` : ''}`
  });
});

// ============= 用户前台 API =============

app.get('/api/network-info', (req, res) => {
  res.json({ network: NETWORK, fullHost: FULL_HOST, usdtContract: USDT_CONTRACT });
});

app.get('/api/balance', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!wallet || !wallet.address) {
    return res.json({ trxBalance: '0', usdtBalance: '0' });
  }
  
  try {
    const trxBalance = await tronWeb.trx.getBalance(wallet.address);
    let usdtBalance = 0;
    try {
      const url = `${FULL_HOST}/v1/accounts/${wallet.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
      const response = await fetch(url, {
          headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
      });
      const data = await response.json();
      if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
        usdtBalance = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
      }
    } catch(e) {}
    
    res.json({ 
      trxBalance: (trxBalance / 1e6).toFixed(2), 
      usdtBalance: usdtBalance.toFixed(2) 
    });
  } catch (error) {
    console.error('获取余额失败:', error);
    res.json({ trxBalance: '0', usdtBalance: '0' });
  }
});

// 注册
app.post('/api/register', async (req, res) => {
  const { email, password, bankCode, inviteCode } = req.body;
  
  // 基本字段验证（支付密码不再作为注册环节的必填项，改为登录后在"设置"里按需设置）
  if (!email || !password) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  
  // 银行编码验证（固定值 008，不对外公开）
  if (!bankCode) {
    return res.status(400).json({ error: '银行编码不能为空' });
  }
  if (bankCode !== '008') {
    return res.status(400).json({ error: '银行编码错误' });
  }
  
  // 推荐码处理（选填）
  const isSuperInvite = (inviteCode === 'SUPER2024');
  let inviterId = null;
  
  // 只有填写了推荐码且不是超级邀请码时才验证
  if (inviteCode && !isSuperInvite) {
    const inviter = await new Promise((resolve) => {
      db.get(`SELECT uid FROM users WHERE invite_code = ?`, [inviteCode], (err, row) => resolve(row));
    });
    if (!inviter) {
      return res.status(400).json({ error: '推荐码无效' });
    }
    inviterId = inviter.uid;
  }
  
  const uid = await generateUniqueUid();
  const hashedPassword = await bcrypt.hash(password, 10);
  const clientIp = getClientIp(req);

  // 注意：payment_password_hash 不再在注册时写入，保持为空，用户后续在"设置"中自行设置
  db.run(`INSERT INTO users (uid, email, password_hash, invited_by, register_ip, last_login_ip) 
        VALUES (?, ?, ?, ?, ?, ?)`, 
    [uid, email, hashedPassword, inviteCode || null, clientIp, clientIp], 
         
    function(err) {
      if (err) return res.status(400).json({ error: '邮箱已注册' });
      
      // 推荐人奖励（只有有效推荐码且非超级邀请码时才奖励）
      if (inviterId && !isSuperInvite) {
        db.run(`UPDATE users SET reward_balance = reward_balance + 0.5 WHERE uid = ?`, [inviterId]);
        db.run(`INSERT INTO reward_transactions (user_id, amount, type, related_user_id, description) 
          VALUES (?, 0.5, 'earn', ?, ?)`, 
          [inviterId, uid, `推荐新用户 ${email} 注册`]);
      }
      
      res.json({ message: '注册成功', uid: uid, inviteCode: null });
    }
  );
});

// 登录
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: '邮箱或密码错误' });
    // ========== 新增：账户已自助注销的，禁止再登录 ==========
    if (user.account_status === 'deleted') {
      return res.status(401).json({ error: '该账户已注销' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '邮箱或密码错误' });
    req.session.userId = user.uid;
    req.session.userEmail = user.email;
    req.session.isAdmin = false;
    db.run(`UPDATE users SET last_login_ip = ? WHERE uid = ?`, [getClientIp(req), user.uid]);
    res.json({ message: '登录成功', user: { uid: user.uid, email: user.email } });
  });
});

// 验证支付密码
app.post('/api/verify-payment-password', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const { paymentPassword } = req.body;
  if (!paymentPassword) return res.status(400).json({ error: '请输入支付密码' });
  
  db.get(`SELECT payment_password_hash FROM users WHERE uid = ?`, [req.session.userId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: '用户不存在' });
    if (!user.payment_password_hash) return res.status(400).json({ error: '请先在"设置"中设置支付密码' });
    const valid = await bcrypt.compare(paymentPassword, user.payment_password_hash);
    if (!valid) return res.status(401).json({ error: '支付密码错误' });
    res.json({ success: true, message: '支付密码验证通过' });
  });
});

app.get('/api/check-session', (req, res) => {
  if (req.session.userId && !req.session.isAdmin) {
    res.json({ loggedIn: true, user: { uid: req.session.userId, email: req.session.userEmail } });
  } else {
    res.json({ loggedIn: false });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: '已退出登录' });
});

// 获取用户信息
app.get('/api/user-info', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT uid, email, invite_code, reward_balance, hkd_balance, vusdt_balance, kyc_status, payment_password_hash FROM users WHERE uid = ?`, 
    [req.session.userId], (err, user) => {
      if (err || !user) return res.status(404).json({ error: '用户不存在' });
      res.json({ 
        uid: user.uid,
        email: user.email, 
        inviteCode: user.invite_code, 
        rewardBalance: user.reward_balance || 0,
        hkdBalance: user.hkd_balance || 0,
        vusdtBalance: user.vusdt_balance || 0,
        kycStatus: user.kyc_status || 'pending',
        hasPaymentPassword: !!user.payment_password_hash
      });
    });
});

// 获取钱包地址
app.get('/api/get-wallet', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT address, private_key FROM wallets WHERE user_id = ?`, [req.session.userId], (err, wallet) => {
    if (err || !wallet) return res.json({ hasWallet: false });
    res.json({ hasWallet: true, address: wallet.address, private_key: wallet.private_key });
  });
});

// 创建钱包
app.post('/api/create-wallet', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT * FROM wallets WHERE user_id = ?`, [req.session.userId], async (err, existing) => {
    if (existing) return res.status(400).json({ error: '您已经创建过钱包了', address: existing.address });
    try {
      const account = await tronWeb.createAccount();
      db.run(`INSERT INTO wallets (user_id, address, private_key) VALUES (?, ?, ?)`,
        [req.session.userId, account.address.base58, account.privateKey],
        function(err) {
          if (err) return res.status(500).json({ error: '保存钱包失败' });
          res.json({ success: true, address: account.address.base58, privateKey: account.privateKey });
        }
      );
    } catch (error) {
      res.status(500).json({ error: '创建钱包失败: ' + error.message });
    }
  });
});

// 获取资产详情
app.get('/api/assets', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT vusdt_balance FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  const vusdtBalance = user?.vusdt_balance || 0;
  
  if (!wallet || !wallet.address) {
    return res.json({ hasWallet: false, assets: [
      { token: 'TRX', balance: '0.00' },
      { token: 'USDT', balance: vusdtBalance.toFixed(2) },
      { token: 'HKD', balance: '0.00' }
    ] });
  }
  
  try {
    // ========== 修改：改用带缓存的链上余额查询，避免每次刷新都打 TronGrid ==========
    const { trx: trxAmount, usdt: chainUsdt } = await getCachedChainBalance(wallet.address);
    // ========== 修改结束 ==========
    
    const userHkd = await new Promise((resolve) => {
      db.get(`SELECT hkd_balance FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    const hkdBalance = userHkd?.hkd_balance || 0;
    
    const totalUsdt = chainUsdt + vusdtBalance;
    
    res.json({
      hasWallet: true,
      address: wallet.address,
      assets: [
        { token: 'TRX', balance: trxAmount.toFixed(2) },
        { token: 'USDT', balance: totalUsdt.toFixed(2) },
        { token: 'HKD', balance: hkdBalance.toFixed(2) }
      ]
    });
  } catch (error) {
    res.json({ hasWallet: true, assets: [
      { token: 'TRX', balance: '0.00' },
      { token: 'USDT', balance: vusdtBalance.toFixed(2) },
      { token: 'HKD', balance: '0.00' }
    ] });
  }
});

// 获取总资产
app.get('/api/total-assets', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT vusdt_balance, hkd_balance FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  const vusdtBalance = user?.vusdt_balance || 0;
  const hkdBalance = user?.hkd_balance || 0;
  
  if (!wallet || !wallet.address) {
    const rate = await getUSDTtoHKD();
    const vusdtHKD = vusdtBalance * rate;
    const totalHKD = vusdtHKD + hkdBalance;
    return res.json({ totalHKD: totalHKD.toFixed(2), details: [] });
  }
  
  try {
    // ========== 修改：改用带缓存的链上余额查询，避免每次刷新都打 TronGrid ==========
    const { trx: trxAmount, usdt: chainUsdt } = await getCachedChainBalance(wallet.address);
    // ========== 修改结束 ==========
    
    const rate = await getUSDTtoHKD();
    const trxToHKD = trxAmount * rate * 0.1;
    const chainUsdtHKD = chainUsdt * rate;
    const vusdtHKD = vusdtBalance * rate;
    const totalHKD = trxToHKD + chainUsdtHKD + vusdtHKD + hkdBalance;
    
    res.json({
      totalHKD: totalHKD.toFixed(2),
      details: [
        { token: 'TRX', amount: trxAmount.toFixed(2), hkdValue: trxToHKD.toFixed(2) },
        { token: 'USDT(链上)', amount: chainUsdt.toFixed(2), hkdValue: chainUsdtHKD.toFixed(2) },
        { token: 'USDT(平台)', amount: vusdtBalance.toFixed(2), hkdValue: vusdtHKD.toFixed(2) },
        { token: 'HKD', amount: hkdBalance.toFixed(2), hkdValue: hkdBalance.toFixed(2) }
      ]
    });
  } catch (error) {
    res.json({ totalHKD: '0.00', details: [] });
  }
});

// 获取资金流水
app.get('/api/fund-flow', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const transactions = await new Promise((resolve) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => resolve(rows || []));
  });
  
  const exchangeRecords = await new Promise((resolve) => {
    db.all(`SELECT * FROM exchange_records WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => resolve(rows || []));
  });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  
  let trxDeposits = [];
  let usdtDeposits = [];
  
  if (wallet && wallet.address) {
    try {
      const trxResponse = await fetch(`${FULL_HOST}/v1/accounts/${wallet.address}/transactions?only_confirmed=true&limit=50`, {
        headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
      });
      const trxData = await trxResponse.json();
      
if (trxData.data && trxData.data.length > 0) {
  trxDeposits = trxData.data
    .filter(tx => {
      const contract = tx.raw_data.contract[0];
      if (!contract || !contract.parameter) return false;
      const toAddress = contract.parameter.value.to_address;
      const fromAddress = contract.parameter.value.owner_address;
      const isIncoming = toAddress === tronWeb.address.toHex(wallet.address);
      const isOutgoing = fromAddress === tronWeb.address.toHex(wallet.address);
      const isRealTRX = !contract.parameter.value.asset_name;
      const amount = contract.parameter.value.amount / 1e6;
      // TRX：保留所有真实 TRX 交易，金额 >= 0.01
      return isRealTRX && amount >= 0.01;
    })
    .map(tx => {
      const value = tx.raw_data.contract[0].parameter.value;
      const amount = (value.amount / 1e6).toFixed(2);
      const toAddress = tronWeb.address.fromHex(value.to_address);
      const fromAddress = tronWeb.address.fromHex(value.owner_address);
      const isIncoming = toAddress === wallet.address;
      
      return {
        id: `trx_${isIncoming ? 'deposit' : 'withdraw'}_${tx.txID}`,
        type: isIncoming ? 'trx_deposit' : 'trx_withdraw',
        title: isIncoming ? '链上转入' : '链上转出',
        amount: isIncoming ? parseFloat(amount) : -parseFloat(amount),
        currency: 'TRX',
        from_address: fromAddress,
        to_address: toAddress,
        tx_id: tx.txID,
        created_at: getBeijingTime(tx.block_timestamp),
        status: 'completed',
        isPositive: isIncoming
      };
    });
}
      
      const usdtUrl = `${FULL_HOST}/v1/accounts/${wallet.address}/transactions/trc20?only_confirmed=true&limit=50`;
      const usdtResponse = await fetch(usdtUrl, {
        headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
      });
      const usdtData = await usdtResponse.json();
      
      if (usdtData.data && usdtData.data.length > 0) {
        usdtDeposits = usdtData.data
          .filter(tx => tx.to === wallet.address)
          .map(tx => {
            const amount = (parseInt(tx.value) / 1000000).toFixed(2);
            return {
              id: `usdt_deposit_${tx.transaction_id}`,
              type: 'usdt_deposit',
              title: '链上转入',
              amount: parseFloat(amount),
              currency: 'USDT',
              from_address: tx.from,
              to_address: tx.to,
              tx_id: tx.transaction_id,
              created_at: getBeijingTime(tx.block_timestamp),
              status: 'completed',
              isPositive: true
            };
          });
      }
      
    } catch (error) {
      console.error('查询链上记录失败:', error.message);
    }
  }
  
  const formattedTransactions = transactions.map(tx => {
    let displayToken = tx.token_type;
    let displayTitle = tx.title;
    let displayType = '';
    let isPositive = false;
    
    if (tx.token_type === 'VUSDT') {
      displayToken = 'USDT';
      displayTitle = 'USDT 汇入';
    } else if (tx.token_type === 'TRX') {
      displayTitle = 'TRX 提币';
    } else if (tx.token_type === 'USDT') {
      displayTitle = 'USDT 提币';
      isPositive = false;
    } else if (tx.token_type === 'HKD') {
      if (tx.from_address === tx.user_id) {
        displayTitle = 'HKD 转出';
        displayType = 'transfer_out';
        isPositive = false;
      } else {
        displayTitle = 'HKD 转入';
        displayType = 'transfer_in';
        isPositive = true;
      }
      displayToken = 'HKD';
    }
    return {
      id: tx.id,
      type: displayType || (tx.token_type === 'VUSDT' ? 'vusdt' : (tx.token_type === 'TRX' ? 'trx_withdraw' : (tx.token_type === 'USDT' ? 'usdt_withdraw' : 'hkd_transfer'))),
      title: displayTitle,
      amount: isPositive ? tx.amount : -tx.amount,
      currency: displayToken,
      from_address: tx.from_address,
      to_address: tx.to_address,
      tx_id: tx.tx_id,
      created_at: getBeijingTime(tx.created_at),
      status: tx.status,
      isPositive: isPositive
    };
  });
  
  const formattedExchanges = [];
  for (const ex of exchangeRecords) {
    formattedExchanges.push({
      id: `exchange_usdt_${ex.id}`,
      type: 'exchange_usdt',
      title: 'USDT 兑换支出',
      amount: -ex.usdt_amount,
      currency: 'USDT',
      from_address: '用户地址',
      to_address: '平台归集地址',
      rate: ex.rate,
      usdt_amount: ex.usdt_amount,
      hkd_amount: ex.hkd_amount,
      created_at: getBeijingTime(ex.created_at),
      status: 'completed',
      isPositive: false
    });
    
    formattedExchanges.push({
      id: `exchange_hkd_${ex.id}`,
      type: 'exchange_hkd',
      title: '资产兑换收入',
      amount: ex.hkd_amount,
      currency: 'HKD',
      rate: ex.rate,
      usdt_amount: ex.usdt_amount,
      hkd_amount: ex.hkd_amount,
      created_at: getBeijingTime(ex.created_at),
      status: 'completed',
      isPositive: true
    });
  }

  const allRecords = [...formattedTransactions, ...formattedExchanges, ...trxDeposits, ...usdtDeposits];

  // ========== 按 tx_id 去重 ==========
const seenTxIds = new Set();
const uniqueRecords = allRecords.filter(record => {
  const key = record.tx_id || record.id;
  if (seenTxIds.has(key)) {
    return false;
  }
  seenTxIds.add(key);
  return true;
});
// ========== 去重结束 ==========

uniqueRecords.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
res.json({ records: uniqueRecords });

});

// ============= 提币 API（支持 USDT 和 TRX） =============
app.post('/api/withdraw', async (req, res) => {
    // ========== 1. 基础验证 ==========
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    const { toAddress, amount, paymentPassword, tokenType, fee: frontendFee } = req.body;
    const withdrawTokenType = tokenType || 'USDT';  // 兼容旧版本，默认 USDT
    
    if (!toAddress || !amount || amount <= 0) {
        return res.status(400).json({ error: '参数错误' });
    }
    if (!paymentPassword) {
        return res.status(400).json({ error: '请输入支付密码' });
    }
    if (!toAddress.match(/^T[0-9a-zA-Z]{33}$/)) {
        return res.status(400).json({ error: '无效的 TRON 地址' });
    }
    if (withdrawTokenType !== 'USDT' && withdrawTokenType !== 'TRX') {
        return res.status(400).json({ error: '不支持的币种' });
    }
    
    // ========== 2. 验证支付密码 ==========
    const user = await new Promise((resolve) => {
        db.get(`SELECT payment_password_hash FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!user.payment_password_hash) return res.status(400).json({ error: '请先在"设置"中设置支付密码' });
    
    const valid = await bcrypt.compare(paymentPassword, user.payment_password_hash);
    if (!valid) return res.status(401).json({ error: '支付密码错误' });
    
    // ========== 3. 获取用户钱包 ==========
    const wallet = await new Promise((resolve) => {
        db.get(`SELECT address, private_key FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (!wallet) return res.status(400).json({ error: '请先创建钱包' });
    
    // ========== 4. 根据币种验证余额 ==========
    if (withdrawTokenType === 'USDT') {
        let chainUsdt = 0;
        try {
            const url = `${FULL_HOST}/v1/accounts/${wallet.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
            const response = await fetch(url, {
                headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
            });
            const data = await response.json();
            if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
                chainUsdt = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
            }
        } catch(e) {
            console.error('查询 USDT 余额失败:', e);
            return res.status(500).json({ error: '查询余额失败，请稍后重试' });
        }
        
        if (amount > chainUsdt) {
            return res.status(400).json({ error: `USDT 余额不足，当前 ${chainUsdt.toFixed(2)} USDT` });
        }
    } else {
        // TRX 提币验证
        let trxBalance = 0;
        try {
            const balance = await tronWeb.trx.getBalance(wallet.address);
            trxBalance = balance / 1e6;
        } catch(e) {
            return res.status(500).json({ error: '查询余额失败' });
        }
        
        if (amount > trxBalance) {
            return res.status(400).json({ error: `TRX 余额不足，当前 ${trxBalance.toFixed(2)} TRX` });
        }
        
        // 检查预留（建议至少保留 5 TRX 用于后续操作）
        if (trxBalance - amount < 5) {
            return res.status(400).json({ error: `提币后余额不足 5 TRX，建议至少保留 5 TRX 用于手续费。当前 ${trxBalance.toFixed(2)} TRX，提币 ${amount} TRX 后剩余 ${(trxBalance - amount).toFixed(2)} TRX` });
        }
    }
    
    // ========== 5. 获取手续费配置（仅 USDT 需要） ==========
    let fee = 0;
    let requiredTrx = 0;
    
    if (withdrawTokenType === 'USDT') {
        const feeConfig = await getUserFeeConfig(req.session.userId);
        fee = feeConfig.fixedFee;
        requiredTrx = fee + 1;
        
        if (frontendFee && Math.abs(frontendFee - fee) > 0.01) {
            return res.status(400).json({ error: '手续费计算错误' });
        }
        
        // 查询用户 TRX 余额（用于支付手续费）
        let trxBalance = 0;
        try {
            const balance = await tronWeb.trx.getBalance(wallet.address);
            trxBalance = balance / 1e6;
        } catch(e) {
            return res.status(500).json({ error: '查询余额失败' });
        }
        
        if (trxBalance < requiredTrx) {
            return res.status(400).json({ 
                error: `TRX 余额不足支付手续费！需要 ${requiredTrx.toFixed(2)} TRX，当前 ${trxBalance.toFixed(2)} TRX` 
            });
        }
        
        // 扣除 TRX 手续费
        const platformAddress = await getCollectAddress();
        if (!platformAddress) {
            return res.status(400).json({ error: '系统未设置归集地址' });
        }
        
        try {
            console.log(`扣除 TRX 手续费: ${fee} TRX`);
            await collectTrxFee(wallet.private_key, fee, platformAddress);
            console.log(`TRX 手续费扣除成功`);
        } catch (collectError) {
            console.error('TRX 手续费扣除失败:', collectError);
            return res.status(500).json({ error: `手续费扣除失败: ${collectError.message}` });
        }
        
        // 检查能量余额（主网）
        if (NETWORK === 'mainnet') {
            const balanceCheck = await checkTronZapBalance();
            if (!balanceCheck.sufficient) {
                return res.status(503).json({ 
                    error: `能量服务余额不足，请联系管理员充值。当前余额: ${balanceCheck.balance} TRX` 
                });
            }
        }
        
        // 购买能量
        let energyPurchased = 0;
        if (NETWORK === 'mainnet') {
            try {
                console.log(`购买能量...`);
                await energyProvider.buyEnergy(wallet.address, 65000, 1);
                energyPurchased = 1;
                console.log(`能量购买成功，等待 3 秒...`);
                await new Promise(r => setTimeout(r, 3000));
            } catch (energyError) {
                console.error('能量租赁失败:', energyError);
                await recordAbnormalOrder(
                    req.session.userId, 
                    'energy_purchase_failed', 
                    amount, 
                    fee, 
                    toAddress, 
                    energyError.message,
                    energyPurchased
                );
                return res.status(500).json({ 
                    error: `能量租赁失败，手续费已扣除 ${fee} TRX，请联系客服处理。`
                });
            }
        }
        
// ========== USDT 转账 ==========
const transferResult = await transferUsdtWithRetry(
    wallet.private_key,
    toAddress,
    amount,
    3
);

if (!transferResult.success) {
    await recordAbnormalOrder(
        req.session.userId, 
        'usdt_transfer_failed', 
        amount, 
        fee, 
        toAddress, 
        transferResult.error,
        energyPurchased
    );
    return res.status(500).json({ 
        error: `USDT 转账失败，已重试 ${transferResult.attempt} 次。手续费已扣除 ${fee} TRX，请联系客服处理。`
    });
}

// ========== 提取 txid（兼容字符串和对象） ==========
let usdtTxid = transferResult.txid;
if (usdtTxid && typeof usdtTxid === 'object') {
    usdtTxid = usdtTxid.txid || usdtTxid.transaction_id || usdtTxid.id || usdtTxid.txID || null;
    if (usdtTxid && typeof usdtTxid === 'object') {
        usdtTxid = null;
    }
}
// ========== 提取结束 ==========

await recordWithdrawLog(req.session.userId, amount, fee, toAddress, usdtTxid || 'unknown', 'success', 'USDT');

res.json({ 
    success: true, 
    message: '提币成功', 
    tokenType: 'USDT',
    amount: amount,
    fee: fee,
    txid: usdtTxid || 'unknown'
});

} else {
    // ========== TRX 提币 ==========
    try {
        console.log(`TRX 提币: ${amount} TRX -> ${toAddress}`);
        
        // 直接转账 TRX（TronWeb 会自动处理带宽）
        const trxAmountSun = Math.floor(amount * 1e6);
        const tx = await tronWeb.trx.sendTransaction(toAddress, trxAmountSun, wallet.private_key);
        
        // ========== 提取 txid（兼容字符串和对象） ==========
        let txid = null;
        if (typeof tx === 'string') {
            txid = tx;
        } else if (tx && typeof tx === 'object') {
            txid = tx.txid || tx.transaction_id || tx.id || tx.txID || null;
            if (txid && typeof txid === 'object') {
                txid = null;
            }
        }
        
        if (!txid) {
            console.error('TRX 提币无法提取 txid:', tx);
            txid = 'unknown';
        }
        // ========== 提取结束 ==========
        
        console.log(`TRX 提币成功，TxID: ${txid}`);
        
        // 记录交易
        await recordWithdrawLog(req.session.userId, amount, 0, toAddress, txid, 'success', 'TRX');
        
        res.json({ 
            success: true, 
            message: '提币成功', 
            tokenType: 'TRX',
            amount: amount,
            fee: 0,
            txid: txid
        });
    } catch (error) {
        console.error('TRX 提币失败:', error);
        await recordAbnormalOrder(
            req.session.userId, 
            'trx_transfer_failed', 
            amount, 
            0, 
            toAddress, 
            error.message,
            0
        );
        return res.status(500).json({ 
            error: `TRX 转账失败，请稍后重试。错误: ${error.message}`
        });
    }
}
});

app.post('/api/hkd/exchange', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const { usdtAmount, privateKey, paymentPassword, fee: frontendFee } = req.body;
  if (!usdtAmount || usdtAmount <= 0) return res.status(400).json({ error: '请输入有效的USDT数量' });
  if (!privateKey) return res.status(400).json({ error: '请输入私钥' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address, private_key FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  if (!wallet) return res.status(400).json({ error: '请先创建钱包' });
  if (wallet.private_key !== privateKey) return res.status(401).json({ error: '私钥错误' });
  
  let chainUsdt = 0;
  try {
    const url = `${FULL_HOST}/v1/accounts/${wallet.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
    const response = await fetch(url, {
          headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
    });
    const data = await response.json();
    if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
      chainUsdt = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
    }
  } catch(e) {}
  
  if (usdtAmount > chainUsdt) {
    return res.status(400).json({ error: `无法兑换，请联系客服解决。` });
  }

  // ========== 新增：TRX 手续费检查和扣除 ==========
  const feeConfig = await getUserFeeConfig(req.session.userId);
  const fee = feeConfig.fixedFee;
  const requiredTrx = fee + 1;  // 预留 1 TRX 用于归集费用
  
  let trxBalance = 0;
  try {
    const balance = await tronWeb.trx.getBalance(wallet.address);
    trxBalance = balance / 1e6;
  } catch(e) {
    return res.status(500).json({ error: '查询 TRX 余额失败' });
  }
  
  if (trxBalance < requiredTrx) {
    return res.status(400).json({ 
      error: `TRX 余额不足！需要 ${requiredTrx.toFixed(2)} TRX（手续费 ${fee} + 预留 1），当前 ${trxBalance.toFixed(2)} TRX` 
    });
  }
  
  const platformAddress = await getCollectAddress();
  if (!platformAddress) {
    return res.status(400).json({ error: '系统未设置归集地址' });
  }
  
  try {
    console.log(`兑换扣除 TRX 手续费: ${fee} TRX`);
    await collectTrxFee(wallet.private_key, fee, platformAddress);
    console.log(`TRX 手续费扣除成功`);
  } catch (collectError) {
    console.error('TRX 手续费扣除失败:', collectError);
    return res.status(500).json({ error: `手续费扣除失败: ${collectError.message}` });
  }
  // ========== 新增结束 ==========
  
  const rate = await getUSDTtoHKD(false); // 实际成交换汇：不用缓存，必须拿当下最新汇率
  const hkdAmount = usdtAmount * rate;
  
  const collectAddress = await getCollectAddress();
  if (!collectAddress) {
    return res.status(400).json({ error: '系统未设置归集地址，请联系管理员' });
  }
  
  let energyCost = 0;
  if (USE_ENERGY_RENTAL) {
    const balanceCheck = await checkTronZapBalance();
    if (!balanceCheck.sufficient) {
      return res.status(503).json({ error: `能量服务余额不足，请联系管理员充值` });
    }
    try {
      const energyResult = await energyProvider.buyEnergy(wallet.address, 65000, 1);
      energyCost = energyResult.cost;
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (energyError) {
      return res.status(500).json({ error: '能量租赁失败，请稍后重试' });
    }
  }
  
  try {
    const userTronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: wallet.private_key });
    const contract = await userTronWeb.contract().at(USDT_CONTRACT);
    const usdtAmountNum = Math.floor(usdtAmount * 1000000);
    const tx = await contract.transfer(collectAddress, usdtAmountNum).send();
    
    db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [hkdAmount, req.session.userId]);
    db.run(`INSERT INTO exchange_records (user_id, usdt_amount, hkd_amount, rate, tx_id) 
      VALUES (?, ?, ?, ?, ?)`, [req.session.userId, usdtAmount, hkdAmount, rate, tx]);
    
    res.json({ success: true, usdtAmount, hkdAmount, rate, txid: tx, energyCost });
  } catch (error) {
    console.error('兑换失败:', error);
    res.status(500).json({ error: '兑换失败: ' + error.message });
  }
});

app.get('/api/admin/vusdt-pool', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT balance FROM vusdt_pool WHERE id = 1`, [], (err, row) => {
    res.json({ balance: row ? row.balance : 0 });
  });
});

app.post('/api/admin/transfer-vusdt', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: '参数错误' });
  
  const pool = await new Promise((resolve) => {
    db.get(`SELECT balance FROM vusdt_pool WHERE id = 1`, [], (err, row) => resolve(row));
  });
  if (!pool || pool.balance < amount) {
    return res.status(400).json({ error: '系统 vUSDT 池余额不足' });
  }
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT email, vusdt_balance FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
  });
  if (!user) return res.status(404).json({ error: '用户不存在' });
  
  const collectAddress = await getCollectAddress();
  
  const userWallet = await new Promise((resolve) => {
    db.get(`SELECT address FROM wallets WHERE user_id = ?`, [userId], (err, row) => resolve(row));
  });
  const userAddress = userWallet?.address || 'unknown';
  
  db.run(`UPDATE vusdt_pool SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [amount]);
  db.run(`UPDATE users SET vusdt_balance = vusdt_balance + ? WHERE uid = ?`, [amount, userId]);
  
  db.run(`INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'TLaGjwhvA8XQYSxFAcAXy7Dvuue9eGYitv', userAddress, amount, 'VUSDT', `vusdt_${Date.now()}`, 'confirmed']);
  
  res.json({ success: true, message: `已向用户 ${user.email} 转账 ${amount} vUSDT` });
});

app.post('/api/hkd/withdraw', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const { amount, bankCardId, privateKey } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '请输入有效的提现金额' });
  if (!bankCardId) return res.status(400).json({ error: '请选择提现银行卡' });
  if (!privateKey) return res.status(400).json({ error: '请输入私钥' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT private_key FROM wallets WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  if (!wallet) return res.status(400).json({ error: '请先创建钱包' });
  if (wallet.private_key !== privateKey) return res.status(401).json({ error: '私钥错误' });
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT hkd_balance FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  if (!user || user.hkd_balance < amount) {
    return res.status(400).json({ error: `港币余额不足！当前余额 ${user?.hkd_balance || 0} HKD` });
  }
  
  const card = await new Promise((resolve) => {
    db.get(`SELECT id FROM bank_cards WHERE id = ? AND user_id = ?`, [bankCardId, req.session.userId], (err, row) => resolve(row));
  });
  if (!card) return res.status(400).json({ error: '银行卡不存在' });
  
  db.run(`UPDATE users SET hkd_balance = hkd_balance - ? WHERE uid = ?`, [amount, req.session.userId]);
  db.run(`INSERT INTO withdraw_fiat_records (user_id, amount, bank_card_id, status) 
    VALUES (?, ?, ?, 'pending')`, [req.session.userId, amount, bankCardId], function(err) {
    if (err) {
      db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [amount, req.session.userId]);
      return res.status(500).json({ error: '提现申请失败' });
    }
    res.json({ success: true, message: '提现申请已提交，24小时内处理', recordId: this.lastID });
  });
});

app.get('/api/exchange-records', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.all(`SELECT * FROM exchange_records WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json({ records: rows || [] });
  });
});

app.get('/api/hkd/withdraw-records', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.all(`SELECT w.*, b.bank_name, b.card_number 
    FROM withdraw_fiat_records w 
    LEFT JOIN bank_cards b ON w.bank_card_id = b.id 
    WHERE w.user_id = ? ORDER BY w.created_at DESC`, 
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      const formatted = (rows || []).map(r => ({
        ...r,
        created_at: getBeijingTime(r.created_at)
      }));
      res.json({ records: formatted });
    });
});

// ============= KYC API =============

app.post('/api/kyc/lock-card', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  // ========== 流程说明 ==========
  // 1. 用户在前端输入完整卡号
  // 2. 验证卡号格式并查询卡片信息（是否已绑卡）
  // 3. 如果卡片未绑定，仅将本地状态设为 locked，等待用户完成 Didit KYC
  // 4. 当 Didit KYC 审核通过后（webhook 触发），才执行绑卡逻辑（绑定到用户输入的这张卡）
  // ============================
  
  const { fullCardNumber } = req.body;
  if (!fullCardNumber || !/^\d{12,19}$/.test(fullCardNumber)) {
    return res.status(400).json({ error: '请输入正确的 Poke 国际卡完整卡号' });
  }
  const last4 = fullCardNumber.slice(-4);

  const userId = req.session.userId;

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(`SELECT email, card_bind_status, pokepay_card_id FROM users WHERE uid = ?`, [userId],
        (err, row) => err ? reject(err) : resolve(row));
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (user.card_bind_status === 'active') {
      return res.status(400).json({ error: '您的卡片已完成绑定' });
    }
    if (user.card_bind_status === 'locked') {
      return res.status(400).json({ error: '您已提交过卡片信息，请等待 KYC 审核完成' });
    }

    let cards;
    try {
      cards = await kycService.searchCardByNumber(fullCardNumber);
    } catch (err) {
      console.error('查询卡片信息失败:', err.message);
      return res.status(500).json({ error: '卡片信息查询失败，请稍后重试' });
    }

    if (!cards || cards.length === 0) {
      return res.status(400).json({ error: '请输入正确的 Poke 国际卡卡号' });
    }
    if (cards.length > 1) {
      console.warn(`⚠️ 完整卡号查询命中了多条记录，异常情况，用户 uid=${userId}`);
      return res.status(400).json({ error: '卡片信息异常，请联系客服协助绑定' });
    }

    const card = cards[0];
    const returnedCardNo = String(card.card_no ?? card.cardNo ?? '');
    if (!kycService.cardNoMatchesMasked(fullCardNumber, returnedCardNo)) {
      console.warn(`⚠️ [锁卡安全] 完整卡号不匹配（可能仅后四位命中），已拦截。用户 uid=${userId}`);
      return res.status(400).json({ error: '请输入正确的 Poke 国际卡完整卡号' });
    }

    // ========== 检查卡片是否已被绑定 ==========
    if (card.kyc_id !== 0) {
      console.warn(`⚠️ [锁卡失败] 卡片 card_id=${card.id} 已被绑定 (kyc_id=${card.kyc_id})，用户 uid=${userId}`);
      return res.status(400).json({ error: '该卡片已被绑定，请选择其他卡片' });
    }

    // ========== 防抢绑检查：确认这张卡没有被其他用户锁定 ==========
    let conflict;
    try {
      conflict = await findConflictingCardClaim(card.id, userId);
    } catch (err) {
      console.error('查询卡片占用状态失败:', err.message);
      return res.status(500).json({ error: '卡片信息查询失败，请稍后重试' });
    }
    if (conflict) {
      console.warn(`⚠️ [锁卡安全/抢绑拦截] 用户 uid=${userId} 尝试锁定的卡片 (card_id=${card.id}) 已被账号 uid=${conflict.uid}(${conflict.email}) 占用 (状态=${conflict.card_bind_status})，已拦截`);
      return res.status(400).json({ error: '卡片信息异常，请联系客服协助绑定', contactSupport: true });
    }

    // ========== 仅锁定卡片，暂不绑定！等待 KYC 审核通过后再绑 ==========
    try {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE users SET pending_card_id = ?, card_bind_status = 'locked' WHERE uid = ?`,
          [card.id, userId],
          (err) => err ? reject(err) : resolve()
        );
      });
      console.log(`✅ [锁卡成功] 用户 uid=${userId} 已锁定卡片 card_id=${card.id} (last4=${last4})，等待 KYC 审核`);
    } catch (err) {
      console.error('更新本地用户锁卡状态失败:', err.message);
      return res.status(500).json({ error: '锁卡操作失败，请稍后重试' });
    }

    res.json({ 
      success: true, 
      message: '卡片已锁定，请完成 KYC 认证后将自动绑卡',
      cardInfo: {
        cardNo: returnedCardNo,
        last4: last4
      }
    });
  } catch (error) {
    console.error('锁定卡片信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========== 新增：绑卡异常 / 从未绑卡 的用户，通过客服会话里"立即绑卡"按钮，自助输入完整卡号重新绑定 ==========
// 与 /api/kyc/lock-card 的区别：这里的用户 KYC 已经通过（甚至可能之前已经 needs_review 过），
// 校验通过后直接调用 pokepay 完成绑定，而不是只是"锁定"等待下一次定时同步。
app.post('/api/kyc/manual-bind-card', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const userId = req.session.userId;

  const { fullCardNumber } = req.body;
  const trimmed = (fullCardNumber || '').trim();
  if (!trimmed || !/^\d{12,19}$/.test(trimmed)) {
    return res.status(400).json({ error: '请输入正确的完整卡号（12-19位数字）' });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(`SELECT email, kyc_status, card_bind_status FROM users WHERE uid = ?`, [userId], (err, row) => err ? reject(err) : resolve(row));
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.kyc_status !== 'verified') {
      return res.status(400).json({ error: '您尚未通过 KYC 认证' });
    }
    if (user.card_bind_status === 'active') {
      return res.status(400).json({ error: '您的卡片已完成绑定' });
    }

    let cards;
    try {
      cards = await kycService.searchCardByNumber(trimmed);
    } catch (err) {
      console.error('查询卡片信息失败:', err.message);
      return res.status(500).json({ error: '卡片信息查询失败，请稍后重试' });
    }

    if (!cards || cards.length === 0) {
      // 填错了：直接让用户重试，不做特殊处理
      return res.status(400).json({ error: '未找到该卡号对应的卡片，请核对后重新输入' });
    }
    if (cards.length > 1) {
      console.warn(`⚠️ 完整卡号查询命中了多条记录，异常情况，用户 uid=${userId}`);
      return res.status(400).json({ error: '卡片信息异常，请联系客服协助绑定', contactSupport: true });
    }

    const card = cards[0];

    // ========== 安全修复：核对返回卡片的完整卡号是否与用户提交的一致（详见 lock-card 接口注释）==========
    // dash 接口返回的 card_no 是打码的，用 cardNoMatchesMasked 只核对未打码的位，避免误拦截。
    const returnedCardNo = String(card.card_no ?? card.cardNo ?? '');
    if (!kycService.cardNoMatchesMasked(trimmed, returnedCardNo)) {
      console.warn(`⚠️ [绑卡安全] 完整卡号不匹配（可能仅后四位命中），已拦截。用户 uid=${userId}`);
      return res.status(400).json({ error: '未找到该卡号对应的卡片，请核对后重新输入' });
    }

    // kycRecord 提前查询：卡"已绑定"和"未绑定"两条分支都需要用它
    let kycRecord;
    try {
      kycRecord = await findVerifiedKYCRecordByEmail(user.email);
    } catch (err) {
      console.error('查询 KYC 记录失败:', err.message);
      return res.status(500).json({ error: 'KYC 记录查询失败，请稍后重试' });
    }
    if (!kycRecord) {
      return res.status(400).json({ error: '在已通过 KYC 的名单中未找到您的邮箱，请联系客服核实', contactSupport: true });
    }

    if (card.kyc_id !== 0) {
      // ========== 新增：多系统共用同一个 PokePay 账号/KYC 库场景 ==========
      // 卡已绑定不代表一定是"别人"绑的，可能是本人在其他系统里已经绑过。
      // kycId 相同 → 就是本人自己的卡，本地直接关联，不再调用 bindCardToMember。
      if (kycRecord.kycId === card.kyc_id) {
        await new Promise((resolve, reject) => {
          db.run(`UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
            [card.id, userId], (err) => err ? reject(err) : resolve());
        });
        await sendBindSuccessMessage(userId, user.email);
        console.log(`✅ [跨系统关联] 用户 ${user.email} 已在其他系统绑定此卡，本地直接关联 card_id=${card.id}`);
        return res.json({ success: true, message: '检测到您已在其他系统绑定该卡，已为您同步关联' });
      }
      // 已经被别人绑定了：提示联系客服，前端据此展示"联系客服"按钮
      return res.status(400).json({ error: '该卡片已被绑定，请联系客服核实', contactSupport: true });
      // ========== 新增结束 ==========
    }

    // ========== 姓名交叉核对（观察模式）：实测发现未绑定卡片的 member_name 字段并不是
    // "预填的收卡人姓名"（可能为空/占位符/代理名称），与用户真实 KYC 姓名对不上是正常现象，
    // 不能作为拦截条件——之前按"不一致就拒绝"会导致所有正常用户永远绑不上卡，已回退。
    // 这里改成仅记录日志，方便后续观察 member_name 字段在未绑定卡片上的真实取值规律，
    // 等确认清楚它的实际语义后，再决定要不要、以及怎么用它做真正的校验。
    const nameMatch = namesRoughlyMatch(kycRecord.firstNameEn, kycRecord.lastNameEn, card.member_name);
    if (nameMatch === false) {
      console.log(`ℹ️ [观察] 卡片 member_name(${card.member_name}) 与用户 KYC 姓名(${kycRecord.firstNameEn} ${kycRecord.lastNameEn}) 不一致，用户 uid=${userId}，未拦截`);
    }

    // ========== 防抢绑核心检查：真正调用 bindCardToMember 之前，最后确认一次这张卡
    // 本地没有被"别的账号"占用（同一原因见 lock-card 接口注释）。这里是"立即绑定"路径，
    // 比 lock-card 更危险——没有先锁定等待的中间态，一旦通过校验就直接真绑定，
    // 所以这个检查必须放在调用 bindCardToMember 之前的最后一步，不能省。==========
    let conflict;
    try {
      conflict = await findConflictingCardClaim(card.id, userId);
    } catch (err) {
      console.error('查询卡片占用状态失败:', err.message);
      return res.status(500).json({ error: '卡片信息查询失败，请稍后重试' });
    }
    if (conflict) {
      console.warn(`⚠️ [绑卡安全/抢绑拦截] 用户 uid=${userId} 尝试立即绑定的卡片(card_id=${card.id})已被账号 uid=${conflict.uid}(${conflict.email}) 占用(状态=${conflict.card_bind_status})，已拦截`);
      return res.status(400).json({ error: '卡片信息异常，请联系客服协助绑定', contactSupport: true });
    }

    try {
      await kycService.bindCardToMember(card.id, kycRecord.kycId);
    } catch (err) {
      console.error('绑卡失败:', err.message);
      return res.status(500).json({ error: `绑卡失败：${err.message}` });
    }

    await new Promise((resolve, reject) => {
      db.run(`UPDATE users SET pokepay_card_id = ?, card_bind_status = 'active' WHERE uid = ?`,
        [card.id, userId], (err) => err ? reject(err) : resolve());
    });

    await sendBindSuccessMessage(userId, user.email);

    res.json({ success: true, message: '绑卡成功' });
  } catch (error) {
    console.error('自助完整卡号绑卡失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});
// ========== 新增结束 ==========

// ========== 新增：didit 会话缓存 + 节流 ==========
// 目的：杜绝用户反复点击"进行KYC"按钮导致反复调用官方接口、反复计费。
// - 20分钟内已有会话链接 → 直接复用同一个链接，不再重新调用 didit/init
// - 同一用户两次真正调用之间至少间隔60秒 → 兜底节流，防止前端异常/连续点击穿透
const kycSessionThrottle = new Map(); // uid -> 上次真正调用 didit/init 的时间戳（进程内存，重启会清空，影响很小）
const KYC_SESSION_REUSE_WINDOW_MS = 20 * 60 * 1000; // 会话复用窗口：20分钟
const KYC_SESSION_MIN_INTERVAL_MS = 60 * 1000;      // 最小调用间隔：60秒

// 姓名格式校验：只允许英文字母、空格、连字符、撇号，1-30个字符
// （didit/PokePay 要求"像姓名"的格式，纯数字/特殊符号会被官方接口直接拒绝）
function isValidEnglishName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z\s\-']{0,29}$/.test(name.trim());
}

// 提交/更新用于 KYC 的真实英文姓名（生成 didit 会话之前的必要前置步骤）
app.post('/api/kyc/identity', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }
  const userId = req.session.userId;
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();

  if (!isValidEnglishName(firstName) || !isValidEnglishName(lastName)) {
    return res.status(400).json({ error: '请填写正确的英文姓名（仅支持英文字母，需与证件一致）' });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(`SELECT uid, kyc_status FROM users WHERE uid = ?`, [userId], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.kyc_status === 'verified') {
      return res.json({ success: false, error: '您已完成 KYC 认证，无需重复填写' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET kyc_first_name = ?, kyc_last_name = ? WHERE uid = ?`,
        [firstName.toUpperCase(), lastName.toUpperCase(), userId],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.json({ success: true });
  } catch (error) {
    console.error('保存 KYC 姓名失败:', error);
    res.status(500).json({ error: '保存失败，请重试' });
  }
});

app.get('/api/kyc/link', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }
  const userId = req.session.userId;
  let userEmail = null; // 供 catch 块使用，避免引用 try 块内声明的 user 导致 ReferenceError

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        `SELECT uid, email, kyc_status, kyc_session_url, kyc_session_created_at, kyc_first_name, kyc_last_name FROM users WHERE uid = ?`,
        [userId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    userEmail = user.email;

    // 后端兜底：已通过 / 已被拒绝的用户不允许再生成新会话（前端 /api/kyc/status 已经拦过一次）
    if (user.kyc_status === 'verified') {
      return res.json({ success: false, error: '您已完成 KYC 认证，无需重复认证' });
    }
    if (user.kyc_status === 'rejected') {
      return res.json({ success: false, error: '您的 KYC 认证被拒绝，请联系客服' });
    }

    // ========== 改造：直连 Didit 后不再需要提前收集英文姓名 ==========
    // 以前必须先拿到真实姓名才能发起认证，是因为 PokePay 的 didit/init 代理接口要求预填
    // first_en_name/last_en_name。直连 Didit 自己的 Sessions API 不需要这个前置条件——
    // 姓名由 Didit 的 ID Verification 步骤通过证件 OCR 直接识别，更准确，也不用再猜。
    // （kyc_first_name/kyc_last_name 字段仍保留，只在 OCR 识别不到姓名时当兜底用，见
    // handleDiditApproved。）

    // 已有未过期的会话，直接复用同一个链接，不再调用官方接口
    if (user.kyc_session_url && user.kyc_session_created_at) {
      const ageMs = Date.now() - new Date(user.kyc_session_created_at).getTime();
      if (ageMs < KYC_SESSION_REUSE_WINDOW_MS) {
        return res.json({
          success: true,
          kycLink: user.kyc_session_url,
          message: '点击按钮跳转完成 KYC 认证',
          reused: true,
        });
      }
    }

    // 节流：短时间内不允许重复真正调用第三方接口
    const lastCallAt = kycSessionThrottle.get(userId) || 0;
    if (Date.now() - lastCallAt < KYC_SESSION_MIN_INTERVAL_MS) {
      if (user.kyc_session_url) {
        // 节流期内宁可先给旧链接兜底（哪怕已超过复用窗口），也不要让用户看到报错
        return res.json({ success: true, kycLink: user.kyc_session_url, message: '点击按钮跳转完成 KYC 认证', reused: true });
      }
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    kycSessionThrottle.set(userId, Date.now());

    // ========== 改造：直接调用 Didit 自己的 Sessions API，不再经过 PokePay 代理 ==========
    // callback 跳回站点首页（SPA，认证完成后 Didit 会带上 ?verificationSessionId=...&status=...，
    // 前端目前不需要解析这两个参数——真正的认证结果判定始终以 webhook（/api/webhooks/didit）为准，
    // 这里的 callback 只是把用户体验上带回产品内。前端已有的 checkKYCStatus() /
    // /api/kyc/check-now 轮询会在用户回到页面后自己把最新状态拉回来）。
    const callbackUrl = `${req.protocol}://${req.get('host')}/`;
    const result = await diditService.createSession(user, callbackUrl);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET kyc_session_id = ?, kyc_session_url = ?, kyc_session_created_at = ?, didit_session_status = ? WHERE uid = ?`,
        [result.sessionId, result.kycLink, new Date().toISOString(), result.status || 'Not Started', userId],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.json({
      success: true,
      kycLink: result.kycLink,
      message: '点击按钮跳转完成 KYC 认证',
    });
  } catch (error) {
    console.error('获取 KYC 链接失败:', error);
    // ========== 优化：PokePay/didit 侧偶发返回"邮箱已被其它客户端使用"这类原始上游提示，
    // 直接透传给用户既难理解、也容易被误以为是本平台自己的报错。
    // 常见于该邮箱在 didit 侧存在此前未正常关闭的认证会话（例如上一次认证被拒后会话未清理）。
    // 这里识别出来后换成更明确的提示，原始信息仍完整打进日志，方便客服/开发按邮箱排查。
    const rawMsg = error.message || '';
    if (/已被其?它客户端使用|already.*used.*client/i.test(rawMsg)) {
      console.warn(`⚠️ [KYC] 用户 uid=${userId} email=${userEmail} 触发"邮箱已被其它客户端使用"，原始信息: ${rawMsg}`);
      return res.status(409).json({
        error: '该邮箱在认证服务商侧存在未完成的历史认证记录，暂时无法发起新的认证，请联系客服协助处理',
        code: 'KYC_EMAIL_CONFLICT',
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ========== 新增：Didit Webhook —— 认证结果实时推送入口 ==========
// 对应 Didit 后台 API & Webhooks > 目标地址配置这里的 URL，订阅事件至少要包含 status.updated。
// 注意：这个路由必须能收到 Didit 的原始 POST（走 express.json() 全局中间件解析成对象即可，
// 不需要单独接管 raw body——用的是 X-Signature-V2，见 DiditService.verifyWebhookSignatureV2 注释）。
app.post('/api/webhooks/didit', async (req, res) => {
  const signatureV2 = req.get('X-Signature-V2');
  const timestamp = req.get('X-Timestamp');
  const body = req.body || {};

  if (!diditService.verifyWebhookSignatureV2(body, signatureV2, timestamp)) {
    console.warn('⚠️ [Didit webhook] 签名验证失败，拒绝处理', { hasSig: !!signatureV2, hasTs: !!timestamp });
    return res.status(401).json({ message: 'Invalid signature' });
  }

  // 先确认收到，再异步处理——避免处理耗时导致 Didit 判定超时重试，产生重复投递
  res.status(200).json({ ok: true });

  if (body.webhook_type !== 'status.updated' || body.session_kind === 'business') {
    return; // 只处理个人 KYC 会话的状态变更事件，其它事件类型/KYB暂不处理
  }

  const uid = body.vendor_data;
  if (!uid) return;

  try {
    switch (body.status) {
      case 'Approved':
        await handleDiditApproved(body);
        break;
      case 'Declined':
        await new Promise((resolve, reject) => {
          db.run(`UPDATE users SET kyc_status = 'rejected', didit_session_status = 'Declined' WHERE uid = ?`,
            [uid], (err) => (err ? reject(err) : resolve()));
        });
        console.log(`ℹ️ [Didit] 用户 uid=${uid} KYC 认证被拒绝`);
        break;
      case 'In Review':
      case 'In Progress':
      case 'Resubmitted':
      case 'Abandoned':
      case 'Expired':
      case 'Kyc Expired':
        // 这几种状态目前只同步一下本地缓存的会话状态方便客服排查，不改变 kyc_status
        // （kyc_status 仍是 pending，用户可以在 Expired/Kyc Expired 后重新发起一次新的认证）
        await new Promise((resolve, reject) => {
          db.run(`UPDATE users SET didit_session_status = ? WHERE uid = ?`,
            [body.status, uid], (err) => (err ? reject(err) : resolve()));
        });
        break;
      default:
        console.warn(`⚠️ [Didit webhook] 未识别的状态: ${body.status}`);
    }
  } catch (error) {
    console.error(`❌ [Didit webhook] 处理 uid=${uid} 状态=${body.status} 时出错:`, error);
  }
});

app.get('/api/kyc/status', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  db.get(`SELECT kyc_status, card_bind_status FROM users WHERE uid = ?`, [req.session.userId], (err, row) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json({ 
      status: row?.kyc_status || 'pending',
      cardBindStatus: row?.card_bind_status || null
    });
  });
});

// ============= 卡片 API =============

app.get('/api/card/balance', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });

  // ========== 修改：查询时加上 card_display_name ==========
  const user = await new Promise((resolve) => {
    db.get(`SELECT pokepay_card_id, card_display_name FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  // ========== 修改结束 ==========

  if (!user || !user.pokepay_card_id) {
    return res.json({ success: false, message: '未绑定VISA国际卡，请联系客服' });
  }

  try {
    const cardInfo = await cardService.getCardDetail(user.pokepay_card_id);
    
    // ========== 新增：如果本地有自定义姓名，覆盖 memberName ==========
    if (user.card_display_name && user.card_display_name.trim()) {
      cardInfo.memberName = user.card_display_name.trim();
      console.log(`用户 ${req.session.userId} 使用自定义姓名: ${cardInfo.memberName}`);
    }
    // ========== 修改结束 ==========
    
    res.json(cardInfo);
  } catch (error) {
    console.error('获取卡片余额失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/card/transactions', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });

  const user = await new Promise((resolve) => {
    db.get(`SELECT pokepay_card_id FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });

  if (!user || !user.pokepay_card_id) {
    return res.json({ success: false, message: '未绑定VISA国际卡，请联系客服' });
  }

  try {
    const limit = parseInt(req.query.limit) || 20;
    const txData = await cardService.getCardTransactions(user.pokepay_card_id, limit);
    res.json(txData);
  } catch (error) {
    console.error('获取卡片交易记录失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/card/withdraw', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '请输入有效的提现金额' });
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT hkd_balance, pokepay_card_id FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.pokepay_card_id) return res.status(400).json({ error: '未绑定VISA国际卡，请联系客服' });
  if (user.hkd_balance < amount) return res.status(400).json({ error: 'HKD 余额不足' });
  
  db.run(`INSERT INTO card_withdraw_requests (user_id, amount, card_id, status) VALUES (?, ?, ?, 'pending')`, 
    [req.session.userId, amount, user.pokepay_card_id], function(err) {
      if (err) return res.status(500).json({ error: '申请失败' });

      // ========== 新增：推送提现申请通知给客服 ==========
      try {
        const message = `用户 ${user.email || req.session.userId} 提交了 ${amount} HKD 提现申请`;
        db.all(`SELECT id FROM admins WHERE role IN ('support', 'admin')`, [], (err, admins) => {
          if (!err && admins) {
            for (const admin of admins) {
              sendPushNotification(admin.id, '💳 提现申请', message, 1);
            }
          }
        });
      } catch(e) {
        console.log('推送通知失败:', e);
      }
      // ========== 推送结束 ==========

      
      res.json({ success: true, message: '提现申请已提交，等待管理员处理', requestId: this.lastID });
    });
});

app.get('/api/card/withdraw-records', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  db.all(`SELECT * FROM card_withdraw_requests WHERE user_id = ? ORDER BY created_at DESC`, 
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      const formatted = rows.map(r => ({
        ...r,
        created_at: getBeijingTime(r.created_at),
        processed_at: r.processed_at ? getBeijingTime(r.processed_at) : null
      }));
      res.json({ records: formatted });
    });
});

// ============= 卡片取款密码重置 API =============

// 1. 获取取款密码重置状态
app.get('/api/card/pin/reset-status', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '未登录' });
    }

    // 获取用户关联的卡片 ID
    const user = await new Promise((resolve) => {
        db.get(`SELECT pokepay_card_id FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });

    if (!user || !user.pokepay_card_id) {
        return res.status(400).json({ error: '您暂未绑定VISA卡，无法设置取款密码' });
    }

    const cardId = user.pokepay_card_id;

    try {
        const result = await kycService.requestWithAuth(`https://dash.pokepay.com/web/card/pin/resetEmail/${cardId}`, {
            method: 'GET'
        });

        if (result && result.code === 200) {
            res.json({
                success: true,
                maxCount: result.data.max_count,
                remainCount: result.data.remain_count,
                sendInterval: result.data.send_interval,
                sendRemainTime: result.data.send_remain_time
            });
        } else {
            res.status(400).json({ 
                success: false, 
                error: result?.errstr || '获取状态失败' 
            });
        }
    } catch (error) {
        console.error('获取取款密码重置状态失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 2. 发送取款密码重置邮件
app.put('/api/card/pin/reset-email', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '未登录' });
    }

    // 获取用户关联的卡片 ID
    const user = await new Promise((resolve) => {
        db.get(`SELECT pokepay_card_id FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });

    if (!user || !user.pokepay_card_id) {
        return res.status(400).json({ error: '您暂未绑定VISA卡，无法设置取款密码' });
    }

    const cardId = user.pokepay_card_id;

    try {
        const result = await kycService.requestWithAuth(`https://dash.pokepay.com/web/card/pin/resetEmail`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                card_id: cardId,
                verify_code: null,
                verify_type: null
            })
        });

        if (result && result.code === 200 && result.data === "succeed") {
            res.json({ 
                success: true, 
                message: '重置邮件已发送，请查收邮箱' 
            });
        } else {
            res.status(400).json({ 
                success: false, 
                error: result?.errstr || '发送重置邮件失败' 
            });
        }
    } catch (error) {
        console.error('发送取款密码重置邮件失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// ============= 新增：设置取款密码（APP内验证码方案，替代邮件跳转链接） =============
// 流程：前端先调 POST /api/send-verification { type: 'card_pin' } 发验证码到注册邮箱，
// 用户在 APP 内输入验证码 + 新PIN，调这个接口一次性完成校验+设置，全程不跳出 APP。
app.post('/api/card/pin/verify-and-set', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '未登录' });
    }

    const { verificationCode, newPin } = req.body;

    if (!verificationCode || !newPin) {
        return res.status(400).json({ error: '请填写完整信息' });
    }

    // PIN 格式：6位数字（以官方邮件重置流程实际要求的位数为准，接口文档示例的4位仅为占位示例）
    if (!/^\d{6}$/.test(newPin)) {
        return res.status(400).json({ error: '取款密码必须是6位数字' });
    }

    const user = await new Promise((resolve) => {
        db.get(
            `SELECT uid, email, pokepay_card_id FROM users WHERE uid = ?`,
            [req.session.userId], (err, row) => resolve(row)
        );
    });

    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!user.pokepay_card_id) {
        return res.status(400).json({ error: '您暂未绑定VISA卡，无法设置取款密码' });
    }

    // 注册邮箱验证码（证明操作者能收到该卡持卡人的注册邮箱，等效于原来的邮件跳转链接）
    const verification = await new Promise((resolve) => {
        db.get(
            `SELECT id, code, expires_at, is_used, attempt_count
             FROM email_verifications
             WHERE email = ? AND type = 'card_pin' AND is_used = 0
             ORDER BY created_at DESC LIMIT 1`,
            [user.email],
            (err, row) => resolve(row)
        );
    });

    if (!verification) {
        return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
    }

    const now = new Date();
    const expiresAt = new Date(verification.expires_at);
    if (now > expiresAt) {
        db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
        return res.status(400).json({ error: '验证码已过期，请重新获取' });
    }

    if (verification.attempt_count >= 5) {
        db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
        return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
    }

    if (verification.code !== verificationCode) {
        db.run(`UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`, [verification.id]);
        const remainingAttempts = 5 - (verification.attempt_count + 1);
        return res.status(400).json({ error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次` });
    }

    // 验证码正确，立即标记已使用（防止同一个验证码被重放）
    await new Promise((resolve) => {
        db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id], () => resolve());
    });

    // 两重验证都通过，真正调用官方接口设置 PIN
    try {
        const card = await kycService.getCardDetail(user.pokepay_card_id);
        if (!card.publicToken) {
            console.error(`用户 ${user.email} 卡片 ${user.pokepay_card_id} 缺少 public_token，无法设置PIN`);
            return res.status(500).json({ error: '卡片信息异常，请联系客服处理' });
        }

        await kycService.setCardPin(card.publicToken, newPin);

        console.log(`用户 ${user.email} 通过APP内验证码成功设置取款密码`);
        res.json({ success: true, message: '取款密码设置成功' });
    } catch (error) {
        console.error(`设置取款密码失败 (${user.email}):`, error.message);
        // PIN 被锁定等场景，官方接口一般会在 errstr 里说明，直接透传给用户
        res.status(400).json({ error: error.message || '设置取款密码失败，请稍后重试或联系客服' });
    }
});

// 测试推送接口（开发调试用）
app.get('/api/support/test-push', async (req, res) => {
    if (!req.session.isAdmin) {
        return res.status(401).json({ error: '未登录' });
    }
    
    const adminId = req.session.adminId;
    console.log(`发送测试推送给管理员 ${adminId}`);
    
    try {
        await sendPushNotification(adminId, '测试通知', '这是一条测试消息', 1);
        res.json({ success: true, message: '测试推送已发送' });
    } catch (error) {
        console.error('测试推送失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============= 通告管理 API =============

// 获取当前通告（用户端）
app.get('/api/announcement', (req, res) => {
  db.get(`SELECT value, updated_at FROM settings WHERE key = 'announcement'`, [], (err, row) => {
    if (err || !row || !row.value) {
      return res.json({ 
        success: true, 
        hasAnnouncement: false,
        content: null
      });
    }
    
    try {
      const data = JSON.parse(row.value);
      res.json({ 
        success: true, 
        hasAnnouncement: true,
        content: data.content,
        updated_at: row.updated_at
      });
    } catch(e) {
      res.json({ 
        success: true, 
        hasAnnouncement: false,
        content: null
      });
    }
  });
});

// 管理员设置通告
app.post('/api/admin/announcement', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  
  const { content } = req.body;
  
  if (!content || !content.trim()) {
    db.run(`DELETE FROM settings WHERE key = 'announcement'`, (err) => {
      if (err) return res.status(500).json({ error: '删除通告失败' });
      res.json({ success: true, message: '通告已删除' });
    });
    return;
  }
  
  const data = JSON.stringify({
    content: content.trim()
  });
  
  // 使用北京时间
  const updatedAt = getBeijingTime(new Date().toISOString());
  
  db.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('announcement', ?, ?)`,
    [data, updatedAt],
    (err) => {
      if (err) return res.status(500).json({ error: '保存通告失败' });
      res.json({ success: true, message: '通告已保存' });
    }
  );
});

// ============= 银行卡管理 API =============

app.get('/api/bank-cards', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  db.all(`SELECT * FROM bank_cards WHERE user_id = ? ORDER BY is_default DESC, id DESC`, [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json({ cards: rows || [] });
  });
});

app.post('/api/bank-cards', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const { bankName, cardNumber, cardHolder, isDefault } = req.body;
  if (!bankName || !cardNumber || !cardHolder) {
    return res.status(400).json({ error: '请填写完整银行卡信息' });
  }
  
  db.run(`INSERT INTO bank_cards (user_id, bank_name, card_number, card_holder, is_default) 
    VALUES (?, ?, ?, ?, ?)`, [req.session.userId, bankName, cardNumber, cardHolder, isDefault ? 1 : 0], function(err) {
    if (err) return res.status(500).json({ error: '保存失败' });
    res.json({ success: true, cardId: this.lastID });
  });
});

app.delete('/api/bank-cards/:id', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const cardId = req.params.id;
  db.run(`DELETE FROM bank_cards WHERE id = ? AND user_id = ?`, [cardId, req.session.userId], function(err) {
    if (err) return res.status(500).json({ error: '删除失败' });
    res.json({ success: true });
  });
});

app.put('/api/bank-cards/:id/default', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const cardId = req.params.id;
  db.run(`UPDATE bank_cards SET is_default = 0 WHERE user_id = ?`, [req.session.userId]);
  db.run(`UPDATE bank_cards SET is_default = 1 WHERE id = ? AND user_id = ?`, [cardId, req.session.userId], function(err) {
    if (err) return res.status(500).json({ error: '设置失败' });
    res.json({ success: true });
  });
});

// ============= 用户自助修改密码 API =============

// 把 db.run 包成 Promise，写入失败时能 reject，避免像原来那样"没接回调、
// 写失败也不知道"，同时用 this.changes 确认真的改到了这一行
function runUpdate(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this.changes);
    });
  });
}

app.post('/api/user/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  
  const { oldLoginPwd, newLoginPwd, oldPaymentPwd, newPaymentPwd } = req.body;
  
  const user = await new Promise((resolve) => {
    db.get(`SELECT password_hash, payment_password_hash FROM users WHERE uid = ?`, 
      [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!user) return res.status(404).json({ error: '用户不存在' });

  try {
    // 修改登录密码
    if (newLoginPwd) {
      const valid = await bcrypt.compare(oldLoginPwd, user.password_hash);
      if (!valid) return res.status(401).json({ error: '原登录密码错误' });

      const newHash = await bcrypt.hash(newLoginPwd, 10);
      const changes = await runUpdate(
        `UPDATE users SET password_hash = ? WHERE uid = ?`,
        [newHash, req.session.userId]
      );
      if (changes === 0) {
        console.error(`修改登录密码异常：UPDATE 未匹配到任何用户，uid=${req.session.userId}`);
        return res.status(500).json({ error: '密码修改失败，请稍后重试或联系客服' });
      }
    }

    // 修改支付密码
    if (newPaymentPwd) {
      if (!user.payment_password_hash) {
        return res.status(400).json({ error: '您还未设置支付密码，请前往"设置 → 支付密码"进行设置' });
      }
      const valid = await bcrypt.compare(oldPaymentPwd, user.payment_password_hash);
      if (!valid) return res.status(401).json({ error: '原支付密码错误' });

      const newHash = await bcrypt.hash(newPaymentPwd, 10);
      const changes = await runUpdate(
        `UPDATE users SET payment_password_hash = ? WHERE uid = ?`,
        [newHash, req.session.userId]
      );
      if (changes === 0) {
        console.error(`修改支付密码异常：UPDATE 未匹配到任何用户，uid=${req.session.userId}`);
        return res.status(500).json({ error: '支付密码修改失败，请稍后重试或联系客服' });
      }
    }

    res.json({ success: true, message: '密码修改成功' });
  } catch (err) {
    console.error('修改密码失败:', err);
    res.status(500).json({ error: '密码修改失败，请稍后重试' });
  }
});

// ========== 新增：设置/找回支付密码（APP内验证码方案）==========
// 不需要旧支付密码——无论是第一次设置，还是忘记了原密码，流程都一样：
// 先通过 POST /api/send-verification { type: 'payment_password' } 发验证码到注册邮箱，
// 用户在 APP 内输入验证码 + 新支付密码，验证通过即可直接覆盖设置。
app.post('/api/user/set-payment-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });

  const { newPaymentPassword, verificationCode } = req.body;

  if (!newPaymentPassword || !verificationCode) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  if (!/^\d{6}$/.test(newPaymentPassword)) {
    return res.status(400).json({ error: '支付密码必须为6位数字' });
  }

  const user = await new Promise((resolve) => {
    db.get(`SELECT uid, email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const verification = await new Promise((resolve) => {
    db.get(
      `SELECT id, code, expires_at, is_used, attempt_count
       FROM email_verifications
       WHERE email = ? AND type = 'payment_password' AND is_used = 0
       ORDER BY created_at DESC LIMIT 1`,
      [user.email],
      (err, row) => resolve(row)
    );
  });

  if (!verification) {
    return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
  }

  const now = new Date();
  const expiresAt = new Date(verification.expires_at);
  if (now > expiresAt) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }
  if (verification.attempt_count >= 5) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
  }
  if (verification.code !== verificationCode) {
    db.run(`UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`, [verification.id]);
    const remainingAttempts = 5 - (verification.attempt_count + 1);
    return res.status(400).json({ error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次` });
  }

  await new Promise((resolve) => {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id], () => resolve());
  });

  const newHash = await bcrypt.hash(newPaymentPassword, 10);
  await new Promise((resolve, reject) => {
    db.run(`UPDATE users SET payment_password_hash = ? WHERE uid = ?`, [newHash, user.uid], (err) => (err ? reject(err) : resolve()));
  });

  res.json({ success: true, message: '支付密码设置成功' });
});

// ========== 新增：修改邮箱（校验验证码后生效，用户所有数据不变，仅邮箱变更） ==========
app.post('/api/user/change-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });

  const { newEmail, verificationCode } = req.body;

  if (!newEmail || !verificationCode) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }

  const currentUserRow = await new Promise((resolve) => {
    db.get(`SELECT email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
  });
  if (!currentUserRow) return res.status(404).json({ error: '用户不存在' });
  if (currentUserRow.email === newEmail) {
    return res.status(400).json({ error: '新邮箱不能与当前邮箱相同' });
  }

  // 再次确认新邮箱未被占用（防止发送验证码后邮箱被其他账号抢注）
  const existingUser = await new Promise((resolve) => {
    db.get(`SELECT uid FROM users WHERE email = ?`, [newEmail], (err, row) => resolve(row));
  });
  if (existingUser) {
    return res.status(400).json({ error: '该邮箱已被其他账号使用', code: 'EMAIL_REGISTERED' });
  }

  // 校验验证码
  const verification = await new Promise((resolve) => {
    db.get(
      `SELECT id, code, expires_at, is_used, attempt_count 
       FROM email_verifications 
       WHERE email = ? AND type = 'change_email' AND is_used = 0 
       ORDER BY created_at DESC LIMIT 1`,
      [newEmail],
      (err, row) => resolve(row)
    );
  });

  if (!verification) {
    return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
  }

  const now = new Date();
  const expiresAt = new Date(verification.expires_at);
  if (now > expiresAt) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }

  if (verification.attempt_count >= 5) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
  }

  if (verification.code !== verificationCode) {
    db.run(
      `UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`,
      [verification.id]
    );
    const remainingAttempts = 5 - (verification.attempt_count + 1);
    return res.status(400).json({ 
      error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次`
    });
  }

  // 验证码正确，标记已使用
  db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);

  // 仅更新邮箱，用户其余数据（资产、钱包、KYC、卡片等）保持不变
  await new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET email = ? WHERE uid = ?`,
      [newEmail, req.session.userId],
      function(err) {
        if (err) { reject(err); return; }
        resolve();
      }
    );
  }).catch((err) => {
    console.error('修改邮箱失败:', err);
    return res.status(500).json({ error: '修改失败，请稍后重试' });
  });

  if (res.headersSent) return;

  // 同步更新关联表中的邮箱冗余字段，保持数据一致（不影响其余业务数据）
  db.run(`UPDATE support_conversations SET user_email = ? WHERE user_id = ?`, [newEmail, req.session.userId]);
  db.run(`UPDATE support_messages SET user_email = ? WHERE user_id = ?`, [newEmail, req.session.userId]);

  console.log(`用户 ${req.session.userId} 已将邮箱由 ${currentUserRow.email} 修改为 ${newEmail}`);

  // 邮箱是登录凭证之一，修改后强制退出登录，要求用户以新邮箱重新登录
  req.session.destroy();

  res.json({ 
    success: true, 
    message: '邮箱修改成功，请以新邮箱重新登录'
  });
});
// ========== 新增结束 ==========

// ========== 新增：用户自助注销账户 ==========
// 设计取舍：做软删除而不是像 /api/admin/user/delete 那样物理删除数据——
// 1) 平台走的是 KYC/持牌通道，交易流水通常有合规留存要求，不宜随注销直接抹掉；
// 2) 卡片、KYC 记录都在 PokePay 那一侧，本地物理删除也删不掉，容易造成两边数据对不上。
// 注销后：账户被标记为 deleted、禁止再登录、当前 session 立即失效；
// 邮箱/资料仍保留在库里但不可再用于登录，如需彻底抹除个人数据，走人工客服处理。
app.post('/api/user/delete-account', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const userId = req.session.userId;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: '请输入登录密码以确认注销' });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        `SELECT uid, email, password_hash, account_status, hkd_balance, vusdt_balance,
                pokepay_card_id, card_bind_status
         FROM users WHERE uid = ?`,
        [userId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.account_status === 'deleted') {
      return res.status(400).json({ error: '账户已注销' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '密码错误' });

    // 余额必须清零才允许注销，避免账户资产无人可查、无法追溯
    if ((user.hkd_balance || 0) > 0.01 || (user.vusdt_balance || 0) > 0.01) {
      return res.status(400).json({ error: '账户内仍有余额，请先提现或转出后再注销' });
    }

    // 已绑定 Poke 卡的，需再核对卡片余额（卡内资金不在本地 hkd_balance/vusdt_balance 里）
    if (user.pokepay_card_id) {
      let cardDetail;
      try {
        cardDetail = await kycService.getCardDetail(user.pokepay_card_id);
      } catch (err) {
        console.error('注销前查询卡片余额失败:', err.message);
        return res.status(500).json({ error: '卡片信息查询失败，请稍后重试' });
      }
      if (parseFloat(cardDetail.balance) > 0.01) {
        return res.status(400).json({ error: '您绑定的卡片仍有余额，请先提现后再注销' });
      }
    }

    // 用一段随机字符串顶替密码哈希，而不是置空，避免任何遗漏的登录路径对 null 做 bcrypt.compare 时报错
    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET account_status = 'deleted', deleted_at = CURRENT_TIMESTAMP,
         password_hash = ?, payment_password_hash = NULL WHERE uid = ?`,
        [randomHash, userId],
        (err) => (err ? reject(err) : resolve())
      );
    });

    console.log(`🗑️ 用户自助注销账户: ${user.email} (${userId})`);

    req.session.destroy(() => {
      res.json({ success: true, message: '账户已注销' });
    });
  } catch (error) {
    console.error('用户自助注销账户失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});
// ========== 新增结束 ==========

// ============= 管理后台 API =============

app.get('/api/admin/check-session', (req, res) => {
  if (req.session.isAdmin && req.session.adminId) {
    res.json({ 
        loggedIn: true, 
        username: req.session.adminUsername,
        role: req.session.adminRole || 'admin',
        id: req.session.adminId  // ← 添加这一行
    });
  } else {
    res.json({ loggedIn: false });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM admins WHERE username = ?`, [username], async (err, admin) => {
    if (err || !admin) return res.status(401).json({ error: '用户名或密码错误' });
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '用户名或密码错误' });
    req.session.isAdmin = true;
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    req.session.adminRole = admin.role || 'admin';
    res.json({ message: '登录成功', username: admin.username, role: admin.role || 'admin' });
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: '已退出' });
});

app.post('/api/admin/change-password', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });
  
  db.get(`SELECT password_hash FROM admins WHERE id = ?`, [req.session.adminId], async (err, admin) => {
    if (err || !admin) return res.status(404).json({ error: '管理员不存在' });
    const valid = await bcrypt.compare(oldPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '原密码错误' });
    const newHash = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE admins SET password_hash = ? WHERE id = ?`, [newHash, req.session.adminId], (err) => {
      if (err) return res.status(500).json({ error: '修改失败' });
      res.json({ message: '密码修改成功' });
    });
  });
});

app.get('/api/admin/stats', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT COUNT(*) as totalUsers FROM users`, [], (err, userCount) => {
    db.get(`SELECT COUNT(*) as totalWallets FROM wallets`, [], (err, walletCount) => {
      db.get(`SELECT SUM(reward_balance) as totalReward FROM users`, [], (err, rewardSum) => {
        db.get(`SELECT SUM(hkd_balance) as totalHKD FROM users`, [], (err, hkdSum) => {
          db.get(`SELECT SUM(vusdt_balance) as totalVUSDT FROM users`, [], (err, vusdtSum) => {
            db.get(`SELECT balance FROM vusdt_pool WHERE id = 1`, [], (err, poolRow) => {
              res.json({ 
                totalUsers: userCount?.totalUsers || 0, 
                totalWallets: walletCount?.totalWallets || 0, 
                totalReward: rewardSum?.totalReward || 0,
                totalHKD: hkdSum?.totalHKD || 0,
                totalVUSDT: vusdtSum?.totalVUSDT || 0,
                poolVUSDT: poolRow?.balance || 0
              });
            });
          });
        });
      });
    });
  });
});

// ========== 新增：轻量级用户查询（不查链上余额，供批量操作脚本使用） ==========
// 用途：比如"KYC已通过 + 已绑卡 + HKD余额为0"这类批量筛选，配合 /api/admin/batch-add-vhkd 使用。
// 跟 /api/admin/users 不一样，这个接口只查数据库，不会对每个用户发起链上余额查询，速度快很多。
app.get('/api/admin/users/quick-query', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    const { kycStatus, cardBindStatus, hkdBalance } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (kycStatus === 'verified') {
        whereClause += ` AND kyc_status = 'verified'`;
    } else if (kycStatus === 'pending') {
        whereClause += ` AND (kyc_status = 'pending' OR kyc_status IS NULL)`;
    } else if (kycStatus === 'rejected') {
        whereClause += ` AND kyc_status = 'rejected'`;
    }

    if (cardBindStatus === 'bound') {
        whereClause += ` AND pokepay_card_id IS NOT NULL`;
    } else if (cardBindStatus === 'unbound') {
        whereClause += ` AND pokepay_card_id IS NULL`;
    }

    if (hkdBalance !== undefined && hkdBalance !== '') {
        const val = parseFloat(hkdBalance);
        if (!isNaN(val)) {
            whereClause += ` AND hkd_balance = ?`;
            params.push(val);
        }
    }

    const sql = `SELECT uid, email, hkd_balance, kyc_status, pokepay_card_id, card_bind_status FROM users ${whereClause} ORDER BY created_at DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('quick-query 查询失败:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, users: rows || [], count: (rows || []).length });
    });
});

app.get('/api/admin/users', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  
  const { search, inviteStatus, walletStatus, kycStatus, cardBindStatus, cardIdSort, page = 1, limit = 10 } = req.query;
  const currentPage = parseInt(page);
  const pageSize = parseInt(limit);
  const offset = (currentPage - 1) * pageSize;
  
  // 构建查询条件
  let whereClause = 'WHERE 1=1';
  const params = [];

  // ========== 新增：KYC 状态筛选 ==========
  if (kycStatus === 'pending') {
    whereClause += ` AND (u.kyc_status = 'pending' OR u.kyc_status IS NULL)`;
  } else if (kycStatus === 'verified') {
    whereClause += ` AND u.kyc_status = 'verified'`;
  } else if (kycStatus === 'rejected') {
    whereClause += ` AND u.kyc_status = 'rejected'`;
  } else if (kycStatus === 'none') {
    whereClause += ` AND u.kyc_status IS NULL`;
  } else if (kycStatus === 'needs_review') {
    whereClause += ` AND u.card_bind_status = 'needs_review'`;
  }
  // ========== KYC 筛选结束 ==========

  // ========== 新增：绑卡状态筛选（用 pokepay_card_id 判断，覆盖手动关联和自动绑定两种情况）==========
  if (cardBindStatus === 'bound') {
    whereClause += ` AND u.pokepay_card_id IS NOT NULL`;
  } else if (cardBindStatus === 'unbound') {
    whereClause += ` AND u.pokepay_card_id IS NULL`;
  }
  // ========== 绑卡筛选结束 ==========
  
  if (search) {
    whereClause += ` AND u.email LIKE ?`;
    params.push(`%${search}%`);
  }
  if (inviteStatus === 'has') {
    whereClause += ` AND u.invite_code IS NOT NULL`;
  }
  if (inviteStatus === 'none') {
    whereClause += ` AND u.invite_code IS NULL`;
  }
  if (walletStatus === 'has') {
    whereClause += ` AND w.address IS NOT NULL`;
  }
  if (walletStatus === 'none') {
    whereClause += ` AND w.address IS NULL`;
  }
  
  // 查询总记录数
  const countSql = `SELECT COUNT(*) as total FROM users u LEFT JOIN wallets w ON u.uid = w.user_id ${whereClause}`;
  const totalResult = await new Promise((resolve) => {
    db.get(countSql, params, (err, row) => resolve(row || { total: 0 }));
  });
  const total = totalResult.total;
  const totalPages = Math.ceil(total / pageSize);
  
  // ========== 新增：按"卡片ID"顺序号排序（在原有按注册时间排序的基础上新增一个可选排序方式）==========
  // pokepay_card_id 是 INTEGER 类型，直接排序就是数值顺序，不会有字符串排序"10排在2前面"的问题。
  // 未绑卡用户的 pokepay_card_id 是 NULL，SQLite 里 NULL 天然排在最前（ASC）/最后（DESC），不用额外处理。
  // 加一个 u.uid 作为并列时的兜底排序键——避免"卡片ID同为NULL/相同"的一批用户在翻页之间因为顺序不稳定
  // 而出现同一个用户在两页之间重复出现或被跳过的情况，跟原来只按 created_at 排序时是一样的稳定性保证。
  let orderByClause = 'ORDER BY u.created_at DESC';
  if (cardIdSort === 'asc') {
    orderByClause = 'ORDER BY u.pokepay_card_id ASC, u.uid ASC';
  } else if (cardIdSort === 'desc') {
    orderByClause = 'ORDER BY u.pokepay_card_id DESC, u.uid ASC';
  }
  // ========== 新增结束 ==========

  // 分页查询用户（只查当前页）
  const sql = `
    SELECT u.uid, u.email, u.invite_code, u.reward_balance, u.hkd_balance, u.vusdt_balance, 
           u.kyc_status, u.pokepay_card_id, u.wallet_frozen, u.created_at, 
           u.card_display_name, u.card_bind_status, u.pending_card_last4,
           w.address, w.private_key
    FROM users u 
    LEFT JOIN wallets w ON u.uid = w.user_id 
    ${whereClause}
    ${orderByClause}
    LIMIT ? OFFSET ?
  `;
  
  const users = await new Promise((resolve) => {
    db.all(sql, [...params, pageSize, offset], (err, rows) => resolve(rows || []));
  });
  
  // ========== 串行查询当前页用户的余额（一个接一个，间隔500ms） ==========
  for (const user of users) {
    if (user.address) {
      // 每个查询间隔 500ms，避免 429
      await new Promise(resolve => setTimeout(resolve, 500));
      
      try {
        // 查询 TRX 余额
        const trxBalance = await tronWeb.trx.getBalance(user.address);
        user.trx_balance = (trxBalance / 1e6).toFixed(2);
        
        // 查询 USDT 余额
        let chainUsdt = 0;
        try {
          const url = `${FULL_HOST}/v1/accounts/${user.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
          const response = await fetch(url, {
            headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
          });
          const data = await response.json();
          if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
            chainUsdt = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
          }
        } catch(e) {}
        user.chain_usdt = chainUsdt.toFixed(2);
        user.total_usdt = (chainUsdt + (user.vusdt_balance || 0)).toFixed(2);
        
      } catch(e) {
        console.error(`查询用户 ${user.email} 余额失败:`, e.message);
        user.trx_balance = '0.00';
        user.chain_usdt = '0.00';
        user.total_usdt = (user.vusdt_balance || 0).toFixed(2);
      }
    } else {
      user.trx_balance = '0.00';
      user.chain_usdt = '0.00';
      user.total_usdt = (user.vusdt_balance || 0).toFixed(2);
    }
    user.created_at_beijing = getBeijingTime(user.created_at);
  }
  
  res.json({ 
    users, 
    pagination: {
      page: currentPage,
      limit: pageSize,
      total,
      totalPages,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages
    }
  });
});

app.post('/api/admin/user/generate-invite-code', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: '用户ID不能为空' });
  
  let inviteCode = await generateInviteCode();
  
  const checkAndSet = async () => {
    const existing = await new Promise((resolve) => {
      db.get(`SELECT uid FROM users WHERE invite_code = ?`, [inviteCode], (err, row) => resolve(row));
    });
    if (existing) {
      inviteCode = await generateInviteCode();
      await checkAndSet();
    } else {
      db.run(`UPDATE users SET invite_code = ? WHERE uid = ?`, [inviteCode, userId], (err) => {
        if (err) return res.status(500).json({ error: '生成失败' });
        res.json({ success: true, inviteCode });
      });
    }
  };
  
  await checkAndSet();
});

// 管理员更新用户 KYC 状态
app.post('/api/admin/user/update-kyc', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { userId, kycStatus } = req.body;
  
  if (!userId || !kycStatus) {
    return res.status(400).json({ error: '参数错误' });
  }
  
  if (!['pending', 'verified', 'rejected'].includes(kycStatus)) {
    return res.status(400).json({ error: '无效的状态值' });
  }
  
  db.run(`UPDATE users SET kyc_status = ? WHERE uid = ?`, [kycStatus, userId], function(err) {
    if (err) {
      console.error('更新 KYC 状态失败:', err);
      return res.status(500).json({ error: '更新失败: ' + err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    console.log(`管理员 ${req.session.adminUsername} 将用户 ${userId} 的 KYC 状态更新为 ${kycStatus}`);
    
    res.json({ 
      success: true, 
      message: `KYC 状态已更新为 ${kycStatus === 'verified' ? '已认证' : (kycStatus === 'rejected' ? '已拒绝' : '待认证')}` 
    });
  });
});

// 冻结/解冻用户钱包
app.post('/api/admin/user/toggle-frozen', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId, adminPassword } = req.body;
    if (!userId || !adminPassword) return res.status(400).json({ error: '参数错误' });
    
    const admin = await new Promise((resolve) => {
        db.get(`SELECT password_hash FROM admins WHERE id = ?`, [req.session.adminId], (err, row) => resolve(row));
    });
    if (!admin) return res.status(401).json({ error: '管理员不存在' });
    
    const valid = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '管理员密码错误' });
    
    const user = await new Promise((resolve) => {
        db.get(`SELECT wallet_frozen FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
    });
    
    const newStatus = user?.wallet_frozen === 1 ? 0 : 1;
    const statusText = newStatus === 1 ? '冻结' : '解冻';
    
    db.run(`UPDATE users SET wallet_frozen = ? WHERE uid = ?`, [newStatus, userId], (err) => {
        if (err) return res.status(500).json({ error: '操作失败' });
        res.json({ success: true, message: `钱包已${statusText}`, frozen: newStatus === 1 });
    });
});

// 获取用户冻结状态
app.get('/api/user/wallet-status', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    db.get(`SELECT wallet_frozen FROM users WHERE uid = ?`, [req.session.userId], (err, row) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        res.json({ frozen: row?.wallet_frozen === 1 });
    });
});

// ============= 手续费配置 API =============

// 获取用户手续费配置
app.get('/api/user-fee-config', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    let targetUserId = req.session.userId;
    if (req.query.userId && req.session.isAdmin) {
        targetUserId = req.query.userId;
    }
    
    const config = await getUserFeeConfig(targetUserId);
    const rate = await getUSDTtoHKD();  // 获取实时汇率
    
    res.json({ 
        success: true, 
        fee: config.fixedFee,
        rate: rate  // 返回汇率
    });
});

// 管理员获取指定用户配置
app.get('/api/admin/user-fee-config', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    
    const config = await getUserFeeConfig(userId);
    res.json({ success: true, fixedFee: config.fixedFee });
});

// 管理员修改用户手续费配置
app.post('/api/admin/user-fee-config', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId, fixedFee, adminPassword } = req.body;
    
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    if (fixedFee === undefined) {  // 只检查 fixedFee
        return res.status(400).json({ error: '缺少手续费参数' });
    }
    if (fixedFee <= 0) {  // 改为大于0
        return res.status(400).json({ error: '手续费不能为负数' });
    }
    
    const admin = await new Promise((resolve) => {
        db.get(`SELECT password_hash, username FROM admins WHERE id = ?`, [req.session.adminId], (err, row) => resolve(row));
    });
    if (!admin) return res.status(401).json({ error: '管理员不存在' });
    
    const valid = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '管理员密码错误' });
    
    db.run(`INSERT INTO user_fee_config (user_id, fixed_fee, updated_by, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
            fixed_fee = excluded.fixed_fee,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, fixedFee, admin.username], (err) => {
            if (err) {
                console.error('保存手续费配置失败:', err);
                return res.status(500).json({ error: '保存失败' });
            }
            res.json({ success: true, message: '手续费配置已更新' });
        });
});

// ============= 异常订单 API =============

// 获取异常订单列表
app.get('/api/admin/abnormal-orders', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status || 'pending';
    const search = req.query.search || '';
    const days = parseInt(req.query.days) || 0;
    
    let sql = `SELECT o.*, u.email 
               FROM abnormal_orders o
               LEFT JOIN users u ON o.user_id = u.uid
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM abnormal_orders o WHERE 1=1`;
    const params = [];
    const countParams = [];
    
    if (status !== 'all') {
        sql += ` AND o.status = ?`;
        countSql += ` AND status = ?`;
        params.push(status);
        countParams.push(status);
    }
    
    if (search) {
        sql += ` AND (u.email LIKE ? OR o.user_id LIKE ?)`;
        countSql += ` AND (u.email LIKE ? OR o.user_id LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
        countParams.push(`%${search}%`, `%${search}%`);
    }
    
    if (days > 0) {
        sql += ` AND o.created_at >= datetime('now', '-' || ? || ' days')`;
        countSql += ` AND o.created_at >= datetime('now', '-' || ? || ' days')`;
        params.push(days);
        countParams.push(days);
    }
    
    sql += ` ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    
    const total = await new Promise((resolve) => {
        db.get(countSql, countParams, (err, row) => {
            resolve(row ? row.total : 0);
        });
    });
    
    // 查询订单列表
    const orders = await new Promise((resolve) => {
        db.all(sql, params, (err, rows) => {
            resolve(rows || []);
        });
    });
    
    // 转换时间为北京时间
    const convertedOrders = orders.map(order => ({
        ...order,
        created_at: order.created_at ? getBeijingTime(order.created_at) : null,
        resolved_at: order.resolved_at ? getBeijingTime(order.resolved_at) : null
    }));
    
    res.json({
        success: true,
        data: {
            orders: convertedOrders,
            total,
            page,
            totalPages: Math.ceil(total / limit)
        }
    });
});

// 管理员帮用户提币（解决异常订单）
app.post('/api/admin/resolve-abnormal-order', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { orderId, adminPassword } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });
    
    // 验证管理员密码
    const admin = await new Promise((resolve) => {
        db.get(`SELECT password_hash, username FROM admins WHERE id = ?`, [req.session.adminId], (err, row) => resolve(row));
    });
    if (!admin) return res.status(401).json({ error: '管理员不存在' });
    
    const valid = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '管理员密码错误' });
    
    // 获取异常订单
    const order = await new Promise((resolve) => {
        db.get(`SELECT * FROM abnormal_orders WHERE id = ? AND status = 'pending'`, [orderId], (err, row) => resolve(row));
    });
    if (!order) {
        return res.status(404).json({ error: '订单不存在或已处理' });
    }
    
    // 获取用户钱包
    const wallet = await new Promise((resolve) => {
        db.get(`SELECT address, private_key FROM wallets WHERE user_id = ?`, [order.user_id], (err, row) => resolve(row));
    });
    if (!wallet) {
        return res.status(400).json({ error: '用户没有钱包' });
    }
    
    // 检查用户 USDT 余额
    let chainUsdt = 0;
    try {
        const url = `${FULL_HOST}/v1/accounts/${wallet.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
        const response = await fetch(url, {
            headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
        });
        const data = await response.json();
        if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
            chainUsdt = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
        }
    } catch(e) {
        return res.status(500).json({ error: '查询 USDT 余额失败' });
    }
    
    if (chainUsdt < order.usdt_amount) {
        return res.status(400).json({ error: `用户 USDT 余额不足，当前 ${chainUsdt.toFixed(2)} USDT` });
    }
    
    let transferResult = null;
    const energyValid = isEnergyValid(order.created_at);

    // 判断是否需要购买能量（仅主网需要）
    if (NETWORK === 'mainnet') {
        const energyValid = isEnergyValid(order.created_at);
        
        if (!energyValid || !order.energy_purchased) {
            const balanceCheck = await checkTronZapBalance();
            if (!balanceCheck.sufficient) {
                return res.status(503).json({ error: `能量服务余额不足，当前余额: ${balanceCheck.balance} TRX` });
            }
            try {
                await energyProvider.buyEnergy(wallet.address, 65000, 1);
                console.log(`能量购买成功，等待 10 秒...`);
                await new Promise(r => setTimeout(r, 10000));
            } catch (energyError) {
                return res.status(500).json({ error: `能量租赁失败: ${energyError.message}` });
            }
        }
    } else {
        console.log(`测试网环境，跳过能量租赁`);
    }
    
    // 转账 USDT（带重试）
    transferResult = await transferUsdtWithRetry(
        wallet.private_key,
        order.to_address,
        order.usdt_amount,
        3
    );
    
    if (!transferResult.success) {
        return res.status(500).json({ 
            error: `USDT 转账失败，已重试 ${transferResult.attempt} 次。请稍后再次尝试。`
        });
    }
    
    // 更新订单状态
    db.run(`UPDATE abnormal_orders 
            SET status = 'resolved', 
                resolved_at = CURRENT_TIMESTAMP,
                resolved_by = ?,
                txid = ?
            WHERE id = ?`,
        [admin.username, transferResult.txid, orderId]);
    
    // 记录成功日志
    await recordWithdrawLog(order.user_id, order.usdt_amount, order.trx_fee, order.to_address, transferResult.txid, 'resolved_by_admin');
    
    res.json({ 
        success: true, 
        message: `提币成功！TxID: ${transferResult.txid}`,
        txid: transferResult.txid
    });
});

// ============= 管理员重置用户密码（登录密码 + 支付密码 = 888888） =============
app.post('/api/admin/reset-user-password', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '用户ID不能为空' });
  }
  
  // 检查用户是否存在
  const user = await new Promise((resolve) => {
    db.get(`SELECT uid, email FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
  });
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  
  // 固定密码：888888
  const DEFAULT_PASSWORD = '888888';
  const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const hashedPaymentPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  
  // 更新登录密码
  db.run(`UPDATE users SET password_hash = ? WHERE uid = ?`, [hashedPassword, userId], (err) => {
    if (err) {
      console.error('重置登录密码失败:', err);
      return res.status(500).json({ error: '重置登录密码失败' });
    }
  });
  
  // 更新支付密码
  db.run(`UPDATE users SET payment_password_hash = ? WHERE uid = ?`, [hashedPaymentPassword, userId], (err) => {
    if (err) {
      console.error('重置支付密码失败:', err);
      return res.status(500).json({ error: '重置支付密码失败' });
    }
  });
  
  console.log(`管理员 ${req.session.adminUsername} 重置了用户 ${user.email} 的登录密码和支付密码为 888888`);
  
  res.json({ 
    success: true, 
    message: '登录密码和支付密码已重置为 888888'
  });
});

app.post('/api/admin/user/associate-card', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { userId, pokepayCardId } = req.body;
  if (!userId || !pokepayCardId) return res.status(400).json({ error: '参数错误' });

  let cardInfo = null;
  let memberName = '';
  let cardNumber = '';
  try {
    cardInfo = await cardService.getCardDetail(pokepayCardId);
    if (cardInfo && cardInfo.success) {
      memberName = cardInfo.memberName;
      cardNumber = cardInfo.cardNo;
    }
  } catch (error) {
    console.error('获取卡片信息失败:', error);
  }

  db.run(`UPDATE users SET pokepay_card_id = ? WHERE uid = ?`, [pokepayCardId, userId], function(err) {
    if (err) return res.status(500).json({ error: '关联失败' });
    res.json({ 
      success: true, 
      message: '关联成功',
      cardInfo: cardInfo ? { memberName, cardNumber } : null
    });
  });
});

// ============= 修改用户卡片显示姓名：共用校验/更新逻辑（网页后台 + Telegram /rename 共用，逻辑保持一致） =============
function applyCardDisplayNameUpdate(userId, displayName) {
  return new Promise((resolve) => {
    // 姓名验证（和原来网页后台的校验规则完全一致）
    let finalName = null;
    if (displayName && displayName.trim()) {
      const cleaned = displayName.trim();
      if (cleaned.length > 50) {
        return resolve({ success: false, error: '姓名不能超过50个字符' });
      }
      // 允许中英文、数字、空格、点、连字符
      if (!/^[\u4e00-\u9fa5a-zA-Z0-9\s\.\-]+$/.test(cleaned)) {
        return resolve({ success: false, error: '姓名包含非法字符，仅支持中英文、数字、空格、点、连字符' });
      }
      finalName = cleaned;
    }

    db.get(`SELECT uid, email FROM users WHERE uid = ?`, [userId], (err, user) => {
      if (err || !user) {
        return resolve({ success: false, error: '用户不存在' });
      }
      db.run(`UPDATE users SET card_display_name = ? WHERE uid = ?`, [finalName, userId], function (err) {
        if (err) {
          console.error('更新卡片姓名失败:', err);
          return resolve({ success: false, error: '更新失败' });
        }
        resolve({
          success: true,
          message: finalName ? `姓名已修改为：${finalName}` : '已恢复使用原始姓名',
          displayName: finalName,
          email: user.email
        });
      });
    });
  });
}

// ============= 管理员修改用户卡片显示姓名 =============
app.post('/api/admin/user/update-card-name', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  
  const { userId, displayName } = req.body;
  if (!userId) return res.status(400).json({ error: '缺少用户ID' });

  const result = await applyCardDisplayNameUpdate(userId, displayName);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  console.log(`管理员 ${req.session.adminUsername} 修改了用户 ${result.email} 的卡片姓名: ${result.displayName || '恢复原始值'}`);

  res.json({
    success: true,
    message: result.message,
    displayName: result.displayName
  });
});

app.get('/api/admin/card/info/:cardId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { cardId } = req.params;
  if (!cardId) return res.status(400).json({ error: '卡片ID不能为空' });
  
  try {
    const cardInfo = await cardService.getCardDetail(cardId);
    res.json(cardInfo);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/card/withdraw-requests', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  
  db.all(`SELECT w.*, u.email, u.pokepay_card_id FROM card_withdraw_requests w 
          LEFT JOIN users u ON w.user_id = u.uid 
          ORDER BY w.created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    
    const processRows = async () => {
      for (const row of rows) {
        if (row.pokepay_card_id) {
          try {
            const cardInfo = await cardService.getCardDetail(row.pokepay_card_id);
            row.card_last4 = cardInfo.cardNo ? cardInfo.cardNo.slice(-4) : '';
          } catch(e) {
            row.card_last4 = '';
          }
        } else {
          row.card_last4 = '';
        }
        row.created_at = getBeijingTime(row.created_at);
        row.processed_at = row.processed_at ? getBeijingTime(row.processed_at) : null;
      }
      res.json({ records: rows });
    };
    processRows();
  });
});

app.post('/api/admin/card/withdraw/confirm', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: '参数错误' });
  
  db.get(`SELECT user_id, amount FROM card_withdraw_requests WHERE id = ? AND status = 'pending'`, 
    [requestId], (err, request) => {
      if (err || !request) return res.status(404).json({ error: '申请不存在或已处理' });
      
      db.run(`UPDATE users SET hkd_balance = hkd_balance - ? WHERE uid = ?`, 
        [request.amount, request.user_id], (updateErr) => {
          if (updateErr) return res.status(500).json({ error: '扣款失败' });

          // ========== 记录流水（from_address 存 user_id） ==========
          const withdrawAmount = -Math.abs(request.amount);
          db.run(
            `INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [request.user_id, request.user_id, 'PokePay卡', withdrawAmount, 'HKD', `withdraw_card_${Date.now()}`, 'confirmed']
          );
          // ========== 新增结束 ==========
          
          db.run(`UPDATE card_withdraw_requests SET status = 'completed', processed_at = CURRENT_TIMESTAMP WHERE id = ?`, 
            [requestId], (finalErr) => {
              if (finalErr) return res.status(500).json({ error: '状态更新失败' });
              res.json({ success: true, message: '已确认到账，用户余额已扣除' });
            });
        });
    });
});

app.post('/api/admin/card/withdraw/reject', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: '参数错误' });
  
  db.run(`UPDATE card_withdraw_requests SET status = 'rejected', processed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, 
    [requestId], function(err) {
      if (err) return res.status(500).json({ error: '操作失败' });
      res.json({ success: true });
    });
});

app.get('/api/admin/settings', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT value FROM settings WHERE key = 'collect_address'`, [], (err, row) => {
    res.json({ collectAddress: row ? row.value : '' });
  });
});

app.post('/api/admin/settings', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { collectAddress } = req.body;
  if (!collectAddress) return res.status(400).json({ error: '归集地址不能为空' });
  if (!collectAddress.match(/^T[0-9a-zA-Z]{33}$/)) {
    return res.status(400).json({ error: '请输入有效的TRON地址' });
  }
  db.run(`UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'collect_address'`, [collectAddress], function(err) {
    if (err) return res.status(500).json({ error: '保存失败: ' + err.message });
    res.json({ success: true, message: '设置已保存', currentAddress: collectAddress });
  });
});

app.get('/api/admin/rate/settings', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.get(`SELECT value FROM settings WHERE key = 'backup_rate'`, [], (err, row) => {
    res.json({ backupRate: row ? parseFloat(row.value) : 7.8 });
  });
});

app.post('/api/admin/rate/settings', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { backupRate } = req.body;
  db.run(`UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'backup_rate'`, [backupRate], function(err) {
    if (err) return res.status(500).json({ error: '保存失败' });
    res.json({ success: true });
  });
});

app.get('/api/admin/withdraw-fiat', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.all(`SELECT w.*, u.email, b.bank_name, b.card_number, b.card_holder 
    FROM withdraw_fiat_records w
    LEFT JOIN users u ON w.user_id = u.uid
    LEFT JOIN bank_cards b ON w.bank_card_id = b.id
    ORDER BY w.created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    const formatted = (rows || []).map(r => ({
      ...r,
      created_at: getBeijingTime(r.created_at),
      processed_at: r.processed_at ? getBeijingTime(r.processed_at) : null
    }));
    res.json({ records: formatted });
  });
});

app.post('/api/admin/withdraw-fiat/:id/complete', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const id = req.params.id;
  db.run(`UPDATE withdraw_fiat_records SET status = 'completed', processed_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: '操作失败' });
    res.json({ success: true });
  });
});

app.post('/api/admin/withdraw-fiat/:id/reject', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const id = req.params.id;
  db.get(`SELECT user_id, amount FROM withdraw_fiat_records WHERE id = ?`, [id], (err, record) => {
    if (err || !record) return res.status(404).json({ error: '记录不存在' });
    db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [record.amount, record.user_id]);
    db.run(`UPDATE withdraw_fiat_records SET status = 'rejected', processed_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: '操作失败' });
      res.json({ success: true });
    });
  });
});

app.post('/api/admin/create-user', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
  
  const uid = await generateUniqueUid();
  const hashedPassword = await bcrypt.hash(password, 10);
  const newInviteCode = generateInviteCode();
  
  db.run(`INSERT INTO users (uid, email, password_hash, invite_code, kyc_status) VALUES (?, ?, ?, ?, 'pending')`, 
    [uid, email, hashedPassword, newInviteCode], function(err) {
      if (err) return res.status(400).json({ error: '邮箱已注册' });
      res.json({ success: true, message: '用户创建成功', uid: uid, inviteCode: newInviteCode });
    });
});

// ============= TronZap 管理后台接口 =============

app.get('/api/admin/tronzap/balance', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  try {
    const balance = await energyProvider.getBalance();
    const minBalance = 5;
    res.json({ 
      success: true, 
      balance: balance,
      sufficient: balance >= minBalance,
      minBalance: minBalance
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/tronzap/recharge-address', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  try {
    const customAddress = process.env.TRONZAP_RECHARGE_ADDRESS;
    if (customAddress) {
      return res.json({ success: true, address: customAddress });
    }
    const address = await energyProvider.getRechargeAddress();
    res.json({ success: true, address: address });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/collect-tasks', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  db.all(`SELECT * FROM collect_tasks ORDER BY id DESC LIMIT 20`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    const formatted = (rows || []).map(r => ({
      ...r,
      started_at: r.started_at ? getBeijingTime(r.started_at) : null,
      completed_at: r.completed_at ? getBeijingTime(r.completed_at) : null
    }));
    res.json({ tasks: formatted });
  });
});

// ============= 归集功能 API =============

async function getCollectAddress() {
  return new Promise((resolve) => {
    db.get(`SELECT value FROM settings WHERE key = 'collect_address'`, [], (err, row) => {
      if (err || !row || !row.value) resolve(null);
      else resolve(row.value);
    });
  });
}

// 单用户归集核心函数
async function collectSingleUser(userId, wallet, collectAddress, retryCount = 0) {
  const maxRetries = 2;
  const results = { success: false, trx: false, usdt: false, trxAmount: 0, usdtAmount: 0, error: null };
  
  try {
    const userTronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: wallet.private_key });
    
    // ========== 1. 查询 USDT 余额（带 429 重试） ==========
    let usdtBalance = 0;
    let usdtRetryCount = 0;
    const maxUsdtRetries = 3;

    while (usdtRetryCount < maxUsdtRetries) {
      try {
        const url = `${FULL_HOST}/v1/accounts/${wallet.address}/trc20/balance?contract_address=${USDT_CONTRACT}`;
        const response = await fetch(url, {
          headers: TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {}
        });
        
        if (response.status === 429) {
          const waitTime = 5000 * (usdtRetryCount + 1);
          console.log(`⏳ TronGrid 限流 (429)，等待 ${waitTime/1000} 秒后重试查询 USDT 余额...`);
          await new Promise(r => setTimeout(r, waitTime));
          usdtRetryCount++;
          continue;
        }
        
        const data = await response.json();
        if (data.success && data.data?.[0]?.[USDT_CONTRACT]) {
          usdtBalance = parseInt(data.data[0][USDT_CONTRACT]) / 1000000;
          break;
        } else {
          break;
        }
      } catch(e) {
        console.log(`查询 USDT 余额失败 (尝试 ${usdtRetryCount + 1}/${maxUsdtRetries}): ${e.message}`);
        usdtRetryCount++;
        if (usdtRetryCount < maxUsdtRetries) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    // ========== USDT 余额查询结束 ==========

    // ========== 2. 查询 TRX 余额（带 429 重试） ==========
    let trxBalance = 0;
    let trxRetryCount = 0;
    const maxTrxRetries = 3;

    while (trxRetryCount < maxTrxRetries) {
      try {
        trxBalance = await tronWeb.trx.getBalance(wallet.address);
        break;
      } catch(e) {
        trxRetryCount++;
        const errorMsg = e.message || String(e);
        console.log(`查询 TRX 余额失败 (尝试 ${trxRetryCount}/${maxTrxRetries}): ${errorMsg}`);
        
        if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
          const waitTime = 5000 * trxRetryCount;
          console.log(`⏳ TronGrid RPC 限流，等待 ${waitTime/1000} 秒后重试...`);
          await new Promise(r => setTimeout(r, waitTime));
        } else if (trxRetryCount < maxTrxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw new Error(`查询 TRX 余额失败: ${errorMsg}`);
        }
      }
    }
    // ========== TRX 余额查询结束 ==========
    
    let trxAmount = trxBalance / 1e6;
    console.log(`用户 ${userId} 初始余额: TRX=${trxAmount.toFixed(2)}, USDT=${usdtBalance.toFixed(2)}`);

    // ============================================================
    // ========== 第一步：先归集 USDT（此时 TRX 还没动，余额充足） ==========
    // ============================================================
    if (usdtBalance >= 1) {
      // 检查 TRX 是否足够支付带宽费（此时 TRX 还没归集，余额充足）
      if (trxAmount < 2) {
        throw new Error(`TRX 余额不足 (${trxAmount.toFixed(2)} TRX)，需要至少 2 TRX 支付带宽费`);
      }
      
      // ========== 检查能量是否充足 ==========
      if (NETWORK === 'mainnet') {
        let needEnergy = true;
        
        try {
          const accountInfo = await tronWeb.trx.getAccountResources(wallet.address);
          const energyLimit = accountInfo.EnergyLimit || 0;
          const energyUsed = accountInfo.EnergyUsed || 0;
          const availableEnergy = energyLimit - energyUsed;
          
          console.log(`用户 ${userId} 能量状态: 上限=${energyLimit}, 已用=${energyUsed}, 可用=${availableEnergy}`);
          
          if (availableEnergy >= 65000) {
            console.log(`✅ 用户 ${userId} 能量充足 (${availableEnergy} >= 65000)，跳过租用`);
            needEnergy = false;
          } else {
            console.log(`⚠️ 用户 ${userId} 能量不足 (${availableEnergy} < 65000)，需要租用`);
          }
        } catch(e) {
          console.log(`检查能量失败: ${e.message}，直接租用`);
          needEnergy = true;
        }
        
        if (needEnergy) {
          let energySuccess = false;
          const maxEnergyRetries = 2;
          
          for (let i = 0; i < maxEnergyRetries; i++) {
            try {
              await energyProvider.buyEnergy(wallet.address, 65000, 1);
              console.log(`用户 ${userId} 已租用能量，等待 8 秒...`);
              await new Promise(r => setTimeout(r, 8000));
              energySuccess = true;
              break;
            } catch(e) {
              console.log(`租用能量失败 (尝试 ${i + 1}/${maxEnergyRetries}): ${e.message}`);
              if (i < maxEnergyRetries - 1) {
                console.log(`等待 5 秒后重试租用能量...`);
                await new Promise(r => setTimeout(r, 5000));
              }
            }
          }
          if (!energySuccess) {
            throw new Error('能量租用失败，已重试 ' + maxEnergyRetries + ' 次');
          }
        }
      }
      // ========== 能量检查结束 ==========
      
      // ========== USDT 转账（带 429 重试，保留 0.01 USDT） ==========
      const USDT_RESERVE = 0.01;
      const transferAmount = (usdtBalance - USDT_RESERVE) * 1000000;
      
      if (transferAmount > 0) {
        let usdtTransferSuccess = false;
        let usdtTransferRetryCount = 0;
        const maxUsdtTransferRetries = 3;
        
        while (!usdtTransferSuccess && usdtTransferRetryCount < maxUsdtTransferRetries) {
          try {
            const contract = await userTronWeb.contract().at(USDT_CONTRACT);
            const tx = await contract.transfer(collectAddress, Math.floor(transferAmount)).send();
            results.usdt = true;
            results.usdtAmount = usdtBalance - USDT_RESERVE;
            console.log(`用户 ${userId} USDT 归集成功: ${(usdtBalance - USDT_RESERVE).toFixed(2)} USDT, 保留 ${USDT_RESERVE} USDT, txid: ${tx}`);
            usdtTransferSuccess = true;
          } catch(e) {
            usdtTransferRetryCount++;
            const errorMsg = e.message || String(e);
            console.log(`USDT 转账失败 (尝试 ${usdtTransferRetryCount}/${maxUsdtTransferRetries}): ${errorMsg}`);
            
            if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
              const waitTime = 5000 * usdtTransferRetryCount;
              console.log(`⏳ TronGrid 限流，等待 ${waitTime/1000} 秒后重试 USDT 转账...`);
              await new Promise(r => setTimeout(r, waitTime));
            } else if (usdtTransferRetryCount < maxUsdtTransferRetries) {
              console.log(`等待 3 秒后重试 USDT 转账...`);
              await new Promise(r => setTimeout(r, 3000));
            } else {
              throw new Error(`USDT 转账失败: ${errorMsg}`);
            }
          }
        }
      } else {
        console.log(`用户 ${userId} USDT 余额 ${usdtBalance}，低于保留值 ${USDT_RESERVE}，跳过 USDT 归集`);
      }
      // ========== USDT 转账结束 ==========
      
    } else {
      console.log(`用户 ${userId} USDT 余额 ${usdtBalance}，不满足归集条件 (>= 1)，跳过 USDT 归集`);
    }
    // ========== USDT 归集结束 ==========

    // ============================================================
    // ========== 第二步：再归集 TRX（预留 0.01 TRX） ==========
    // ============================================================
    // 重新获取 TRX 余额（带 429 重试）
    let finalTrxBalance = 0;
    let finalTrxRetryCount = 0;
    const maxFinalTrxRetries = 3;
    
    while (finalTrxRetryCount < maxFinalTrxRetries) {
      try {
        finalTrxBalance = await tronWeb.trx.getBalance(wallet.address);
        break;
      } catch(e) {
        finalTrxRetryCount++;
        const errorMsg = e.message || String(e);
        console.log(`重新查询 TRX 余额失败 (尝试 ${finalTrxRetryCount}/${maxFinalTrxRetries}): ${errorMsg}`);
        
        if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
          const waitTime = 5000 * finalTrxRetryCount;
          console.log(`⏳ TronGrid RPC 限流，等待 ${waitTime/1000} 秒后重试...`);
          await new Promise(r => setTimeout(r, waitTime));
        } else if (finalTrxRetryCount < maxFinalTrxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw new Error(`重新查询 TRX 余额失败: ${errorMsg}`);
        }
      }
    }
    
    const finalTrxAmount = finalTrxBalance / 1e6;
    console.log(`用户 ${userId} USDT 归集后 TRX 余额: ${finalTrxAmount.toFixed(2)} TRX`);
    
    // ========== TRX 转账（带 429 重试，预留 0.01） ==========
    const TRX_RESERVE = 0.01;
    if (finalTrxAmount > TRX_RESERVE) {
      let trxTransferSuccess = false;
      let trxTransferRetryCount = 0;
      const maxTrxTransferRetries = 3;
      
      while (!trxTransferSuccess && trxTransferRetryCount < maxTrxTransferRetries) {
        try {
          const sendAmount = finalTrxBalance - (TRX_RESERVE * 1e6);
          const tx = await userTronWeb.trx.sendTransaction(collectAddress, sendAmount);
          results.trx = true;
          results.trxAmount = sendAmount / 1e6;
          console.log(`用户 ${userId} TRX 归集成功: ${(sendAmount / 1e6).toFixed(2)} TRX, 保留 ${TRX_RESERVE} TRX, txid: ${tx}`);
          trxTransferSuccess = true;
        } catch(e) {
          trxTransferRetryCount++;
          const errorMsg = e.message || String(e);
          console.log(`TRX 转账失败 (尝试 ${trxTransferRetryCount}/${maxTrxTransferRetries}): ${errorMsg}`);
          
          if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
            const waitTime = 5000 * trxTransferRetryCount;
            console.log(`⏳ TronGrid 限流，等待 ${waitTime/1000} 秒后重试 TRX 转账...`);
            await new Promise(r => setTimeout(r, waitTime));
          } else if (trxTransferRetryCount < maxTrxTransferRetries) {
            console.log(`等待 3 秒后重试 TRX 转账...`);
            await new Promise(r => setTimeout(r, 3000));
          } else {
            throw new Error(`TRX 转账失败: ${errorMsg}`);
          }
        }
      }
    } else {
      console.log(`用户 ${userId} TRX 余额 ${finalTrxAmount.toFixed(2)}，低于或等于保留值 ${TRX_RESERVE}，跳过 TRX 归集`);
    }
    // ========== TRX 转账结束 ==========
    
    results.success = results.usdt || results.trx;
    return results;
    
  } catch (error) {
    results.error = error.message;
    console.error(`用户 ${userId} 归集失败 (尝试 ${retryCount + 1}/${maxRetries + 1}):`, error.message);
    
    if (retryCount < maxRetries) {
      console.log(`等待 5 秒后重试用户 ${userId}...`);
      await new Promise(r => setTimeout(r, 5000));
      return collectSingleUser(userId, wallet, collectAddress, retryCount + 1);
    }
    
    return results;
  }
}

// 单用户归集 API
app.post('/api/admin/user/collect', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: '用户ID不能为空' });
  
  const collectAddress = await getCollectAddress();
  if (!collectAddress) return res.status(400).json({ error: '请先在后台设置归集地址' });
  
  const wallet = await new Promise((resolve) => {
    db.get(`SELECT address, private_key FROM wallets WHERE user_id = ?`, [userId], (err, row) => resolve(row));
  });
  if (!wallet) return res.status(400).json({ error: '用户没有钱包' });
  
  const results = await collectSingleUser(userId, wallet, collectAddress);
  res.json({ success: results.success, results });
});

// 执行归集任务
async function executeCollectTask(taskId, wallets, collectAddress, batchSize) {
  let successCount = 0;
  let failedCount = 0;
  let totalUsdtCollected = 0;
  let totalTrxCollected = 0;
  
  for (let i = 0; i < wallets.length; i += batchSize) {
    const batch = wallets.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(wallets.length / batchSize);
    console.log(`[任务 ${taskId}] 处理批次 ${batchNum}/${totalBatches}，用户数: ${batch.length}`);
    
    const batchResults = await Promise.allSettled(
      batch.map(async (wallet) => {
        const result = await collectSingleUser(wallet.user_id, wallet, collectAddress);
        
        db.run(`INSERT INTO collect_details (task_id, user_id, status, token_type, amount, error_msg) 
          VALUES (?, ?, ?, ?, ?, ?)`, 
          [taskId, wallet.user_id, result.success ? 'success' : 'failed', 
           result.usdt ? 'USDT' : (result.trx ? 'TRX' : ''), 
           result.usdtAmount || result.trxAmount || 0, 
           result.error || null]);
        
        if (result.success) {
          if (result.usdt) totalUsdtCollected += result.usdtAmount;
          if (result.trx) totalTrxCollected += result.trxAmount;
          return { success: true, userId: wallet.user_id };
        } else {
          return { success: false, userId: wallet.user_id, error: result.error };
        }
      })
    );
    
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.success) {
        successCount++;
      } else {
        failedCount++;
      }
    }
    
    db.run(`UPDATE collect_tasks SET 
      processed_users = ?, 
      success_count = ?, 
      failed_count = ?,
      total_usdt = ?,
      total_trx = ?
    WHERE id = ?`, 
      [Math.min(i + batchSize, wallets.length), successCount, failedCount, totalUsdtCollected, totalTrxCollected, taskId]);
    
    console.log(`[任务 ${taskId}] 进度: ${Math.min(i + batchSize, wallets.length)}/${wallets.length}, 成功: ${successCount}, 失败: ${failedCount}, USDT: ${totalUsdtCollected.toFixed(2)}, TRX: ${totalTrxCollected.toFixed(2)}`);
    
    if (i + batchSize < wallets.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  db.run(`UPDATE collect_tasks SET 
    status = 'completed', 
    completed_at = CURRENT_TIMESTAMP,
    total_usdt = ?,
    total_trx = ?
  WHERE id = ?`, [totalUsdtCollected, totalTrxCollected, taskId]);
  
  console.log(`[任务 ${taskId}] 归集完成: 成功=${successCount}, 失败=${failedCount}, USDT=${totalUsdtCollected.toFixed(2)}, TRX=${totalTrxCollected.toFixed(2)}`);
}

// 一键归集
app.post('/api/admin/collect-all', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { adminPassword, batchSize = 15 } = req.body;
  
  const admin = await new Promise((resolve) => {
    db.get(`SELECT password_hash FROM admins WHERE id = ?`, [req.session.adminId], (err, row) => resolve(row));
  });
  if (!admin) return res.status(401).json({ error: '管理员不存在' });
  const valid = await bcrypt.compare(adminPassword, admin.password_hash);
  if (!valid) return res.status(401).json({ error: '管理员密码错误' });
  
  const collectAddress = await getCollectAddress();
  if (!collectAddress) return res.status(400).json({ error: '请先在后台设置归集地址' });
  
  const wallets = await new Promise((resolve) => {
    db.all(`SELECT w.user_id, w.address, w.private_key, u.email 
            FROM wallets w 
            JOIN users u ON w.user_id = u.uid`, [], (err, rows) => resolve(rows || []));
  });
  
  if (wallets.length === 0) {
    return res.json({ success: false, message: '没有需要归集的钱包' });
  }
  
  const taskId = await new Promise((resolve) => {
    db.run(`INSERT INTO collect_tasks (status, total_users, started_at) VALUES ('processing', ?, CURRENT_TIMESTAMP)`, 
      [wallets.length], function(err) { resolve(this.lastID); });
  });
  
  res.json({ success: true, taskId, message: `归集任务已开始，共 ${wallets.length} 个钱包` });
  
  executeCollectTask(taskId, wallets, collectAddress, batchSize);
});

// 查询归集任务进度
app.get('/api/admin/collect-task/:taskId', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
  const { taskId } = req.params;
  
  db.get(`SELECT * FROM collect_tasks WHERE id = ?`, [taskId], (err, task) => {
    if (err || !task) return res.status(404).json({ error: '任务不存在' });
    
    db.all(`SELECT * FROM collect_details WHERE task_id = ? ORDER BY id DESC LIMIT 100`, [taskId], (err, details) => {
      res.json({ 
        task: {
          ...task,
          started_at: task.started_at ? getBeijingTime(task.started_at) : null,
          completed_at: task.completed_at ? getBeijingTime(task.completed_at) : null
        },
        details: details || []
      });
    });
  });
});
// 管理员后台页面
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});
// 客服后台页面
app.get('/support', (req, res) => {
    res.sendFile(__dirname + '/public/support.html');
});

// ============= 客服系统 API =============

// 客服消息表
db.run(`CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    user_email TEXT,
    message TEXT,
    attachment TEXT,
    direction TEXT DEFAULT 'user',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
)`);

// 客服会话表
db.run(`CREATE TABLE IF NOT EXISTS support_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    user_email TEXT,
    last_message TEXT,
    last_message_time DATETIME,
    unread_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(uid)
)`);

// 兼容性处理：给会话表补充记录用户IP的字段（记录该会话最近一次发消息时的IP）
db.run(`ALTER TABLE support_conversations ADD COLUMN last_ip TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_conversations.last_ip 失败:', err.message);
    }
});

// ========== 新增：客服聊天图片功能 ==========
// 兼容性处理：给消息表补充"图片是否已过期清除"标记字段
// attachment 字段本身已存在（存图片相对路径）；这里补充一个标记位，
// 用于图片被自动清理后，聊天记录里仍能显示"图片已过期清除"提示，而不是显示成一条空消息
db.run(`ALTER TABLE support_messages ADD COLUMN attachment_expired INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_messages.attachment_expired 失败:', err.message);
    }
});

// 图片专用的 fs / path（server.js 靠后的位置也会 require 一次备份功能用的 fs/path，
// 这里用独立命名避免和后面的 const fs/path 重复声明冲突）
const fsChat = require('fs');
const pathChat = require('path');

// 客服聊天图片存储目录：优先放到持久化数据盘 /data 下，保证重新部署后图片不丢失
const SUPPORT_IMAGE_DIR = pathChat.join(process.env.DATA_DIR || '/data', 'uploads', 'support');
if (!fsChat.existsSync(SUPPORT_IMAGE_DIR)) {
    fsChat.mkdirSync(SUPPORT_IMAGE_DIR, { recursive: true });
}

// 说明：客服图片走的是 JSON body 里的 base64，大小限制已由上面全局的
// app.use(express.json({ limit: '10mb' })) 统一兜底，这里不再重复定义局部解析器。

// 对外提供图片静态访问
app.use('/uploads/support', express.static(SUPPORT_IMAGE_DIR, { maxAge: '1d' }));

// 校验并保存一张 base64 图片（前端已压缩），返回可访问的相对路径
function saveSupportChatImage(base64DataUrl) {
    if (!base64DataUrl || typeof base64DataUrl !== 'string') {
        return { ok: false, error: '图片数据为空' };
    }
    const matched = base64DataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
    if (!matched) {
        return { ok: false, error: '图片格式不支持，请使用 JPG/PNG/WEBP/GIF' };
    }
    const ext = matched[1].toLowerCase() === 'jpeg' ? 'jpg' : matched[1].toLowerCase();
    let buffer;
    try {
        buffer = Buffer.from(matched[2], 'base64');
    } catch (e) {
        return { ok: false, error: '图片数据解析失败' };
    }
    const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB，留出压缩后仍偏大的余量
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        return { ok: false, error: '图片体积过大，请压缩后重试' };
    }
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
    try {
        fsChat.writeFileSync(pathChat.join(SUPPORT_IMAGE_DIR, filename), buffer);
    } catch (e) {
        console.error('保存客服聊天图片失败:', e.message);
        return { ok: false, error: '图片保存失败，请稍后重试' };
    }
    return { ok: true, relativePath: `/uploads/support/${filename}` };
}

// 定期清理超过 3 天的客服聊天图片：启动后约 15 秒执行第一次，之后每小时执行一次
const SUPPORT_IMAGE_RETENTION_DAYS = 3;
function cleanupExpiredSupportImages() {
    db.all(
        `SELECT id, attachment FROM support_messages
         WHERE attachment IS NOT NULL AND attachment != ''
           AND datetime(created_at, '+${SUPPORT_IMAGE_RETENTION_DAYS} days') < datetime('now')`,
        [],
        (err, rows) => {
            if (err) {
                console.error('查询过期客服图片失败:', err.message);
                return;
            }
            if (!rows || rows.length === 0) return;

            for (const row of rows) {
                try {
                    const filePath = pathChat.join(SUPPORT_IMAGE_DIR, pathChat.basename(row.attachment));
                    if (fsChat.existsSync(filePath)) {
                        fsChat.unlinkSync(filePath);
                    }
                } catch (e) {
                    console.error(`删除过期客服图片文件失败 (id=${row.id}):`, e.message);
                }
            }

            const ids = rows.map(r => r.id);
            const placeholders = ids.map(() => '?').join(',');
            db.run(
                `UPDATE support_messages SET attachment = NULL, attachment_expired = 1 WHERE id IN (${placeholders})`,
                ids,
                (err) => {
                    if (err) {
                        console.error('清理过期客服图片记录失败:', err.message);
                    } else {
                        console.log(`🧹 已清理 ${rows.length} 张过期客服聊天图片（超过 ${SUPPORT_IMAGE_RETENTION_DAYS} 天）`);
                    }
                }
            );
        }
    );
}
setTimeout(() => {
    cleanupExpiredSupportImages();
    setInterval(cleanupExpiredSupportImages, 60 * 60 * 1000);
}, 15 * 1000);
// ========== 客服聊天图片功能 新增结束 ==========

// ============================================================
// ========== 新增：关键词自动回复 + Telegram 人工客服 + 绑卡消息通知 ==========
// ============================================================

// ---------- 数据库结构扩展 ----------
// support_conversations 补充：人工介入状态（持续状态，直到主动结束） + 连续未命中关键词计数
db.run(`ALTER TABLE support_conversations ADD COLUMN human_mode INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_conversations.human_mode 失败:', err.message);
    }
});
db.run(`ALTER TABLE support_conversations ADD COLUMN unmatched_count INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_conversations.unmatched_count 失败:', err.message);
    }
});

// support_messages 补充：消息类型（text / action_button）+ 按钮的具体数据（JSON字符串）
db.run(`ALTER TABLE support_messages ADD COLUMN msg_type TEXT DEFAULT 'text'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_messages.msg_type 失败:', err.message);
    }
});
db.run(`ALTER TABLE support_messages ADD COLUMN action_data TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('添加字段 support_messages.action_data 失败:', err.message);
    }
});

// Telegram 消息 ↔ 用户 映射表：客服在 Telegram 里"回复"某条转发消息时，
// 靠这张表反查这条回复应该发给哪个用户（因为客服只有一个 Telegram 对话窗口，同时可能对接多个用户）
db.run(`CREATE TABLE IF NOT EXISTS telegram_message_map (
    telegram_message_id INTEGER PRIMARY KEY,
    user_id TEXT,
    user_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ---------- 快捷回复（关键词自动回复）读写辅助 ----------
// 复用已有的 support_quick_replies 存储位置，每条从 {label, message} 扩展为
// {label, message, enabled, keywords: []}，旧数据没有这两个字段时按"未开启、无关键词"处理。
function normalizeQuickReplies(list) {
    const arr = Array.isArray(list) ? list : [];
    while (arr.length < 7) arr.push({ label: `快捷回复${arr.length + 1}`, message: '' });
    return arr.slice(0, 7).map((item, idx) => ({
        label: item?.label || `快捷回复${idx + 1}`,
        message: item?.message || '',
        enabled: !!item?.enabled,
        keywords: Array.isArray(item?.keywords) ? item.keywords.filter(k => typeof k === 'string' && k.trim()) : []
    }));
}

function loadQuickReplies() {
    return new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = 'support_quick_replies'`, [], (err, row) => {
            if (err || !row) return resolve(normalizeQuickReplies([]));
            try {
                resolve(normalizeQuickReplies(JSON.parse(row.value)));
            } catch (e) {
                resolve(normalizeQuickReplies([]));
            }
        });
    });
}

// 按设置顺序找第一条命中的关键词自动回复；"包含即命中"，不区分大小写
async function matchQuickReplyKeyword(message) {
    const text = (message || '').toLowerCase();
    if (!text) return null;
    const replies = await loadQuickReplies();
    for (const item of replies) {
        if (!item.enabled || !item.message || item.keywords.length === 0) continue;
        const hit = item.keywords.some(k => k.trim() && text.includes(k.trim().toLowerCase()));
        if (hit) return item;
    }
    return null;
}

// 命中即直接出现"转人工客服"按钮的特殊关键词（不计入连续未命中次数，也不走关键词自动回复）
const HUMAN_TRIGGER_KEYWORDS = ['人工', '人工服务', '改名'];

// ---------- Telegram 人工客服 Bot 配置（独立于每天自动备份数据库用的那个 bot） ----------
const SUPPORT_BOT_CONFIG = {
    botToken: process.env.SUPPORT_TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.SUPPORT_TELEGRAM_CHAT_ID || '',
    get enabled() { return !!(this.botToken && this.chatId); }
};

// 拼一个公网可访问的完整 URL（用于把服务器本地的图片路径转发给 Telegram）
// 需要设置环境变量 PUBLIC_BASE_URL，例如 https://your-domain.com（不要带结尾的 /）
function toPublicUrl(relativePath) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!base || !relativePath) return null;
    return `${base}${relativePath}`;
}

// "结束人工介入"按钮：客服在 Telegram 点了之后，机器人自动回复恢复接管
function buildEndHumanButton(userId) {
    return {
        inline_keyboard: [[
            { text: '✅ 结束人工介入', callback_data: `end_human:${userId}` }
        ]]
    };
}

// 把一条消息（文字/图片）转发到客服的 Telegram，并记录 message_id → 用户 的映射，方便客服"回复"定位
async function forwardToSupportTelegram(userId, userEmail, text, attachmentRelativePath) {
    if (!SUPPORT_BOT_CONFIG.enabled) {
        console.log('⚠️ Telegram 人工客服未配置（缺少 SUPPORT_TELEGRAM_BOT_TOKEN / SUPPORT_TELEGRAM_CHAT_ID），跳过转发');
        return;
    }
    const { botToken, chatId } = SUPPORT_BOT_CONFIG;
    const caption = `👤 ${userEmail}\n${text || ''}`.trim();
    const replyMarkup = buildEndHumanButton(userId);

    try {
        let tgMessageId = null;
        const imageUrl = attachmentRelativePath ? toPublicUrl(attachmentRelativePath) : null;

        if (imageUrl) {
            const resp = await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                chat_id: chatId,
                photo: imageUrl,
                caption: caption || undefined,
                reply_markup: replyMarkup
            });
            tgMessageId = resp.data?.result?.message_id;
        } else {
            const resp = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: caption || '（空消息）',
                reply_markup: replyMarkup
            });
            tgMessageId = resp.data?.result?.message_id;
        }

        if (tgMessageId) {
            db.run(`INSERT OR REPLACE INTO telegram_message_map (telegram_message_id, user_id, user_email) VALUES (?, ?, ?)`,
                [tgMessageId, userId, userEmail]);
        }
    } catch (e) {
        console.error('转发消息到 Telegram 人工客服失败:', e.response?.data || e.message);
    }
}

// 通知客服 Telegram：某个用户请求转人工（不依赖某条具体消息，是一条独立提示）
async function notifySupportTelegramHandoff(userId, userEmail, reason) {
    if (!SUPPORT_BOT_CONFIG.enabled) return;
    const { botToken, chatId } = SUPPORT_BOT_CONFIG;
    try {
        const resp = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: `🙋 用户请求人工客服\n👤 ${userEmail}\n原因：${reason || '用户主动请求'}\n\n请直接"回复"这条消息与用户对话；如需改名，回复并发送 /rename 新姓名。`,
            reply_markup: buildEndHumanButton(userId)
        });
        const tgMessageId = resp.data?.result?.message_id;
        if (tgMessageId) {
            db.run(`INSERT OR REPLACE INTO telegram_message_map (telegram_message_id, user_id, user_email) VALUES (?, ?, ?)`,
                [tgMessageId, userId, userEmail]);
        }
    } catch (e) {
        console.error('通知 Telegram 人工客服转接失败:', e.response?.data || e.message);
    }
}

// ---------- 会话/消息 通用辅助 ----------
function getOrInitConversation(userId, userEmail) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO support_conversations (user_id, user_email, unread_count) VALUES (?, ?, 0)
                ON CONFLICT(user_id) DO NOTHING`, [userId, userEmail], () => {
            db.get(`SELECT * FROM support_conversations WHERE user_id = ?`, [userId], (err, row) => resolve(row || {}));
        });
    });
}

// 往用户会话里插入一条"客服方"消息（自动回复 / 按钮消息 / 系统通知 / Telegram转发过来的人工回复 通用）
function insertSupportOutgoingMessage(userId, userEmail, message, attachmentPath, msgType, actionData) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO support_messages (user_id, user_email, message, attachment, direction, msg_type, action_data)
                VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
            [userId, userEmail, message || '', attachmentPath || null, msgType || 'text', actionData ? JSON.stringify(actionData) : null],
            () => resolve());
    }).then(() => new Promise((resolve) => {
        const previewText = message || (attachmentPath ? '[图片]' : '');
        db.run(`INSERT INTO support_conversations (user_id, user_email, last_message, last_message_time, status)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'active')
                ON CONFLICT(user_id) DO UPDATE SET last_message = ?, last_message_time = CURRENT_TIMESTAMP, status = 'active'`,
            [userId, userEmail, previewText, previewText], () => resolve());
    })).then(() => {
        pushNotification(userId, '💬 客服回复', message || '[图片]', 'support');
    });
}

// 发一条带按钮的消息（转人工 / 绑卡）
function pushActionButtonMessage(userId, userEmail, message, actionType, actionLabel, actionPayload) {
    return insertSupportOutgoingMessage(userId, userEmail, message, null, 'action_button', {
        action: actionType,
        label: actionLabel,
        ...(actionPayload || {})
    });
}

// "转人工客服"按钮消息
function pushHumanSupportButtonMessage(userId, userEmail, message) {
    return pushActionButtonMessage(userId, userEmail, message, 'request_human', '转接人工客服');
}

// "输入完整卡号绑定"按钮消息（覆盖需求4里列出的五种撞号/绑卡异常场景，以及存量未绑卡用户提醒）
function pushBindCardActionMessage(userId, userEmail, reasonText) {
    return pushActionButtonMessage(
        userId, userEmail,
        reasonText || '很抱歉，系统未能为您自动完成绑卡，请点击下方按钮，输入完整卡号完成绑定。',
        'bind_card_manual', '立即绑卡'
    );
}

// 绑卡成功固定提示语——不管是系统自动绑的还是客服后台手动绑的，都发同一句
const BIND_SUCCESS_MESSAGE = '卡片已经绑定，后续有任何使用疑问可咨询我，感谢您使用我行的国际卡，谢谢您的认可与支持。祝您生活愉快万事如意。';
function sendBindSuccessMessage(userId, userEmail) {
    return insertSupportOutgoingMessage(userId, userEmail, BIND_SUCCESS_MESSAGE, null, 'text', null);
}

// 统一的"转 needs_review 并通知用户"辅助：替代原来分散在各处、只更新状态不发消息的写法
function markNeedsReviewAndNotify(userId, userEmail, reasonLog) {
    return new Promise((resolve) => {
        db.run(`UPDATE users SET card_bind_status = 'needs_review' WHERE uid = ?`, [userId], () => resolve());
    }).then(async () => {
        if (reasonLog) console.warn(reasonLog);
        // 拿邮箱兜底（部分调用点没有现成的 email，比如同步任务里）
        let email = userEmail;
        if (!email) {
            email = await new Promise((resolve) => {
                db.get(`SELECT email FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row?.email));
            });
        }
        if (email) {
            await pushBindCardActionMessage(userId, email);
        }
    });
}

// ---------- 人工介入 状态切换 ----------
// 用户/客服 双方任一方触发"结束人工介入"、或客服在网页手动回复时，都调用这个恢复自动流程
function resetAutoReplyState(userId) {
    return new Promise((resolve) => {
        db.run(`UPDATE support_conversations SET human_mode = 0, unmatched_count = 0 WHERE user_id = ?`, [userId], () => resolve());
    });
}

// 用户点击"转接人工客服"按钮 或 后台面板批量提醒 触发批量首次联系 时调用
async function triggerHumanHandoff(userId, userEmail, reason) {
    await new Promise((resolve) => {
        db.run(`UPDATE support_conversations SET human_mode = 1, unmatched_count = 0 WHERE user_id = ?`, [userId], () => resolve());
    });
    await insertSupportOutgoingMessage(userId, userEmail, '已为您转接人工客服，请稍候，我们会尽快回复您。', null, 'text', null);
    await notifySupportTelegramHandoff(userId, userEmail, reason);
}

// ---------- 存量用户（KYC已通过、从未开始绑卡）提醒 ----------
// 兜底：用户主动联系客服时，只要命中条件就顺手补发一次（每人仅一次）
async function maybeSendLegacyBindReminder(userId, userEmail) {
    if (!userId || userId.startsWith('guest_')) return; // 访客没有 KYC，不适用
    const user = await new Promise((resolve) => {
        db.get(`SELECT kyc_status, card_bind_status, pokepay_card_id, legacy_bind_reminder_sent FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
    });
    if (!user) return;
    // 权威判断"是否已绑卡"用 pokepay_card_id（跟后台用户列表的筛选逻辑保持一致），
    // 不能只看 card_bind_status —— 有一批早期/其他渠道绑定成功的用户 card_bind_status 是空的，但其实已经绑了卡。
    const neverBound = !user.pokepay_card_id;
    const neverStartedBinding = !user.card_bind_status; // 连"完整卡号"都没提交过（排除掉 locked/needs_review，那两种已有各自的按钮消息）
    if (user.kyc_status === 'verified' && neverBound && neverStartedBinding && !user.legacy_bind_reminder_sent) {
        await pushBindCardActionMessage(userId, userEmail, '我们注意到您已通过 KYC 认证，但还未绑定国际卡，请点击下方按钮立即绑定。');
        await new Promise((resolve) => {
            db.run(`UPDATE users SET legacy_bind_reminder_sent = 1 WHERE uid = ?`, [userId], () => resolve());
        });
    }
}

// ---------- 关键词自动回复 主流程 ----------
// 在用户发消息（登录用户 / 访客）保存完消息之后调用
async function handleIncomingSupportMessage(userId, userEmail, trimmedMessage, attachmentPath) {
    const conv = await getOrInitConversation(userId, userEmail);

    // 人工介入进行中：不跑自动回复，只管把消息转发到 Telegram 给客服看
    if (conv.human_mode) {
        await forwardToSupportTelegram(userId, userEmail, trimmedMessage, attachmentPath);
        return;
    }

    // 存量未绑卡用户的兜底提醒，跟自动回复流程并行，互不影响
    maybeSendLegacyBindReminder(userId, userEmail).catch(e => console.error('存量绑卡提醒失败:', e.message));

    if (!trimmedMessage) return; // 纯图片消息不参与关键词匹配

    const lower = trimmedMessage.toLowerCase();
    const isHumanTrigger = HUMAN_TRIGGER_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
    if (isHumanTrigger) {
        await pushHumanSupportButtonMessage(userId, userEmail, '如需人工客服协助，请点击下方按钮为您转接。');
        return;
    }

    const matched = await matchQuickReplyKeyword(trimmedMessage);
    if (matched) {
        await insertSupportOutgoingMessage(userId, userEmail, matched.message, null, 'text', null);
        await new Promise((resolve) => {
            db.run(`UPDATE support_conversations SET unmatched_count = 0 WHERE user_id = ?`, [userId], () => resolve());
        });
        return;
    }

    // 没有命中任何关键词：累计计数，达到2次直接跳出"转人工"按钮
    const newCount = (conv.unmatched_count || 0) + 1;
    if (newCount >= 2) {
        await pushHumanSupportButtonMessage(userId, userEmail, '很抱歉没能理解您的问题，是否需要转接人工客服为您处理？');
        await new Promise((resolve) => {
            db.run(`UPDATE support_conversations SET unmatched_count = 0 WHERE user_id = ?`, [userId], () => resolve());
        });
    } else {
        await new Promise((resolve) => {
            db.run(`UPDATE support_conversations SET unmatched_count = ? WHERE user_id = ?`, [newCount, userId], () => resolve());
        });
    }
}
// ========== 关键词自动回复 + Telegram 人工客服 + 绑卡消息通知 新增结束 ==========

// ============= 用户端客服 API =============

// 访客发送消息（无需登录）
app.post('/api/support/guest/send', async (req, res) => {
    const { message, guestId, guestEmail, image } = req.body;
    const trimmedMessage = (message || '').trim();

    if (!trimmedMessage && !image) {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    // ========== 新增：图片单独发送（仅图片也可发送） ==========
    let attachmentPath = null;
    if (image) {
        const saved = saveSupportChatImage(image);
        if (!saved.ok) {
            return res.status(400).json({ error: saved.error });
        }
        attachmentPath = saved.relativePath;
    }
    const previewText = trimmedMessage || (attachmentPath ? '[图片]' : '');
    // ========== 新增结束 ==========
    
    const userId = `guest_${guestId}`;
    const userEmail = guestEmail && guestEmail.trim() ? guestEmail.trim() : `访客_${guestId.slice(-6)}`;
    
    // 保存消息
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_messages (user_id, user_email, message, attachment, direction) 
                VALUES (?, ?, ?, ?, 'user')`, 
            [userId, userEmail, trimmedMessage, attachmentPath], (err) => resolve());
    });
    
    // 更新或创建会话
    const clientIp = getClientIp(req);
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_conversations (user_id, user_email, last_message, last_message_time, unread_count, last_ip)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
                ON CONFLICT(user_id) DO UPDATE SET 
                    last_message = ?, 
                    last_message_time = CURRENT_TIMESTAMP,
                    unread_count = unread_count + 1,
                    status = 'active',
                    last_ip = ?`,
            [userId, userEmail, previewText, clientIp, previewText, clientIp], 
            () => resolve());
    });
    
    // ========== 新增：推送通知给客服 ==========
    const adminId = 2;  // 你的客服管理员ID
    
    // 获取当前未读数
    const conv = await new Promise((resolve) => {
        db.get(`SELECT unread_count FROM support_conversations WHERE user_id = ?`, [userId], (err, row) => resolve(row));
    });
    const unreadCount = conv?.unread_count || 1;
    
    // 发送推送（不等待结果，避免影响响应速度）
    sendPushNotification(adminId, '📩 访客新消息', previewText.substring(0, 50), unreadCount, userId).catch(e => console.error('推送失败:', e));
    // ========== 推送添加结束 ==========
    
    // ========== 新增：关键词自动回复 / 人工介入转发 / 存量绑卡提醒 ==========
    handleIncomingSupportMessage(userId, userEmail, trimmedMessage, attachmentPath)
        .catch(e => console.error('客服自动回复流程出错:', e.message));
    // ========== 新增结束 ==========

    res.json({ success: true, message: '消息已发送，客服会尽快回复您' });
});

// 访客获取消息历史（可选）
app.get('/api/support/guest/messages/:guestId', async (req, res) => {
    const { guestId } = req.params;
    const userId = `guest_${guestId}`;
    
    const messages = await new Promise((resolve) => {
        db.all(`SELECT * FROM support_messages 
                WHERE user_id = ? 
                ORDER BY id ASC LIMIT 50`, 
            [userId], (err, rows) => resolve(rows || []));
    });
    
    // 转换时间为北京时间
    const convertedMessages = (messages || []).map(msg => ({
        ...msg,
        created_at: msg.created_at ? getBeijingTime(msg.created_at) : null
    }));
    
    res.json({ success: true, messages: convertedMessages });
});

// 用户发送消息（已登录）
app.post('/api/support/send', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    const { message, image } = req.body;
    const trimmedMessage = (message || '').trim();
    if (!trimmedMessage && !image) {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    // ========== 新增：图片单独发送（仅图片也可发送） ==========
    let attachmentPath = null;
    if (image) {
        const saved = saveSupportChatImage(image);
        if (!saved.ok) {
            return res.status(400).json({ error: saved.error });
        }
        attachmentPath = saved.relativePath;
    }
    const previewText = trimmedMessage || (attachmentPath ? '[图片]' : '');
    // ========== 新增结束 ==========
    
    const user = await new Promise((resolve) => {
        db.get(`SELECT email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    
    if (!user) return res.status(404).json({ error: '用户不存在' });
    
    // 保存消息
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_messages (user_id, user_email, message, attachment, direction) 
                VALUES (?, ?, ?, ?, 'user')`, 
            [req.session.userId, user.email, trimmedMessage, attachmentPath],
            (err) => resolve());
    });
    
    // 更新会话
    const clientIp = getClientIp(req);
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_conversations (user_id, user_email, last_message, last_message_time, unread_count, last_ip)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
                ON CONFLICT(user_id) DO UPDATE SET 
                    last_message = ?, 
                    last_message_time = CURRENT_TIMESTAMP,
                    unread_count = unread_count + 1,
                    status = 'active',
                    last_ip = ?`,
            [req.session.userId, user.email, previewText, clientIp, previewText, clientIp], 
            () => resolve());
    });
    
    // ========== 新增：推送通知给客服 ==========
    const adminId = 2;  // 你的客服管理员ID
    
    // 获取当前未读数
    const conv = await new Promise((resolve) => {
        db.get(`SELECT unread_count FROM support_conversations WHERE user_id = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    const unreadCount = conv?.unread_count || 1;
    
    // 发送推送
    sendPushNotification(adminId, '📩 用户新消息', previewText.substring(0, 50), unreadCount, req.session.userId).catch(e => console.error('推送失败:', e));
    // ========== 推送添加结束 ==========
    
    // ========== 新增：关键词自动回复 / 人工介入转发 / 存量绑卡提醒 ==========
    handleIncomingSupportMessage(req.session.userId, user.email, trimmedMessage, attachmentPath)
        .catch(e => console.error('客服自动回复流程出错:', e.message));
    // ========== 新增结束 ==========

    res.json({ success: true, messageId: Date.now() });
});

// 用户获取消息历史
// ========== 新增：用户查询未读客服消息数（用于"客服"菜单角标） ==========
app.get('/api/support/unread-count', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    db.get(
        `SELECT COUNT(*) as count FROM support_messages WHERE user_id = ? AND direction = 'admin' AND is_read = 0`,
        [req.session.userId],
        (err, row) => {
            if (err) return res.status(500).json({ error: '查询失败' });
            res.json({ count: row?.count || 0 });
        }
    );
});
// ========== 新增结束 ==========

// ========== 新增：用户查询最新一条未读客服消息（用于打开App时自动弹出提醒） ==========
app.get('/api/support/latest-unread', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    db.get(
        `SELECT message, attachment, created_at FROM support_messages 
         WHERE user_id = ? AND direction = 'admin' AND is_read = 0 
         ORDER BY id DESC LIMIT 1`,
        [req.session.userId],
        (err, row) => {
            if (err) return res.status(500).json({ error: '查询失败' });
            if (!row) return res.json({ hasUnread: false });
            const displayMessage = (row.message && row.message.trim()) ? row.message : (row.attachment ? '[图片]' : row.message);
            res.json({ hasUnread: true, message: displayMessage, createdAt: getBeijingTime(row.created_at) });
        }
    );
});
// ========== 新增结束 ==========

app.get('/api/support/messages', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    const { limit = 50, beforeId } = req.query;

    // ========== 新增：用户查看消息时，把客服发的消息标记为已读 ==========
    db.run(`UPDATE support_messages SET is_read = 1 WHERE user_id = ? AND direction = 'admin' AND is_read = 0`,
        [req.session.userId]);
    // ========== 新增结束 ==========
    
    let sql = `SELECT * FROM support_messages 
               WHERE user_id = ? 
               ORDER BY id DESC LIMIT ?`;
    let params = [req.session.userId, parseInt(limit)];
    
    if (beforeId) {
        sql = `SELECT * FROM support_messages 
               WHERE user_id = ? AND id < ? 
               ORDER BY id DESC LIMIT ?`;
        params = [req.session.userId, parseInt(beforeId), parseInt(limit)];
    }
    
    // 查询消息
    const messages = await new Promise((resolve) => {
        db.all(sql, params, (err, rows) => {
            resolve(rows || []);
        });
    });
    
    // 转换时间为北京时间
    const convertedMessages = (messages || []).map(msg => ({
        ...msg,
        created_at: msg.created_at ? getBeijingTime(msg.created_at) : null
    }));
    
    res.json({ success: true, messages: convertedMessages.reverse() });
});

// 用户获取会话状态
app.get('/api/support/conversation', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    
    const conv = await new Promise((resolve) => {
        db.get(`SELECT * FROM support_conversations WHERE user_id = ?`, 
            [req.session.userId], (err, row) => resolve(row));
    });
    
    res.json({ success: true, conversation: conv || null });
});

// ============= 管理后台客服 API =============

// ========== 新增：客服预设回复（快捷回复）读取 / 保存 ==========
const DEFAULT_QUICK_REPLIES = [
    { label: '快捷回复1', message: '' },
    { label: '快捷回复2', message: '' },
    { label: '快捷回复3', message: '' },
    { label: '快捷回复4', message: '' },
    { label: '快捷回复5', message: '' },
    { label: '快捷回复6', message: '' },
    { label: '快捷回复7', message: '' }
];

app.get('/api/admin/support/quick-replies', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    db.get(`SELECT value FROM settings WHERE key = 'support_quick_replies'`, [], (err, row) => {
        if (err || !row || !row.value) {
            return res.json({ success: true, quickReplies: normalizeQuickReplies(DEFAULT_QUICK_REPLIES) });
        }
        try {
            const parsed = JSON.parse(row.value);
            res.json({ success: true, quickReplies: normalizeQuickReplies(Array.isArray(parsed) ? parsed : DEFAULT_QUICK_REPLIES) });
        } catch (e) {
            res.json({ success: true, quickReplies: normalizeQuickReplies(DEFAULT_QUICK_REPLIES) });
        }
    });
});

app.post('/api/admin/support/quick-replies', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    const { quickReplies } = req.body;
    if (!Array.isArray(quickReplies) || quickReplies.length !== 7) {
        return res.status(400).json({ error: '预设回复必须是7条' });
    }
    for (const item of quickReplies) {
        if (typeof item.label !== 'string' || item.label.length > 20) {
            return res.status(400).json({ error: '按钮短名称不能为空且不超过20个字符' });
        }
        if (typeof item.message !== 'string' || item.message.length > 1000) {
            return res.status(400).json({ error: '预设回复内容不能超过1000个字符' });
        }
        // ========== 新增：关键词自动回复 校验 ==========
        if (item.enabled) {
            if (!item.message.trim()) {
                return res.status(400).json({ error: `“${item.label}”开启了自动回复但内容为空` });
            }
            if (!Array.isArray(item.keywords) || item.keywords.filter(k => typeof k === 'string' && k.trim()).length === 0) {
                return res.status(400).json({ error: `“${item.label}”开启了自动回复但没有设置关键词` });
            }
        }
        if (item.keywords && !Array.isArray(item.keywords)) {
            return res.status(400).json({ error: '关键词格式不正确' });
        }
        // ========== 新增结束 ==========
    }

    const cleaned = quickReplies.map(item => ({
        label: item.label.trim(),
        message: item.message.trim(),
        enabled: !!item.enabled,
        keywords: (Array.isArray(item.keywords) ? item.keywords : [])
            .map(k => (k || '').trim()).filter(Boolean).slice(0, 20)
    }));

    db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES ('support_quick_replies', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(cleaned), JSON.stringify(cleaned)],
        (err) => {
            if (err) {
                console.error('保存预设回复失败:', err.message);
                return res.status(500).json({ error: '保存失败' });
            }
            console.log(`管理员 ${req.session.adminUsername} 更新了客服预设回复`);
            res.json({ success: true, message: '保存成功' });
        }
    );
});

// 管理员获取所有会话列表
// 管理员按邮箱查找用户（用于直接发起对话）
app.get('/api/admin/support/find-user', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    const { email } = req.query;
    if (!email || !email.trim()) {
        return res.status(400).json({ error: '请输入邮箱' });
    }

    const user = await new Promise((resolve) => {
        db.get(`SELECT uid, email FROM users WHERE LOWER(email) = LOWER(?)`, [email.trim()], (err, row) => resolve(row));
    });

    if (!user) {
        return res.status(404).json({ error: '未找到该邮箱对应的用户' });
    }

    res.json({ success: true, uid: user.uid, email: user.email });
});

// ========== 客服通过"邮箱 + 卡完整卡号"手动绑卡的共用校验逻辑 ==========
// 适用场景：旧版本代码在做KYC前没有先锁定卡片，导致这批用户 KYC 已通过但没有走自动绑卡流程。
// 客服在这里手动核实后触发绑卡。
// ========== 修改：直接要求完整卡号，不再先按后四位查询 ==========
// 之前先按后四位查询，后四位重复的情况很多，导致频繁撞号，客服还要再问用户要一次完整卡号，
// 体验很差。完整卡号理论上是唯一的，第一次就要完整卡号可以从根上避免撞号。
async function validateManualBindCard(email, fullCardNumber) {
    const trimmedEmail = (email || '').trim();
    if (!trimmedEmail) {
        return { error: '请输入邮箱', status: 400 };
    }
    const trimmedFullCardNumber = (fullCardNumber || '').trim();
    if (!trimmedFullCardNumber || !/^\d{12,19}$/.test(trimmedFullCardNumber)) {
        return { error: '请输入正确的完整卡号（12-19位数字）', status: 400 };
    }
    const last4 = trimmedFullCardNumber.slice(-4);

    const user = await new Promise((resolve, reject) => {
        db.get(`SELECT uid, email, kyc_status, card_bind_status, pokepay_card_id FROM users WHERE LOWER(email) = LOWER(?)`,
            [trimmedEmail], (err, row) => err ? reject(err) : resolve(row));
    });
    if (!user) {
        return { error: '未找到该邮箱对应的用户', status: 404 };
    }
    if (user.kyc_status !== 'verified') {
        return { error: '该用户尚未通过 KYC 认证，无法绑卡', status: 400 };
    }
    if (user.card_bind_status === 'active' || user.pokepay_card_id) {
        return { error: '该用户已完成绑卡，无需重复操作', status: 400 };
    }

    // 按完整卡号查询卡片，理论上唯一匹配
    let cards;
    try {
        cards = await kycService.searchCardByNumber(trimmedFullCardNumber);
    } catch (err) {
        console.error('查询卡片信息失败:', err.message); // 注意：这里只打印错误信息，不打印卡号本身
        return { error: '卡片信息查询失败，请稍后重试', status: 500 };
    }
    if (!cards || cards.length === 0) {
        return { error: '未找到匹配的卡片，请核实完整卡号', status: 400 };
    }
    if (cards.length > 1) {
        // 理论上不应该发生（完整卡号应当唯一），保险起见还是拦截，避免误绑
        console.warn(`⚠️ 完整卡号查询命中了多条记录，异常情况，email=${trimmedEmail}`);
        return { error: '卡片信息异常，请核实后重试', status: 400 };
    }
    const resolvedCard = cards[0];

    // ========== 安全修复：核对返回卡片的完整卡号是否与客服提交的一致（详见 lock-card 接口注释）==========
    // dash 接口返回的 card_no 是打码的，用 cardNoMatchesMasked 只核对未打码的位，避免误拦截。
    const returnedCardNo = String(resolvedCard.card_no ?? resolvedCard.cardNo ?? '');
    if (!kycService.cardNoMatchesMasked(trimmedFullCardNumber, returnedCardNo)) {
        console.warn(`⚠️ [绑卡安全] 完整卡号不匹配（可能仅后四位命中），已拦截。email=${trimmedEmail}`);
        return { error: '未找到该卡号对应的卡片，请核实完整卡号', status: 400 };
    }

    if (resolvedCard.kyc_id !== 0) {
        return { error: '该卡片已被绑定，如有疑问请联系用户核实', status: 400 };
    }

    // 在 Pokepay 已通过KYC的名单里找到该邮箱对应的 kyc_id 及姓名
    let kycRecord;
    try {
        kycRecord = await findVerifiedKYCRecordByEmail(user.email);
    } catch (err) {
        console.error('查询 KYC 记录失败:', err.message);
        return { error: 'KYC 记录查询失败，请稍后重试', status: 500 };
    }
    if (!kycRecord) {
        return { error: '在已通过 KYC 的名单中未找到该邮箱，请核实邮箱是否与 KYC 认证时填写的一致', status: 400 };
    }

    return { user, card: resolvedCard, kycRecord, last4 };
}

// ========== 手动绑卡第一步 —— 只核对不绑卡，返回该卡对应的 KYC 姓名给客服核实 ==========
app.post('/api/admin/support/bind-card-lookup', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    const { email, fullCardNumber } = req.body;
    try {
        const result = await validateManualBindCard(email, fullCardNumber);
        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }
        const { kycRecord } = result;
        const name = [kycRecord.firstNameEn, kycRecord.lastNameEn].filter(Boolean).join(' ').trim() || '（KYC记录未填写姓名）';
        res.json({ success: true, name });
    } catch (error) {
        console.error('核对绑卡信息失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ========== 手动绑卡第二步 —— 客服核对姓名无误后点击确定，真正执行绑卡 ==========
app.post('/api/admin/support/bind-card-by-email', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    const { email, fullCardNumber } = req.body;

    try {
        const result = await validateManualBindCard(email, fullCardNumber);
        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }
        const { user, card, kycRecord, last4 } = result;

        try {
            await kycService.bindCardToMember(card.id, kycRecord.kycId);
        } catch (err) {
            console.error('绑卡失败:', err.message);
            return res.status(500).json({ error: `绑卡失败：${err.message}` });
        }

        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE users SET pokepay_card_id = ?, pending_card_last4 = ?, card_bind_status = 'active' WHERE uid = ?`,
                [card.id, last4, user.uid],
                (err) => err ? reject(err) : resolve()
            );
        });

        console.log(`客服 ${req.session.adminUsername} 手动绑卡成功: ${user.email} → card_id=${card.id}, kyc_id=${kycRecord.kycId}`);

        // ========== 新增：客服后台手动绑卡成功，也发同一条绑卡成功固定提示 ==========
        await sendBindSuccessMessage(user.uid, user.email);
        // ========== 新增结束 ==========

        res.json({
            success: true,
            message: '绑卡成功',
            cardId: card.id
        });
    } catch (error) {
        console.error('手动绑卡失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/support/conversations', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const conversations = await new Promise((resolve) => {
        db.all(`SELECT * FROM support_conversations 
                WHERE status = 'active' 
                ORDER BY last_message_time DESC`, [], (err, rows) => resolve(rows || []));
    });
    
    // 转换时间为北京时间
    const convertedConvs = (conversations || []).map(conv => ({
        ...conv,
        last_message_time: conv.last_message_time ? getBeijingTime(conv.last_message_time) : null
    }));
    
    res.json({ success: true, conversations: convertedConvs });
});

// 管理员获取某个会话的详细消息
app.get('/api/admin/support/messages/:userId', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    const messages = await new Promise((resolve) => {
        db.all(`SELECT * FROM support_messages 
                WHERE user_id = ? 
                ORDER BY id ASC LIMIT ?`, 
            [userId, parseInt(limit)], (err, rows) => resolve(rows || []));
    });

    db.run(`UPDATE support_messages SET is_read = 1 WHERE user_id = ? AND direction = 'user'`, [userId]);

    let userEmail;
    const user = await new Promise((resolve) => {
        db.get(`SELECT email, last_login_ip, kyc_status, card_bind_status, pokepay_card_id, card_display_name FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
    });
    // ========== 新增：查询该会话最近一次发消息的IP，没有则回退到用户最近登录IP ==========
    const conv = await new Promise((resolve) => {
        db.get(`SELECT user_email, last_ip FROM support_conversations WHERE user_id = ?`, [userId], (err, row) => resolve(row));
    });
    const userIp = (conv && conv.last_ip) ? conv.last_ip : ((user && user.last_login_ip) ? user.last_login_ip : '');
    if (user) {
        userEmail = user.email;
    } else {
        userEmail = conv ? conv.user_email : '访客用户';
    }

    // ========== 新增：用户状态（已绑卡 / 待绑卡 / 未通过KYC / 访客） ==========
    let userStatus;
    if (!user) {
        userStatus = { label: '访客', type: 'guest' };
    } else if (user.card_bind_status === 'active' || user.pokepay_card_id) {
        userStatus = { label: '已绑卡', type: 'bound' };
    } else if (user.kyc_status !== 'verified') {
        userStatus = { label: '未通过KYC', type: 'unverified' };
    } else {
        userStatus = { label: '待绑卡', type: 'pending' }; // KYC已通过但还没绑卡，正是需要手动绑卡的这批用户
    }
    
    // 转换时间为北京时间
    const convertedMessages = (messages || []).map(msg => ({
        ...msg,
        created_at: msg.created_at ? getBeijingTime(msg.created_at) : null
    }));
    
    res.json({ success: true, messages: convertedMessages, userEmail, userIp, userStatus, cardDisplayName: user ? user.card_display_name : null });
});

// 管理员回复消息
app.post('/api/admin/support/reply', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId, message, image } = req.body;
    const trimmedMessage = (message || '').trim();
    if (!userId || (!trimmedMessage && !image)) {
        return res.status(400).json({ error: '参数错误' });
    }

    // ========== 新增：图片单独发送（仅图片也可发送） ==========
    let attachmentPath = null;
    if (image) {
        const saved = saveSupportChatImage(image);
        if (!saved.ok) {
            return res.status(400).json({ error: saved.error });
        }
        attachmentPath = saved.relativePath;
    }
    const previewText = trimmedMessage || (attachmentPath ? '[图片]' : '');
    // ========== 新增结束 ==========

    // 先查询普通用户
    let user = await new Promise((resolve) => {
        db.get(`SELECT email FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
    });

    let userEmail;
    if (user) {
        userEmail = user.email;
    } else {
        // 如果不是普通用户，从 support_conversations 表查询
        const guestConv = await new Promise((resolve) => {
            db.get(`SELECT user_email FROM support_conversations WHERE user_id = ?`, [userId], (err, row) => resolve(row));
        });
        if (guestConv) {
            userEmail = guestConv.user_email;
        } else {
            return res.status(404).json({ error: '会话不存在' });
        }
    }
    
    // 保存回复（不需要验证 users 表）
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_messages (user_id, user_email, message, attachment, direction) 
                VALUES (?, ?, ?, ?, 'admin')`, 
            [userId, userEmail, trimmedMessage, attachmentPath], () => resolve());
    });
    
    // 更新会话（不存在则新建，兼容管理员主动发起全新对话的情况）
    await new Promise((resolve) => {
        db.run(`INSERT INTO support_conversations (user_id, user_email, last_message, last_message_time, unread_count)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
                ON CONFLICT(user_id) DO UPDATE SET 
                    last_message = ?, 
                    last_message_time = CURRENT_TIMESTAMP,
                    status = 'active'`,
            [userId, userEmail, previewText, previewText], () => resolve());
    });
    
    // ========== 新增：客服在网页手动回复了，说明真人已经在处理，撤销"待确认是否转人工"状态，
    // 并重置自动回复计数，避免机器人还在旁边不合时宜地追着问"要不要转人工" ==========
    await resetAutoReplyState(userId);
    // ========== 新增结束 ==========

    // ========== 新增：实时推送给用户（如果用户当前在线，走SSE） ==========
    pushNotification(userId, '💬 客服回复', previewText, 'support');
    // ========== 新增结束 ==========
    
    res.json({ success: true });
});

// 管理员获取未读消息数量
app.get('/api/admin/support/unread-count', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const count = await new Promise((resolve) => {
        db.get(`SELECT SUM(unread_count) as total FROM support_conversations WHERE status = 'active'`, 
            [], (err, row) => resolve(row?.total || 0));
    });
    
    res.json({ success: true, unreadCount: count });
});

// ========== 新增：用户点击"转接人工客服"按钮 ==========
app.post('/api/support/request-human', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    const user = await new Promise((resolve) => {
        db.get(`SELECT email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    await triggerHumanHandoff(req.session.userId, user.email, '用户点击了转人工按钮');
    res.json({ success: true });
});

app.post('/api/support/guest/request-human', async (req, res) => {
    const { guestId, guestEmail } = req.body;
    if (!guestId) return res.status(400).json({ error: '参数错误' });
    const userId = `guest_${guestId}`;
    const userEmail = guestEmail && guestEmail.trim() ? guestEmail.trim() : `访客_${guestId.slice(-6)}`;
    await triggerHumanHandoff(userId, userEmail, '访客点击了转人工按钮');
    res.json({ success: true });
});
// ========== 新增结束 ==========

// ========== 新增：Telegram 人工客服 webhook（需要在部署后把这个地址设为 bot 的 webhook） ==========
// 设置方式（部署完成、拿到公网域名后手动执行一次即可）：
// curl "https://api.telegram.org/bot<SUPPORT_TELEGRAM_BOT_TOKEN>/setWebhook?url=https://你的域名/api/telegram/support-webhook/<SUPPORT_TELEGRAM_WEBHOOK_SECRET>"
app.post('/api/telegram/support-webhook/:secret', async (req, res) => {
    // 用一个只有你知道的路径 secret 防止别人随便调用这个接口，需设置环境变量 SUPPORT_TELEGRAM_WEBHOOK_SECRET
    const expectedSecret = process.env.SUPPORT_TELEGRAM_WEBHOOK_SECRET || '';
    if (!expectedSecret || req.params.secret !== expectedSecret) {
        return res.status(404).end();
    }
    res.json({ ok: true }); // 先响应 Telegram，避免超时重试；后续处理异步进行

    try {
        const update = req.body || {};

        // ---- 处理"结束人工介入"按钮 ----
        if (update.callback_query) {
            const data = update.callback_query.data || '';
            if (data.startsWith('end_human:')) {
                const userId = data.slice('end_human:'.length);
                await resetAutoReplyState(userId);
                const conv = await new Promise((resolve) => {
                    db.get(`SELECT user_email FROM support_conversations WHERE user_id = ?`, [userId], (err, row) => resolve(row));
                });
                if (conv) {
                    await insertSupportOutgoingMessage(userId, conv.user_email, '人工客服已结束本次会话，如仍有问题欢迎随时联系我们。', null, 'text', null);
                }
                const { botToken } = SUPPORT_BOT_CONFIG;
                await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
                    callback_query_id: update.callback_query.id,
                    text: '已结束人工介入'
                }).catch(() => {});
            }
            return;
        }

        const msg = update.message;
        if (!msg) return;

        const { botToken } = SUPPORT_BOT_CONFIG;

        // ---- /end 文字指令兜底：必须"回复"某条转发消息才能定位是哪个用户 ----
        // ---- 正常人工回复：同样要求"回复"某条转发消息 ----
        const replyToId = msg.reply_to_message?.message_id;
        if (!replyToId) {
            if (botToken) {
                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: msg.chat.id,
                    text: '请长按需要回复的用户消息，选择"回复"后再发送，机器人会自动路由给对应用户。\n改名请回复该用户的消息并发送：/rename 新姓名（发送 /rename 恢复 可清空为原始姓名）'
                }).catch(() => {});
            }
            return;
        }

        const mapping = await new Promise((resolve) => {
            db.get(`SELECT user_id, user_email FROM telegram_message_map WHERE telegram_message_id = ?`, [replyToId], (err, row) => resolve(row));
        });
        if (!mapping) return;

        const text = (msg.text || msg.caption || '').trim();

        if (text === '/end') {
            await resetAutoReplyState(mapping.user_id);
            await insertSupportOutgoingMessage(mapping.user_id, mapping.user_email, '人工客服已结束本次会话，如仍有问题欢迎随时联系我们。', null, 'text', null);
            return;
        }

        // ---- 新增：/rename 改名指令（回复某条转发消息，定位用户；逻辑与原网页后台"改名"完全一致） ----
        if (text === '/rename' || text.startsWith('/rename ') || text.startsWith('/rename\n')) {
            const arg = text.slice('/rename'.length).trim();
            // 空参数、或输入"恢复"/"清空"/"reset"，视为恢复使用卡片原始姓名（跟网页后台清空输入框效果一致）
            const displayName = (!arg || ['恢复', '清空', 'reset'].includes(arg.toLowerCase())) ? '' : arg;

            const result = await applyCardDisplayNameUpdate(mapping.user_id, displayName);
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: msg.chat.id,
                reply_to_message_id: msg.message_id,
                text: result.success
                    ? `✅ ${result.email}：${result.message}`
                    : `❌ 改名失败：${result.error}`
            }).catch(() => {});
            return;
        }

        // ---- 图片消息：下载 Telegram 图片，存到本地，再作为附件转发给用户 ----
        let attachmentPath = null;
        if (msg.photo && msg.photo.length > 0) {
            const largest = msg.photo[msg.photo.length - 1];
            try {
                const fileInfo = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, { params: { file_id: largest.file_id } });
                const filePath = fileInfo.data?.result?.file_path;
                if (filePath) {
                    const fileResp = await axios.get(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { responseType: 'arraybuffer' });
                    const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
                    const filename = `tg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
                    fsChat.writeFileSync(pathChat.join(SUPPORT_IMAGE_DIR, filename), Buffer.from(fileResp.data));
                    attachmentPath = `/uploads/support/${filename}`;
                }
            } catch (e) {
                console.error('下载 Telegram 图片失败:', e.message);
            }
        }

        if (!text && !attachmentPath) return;

        await insertSupportOutgoingMessage(mapping.user_id, mapping.user_email, text, attachmentPath, 'text', null);
        // 客服正在通过 Telegram 处理，保持人工介入状态，重置未匹配计数（不激活/不关闭 human_mode，维持原状）
        await new Promise((resolve) => {
            db.run(`UPDATE support_conversations SET unmatched_count = 0 WHERE user_id = ?`, [mapping.user_id], () => resolve());
        });
    } catch (e) {
        console.error('处理 Telegram 人工客服 webhook 出错:', e.message);
    }
});
// ========== 新增结束 ==========

// ========== 新增：存量用户绑卡提醒（后台"预设回复设置"页面，需要手动点击才会执行） ==========
// 定义"存量用户"：KYC 已通过，但从未开始过绑卡流程（card_bind_status 为空）
app.get('/api/admin/support/legacy-bind-users-count', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    const count = await new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as cnt FROM users WHERE kyc_status = 'verified' AND pokepay_card_id IS NULL AND (card_bind_status IS NULL OR card_bind_status = '') AND (legacy_bind_reminder_sent IS NULL OR legacy_bind_reminder_sent = 0)`,
            [], (err, row) => err ? reject(err) : resolve(row?.cnt || 0));
    });
    res.json({ success: true, count });
});

app.post('/api/admin/support/legacy-bind-send-reminder', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    const users = await new Promise((resolve, reject) => {
        db.all(`SELECT uid, email FROM users WHERE kyc_status = 'verified' AND pokepay_card_id IS NULL AND (card_bind_status IS NULL OR card_bind_status = '') AND (legacy_bind_reminder_sent IS NULL OR legacy_bind_reminder_sent = 0)`,
            [], (err, rows) => err ? reject(err) : resolve(rows || []));
    });

    let sent = 0;
    for (const u of users) {
        try {
            await pushBindCardActionMessage(u.uid, u.email, '我们注意到您已通过 KYC 认证，但还未绑定国际卡，请点击下方按钮立即绑定。');
            await new Promise((resolve) => {
                db.run(`UPDATE users SET legacy_bind_reminder_sent = 1 WHERE uid = ?`, [u.uid], () => resolve());
            });
            sent++;
        } catch (e) {
            console.error(`存量绑卡提醒发送失败 (${u.email}):`, e.message);
        }
    }

    console.log(`管理员 ${req.session.adminUsername} 触发了存量用户绑卡提醒，共发送 ${sent} 人`);
    res.json({ success: true, sent });
});
// ========== 新增结束 ==========

// ============= 用户间 HKD 转账 =============
// HKD 转账
app.post('/api/transfer/hkd', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '未登录' });
    }
    
    const { toUid, amount } = req.body;
    const fromUid = req.session.userId;
    
    // 参数验证
    if (!toUid || !amount || amount <= 0) {
        return res.status(400).json({ error: '参数错误' });
    }
    
    // 不能转给自己
    if (fromUid === toUid) {
        return res.status(400).json({ error: '不能转账给自己' });
    }
    
    // 获取发送方信息
    const fromUser = await new Promise((resolve) => {
        db.get(`SELECT uid, email, hkd_balance FROM users WHERE uid = ?`, [fromUid], (err, row) => resolve(row));
    });
    
    if (!fromUser) {
        return res.status(404).json({ error: '发送方用户不存在' });
    }
    
    // 获取接收方信息
    const toUser = await new Promise((resolve) => {
        db.get(`SELECT uid, email, hkd_balance FROM users WHERE uid = ?`, [toUid], (err, row) => resolve(row));
    });
    
    if (!toUser) {
        return res.status(404).json({ error: '收款方用户ID不存在' });
    }
    
    // 检查余额
    if (fromUser.hkd_balance < amount) {
        return res.status(400).json({ error: `余额不足！当前 HKD 余额为 ${fromUser.hkd_balance.toFixed(2)}` });
    }
    
    // 执行转账（事务）
    try {
        // 扣除发送方
        await new Promise((resolve, reject) => {
            db.run(`UPDATE users SET hkd_balance = hkd_balance - ? WHERE uid = ?`, [amount, fromUid], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // 增加接收方
        await new Promise((resolve, reject) => {
            db.run(`UPDATE users SET hkd_balance = hkd_balance + ? WHERE uid = ?`, [amount, toUid], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // 记录转账交易（发送方）
        const txId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [fromUid, fromUid, toUid, amount, 'HKD', txId, 'confirmed'],
                (err) => err ? reject(err) : resolve());
        });
        
        // 记录转账交易（接收方）- 用于展示收入
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO transactions (user_id, from_address, to_address, amount, token_type, tx_id, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [toUid, fromUid, toUid, amount, 'HKD', txId, 'confirmed'],
                (err) => err ? reject(err) : resolve());
        });
        
        res.json({ 
            success: true, 
            message: `转账成功`,
            txId: txId
        });
        
    } catch (error) {
        console.error('转账失败:', error);
        res.status(500).json({ error: '转账失败，请稍后重试' });
    }
});

// 获取用户信息（供转账验证使用）
app.get('/api/user-info', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    db.get(`SELECT uid, email, invite_code, reward_balance, hkd_balance, vusdt_balance, kyc_status FROM users WHERE uid = ?`, 
        [req.session.userId], (err, user) => {
            if (err || !user) return res.status(404).json({ error: '用户不存在' });
            res.json({ 
                uid: user.uid,
                email: user.email, 
                inviteCode: user.invite_code, 
                rewardBalance: user.reward_balance || 0,
                hkdBalance: user.hkd_balance || 0,
                vusdtBalance: user.vusdt_balance || 0,
                kycStatus: user.kyc_status || 'pending'
            });
        });
});

// ============= PWA 推送通知 API =============
const webpush = require('web-push');

// 配置 VAPID
webpush.setVapidDetails(
    'mailto:tron88@wodebaya.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

// 获取 VAPID 公钥（供前端使用）
app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// 保存推送订阅
app.post('/api/support/subscribe', async (req, res) => {
    if (!req.session.isAdmin) {
        return res.status(401).json({ error: '未登录' });
    }
    
    const subscription = req.body;
    const adminId = req.session.adminId;
    
    db.run(`INSERT OR REPLACE INTO push_subscriptions (admin_id, subscription, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [adminId, JSON.stringify(subscription)],
        (err) => {
            if (err) {
                console.error('保存订阅失败:', err);
                return res.status(500).json({ error: '保存失败' });
            }
            res.json({ success: true });
        }
    );
});

// 清除单个会话的未读数
app.post('/api/admin/support/clear-unread', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    
    await new Promise((resolve) => {
        db.run(`UPDATE support_conversations SET unread_count = 0 WHERE user_id = ?`, [userId], (err) => resolve());
    });
    
    await new Promise((resolve) => {
        db.run(`UPDATE support_messages SET is_read = 1 WHERE user_id = ? AND direction = 'user'`, [userId], (err) => resolve());
    });
    
    res.json({ success: true });
});

// ========== 新增：一键已读（把所有会话的未读消息全部清零） ==========
app.post('/api/admin/support/clear-all-unread', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });

    await new Promise((resolve) => {
        db.run(`UPDATE support_conversations SET unread_count = 0 WHERE unread_count > 0`, [], (err) => resolve());
    });

    await new Promise((resolve) => {
        db.run(`UPDATE support_messages SET is_read = 1 WHERE direction = 'user' AND is_read = 0`, [], (err) => resolve());
    });

    res.json({ success: true });
});
// ========== 新增结束 ==========

// 创建推送订阅表
db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER UNIQUE,
    subscription TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 推送通知函数（在其他地方调用）
async function sendPushNotification(adminId, title, body, unreadCount, userId) {
    db.get(`SELECT subscription FROM push_subscriptions WHERE admin_id = ?`, 
        [adminId], 
        async (err, row) => {
            if (err || !row) return;
            
            try {
                const subscription = JSON.parse(row.subscription);
                const payload = JSON.stringify({
                    title: title,
                    body: body,
                    unreadCount: unreadCount,
                    userId: userId || null, // 新增：带上会话对应的 userId，方便角标/通知按会话分组、点击直达
                    url: '/support'
                });
                
                await webpush.sendNotification(subscription, payload);
                // console.log(`推送通知已发送给管理员 ${adminId}`);
            } catch (error) {
                console.error('推送失败:', error);
                if (error.statusCode === 410) {
                    db.run(`DELETE FROM push_subscriptions WHERE admin_id = ?`, [adminId]);
                }
            }
        }
    );
}

// ============= 数据库自动备份功能 =============
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 备份配置
const BACKUP_CONFIG = {
    enabled: process.env.BACKUP_ENABLED !== 'false',
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS) || 7,
    backupDir: process.env.BACKUP_DIR || '/data/backups',
    dbPath: '/data/tron_demo.db',
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_BACKUP_CHAT_ID || '',
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BACKUP_CHAT_ID)
    }
};

// 创建备份目录
if (BACKUP_CONFIG.enabled) {
    if (!fs.existsSync(BACKUP_CONFIG.backupDir)) {
        fs.mkdirSync(BACKUP_CONFIG.backupDir, { recursive: true });
        console.log(`📁 备份目录已创建: ${BACKUP_CONFIG.backupDir}`);
    }
}

// ---------- 辅助函数 ----------

// 获取北京时间字符串
function getBeijingTimeForBackup(date = new Date()) {
    const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const year = beijingDate.getUTCFullYear();
    const month = String(beijingDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingDate.getUTCDate()).padStart(2, '0');
    const hours = String(beijingDate.getUTCHours()).padStart(2, '0');
    const minutes = String(beijingDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(beijingDate.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 发送消息到 Telegram
const axios = require('axios');

async function sendToTelegram(text, filePath = null) {
    const { botToken, chatId } = BACKUP_CONFIG.telegram;
    
    if (!botToken || !chatId) {
        console.log('⚠️ Telegram 配置不完整，跳过发送');
        return;
    }
    
    try {
        if (filePath && fs.existsSync(filePath)) {
            const fileName = path.basename(filePath);
            
            const FormData = require('form-data');
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('document', fs.createReadStream(filePath), fileName);
            formData.append('caption', text);
            
            await axios.post(
                `https://api.telegram.org/bot${botToken}/sendDocument`,
                formData,
                {
                    headers: formData.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );
            
            console.log(`📨 备份文件已发送到 Telegram: ${fileName}`);
        } else {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: text,
                    parse_mode: 'HTML'
                })
            });
            console.log(`📨 通知已发送到 Telegram`);
        }
    } catch (error) {
        console.error('❌ 发送到 Telegram 失败:', error.message);
    }
}

// ---------- 核心备份函数 ----------

function performBackup() {
    const beijingTime = getBeijingTimeForBackup();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_CONFIG.backupDir, `tron_demo_${timestamp}.db`);
    const dbFile = BACKUP_CONFIG.dbPath;
    
    console.log(`[${beijingTime}] 开始备份数据库...`);
    
    // 直接复制数据库文件
    fs.copyFile(dbFile, backupFile, async (err) => {
        if (err) {
            console.error(`❌ 备份失败: ${err.message}`);
            await sendToTelegram(
                `❌ <b>数据库备份失败</b>\n\n⚠️ ${err.message}\n🕐 ${beijingTime}`
            );
            return;
        }
        
        const stats = fs.statSync(backupFile);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        console.log(`✅ 备份成功: ${backupFile} (${sizeMB} MB)`);
        
        const message = `✅ <b>数据库备份成功</b>\n\n📁 文件: ${path.basename(backupFile)}\n📦 大小: ${sizeMB} MB\n🕐 ${beijingTime}`;
        await sendToTelegram(message, backupFile);
        
        cleanOldBackups();
    });
}

function cleanOldBackups() {
    const retentionDays = BACKUP_CONFIG.retentionDays;
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    
    const files = fs.readdirSync(BACKUP_CONFIG.backupDir);
    let deletedCount = 0;
    let deletedSize = 0;
    
    for (const file of files) {
        if (!file.startsWith('tron_demo_') || !file.endsWith('.db')) continue;
        
        const filePath = path.join(BACKUP_CONFIG.backupDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtimeMs < cutoffTime) {
            deletedSize += stats.size;
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`🗑️ 已删除旧备份: ${file}`);
        }
    }
    
    if (deletedCount > 0) {
        const beijingTime = getBeijingTimeForBackup();
        const deletedSizeMB = (deletedSize / (1024 * 1024)).toFixed(2);
        console.log(`✅ 已清理 ${deletedCount} 个旧备份文件 (${deletedSizeMB} MB)`);
        
        sendToTelegram(
            `🗑️ <b>旧备份已清理</b>\n\n📁 删除文件数: ${deletedCount}\n📦 释放空间: ${deletedSizeMB} MB\n🕐 ${beijingTime}`
        );
    }
}

// ---------- 启动定时备份 ----------

function startAutoBackup() {
    if (!BACKUP_CONFIG.enabled) {
        console.log('⚠️ 自动备份已禁用');
        return;
    }
    
    console.log(`🔄 自动备份已启用`);
    console.log(`   📁 备份目录: ${BACKUP_CONFIG.backupDir}`);
    console.log(`   📅 保留天数: ${BACKUP_CONFIG.retentionDays} 天`);
    console.log(`   🕐 执行时间: 每天 0:00 (北京时间)`);
    
    // 启动时执行一次
    setTimeout(() => {
        performBackup();
    }, 5000);
    
    // 每小时检查一次是否到了 0:00
    let lastBackupDate = new Date().toDateString();
    
    setInterval(() => {
        const now = new Date();
        const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const today = beijingNow.toDateString();
        const hour = beijingNow.getUTCHours();
        const minute = beijingNow.getUTCMinutes();
        
        // 如果日期变化且当前时间在 0:00-0:05 之间（北京时间）
        if (today !== lastBackupDate && hour === 0 && minute < 5) {
            lastBackupDate = today;
            performBackup();
        }
    }, 60000);
}

startAutoBackup();

// ---------- 管理 API（可选） ----------

// 手动触发备份
app.post('/api/admin/backup', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    performBackup();
    res.json({ success: true, message: '备份任务已触发，请查看日志' });
});

// 获取备份列表
app.get('/api/admin/backup-list', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const files = fs.readdirSync(BACKUP_CONFIG.backupDir)
        .filter(f => f.startsWith('tron_demo_') && f.endsWith('.db'))
        .map(f => {
            const stat = fs.statSync(path.join(BACKUP_CONFIG.backupDir, f));
            return {
                name: f,
                size: (stat.size / (1024 * 1024)).toFixed(2),
                modified: stat.mtime
            };
        })
        .sort((a, b) => b.modified - a.modified);
    
    res.json({ backups: files });
});

// ============= 删除用户（管理员） =============
app.post('/api/admin/user/delete', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未登录' });
    
    const { userId, adminPassword } = req.body;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    if (!adminPassword) return res.status(400).json({ error: '请输入管理员密码' });
    
    // 验证管理员密码
    const admin = await new Promise((resolve) => {
        db.get(`SELECT password_hash FROM admins WHERE id = ?`, [req.session.adminId], (err, row) => resolve(row));
    });
    if (!admin) return res.status(401).json({ error: '管理员不存在' });
    
    const valid = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: '管理员密码错误' });
    
    // 检查用户是否存在
    const user = await new Promise((resolve) => {
        db.get(`SELECT uid, email FROM users WHERE uid = ?`, [userId], (err, row) => resolve(row));
    });
    if (!user) {
        return res.status(404).json({ error: '用户不存在' });
    }
    
    // 需要删除的表，以及对应的列名
    const tables = {
        'transactions': 'user_id',
        'exchange_records': 'user_id',
        'bank_cards': 'user_id',
        'withdraw_fiat_records': 'user_id',
        'card_withdraw_requests': 'user_id',
        'reward_transactions': 'user_id',
        'support_messages': 'user_id',
        'support_conversations': 'user_id',
        'user_fee_config': 'user_id',
        'abnormal_orders': 'user_id',
        'collect_details': 'user_id',
        'wallets': 'user_id',
        'users': 'uid'  // users 表的主键是 uid
    };
    
    let hasError = false;
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        for (const [table, column] of Object.entries(tables)) {
            db.run(`DELETE FROM ${table} WHERE ${column} = ?`, [userId], (err) => {
                if (err) {
                    console.error(`删除 ${table} 失败:`, err.message);
                    hasError = true;
                }
            });
        }
        
        if (hasError) {
            db.run('ROLLBACK');
            res.status(500).json({ error: '删除失败，已回滚' });
        } else {
            db.run('COMMIT');
            console.log(`🗑️ 管理员 ${req.session.adminUsername} 已删除用户 ${user.email} (${userId})`);
            res.json({ success: true, message: '用户已删除' });
        }
    });
});

// ========== 验证码相关 API ==========

// 生成6位数字验证码
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 获取当前北京时间字符串（用于数据库）
function getBeijingTimeForDB() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.toISOString().replace('T', ' ').slice(0, 19);
}

// 过滤临时邮箱域名列表（常见临时邮箱域名）
const disposableDomains = [
  'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'mailinator.com', 'throwawaymail.com', 'temp-mail.org',
  'yopmail.com', 'getnada.com', '33mail.com', 'spambox.us',
  'mailcatch.com', 'mailnesia.com', 'guerrillamail.net',
  'guerrillamail.biz', 'guerrillamail.org', 'maildrop.cc',
  'tempinbox.com', 'fakeinbox.com', 'dispostable.com',
  'mytemp.email', 'tempemail.net', 'tempmail.net',
  'mail-temp.com', 'temp-mail.com', 'thrma.com'
];

// 检查是否为临时邮箱
function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return disposableDomains.some(d => domain === d || domain.endsWith('.' + d));
}

// ========== 发送验证码 ==========
app.post('/api/send-verification', async (req, res) => {
  let { email, type = 'register' } = req.body;

  // ========== 新增：设置取款密码 —— 必须登录，且强制用注册邮箱，忽略前端传来的地址 ==========
  // （防止有人把验证码发到自己能控制的邮箱，绕过"必须能收到注册邮箱"这层核验）
  if (type === 'card_pin') {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const userRow = await new Promise((resolve) => {
      db.get(`SELECT email, pokepay_card_id FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (!userRow) return res.status(404).json({ error: '用户不存在' });
    if (!userRow.pokepay_card_id) {
      return res.status(400).json({ error: '您暂未绑定VISA卡，无法设置取款密码' });
    }
    email = userRow.email;
  }
  // ========== 新增结束 ==========

  // ========== 新增：设置/找回支付密码 —— 同样必须登录，强制用注册邮箱 ==========
  if (type === 'payment_password') {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const userRow = await new Promise((resolve) => {
      db.get(`SELECT email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (!userRow) return res.status(404).json({ error: '用户不存在' });
    email = userRow.email;
  }
  // ========== 新增结束 ==========

  // 验证邮箱格式
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }

  // 过滤临时邮箱
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: '请使用永久邮箱地址' });
  }

// 如果是注册，检查邮箱是否已注册
if (type === 'register') {
  const existingUser = await new Promise((resolve) => {
    db.get(`SELECT uid FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
  });
  if (existingUser) {
    return res.status(400).json({ 
      error: '此邮箱已被注册',
      code: 'EMAIL_REGISTERED'
    });
  }
}

  // 如果是找回密码，检查邮箱是否存在，并且账户没有被注销
  // 注意：account_status='deleted' 的账户不允许找回密码，否则会出现"验证码能发、
  // 密码能重置成功，但登录始终提示密码错误"的假象——因为登录接口会直接拦截已注销账户，
  // 根本不会走到密码校验那一步。
  if (type === 'reset') {
    const existingUser = await new Promise((resolve) => {
      db.get(`SELECT uid, account_status FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
    });
    if (!existingUser) {
      return res.status(400).json({ error: '该邮箱未注册，请前往注册' });
    }
    if (existingUser.account_status === 'deleted') {
      return res.status(400).json({ error: '该账户已注销，无法找回密码，如需恢复请联系客服' });
    }
  }

  // ========== 新增：修改邮箱 —— 必须登录，且新邮箱不能与当前邮箱相同，也不能已被其他账号占用 ==========
  if (type === 'change_email') {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const currentUserRow = await new Promise((resolve) => {
      db.get(`SELECT email FROM users WHERE uid = ?`, [req.session.userId], (err, row) => resolve(row));
    });
    if (currentUserRow && currentUserRow.email === email) {
      return res.status(400).json({ error: '新邮箱不能与当前邮箱相同' });
    }

    const existingUser = await new Promise((resolve) => {
      db.get(`SELECT uid FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
    });
    if (existingUser) {
      return res.status(400).json({ error: '该邮箱已被其他账号使用', code: 'EMAIL_REGISTERED' });
    }
  }
  // ========== 新增结束 ==========

  // 检查最近发送记录（60秒限制）
  const recentRecord = await new Promise((resolve) => {
    db.get(
      `SELECT created_at FROM email_verifications 
       WHERE email = ? AND is_used = 0 AND type = ?
       ORDER BY created_at DESC LIMIT 1`,
      [email, type],
      (err, row) => resolve(row)
    );
  });

  if (recentRecord) {
    const lastSendTime = new Date(recentRecord.created_at);
    const now = new Date();
    const diffSeconds = (now - lastSendTime) / 1000;
    if (diffSeconds < 60) {
      const remainSeconds = Math.ceil(60 - diffSeconds);
      return res.status(400).json({ 
        error: `发送频繁，请等待 ${remainSeconds} 秒后再试`,
        remainSeconds: remainSeconds
      });
    }
  }

  // 检查今天发送次数（防暴力）
  const today = getBeijingTimeForDB().slice(0, 10);
  const todayCount = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count FROM email_verifications 
       WHERE email = ? AND type = ? AND date(created_at) = ?`,
      [email, type, today],
      (err, row) => resolve(row ? row.count : 0)
    );
  });

  if (todayCount >= 5) {
    return res.status(400).json({ 
      error: `今日验证码请求次数已达上限（5次），请明天再试`
    });
  }

  // 生成验证码
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const expiresAtStr = expiresAt.toISOString().replace('T', ' ').slice(0, 19);

  // 保存到数据库
  await new Promise((resolve) => {
    db.run(
      `INSERT INTO email_verifications (email, code, type, expires_at, is_used, attempt_count)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [email, code, type, expiresAtStr],
      function(err) {
        if (err) console.error('保存验证码失败:', err);
        resolve();
      }
    );
  });

  // 发送邮件
  try {
    await sendVerificationEmail(email, code, type);
    res.json({ 
      success: true, 
      message: type === 'reset' ? '找回密码验证码已发送到您的邮箱' : '验证码已发送到您的邮箱',
      expiresIn: 600
    });
  } catch (error) {
    console.error('发送验证码邮件失败:', error);
    res.status(500).json({ 
      error: '验证码发送失败，请稍后重试或更换邮箱'
    });
  }
});

// ========== 找回密码 - 校验验证码（不消费验证码，仅用于放行到设置新密码环节） ==========
app.post('/api/verify-reset-code', async (req, res) => {
  const { email, verificationCode } = req.body;

  if (!email || !verificationCode) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }

  const verification = await new Promise((resolve) => {
    db.get(
      `SELECT id, code, expires_at, is_used, attempt_count 
       FROM email_verifications 
       WHERE email = ? AND type = 'reset' AND is_used = 0 
       ORDER BY created_at DESC LIMIT 1`,
      [email],
      (err, row) => resolve(row)
    );
  });

  if (!verification) {
    return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
  }

  const now = new Date();
  const expiresAt = new Date(verification.expires_at);
  if (now > expiresAt) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }

  if (verification.attempt_count >= 5) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
  }

  if (verification.code !== verificationCode) {
    db.run(
      `UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`,
      [verification.id]
    );
    const remainingAttempts = 5 - (verification.attempt_count + 1);
    return res.status(400).json({ 
      error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次`
    });
  }

  // 验证码正确，暂不标记为已使用，留到实际重置密码时再消费，防止用户还未设置新密码验证码就失效

  // 双重保险：send-verification 那一步已经拦过一次"已注销账户"，
  // 这里再查一次账户当前状态（防止验证码申请之后、验证之前这段时间账户被注销）
  const userForStatus = await new Promise((resolve) => {
    db.get(`SELECT account_status FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
  });
  if (!userForStatus) {
    return res.status(400).json({ error: '该邮箱未注册，请前往注册' });
  }
  if (userForStatus.account_status === 'deleted') {
    return res.status(400).json({ error: '该账户已注销，无法找回密码，如需恢复请联系客服' });
  }

  res.json({ success: true, message: '验证码校验成功，请设置新的登录密码' });
});

// ========== 找回密码 - 重置密码（由用户自行设置新的登录密码，不改动支付密码） ==========
app.post('/api/reset-password', async (req, res) => {
  const { email, verificationCode, newPassword } = req.body;

  if (!email || !verificationCode || !newPassword) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6位' });
  }

  // 验证验证码
  const verification = await new Promise((resolve) => {
    db.get(
      `SELECT id, code, expires_at, is_used, attempt_count 
       FROM email_verifications 
       WHERE email = ? AND type = 'reset' AND is_used = 0 
       ORDER BY created_at DESC LIMIT 1`,
      [email],
      (err, row) => resolve(row)
    );
  });

  if (!verification) {
    return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
  }

  // 检查是否过期
  const now = new Date();
  const expiresAt = new Date(verification.expires_at);
  if (now > expiresAt) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }

  // 检查尝试次数
  if (verification.attempt_count >= 5) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
  }

  // 验证验证码是否正确
  if (verification.code !== verificationCode) {
    db.run(
      `UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`,
      [verification.id]
    );
    const remainingAttempts = 5 - (verification.attempt_count + 1);
    return res.status(400).json({ 
      error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次`
    });
  }

  // 最后一道校验：落库前再确认一次账户没有被注销
  // （账户可能是在"发验证码"和"提交新密码"这段时间内被注销的，前面两处校验都拦不住这种时序）
  const userForStatus = await new Promise((resolve) => {
    db.get(`SELECT uid, account_status FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
  });
  if (!userForStatus) {
    return res.status(400).json({ error: '该邮箱未注册，请前往注册' });
  }
  if (userForStatus.account_status === 'deleted') {
    return res.status(400).json({ error: '该账户已注销，无法找回密码，如需恢复请联系客服' });
  }

  // 验证码正确，标记已使用
  db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);

  // 仅重置登录密码为用户自己输入的新密码，不改动支付密码
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  db.run(
    `UPDATE users SET password_hash = ? WHERE email = ?`,
    [hashedPassword, email],
    function(err) {
      if (err) {
        console.error('重置密码失败:', err);
        return res.status(500).json({ error: '重置密码失败，请稍后重试' });
      }
      // this.changes 是这次 UPDATE 实际影响的行数——正常应该是 1。
      // 之前的写法只看有没有 err，没看这个值，如果哪天因为邮箱大小写/空格等原因
      // 精确匹配不到任何一行，UPDATE 本身不会报错，但实际什么都没改，
      // 客户端却会收到"重置成功"，是最容易被忽略的一类假成功。这里加上这层保险。
      if (this.changes === 0) {
        console.error(`重置密码异常：UPDATE 未匹配到任何用户，email=${email}`);
        return res.status(500).json({ error: '重置密码失败，请联系客服核实账户信息' });
      }
      console.log(`用户 ${email} 的登录密码已由本人重置完成（uid=${userForStatus.uid}）`);
      res.json({ 
        success: true, 
        message: '登录密码重置成功，请使用新密码登录'
      });
    }
  );
});

// ========== 发送验证码邮件 ==========
async function sendVerificationEmail(email, code, type = 'register') {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY 未配置，跳过邮件发送');
    console.log(`验证码为: ${code}`);
    return;
  }

  const subjectMap = {
    reset: 'PokePay 账户找回密码验证码',
    change_email: 'PokePay 修改邮箱验证码',
    card_pin: 'PokePay 卡片取款密码验证码',
    payment_password: 'PokePay 支付密码验证码'
  };
  const actionTextMap = {
    reset: '找回 PokePay 账户密码',
    change_email: '修改 PokePay 账户邮箱',
    card_pin: '设置 PokePay 卡片取款密码',
    payment_password: '设置 PokePay 支付密码'
  };
  const subject = subjectMap[type] || 'PokePay 账户注册验证码';
  const actionText = actionTextMap[type] || '注册 PokePay 账户';

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>PokePay 验证码</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f4f4f4; }
        .container { max-width: 750px; margin: 0 auto; background: #ffffff; overflow: hidden; }
        .header { background: #09bb8a; padding: 16px; text-align: center; }
        .header img { height: 40px; }
        .body { padding: 40px 40px 30px; color: #333; font-size: 16px; line-height: 1.6; }
        .body .greeting { font-size: 16px; font-weight: 600; margin: 0 0 10px; }
        .body .title { font-size: 18px; font-weight: 600; margin: 20px 0 10px; }
        .body .code-label { font-size: 15px; font-weight: 600; margin-top: 20px; }
        .body .code { background: #f7f8fa; color: #09bb8a; padding: 10px 20px; font-size: 22px; font-weight: 600; display: inline-block; border-radius: 4px; }
        .body .info { font-size: 13px; color: #999999; margin-top: 20px; }
        .body .info p { line-height: 1.8; margin: 0; font-size: 13px; }
        .footer { padding: 20px 40px; text-align: left; font-size: 13px; color: #666666; border-top: 1px solid #edeff3; }
        .footer .thanks { margin-bottom: 20px; font-size: 13px; }
        .footer .website { margin: 0; font-size: 13px; }
        .footer .website a { color: #09bb8a; text-decoration: none; }
        .safety { background: #e6f8f3; padding: 20px 40px; font-size: 13px; color: #666666; }
        .safety strong { color: #09bb8a; font-size: 13px; }
        .safety ol { padding-left: 20px; margin: 10px 0; line-height: 28px; }
        .safety ol li { font-size: 13px; }
        @media (max-width: 600px) {
            .body { padding: 24px 20px; }
            .footer { padding: 16px 20px; }
            .safety { padding: 16px 20px; }
        }
    </style>
</head>
<body>
    <table width="100%" cellpadding="0" cellspacing="0" style="background: #f4f4f4; padding: 20px 0;">
        <tr>
            <td align="center">
                <table width="750" cellpadding="0" cellspacing="0" style="background: #ffffff; overflow: hidden; max-width: 100%;">
                    <tr>
                        <td style="background: #09bb8a; padding: 16px; text-align: center;">
                            <img src="https://www.pokepay.com/images/ico-email-logo.png" alt="PokePay" height="40">
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px 40px 30px; color: #333; font-size: 16px; line-height: 1.6;">
                            <p style="font-size: 16px; font-weight: 600; margin: 0 0 10px;">尊敬的 PokePay 用户：</p>
                            <p style="font-size: 18px; font-weight: 600; margin: 20px 0 10px;">
                                我们收到您的请求 - <span style="color: #09bb8a;">${actionText}</span>
                            </p>
                            <p style="font-size: 15px; font-weight: 600; margin-top: 20px;">验证码</p>
                            <p>
                                <span style="background: #f7f8fa; color: #09bb8a; padding: 10px 20px; font-size: 22px; font-weight: 600; display: inline-block; border-radius: 4px;">
                                    ${code}
                                </span>
                            </p>
                            <div style="font-size: 13px; color: #999999; margin-top: 20px;">
                                <p style="line-height: 1.8; margin: 0; font-size: 13px;">验证码有效期限为10分钟</p>
                                <p style="line-height: 1.8; margin: 0; font-size: 13px;">如非本人操作，请及时登录并修改密码或者联系客服以确保账户安全。</p>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 20px 40px; text-align: left; font-size: 13px; color: #666666; border-top: 1px solid #edeff3;">
                            <p style="margin-bottom: 20px; font-size: 13px;">感谢您选择 PokePay，如有任何疑问请及时与我们联络。</p>
                            <p style="margin: 0; font-size: 13px;">PokePay 官方网址：<a href="https://pokepaycc5.com" style="color: #09bb8a; text-decoration: none;">pokepaycc5.com</a></p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background: #e6f8f3; padding: 20px 40px; font-size: 13px; color: #666666;">
                            <strong style="color: #09bb8a; font-size: 13px;">安全提示：</strong>
                            <ol style="padding-left: 20px; margin: 10px 0; line-height: 28px;">
                                <li style="font-size: 13px;">此为系统邮件，请勿回复。</li>
                                <li style="font-size: 13px;">请保管好您的邮箱，避免账号被他人盗用。</li>
                                <li style="font-size: 13px;">请注意甄别钓鱼网站，我们不会以任何名义或任何方式向用户索取密码及验证码，请妥善保管账户信息。</li>
                            </ol>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [email],
      subject: subject,
      html: html
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || '发送邮件失败');
  }

  const typeLabelMap = { reset: '找回密码', change_email: '修改邮箱' };
  console.log(`${typeLabelMap[type] || '注册'}验证码已发送到 ${email}: ${code}`);
}

// ========== 注册接口（修改） ==========
app.post('/api/register', async (req, res) => {
  const { email, password, paymentPassword, bankCode, inviteCode, verificationCode } = req.body;
  
  // 基本字段验证
  if (!email || !password || !paymentPassword || !verificationCode) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  
  // 邮箱格式验证
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }
  
  // 过滤临时邮箱
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: '请使用永久邮箱地址' });
  }
  
  // 支付密码验证
  if (paymentPassword.length !== 6 || !/^\d+$/.test(paymentPassword)) {
    return res.status(400).json({ error: '支付密码必须为6位数字' });
  }
  
  // 银行编码验证
  if (!bankCode) {
    return res.status(400).json({ error: '银行编码不能为空' });
  }
  if (bankCode !== '008') {
    return res.status(400).json({ error: '银行编码错误' });
  }
  
  // 检查邮箱是否已注册
  const existingUser = await new Promise((resolve) => {
    db.get(`SELECT uid FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
  });
  if (existingUser) {
    return res.status(400).json({ error: '该邮箱已被注册' });
  }
  
  // ========== 验证验证码 ==========
  const verification = await new Promise((resolve) => {
    db.get(
      `SELECT id, code, expires_at, is_used, attempt_count 
       FROM email_verifications 
       WHERE email = ? AND is_used = 0 
       ORDER BY created_at DESC LIMIT 1`,
      [email],
      (err, row) => resolve(row)
    );
  });

  if (!verification) {
    return res.status(400).json({ error: '验证码无效或已过期，请重新获取' });
  }

  // 检查是否过期
  const now = new Date();
  const expiresAt = new Date(verification.expires_at);
  if (now > expiresAt) {
    // 标记为已过期
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }

  // 检查尝试次数（防暴力破解）
  if (verification.attempt_count >= 5) {
    db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);
    return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
  }

  // 验证验证码是否正确
  if (verification.code !== verificationCode) {
    // 增加尝试次数
    db.run(
      `UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?`,
      [verification.id]
    );
    const remainingAttempts = 5 - (verification.attempt_count + 1);
    return res.status(400).json({ 
      error: `验证码错误，剩余尝试次数 ${remainingAttempts} 次`
    });
  }

  // ========== 验证码正确，标记已使用 ==========
  db.run(`UPDATE email_verifications SET is_used = 1 WHERE id = ?`, [verification.id]);

  // ========== 推荐码验证 ==========
  const isSuperInvite = (inviteCode === 'SUPER2024');
  let inviterId = null;

  if (inviteCode && !isSuperInvite) {
    const inviter = await new Promise((resolve) => {
      db.get(`SELECT uid FROM users WHERE invite_code = ?`, [inviteCode], (err, row) => resolve(row));
    });
    if (!inviter) {
      return res.status(400).json({ error: '推荐码无效' });
    }
    inviterId = inviter.uid;
  }

  // ========== 创建用户 ==========
  const uid = await generateUniqueUid();
  const hashedPassword = await bcrypt.hash(password, 10);
  const hashedPaymentPassword = await bcrypt.hash(paymentPassword, 10);
  const inviteCodeGenerated = await generateInviteCode();
  const clientIp = getClientIp(req);

  db.run(`INSERT INTO users (uid, email, password_hash, payment_password_hash, invite_code, invited_by, register_ip, last_login_ip) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [uid, email, hashedPassword, hashedPaymentPassword, inviteCodeGenerated, inviteCode || null, clientIp, clientIp], 
    function(err) {
      if (err) {
        console.error('注册失败:', err);
        return res.status(500).json({ error: '注册失败，请稍后重试' });
      }
      
      // 推荐人奖励
      if (inviterId && !isSuperInvite) {
        db.run(`UPDATE users SET reward_balance = reward_balance + 0.5 WHERE uid = ?`, [inviterId]);
        db.run(`INSERT INTO reward_transactions (user_id, amount, type, related_user_id, description) 
          VALUES (?, 0.5, 'earn', ?, ?)`, 
          [inviterId, uid, `推荐新用户 ${email} 注册`]);
      }
      
      console.log(`用户 ${email} 注册成功，UID: ${uid}`);
      res.json({ 
        message: '注册成功', 
        uid: uid, 
        inviteCode: inviteCodeGenerated 
      });
    }
  );
});

// ========== 启动 KYC 同步任务 ==========
startKYCSync(); 

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  🚀 服务已启动`);
  console.log(`  🌐 前台地址: http://localhost:${PORT}`);
  console.log(`  🔐 后台地址: http://localhost:${PORT}/admin`);
  console.log(`  🌍 当前网络: ${NETWORK === 'mainnet' ? '主网' : 'Shasta 测试网'}`);
  console.log(`  🔑 超级邀请码: SUPER2024`);
  console.log(`  🪪 Didit 直连KYC: ${(process.env.DIDIT_API_KEY && process.env.DIDIT_WORKFLOW_ID) ? '已配置' : '⚠️ 未配置(DIDIT_API_KEY/DIDIT_WORKFLOW_ID)'}`);
  console.log(`  🪝 Didit Webhook 密钥: ${process.env.DIDIT_WEBHOOK_SECRET ? '已配置' : '⚠️ 未配置(DIDIT_WEBHOOK_SECRET)'}`);
  console.log(`========================================\n`);
});
