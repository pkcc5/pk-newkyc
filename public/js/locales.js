// public/js/locales.js - 语言包（简体中文 + 繁体中文香港版）

const translations = {
    // 简体中文
    'zh-CN': {
        // 通用
        'app_name': 'PokePay',
        'loading': '加载中...',
        'confirm': '确认',
        'cancel': '取消',
        'copy': '复制',
        'copied': '已复制',
        'close': '关闭',
        'send': '发送',
        'reply': '回复',
        'type_message': '请输入消息...',
        'online_customer_service': '在线客服',
        'working_hours': '工作时间: 工作日 9:00-18:00',
        
        // 客服
        'customer_service': '客服中心',
        'reset_password_assist': '请联系客服协助重置密码',
        'no_messages': '暂无消息，发送您的问题开始咨询',
        'customer_service_reply': '客服',
        'support_hours': '客服在线时间：工作日 9:00-18:00',
        'support_welcome': '您好！请问有什么可以帮您？',
        
        // 底部导航
        'nav_home': '首页',
        'nav_card': '卡片',
        'nav_profile': '我的',
        
        // 登录页
        'login_title': '登录',
        'login_phone_label': '手机号',
        'login_phone_placeholder': '请输入手机号',
        'login_password_label': '密码',
        'login_password_placeholder': '请输入密码',
        'login_forgot_password': '联系客服找回',
        'login_submit': '登录',
        'login_register_prompt': '没有账号？',
        'login_register_action': '去注册',
        
        // 注册页
        'register_title': '注册',
        'register_phone_label': '手机号',
        'register_phone_placeholder': '请输入手机号',
        'register_name_label': '姓名',
        'register_name_placeholder': '请输入姓名拼音',
        'register_id_label': '身份证号',
        'register_id_placeholder': '请输入18位身份证号',
        'register_card_label': '银行卡号',
        'register_card_placeholder': '请输入银行卡号',
        'register_password_label': '登录密码',
        'register_password_placeholder': '请输入至少8位密码',
        'register_confirm_password_label': '确认登录密码',
        'register_confirm_password_placeholder': '请再次输入密码',
        'register_payment_password_label': '支付密码',
        'register_payment_password_placeholder': '6位数字',
        'register_confirm_payment_label': '确认支付密码',
        'register_confirm_payment_placeholder': '请再次输入6位数字',
        'register_submit': '立即注册',
        'register_login_prompt': '已有账号？',
        'register_login_action': '去登录',
        
        // 卡片页
        'card_balance': '卡内余额',
        'card_balance_label': '余额',
        'card_balance_hkd': '钱包 HKD 余额',
        'card_bind_hint': '请绑定 VISA 卡，如需申请请联系客服',
        'card_withdraw': '提现到卡',
        'card_transactions': '卡片交易记录',
        'card_no_transactions': '暂无交易记录',
        
        // 我的页面
        'profile_kyc': 'KYC 认证',
        'profile_kyc_pending': '待认证',
        'profile_kyc_verified': '已验证',
        'profile_kyc_rejected': '已拒绝',
        'profile_invite': '邀请好友',
        'profile_language': '语言',
        'profile_support': '客服中心',
        'profile_settings': '设置',
        'profile_logout': '退出登录',
        
        // 设置菜单
        'settings_title': '设置',
        'settings_reset_password': '重置密码',
        'settings_about': '关于',
        'settings_delete_account': '注销账户',
        'delete_account_title': '注销账户',
        'delete_account_warning': '注销后账户将无法登录，此操作不可撤销。请确认您已提现所有余额与卡片资金。',
        'delete_account_password_label': '请输入登录密码以确认',
        'delete_account_confirm': '确认注销',
        'delete_account_cancel': '取消',
        'delete_account_success': '账户已注销',
        
        // 重置密码（用户自助）
        'reset_password_title': '重置密码',
        'reset_old_password': '原密码',
        'reset_new_password': '新密码',
        'reset_confirm_password': '确认新密码',
        'reset_old_payment': '原支付密码',
        'reset_new_payment': '新支付密码',
        'reset_confirm_payment': '确认新支付密码',
        'reset_submit': '确认修改',
        'reset_login_password_success': '登录密码修改成功，请重新登录',
        'reset_payment_password_success': '支付密码修改成功',
        
        // 关于
        'about_version': '当前版本',
        'about_company': '公司介绍',
        'about_agreement': '服务协议',
        'about_privacy': '隐私政策',
        
        // 消息提示
        'msg_send_success': '发送成功',
        'msg_send_failed': '发送失败，请稍后重试',
        'msg_please_enter_content': '请输入消息内容',
        'msg_network_error': '网络错误，请稍后重试'
    },
    
    // 繁体中文（香港版）
    'zh-HK': {
        // 通用
        'app_name': 'PokePay',
        'loading': '載入中...',
        'confirm': '確認',
        'cancel': '取消',
        'copy': '複製',
        'copied': '已複製',
        'close': '關閉',
        'send': '發送',
        'reply': '回覆',
        'type_message': '請輸入訊息...',
        'online_customer_service': '線上客服',
        'working_hours': '工作時間: 工作日 9:00-18:00',
        
        // 客服
        'customer_service': '客服中心',
        'reset_password_assist': '請聯繫客服協助重設密碼',
        'no_messages': '暫無訊息，發送您的問題開始諮詢',
        'customer_service_reply': '客服',
        'support_hours': '客服在線時間：工作日 9:00-18:00',
        'support_welcome': '您好！請問有甚麼可以幫您？',
        
        // 底部導航
        'nav_home': '首頁',
        'nav_card': '卡片',
        'nav_profile': '我的',
        
        // 登入頁
        'login_title': '登入',
        'login_phone_label': '手機號碼',
        'login_phone_placeholder': '請輸入手機號碼',
        'login_password_label': '密碼',
        'login_password_placeholder': '請輸入密碼',
        'login_forgot_password': '聯繫客服找回',
        'login_submit': '登入',
        'login_register_prompt': '沒有帳號？',
        'login_register_action': '去註冊',
        
        // 註冊頁
        'register_title': '註冊',
        'register_phone_label': '手機號碼',
        'register_phone_placeholder': '請輸入手機號碼',
        'register_name_label': '姓名',
        'register_name_placeholder': '請輸入姓名拼音',
        'register_id_label': '身份證號碼',
        'register_id_placeholder': '請輸入18位身份證號碼',
        'register_card_label': '銀行卡號',
        'register_card_placeholder': '請輸入銀行卡號',
        'register_password_label': '登入密碼',
        'register_password_placeholder': '請輸入至少8位密碼',
        'register_confirm_password_label': '確認登入密碼',
        'register_confirm_password_placeholder': '請再次輸入密碼',
        'register_payment_password_label': '支付密碼',
        'register_payment_password_placeholder': '6位數字',
        'register_confirm_payment_label': '確認支付密碼',
        'register_confirm_payment_placeholder': '請再次輸入6位數字',
        'register_submit': '立即註冊',
        'register_login_prompt': '已有帳號？',
        'register_login_action': '去登入',
        
        // 卡片頁
        'card_balance': '卡內餘額',
        'card_balance_label': '餘額',
        'card_balance_hkd': '錢包 HKD 餘額',
        'card_bind_hint': '請綁定 VISA 卡，如需申請請聯繫客服',
        'card_withdraw': '提現到卡',
        'card_transactions': '卡片交易記錄',
        'card_no_transactions': '暫無交易記錄',
        
        // 我的頁面
        'profile_kyc': 'KYC 認證',
        'profile_kyc_pending': '待認證',
        'profile_kyc_verified': '已驗證',
        'profile_kyc_rejected': '已拒絕',
        'profile_invite': '邀請好友',
        'profile_language': '語言',
        'profile_support': '客服中心',
        'profile_settings': '設定',
        'profile_logout': '登出',
        
        // 設定選單
        'settings_title': '設定',
        'settings_reset_password': '重設密碼',
        'settings_about': '關於',
        'settings_delete_account': '註銷帳戶',
        'delete_account_title': '註銷帳戶',
        'delete_account_warning': '註銷後帳戶將無法登入，此操作不可撤銷。請確認您已提現所有餘額與卡片資金。',
        'delete_account_password_label': '請輸入登入密碼以確認',
        'delete_account_confirm': '確認註銷',
        'delete_account_cancel': '取消',
        'delete_account_success': '帳戶已註銷',
        
        // 重設密碼（用戶自助）
        'reset_password_title': '重設密碼',
        'reset_old_password': '原密碼',
        'reset_new_password': '新密碼',
        'reset_confirm_password': '確認新密碼',
        'reset_old_payment': '原支付密碼',
        'reset_new_payment': '新支付密碼',
        'reset_confirm_payment': '確認新支付密碼',
        'reset_submit': '確認修改',
        'reset_login_password_success': '登入密碼修改成功，請重新登入',
        'reset_payment_password_success': '支付密碼修改成功',
        
        // 關於
        'about_version': '目前版本',
        'about_company': '公司介紹',
        'about_agreement': '服務協議',
        'about_privacy': '隱私政策',
        
        // 訊息提示
        'msg_send_success': '發送成功',
        'msg_send_failed': '發送失敗，請稍後重試',
        'msg_please_enter_content': '請輸入訊息內容',
        'msg_network_error': '網絡錯誤，請稍後重試'
    }
};

// 当前语言
let currentLocale = localStorage.getItem('poke_language') || 'zh-CN';

// 翻译函数
function t(key) {
    return translations[currentLocale]?.[key] || key;
}

// 设置语言
function setLanguage(locale) {
    if (locale !== 'zh-CN' && locale !== 'zh-HK') return;
    currentLocale = locale;
    localStorage.setItem('poke_language', locale);
    location.reload();
}

// 获取当前语言
function getCurrentLanguage() {
    return currentLocale;
}

// 获取语言显示名称
function getLanguageDisplayName(locale) {
    if (locale === 'zh-CN') return '简体中文';
    if (locale === 'zh-HK') return '繁體中文（香港）';
    return '简体中文';
}
