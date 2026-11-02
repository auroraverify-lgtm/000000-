const APP_NAME = 'Aurora';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('Unable to decode push notification payload:', error);
  }

  if (payload.type === 'call-ended' && payload.callId) {
    event.waitUntil(self.registration.getNotifications({ tag: `aurora-call-${payload.callId}` })
      .then((notifications) => notifications.forEach((notification) => notification.close())));
    return;
  }

  const title = String(payload.title || APP_NAME).slice(0, 80);
  const isCall = payload.type === 'incoming-call';
  const options = {
    body: String(payload.body || 'Новое сообщение').slice(0, 180),
    icon: payload.icon || '/assets/icons/app-icon.svg',
    badge: payload.badge || '/assets/icons/favicon.svg',
    image: payload.image || undefined,
    tag: payload.tag || (isCall ? `aurora-call-${payload.callId || 'incoming'}` : 'aurora-message'),
    renotify: isCall,
    requireInteraction: isCall,
    vibrate: isCall ? [300, 100, 300, 100, 500] : undefined,
    actions: isCall ? [
      { action: 'answer', title: 'Ответить' },
      { action: 'decline', title: 'Отклонить' },
    ] : [],
    data: {
      url: payload.url || '/',
      type: isCall ? 'incoming-call' : 'message',
      callId: payload.callId || null,
      chatId: payload.chatId || null,
    },
  };
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!payload.test && windows.some((client) => client.visibilityState === 'visible')) return;
    return self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || '/', self.location.origin);
  const safeHash = /^#\/chat\/\d+$/.test(requestedUrl.hash) || requestedUrl.hash === '#/settings' ? requestedUrl.hash : '#/chats';
  const targetUrl = new URL('/', self.location.origin);
  targetUrl.hash = safeHash;
  const data = event.notification.data || {};
  const callId = String(data.callId || '');
  if (data.type === 'incoming-call'
    && ['answer', 'decline'].includes(event.action)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    targetUrl.searchParams.set('callAction', event.action);
    targetUrl.searchParams.set('callId', callId);
    targetUrl.searchParams.set('callActionAt', String(Date.now()));
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        try {
          await client.navigate(targetUrl.href);
          return client.focus();
        } catch (error) {
          console.error('Unable to navigate the existing Aurora window:', error);
        }
      }
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});
