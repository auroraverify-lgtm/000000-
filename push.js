import fs from 'node:fs';
import path from 'node:path';
import { createSign } from 'node:crypto';
import webpush from 'web-push';
import { DATA_DIR } from './config.js';
import { now, nativePushTokens, pushSubscriptions } from './db.js';

const vapidPath = path.join(DATA_DIR, 'push-vapid.json');
let vapidKeys;
if (fs.existsSync(vapidPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapidKeys), { mode: 0o600, flag: 'wx' });
}
webpush.setVapidDetails(
  process.env.PUSH_VAPID_SUBJECT || 'https://snobbishly-bountiful-quail.cloudpub.ru',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

const trustedPushHosts = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
];
const fcmServiceAccountPath = process.env.FCM_SERVICE_ACCOUNT_FILE || '';
let serviceAccount;
let accessToken;
let accessTokenExpiresAt = 0;
let accessTokenRequest;

function getServiceAccount() {
  if (!fcmServiceAccountPath) return null;
  if (!serviceAccount) {
    const parsed = JSON.parse(fs.readFileSync(fcmServiceAccountPath, 'utf8'));
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('FCM service account file is missing required fields');
    }
    serviceAccount = parsed;
  }
  return serviceAccount;
}

export function isNativePushConfigured() {
  return !!fcmServiceAccountPath && fs.existsSync(fcmServiceAccountPath);
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getFcmAccessToken(account) {
  if (accessToken && accessTokenExpiresAt > Date.now() + 60_000) return accessToken;
  if (accessTokenRequest) return accessTokenRequest;
  accessTokenRequest = (async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(`FCM OAuth token request failed (${response.status}): ${payload.error || 'unknown error'}`);
    }
    accessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return accessToken;
  })();
  try {
    return await accessTokenRequest;
  } finally {
    accessTokenRequest = null;
  }
}

async function sendFcm(token, data, { ttlSeconds = 3600 } = {}) {
  const account = getServiceAccount();
  if (!account) return false;
  const bearer = await getFcmAccessToken(account);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data,
        android: { priority: 'HIGH', ttl: `${ttlSeconds}s` },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const fcmError = payload.error || {};
    const errorCodes = (fcmError.details || []).map((detail) => detail.errorCode);
    if (errorCodes.includes('UNREGISTERED')) {
      nativePushTokens.removeInvalid.run(token);
      return false;
    }
    throw new Error(`FCM send failed (${response.status}): ${fcmError.status || fcmError.message || 'unknown error'}`);
  }
  return true;
}

export function validPushSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const endpoint = String(value.endpoint || '');
  if (endpoint.length > 2048) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  const hostAllowed = trustedPushHosts.includes(url.hostname)
    || url.hostname.endsWith('.push.apple.com')
    || url.hostname.endsWith('.notify.windows.com');
  const p256dh = typeof value.keys?.p256dh === 'string' ? Buffer.from(value.keys.p256dh, 'base64url') : null;
  const auth = typeof value.keys?.auth === 'string' ? Buffer.from(value.keys.auth, 'base64url') : null;
  return url.protocol === 'https:'
    && hostAllowed
    && typeof value.keys?.p256dh === 'string'
    && /^[A-Za-z0-9_-]+$/.test(value.keys.p256dh)
    && p256dh.length === 65
    && typeof value.keys?.auth === 'string'
    && /^[A-Za-z0-9_-]+$/.test(value.keys.auth)
    && auth.length === 16;
}

export function publicVapidKey() {
  return vapidKeys.publicKey;
}

function messagePreview(message) {
  switch (message.type) {
    case 'photo': return '📷 Фото';
    case 'video': return '🎬 Видео';
    case 'voice': return '🎤 Голосовое сообщение';
    case 'file': return '📎 Файл';
    case 'sticker': return '✨ Стикер';
    case 'poll': return '📊 Опрос';
    case 'gift': return `Вам отправили подарок: ${message.gift?.name || 'подарок'}`;
    default: return String(message.text || '').trim().slice(0, 140) || 'Новое сообщение';
  }
}

export async function sendChatPush({ chat, sender, message }) {
  const recipients = pushSubscriptions.forChat.all(chat.id, now(), sender.id);
  const sends = recipients.map(async (recipient) => {
    const enabled = chat.type === 'channel' ? recipient.notify_channels
      : chat.type === 'group' ? recipient.notify_groups
        : recipient.notify_messages;
    if (recipient.muted || enabled === 0) return;

    const preview = recipient.notify_preview !== 0;
    const title = chat.type === 'dm' ? sender.name : (chat.title || 'Aurora');
    const snippet = preview ? messagePreview(message) : 'Новое сообщение';
    const body = preview && chat.type !== 'dm' ? `${sender.name}: ${snippet}` : snippet;
    const payload = JSON.stringify({
      title: String(title).slice(0, 80),
      body: String(body).slice(0, 180),
      url: `/#/chat/${chat.id}`,
      tag: `aurora-chat-${chat.id}`,
      icon: '/assets/icons/app-icon.svg',
      badge: '/assets/icons/favicon.svg',
      image: message.type === 'gift' ? message.gift?.imageUrl : undefined,
    });

    try {
      await webpush.sendNotification(JSON.parse(recipient.subscription_json), payload, { TTL: 60 * 60 });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions.removeInvalid.run(recipient.endpoint);
        return;
      }
      console.error(`Web Push delivery failed for user ${recipient.user_id}:`, error.statusCode || error.message);
    }
  });
  await Promise.all(sends);
  await sendNativeChatPush({ chat, sender, message });
}

export async function sendNativeChatPush({ chat, sender, message }) {
  if (!isNativePushConfigured()) return;
  const recipients = nativePushTokens.forChat.all(chat.id, now(), sender.id);
  await Promise.all(recipients.map(async (recipient) => {
    const enabled = chat.type === 'channel' ? recipient.notify_channels
      : chat.type === 'group' ? recipient.notify_groups
        : recipient.notify_messages;
    if (recipient.muted || enabled === 0) return;

    const preview = recipient.notify_preview !== 0;
    const title = chat.type === 'dm' ? sender.name : (chat.title || 'Aurora');
    const snippet = preview ? messagePreview(message) : 'Новое сообщение';
    const body = preview && chat.type !== 'dm' ? `${sender.name}: ${snippet}` : snippet;
    try {
      await sendFcm(recipient.token, {
        type: 'chat',
        chatId: String(chat.id),
        title: String(title).slice(0, 80),
        body: String(body).slice(0, 180),
      });
    } catch (error) {
      console.error(`FCM delivery failed for user ${recipient.user_id}:`, error.message);
    }
  }));
}

export async function sendCallPush({ call, chat, caller }) {
  const ts = now();
  const recipients = pushSubscriptions.forCall.all(call.id, ts, caller.id);
  const nativeRecipients = nativePushTokens.forCall.all(call.id, ts, caller.id);
  const mediaLabel = call.media_mode === 'video' ? 'видеозвонок' : 'аудиозвонок';
  const sends = [];
  for (const recipient of recipients) {
    if (recipient.muted) continue;
    const showCaller = recipient.notify_preview !== 0;
    const title = showCaller ? `Звонок от ${caller.name || 'пользователя'}` : 'Входящий звонок';
    const chatLabel = chat.type === 'group' && chat.title ? ` · ${chat.title}` : '';
    const body = showCaller
      ? `Входящий ${mediaLabel}${chatLabel}`
      : 'Откройте Aurora, чтобы принять вызов';
    const payload = JSON.stringify({
      type: 'incoming-call',
      title: title.slice(0, 80),
      body: body.slice(0, 180),
      url: `/#/chat/${call.chat_id}`,
      chatId: String(call.chat_id),
      callId: call.id,
      mediaMode: call.media_mode,
      tag: `aurora-call-${call.id}`,
      icon: '/assets/icons/app-icon.svg',
      badge: '/assets/icons/favicon.svg',
    });

    sends.push((async () => {
      try {
        await webpush.sendNotification(JSON.parse(recipient.subscription_json), payload, {
          TTL: 60,
          urgency: 'high',
        });
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          pushSubscriptions.removeInvalid.run(recipient.endpoint);
          return;
        }
        console.error(`Incoming call push failed for user ${recipient.user_id}:`, error.statusCode || error.message);
      }
    })());
  }
  for (const recipient of nativeRecipients) {
    if (recipient.muted) continue;
    const showCaller = recipient.notify_preview !== 0;
    const title = showCaller ? `Звонок от ${caller.name || 'пользователя'}` : 'Входящий звонок';
    const chatLabel = chat.type === 'group' && chat.title ? ` · ${chat.title}` : '';
    const body = showCaller
      ? `Входящий ${mediaLabel}${chatLabel}`
      : 'Откройте Aurora, чтобы принять вызов';
    sends.push((async () => {
      try {
        await sendFcm(recipient.token, {
          type: 'incoming-call',
          callId: String(call.id),
          chatId: String(call.chat_id),
          mediaMode: String(call.media_mode),
          title: title.slice(0, 80),
          body: body.slice(0, 180),
          callerName: showCaller ? String(caller.name || 'Пользователь').slice(0, 80) : 'Aurora',
        }, { ttlSeconds: 60 });
      } catch (error) {
        console.error(`Incoming native call push failed for user ${recipient.user_id}:`, error.message);
      }
    })());
  }
  await Promise.all(sends);
}

export async function sendCallEndedPush({ callId, callerId }) {
  const ts = now();
  const webRecipients = pushSubscriptions.forCall.all(callId, ts, callerId);
  const nativeRecipients = nativePushTokens.forCall.all(callId, ts, callerId);
  const sends = [];
  for (const recipient of webRecipients) {
    sends.push((async () => {
      try {
        await webpush.sendNotification(JSON.parse(recipient.subscription_json), JSON.stringify({
          type: 'call-ended',
          callId,
          tag: `aurora-call-${callId}`,
        }), { TTL: 60, urgency: 'high' });
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          pushSubscriptions.removeInvalid.run(recipient.endpoint);
          return;
        }
        console.error(`Incoming call cancellation push failed for user ${recipient.user_id}:`, error.statusCode || error.message);
      }
    })());
  }
  for (const recipient of nativeRecipients) {
    sends.push((async () => {
      try {
        await sendFcm(recipient.token, { type: 'call-ended', callId: String(callId) }, { ttlSeconds: 60 });
      } catch (error) {
        console.error(`Incoming native call cancellation failed for user ${recipient.user_id}:`, error.message);
      }
    })());
  }
  await Promise.all(sends);
}

export async function sendNativeTestPush(userId, sessionId) {
  const tokens = nativePushTokens.bySession.all(userId, sessionId);
  if (!isNativePushConfigured()) return { sent: 0, failed: tokens.length, configured: false };
  const results = await Promise.all(tokens.map(async ({ token }) => {
    try {
      return await sendFcm(token, {
        type: 'test',
        title: 'Aurora',
        body: 'Тестовое уведомление: push работает.',
      });
    } catch (error) {
      console.error(`FCM test delivery failed for user ${userId}:`, error.message);
      return false;
    }
  }));
  return {
    sent: results.filter(Boolean).length,
    failed: results.filter((sent) => !sent).length,
    configured: true,
  };
}

export async function sendTestPush(userId, sessionId) {
  const subscriptions = pushSubscriptions.bySession.all(userId, sessionId);
  const results = await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(JSON.parse(subscription.subscription_json), JSON.stringify({
        title: 'Aurora',
        body: 'Тестовое уведомление: push работает.',
        url: '/#/settings',
        tag: 'aurora-push-test',
        test: true,
      }), { TTL: 60 });
      return true;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions.removeInvalid.run(subscription.endpoint);
      } else {
        console.error(`Web Push test delivery failed for user ${userId}:`, error.statusCode || error.message);
      }
      return false;
    }
  }));
  return { sent: results.filter(Boolean).length, failed: results.filter((sent) => !sent).length };
}

export function savePushSubscription(userId, sessionId, subscription) {
  const ts = now();
  return pushSubscriptions.upsert.run({
    endpoint: subscription.endpoint,
    user_id: userId,
    session_id: sessionId,
    subscription_json: JSON.stringify(subscription),
    created_at: ts,
    updated_at: ts,
  });
}
