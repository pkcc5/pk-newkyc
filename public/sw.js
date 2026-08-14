// sw.js - Service Worker
const CACHE_NAME = 'support-pwa-v1';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                '/support',
                '/manifest.json'
            ]);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 处理推送通知
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: '新消息', body: '您有一条新消息' };
    }
    
    const options = {
        body: data.body || '点击查看详情',
        icon: '/favicon.png',
        badge: '/favicon.png',
        vibrate: [200, 100, 200],
        // ========== 新增：按会话分组，同一个用户的多条新消息只保留/替换最新这一条通知，避免在 Android 上无限堆叠 ==========
        tag: data.userId ? `support-${data.userId}` : 'support-general',
        renotify: true, // 同一个 tag 被替换时依然震动/提示一次，避免客服误以为没有新消息
        // ========== 新增结束 ==========
        data: {
            url: data.url || '/support',
            userId: data.userId || null,
            unreadCount: data.unreadCount || 0
        }
    };
    
    const notifyPromise = self.registration.showNotification(data.title || '客服工作台', options);

    // ========== 修复：角标更新逻辑 ==========
    // 原来的写法是 `if (setAppBadge && data.unreadCount)`，当 unreadCount 为 0（比如所有会话都已读）时会整体跳过，
    // 导致角标残留一个过期的旧数字，永远清不掉。这里改成：有未读就设置数字，没有未读就明确清零。
    let badgePromise = Promise.resolve();
    if (self.navigator && 'setAppBadge' in self.navigator) {
        badgePromise = (data.unreadCount && data.unreadCount > 0
            ? self.navigator.setAppBadge(data.unreadCount)
            : self.navigator.clearAppBadge()
        ).catch(() => {
            // Badging API 在部分浏览器/平台（如桌面版 Safari、Firefox、部分 Linux 环境、Android Chrome 等）不生效或会被拒绝，
            // 这是平台限制而非代码错误，静默忽略即可，不影响通知本身的展示。
        });
    }
    // ========== 修复结束 ==========

    event.waitUntil(Promise.all([notifyPromise, badgePromise]));
});

// 用户点击通知时
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    // ========== 修复：不再无条件清零角标 ==========
    // 点击某一条通知只代表客服看到了"这一条"提醒，不代表其他会话也都处理完了。
    // 真正准确的未读总数由页面里的 loadSupportConversations() 统一维护角标（见 support.html），
    // 这里不再做任何角标操作，避免把其他会话的未读数也一并清掉。
    // ========== 修复结束 ==========
    
    event.waitUntil(
        clients.openWindow(event.notification.data.url || '/support')
    );
});

// 网络请求拦截
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
