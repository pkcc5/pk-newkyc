/**
 * init.js
 * 初始化脚本 - 创建管理员账号和测试数据
 * 使用方法: node init.js
 * 
 * 功能：
 * 1. 创建默认管理员账号
 * 2. 创建超级邀请码用户
 * 3. 设置默认归集地址（可选）
 * 4. 显示系统状态
 */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const DB_PATH = process.env.DATABASE_PATH || './tron_demo.db';
const db = new sqlite3.Database(DB_PATH);

console.log('========================================');
console.log('  TRON 会员系统初始化脚本');
console.log('========================================\n');

// 生成随机邀请码
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 创建管理员账号
async function createAdmin() {
  return new Promise(async (resolve) => {
    const adminUsername = 'admin';
    const adminPassword = 'admin123';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    
    db.run(`INSERT OR REPLACE INTO admins (username, password_hash, created_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)`, 
      [adminUsername, hashedPassword], 
      function(err) {
        if (err) {
          console.log('❌ 创建管理员失败:', err.message);
        } else {
          console.log('✅ 管理员账号创建/更新成功');
          console.log(`   用户名: ${adminUsername}`);
          console.log(`   密码: ${adminPassword}`);
        }
        resolve();
      }
    );
  });
}

// 创建测试用户（使用超级邀请码）
async function createTestUser() {
  return new Promise(async (resolve) => {
    const email = 'test@example.com';
    const password = '123456';
    const hashedPassword = await bcrypt.hash(password, 10);
    const inviteCode = generateInviteCode();
    
    db.get(`SELECT id FROM users WHERE email = ?`, [email], async (err, existing) => {
      if (existing) {
        console.log('⚠️ 测试用户已存在，跳过创建');
        resolve();
        return;
      }
      
      db.run(`INSERT INTO users (email, password_hash, invite_code) 
              VALUES (?, ?, ?)`, 
        [email, hashedPassword, inviteCode],
        function(err) {
          if (err) {
            console.log('❌ 创建测试用户失败:', err.message);
          } else {
            console.log('✅ 测试用户创建成功');
            console.log(`   邮箱: ${email}`);
            console.log(`   密码: ${password}`);
            console.log(`   邀请码: ${inviteCode}`);
          }
          resolve();
        }
      );
    });
  });
}

// 检查并初始化系统设置
async function initSettings() {
  return new Promise((resolve) => {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('collect_address', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('collect_threshold', '10')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_rate', '7.8')`);
    console.log('✅ 系统设置初始化完成');
    resolve();
  });
}

// 显示数据库统计
async function showStats() {
  return new Promise((resolve) => {
    db.get(`SELECT COUNT(*) as total FROM users`, [], (err, userCount) => {
      db.get(`SELECT COUNT(*) as total FROM wallets`, [], (err, walletCount) => {
        db.get(`SELECT COUNT(*) as total FROM admins`, [], (err, adminCount) => {
          console.log('\n========================================');
          console.log('  📊 数据库统计');
          console.log('========================================');
          console.log(`   用户数量: ${userCount?.total || 0}`);
          console.log(`   钱包数量: ${walletCount?.total || 0}`);
          console.log(`   管理员数量: ${adminCount?.total || 0}`);
          console.log('========================================\n');
          resolve();
        });
      });
    });
  });
}

// 主函数
async function main() {
  console.log('开始初始化...\n');
  
  await initSettings();
  await createAdmin();
  await createTestUser();
  await showStats();
  
  console.log('初始化完成！');
  console.log('\n提示:');
  console.log('  1. 使用 admin/admin123 登录管理后台');
  console.log('  2. 使用 test@example.com/123456 登录用户前台');
  console.log('  3. 超级邀请码: SUPER2024 (可用于注册新用户)');
  console.log('  4. 如需清空数据，可执行: rm tron_demo.db');
  
  db.close();
}

main();
