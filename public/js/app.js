// public/js/app.js - 完整版（含 KYC 一键跳转、卡片关联、卡片提现，移动端兼容版）

// ============= 全局变量 =============
let currentUser = null;
let currentTab = 'home';
let userWallet = null;
let userPrivateKey = null;
let userAssets = null;
let userInviteCode = null;
let userHKD = 0;
let userVUSDT = 0;
let userChainUSDT = 0;
let userBankCards = [];
let userKYCStatus = 'pending';
let userHasPaymentPassword = false; // ========== 新增：支付密码是否已设置 ==========
let allRecords = [];
let isWalletFrozenStatus = false;
// ========== 验证码相关变量 ==========
let countdownTimer = null;
let countdownSeconds = 60;
let isSendingCode = false;
// 手续费配置缓存
let userFeeConfig = null;

// ========== SSE 通知连接 ==========
let sseConnection = null;

// 预加载的数据缓存
let preloadedData = {
    totalData: null,
    flowRecords: null,
    userDataLoaded: false,
    assets: null
};

// 页面 HTML 缓存
let pageCache = {
    home: null,
    card: null,
    profile: null
};
// ============= 北京时间转换函数 =============
function toBeijingTime(dateStr) {
    if (!dateStr) return '-';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
        return dateStr;
    }
    const date = new Date(dateStr);
    date.setHours(date.getHours() + 8);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ============= 加载动画控制 =============
function showLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
}

// ============= API 请求封装 =============
async function fetchAPI(url, options = {}) {
    try {
        const defaultOptions = { headers: { 'Content-Type': 'application/json' } };
        const mergedOptions = { ...defaultOptions, ...options };
        if (mergedOptions.body && typeof mergedOptions.body === 'object') {
            mergedOptions.body = JSON.stringify(mergedOptions.body);
        }
        const res = await fetch(url, mergedOptions);
        return await res.json();
    } catch (e) {
        console.error(`API Error ${url}:`, e);
        return null;
    }
}

// ============= 预加载所有数据 =============
async function preloadAllData() {
    console.log('开始预加载数据...');
    
    const [totalData, flowData, userInfo, walletData, cardsData, assetsData] = await Promise.all([
        fetchAPI('/api/total-assets'),
        fetchAPI('/api/fund-flow'),
        fetchAPI('/api/user-info'),
        fetchAPI('/api/get-wallet'),
        fetchAPI('/api/bank-cards'),
        fetchAPI('/api/assets')
    ]);
    
    preloadedData.totalData = totalData || { totalHKD: '0.00' };
    preloadedData.flowRecords = (flowData && flowData.records) ? flowData.records : [];
    preloadedData.userDataLoaded = true;
    preloadedData.assets = assetsData;
    
    if (userInfo) {
        userHKD = userInfo.hkdBalance || 0;
        userVUSDT = userInfo.vusdtBalance || 0;
        userInviteCode = userInfo.inviteCode;
        userKYCStatus = userInfo.kycStatus || 'pending';
        userHasPaymentPassword = !!userInfo.hasPaymentPassword;
    }
    
    if (walletData && walletData.hasWallet) {
        userWallet = walletData.address;
        userPrivateKey = walletData.private_key;
        console.log('预加载完成，钱包地址:', userWallet);
    }
    
    updateSupportUnreadBadge(); // ========== 新增：预加载时顺带刷新客服未读角标 ==========
    checkAndShowSupportPopup(); // ========== 新增：如果有未读客服消息，自动弹窗提醒 ==========
    
    console.log('预加载完成');
}

// ========== SSE 通知监听 ==========
function setupSSE() {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
  
  sseConnection = new EventSource('/api/notifications/sse');
  
  sseConnection.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'support') {
        if (!isSupportPageOpen()) {
          // 用户不在客服页面，弹跟"打开App"一样的大模态框，保持提醒体验一致
          checkAndShowSupportPopup();
        }
        // 如果正好在客服页面，页面自身的5秒轮询会自动把消息显示出来，不需要额外提醒
        updateSupportUnreadBadge();
      } else {
        showDepositNotification(data);
      }
    } catch(e) {
      console.log('解析通知失败:', e);
    }
  };
  
  sseConnection.onerror = function() {
    setTimeout(setupSSE, 5000);
  };
}

// ========== 新增：App从后台切回前台时，补检查连接状态和遗漏的未读消息 ==========
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!currentUser) return; // 未登录不处理

  // 连接可能在后台被系统挂起、网络中断时悄悄断掉，切回前台时确认一下，断了就重连
  if (!sseConnection || sseConnection.readyState === EventSource.CLOSED) {
    setupSSE();
  }

  // 不管连接有没有断过，都补查一次未读消息，避免中途错过的提醒漏掉
  checkAndShowSupportPopup();
  updateSupportUnreadBadge();
});

// ========== 新增：判断当前是否正停留在客服聊天页面 ==========
function isSupportPageOpen() {
  const modal = document.getElementById('dynamicModal');
  if (!modal || modal.classList.contains('hidden')) return false;
  return !!document.getElementById('supportMessagesContainer');
}

// ========== 新增结束 ==========
// ========== 新增：更新"客服"菜单角标 ==========
async function updateSupportUnreadBadge() {
  const data = await fetchAPI('/api/support/unread-count');
  const badge = document.getElementById('supportMenuBadge');
  if (!badge) return;
  const count = data?.count || 0;
  if (count > 0) {
    badge.style.display = 'inline-block';
    badge.innerText = count > 99 ? '99+' : count;
  } else {
    badge.style.display = 'none';
  }
}
// ========== 新增结束 ==========

// ========== 新增：App打开时自动弹出最新未读客服消息（复用现有的 dynamicModal） ==========
async function checkAndShowSupportPopup() {
  const data = await fetchAPI('/api/support/latest-unread');
  if (!data || !data.hasUnread) return;

  document.getElementById('dynamicModalContent').innerHTML = `
    <div style="text-align:center; padding: 8px 0 16px;">
      <div style="font-size: 32px; margin-bottom: 8px;">💬</div>
      <div style="font-weight: 600; font-size: 15px; margin-bottom: 12px;">您有一条新的客服回复</div>
      <div style="background: var(--bg-secondary, #f5f5f7); border-radius: 10px; padding: 12px 14px; text-align: left; font-size: 13px; line-height: 1.6; max-height: 160px; overflow-y: auto;">
        ${escapeHtmlSafe(data.message)}
      </div>
      <div style="font-size: 11px; color: var(--text-muted, #888); margin-top: 8px;">${data.createdAt || ''}</div>
    </div>
    <button class="btn btn-primary" style="width:100%;" onclick="closeModal(); navigateTo('support');">查看完整对话</button>
  `;
  showModal();
}

// 简单转义，避免消息内容里有特殊字符破坏弹窗结构
function escapeHtmlSafe(text) {
  const div = document.createElement('div');
  div.innerText = text || '';
  return div.innerHTML;
}
// ========== 新增结束 ==========

// ========== 充值到账弹窗（复用流水详情样式） ==========
function showDepositNotification(data) {
  const amount = data.amount || '0';
  
  const record = {
    amount: parseFloat(amount),
    currency: 'HKD',
    type: 'deposit',
    from_address: 'Poke国际',
    to_address: currentUser?.uid || '用户',
    created_at: new Date().toLocaleString(),
    status: 'completed'
  };
  
  showTransactionDetail(record);
}

// ============= 刷新用户数据 =============
async function refreshUserData() {
    const [userInfo, walletData, walletStatus] = await Promise.all([
        fetchAPI('/api/user-info'),
        fetchAPI('/api/get-wallet'),
        fetchAPI('/api/user/wallet-status')  // 新增：获取管理员冻结状态
    ]);
    
    if (userInfo) {
        userHKD = userInfo.hkdBalance || 0;
        userVUSDT = userInfo.vusdtBalance || 0;
        userInviteCode = userInfo.inviteCode;
        userKYCStatus = userInfo.kycStatus || 'pending';
        userHasPaymentPassword = !!userInfo.hasPaymentPassword;
    }
    
    if (walletData && walletData.hasWallet) {
        userWallet = walletData.address;
        userPrivateKey = walletData.private_key;
        console.log('刷新钱包:', userWallet);
    } else {
        userWallet = null;
        userPrivateKey = null;
    }
    
    // 新增：更新管理员冻结状态
    if (walletStatus) {
        isWalletFrozenStatus = walletStatus.frozen === true;
        console.log('管理员冻结状态:', isWalletFrozenStatus);
    }
    // 清除手续费缓存
    userFeeConfig = null;
    
    pageCache = { home: null, card: null, profile: null };
}

// ============= 加载用户数据 =============
async function loadUserData() {
    const [userInfo, walletData] = await Promise.all([
        fetchAPI('/api/user-info'),
        fetchAPI('/api/get-wallet')
    ]);
    
    if (userInfo) {
        userHKD = userInfo.hkdBalance || 0;
        userVUSDT = userInfo.vusdtBalance || 0;
        userInviteCode = userInfo.inviteCode;
        userKYCStatus = userInfo.kycStatus || 'pending';
        userHasPaymentPassword = !!userInfo.hasPaymentPassword;
    }
    
    if (walletData && walletData.hasWallet) {
        userWallet = walletData.address;
        userPrivateKey = walletData.private_key;
        console.log('钱包已加载:', userWallet);
    } else {
        userWallet = null;
        userPrivateKey = null;
        console.log('用户没有钱包');
    }
    
    return { userHKD, userVUSDT, userWallet, userInviteCode, userPrivateKey };
}

// ============= 登录 =============
async function handleLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
        alert('请填写邮箱和密码');
        return;
    }
    const data = await fetchAPI('/api/login', { method: 'POST', body: { email, password } });
    if (data && data.message === '登录成功') {
        await checkSession();
    } else {
        // ========== 改为自定义弹窗 ==========
        // 把后端返回的真实错误文案传进去，而不是不管什么原因都显示"密码错误"——
        // 比如账户已注销时，后端返回的是"该账户已注销"，这种情况引导用户去"重置密码"
        // 也没用（账户注销后无法找回密码），所以这里连按钮文案也一并区分开。
        showLoginErrorModal(data && data.error);
        // ========== 修改结束 ==========
    }
}

// ========== 登录错误弹窗 ==========
function showLoginErrorModal(errorMessage) {
    const existing = document.getElementById('loginErrorModal');
    if (existing) existing.remove();

    const isDeleted = errorMessage === '该账户已注销';
    const displayMessage = errorMessage || '邮箱或密码错误';
    const hintHtml = isDeleted
        ? '该账户已自助注销，无法登录，如需恢复请联系客服'
        : '如果您已忘记密码，请重置';
    const actionButtonHtml = isDeleted
        ? `<button onclick="closeLoginErrorModal(); showSupportPage(true);" style="flex: 1; padding: 12px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#18ac94'" onmouseout="this.style.background='#21c592'">
                联系客服
            </button>`
        : `<button onclick="closeLoginErrorModal(); showForgotPasswordModal();" style="flex: 1; padding: 12px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#18ac94'" onmouseout="this.style.background='#21c592'">
                重置密码
            </button>`;

    const modalHtml = `
    <div id="loginErrorModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;" onclick="if(event.target===this) closeLoginErrorModal()">
        <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 28px 24px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;">
            <div style="font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px;">❌ 登录失败</div>
            <div style="font-size: 14px; color: #666; margin-bottom: 12px; line-height: 1.6;">
                ${displayMessage}<br>
                ${hintHtml}
            </div>
            <div style="display: flex; gap: 12px; margin-top: 8px;">
                ${actionButtonHtml}
                <button onclick="closeLoginErrorModal()" style="flex: 1; padding: 12px; background: #f0f2f5; color: #666; border: none; border-radius: 12px; font-size: 15px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">
                    关闭
                </button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeLoginErrorModal() {
    const modal = document.getElementById('loginErrorModal');
    if (modal) modal.remove();
}

// ============= 辅助函数 =============
function isValidEmail(email) {
    // 更严格的邮箱正则
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
}

// ========== 验证码功能 ==========

// ========== 发送验证码 ==========
async function sendVerificationCode() {
  const emailInput = document.getElementById('regEmail');
  const email = emailInput.value.trim();
  const sendBtn = document.getElementById('sendVerificationBtn');
  
  if (isSendingCode) return;
  
  if (!email) {
    alert('请输入邮箱地址');
    emailInput.focus();
    return;
  }
  
  if (!isValidEmail(email)) {
    alert('请输入正确的邮箱地址');
    emailInput.focus();
    return;
  }
  
  isSendingCode = true;
  sendBtn.disabled = true;
  sendBtn.innerText = '发送中...';
  sendBtn.style.opacity = '0.6';
  
  try {
    const data = await fetchAPI('/api/send-verification', {
      method: 'POST',
      body: { email, type: 'register' }
    });
    
    if (data && data.success) {
      alert('✅ 验证码已发送到您的邮箱，请查收');
      startCountdown(sendBtn);
    } else {
      // 恢复按钮
      isSendingCode = false;
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
      sendBtn.style.opacity = '1';
      
      // ========== 检查是否是邮箱已注册 ==========
      if (data && data.code === 'EMAIL_REGISTERED') {
        showEmailRegisteredModal();
        return;
      }
      // ========== 检查结束 ==========
      
      // 其他错误
      if (data && data.error) {
        alert('❌ ' + data.error);
        if (data.error.includes('更换邮箱') || data.error.includes('永久邮箱')) {
          emailInput.focus();
        }
      } else {
        alert('❌ 验证码发送失败，请稍后重试或更换邮箱');
      }
    }
  } catch(e) {
    isSendingCode = false;
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
    sendBtn.style.opacity = '1';
    alert('❌ 网络请求失败，请检查网络连接');
  }
}

// ========== 邮箱已注册弹窗 ==========
function showEmailRegisteredModal() {
  const existing = document.getElementById('emailRegisteredModal');
  if (existing) existing.remove();
  
  const modalHtml = `
  <div id="emailRegisteredModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;" onclick="if(event.target===this) closeEmailRegisteredModal()">
    <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 32px 24px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;">
      <div style="font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 12px;">此邮箱已被注册</div>
      <div style="font-size: 14px; color: #666; margin-bottom: 24px; line-height: 1.6;">请直接登录</div>
      <button onclick="closeEmailRegisteredModal(); showLoginForm();" style="width: 100%; padding: 14px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#18ac94'" onmouseout="this.style.background='#21c592'">
        立即登录
      </button>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeEmailRegisteredModal() {
  const modal = document.getElementById('emailRegisteredModal');
  if (modal) modal.remove();
}

// 倒计时
function startCountdown(btn) {
  let seconds = 60;
  btn.innerText = `${seconds}秒后重新获取`;
  btn.style.opacity = '0.6';
  
  if (countdownTimer) clearInterval(countdownTimer);
  
  countdownTimer = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      isSendingCode = false;
      btn.disabled = false;
      btn.innerText = '重新获取';
      btn.style.opacity = '1';
    } else {
      btn.innerText = `${seconds}秒后重新获取`;
    }
  }, 1000);
}

// 重置验证码按钮（邮箱变化时调用）
function resetVerificationButton() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const sendBtn = document.getElementById('sendVerificationBtn');
  if (sendBtn) {
    isSendingCode = false;
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
    sendBtn.style.opacity = '1';
  }
}

// ============= 注册 =============
async function handleRegister() {
    const email = document.getElementById('regEmail').value.trim();
    const verificationCode = document.getElementById('regVerificationCode').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;
    const bankCode = document.getElementById('regBankCode').value.trim();
    const inviteCode = document.getElementById('regInviteCode').value.trim();
    const agreeTerms = document.getElementById('regAgreeTerms').checked;
    
    // 检查是否为空
    if (!email || !verificationCode || !password || !confirmPassword) {
        alert('请填写完整信息');
        return;
    }
    
    // 同意协议验证
    if (!agreeTerms) {
        alert('请先阅读并同意《隐私协议》和《服务协议》');
        return;
    }
    
    // 邮箱格式验证
    if (!isValidEmail(email)) {
        alert('请输入正确的邮箱地址');
        return;
    }

    // 验证码验证
    if (verificationCode.length !== 6 || !/^\d+$/.test(verificationCode)) {
        alert('请输入6位数字验证码');
        return;
    }

    // 密码验证
    if (password.length < 6) {
        alert('密码至少6位');
        return;
    }
    
    // 确认密码验证
    if (password !== confirmPassword) {
        alert('两次输入的密码不一致');
        return;
    }

    // 银行编码验证
    if (!bankCode) {
        alert('银行编码不能为空');
        return;
    }
    if (bankCode !== '008') {
        alert('银行编码错误');
        return;
    }
    
    const finalInviteCode = inviteCode || null;

    const data = await fetchAPI('/api/register', { 
        method: 'POST', 
        body: { 
            email, 
            password, 
            bankCode,
            inviteCode: finalInviteCode,
            verificationCode: verificationCode
        } 
    });
    
    if (data && data.message === '注册成功') {
        alert('注册成功，请登录');
        // 清空注册表单
        document.getElementById('regEmail').value = '';
        document.getElementById('regVerificationCode').value = '';
        document.getElementById('regPassword').value = '';
        document.getElementById('regConfirmPassword').value = '';
        document.getElementById('regBankCode').value = '';
        document.getElementById('regInviteCode').value = '';
        document.getElementById('regAgreeTerms').checked = false;
        // 重置验证码按钮
        resetVerificationButton();
        showLoginForm();
    } else {
        alert(data?.error || '注册失败');
    }
}

// ========== 找回密码功能 ==========

let resetCountdownTimer = null;

// 显示找回密码弹窗
function showForgotPasswordModal() {
  const modalHtml = `
  <div id="forgotPasswordModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;" onclick="if(event.target===this) closeForgotPasswordModal()">
    <div style="background: white; border-radius: 24px; max-width: 440px; width: 92%; padding: 28px 24px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-height: 90vh; overflow-y: auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h3 style="font-size: 20px; color: #1a1a2e;">🔐 找回密码</h3>
        <button onclick="closeForgotPasswordModal()" style="background: none; border: none; font-size: 24px; color: #999; cursor: pointer;">×</button>
      </div>
      
      <div id="resetStep1">
        <div class="input-group">
          <label class="input-label">邮箱</label>
          <div style="display: flex; gap: 10px; align-items: center;">
            <input type="email" id="resetEmail" class="input-field" placeholder="请输入您的邮箱" style="flex: 1; min-width: 0;">
            <button id="sendResetCodeBtn" style="padding: 10px 16px; white-space: nowrap; font-size: 13px; background: #21c592; color: white; border: none; border-radius: 8px; cursor: pointer; min-width: 100px; flex-shrink: 0;">
              获取验证码
            </button>
          </div>
        </div>
        <div class="input-group" style="margin-top: 12px;">
          <label class="input-label">验证码</label>
          <input type="text" id="resetVerificationCode" class="input-field" placeholder="请输入6位验证码" maxlength="6" inputmode="numeric">
        </div>
        <button id="confirmResetBtn" class="btn btn-primary" style="width: 100%; margin-top: 16px; padding: 14px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer;">
          下一步
        </button>
      </div>

      <div id="resetStep2" style="display: none;">
        <div style="font-size: 14px; color: #21c592; margin-bottom: 16px; padding: 10px 12px; background: #f0fdf9; border-radius: 8px;">
          ✅ 验证码校验成功，请设置您的新登录密码
        </div>
        <div class="input-group">
          <label class="input-label">新登录密码</label>
          <input type="password" id="resetNewPassword" class="input-field" placeholder="请输入至少6位新登录密码" autocomplete="new-password">
        </div>
        <div class="input-group" style="margin-top: 12px;">
          <label class="input-label">确认新登录密码</label>
          <input type="password" id="resetNewPasswordConfirm" class="input-field" placeholder="请再次输入新登录密码" autocomplete="new-password">
        </div>
        <div style="font-size: 13px; color: #999; margin-top: 10px;">
          说明：此操作仅重置登录密码，您的支付密码不会被改动。
        </div>
        <button id="submitNewPasswordBtn" class="btn btn-primary" style="width: 100%; margin-top: 16px; padding: 14px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer;">
          确认修改密码
        </button>
      </div>
      
      <div id="resetStep3" style="display: none; text-align: center; padding: 20px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
        <div style="font-size: 18px; font-weight: 700; color: #21c592; margin-bottom: 12px;">登录密码修改成功</div>
        <div style="font-size: 15px; color: #333; line-height: 1.8; text-align: left; padding: 0 10px;">
          您的登录密码已修改成功，支付密码未发生变化。
        </div>
        <button id="resetDoneBtn" class="btn btn-primary" style="width: 100%; margin-top: 20px; padding: 14px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer;">
          我知道了
        </button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  
  // 绑定事件
  document.getElementById('sendResetCodeBtn').addEventListener('click', sendResetCode);
  document.getElementById('confirmResetBtn').addEventListener('click', verifyResetCode);
  document.getElementById('submitNewPasswordBtn').addEventListener('click', confirmResetPassword);
  document.getElementById('resetDoneBtn').addEventListener('click', function() {
    closeForgotPasswordModal();
    // 跳转到登录页
    showLoginForm();
  });
  
  // Enter键支持
  document.getElementById('resetVerificationCode').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      verifyResetCode();
    }
  });
  document.getElementById('resetNewPasswordConfirm').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      confirmResetPassword();
    }
  });
}

function closeForgotPasswordModal() {
  const modal = document.getElementById('forgotPasswordModal');
  if (modal) modal.remove();
  if (resetCountdownTimer) {
    clearInterval(resetCountdownTimer);
    resetCountdownTimer = null;
  }
}

// 发送找回密码验证码
async function sendResetCode() {
  const emailInput = document.getElementById('resetEmail');
  const email = emailInput.value.trim();
  const sendBtn = document.getElementById('sendResetCodeBtn');
  
  if (!email) {
    alert('请输入邮箱地址');
    emailInput.focus();
    return;
  }
  
  if (!isValidEmail(email)) {
    alert('请输入正确的邮箱地址');
    emailInput.focus();
    return;
  }
  
  // 禁用按钮
  sendBtn.disabled = true;
  sendBtn.innerText = '发送中...';
  sendBtn.style.opacity = '0.6';
  
  try {
    const data = await fetchAPI('/api/send-verification', {
      method: 'POST',
      body: { email, type: 'reset' }
    });
    
    if (data && data.success) {
      alert('✅ 找回密码验证码已发送到您的邮箱，请查收');
      startResetCountdown(sendBtn);
    } else {
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
      sendBtn.style.opacity = '1';
      alert('❌ ' + (data?.error || '验证码发送失败，请稍后重试'));
    }
  } catch(e) {
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
    sendBtn.style.opacity = '1';
    alert('❌ 网络请求失败，请检查网络连接');
  }
}

// 找回密码倒计时
function startResetCountdown(btn) {
  let seconds = 60;
  btn.innerText = `${seconds}秒后重新获取`;
  btn.style.opacity = '0.6';
  
  if (resetCountdownTimer) clearInterval(resetCountdownTimer);
  
  resetCountdownTimer = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(resetCountdownTimer);
      resetCountdownTimer = null;
      btn.disabled = false;
      btn.innerText = '重新获取';
      btn.style.opacity = '1';
    } else {
      btn.innerText = `${seconds}秒后重新获取`;
    }
  }, 1000);
}

// 暂存已通过校验的邮箱与验证码，供设置新密码时使用
let verifiedResetEmail = '';
let verifiedResetCode = '';

// 第一步：校验验证码是否正确，正确后进入设置新密码环节
async function verifyResetCode() {
  const email = document.getElementById('resetEmail').value.trim();
  const code = document.getElementById('resetVerificationCode').value.trim();
  const confirmBtn = document.getElementById('confirmResetBtn');
  
  if (!email) {
    alert('请输入邮箱地址');
    return;
  }
  
  if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
    alert('请输入6位数字验证码');
    return;
  }
  
  confirmBtn.disabled = true;
  confirmBtn.innerText = '验证中...';
  confirmBtn.style.opacity = '0.6';
  
  try {
    const data = await fetchAPI('/api/verify-reset-code', {
      method: 'POST',
      body: { email, verificationCode: code }
    });
    
    if (data && data.success) {
      // 记住已通过校验的邮箱和验证码，进入设置新密码环节
      verifiedResetEmail = email;
      verifiedResetCode = code;
      document.getElementById('resetStep1').style.display = 'none';
      document.getElementById('resetStep2').style.display = 'block';
    } else {
      confirmBtn.disabled = false;
      confirmBtn.innerText = '下一步';
      confirmBtn.style.opacity = '1';
      alert('❌ ' + (data?.error || '验证失败，请稍后重试'));
    }
  } catch(e) {
    confirmBtn.disabled = false;
    confirmBtn.innerText = '下一步';
    confirmBtn.style.opacity = '1';
    alert('❌ 网络请求失败，请检查网络连接');
  }
}

// 第二步：提交用户自行设置的新登录密码（不涉及支付密码）
async function confirmResetPassword() {
  const newPassword = document.getElementById('resetNewPassword').value;
  const newPasswordConfirm = document.getElementById('resetNewPasswordConfirm').value;
  const submitBtn = document.getElementById('submitNewPasswordBtn');
  
  if (!newPassword || newPassword.length < 6) {
    alert('新登录密码至少6位');
    return;
  }
  
  if (newPassword !== newPasswordConfirm) {
    alert('两次输入的新登录密码不一致');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.innerText = '提交中...';
  submitBtn.style.opacity = '0.6';
  
  try {
    const data = await fetchAPI('/api/reset-password', {
      method: 'POST',
      body: { email: verifiedResetEmail, verificationCode: verifiedResetCode, newPassword }
    });
    
    if (data && data.success) {
      // 切换到成功页面
      document.getElementById('resetStep2').style.display = 'none';
      document.getElementById('resetStep3').style.display = 'block';
    } else {
      submitBtn.disabled = false;
      submitBtn.innerText = '确认修改密码';
      submitBtn.style.opacity = '1';
      alert('❌ ' + (data?.error || '修改失败，请稍后重试'));
    }
  } catch(e) {
    submitBtn.disabled = false;
    submitBtn.innerText = '确认修改密码';
    submitBtn.style.opacity = '1';
    alert('❌ 网络请求失败，请检查网络连接');
  }
}

// ============= 通告功能 =============

// ========== 修改：通告从"每天弹一次"改为"每天最多弹三次，且两次之间间隔一定时间" ==========
const ANNOUNCEMENT_MAX_PER_DAY = 3;                     // 每天最多弹出次数，需要调整就改这里
const ANNOUNCEMENT_MIN_INTERVAL_MS = 5 * 60 * 60 * 1000; // 两次弹出之间至少间隔的时间（毫秒），当前是5小时

async function checkAndShowAnnouncement() {
  try {
    const data = await fetchAPI('/api/announcement');
    if (data && data.success && data.hasAnnouncement && data.content) {
      const today = new Date().toLocaleDateString();
      
      let state = {};
      try {
        state = JSON.parse(localStorage.getItem('announcement_show_state') || '{}');
      } catch(e) { state = {}; }
      
      // 跨天了，重置计数
      if (state.date !== today) {
        state = { date: today, count: 0, lastShown: 0 };
      }
      
      const now = Date.now();
      if (state.count >= ANNOUNCEMENT_MAX_PER_DAY) return;                          // 今天已经弹够次数了
      if (state.lastShown && (now - state.lastShown) < ANNOUNCEMENT_MIN_INTERVAL_MS) return; // 离上次弹出还没到间隔时间
      
      state.count += 1;
      state.lastShown = now;
      localStorage.setItem('announcement_show_state', JSON.stringify(state));
      
      showAnnouncementModal(data.content);
    }
  } catch(e) {
    console.log('检查通告失败:', e);
  }
}
// ========== 修改结束 ==========

function showAnnouncementModal(content, fromBell = false) {
  // 移除已存在的弹窗
  const existing = document.getElementById('announcementModal');
  if (existing) existing.remove();
  
  const modalHtml = `
  <div id="announcementModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
    <div style="background: white; border-radius: 24px; max-width: 440px; width: 90%; padding: 28px 24px 20px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
      <button onclick="closeAnnouncementModal(${fromBell})" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>
      
      <div style="text-align: center; margin-bottom: 12px;">
        <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
        <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
      </div>
      
      <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>
      
      <div style="font-size: 15px; line-height: 1.8; color: #333; white-space: pre-wrap; text-align: left; padding: 4px 0 8px;">${content}</div>
      
      <div style="margin-top: 20px; text-align: center;">
        <button onclick="closeAnnouncementModal(${fromBell})" style="background: #21c592; color: white; border: none; border-radius: 12px; padding: 10px 48px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">我知道了</button>
      </div>
    </div>
  </div>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
  </style>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeAnnouncementModal(fromBell = false) {
  const modal = document.getElementById('announcementModal');
  if (modal) {
    modal.remove();
    // ========== 修改：计数改为在"弹出时"记录（见 checkAndShowAnnouncement），这里不再需要处理 ==========
  }
}

// ========== 新增：输入完整卡号的弹窗（跟公告弹窗同一套 Poke 风格，替代原来的系统 prompt()） ==========
// 返回一个 Promise：用户点"确认"且格式校验通过 → resolve(卡号字符串)；点"取消"/关闭 → resolve(null)
function showCardNumberModal({ title = '绑定国际卡', subtitle = '请输入完整卡号完成绑定' } = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById('cardNumberModal');
    if (existing) existing.remove();

    const modalHtml = `
    <div id="cardNumberModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
      <div style="background: white; border-radius: 24px; max-width: 400px; width: 88%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
        <button id="cardNumberModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

        <div style="text-align: center; margin-bottom: 12px;">
          <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
          <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
        </div>
        <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

        <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">${escapeHtml(title)}</div>
        <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">${escapeHtml(subtitle)}</div>

        <input id="cardNumberModalInput" type="text" inputmode="numeric" maxlength="19" placeholder="请输入完整卡号" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 1px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <div id="cardNumberModalError" style="color: #ef4444; font-size: 12px; margin-top: 6px; min-height: 16px;"></div>

        <div style="margin-top: 16px; display: flex; gap: 10px;">
          <button id="cardNumberModalCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
          <button id="cardNumberModalConfirm" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认</button>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('cardNumberModal');
    const input = document.getElementById('cardNumberModalInput');
    const errorEl = document.getElementById('cardNumberModalError');
    input.focus();

    function cleanup(value) {
      modal.remove();
      resolve(value);
    }

    document.getElementById('cardNumberModalClose').onclick = () => cleanup(null);
    document.getElementById('cardNumberModalCancel').onclick = () => cleanup(null);
    document.getElementById('cardNumberModalConfirm').onclick = () => {
      const val = input.value.trim();
      if (!val || !/^\d{12,19}$/.test(val)) {
        errorEl.textContent = '请输入正确的完整卡号（12-19位数字）';
        return;
      }
      cleanup(val);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('cardNumberModalConfirm').click();
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cleanup(null);
    });
  });
}

// ========== 新增：完整卡号查询接口暂时查不出来，临时改为让用户自己填 卡ID + 卡号后4位 + 姓名拼音 ==========
// 后端会核对"卡ID对应卡片的后四位"是否与用户填的后四位一致，一致才放行进入 KYC；
// 姓名拼音同时作为这张卡在本产品里显示的持卡人姓名（Didit KYC 本身不再参与这个环节，见后端注释）。
function showCardBindInputModal({ title = '绑定国际卡', subtitle = '请填写卡片信息，完成后将跳转 KYC 认证' } = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById('cardBindInputModal');
    if (existing) existing.remove();

    const modalHtml = `
    <div id="cardBindInputModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
      <div style="background: white; border-radius: 24px; max-width: 400px; width: 88%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
        <button id="cardBindInputModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

        <div style="text-align: center; margin-bottom: 12px;">
          <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
          <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
        </div>
        <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

        <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">${escapeHtml(title)}</div>
        <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">${escapeHtml(subtitle)}</div>

        <input id="cardBindInputCardId" type="text" inputmode="numeric" maxlength="20" placeholder="卡ID" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; outline: none; transition: border-color 0.2s; margin-bottom: 10px;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <input id="cardBindInputLast4" type="text" inputmode="numeric" maxlength="4" placeholder="卡号后4位" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 2px; outline: none; transition: border-color 0.2s; margin-bottom: 10px;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <input id="cardBindInputName" type="text" maxlength="50" placeholder="姓名拼音（如 ZHANG WEI）" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <div id="cardBindInputError" style="color: #ef4444; font-size: 12px; margin-top: 6px; min-height: 16px;"></div>

        <div style="margin-top: 16px; display: flex; gap: 10px;">
          <button id="cardBindInputCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
          <button id="cardBindInputConfirm" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认</button>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('cardBindInputModal');
    const cardIdInput = document.getElementById('cardBindInputCardId');
    const last4Input = document.getElementById('cardBindInputLast4');
    const nameInput = document.getElementById('cardBindInputName');
    const errorEl = document.getElementById('cardBindInputError');
    cardIdInput.focus();

    function cleanup(value) {
      modal.remove();
      resolve(value);
    }

    document.getElementById('cardBindInputModalClose').onclick = () => cleanup(null);
    document.getElementById('cardBindInputCancel').onclick = () => cleanup(null);
    document.getElementById('cardBindInputConfirm').onclick = () => {
      const cardId = cardIdInput.value.trim();
      const last4 = last4Input.value.trim();
      const pinyinName = nameInput.value.trim();

      if (!cardId || !/^\d+$/.test(cardId)) {
        errorEl.textContent = '请输入正确的卡ID（纯数字）';
        return;
      }
      if (!last4 || !/^\d{4}$/.test(last4)) {
        errorEl.textContent = '请输入正确的卡号后4位';
        return;
      }
      if (!pinyinName) {
        errorEl.textContent = '请输入姓名拼音';
        return;
      }
      cleanup({ cardId, last4, pinyinName });
    };
    [cardIdInput, last4Input, nameInput].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('cardBindInputConfirm').click();
      });
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cleanup(null);
    });
  });
}
// ========== 新增：KYC 前置——收集真实英文姓名的弹窗（同一套 Poke 风格）==========
// 返回 Promise：确认 → resolve({firstName, lastName})；取消/关闭 → resolve(null)
function showKycNameModal() {
  return new Promise((resolve) => {
    const existing = document.getElementById('kycNameModal');
    if (existing) existing.remove();

    const modalHtml = `
    <div id="kycNameModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
      <div style="background: white; border-radius: 24px; max-width: 400px; width: 88%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
        <button id="kycNameModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

        <div style="text-align: center; margin-bottom: 12px;">
          <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
          <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
        </div>
        <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

        <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">填写真实姓名</div>
        <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">请填写与您证件一致的英文姓名，用于KYC认证及卡片显示</div>

        <input id="kycNameModalFirst" type="text" maxlength="30" placeholder="名 First Name（如 WEI）" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; outline: none; margin-bottom: 10px; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <input id="kycNameModalLast" type="text" maxlength="30" placeholder="姓 Last Name（如 ZHANG）" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <div id="kycNameModalError" style="color: #ef4444; font-size: 12px; margin-top: 6px; min-height: 16px;"></div>

        <div style="margin-top: 10px; display: flex; gap: 10px;">
          <button id="kycNameModalCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
          <button id="kycNameModalConfirm" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认</button>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('kycNameModal');
    const firstInput = document.getElementById('kycNameModalFirst');
    const lastInput = document.getElementById('kycNameModalLast');
    const errorEl = document.getElementById('kycNameModalError');
    firstInput.focus();

    function cleanup(value) {
      modal.remove();
      resolve(value);
    }

    const nameRe = /^[A-Za-z][A-Za-z\s\-']{0,29}$/;

    document.getElementById('kycNameModalClose').onclick = () => cleanup(null);
    document.getElementById('kycNameModalCancel').onclick = () => cleanup(null);
    document.getElementById('kycNameModalConfirm').onclick = () => {
      const firstName = firstInput.value.trim();
      const lastName = lastInput.value.trim();
      if (!nameRe.test(firstName) || !nameRe.test(lastName)) {
        errorEl.textContent = '请填写正确的英文姓名（仅支持英文字母）';
        return;
      }
      cleanup({ firstName, lastName });
    };
    [firstInput, lastInput].forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('kycNameModalConfirm').click();
      });
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cleanup(null);
    });
  });
}
// ========== 新增结束 ==========

// ============= 检查登录状态 =============
async function checkSession() {
    const isRefreshing = sessionStorage.getItem('isRefreshing') === 'true';
    sessionStorage.setItem('isRefreshing', 'true');
    
    // 加载动画默认已显示，不需要额外操作
    
    const data = await fetchAPI('/api/check-session');
    
    if (data && data.loggedIn) {
        currentUser = data.user;
        document.getElementById('authPage').style.display = 'none';
        document.getElementById('appPage').style.display = 'block';

// ===================== 在这里添加（临时通告） =====================
        await checkAndShowAnnouncement();
// ===================== 添加结束（临时通告） =====================
        setupSSE();  // ← 添加这行
        
        showLoading();  // 显示应用内的加载动画
        await isWalletFrozen();
        await preloadAllData();
        await renderHomePage();
        await preRenderCardPage();
        await preRenderProfilePage();
        hideLoading();

        // ========== 新增：打开 App 时顺手做一次"实时"KYC检查 ==========
        // 用户很可能是刚在 PokePay 那边做完认证、回到 App 来看结果的，
        // 不用干等最多15分钟的批量兜底任务，这里直接问一下有没有通过。
        maybeSilentKYCCheck();
        // ========== 新增结束 ==========
    } else {
        document.getElementById('authPage').style.display = 'block';
        document.getElementById('appPage').style.display = 'none';
        document.getElementById('loginForm').classList.remove('hidden');
        document.getElementById('registerForm').classList.add('hidden');
    }
    
    // 隐藏全局加载动画
    document.getElementById('loadingOverlay').classList.add('hidden');
}

// 轮播图组件
function renderBanner() {
    const banners = [
        { id: 1, url: 'https://pokepay-server.oss-cn-hongkong.aliyuncs.com/idcard/260601/161010.png', alt: 'banner1' },
        { id: 2, url: 'https://pokepay-server.oss-cn-hongkong.aliyuncs.com/idcard/250912/185850.jpg', alt: 'banner2' },
        { id: 3, url: 'https://pokepay-server.oss-cn-hongkong.aliyuncs.com/idcard/250826/134202.jpg', alt: 'banner3' }
    ];
    
    let currentIndex = 0;
    let timer = null;
    
    // 生成轮播图 HTML
    const bannerHtml = `
        <div id="bannerContainer" style="position: relative; width: 100%; height: 140px; margin-bottom: 20px; border-radius: 20px; overflow: hidden;">
            <div id="bannerTrack" style="display: flex; width: 100%; height: 100%; transition: transform 0.5s ease-in-out;">
                ${banners.map(banner => `
                    <div style="flex-shrink: 0; width: 100%; height: 100%;">
                        <img src="${banner.url}" style="width: 100%; height: 100%; object-fit: cover;" alt="${banner.alt}">
                    </div>
                `).join('')}
            </div>
            <div id="bannerDots" style="position: absolute; bottom: 12px; left: 0; right: 0; display: flex; justify-content: center; gap: 8px;">
                ${banners.map((_, idx) => `
                    <div class="banner-dot" data-index="${idx}" style="width: 8px; height: 8px; border-radius: 50%; background: ${idx === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)'}; cursor: pointer; transition: all 0.3s;"></div>
                `).join('')}
            </div>
        </div>
    `;
    
    // 启动轮播
    setTimeout(() => {
        const track = document.getElementById('bannerTrack');
        const dots = document.querySelectorAll('.banner-dot');
        
        if (!track) return;
        
        function goToSlide(index) {
            currentIndex = index;
            track.style.transform = `translateX(-${currentIndex * 100}%)`;
            dots.forEach((dot, i) => {
                dot.style.background = i === currentIndex ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
            });
        }
        
        function nextSlide() {
            currentIndex = (currentIndex + 1) % banners.length;
            goToSlide(currentIndex);
        }
        
        // 自动轮播
        if (timer) clearInterval(timer);
        timer = setInterval(nextSlide, 4000);
        
        // 点击指示点切换
        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const index = parseInt(dot.dataset.index);
                if (!isNaN(index)) {
                    goToSlide(index);
                    // 重置计时器
                    clearInterval(timer);
                    timer = setInterval(nextSlide, 4000);
                }
            });
        });
        
        // 触摸滑动支持
        let startX = 0;
        let isDragging = false;
        
        const container = document.getElementById('bannerContainer');
        
        container.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            isDragging = true;
            clearInterval(timer);
        });
        
        container.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            const endX = e.changedTouches[0].clientX;
            const diff = endX - startX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) {
                    // 向右滑动，上一张
                    currentIndex = (currentIndex - 1 + banners.length) % banners.length;
                } else {
                    // 向左滑动，下一张
                    currentIndex = (currentIndex + 1) % banners.length;
                }
                goToSlide(currentIndex);
            }
            isDragging = false;
            timer = setInterval(nextSlide, 4000);
        });
        
        container.addEventListener('touchcancel', () => {
            isDragging = false;
            timer = setInterval(nextSlide, 4000);
        });
    }, 100);
    
    return bannerHtml;
}

// ============= 渲染首页 =============
async function renderHomePage() {
    // ========== 修改：每次进首页都刷新一次数据 ==========
    // 原来 preloadedData（总资产、流水记录）只在 App 启动时拉取一次，之后切回首页
    // 一直用的是启动时那份旧数据，不会自动更新——这也是用户反馈"状态没刷新"的原因之一。
    await preloadAllData();
    // ========== 修改结束 ==========

    const container = document.getElementById('tabContent');
    const totalHKD = preloadedData.totalData?.totalHKD || '0.00';
    
    let flowHtml = '';
    if (preloadedData.flowRecords && preloadedData.flowRecords.length > 0) {
        flowHtml = preloadedData.flowRecords.slice(0, 20).map(record => {
            let isPositive = true;
            let icon = '📤';
            let title = record.title || '转账';
            
            if (record.type === 'exchange_hkd') {
                isPositive = true;
                icon = '🇭🇰';
                title = '资产兑换收入';
            } else if (record.type === 'exchange_usdt') {
                isPositive = false;
                icon = '📤';
                title = 'USDT 兑换支出';
            } else if (record.type === 'vusdt') {
                isPositive = true;
                icon = '📥';
                title = '链上转入';
            } else if (record.type === 'trx_deposit' || record.type === 'usdt_deposit') {
                isPositive = true;
                icon = '📥';
                title = '链上转入';
            } else if (record.type === 'usdt_withdraw') {
                isPositive = false;
                icon = '📤';
                title = 'USDT 提币';
            } else if (record.type === 'trx_withdraw') {
                isPositive = false;
                icon = '📤';
                title = 'TRX 提币';
} else {
    isPositive = record.amount > 0;
    icon = isPositive ? '📥' : '📤';
    // ========== 提现到卡特殊处理 ==========
    if (record.to_address === 'PokePay卡' && record.currency === 'HKD') {
        isPositive = false;
        icon = '📤';
        title = '提现到卡';
    }
    // ========== 处理结束 ==========
}
            
            const amountClass = isPositive ? 'positive' : 'negative';
            const amountPrefix = isPositive ? '+' : '-';
            const displayAmount = Math.abs(record.amount);
            
            return `
                <div class="flow-item" onclick='showTransactionDetail(${JSON.stringify(record)})'>
                    <div class="flow-left">
                        
                        <div class="flow-info">
                            <div class="flow-title">${title}</div>
                            <div class="flow-time">${record.created_at}</div>
                        </div>
                    </div>
                    <div class="flow-amount ${amountClass}">${amountPrefix}${displayAmount.toFixed(2)} ${record.currency}</div>
                </div>
            `;
        }).join('');
    } else {
        flowHtml = '<div class="text-center" style="color: var(--text-muted); padding: 40px;">暂无数据</div>';
    }

    // 顶部栏
    const topBarHtml = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <div style="display: flex; align-items: baseline; gap: 2px;">
                <span style="color: #21c592; font-size: 26px; font-weight: 700;">Poke</span>
                <span style="color: #1a1a2e; font-size: 26px; font-weight: 700;">Pay</span>
            </div>
            <button onclick="showNotificationTip()" style="background: none; border: none; cursor: pointer; padding: 8px;">
                <i class="iconfont icon-notification" style="font-size: 24px; color: #1a1a2e;"></i>
            </button>
        </div>
    `;

    const assetCardHtml = `
        <div style="position: relative; overflow: hidden; background: linear-gradient(135deg, #20c690, #22bf91 56%, #18ac94); border-radius: 22px; padding: 20px; margin-bottom: 20px; color: white; box-shadow: 0 16px 28px rgba(29, 155, 132, 0.18);">
            <!-- 装饰圆点 -->
            <div style="position: absolute; top: -26px; right: -24px; width: 120px; height: 120px; background: radial-gradient(circle, rgba(255,255,255,0.2), rgba(255,255,255,0) 72%);"></div>
            <div style="position: absolute; right: -42px; bottom: -62px; width: 194px; height: 132px; background: rgba(255,255,255,0.1); border-radius: 120px 0 0;"></div>
        
            <!-- 右上角徽章 -->
            <div style="position: absolute; top: 16px; right: 16px; z-index: 1;">
                    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAACXBIWXMAABYlAAAWJQFJUiTwAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAcJSURBVHgBzZppbFVFFMdP2WQpimUXhNoCikgAlxDAYMQgSkwIETB8qfiBxIiJEPWbiMaYGIOiqESFBLe4JGhE2d1AhCohSCIYFqFlX2QplrLD8f9n3iOP8u6cua/3tf0l/9z2zdxzZu6dO8uZKZA8oao34TIc6guVQKVQD6gj1CKV7Rh0BKqEtqauf0DrCwoKzkoeKJAEQSVZuTHQaGgI1ExyowpaDC2ClqLyJ6SxgEo2gx6GvoXOa/Ich96CSqQhQQEKoAegn7V+4MOcD/WQ+gZOu0NLoEta/5yGZkHXS76BkybQRKhKG54t0BDJF+oqO08b5q1GcQZ6TpIGRltAP2jj5SOoSUhdzGEJhgpxWQXdKblRDf0GbRA31u6DLqbSWokbmwdAw6A7oKaSGxzCxmAIuyS5ou7NrtP4HIXehQbTRgx/7aCx0GLNbYj7PvRNRxVgmcZjHzQFait1BDZ6quuNazQe8yUu6sbY2TGcHEvlv0ESBjZLoAXQuRjleTmuk/HQxUDjm6H7JI+oGyHKoD2BZeLDGRpqvAt0ONBwubpFQr0AX3dBWwPLtgtqZxlkU14QaHCV5qEJW8DnLdDGwDK+YxnjEwxpyuUNUdmMcvZQ9ylZnIV6Rxnhd7I8wMgOqKc0MCjDAKgioLxX9doFGQb4ka8x/HASMQGD+zIJK1RrXIrEXhefgU5DNbB9QQKB/TJc5kHNDdsDYXdr7Zu/CHhab0hYQa6DJkEboFOGTU4wjqfeFj+VuepGiS4Bftgql6jNm7VvLFZ7ZvMvVBRQiObQJ1r3RcYhdROP9oa/Xuq+VR/7oTaZN01Vm2clAOR7RpNdUa2Hbjd8zg2wMy7zhpVG5v+gGwMq2xT6UZOHa99+4n/L1ugyJ525A3TByPyhBIB8Rerm0/lgKdTS43u1cf8/zMfek72ztST7VMLgzKaTJ32luIhkGvrn8pAh3DbiZ5S4sO+KiPTPoXs995ei0qV8Mi8aT6bG92QzQb6HPHb4XffJcg9nd72hl9ReIHzN/BG+i9VmHNeOpUY91mEMOyNh3OpJqxEXdL8K2FZoO/7kCudV8TMCipq77xYX2PfRixXuZWRaK+H4ZmDVKWWFFcdlNrTdYyPyk0lFOv4UPx1ZYSvOu0XC6e5Jq0ChznvSWejjuJSLH98cfqf46cQKdzAy7ZYA1IVWunqybJMwjhjpvpiV1aQ7sJBBHVIADOt09qT7mmomvl6ezf6oJ/2gGOQe8LoW7gT4mvQuMUAr4fDom1Ux4nnIk14oBqyw1QxMIym4DdrKk35YbAaKv8K/4zv3NXmrrCdDKlwsYXTzpHFIOuBJvxwSxuVpif7E+O3OFT/WiHOMFbZ6tn4Shq85czjaG5WYquzz0OPRJuQXcTM1HwOM9AOc2u0wMoVuWPmc7UdTrMqWgMpyt2E6NF6id0I48ZkBG+ci0mmHfYi1h7yHFbZ6z/4wVgRndWn63MGYmvE/e3SOp3dD90Ctxc/r8G9FYwaJ3Qlv5JO5P2AOOtZnBeltoE2aHxaq298SowxvG3a4xG2RDsccMTKvMJx1Vrf7kCRcbHwDWROjdB0OGPYWMm+T1GkZKyg3Qv1nLBiGMQMEMeDnw33ficYwlGYkZMXAfrryl7ptDIvIIUHdWY8kYNzsfWiQBKIukFdu2GU0pCTzprbQQeMmBsr6RjidpLnB8xrboK+gJ6FiiYn61+BpVqbzX44Xo9lU40dGDKZ5bHOsnIN8I7PEjn3r4L+hp2r9xkkEhymujqpg76TkgLpt2ZkBWT/IdjMjBtXGkzqhDJNce+93nnu+lDwB26+pTYW6DYHLXBm38JQrcfnMY5/HFoYi345aTvnmfcvC0FVSLOD3MXFTUYuZKPOpKCPd9Nodd37wL2jE1iN+bw/t9TzhyZIwsDkM2q023DIttIzNyLiBEftR6pZtUfkZE/btWjwiyVd2p4ZRFmKwNfSXuqNAXQPyD/c45IMYLAkBW49ClRrGCijscCsydtSMD93IO8HjlLOvm6WOpF4C95msTjUNx/Pukg9geLrHMTetg48tZbHNScWD6nYhQ2GrGi35AsY/9jh/RXJA3fkwHkleq/E25ph3muSL1BtYE+Gch9P6xLDFQ2lcufH4037NDXMSkuuJ9TTs8rN1bNzNH4vxL2toFgWbIm7Hg/vNnPTfJi4+nusJfUYzZ8Ff8gdNr/Lizk2fznjC/H54eq+/cd92TQ7ufAbtXZO6vmEu49IhIB4YrQicF9fVbxrOxcvgc5E0ZtTNgOoK94O7SWMHhWypdnTCB89+PKGhk4paJNW06oNKcUeU3ouKgDZK8GYK1c2EQriYarqTNSCQF0JDvOFm4vfLjuhXaDW0HG9zkyTsvL5hUJ1BAW6pMLDOXp37TtyZYOU2xzmNF5f/ATzaHyRg5pxlAAAAAElFTkSuQmCC" style="width: 32px; height: 32px; object-fit: contain;">
            </div>
        
            <div style="position: relative; z-index: 1;">
                <div style="font-size: 18px; opacity: 0.9; margin-bottom: 8px;">总资产估值</div>
                <div style="font-size: 32px; font-weight: 700;" id="totalAssetValue">${totalHKD} HKD</div>
            </div>
        </div>
    `;

    const html = `
        ${topBarHtml}
        ${assetCardHtml}
        <div class="action-grid">
            <div class="action-item" onclick="navigateTo('account')">
                <div class="action-icon"><i class="iconfont icon-wallet-outline" style="font-size: 24px;"></i></div>
                <div class="action-label">账户</div>
            </div>
            <div class="action-item" onclick="navigateTo('deposit')">
                <div class="action-icon"><i class="iconfont icon-card-receive" style="font-size: 24px;"></i></div>
                <div class="action-label">充值</div>
            </div>
            <div class="action-item" onclick="navigateTo('withdraw')">
                <div class="action-icon"><i class="iconfont icon-card-send" style="font-size: 24px;"></i></div>
                <div class="action-label">提币</div>
            </div>
            <div class="action-item" onclick="navigateTo('swap')">
                <div class="action-icon"><i class="iconfont icon-arrows-down-up" style="font-size: 24px;"></i></div>
                <div class="action-label">兑换</div>
            </div>
        </div>
        ${renderBanner()}
        <div class="card">
            <h3 style="font-size: 16px; margin-bottom: 16px;">资金流水</h3>
            <div id="fundFlowList">${flowHtml}</div>
        </div>
    `;
    
    container.innerHTML = html;
    pageCache.home = html;
}

// ============= 预渲染卡片页 =============
async function preRenderCardPage() {
    // 获取 PokePay 卡片信息
    let pokePayCardNo = '';
    let pokePayBalance = '0.00';
    let pokePayCurrency = 'HKD';
    let pokePayMemberName = '';
    let pokePayTransactions = [];
    let cardBound = false;
    
    try {
        const cardInfo = await fetchAPI('/api/card/balance');
        if (cardInfo && cardInfo.success) {
            pokePayCardNo = cardInfo.cardNo || '';
            pokePayBalance = cardInfo.balance;
            pokePayCurrency = cardInfo.currency;
            pokePayMemberName = cardInfo.memberName || '';
            cardBound = true;
        }
        
        const txData = await fetchAPI('/api/card/transactions?limit=10');
        if (txData && txData.success && txData.transactions) {
            pokePayTransactions = txData.transactions;
        }
    } catch(e) {
        console.log('获取卡片信息失败:', e);
    }
    
    // ========== 关键修改：区分两种冻结状态 ==========
    const isBalanceZero = userHKD <= 0;           // 余额为0（业务提示，不是真冻结）
    const isAdminFrozen = isWalletFrozenStatus;   // 管理员冻结（真冻结）
    
    const cardLast4 = pokePayCardNo ? pokePayCardNo.slice(-4) : '';
    const cardHolderName = pokePayMemberName || (cardBound ? 'Card Holder' : '');

    // 卡片样式
    let visaCardHtml = '';
    if (cardBound) {
        visaCardHtml = `
            <div style="background-image: url('/assets/card-preview-BEM1-lN4.png'); background-size: cover; background-position: center; border-radius: 24px; padding: 20px; margin-bottom: 16px; position: relative; min-height: 200px;">
                <div style="position: relative; z-index: 1;">
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 30px;">
                        <span style="font-size: 20px; font-weight: 600; letter-spacing: 2px; color: white;">PokePay Card</span>
                    </div>
                    <div style="margin-bottom: 24px; display: flex; align-items: baseline; gap: 12px;">
                        <div style="font-size: 14px; opacity: 0.7; color: white;">余额</div>
                        <div style="font-size: 24px; font-weight: 700; color: white;">${pokePayBalance} ${pokePayCurrency}</div>
                    </div>
                    <div style="font-size: 18px; letter-spacing: 3px; font-family: monospace; color: white; margin-bottom: 24px;">
                        ••••  ••••  ••••  ${cardLast4}
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 12px; opacity: 0.8; color: white;">${cardHolderName}</span>
                    </div>
                </div>
            </div>
        `;
    } else {
        visaCardHtml = `
            <div style="background-image: url('/assets/card-preview-BEM1-lN4.png'); background-size: cover; background-position: center; border-radius: 24px; padding: 20px; margin-bottom: 16px; position: relative; min-height: 200px;">
                <div style="position: relative; z-index: 1;">
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 30px;">
                        <span style="font-size: 20px; font-weight: 600; letter-spacing: 2px; color: white;">PokePay Card</span>
                    </div>
                    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center;">
                        <div style="height: 18px;"></div>
                        <div onclick="showKYC()" style="font-size: 18px; font-weight: 600; color: white; margin-bottom: 8px; cursor: pointer; text-decoration: underline;">点击绑定 VISA 卡</div>
                        <div style="height: 48px;"></div>
                        <div style="font-size: 16px; opacity: 0.7; color: white;">如需申请,请联系客服</div>
                    </div>
                </div>
            </div>
        `;
    }
    
    // ========== 新增：余额冻结提示（白底，仅当余额为0且不是管理员冻结时显示）==========
    const balanceFrozenBadge = (!isAdminFrozen && isBalanceZero) ? `
        <div class="frozen-badge" style="background: white; padding: 12px; border-radius: 12px; margin-bottom: 16px; text-align: center; border: 1px solid #e5e7eb;">
            <div class="title" style="font-weight: 600; margin-bottom: 4px;">⚠️ 余额不足</div>
            <div class="desc" style="font-size: 12px;">HKD 余额为 0，无法提现到卡，请先充值</div>
        </div>
    ` : '';
    
    // ========== 新增：管理员冻结提示（红色）==========
    const adminFrozenBadge = isAdminFrozen ? `
        <div class="frozen-badge" style="background: #b71c1c; color: #ffeb3b; padding: 12px; border-radius: 12px; margin-bottom: 16px; text-align: center; border: 1px solid #ffeb3b;">
            <div class="title" style="font-weight: 700; margin-bottom: 4px; font-size: 15px;">🔒 钱包无法交易，请联系客服！</div>
        </div>
    ` : '';
    
    // ========== 按钮禁用逻辑：只有管理员冻结时才禁用按钮 ==========
    const buttonsDisabled = isAdminFrozen;
    const buttonStyle = buttonsDisabled ? '#ccc' : '#21c592';
    const buttonCursor = buttonsDisabled ? 'not-allowed' : 'pointer';
    
// 生成交易记录 HTML
let transactionsHtml = '';
if (pokePayTransactions.length > 0) {
    transactionsHtml = pokePayTransactions.map(tx => {
        const isPositive = tx.type === '充值';  // 充值为正数
        const amountClass = isPositive ? 'positive' : 'negative';
        let icon = '🇭🇰';
      //if (tx.type === '充值') icon = '🇭🇰';
      //if (tx.type === '退值') icon = '💳';  // 退值用不同图标
        
        return `
            <div class="flow-item">
                <div class="flow-left">
                    <div class="flow-icon">${icon}</div>
                    <div class="flow-info">
                        <div class="flow-title">${tx.type}</div>
                        <div class="flow-time">${tx.time}</div>
                    </div>
                </div>
                <div class="flow-amount ${amountClass}">${tx.amount} ${tx.currency}</div>
            </div>
        `;
    }).join('');
} else {
    transactionsHtml = '<div class="text-center" style="color: var(--text-muted); padding: 20px;">暂无交易记录</div>';
}
    
    pageCache.card = `
        ${visaCardHtml}
        <div class="card">
            <div class="flex justify-between items-center">
                <span style="color: var(--text-secondary); font-size: 16px;">钱包 HKD 余额</span>
                <span style="font-size: 24px; font-weight: 700;">${userHKD.toFixed(2)} HKD</span>
            </div>
        </div>
        ${balanceFrozenBadge}
        ${adminFrozenBadge}
        <!-- 按钮区域 -->
        <div style="display: flex; gap: 12px; margin-top: 16px; margin-bottom: 16px;">
            <button onclick="withdrawHKDToCard()" 
                style="flex: 1; background: ${buttonStyle}; color: white; border: none; border-radius: 14px; padding: 14px 0; font-size: 15px; font-weight: 600; cursor: ${buttonCursor};" 
                ${buttonsDisabled ? 'disabled' : ''}>
                提现到卡
            </button>
            <button onclick="showTransferPage()" 
                style="flex: 1; background: ${buttonStyle}; color: white; border: none; border-radius: 14px; padding: 14px 0; font-size: 15px; font-weight: 600; cursor: ${buttonCursor};" 
                ${buttonsDisabled ? 'disabled' : ''}>
                钱包转账
            </button>
            <button onclick="showSetWithdrawPinModal()" 
                style="flex: 1; background: ${buttonStyle}; color: white; border: none; border-radius: 14px; padding: 14px 0; font-size: 15px; font-weight: 600; cursor: ${buttonCursor};" 
                ${buttonsDisabled ? 'disabled' : ''}>
                设置取款密码
            </button>
        </div>
        
        <div class="card">
            <h3 style="font-size: 16px; margin-bottom: 16px;">卡片交易记录</h3>
            <div id="cardTransactionsList">${transactionsHtml}</div>
        </div>
    `;
}

// 卡片页加载
async function loadCardPage(container) {
    // 如果有缓存，先显示缓存
    if (pageCache.card) {
        container.innerHTML = pageCache.card;
    }
    
    // 后台静默刷新数据
    await refreshUserData();
    await isWalletFrozen();
    await preRenderCardPage();
    
    // 刷新完成后更新页面（如果状态有变化）
    if (pageCache.card !== container.innerHTML) {
        container.innerHTML = pageCache.card;
    }
}

// 提现到 PokePay 卡
async function withdrawHKDToCard() {
    if (userHKD <= 0) {
        alert('HKD 余额为 0，无法提现');
        return;
    }
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 16px;">提现 HKD 到 PokePay 卡</h3>
        <div class="input-group">
            <label class="input-label">提现金额 (HKD)</label>
            <input type="number" id="withdrawAmount" class="input-field" placeholder="0.00" max="${userHKD}" step="0.01">
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">可用余额: ${userHKD.toFixed(2)} HKD</div>
        </div>
        <div class="input-group">
            <label class="input-label">支付密码</label>
            <input type="password" id="withdrawPaymentPassword" class="input-field" placeholder="6位支付密码" maxlength="6">
        </div>
        <button class="btn btn-primary" onclick="submitWithdrawRequest()">提交提现申请</button>
        <p style="color: var(--text-muted); font-size: 12px; margin-top: 12px;">申请提交后，银行会在24小时内处理，资金将充值到您的PokePay卡</p>
    `;
    showModal();
}

async function submitWithdrawRequest() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const paymentPassword = document.getElementById('withdrawPaymentPassword').value;
    
    if (!amount || amount <= 0) {
        alert('请输入有效的金额');
        return;
    }
    if (!paymentPassword) {
        alert('请输入支付密码');
        return;
    }
    
    const verifyRes = await fetchAPI('/api/verify-payment-password', { 
        method: 'POST', 
        body: { paymentPassword } 
    });
    if (!verifyRes || !verifyRes.success) {
        alert(verifyRes?.error || '支付密码错误');
        return;
    }
    
    const data = await fetchAPI('/api/card/withdraw', {
        method: 'POST',
        body: { amount }
    });
    
    if (data && data.success) {
        alert('提现申请已提交，请等待银行处理');
        closeModal();
        await refreshUserData();
        if (currentTab === 'card') {
            await loadCardPage(document.getElementById('tabContent'));
        }
    } else {
        alert(data?.error || '申请失败');
    }
}

// ============= 预渲染我的页面 =============
async function preRenderProfilePage() {
    const email = currentUser?.email || '用户';
    const userId = currentUser?.uid || '123456';
    
    // KYC 状态显示逻辑
    let kycStatusText = '';
    if (userKYCStatus === 'verified') {
        kycStatusText = '✅ 已验证';
    } else if (userKYCStatus === 'rejected') {
        kycStatusText = '❌ 已拒绝';
    } else {
        kycStatusText = '🔍 待认证';
    }

    
    pageCache.profile = `
        <div style="position: relative; overflow: hidden; background: linear-gradient(135deg, #20c690, #22bf91 56%, #18ac94); border-radius: 22px; padding: 20px; margin-bottom: 20px; color: white; box-shadow: 0 16px 28px rgba(29, 155, 132, 0.18);">
            <!-- 装饰圆点 -->
            <div style="position: absolute; top: -26px; right: -24px; width: 120px; height: 120px; background: radial-gradient(circle, rgba(255,255,255,0.2), rgba(255,255,255,0) 72%);"></div>
            <div style="position: absolute; right: -42px; bottom: -62px; width: 194px; height: 132px; background: rgba(255,255,255,0.1); border-radius: 120px 0 0;"></div>
        
            <!-- 右上角徽章 -->
            <div style="position: absolute; top: 16px; right: 16px; z-index: 1;">
                    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAACXBIWXMAABYlAAAWJQFJUiTwAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAcJSURBVHgBzZppbFVFFMdP2WQpimUXhNoCikgAlxDAYMQgSkwIETB8qfiBxIiJEPWbiMaYGIOiqESFBLe4JGhE2d1AhCohSCIYFqFlX2QplrLD8f9n3iOP8u6cua/3tf0l/9z2zdxzZu6dO8uZKZA8oao34TIc6guVQKVQD6gj1CKV7Rh0BKqEtqauf0DrCwoKzkoeKJAEQSVZuTHQaGgI1ExyowpaDC2ClqLyJ6SxgEo2gx6GvoXOa/Ich96CSqQhQQEKoAegn7V+4MOcD/WQ+gZOu0NLoEta/5yGZkHXS76BkybQRKhKG54t0BDJF+oqO08b5q1GcQZ6TpIGRltAP2jj5SOoSUhdzGEJhgpxWQXdKblRDf0GbRA31u6DLqbSWokbmwdAw6A7oKaSGxzCxmAIuyS5ou7NrtP4HIXehQbTRgx/7aCx0GLNbYj7PvRNRxVgmcZjHzQFait1BDZ6quuNazQe8yUu6sbY2TGcHEvlv0ESBjZLoAXQuRjleTmuk/HQxUDjm6H7JI+oGyHKoD2BZeLDGRpqvAt0ONBwubpFQr0AX3dBWwPLtgtqZxlkU14QaHCV5qEJW8DnLdDGwDK+YxnjEwxpyuUNUdmMcvZQ9ylZnIV6Rxnhd7I8wMgOqKc0MCjDAKgioLxX9doFGQb4ka8x/HASMQGD+zIJK1RrXIrEXhefgU5DNbB9QQKB/TJc5kHNDdsDYXdr7Zu/CHhab0hYQa6DJkEboFOGTU4wjqfeFj+VuepGiS4Bftgql6jNm7VvLFZ7ZvMvVBRQiObQJ1r3RcYhdROP9oa/Xuq+VR/7oTaZN01Vm2clAOR7RpNdUa2Hbjd8zg2wMy7zhpVG5v+gGwMq2xT6UZOHa99+4n/L1ugyJ525A3TByPyhBIB8Rerm0/lgKdTS43u1cf8/zMfek72ztST7VMLgzKaTJ32luIhkGvrn8pAh3DbiZ5S4sO+KiPTPoXs995ei0qV8Mi8aT6bG92QzQb6HPHb4XffJcg9nd72hl9ReIHzN/BG+i9VmHNeOpUY91mEMOyNh3OpJqxEXdL8K2FZoO/7kCudV8TMCipq77xYX2PfRixXuZWRaK+H4ZmDVKWWFFcdlNrTdYyPyk0lFOv4UPx1ZYSvOu0XC6e5Jq0ChznvSWejjuJSLH98cfqf46cQKdzAy7ZYA1IVWunqybJMwjhjpvpiV1aQ7sJBBHVIADOt09qT7mmomvl6ezf6oJ/2gGOQe8LoW7gT4mvQuMUAr4fDom1Ux4nnIk14oBqyw1QxMIym4DdrKk35YbAaKv8K/4zv3NXmrrCdDKlwsYXTzpHFIOuBJvxwSxuVpif7E+O3OFT/WiHOMFbZ6tn4Shq85czjaG5WYquzz0OPRJuQXcTM1HwOM9AOc2u0wMoVuWPmc7UdTrMqWgMpyt2E6NF6id0I48ZkBG+ci0mmHfYi1h7yHFbZ6z/4wVgRndWn63MGYmvE/e3SOp3dD90Ctxc/r8G9FYwaJ3Qlv5JO5P2AOOtZnBeltoE2aHxaq298SowxvG3a4xG2RDsccMTKvMJx1Vrf7kCRcbHwDWROjdB0OGPYWMm+T1GkZKyg3Qv1nLBiGMQMEMeDnw33ficYwlGYkZMXAfrryl7ptDIvIIUHdWY8kYNzsfWiQBKIukFdu2GU0pCTzprbQQeMmBsr6RjidpLnB8xrboK+gJ6FiiYn61+BpVqbzX44Xo9lU40dGDKZ5bHOsnIN8I7PEjn3r4L+hp2r9xkkEhymujqpg76TkgLpt2ZkBWT/IdjMjBtXGkzqhDJNce+93nnu+lDwB26+pTYW6DYHLXBm38JQrcfnMY5/HFoYi345aTvnmfcvC0FVSLOD3MXFTUYuZKPOpKCPd9Nodd37wL2jE1iN+bw/t9TzhyZIwsDkM2q023DIttIzNyLiBEftR6pZtUfkZE/btWjwiyVd2p4ZRFmKwNfSXuqNAXQPyD/c45IMYLAkBW49ClRrGCijscCsydtSMD93IO8HjlLOvm6WOpF4C95msTjUNx/Pukg9geLrHMTetg48tZbHNScWD6nYhQ2GrGi35AsY/9jh/RXJA3fkwHkleq/E25ph3muSL1BtYE+Gch9P6xLDFQ2lcufH4037NDXMSkuuJ9TTs8rN1bNzNH4vxL2toFgWbIm7Hg/vNnPTfJi4+nusJfUYzZ8Ff8gdNr/Lizk2fznjC/H54eq+/cd92TQ7ufAbtXZO6vmEu49IhIB4YrQicF9fVbxrOxcvgc5E0ZtTNgOoK94O7SWMHhWypdnTCB89+PKGhk4paJNW06oNKcUeU3ouKgDZK8GYK1c2EQriYarqTNSCQF0JDvOFm4vfLjuhXaDW0HG9zkyTsvL5hUJ1BAW6pMLDOXp37TtyZYOU2xzmNF5f/ATzaHyRg5pxlAAAAAElFTkSuQmCC" style="width: 32px; height: 32px; object-fit: contain;">
            </div>
        
            <div style="position: relative; z-index: 1;">
                <div><div class="asset-value" style="font-size: 24px;">${email}</div><div class="asset-sub">ID: ${userId}</div></div>
            </div>
        </div>
        
        <div class="card">
            <div class="menu-list">
                <!-- KYC 认证 -->
                <button class="menu-item" onclick="navigateTo('kyc')">
                    <div class="menu-left">
                        <span class="menu-icon"><i class="iconfont icon-profile" style="font-size: 20px;"></i></span>
                        <span>${t('profile_kyc')}</span>
                    </div>
                    <div class="menu-right">${kycStatusText}</div>
                </button>
                <!-- 推荐好友 -->
                <button class="menu-item" onclick="navigateTo('invite')">
                    <div class="menu-left">
                        <span class="menu-icon"><i class="iconfont icon-gift-outline" style="font-size: 20px;"></i></span>
                        <span>${t('profile_invite')}</span>
                    </div>
                    <div class="menu-right">›</div>
                </button>
                <!-- 语言 -->
                <button class="menu-item" onclick="showLanguageSelector()">
                    <div class="menu-left">
                        <span class="menu-icon"><i class="iconfont icon-globe-outline-new" style="font-size: 20px;"></i></span>
                        <span>${t('profile_language')}</span>
                    </div>
                    <div class="menu-right">${getLanguageDisplayName(getCurrentLanguage())}</div>
                </button>
                <!-- 客服中心 -->
                <button class="menu-item" onclick="navigateTo('support')">
                    <div class="menu-left">
                        <span class="menu-icon"><i class="iconfont icon-document-text" style="font-size: 20px;"></i></span>
                        <span>${t('profile_support')}</span>
                    </div>
                    <div class="menu-right">
                        <span id="supportMenuBadge" style="display:none; background:#e53e3e; color:white; border-radius:20px; padding:1px 8px; font-size:11px; margin-right:6px;"></span>
                        ›
                    </div>
                </button>
                <!-- 设置 -->
                <button class="menu-item" onclick="navigateTo('settings')">
                    <div class="menu-left">
                        <span class="menu-icon"><i class="iconfont icon-settings" style="font-size: 20px;"></i></span>
                        <span>${t('profile_settings')}</span>
                    </div>
                    <div class="menu-right">›</div>
                </button>
                <!-- 退出登录 -->             
                <button class="menu-item" onclick="handleLogout()">
                    <div class="menu-left">
                        <span class="menu-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                                <polyline points="16 17 21 12 16 7"/>
                                <line x1="21" y1="12" x2="9" y2="12"/>
                            </svg>
                        </span>
                        <span>退出登录</span>
                    </div>
                    <div class="menu-right">›</div>
                </button>
            </div>
        </div>
    `;
}

// 我的页面加载
async function loadProfilePage(container) {
    // 先秒显示上一次的缓存内容（如果有），避免每次切换都出现一下空白/加载感
    if (pageCache.profile) {
        container.innerHTML = pageCache.profile;
    }
    // 后台刷新最新数据
    await refreshUserData();
    await preRenderProfilePage();
    // 刷新完成后更新页面（如果状态有变化）
    if (pageCache.profile !== container.innerHTML) {
        container.innerHTML = pageCache.profile;
    }
}

// ============= 标签页切换 =============
async function loadTab(tab) {
    
    currentTab = tab;
    
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.dataset.tab === tab) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    const content = document.getElementById('tabContent');
    if (!content) return;
    
    // 卡片页：每次都重新加载
    if (tab === 'card') {
        await loadCardPage(content);
        return;
    }
    
    // 首页不使用缓存（因为轮播图需要重新初始化）
    if (tab === 'home') {
        await renderHomePage();
        return;
    }
    
    // 其他页面使用缓存
    // ========== 修改：profile 页每次切换都刷新，而不是只有第一次没缓存时才刷新 ==========
    // 原来的写法是：只要 pageCache.profile 有值（哪怕是很久以前的），就直接显示旧内容，
    // 完全不会去问后端最新状态——这也是不少用户反映"KYC/绑卡状态没更新"的原因之一：
    // 只要不是第一次打开"我的"页，来回切标签是看不到最新数据的，除非中途刚好触发过别的会顺带刷新的操作。
    if (tab === 'profile') {
        await loadProfilePage(content);
        return;
    }
    if (pageCache[tab]) {
        content.innerHTML = pageCache[tab];
    }
    // ========== 修改结束 ==========
}

// ============= 创建钱包 =============
async function createWallet() {
    const data = await fetchAPI('/api/create-wallet', { method: 'POST' });
    if (data && data.success) {
        alert(`钱包创建成功！\n地址: ${data.address}\n私钥: ${data.privateKey}\n请妥善保管私钥`);
        userWallet = data.address;
        userPrivateKey = data.private_key;
        await refreshUserData();
        await preRenderCardPage();
        await preRenderProfilePage();
        if (currentTab === 'card') {
            document.getElementById('tabContent').innerHTML = pageCache.card;
        }
    } else {
        alert(data?.error || '创建钱包失败');
    }
}

// ============= KYC 功能（一键跳转链接版，移动端兼容） =============

async function showKYC() {
    // 先检查状态
    const statusData = await fetchAPI('/api/kyc/status');
    
    if (statusData && statusData.status === 'verified') {
        alert('✅ 您已完成 KYC 认证');
        return;
    }
    
    if (statusData && statusData.status === 'rejected') {
        alert('❌ 您的 KYC 认证被拒绝，请联系客服');
        return;
    }

    // ========== 修改：完整卡号查询接口暂时不可用，改为用户自己填 卡ID + 卡号后4位 + 姓名拼音 ==========
    // 后端核对"这个卡ID对应卡片的后四位"跟用户填的是否一致，一致才放行进入 KYC。
    if (!statusData.cardBindStatus) {
        const cardInput = await showCardBindInputModal({
            title: '绑定国际卡',
            subtitle: '请填写卡片信息，完成后将跳转 KYC 认证'
        });
        if (!cardInput) return;

        const lockResult = await fetchAPI('/api/kyc/lock-card', {
            method: 'POST',
            body: { cardId: cardInput.cardId, last4: cardInput.last4, pinyinName: cardInput.pinyinName }
        });

        if (!lockResult || !lockResult.success) {
            alert(lockResult?.error || '提交失败，请重试');
            return;
        }
    }
    
    // ========== 修改：取消二次确认，输入完整卡号后直接跳转到 KYC 认证页 ==========
    await getKYCLinkAndRedirect();
}

// 获取 KYC 链接并跳转（当前页面跳转，最可靠）
async function getKYCLinkAndRedirect() {
    showLoading();
    try {
        let data = await fetchAPI('/api/kyc/link');

        // 首次填写：后端没有真实姓名，先弹窗收集，再重新请求链接
        if (data && data.needIdentity) {
            hideLoading();
            const name = await showKycNameModal();
            if (!name) return; // 用户取消

            showLoading();
            const saveResult = await fetchAPI('/api/kyc/identity', {
                method: 'POST',
                body: { firstName: name.firstName, lastName: name.lastName }
            });
            if (!saveResult || !saveResult.success) {
                hideLoading();
                alert(saveResult?.error || '保存姓名失败，请重试');
                return;
            }
            data = await fetchAPI('/api/kyc/link');
        }

        if (data && data.success && data.kycLink) {
            // 直接在当前页面跳转
            window.location.href = data.kycLink;
        } else {
            hideLoading();
            alert(data?.error || '获取认证链接失败，请稍后重试');
        }
    } catch(e) {
        hideLoading();
        console.error('获取 KYC 链接失败:', e);
        alert('获取认证链接失败: ' + e.message);
    }
}

// 查询 KYC 状态（用户主动查询）—— 改为调用"实时查询"接口，而不是只读本地缓存的旧状态
async function checkKYCStatus() {
    showLoading();
    try {
        const data = await fetchAPI('/api/kyc/check-now', { method: 'POST' });
        if (data && data.status === 'verified' && data.cardBindStatus === 'needs_review') {
            // KYC 本身已经通过了，卡在自动绑卡这一步（比如候选用卡人暂时都满了），需要人工核实
            alert('✅ KYC 认证已完成，但卡片绑定遇到问题，需要人工核实\n\n请联系客服协助处理');
            await refreshUserData();
        } else if (data && data.status === 'verified') {
            alert('✅ KYC 认证已完成！');
            await refreshUserData();
            await preRenderProfilePage();
            if (currentTab === 'profile') {
                document.getElementById('tabContent').innerHTML = pageCache.profile;
            }
        } else if (data && data.status === 'pending') {
            alert('⏳ KYC 认证处理中，请稍后再查询\n\n通常需要几分钟时间');
        } else if (data && data.status === 'rejected') {
            alert('❌ KYC 认证被拒绝，请联系客服');
        } else {
            alert('❌ 尚未完成认证\n\n请先完成认证流程');
        }
    } catch(e) {
        alert('查询失败: ' + e.message);
    } finally {
        hideLoading();
    }
}

// ========== 新增：静默的实时 KYC 检查（不弹窗、不加载动画，用户无感知） ==========
// 只在"本地状态还不是 verified、但已经锁定了卡片（说明用户正走在认证流程里）"时才会去查，
// 避免给完全没开始KYC的用户也发起无意义的查询。
let kycSilentCheckInFlight = false;
async function maybeSilentKYCCheck() {
    if (kycSilentCheckInFlight) return;
    try {
        const statusData = await fetchAPI('/api/kyc/status'); // 本地缓存，不打外部接口，很快
        if (!statusData || statusData.status === 'verified' || statusData.status === 'rejected') return;
        if (statusData.cardBindStatus !== 'locked') return; // 还没到"已提交卡号、等审核"这一步，不用查

        kycSilentCheckInFlight = true;
        const result = await fetchAPI('/api/kyc/check-now', { method: 'POST' });
        if (result && result.status === 'verified') {
            await refreshUserData();
            await preRenderProfilePage();
            if (currentTab === 'profile') {
                document.getElementById('tabContent').innerHTML = pageCache.profile;
            }
            if (result.cardBindStatus === 'active') {
                alert('✅ KYC 认证已通过，卡片已为您自动绑定完成！');
            } else if (result.cardBindStatus === 'needs_review') {
                alert('✅ KYC 认证已通过，但卡片绑定需要人工核实，请联系客服协助处理');
            } else {
                alert('✅ KYC 认证已通过！');
            }
        }
    } catch (e) {
        // 静默失败即可，不打扰用户，反正还有15分钟兜底任务
        console.warn('实时KYC检查失败（不影响使用，会有兜底任务重试）:', e.message);
    } finally {
        kycSilentCheckInFlight = false;
    }
}

// App 从后台切回前台时（比如用户刚在浏览器另一个标签/PokePay页面做完认证切回来），也顺手查一次
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
        maybeSilentKYCCheck();
    }
});
// ========== 新增结束 ==========

// ============= 其他功能函数 =============
function navigateTo(page) {
    if (page === 'account') showAccountPage();
    else if (page === 'deposit') showDepositPage();
    else if (page === 'withdraw') showWithdrawPage();
    else if (page === 'swap') showSwapPage();
    else if (page === 'invite') showInvitePage();
    else if (page === 'kyc') showKYC();
    else if (page === 'support') showSupportPage(false);
    else if (page === 'language') alert('语言切换功能开发中');
    else if (page === 'support') alert('客服中心: support@example.com');
    else if (page === 'settings') showSettingsMenu();
}

async function showAccountPage() {
    if (!userWallet) {
        document.getElementById('dynamicModalContent').innerHTML = `
            <div class="text-center"><div style="font-size: 48px;">💼</div><h3>暂无钱包</h3>
            <p style="color: var(--text-secondary); margin: 16px 0;">创建 TRON 钱包开始使用</p>
            <button class="btn btn-primary" onclick="createWallet()">创建钱包</button></div>
        `;
        showModal();
        return;
    }

    // 资产图标（使用本地图片）
    const assetIcons = {
        'TRX': '<img src="/images/trx-icon.webp" width="20" height="20" style="vertical-align: middle; margin-right: 8px;">',
        'USDT': '<img src="/images/usdt-icon.webp" width="20" height="20" style="vertical-align: middle; margin-right: 8px;">',
        'HKD': '<img src="/images/hkd-icon.svg" width="20" height="20" style="vertical-align: middle; margin-right: 8px;">'
    };
    let assetsHtml = '';
    
    if (preloadedData.assets && preloadedData.assets.assets) {
        assetsHtml = preloadedData.assets.assets.map(a => {
            const icon = assetIcons[a.token] || '💰';
            return `
                <div class="flex justify-between" style="padding: 10px 0; align-items: center;">
                    <span>${icon} ${a.token}</span>
                    <span style="font-weight: 500;">${a.balance}</span>
                </div>
            `;
        }).join('');
    } else {
        const assets = await fetchAPI('/api/assets');
        if (assets && assets.assets) {
            assetsHtml = assets.assets.map(a => {
                const icon = assetIcons[a.token] || '💰';
                return `
                    <div class="flex justify-between" style="padding: 10px 0; align-items: center;">
                        <span>${icon} ${a.token}</span>
                        <span style="font-weight: 500;">${a.balance}</span>
                    </div>
                `;
            }).join('');
        }
    }
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3>我的资产</h3>
        <div style="margin: 16px 0;">${assetsHtml}</div>
        <div class="invite-code-box">
            <div>钱包地址</div>
            <div style="font-size: 12px; word-break: break-all;">${userWallet}</div>
            <button class="btn btn-secondary" style="margin-top: 12px;" onclick="copyToClipboard('${userWallet}')">复制地址</button>
        </div>
    `;
    showModal();
}

function showDepositPage() {
    if (!userWallet) { alert('请先创建钱包'); return; }
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3>充值</h3><p>请将 USDT (TRC20) 发送到以下地址：</p>
        <div class="invite-code-box"><div style="font-size: 12px; word-break: break-all;">${userWallet}</div>
        <button class="btn btn-secondary" onclick="copyToClipboard('${userWallet}')">复制地址</button></div>
        <p style="color: var(--text-muted); font-size: 12px;">⚠️ 仅支持 TRC20 网络</p>
    `;
    showModal();
}

function showWithdrawPage() {
    if (!userWallet) { alert('请先创建钱包'); return; }
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3>提币</h3>
        
        <!-- 币种选择 -->
        <div class="input-group">
            <label>币种</label>
            <select id="withdrawTokenType" class="input-field" style="padding: 12px;">
                <option value="USDT">USDT (TRC20)</option>
                <option value="TRX">TRX</option>
            </select>
        </div>
        
        <div class="input-group">
            <label>目标地址</label>
            <input type="text" id="withdrawTo" class="input-field" placeholder="TRON 钱包地址">
        </div>
        <div class="input-group">
            <label>数量 (<span id="tokenTypeLabel">USDT</span>)</label>
            <input type="number" id="withdrawAmount" class="input-field" placeholder="0.00" step="0.01">
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;" id="balanceDisplay">加载中...</div>
        </div>
        <div id="feeDisplay" style="background: #f5f5f5; padding: 12px; border-radius: 12px; margin: 12px 0;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span id="feeLabel">能量 (TRX):</span>
                <span id="feeAmount">0</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span>预留带宽费 (TRX):</span>
                <span>1.00</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #ddd;">
                <span style="font-weight: 600;">您需要准备 (TRX):</span>
                <span id="totalTrxNeeded" style="font-weight: 600; color: #21c592;">0</span>
            </div>
        </div>
        <div id="trxBalanceWarning" style="background: #fff3f3; color: #d32f2f; padding: 10px; border-radius: 8px; margin: 12px 0; display: none; font-size: 13px;"></div>
        <div class="input-group">
            <label>支付密码</label>
            <input type="password" id="paymentPassword" class="input-field" placeholder="6位支付密码" maxlength="6">
        </div>
        <button class="btn btn-primary" id="withdrawConfirmBtn" onclick="executeWithdraw()">确认提币</button>
        <p style="color: var(--text-muted); font-size: 11px; margin-top: 12px;" id="withdrawHint">💡 提币将先扣除 TRX 手续费，再进行 USDT 转账。如遇网络问题，系统会自动重试最多3次。</p>
    `;
    
    showModal();
    
    // 币种切换事件
    const tokenTypeSelect = document.getElementById('withdrawTokenType');
    if (tokenTypeSelect) {
        tokenTypeSelect.addEventListener('change', () => onTokenTypeChange());
    }
    
    const amountInput = document.getElementById('withdrawAmount');
    if (amountInput) {
        amountInput.addEventListener('input', () => onWithdrawAmountChange());
    }
    
    loadWithdrawPageData();
}

// 币种切换时更新界面
async function onTokenTypeChange() {
    const tokenType = document.getElementById('withdrawTokenType').value;
    const labelSpan = document.getElementById('tokenTypeLabel');
    const feeLabel = document.getElementById('feeLabel');
    const hint = document.getElementById('withdrawHint');
    
    if (tokenType === 'USDT') {
        labelSpan.innerText = 'USDT';
        feeLabel.innerHTML = '能量 (TRX):';
        hint.innerHTML = '💡 提币将先扣除 TRX 手续费，再进行 USDT 转账。如遇网络问题，系统会自动重试最多3次。';
    } else {
        labelSpan.innerText = 'TRX';
        feeLabel.innerHTML = '带宽费 (TRX):';
        hint.innerHTML = '💡 TRX 提币优先使用免费带宽，带宽不足时自动燃烧 TRX。建议预留 5 TRX 确保转账成功。';
    }
    
    // 刷新余额和费用显示
    await loadWithdrawPageData();
}

async function loadWithdrawPageData() {
    const assets = await getUserAssets(true);
    const tokenType = document.getElementById('withdrawTokenType')?.value || 'USDT';
    const balanceDisplay = document.getElementById('balanceDisplay');
    
    if (balanceDisplay) {
        if (tokenType === 'USDT') {
            balanceDisplay.innerHTML = `💰 可用 USDT: ${assets.usdt.toFixed(2)} USDT`;
        } else {
            balanceDisplay.innerHTML = `💰 可用 TRX: ${assets.trx.toFixed(2)} TRX`;
        }
    }
    
    const amountInput = document.getElementById('withdrawAmount');
    if (amountInput && amountInput.value) {
        const amount = parseFloat(amountInput.value);
        if (amount > 0) {
            const trxBalance = assets.trx;
            await updateFeeDisplayForToken(amount, tokenType, trxBalance);
        }
    }
}

async function onWithdrawAmountChange() {
    const amountInput = document.getElementById('withdrawAmount');
    const amount = parseFloat(amountInput.value);
    const tokenType = document.getElementById('withdrawTokenType')?.value || 'USDT';
    
    if (!amount || amount <= 0) {
        document.getElementById('feeAmount').innerText = '0';
        document.getElementById('totalTrxNeeded').innerText = '0';
        document.getElementById('trxBalanceWarning').style.display = 'none';
        const confirmBtn = document.getElementById('withdrawConfirmBtn');
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.style.cursor = 'pointer';
        }
        return;
    }
    
    const config = await getUserFeeConfig();
    const trxBalance = await getUserTrxBalance();
    await updateFeeDisplayForToken(amount, tokenType, trxBalance);
}

// 根据币种更新费用显示
async function updateFeeDisplayForToken(amount, tokenType, trxBalance) {
    let fee = 0;
    let requiredTrx = 0;
    
    if (tokenType === 'USDT') {
        const config = await getUserFeeConfig();
        fee = config.fee;
        requiredTrx = fee + 1;  // 手续费 + 1 预留
    } else {
        // TRX 提币：预留 5 TRX（优先使用免费带宽，不够时燃烧）
        fee = 0;  // TRX 不单独收取手续费
        requiredTrx = 5;  // 建议预留 5 TRX
    }
    
    document.getElementById('feeAmount').innerText = fee.toFixed(2);
    document.getElementById('totalTrxNeeded').innerText = requiredTrx.toFixed(2);
    
    const warningDiv = document.getElementById('trxBalanceWarning');
    const confirmBtn = document.getElementById('withdrawConfirmBtn');
    
    if (trxBalance < requiredTrx) {
        const shortage = (requiredTrx - trxBalance).toFixed(2);
        warningDiv.style.display = 'block';
        if (tokenType === 'USDT') {
            warningDiv.innerHTML = `❌ TRX 余额不足！需要 ${requiredTrx.toFixed(2)} TRX，当前 ${trxBalance.toFixed(2)} TRX，缺少 ${shortage} TRX<br>💡 请先充值 TRX 到您的钱包`;
        } else {
            warningDiv.innerHTML = `❌ TRX 余额不足！建议预留 ${requiredTrx.toFixed(2)} TRX 确保转账成功，当前 ${trxBalance.toFixed(2)} TRX，缺少 ${shortage} TRX<br>💡 请先充值 TRX 到您的钱包`;
        }
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.style.cursor = 'not-allowed';
        }
    } else {
        warningDiv.style.display = 'none';
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.style.cursor = 'pointer';
        }
    }
}

async function executeWithdraw() {
    const walletData = await fetchAPI('/api/get-wallet');
    if (!walletData || !walletData.hasWallet) {
        alert('请先创建钱包');
        closeModal();
        return;
    }
    
    const toAddress = document.getElementById('withdrawTo').value.trim();
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const paymentPassword = document.getElementById('paymentPassword').value;
    const tokenType = document.getElementById('withdrawTokenType')?.value || 'USDT';
    
    if (!toAddress) {
        alert('请输入目标地址');
        return;
    }
    if (!amount || amount <= 0) {
        alert('请输入有效的提币数量');
        return;
    }
    if (!paymentPassword || paymentPassword.length !== 6) {
        alert('请输入6位支付密码');
        return;
    }
    
    if (!toAddress.match(/^T[0-9a-zA-Z]{33}$/)) {
        alert('请输入有效的 TRON 地址（以 T 开头，34位）');
        return;
    }
    
    // 验证余额
    const assets = await getUserAssets(true);
    if (tokenType === 'USDT') {
        if (assets.usdt < amount) {
            alert(`USDT 余额不足！当前 ${assets.usdt.toFixed(2)} USDT`);
            return;
        }
    } else {
        if (assets.trx < amount) {
            alert(`TRX 余额不足！当前 ${assets.trx.toFixed(2)} TRX`);
            return;
        }
        // 检查预留 TRX
        if (assets.trx < amount + 5) {
            alert(`TRX 余额不足！提币 ${amount} TRX 后，建议至少保留 5 TRX 用于手续费，当前 ${assets.trx.toFixed(2)} TRX`);
            return;
        }
    }
    
    // 验证支付密码
    const verifyRes = await fetchAPI('/api/verify-payment-password', { 
        method: 'POST', 
        body: { paymentPassword } 
    });
    if (!verifyRes || !verifyRes.success) {
        alert(verifyRes?.error || '支付密码错误');
        return;
    }
    
    const btn = document.getElementById('withdrawConfirmBtn');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '⏳ 提币处理中...';
    
    const data = await fetchAPI('/api/withdraw', {
        method: 'POST',
        body: { 
            toAddress, 
            amount, 
            paymentPassword,
            tokenType,  // 新增：币种类型
            fee: tokenType === 'USDT' ? (await getUserFeeConfig()).fee : 0
        }
    });
    
    if (data && data.success) {
        alert(`✅ 提币成功！\n币种: ${data.tokenType}\n数量: ${data.amount}\n交易哈希: ${data.txid}`);
        closeModal();
        await refreshUserData();
        await preRenderCardPage();
        await preRenderProfilePage();
        if (currentTab === 'home') await renderHomePage();
        if (currentTab === 'card') {
            await preRenderCardPage();
            document.getElementById('tabContent').innerHTML = pageCache.card;
        }
    } else {
        alert(data?.error || '提币失败，请稍后重试或联系客服');
    }
    
    btn.disabled = false;
    btn.innerText = originalText;
}

async function showSwapPage() {
    // 清除缓存，获取最新配置
    userFeeConfig = null;
    const config = await getUserFeeConfig();
    const fee = config.fee;
    const requiredTrx = fee + 1;
    
    // 获取实时余额
    const usdtBalance = await getUserUsdtBalance();
    const trxBalance = await getUserTrxBalance();
    
    // 构建弹窗HTML - 手续费区域始终可见，初始显示 0
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3> 兑换 USDT → HKD</h3>
        <div class="input-group">
            <label>USDT 数量</label>
            <input type="number" id="swapAmount" class="input-field" placeholder="0.00" step="0.01" value="">
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;" id="usdtBalanceDisplay">💰 可用 USDT: ${usdtBalance.toFixed(2)} USDT</div>
        </div>
        
        <!-- 预计获得 HKD 区域（初始隐藏，输入后显示） -->
        <div id="swapExpectedDisplay" style="background: #e8f5e9; padding: 12px; border-radius: 12px; margin: 12px 0; display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>🇭🇰 您将获得</span>
                <span id="swapExpectedAmount" style="font-size: 20px; font-weight: 700; color: #21c592;">0.00 HKD</span>
            </div>
        </div>
        
        <!-- 手续费显示区域（始终可见，初始显示 0） -->
        <div id="swapFeeDisplay" style="background: #f5f5f5; padding: 12px; border-radius: 12px; margin: 12px 0;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span> 能量 (TRX):</span>
                <span id="swapFeeAmount" style="color: #ff6b6b; font-weight: 600;">0</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span> 预留带宽费 (TRX):</span>
                <span>1.00</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #ddd;">
                <span style="font-weight: 600;"> 您需要准备 (TRX):</span>
                <span id="swapTotalTrxNeeded" style="font-weight: 600; color: #21c592;">0</span>
            </div>
        </div>
        
        <!-- 错误提示区域 -->
        <div id="swapTrxBalanceWarning" style="background: #fff3f3; color: #d32f2f; padding: 10px; border-radius: 8px; margin: 12px 0; display: none; font-size: 13px;"></div>
        <div id="swapUsdtWarning" style="background: #fff3f3; color: #d32f2f; padding: 10px; border-radius: 8px; margin: 12px 0; display: none; font-size: 13px;"></div>
        
        <div class="input-group">
            <label>支付密码</label>
            <input type="password" id="swapPaymentPassword" class="input-field" placeholder="6位支付密码" maxlength="6">
        </div>
        <button class="btn btn-primary" id="swapConfirmBtn" onclick="executeSwap()" disabled style="opacity: 0.5;">确认兑换</button>
        <p style="color: var(--text-muted); font-size: 11px; margin-top: 12px;">💡 输入数量后自动计算手续费和预计获得 HKD</p>
    `;
    
    showModal();
    
    // 绑定输入事件
    const amountInput = document.getElementById('swapAmount');
    if (amountInput) {
        amountInput.addEventListener('input', async () => {
            await updateSwapCalculation();
        });
        amountInput.addEventListener('keyup', async () => {
            await updateSwapCalculation();
        });
    }
}

// 兑换计算函数：输入金额后自动计算手续费和预计获得 HKD
async function updateSwapCalculation() {
    // 1. 获取用户输入的金额
    const amountInput = document.getElementById('swapAmount');
    const amount = parseFloat(amountInput?.value);
    
    // 2. 获取页面上的各种元素
    const feeAmountSpan = document.getElementById('swapFeeAmount');
    const totalTrxSpan = document.getElementById('swapTotalTrxNeeded');
    const expectedDisplay = document.getElementById('swapExpectedDisplay');
    const expectedAmountSpan = document.getElementById('swapExpectedAmount');
    const confirmBtn = document.getElementById('swapConfirmBtn');
    const trxWarningDiv = document.getElementById('swapTrxBalanceWarning');
    const usdtWarningDiv = document.getElementById('swapUsdtWarning');
    
    // ========== 关键修改：如果没有输入金额，直接返回，显示 0 ==========
    if (!amount || amount <= 0) {
        // 手续费显示 0
        if (feeAmountSpan) feeAmountSpan.innerText = '0';
        if (totalTrxSpan) totalTrxSpan.innerText = '0';
        // 隐藏预计获得区域
        if (expectedDisplay) expectedDisplay.style.display = 'none';
        // 隐藏所有警告
        if (trxWarningDiv) trxWarningDiv.style.display = 'none';
        if (usdtWarningDiv) usdtWarningDiv.style.display = 'none';
        // 禁用确认按钮
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.style.cursor = 'not-allowed';
        }
        return;  // 直接退出，不再执行下面的代码
    }
    
    // ========== 只有在输入了金额后，才会执行下面的代码 ==========
    
    // 获取手续费配置和汇率
    userFeeConfig = null;
    const config = await getUserFeeConfig();
    const fee = config.fee;
    const rate = config.rate;
    const requiredTrx = fee + 1;
    
    // 更新手续费显示
    if (feeAmountSpan) feeAmountSpan.innerText = fee;
    if (totalTrxSpan) totalTrxSpan.innerText = requiredTrx;
    
    // 获取实时余额
    const trxBalance = await getUserTrxBalance();
    const usdtBalance = await getUserUsdtBalance();
    
    // 检查 TRX 余额
    let trxOk = true;
    if (trxBalance < requiredTrx) {
        const shortage = (requiredTrx - trxBalance).toFixed(2);
        if (trxWarningDiv) {
            trxWarningDiv.style.display = 'block';
            trxWarningDiv.innerHTML = `❌ TRX 余额不足！需要 ${requiredTrx.toFixed(2)} TRX，当前 ${trxBalance.toFixed(2)} TRX，缺少 ${shortage} TRX<br>💡 请先充值 TRX 到您的钱包`;
        }
        trxOk = false;
    } else {
        if (trxWarningDiv) trxWarningDiv.style.display = 'none';
    }
    
    // 检查 USDT 余额
    let usdtOk = true;
    if (usdtBalance < amount) {
        if (usdtWarningDiv) {
            usdtWarningDiv.style.display = 'block';
            usdtWarningDiv.innerHTML = `❌ USDT 余额不足！需要 ${amount.toFixed(2)} USDT，当前 ${usdtBalance.toFixed(2)} USDT`;
        }
        usdtOk = false;
    } else {
        if (usdtWarningDiv) usdtWarningDiv.style.display = 'none';
    }
    
    // 计算并显示预计获得 HKD
    const expectedHkd = (amount * rate).toFixed(2);
    if (expectedAmountSpan) expectedAmountSpan.innerText = expectedHkd;
    if (expectedDisplay) expectedDisplay.style.display = 'block';
    
    // 控制确认按钮
    if (trxOk && usdtOk) {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.style.cursor = 'pointer';
        }
    } else {
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.style.cursor = 'not-allowed';
        }
    }
    
    console.log(`兑换计算: 数量=${amount}, 手续费=${fee}, 汇率=${rate}, 需要TRX=${requiredTrx}, TRX余额=${trxBalance}, USDT余额=${usdtBalance}`);
}

// 新增：兑换金额变化时的处理函数
async function onSwapAmountChange(fee) {
    const amount = parseFloat(document.getElementById('swapAmount').value);
    if (amount && amount > 0) {
        const rate = await getExchangeRate();
        const expectedHkd = (amount * rate).toFixed(2);
        
        // 在手续费显示区域下方添加预计获得金额
        let feeDisplay = document.getElementById('swapFeeDisplay');
        if (feeDisplay && !document.getElementById('swapExpectedHkd')) {
            const expectedDiv = document.createElement('div');
            expectedDiv.id = 'swapExpectedHkd';
            expectedDiv.style.cssText = 'display: flex; justify-content: space-between; padding-top: 8px; margin-top: 8px; border-top: 1px solid #ddd;';
            expectedDiv.innerHTML = `<span>💵 预计获得:</span><span style="color: #21c592; font-weight: 600;">${expectedHkd} HKD</span>`;
            feeDisplay.appendChild(expectedDiv);
        } else if (document.getElementById('swapExpectedHkd')) {
            document.getElementById('swapExpectedHkd').innerHTML = `<span>💵 预计获得:</span><span style="color: #21c592; font-weight: 600;">${expectedHkd} HKD</span>`;
        }
    }
}

// 获取实时汇率
async function getExchangeRate() {
    try {
        const response = await fetch('/api/exchange-rate');
        const data = await response.json();
        return data.rate || 7.8;
    } catch(e) {
        return 7.8;
    }
}

async function executeSwap() {
    const walletData = await fetchAPI('/api/get-wallet');
    if (!walletData || !walletData.hasWallet) {
        alert('请先创建钱包');
        closeModal();
        return;
    }
    
    const userPrivateKeyVal = walletData.private_key;
    const amount = parseFloat(document.getElementById('swapAmount').value);
    const paymentPassword = document.getElementById('swapPaymentPassword').value;
    
    if (!amount || amount <= 0) {
        alert('请输入有效的USDT数量');
        return;
    }
    if (!paymentPassword) {
        alert('请输入支付密码');
        return;
    }
    
    // 重新获取手续费配置
    userFeeConfig = null;
    const config = await getUserFeeConfig();
    const fee = config.fee;
    const requiredTrx = fee + 1;
    
    // 最终验证 TRX 余额
    const trxBalance = await getUserTrxBalance();
    if (trxBalance < requiredTrx) {
        alert(`TRX 余额不足！需要 ${requiredTrx.toFixed(2)} TRX，当前 ${trxBalance.toFixed(2)} TRX`);
        return;
    }
    
    // 最终验证 USDT 余额
    const usdtBalance = await getUserUsdtBalance();
    if (usdtBalance < amount) {
        alert(`USDT 余额不足！当前 ${usdtBalance.toFixed(2)} USDT`);
        return;
    }
    
    // 验证支付密码
    const verifyRes = await fetchAPI('/api/verify-payment-password', { 
        method: 'POST', 
        body: { paymentPassword } 
    });
    if (!verifyRes || !verifyRes.success) {
        alert(verifyRes?.error || '支付密码错误');
        return;
    }
    
    const btn = document.getElementById('swapConfirmBtn');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '兑换中...';
    btn.style.opacity = '0.5';
    
    try {
        const data = await fetchAPI('/api/hkd/exchange', {
            method: 'POST',
            body: { 
                usdtAmount: amount, 
                privateKey: userPrivateKeyVal,
                paymentPassword: paymentPassword,
                fee: fee
            }
        });
        
        if (data && data.success) {
            alert(`✅ 兑换成功！获得 ${data.hkdAmount.toFixed(2)} HKD，手续费: ${fee} TRX`);
            closeModal();
            await refreshUserData();
            await preRenderCardPage();
            await preRenderProfilePage();
            if (currentTab === 'home') await renderHomePage();
            if (currentTab === 'card') document.getElementById('tabContent').innerHTML = pageCache.card;
        } else {
            alert(data?.error || '兑换失败，请稍后重试');
        }
    } catch (error) {
        alert('兑换失败: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
        btn.style.opacity = '1';
    }
}

async function showInvitePage() {
    if (!userInviteCode) await refreshUserData();
    
    if (userInviteCode && userInviteCode !== 'NULL' && userInviteCode !== 'null') {
        const inviteLink = `${window.location.origin}/register?code=${userInviteCode}`;
        document.getElementById('dynamicModalContent').innerHTML = `
            <h3>推荐好友</h3>
            <div class="invite-code-box">
                <div>您的推荐码</div>
                <div class="invite-code">${userInviteCode}</div>
                <button class="btn btn-secondary" onclick="copyToClipboard('${userInviteCode}')">复制推荐码</button>
            </div>
            <p style="color: var(--text-muted); font-size: 12px;">🎁 推荐好友注册，获得 0.5 USD 奖励！</p>
        `;
    } else {
        document.getElementById('dynamicModalContent').innerHTML = `
            <h3>推荐好友</h3>
            <div class="invite-code-box" style="text-align: center; padding: 30px;">
                <div style="font-size: 48px; margin-bottom: 12px;">🔒</div>
                <div style="font-size: 16px; font-weight: 600;">升级合伙人，获取推荐码</div>
            </div>
        `;
    }
    showModal();
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    alert('已复制到剪贴板');
}

function showTransactionDetail(record) {
    let isPositive = record.amount > 0;
    const displayAmount = Math.abs(record.amount);
    let amountPrefix = isPositive ? '+' : '-';

    // ========== 提现到卡强制显示为负数 ==========
    if (record.to_address === 'PokePay卡' && record.currency === 'HKD') {
        isPositive = false;
        amountPrefix = '-';
    }
    // ========== 处理结束 ==========
    
    // vusdt 强制显示为正数
    if (record.type === 'vusdt') {
        isPositive = true;
        amountPrefix = '+';
    }
    
    const amountClass = isPositive ? 'positive' : 'negative';
    
    let detailsHtml = '';
    if (record.type === 'exchange_hkd') {
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">兑换金额</span><span class="detail-value">${record.usdt_amount} USDT → ${record.amount} HKD</span></div>
            <div class="detail-row"><span class="detail-label">汇率</span><span class="detail-value">1 USDT = ${record.rate} HKD</span></div>
        `;
    } else if (record.type === 'exchange_usdt') {
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">兑换金额</span><span class="detail-value">${record.usdt_amount} USDT → ${record.hkd_amount} HKD</span></div>
            <div class="detail-row"><span class="detail-label">汇率</span><span class="detail-value">1 USDT = ${record.rate} HKD</span></div>
        `;
    } else if (record.type === 'vusdt') {
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">链上转入</span></div>
            <div class="detail-row"><span class="detail-label">发送方</span><span class="detail-value">${record.from_address || '系统归集地址'}</span></div>
            <div class="detail-row"><span class="detail-label">接收方</span><span class="detail-value">${record.to_address || userWallet || '用户钱包'}</span></div>
        `;
    } else if (record.type === 'trx_deposit' || record.type === 'usdt_deposit') {
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">发送方</span><span class="detail-value">${record.from_address || '-'}</span></div>
            <div class="detail-row"><span class="detail-label">接收方</span><span class="detail-value">${record.to_address || userWallet || '-'}</span></div>
        `;
    } else if (record.type === 'transfer_out') {
        // ========== 判断是否是提现到卡 ==========
        if (record.to_address === 'PokePay卡') {
            detailsHtml = `
                <div class="detail-row"><span class="detail-label">业务类型</span><span class="detail-value">提现</span></div>
                <div class="detail-row"><span class="detail-label">收款方</span><span class="detail-value">PokePay卡</span></div>
            `;
        } else {
            detailsHtml = `
                <div class="detail-row"><span class="detail-label">转账类型</span><span class="detail-value">转出</span></div>
                <div class="detail-row"><span class="detail-label">收款方ID</span><span class="detail-value">${record.to_address}</span></div>
            `;
        }
        // ========== 修改结束 ==========
    } else if (record.type === 'deposit') {
        // 推送弹窗专用 + 普通存款
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">普通存款</span></div>
            <div class="detail-row"><span class="detail-label">发送方</span><span class="detail-value">${record.from_address || 'Poke国际'}</span></div>
            <div class="detail-row"><span class="detail-label">接收方</span><span class="detail-value">${record.to_address || currentUser?.uid || '用户'}</span></div>
        `;
    } else if (record.type === 'transfer_in') {
        // 判断是否是提现到卡
        if (record.to_address === 'PokePay卡') {
            detailsHtml = `
                <div class="detail-row"><span class="detail-label">业务类型</span><span class="detail-value">提现</span></div>
                <div class="detail-row"><span class="detail-label">提现方ID</span><span class="detail-value">${record.from_address || currentUser?.uid || '用户'}</span></div>
            `;
        } else if (record.from_address === 'Poke国际') {
            // 充值（普通存款）
            detailsHtml = `
                <div class="detail-row"><span class="detail-label">业务类型</span><span class="detail-value">普通存款</span></div>
                <div class="detail-row"><span class="detail-label">发送方</span><span class="detail-value">${record.from_address}</span></div>
                <div class="detail-row"><span class="detail-label">接收方ID</span><span class="detail-value">${record.to_address || currentUser?.uid || '用户'}</span></div>
            `;
        } else {
            // 其他转入
            detailsHtml = `
                <div class="detail-row"><span class="detail-label">转账类型</span><span class="detail-value">转入</span></div>
                <div class="detail-row"><span class="detail-label">转账方ID</span><span class="detail-value">${record.from_address}</span></div>
            `;
        }
    } else {
        detailsHtml = `
            <div class="detail-row"><span class="detail-label">发送方</span><span class="detail-value">${record.from_address || '-'}</span></div>
            <div class="detail-row"><span class="detail-label">接收方</span><span class="detail-value">${record.to_address || '-'}</span></div>
        `;
    }
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <div class="detail-amount ${amountClass}">${amountPrefix}${displayAmount.toFixed(2)} ${record.currency}</div>
        <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value" style="color: var(--accent-green);">已完成</span></div>
        ${detailsHtml}
        <div class="detail-row"><span class="detail-label">交易时间</span><span class="detail-value">${record.created_at}</span></div>
    `;
    showModal();
}

function showModal() { 
    const modal = document.getElementById('dynamicModal');
    if (modal) modal.classList.remove('hidden');
}

function closeModal() { 
    const modal = document.getElementById('dynamicModal');
    if (modal) modal.classList.add('hidden');
    // 停止访客轮询
    stopGuestPolling();
    // ========== 修复：关闭弹窗时也要停止客服轮询，之前这里漏掉了，导致轮询永远停不下来 ==========
    stopSupportPolling();
    // ========== 新增：重置外层弹窗的overflow，避免影响其他需要滚动的弹窗 ==========
    const modalContentEl = document.querySelector('#dynamicModal .modal-content');
    if (modalContentEl) modalContentEl.style.overflowY = '';
    // ========== 新增结束 ==========
}

function showLoginForm() {
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('showLoginBtn').classList.add('active');
    document.getElementById('showRegisterBtn').classList.remove('active');
}

function showRegisterForm() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('showLoginBtn').classList.remove('active');
    document.getElementById('showRegisterBtn').classList.add('active');
}

async function handleLogout() {
    if (sseConnection) {
        sseConnection.close();
        sseConnection = null;
      }
    await fetchAPI('/api/logout', { method: 'POST' });
    currentUser = null;
    userWallet = null;
    userPrivateKey = null;
    pageCache = { home: null, card: null, profile: null };
    preloadedData = { totalData: null, flowRecords: null, userDataLoaded: false, assets: null };

    // 清空登录表单
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    
    await checkSession();
}

// ============= 页面初始化 =============
window.onload = async () => {

    // 绑定验证码发送按钮
const sendBtn = document.getElementById('sendVerificationBtn');
if (sendBtn) {
  sendBtn.addEventListener('click', sendVerificationCode);
}

// 邮箱输入变化时重置验证码按钮
const emailInput = document.getElementById('regEmail');
if (emailInput) {
  emailInput.addEventListener('input', function() {
    if (this.value.trim() !== this._lastEmail) {
      this._lastEmail = this.value.trim();
      resetVerificationButton();
    }
  });
}
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tab = item.getAttribute('data-tab');
            if (tab) {
                loadTab(tab);
            }
        });
    });
    
    const modalClose = document.getElementById('modalClose');
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalClose) modalClose.onclick = closeModal;
    if (modalOverlay) modalOverlay.onclick = closeModal;
    
    const showLoginBtn = document.getElementById('showLoginBtn');
    const showRegisterBtn = document.getElementById('showRegisterBtn');
    if (showLoginBtn) showLoginBtn.onclick = showLoginForm;
    if (showRegisterBtn) showRegisterBtn.onclick = showRegisterForm;
    
    const doLoginBtn = document.getElementById('doLoginBtn');
    const doRegisterBtn = document.getElementById('doRegisterBtn');
    if (doLoginBtn) doLoginBtn.onclick = handleLogin;
    if (doRegisterBtn) doRegisterBtn.onclick = handleRegister;
    
    await checkSession();
};

// ============= 设置菜单功能 =============

// 设置菜单
function showSettingsMenu() {
    const pwdStatusText = userHasPaymentPassword ? '已设置' : '未设置';
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 20px;">⚙️ 设置</h3>
        <div class="menu-list">
            <button class="menu-item" onclick="closeModal(); showResetPasswordPage()" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">🔐</span><span>重置密码</span></div>
                <div class="menu-right">›</div>
            </button>
            <button class="menu-item" onclick="closeModal(); showChangeEmailModal()" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">📧</span><span>修改邮箱</span></div>
                <div class="menu-right">›</div>
            </button>
            <button class="menu-item" onclick="closeModal(); showPaymentPasswordModal()" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">💰</span><span>支付密码</span></div>
                <div class="menu-right" style="color: ${userHasPaymentPassword ? '#999' : '#e53e3e'};">${pwdStatusText} ›</div>
            </button>
            <button class="menu-item" onclick="closeModal(); showAboutPage()" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">ℹ️</span><span>关于</span></div>
                <div class="menu-right">›</div>
            </button>
            <button class="menu-item" onclick="closeModal(); showDeleteAccountModal()" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">⚠️</span><span style="color: #e53e3e;">注销账户</span></div>
                <div class="menu-right">›</div>
            </button>
        </div>
    `;
    showModal();
}

// ========== 新增：注销账户弹窗 ==========
// 两步走：先展示警告文案，用户确认要继续 → 再要求输入登录密码二次确认后才真正提交。
function showDeleteAccountModal() {
  const existing = document.getElementById('deleteAccountModal');
  if (existing) existing.remove();

  const modalHtml = `
  <div id="deleteAccountModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
    <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
      <button id="deleteAccountModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

      <div style="text-align: center; margin-bottom: 12px;">
        <span style="font-size: 32px;">⚠️</span>
      </div>

      <div style="text-align: center; font-size: 16px; font-weight: 700; color: #e53e3e; margin-bottom: 10px;">注销账户</div>
      <div style="text-align: center; font-size: 13px; color: #666; line-height: 1.6; margin-bottom: 18px;">
        注销后账户将<b>无法再登录</b>，此操作<b>不可撤销</b>。<br>
        请确认账户余额及已绑定卡片内的资金均已提现或转出，否则将无法完成注销。
      </div>

      <div style="margin-bottom: 8px;">
        <input id="deleteAccountPasswordInput" type="password" placeholder="请输入登录密码以确认" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#e53e3e'" onblur="this.style.borderColor='#e5e7eb'">
      </div>
      <div id="deleteAccountError" style="color: #ef4444; font-size: 12px; margin-top: 2px; min-height: 16px;"></div>

      <div style="margin-top: 10px; display: flex; gap: 10px;">
        <button id="deleteAccountCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
        <button id="deleteAccountConfirm" onclick="submitDeleteAccount()" style="flex: 1; background: #e53e3e; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#c53030'" onmouseout="this.style.background='#e53e3e'">确认注销</button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('deleteAccountModal');
  document.getElementById('deleteAccountModalClose').onclick = closeDeleteAccountModal;
  document.getElementById('deleteAccountCancel').onclick = closeDeleteAccountModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDeleteAccountModal();
  });
  document.getElementById('deleteAccountPasswordInput').focus();
}

function closeDeleteAccountModal() {
  const modal = document.getElementById('deleteAccountModal');
  if (modal) modal.remove();
}

async function submitDeleteAccount() {
  const password = document.getElementById('deleteAccountPasswordInput').value;
  const errorEl = document.getElementById('deleteAccountError');
  errorEl.textContent = '';

  if (!password) {
    errorEl.textContent = '请输入登录密码';
    return;
  }

  const confirmBtn = document.getElementById('deleteAccountConfirm');
  confirmBtn.disabled = true;
  const originalText = confirmBtn.innerText;
  confirmBtn.innerText = '处理中...';

  try {
    const data = await fetchAPI('/api/user/delete-account', {
      method: 'POST',
      body: { password }
    });

    if (data && data.success) {
      closeDeleteAccountModal();
      alert('✅ ' + (data.message || '账户已注销'));
      // 注销成功后，服务端已销毁 session，这里同步清理本地状态并回到登录页
      await handleLogout();
    } else {
      errorEl.textContent = (data && data.error) || '注销失败，请稍后重试';
      confirmBtn.disabled = false;
      confirmBtn.innerText = originalText;
    }
  } catch (err) {
    errorEl.textContent = '网络错误，请稍后重试';
    confirmBtn.disabled = false;
    confirmBtn.innerText = originalText;
  }
}
// ========== 新增结束 ==========

// ========== 新增：设置/找回支付密码弹窗（跟公告弹窗同一套 Poke 风格）==========
// 不需要旧密码——无论是第一次设置还是忘记了原密码，流程一样：验证邮箱验证码后直接覆盖设置。
let paymentPwdSendingCode = false;
let paymentPwdCountdownTimer = null;

function showPaymentPasswordModal() {
  const existing = document.getElementById('paymentPwdModal');
  if (existing) existing.remove();

  const isFirstSet = !userHasPaymentPassword;
  const subtitle = isFirstSet
    ? '首次设置支付密码，验证码将发送至您的注册邮箱'
    : '找回/修改支付密码，验证码将发送至您的注册邮箱';

  const modalHtml = `
  <div id="paymentPwdModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
    <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
      <button id="paymentPwdModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

      <div style="text-align: center; margin-bottom: 12px;">
        <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
        <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
      </div>
      <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

      <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">${isFirstSet ? '设置支付密码' : '找回/修改支付密码'}</div>
      <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">${subtitle}</div>

      <input id="paymentPwdNewInput" type="password" inputmode="numeric" maxlength="6" placeholder="新支付密码（6位数字）" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 4px; outline: none; margin-bottom: 10px; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
      <input id="paymentPwdConfirmInput" type="password" inputmode="numeric" maxlength="6" placeholder="确认新支付密码" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 4px; outline: none; margin-bottom: 12px; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">

      <div style="display: flex; gap: 8px; margin-bottom: 8px;">
        <input id="paymentPwdCodeInput" type="text" inputmode="numeric" maxlength="6" placeholder="请输入6位验证码" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <button id="paymentPwdSendBtn" style="flex-shrink: 0; padding: 0 16px; white-space: nowrap; font-size: 13px; background: #21c592; color: white; border: none; border-radius: 12px; cursor: pointer; min-width: 108px;">获取验证码</button>
      </div>
      <div id="paymentPwdError" style="color: #ef4444; font-size: 12px; margin-top: 2px; min-height: 16px;"></div>

      <div style="margin-top: 10px; display: flex; gap: 10px;">
        <button id="paymentPwdCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
        <button id="paymentPwdConfirm" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认设置</button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('paymentPwdModal');
  const errorEl = document.getElementById('paymentPwdError');
  const sendBtn = document.getElementById('paymentPwdSendBtn');
  const confirmBtn = document.getElementById('paymentPwdConfirm');

  function closePaymentPwdModal() {
    if (paymentPwdCountdownTimer) {
      clearInterval(paymentPwdCountdownTimer);
      paymentPwdCountdownTimer = null;
    }
    paymentPwdSendingCode = false;
    modal.remove();
  }

  document.getElementById('paymentPwdModalClose').onclick = closePaymentPwdModal;
  document.getElementById('paymentPwdCancel').onclick = closePaymentPwdModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePaymentPwdModal();
  });

  sendBtn.onclick = async () => {
    if (paymentPwdSendingCode) return;
    errorEl.textContent = '';
    paymentPwdSendingCode = true;
    sendBtn.disabled = true;
    sendBtn.innerText = '发送中...';
    sendBtn.style.opacity = '0.6';

    try {
      const data = await fetchAPI('/api/send-verification', {
        method: 'POST',
        body: { type: 'payment_password' }
      });

      if (data && data.success) {
        let seconds = 60;
        sendBtn.innerText = `${seconds}秒后重新获取`;
        if (paymentPwdCountdownTimer) clearInterval(paymentPwdCountdownTimer);
        paymentPwdCountdownTimer = setInterval(() => {
          seconds--;
          if (seconds <= 0) {
            clearInterval(paymentPwdCountdownTimer);
            paymentPwdCountdownTimer = null;
            paymentPwdSendingCode = false;
            sendBtn.disabled = false;
            sendBtn.innerText = '重新获取';
            sendBtn.style.opacity = '1';
          } else {
            sendBtn.innerText = `${seconds}秒后重新获取`;
          }
        }, 1000);
      } else {
        paymentPwdSendingCode = false;
        sendBtn.disabled = false;
        sendBtn.innerText = '获取验证码';
        sendBtn.style.opacity = '1';
        errorEl.textContent = (data && data.error) || '验证码发送失败，请稍后重试';
      }
    } catch (e) {
      paymentPwdSendingCode = false;
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
      sendBtn.style.opacity = '1';
      errorEl.textContent = '网络请求失败，请检查网络连接';
    }
  };

  confirmBtn.onclick = async () => {
    const newPwd = document.getElementById('paymentPwdNewInput').value.trim();
    const confirmPwd = document.getElementById('paymentPwdConfirmInput').value.trim();
    const code = document.getElementById('paymentPwdCodeInput').value.trim();
    errorEl.textContent = '';

    if (!/^\d{6}$/.test(newPwd)) {
      errorEl.textContent = '支付密码必须为6位数字';
      return;
    }
    if (newPwd !== confirmPwd) {
      errorEl.textContent = '两次输入的支付密码不一致';
      return;
    }
    if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
      errorEl.textContent = '请输入6位数字验证码';
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.6';

    try {
      const data = await fetchAPI('/api/user/set-payment-password', {
        method: 'POST',
        body: { newPaymentPassword: newPwd, verificationCode: code }
      });

      if (data && data.success) {
        userHasPaymentPassword = true;
        closePaymentPwdModal();
        alert('✅ ' + (data.message || '支付密码设置成功'));
      } else {
        errorEl.textContent = (data && data.error) || '设置失败，请稍后重试';
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
      }
    } catch (e) {
      errorEl.textContent = '网络请求失败: ' + e.message;
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '1';
    }
  };

  document.getElementById('paymentPwdNewInput').focus();
}

// ========== 新增：修改邮箱弹窗（跟公告弹窗同一套 Poke 风格） ==========
let changeEmailSendingCode = false;
let changeEmailCountdownTimer = null;

function showChangeEmailModal() {
  const existing = document.getElementById('changeEmailModal');
  if (existing) existing.remove();

  const modalHtml = `
  <div id="changeEmailModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
    <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
      <button id="changeEmailModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

      <div style="text-align: center; margin-bottom: 12px;">
        <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
        <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
      </div>
      <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

      <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">修改邮箱</div>
      <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">验证新邮箱后即可完成修改，账户其他数据不受影响</div>

      <div style="margin-bottom: 12px;">
        <input id="changeEmailInput" type="email" placeholder="请输入新邮箱" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
      </div>
      <div style="display: flex; gap: 8px; margin-bottom: 8px;">
        <input id="changeEmailCodeInput" type="text" inputmode="numeric" maxlength="6" placeholder="请输入6位验证码" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <button id="changeEmailSendBtn" onclick="sendChangeEmailCode()" style="flex-shrink: 0; padding: 0 16px; white-space: nowrap; font-size: 13px; background: #21c592; color: white; border: none; border-radius: 12px; cursor: pointer; min-width: 108px;">获取验证码</button>
      </div>
      <div id="changeEmailError" style="color: #ef4444; font-size: 12px; margin-top: 2px; min-height: 16px;"></div>

      <div style="margin-top: 14px; display: flex; gap: 10px;">
        <button id="changeEmailCancel" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
        <button id="changeEmailConfirm" onclick="submitChangeEmail()" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认</button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('changeEmailModal');
  document.getElementById('changeEmailModalClose').onclick = closeChangeEmailModal;
  document.getElementById('changeEmailCancel').onclick = closeChangeEmailModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeChangeEmailModal();
  });
  document.getElementById('changeEmailInput').focus();
}

function closeChangeEmailModal() {
  if (changeEmailCountdownTimer) {
    clearInterval(changeEmailCountdownTimer);
    changeEmailCountdownTimer = null;
  }
  changeEmailSendingCode = false;
  const modal = document.getElementById('changeEmailModal');
  if (modal) modal.remove();
}

async function sendChangeEmailCode() {
  const emailInput = document.getElementById('changeEmailInput');
  const errorEl = document.getElementById('changeEmailError');
  const email = emailInput.value.trim();
  const sendBtn = document.getElementById('changeEmailSendBtn');

  if (changeEmailSendingCode) return;
  errorEl.textContent = '';

  if (!email || !isValidEmail(email)) {
    errorEl.textContent = '请输入正确的邮箱地址';
    emailInput.focus();
    return;
  }

  changeEmailSendingCode = true;
  sendBtn.disabled = true;
  sendBtn.innerText = '发送中...';
  sendBtn.style.opacity = '0.6';

  try {
    const data = await fetchAPI('/api/send-verification', {
      method: 'POST',
      body: { email, type: 'change_email' }
    });

    if (data && data.success) {
      let seconds = 60;
      sendBtn.innerText = `${seconds}秒后重新获取`;
      if (changeEmailCountdownTimer) clearInterval(changeEmailCountdownTimer);
      changeEmailCountdownTimer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
          clearInterval(changeEmailCountdownTimer);
          changeEmailCountdownTimer = null;
          changeEmailSendingCode = false;
          sendBtn.disabled = false;
          sendBtn.innerText = '重新获取';
          sendBtn.style.opacity = '1';
        } else {
          sendBtn.innerText = `${seconds}秒后重新获取`;
        }
      }, 1000);
    } else {
      changeEmailSendingCode = false;
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
      sendBtn.style.opacity = '1';
      errorEl.textContent = (data && data.error) || '验证码发送失败，请稍后重试';
    }
  } catch (e) {
    changeEmailSendingCode = false;
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
    sendBtn.style.opacity = '1';
    errorEl.textContent = '网络请求失败，请检查网络连接';
  }
}

async function submitChangeEmail() {
  const email = document.getElementById('changeEmailInput').value.trim();
  const code = document.getElementById('changeEmailCodeInput').value.trim();
  const errorEl = document.getElementById('changeEmailError');
  errorEl.textContent = '';

  if (!email || !isValidEmail(email)) {
    errorEl.textContent = '请输入正确的邮箱地址';
    return;
  }
  if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
    errorEl.textContent = '请输入6位数字验证码';
    return;
  }

  const confirmBtn = document.getElementById('changeEmailConfirm');
  confirmBtn.disabled = true;
  confirmBtn.style.opacity = '0.6';

  const data = await fetchAPI('/api/user/change-email', {
    method: 'POST',
    body: { newEmail: email, verificationCode: code }
  });

  confirmBtn.disabled = false;
  confirmBtn.style.opacity = '1';

  if (data && data.success) {
    closeChangeEmailModal();
    showChangeEmailSuccessModal();
  } else {
    errorEl.textContent = (data && data.error) || '修改失败，请稍后重试';
  }
}

// 修改成功弹窗：点击确认后退出并跳转到登录页面
function showChangeEmailSuccessModal() {
  const existing = document.getElementById('changeEmailSuccessModal');
  if (existing) existing.remove();

  const modalHtml = `
  <div id="changeEmailSuccessModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
    <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 32px 24px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; animation: fadeIn 0.3s ease;">
      <div style="text-align: center; margin-bottom: 12px;">
        <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
        <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
      </div>
      <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>
      <div style="font-size: 40px; margin-bottom: 8px;">✅</div>
      <div style="font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 24px;">邮箱修改成功，请以新邮箱重新登录</div>
      <button id="changeEmailSuccessConfirm" style="width: 100%; padding: 14px; background: #21c592; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#18ac94'" onmouseout="this.style.background='#21c592'">确认</button>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  document.getElementById('changeEmailSuccessConfirm').onclick = async () => {
    const modal = document.getElementById('changeEmailSuccessModal');
    if (modal) modal.remove();
    await handleLogout();
    showLoginForm();
  };
}
// ========== 新增结束 ==========

// 重置密码页面
function showResetPasswordPage() {
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 20px;">🔐 修改登录密码</h3>
        <div class="input-group">
            <label class="input-label">原密码</label>
            <input type="password" id="oldLoginPassword" class="input-field" placeholder="请输入原登录密码">
        </div>
        <div class="input-group">
            <label class="input-label">新登录密码</label>
            <input type="password" id="newLoginPassword" class="input-field" placeholder="6-20位，字母数字组合">
        </div>
        <div class="input-group">
            <label class="input-label">确认新登录密码</label>
            <input type="password" id="confirmLoginPassword" class="input-field" placeholder="请再次输入新密码">
        </div>
        <button class="btn btn-primary" onclick="submitResetPassword()" style="margin-top: 20px;">确认修改</button>
    `;
    showModal();
}

// 提交重置密码
async function submitResetPassword() {
    const oldLoginPwd = document.getElementById('oldLoginPassword').value;
    const newLoginPwd = document.getElementById('newLoginPassword').value;
    const confirmLoginPwd = document.getElementById('confirmLoginPassword').value;
    
    if (!newLoginPwd || newLoginPwd !== confirmLoginPwd) {
        alert('两次输入的新登录密码不一致');
        return;
    }
    if (newLoginPwd.length < 6) {
        alert('新登录密码至少6位');
        return;
    }
    
    const data = await fetchAPI('/api/user/change-password', {
        method: 'POST',
        body: { oldLoginPwd, newLoginPwd }
    });
    
    if (data && data.success) {
        alert('密码修改成功，请重新登录');
        closeModal();
        setTimeout(() => handleLogout(), 1500);
    } else {
        alert(data?.error || '修改失败');
    }
}

// 关于页面
function showAboutPage() {
    document.getElementById('dynamicModalContent').innerHTML = `
        <div style="text-align: center; padding: 20px 0;">
            <div style="font-size: 48px; margin-bottom: 8px;">💳</div>
            <div style="font-size: 20px; font-weight: 600;">PokePay</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 24px;">当前版本 2.5.30</div>
        </div>
        <div class="menu-list">
            <button class="menu-item" onclick="openAboutPage('company')">
                <div class="menu-left"><span class="menu-icon">🏢</span><span>公司介绍</span></div>
                <div class="menu-right">›</div>
            </button>
            <button class="menu-item" onclick="openAboutPage('agreement')">
                <div class="menu-left"><span class="menu-icon">📄</span><span>服务协议</span></div>
                <div class="menu-right">›</div>
            </button>
            <button class="menu-item" onclick="openAboutPage('privacy')">
                <div class="menu-left"><span class="menu-icon">🔒</span><span>隐私政策</span></div>
                <div class="menu-right">›</div>
            </button>
        </div>
    `;
    showModal();
}

// 打开关于子页面
function openAboutPage(type) {
    let url = '';
    if (type === 'company') {
        url = '/about/company-introduction.html';
    } else if (type === 'agreement') {
        url = '/about/service-agreement.html';
    } else if (type === 'privacy') {
        url = '/about/privacy-policy.html';
    }
    window.open(url, '_blank');
    closeModal();
}

// ============= 客服系统功能 =============

let currentMessages = [];
let isLoadingMessages = false;
let hasMoreMessages = true;
let lastMessageId = null;
let supportPollingInterval = null;
let supportPendingImage = null; // 已登录用户客服聊天：待发送的图片（压缩后的 base64）

// ========== 新增：客服聊天图片工具函数（登录用户 / 访客共用） ==========
// 选择图片后在浏览器端压缩（限制最长边，转成 JPEG），减少上传体积
function compressImageForSupport(file, maxDim = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('请选择图片文件'));
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round(height * (maxDim / width));
                        width = maxDim;
                    } else {
                        width = Math.round(width * (maxDim / height));
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(file);
    });
}

// 点击聊天里的图片，弹出全屏大图查看
function viewSupportImage(url) {
    if (!url) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:8px;';
    img.onclick = (e) => e.stopPropagation();
    overlay.appendChild(img);
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
}

// 根据一条消息生成显示内容：图片（未过期/已过期）+ 文字 + 按钮消息（绑卡/转人工）
function renderSupportMessageContent(msg) {
    let html = '';
    if (msg.attachment) {
        const safeUrl = escapeHtml(msg.attachment);
        html += `<img src="${safeUrl}" class="support-chat-image" onclick="viewSupportImage('${safeUrl}')" style="max-width:160px; max-height:160px; border-radius:10px; display:block; cursor:zoom-in; object-fit:cover;${msg.message ? ' margin-bottom:6px;' : ''}">`;
    } else if (msg.attachment_expired) {
        html += `<div style="font-size:12px; opacity:0.7; font-style:italic;${msg.message ? ' margin-bottom:6px;' : ''}">🖼 图片已过期清除</div>`;
    }
    if (msg.message) {
        html += `<div>${escapeHtml(msg.message)}</div>`;
    }
    // ========== 新增：带按钮的消息（立即绑卡 / 转接人工客服） ==========
    if (msg.msg_type === 'action_button' && msg.action_data) {
        let actionData = null;
        try { actionData = typeof msg.action_data === 'string' ? JSON.parse(msg.action_data) : msg.action_data; } catch (e) {}
        if (actionData && actionData.action) {
            const clickFn = actionData.action === 'bind_card_manual' ? 'handleBindCardActionClick(this)' : 'handleRequestHumanActionClick(this)';
            html += `<button type="button" onclick="${clickFn}" style="margin-top:8px; background:#21c592; color:#fff; border:none; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer;">${escapeHtml(actionData.label || '点击处理')}</button>`;
        }
    }
    // ========== 新增结束 ==========
    return html;
}

// ========== 新增：按钮消息 点击处理 ==========
async function handleBindCardActionClick(btnEl) {
    const fullCardNumber = await showCardNumberModal({
        title: '立即绑卡',
        subtitle: '请输入完整卡号完成绑定'
    });
    if (!fullCardNumber) return;
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = '核实中...'; }
    const result = await fetchAPI('/api/kyc/manual-bind-card', {
        method: 'POST',
        body: { fullCardNumber }
    });
    if (result && result.success) {
        alert('绑卡成功！');
        if (btnEl) { btnEl.innerText = '已完成绑卡'; }
    } else {
        alert(result?.error || '绑卡失败，请重试');
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = '立即绑卡'; }
        if (result && result.contactSupport) {
            // 这张卡已被别人绑定 / 卡片信息异常等情况，直接引导联系人工客服
            await handleRequestHumanActionClick(null);
        }
    }
    await loadSupportMessages();
}

async function handleRequestHumanActionClick(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = '正在转接...'; }
    await fetchAPI('/api/support/request-human', { method: 'POST' });
    if (btnEl) { btnEl.innerText = '已转接人工客服'; }
    await loadSupportMessages();
}
// ========== 新增结束 ==========
// ========== 客服聊天图片工具函数 结束 ==========

async function showSupportPage(isResetPassword = false) {
    await loadSupportConversation();
    
    const title = isResetPassword ? t('reset_password_assist') : t('customer_service');
    const description = isResetPassword ? t('reset_password_assist') : t('support_hours');
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <div style="display: flex; flex-direction: column; height: min(520px, calc(80vh - 100px));">
            <div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color);">
                <h3 style="font-size: 18px;">${isResetPassword ? '🔐' : '🎧'} ${title}</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${description}</p>
            </div>
            
            <div id="supportMessagesList" style="flex: 1; overflow-y: auto; margin-bottom: 16px; padding-right: 8px;">
                <div id="supportLoadingMore" style="text-align: center; padding: 8px; color: var(--text-muted); display: none;">${t('loading')}...</div>
                <div id="supportMessagesContainer"></div>
            </div>
            
            <div style="border-top: 1px solid var(--border-color); padding-top: 16px;">
                <div id="supportImagePreviewWrap" style="display:none; margin-bottom: 10px; position:relative; width:64px;">
                    <img id="supportImagePreview" style="width:64px; height:64px; object-fit:cover; border-radius:8px; border:1px solid var(--border-color); display:block;">
                    <button type="button" id="supportImagePreviewRemove" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; background:#e53e3e; color:#fff; border:none; font-size:12px; line-height:1; cursor:pointer;">×</button>
                </div>
                <div style="display: flex; gap: 12px;">
                    <input type="file" id="supportImageInput" accept="image/*" style="display:none;">
                    <button id="supportImageBtn" type="button"
                        style="align-self: flex-end; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 12px; width: 44px; height: 44px; font-size: 18px; cursor: pointer;">
                        🖼
                    </button>
                    <textarea id="supportMessageInput" 
                        style="flex: 1; padding: 12px; border: 1px solid var(--border-color); border-radius: 12px; resize: none; font-size: 14px; min-height: 60px;"
                        placeholder="${t('type_message')}"></textarea>
                    <button id="supportSendBtn" 
                        style="align-self: flex-end; background: var(--accent-blue); color: white; border: none; border-radius: 12px; padding: 12px 20px; cursor: pointer; font-weight: 600;">
                        ${t('send')}
                    </button>
                </div>
                <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">💡 ${t('support_hours')}</p>
            </div>
        </div>
    `;
    
    showModal();
    // ========== 新增：关闭外层弹窗自身的滚动条，只保留内层消息列表的滚动条 ==========
    const modalContentEl = document.querySelector('#dynamicModal .modal-content');
    if (modalContentEl) modalContentEl.style.overflowY = 'hidden';
    // ========== 新增结束 ==========
    
    document.getElementById('supportSendBtn').onclick = sendSupportMessage;
    document.getElementById('supportMessageInput').addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            sendSupportMessage();
        }
    });

    // ========== 新增：客服聊天图片选择与预览 ==========
    supportPendingImage = null;
    document.getElementById('supportImageBtn').onclick = () => document.getElementById('supportImageInput').click();
    document.getElementById('supportImageInput').onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            supportPendingImage = await compressImageForSupport(file);
            document.getElementById('supportImagePreview').src = supportPendingImage;
            document.getElementById('supportImagePreviewWrap').style.display = 'block';
        } catch (err) {
            alert(err.message || '图片处理失败');
        }
    };
    document.getElementById('supportImagePreviewRemove').onclick = () => {
        supportPendingImage = null;
        document.getElementById('supportImagePreviewWrap').style.display = 'none';
    };
    // ========== 新增结束 ==========
    
    const messagesList = document.getElementById('supportMessagesList');
    messagesList.addEventListener('scroll', handleSupportScroll);
    
    // ========== 修复：容器创建好之后再加载消息，确保能正确渲染出历史记录 ==========
    await loadSupportMessages();
    updateSupportUnreadBadge();
    // ========== 修复结束 ==========
    
    startSupportPolling();
}

function startSupportPolling() {
    if (supportPollingInterval) clearInterval(supportPollingInterval);
    supportPollingInterval = setInterval(async () => {
        const data = await fetchAPI('/api/support/messages?limit=500');
        if (data && data.success && data.messages) {
            if (data.messages.length > currentMessages.length) {
                currentMessages = data.messages;
                renderSupportMessages();
                scrollToBottom();
            }
        }
    }, 5000);
}

function stopSupportPolling() {
    if (supportPollingInterval) {
        clearInterval(supportPollingInterval);
        supportPollingInterval = null;
    }
}

async function loadSupportConversation() {
    await fetchAPI('/api/support/conversation');
}

async function loadSupportMessages(reset = true) {
    if (isLoadingMessages) return;
    
    isLoadingMessages = true;
    
    let url = '/api/support/messages?limit=20';
    if (!reset && lastMessageId) {
        url += `&beforeId=${lastMessageId}`;
        const loadingMore = document.getElementById('supportLoadingMore');
        if (loadingMore) loadingMore.style.display = 'block';
    }
    
    const data = await fetchAPI(url);
    
    if (data && data.success) {
        if (reset) {
            currentMessages = data.messages;
            lastMessageId = currentMessages.length > 0 ? currentMessages[0].id : null;
            hasMoreMessages = data.messages.length >= 20;
        } else {
            if (data.messages.length > 0) {
                currentMessages = [...data.messages, ...currentMessages];
                lastMessageId = data.messages[0]?.id;
                hasMoreMessages = data.messages.length >= 20;
            } else {
                hasMoreMessages = false;
            }
        }
        renderSupportMessages();
        if (reset) scrollToBottom();
    }
    
    isLoadingMessages = false;
    const loadingMore = document.getElementById('supportLoadingMore');
    if (loadingMore) loadingMore.style.display = 'none';
}

function renderSupportMessages() {
    const container = document.getElementById('supportMessagesContainer');
    if (!container) return;
    
    if (currentMessages.length === 0) {
        container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">${t('no_messages')}</div>`;
        return;
    }
    
    let lastDate = null;
    let html = '';
    
    for (const msg of currentMessages) {
        const msgDate = new Date(msg.created_at).toLocaleDateString();
        if (lastDate !== msgDate) {
            html += `<div style="text-align: center; margin: 12px 0;"><span style="background: var(--bg-input); padding: 4px 12px; border-radius: 20px; font-size: 11px; color: var(--text-muted);">${msgDate}</span></div>`;
            lastDate = msgDate;
        }
        
        const isUser = msg.direction === 'user';
        const time = msg.created_at;
        
        html += `
            <div style="display: flex; justify-content: ${isUser ? 'flex-end' : 'flex-start'}; margin-bottom: 16px;">
                <div style="max-width: 80%;">
                    <div style="background: ${isUser ? 'var(--accent-blue)' : '#f0f2f5'}; color: ${isUser ? 'white' : 'var(--text-primary)'}; padding: 10px 14px; border-radius: ${isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};">
                        ${renderSupportMessageContent(msg)}
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; text-align: ${isUser ? 'right' : 'left'};">
                        ${time} ${isUser ? '' : `· ${t('customer_service_reply')}`}
                    </div>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    setTimeout(() => {
        const messagesList = document.getElementById('supportMessagesList');
        if (messagesList) {
            messagesList.scrollTop = messagesList.scrollHeight;
        }
    }, 100);
}

function handleSupportScroll() {
    const messagesList = document.getElementById('supportMessagesList');
    if (!messagesList) return;
    
    if (messagesList.scrollTop === 0 && !isLoadingMessages && hasMoreMessages) {
        loadSupportMessages(false);
    }
}

async function sendSupportMessage() {
    const input = document.getElementById('supportMessageInput');
    const message = input.value.trim();
    
    if (!message && !supportPendingImage) {
        alert(t('msg_please_enter_content'));
        return;
    }
    
    const btn = document.getElementById('supportSendBtn');
    btn.disabled = true;
    btn.innerText = t('loading');
    
    const data = await fetchAPI('/api/support/send', {
        method: 'POST',
        body: { message, image: supportPendingImage }
    });
    
    if (data && data.success) {
        input.value = '';
        supportPendingImage = null;
        const previewWrap = document.getElementById('supportImagePreviewWrap');
        if (previewWrap) previewWrap.style.display = 'none';
        await loadSupportMessages(true);
    } else {
        alert(data?.error || t('msg_send_failed'));
    }
    
    btn.disabled = false;
    btn.innerText = t('send');
}

// ============= 语言切换功能 =============

function showLanguageSelector() {
    const currentLang = getCurrentLanguage();
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 20px;">${t('profile_language')}</h3>
        <div class="menu-list">
            <button class="menu-item" onclick="selectLanguage('zh-CN')" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">🇨🇳</span><span>简体中文</span></div>
                <div class="menu-right">${currentLang === 'zh-CN' ? '✓' : ''}</div>
            </button>
            <button class="menu-item" onclick="selectLanguage('zh-HK')" style="width: 100%; text-align: left; padding: 12px 0;">
                <div class="menu-left"><span class="menu-icon">🇭🇰</span><span>繁體中文（香港）</span></div>
                <div class="menu-right">${currentLang === 'zh-HK' ? '✓' : ''}</div>
            </button>
        </div>
    `;
    showModal();
}

function selectLanguage(locale) {
    setLanguage(locale);
}

// 修改 navigateTo 函数，添加客服入口
// 在原有的 navigateTo 函数中添加：
// else if (page === 'support') showSupportPage(false);

// 忘记密码 - 显示客服联系方式
function showForgotPasswordSupport() {
    showModal();
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 16px;">🔐 找回密码</h3>
        <div style="text-align: center; padding: 10px 0;">
            <div style="font-size: 48px; margin-bottom: 16px;">📧</div>
            <p style="color: var(--text-secondary); margin-bottom: 8px;">
                请发送邮件至以下邮箱，客服将协助您重置密码
            </p>
            <div style="background: #f0f2f5; padding: 16px; border-radius: 12px; margin: 20px 0;">
                <p style="font-size: 16px; font-weight: 600; word-break: break-all;">support@pokepay.com</p>
            </div>
            <p style="color: var(--text-muted); font-size: 12px; margin-bottom: 16px;">
                邮件标题请注明：密码重置 + 您的注册手机号/邮箱
            </p>
            <button class="btn btn-secondary" onclick="copyToClipboard('support@pokepay.com', '客服邮箱')">复制邮箱</button>
            <button class="btn btn-primary" onclick="closeModal()" style="margin-top: 12px;">关闭</button>
        </div>
    `;
}
// ============= 访客客服功能（新增） =============

// 重写 showSupportPage，添加访客模式判断
const originalShowSupportPage = window.showSupportPage;
window.showSupportPage = function(isResetPassword = false) {
    // 检查是否已登录（根据您的全局变量 currentUser 判断）
    const isLoggedIn = !!currentUser;
    
    if (!isLoggedIn) {
        showGuestSupportPage(isResetPassword);
        return;
    }
    
    // 如果已登录，调用原有的客服页面函数
    if (originalShowSupportPage) {
        originalShowSupportPage(isResetPassword);
    } else {
        // 如果原有的函数不存在（兼容性），直接调用登录用户的客服页面
        showLoggedInSupportPage(isResetPassword);
    }
};

// 访客客服页面
function showGuestSupportPage(isResetPassword) {
    let guestId = sessionStorage.getItem('guest_support_id');
    if (!guestId) {
        guestId = 'g' + Date.now() + Math.random().toString(36).substr(2, 6);
        sessionStorage.setItem('guest_support_id', guestId);
    }
    
    const title = isResetPassword ? '🔐 找回密码' : '🎧 客服中心';
    const description = isResetPassword ? '请联系客服协助重置密码' : '请留下联系方式，客服会尽快回复';
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <div style="display: flex; flex-direction: column; height: min(520px, calc(80vh - 100px));">
            <div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color);">
                <h3 style="font-size: 18px;">${title}</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${description}</p>
            </div>
            
            <div class="input-group" style="margin-bottom: 16px;">
                <label class="input-label">联系方式（选填）</label>
                <input type="text" id="guestEmail" class="input-field" placeholder="请输入您的邮箱，以便客服回复">
                <p style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">💡 填写邮箱后，客服可以通过邮件回复您</p>
            </div>
            
            <div id="guestMessagesList" style="flex: 1; overflow-y: auto; margin-bottom: 16px; background: #f8f9fa; border-radius: 12px; padding: 12px;">
                <div style="text-align: center; color: #999; padding: 40px 0;">
                    <div style="font-size: 48px; margin-bottom: 12px;">💬</div>
                    <p>发送您的问题，客服会尽快回复</p>
                </div>
            </div>
            
            <div style="border-top: 1px solid var(--border-color); padding-top: 16px;">
                <div id="guestImagePreviewWrap" style="display:none; margin-bottom: 10px; position:relative; width:64px;">
                    <img id="guestImagePreview" style="width:64px; height:64px; object-fit:cover; border-radius:8px; border:1px solid var(--border-color); display:block;">
                    <button type="button" id="guestImagePreviewRemove" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; background:#e53e3e; color:#fff; border:none; font-size:12px; line-height:1; cursor:pointer;">×</button>
                </div>
                <div style="display: flex; gap: 12px;">
                    <input type="file" id="guestImageInput" accept="image/*" style="display:none;">
                    <button id="guestImageBtn" type="button"
                        style="align-self: flex-end; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 12px; width: 44px; height: 44px; font-size: 18px; cursor: pointer;">
                        🖼
                    </button>
                    <textarea id="guestMessageInput" 
                        style="flex: 1; padding: 12px; border: 1px solid var(--border-color); border-radius: 12px; resize: none; font-size: 14px; min-height: 60px;"
                        placeholder="请输入您的问题..."></textarea>
                    <button id="guestSendBtn" 
                        style="align-self: flex-end; background: var(--accent-blue); color: white; border: none; border-radius: 12px; padding: 12px 20px; cursor: pointer; font-weight: 600;">
                        发送
                    </button>
                </div>
                <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">💡 客服在线时间：工作日 9:00-18:00</p>
            </div>
        </div>
    `;
    showModal();
    // ========== 新增：关闭外层弹窗自身的滚动条，只保留内层消息列表的滚动条 ==========
    const modalContentEl = document.querySelector('#dynamicModal .modal-content');
    if (modalContentEl) modalContentEl.style.overflowY = 'hidden';
    // ========== 新增结束 ==========
    
    // 加载历史消息
    loadGuestMessages(guestId);

    // 启动轮询（每 5 秒检查一次新消息）
    startGuestPolling(guestId);
    
    document.getElementById('guestSendBtn').onclick = () => sendGuestMessage(guestId);
    document.getElementById('guestMessageInput').addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') sendGuestMessage(guestId);
    });

    // ========== 新增：访客客服聊天图片选择与预览 ==========
    guestPendingImage = null;
    document.getElementById('guestImageBtn').onclick = () => document.getElementById('guestImageInput').click();
    document.getElementById('guestImageInput').onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            guestPendingImage = await compressImageForSupport(file);
            document.getElementById('guestImagePreview').src = guestPendingImage;
            document.getElementById('guestImagePreviewWrap').style.display = 'block';
        } catch (err) {
            alert(err.message || '图片处理失败');
        }
    };
    document.getElementById('guestImagePreviewRemove').onclick = () => {
        guestPendingImage = null;
        document.getElementById('guestImagePreviewWrap').style.display = 'none';
    };
    // ========== 新增结束 ==========
}

async function loadGuestMessages(guestId) {
    try {
        const data = await fetchAPI(`/api/support/guest/messages/${guestId}`);
        if (data && data.success && data.messages && data.messages.length > 0) {
            const container = document.getElementById('guestMessagesList');
            if (container) {
                let html = '';
                for (const msg of data.messages) {
                    const isUser = msg.direction === 'user';
                    const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    html += `
                        <div style="display: flex; justify-content: ${isUser ? 'flex-end' : 'flex-start'}; margin-bottom: 16px;">
                            <div style="max-width: 80%;">
                                <div style="background: ${isUser ? 'var(--accent-blue)' : '#e9ecef'}; color: ${isUser ? 'white' : 'var(--text-primary)'}; padding: 10px 14px; border-radius: ${isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};">
                                    ${renderSupportMessageContent(msg)}
                                </div>
                                <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; text-align: ${isUser ? 'right' : 'left'};">
                                    ${time} ${isUser ? '' : '· 客服'}
                                </div>
                            </div>
                        </div>
                    `;
                }
                container.innerHTML = html;
                // 滚动到底部
                container.scrollTop = container.scrollHeight;
                // 更新消息计数
                lastMessageCount = data.messages.length;
            }
        }
    } catch(e) { 
        console.log('加载历史消息失败:', e); 
    }
}

async function sendGuestMessage(guestId) {
    const input = document.getElementById('guestMessageInput');
    const message = input.value.trim();
    const guestEmail = document.getElementById('guestEmail')?.value.trim() || '';
    if (!message && !guestPendingImage) { alert('请输入消息内容或选择一张图片'); return; }
    
    const btn = document.getElementById('guestSendBtn');
    btn.disabled = true; btn.innerText = '发送中...';
    
    const imageToSend = guestPendingImage;
    const data = await fetchAPI('/api/support/guest/send', {
        method: 'POST', body: { message, guestId, guestEmail, image: imageToSend }
    });
    
    if (data && data.success) {
        input.value = '';
        guestPendingImage = null;
        const previewWrap = document.getElementById('guestImagePreviewWrap');
        if (previewWrap) previewWrap.style.display = 'none';
        const container = document.getElementById('guestMessagesList');
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const imageHtml = imageToSend ? `<img src="${imageToSend}" class="support-chat-image" onclick="viewSupportImage('${imageToSend}')" style="max-width:160px; max-height:160px; border-radius:10px; display:block; cursor:zoom-in; object-fit:cover;${message ? ' margin-bottom:6px;' : ''}">` : '';
        const newMsgHtml = `
            <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
                <div style="max-width: 80%;">
                    <div style="background: var(--accent-blue); color: white; padding: 10px 14px; border-radius: 18px 18px 4px 18px;">
                        ${imageHtml}${message ? escapeHtml(message) : ''}
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; text-align: right;">
                        ${time}
                    </div>
                </div>
            </div>
        `;
        container.innerHTML += newMsgHtml;
        container.scrollTop = container.scrollHeight;
        lastMessageCount += 1;
        alert('消息已发送，客服会尽快回复您');
    } else {
        alert(data?.error || '发送失败，请稍后重试');
    }
    btn.disabled = false; btn.innerText = '发送';
}

// 确保 escapeHtml 函数存在（如果您的文件里没有，这个会补上）
if (typeof escapeHtml !== 'function') {
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 访客轮询变量
let guestPollingInterval = null;
let currentGuestId = null;
let lastMessageCount = 0;
let guestPendingImage = null; // 访客客服聊天：待发送的图片（压缩后的 base64）

// 启动访客轮询
function startGuestPolling(guestId) {
    currentGuestId = guestId;
    if (guestPollingInterval) clearInterval(guestPollingInterval);
    
    // 先获取当前消息数量
    setTimeout(async () => {
        await updateGuestMessageCount(guestId);
    }, 500);
    
    guestPollingInterval = setInterval(async () => {
        await checkGuestNewMessages(guestId);
    }, 5000); // 每5秒检查一次
}

// 更新消息数量
async function updateGuestMessageCount(guestId) {
    try {
        const data = await fetchAPI(`/api/support/guest/messages/${guestId}`);
        if (data && data.success && data.messages) {
            lastMessageCount = data.messages.length;
        }
    } catch(e) {}
}

// 检查新消息
async function checkGuestNewMessages(guestId) {
    try {
        const data = await fetchAPI(`/api/support/guest/messages/${guestId}`);
        if (data && data.success && data.messages) {
            const currentCount = data.messages.length;
            if (currentCount > lastMessageCount) {
                // 有新消息，重新加载
                await loadGuestMessages(guestId);
                lastMessageCount = currentCount;
                // 播放提示音或震动（可选）
                if (typeof window.navigator.vibrate === 'function') {
                    window.navigator.vibrate(200);
                }
            }
        }
    } catch(e) {}
}

// 停止访客轮询（关闭弹窗时调用）
function stopGuestPolling() {
    if (guestPollingInterval) {
        clearInterval(guestPollingInterval);
        guestPollingInterval = null;
    }
}

// ============= 通知提示（点击铃铛查看通告） =============
async function showNotificationTip() {
  try {
    const data = await fetchAPI('/api/announcement');
    if (data && data.success && data.hasAnnouncement && data.content) {
      // 从铃铛打开，传入 true
      showAnnouncementModal(data.content, true);
    } else {
      alert('📭 暂无新通知');
    }
  } catch(e) {
    console.log('获取通知失败:', e);
    alert('📭 暂无新通知');
  }
}

// ============= 用户间 HKD 转账功能 =============
// 显示转账页面
async function showTransferPage() {
    // 获取用户余额
    const userInfo = await fetchAPI('/api/user-info');
    const balance = userInfo?.hkdBalance || 0;
    
    document.getElementById('dynamicModalContent').innerHTML = `
        <h3 style="margin-bottom: 20px;">💰 钱包转账</h3>
        <div class="input-group">
            <label class="input-label">收款方用户ID</label>
            <input type="text" id="transferToUid" class="input-field" placeholder="请输入对方10位用户ID">
        </div>
        <div class="input-group">
            <label class="input-label">转账金额 (HKD)</label>
            <input type="number" id="transferAmount" class="input-field" placeholder="0.00" step="0.01">
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">可用余额: ${balance.toFixed(2)} HKD</div>
        </div>
        <div class="input-group">
            <label class="input-label">支付密码</label>
            <input type="password" id="transferPaymentPassword" class="input-field" placeholder="6位支付密码" maxlength="6">
        </div>
        <button class="btn btn-primary" onclick="executeTransfer()" style="margin-top: 16px;">确认转账</button>
        <button class="btn btn-secondary" onclick="closeModal()" style="margin-top: 12px;">取消</button>
    `;
    showModal();
}

// 执行转账
async function executeTransfer() {
    const toUid = document.getElementById('transferToUid').value.trim();
    const amount = parseFloat(document.getElementById('transferAmount').value);
    const paymentPassword = document.getElementById('transferPaymentPassword').value;
    
    if (!toUid) {
        alert('请输入收款方用户ID');
        return;
    }
    if (!amount || amount <= 0) {
        alert('请输入有效的转账金额');
        return;
    }
    if (!paymentPassword || paymentPassword.length !== 6) {
        alert('请输入6位支付密码');
        return;
    }
    
    // 验证支付密码
    const verifyRes = await fetchAPI('/api/verify-payment-password', {
        method: 'POST',
        body: { paymentPassword }
    });
    if (!verifyRes || !verifyRes.success) {
        alert(verifyRes?.error || '支付密码错误');
        return;
    }
    
    const btn = document.querySelector('#dynamicModalContent .btn-primary');
    if (btn) {
        btn.disabled = true;
        btn.innerText = '转账中...';
    }
    
    const data = await fetchAPI('/api/transfer/hkd', {
        method: 'POST',
        body: { toUid, amount }
    });
    
    if (data && data.success) {
        alert(`转账成功！已向用户 ${toUid} 转账 ${amount} HKD`);
        closeModal();
        // 刷新数据
        await refreshUserData();
        await renderHomePage();
        if (currentTab === 'card') {
            await preRenderCardPage();
            document.getElementById('tabContent').innerHTML = pageCache.card;
        }
    } else {
        alert(data?.error || '转账失败');
    }
    
    if (btn) {
        btn.disabled = false;
        btn.innerText = '确认转账';
    }
}

// ============= 钱包冻结功能 =============
// 检查钱包是否被管理员冻结
async function isWalletFrozen() {
    const data = await fetchAPI('/api/user/wallet-status');
    const newStatus = data?.frozen === true;
    if (isWalletFrozenStatus !== newStatus) {
        console.log(`管理员冻结状态变更: ${isWalletFrozenStatus} -> ${newStatus}`);
        isWalletFrozenStatus = newStatus;
    }
    return isWalletFrozenStatus;
}

// ============= 手续费相关函数 =============

// 获取用户手续费配置
async function getUserFeeConfig() {
    if (userFeeConfig) return userFeeConfig;
    
    const data = await fetchAPI('/api/user-fee-config');
    if (data && data.success) {
        userFeeConfig = { 
            fee: data.fee || 8,
            rate: data.rate || 7.8
        };
        console.log('获取到手续费配置:', userFeeConfig);
        return userFeeConfig;
    }
    return { fee: 8, rate: 7.8 };
}

// 资产缓存
let cachedAssets = { trx: 0, usdt: 0 };
let lastAssetFetchTime = 0;
const ASSET_CACHE_TTL = 30000; // 30秒缓存

// 获取用户资产（带缓存）
async function getUserAssets(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && (now - lastAssetFetchTime) < ASSET_CACHE_TTL) {
        return cachedAssets;
    }
    
    const data = await fetchAPI('/api/assets');
    if (data && data.assets) {
        const trxAsset = data.assets.find(a => a.token === 'TRX');
        const usdtAsset = data.assets.find(a => a.token === 'USDT');
        cachedAssets = {
            trx: parseFloat(trxAsset?.balance || 0),
            usdt: parseFloat(usdtAsset?.balance || 0)
        };
        lastAssetFetchTime = now;
        return cachedAssets;
    }
    return { trx: 0, usdt: 0 };
}

// 获取用户链上 TRX 余额（保持函数名兼容）
async function getUserTrxBalance() {
    const assets = await getUserAssets();
    return assets.trx;
}

// 获取用户链上 USDT 余额（保持函数名兼容）
async function getUserUsdtBalance() {
    const assets = await getUserAssets();
    return assets.usdt;
}

// 计算提币手续费
function calculateWithdrawFee(amount, config) {
    const fee = config.fee;
    const requiredTrx = fee + 1;
    return { fee, requiredTrx };
}

// ============= 设置取款密码功能（APP内验证码方案，不再跳转邮箱）=============
// 跟公告弹窗同一套 Poke 风格，用法和排版跟"支付密码"弹窗保持一致

let withdrawPinCodeSending = false;
let withdrawPinCountdownTimer = null;

function showSetWithdrawPinModal() {
    const existing = document.getElementById('withdrawPinModal');
    if (existing) existing.remove();

    const modalHtml = `
    <div id="withdrawPinModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 99999;">
      <div style="background: white; border-radius: 24px; max-width: 400px; width: 90%; padding: 28px 24px 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: fadeIn 0.3s ease;">
        <button id="withdrawPinModalClose" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #999; cursor: pointer; padding: 4px 8px; border-radius: 50%; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='transparent'">×</button>

        <div style="text-align: center; margin-bottom: 12px;">
          <span style="font-size: 24px; font-weight: 700; color: #21c592;">Poke</span>
          <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">Pay</span>
        </div>
        <div style="border-top: 2px solid #21c592; width: 50px; margin: 0 auto 16px;"></div>

        <div style="text-align: center; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px;">设置取款密码</div>
        <div style="text-align: center; font-size: 13px; color: #888; margin-bottom: 18px;">验证码将发送至您绑定卡片的注册邮箱</div>

        <input id="wpNewPin" type="password" inputmode="numeric" maxlength="6" placeholder="新取款密码（6位数字）" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 4px; outline: none; margin-bottom: 10px; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
        <input id="wpConfirmPin" type="password" inputmode="numeric" maxlength="6" placeholder="确认新取款密码" style="width: 100%; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 16px; letter-spacing: 4px; outline: none; margin-bottom: 12px; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">

        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input id="wpVerifyCode" type="text" inputmode="numeric" maxlength="6" placeholder="请输入6位验证码" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 13px 14px; border: 1.5px solid #e5e7eb; border-radius: 12px; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#21c592'" onblur="this.style.borderColor='#e5e7eb'">
          <button id="wpSendCodeBtn" style="flex-shrink: 0; padding: 0 16px; white-space: nowrap; font-size: 13px; background: #21c592; color: white; border: none; border-radius: 12px; cursor: pointer; min-width: 108px;">获取验证码</button>
        </div>
        <div id="wpError" style="color: #ef4444; font-size: 12px; margin-top: 2px; min-height: 16px;"></div>

        <div style="margin-top: 10px; display: flex; gap: 10px;">
          <button id="wpCancelBtn" style="flex: 1; background: #f0f2f5; color: #666; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f0f2f5'">取消</button>
          <button id="wpSubmitBtn" style="flex: 1; background: #21c592; color: white; border: none; border-radius: 12px; padding: 12px 0; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1aad7a'" onmouseout="this.style.background='#21c592'">确认设置</button>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('withdrawPinModal');
    const errorEl = document.getElementById('wpError');
    const sendBtn = document.getElementById('wpSendCodeBtn');
    const submitBtn = document.getElementById('wpSubmitBtn');

    function closeWithdrawPinModal() {
        if (withdrawPinCountdownTimer) {
            clearInterval(withdrawPinCountdownTimer);
            withdrawPinCountdownTimer = null;
        }
        withdrawPinCodeSending = false;
        modal.remove();
    }

    document.getElementById('withdrawPinModalClose').onclick = closeWithdrawPinModal;
    document.getElementById('wpCancelBtn').onclick = closeWithdrawPinModal;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeWithdrawPinModal();
    });

    sendBtn.onclick = async () => {
        if (withdrawPinCodeSending) return;
        withdrawPinCodeSending = true;
        sendBtn.disabled = true;
        sendBtn.innerText = '发送中...';
        sendBtn.style.opacity = '0.6';
        errorEl.textContent = '';

        try {
            const data = await fetchAPI('/api/send-verification', {
                method: 'POST',
                body: { type: 'card_pin' }
            });

            if (data && data.success) {
                let seconds = 60;
                sendBtn.innerText = `${seconds}秒后重发`;
                if (withdrawPinCountdownTimer) clearInterval(withdrawPinCountdownTimer);
                withdrawPinCountdownTimer = setInterval(() => {
                    seconds--;
                    if (seconds <= 0) {
                        clearInterval(withdrawPinCountdownTimer);
                        withdrawPinCountdownTimer = null;
                        withdrawPinCodeSending = false;
                        sendBtn.disabled = false;
                        sendBtn.innerText = '发送验证码';
                        sendBtn.style.opacity = '1';
                    } else {
                        sendBtn.innerText = `${seconds}秒后重发`;
                    }
                }, 1000);
            } else {
                withdrawPinCodeSending = false;
                sendBtn.disabled = false;
                sendBtn.innerText = '获取验证码';
                sendBtn.style.opacity = '1';
                errorEl.textContent = (data && data.error) || '发送失败，请稍后重试';
            }
        } catch (e) {
            withdrawPinCodeSending = false;
            sendBtn.disabled = false;
            sendBtn.innerText = '获取验证码';
            sendBtn.style.opacity = '1';
            errorEl.textContent = '网络请求失败: ' + e.message;
        }
    };

    submitBtn.onclick = async () => {
        const newPin = document.getElementById('wpNewPin').value.trim();
        const confirmPin = document.getElementById('wpConfirmPin').value.trim();
        const verificationCode = document.getElementById('wpVerifyCode').value.trim();

        errorEl.textContent = '';

        if (!/^\d{6}$/.test(newPin)) {
            errorEl.textContent = '取款密码必须是6位数字';
            return;
        }
        if (newPin !== confirmPin) {
            errorEl.textContent = '两次输入的取款密码不一致';
            return;
        }
        if (!/^\d{6}$/.test(verificationCode)) {
            errorEl.textContent = '请输入6位邮箱验证码';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.innerText = '设置中...';
        submitBtn.style.opacity = '0.6';

        try {
            const data = await fetchAPI('/api/card/pin/verify-and-set', {
                method: 'POST',
                body: { newPin, verificationCode }
            });

            if (data && data.success) {
                closeWithdrawPinModal();
                alert('✅ ' + (data.message || '取款密码设置成功'));
            } else {
                errorEl.textContent = (data && data.error) || '设置失败，请稍后重试';
                submitBtn.disabled = false;
                submitBtn.innerText = '确认设置';
                submitBtn.style.opacity = '1';
            }
        } catch (e) {
            errorEl.textContent = '网络请求失败: ' + e.message;
            submitBtn.disabled = false;
            submitBtn.innerText = '确认设置';
            submitBtn.style.opacity = '1';
        }
    };

    document.getElementById('wpNewPin').focus();
}
