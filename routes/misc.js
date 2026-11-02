/**
 * Поиск, настройки, профили других пользователей, блокировки, синхронизация (fallback к WS).
 */
import express from 'express';
import { db, users, chats, messages, settings, media, blocks, reports, events, now, pushSubscriptions, nativePushTokens, commerce } from '../db.js';
import { PREMIUM_WALLPAPER_IDS } from '../config.js';
import { validate, signMedia, cleanText } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { canViewProfile, canViewStatus, userDTO, settingsDTO, publicUser, chatsOf, membersOf, giftImageUrl } from '../helpers.js';
import { broadcastToContacts, isOnline, refreshPresence } from '../realtime.js';
import { publicVapidKey, savePushSubscription, sendTestPush, validPushSubscription, isNativePushConfigured, sendNativeTestPush } from '../push.js';
import { requestSecurityVerification } from '../security-client.js';

export const apiRouter = express.Router();
apiRouter.use(requireAuth);

apiRouter.get('/push/vapid-public-key', wrap((req, res) => {
  res.json({ publicKey: publicVapidKey() });
}));

apiRouter.get('/push/subscription', wrap((req, res) => {
  res.json({ enabled: pushSubscriptions.bySession.all(req.user.id, req.sessionId).length > 0 });
}));

apiRouter.post('/push/test', limit('write'), wrap(async (req, res) => {
  if (!pushSubscriptions.bySession.all(req.user.id, req.sessionId).length) {
    throw badRequest('Сначала включите фоновые уведомления для этого устройства');
  }
  const result = await sendTestPush(req.user.id, req.sessionId);
  if (!result.sent) {
    return res.status(502).json({ error: 'Push не доставлен. Проверьте разрешение уведомлений и подписку устройства.' });
  }
  res.json(result);
}));

apiRouter.post('/security/verification/request', limit('write'), wrap(async (req, res) => {
  const kind = String(req.body?.kind || '');
  if (!['phone', 'official'].includes(kind)) throw badRequest('Выберите тип верификации');
  const result = await requestSecurityVerification({ userId: req.user.id, kind });
  if (!result?.request) {
    return res.status(503).json({ error: 'Сервис безопасности временно недоступен. Заявка не была сохранена.' });
  }
  res.status(result.request.status === 'pending' ? 202 : 200).json(result);
}));

apiRouter.post('/push/subscription', limit('write'), wrap((req, res) => {
  const subscription = req.body?.subscription;
  if (!validPushSubscription(subscription)) throw badRequest('Некорректная push-подписка');
  const existing = pushSubscriptions.byEndpoint.get(subscription.endpoint);
  if (existing && existing.user_id !== req.user.id) throw conflict('Эта push-подписка уже привязана к другому аккаунту');
  const result = savePushSubscription(req.user.id, req.sessionId, subscription);
  if (!result.changes) throw conflict('Не удалось сохранить push-подписку');
  res.json({ enabled: true });
}));

apiRouter.delete('/push/subscription', limit('write'), wrap((req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) {
    if (!validPushSubscription({ endpoint, keys: req.body?.keys })) throw badRequest('Некорректная push-подписка');
    pushSubscriptions.remove.run(req.user.id, req.sessionId, endpoint);
  } else {
    pushSubscriptions.removeSession.run(req.user.id, req.sessionId);
  }
  res.json({ enabled: pushSubscriptions.bySession.all(req.user.id, req.sessionId).length > 0 });
}));

apiRouter.get('/push/native/status', wrap((req, res) => {
  res.json({
    enabled: nativePushTokens.bySession.all(req.user.id, req.sessionId).length > 0,
    configured: isNativePushConfigured(),
  });
}));

apiRouter.post('/push/native/token', limit('write'), wrap((req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096
    || token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token)) {
    throw badRequest('Некорректный токен push-уведомлений');
  }
  const existing = nativePushTokens.byToken.get(token);
  if (existing && existing.user_id !== req.user.id) {
    throw conflict('Этот push-токен уже привязан к другому аккаунту');
  }
  const ts = now();
  const result = nativePushTokens.upsert.run({
    token,
    user_id: req.user.id,
    session_id: req.sessionId,
    created_at: ts,
    updated_at: ts,
  });
  if (!result.changes) throw conflict('Не удалось сохранить push-токен');
  res.json({ enabled: true, configured: isNativePushConfigured() });
}));

apiRouter.delete('/push/native/token', limit('write'), wrap((req, res) => {
  const token = req.body?.token;
  if (token !== undefined) {
    if (typeof token !== 'string' || token.length > 4096) throw badRequest('Некорректный токен push-уведомлений');
    nativePushTokens.remove.run(req.user.id, req.sessionId, token);
  } else {
    nativePushTokens.removeForSession.run(req.sessionId);
  }
  res.json({ enabled: nativePushTokens.bySession.all(req.user.id, req.sessionId).length > 0 });
}));

apiRouter.post('/push/native/test', limit('write'), wrap(async (req, res) => {
  if (!nativePushTokens.bySession.all(req.user.id, req.sessionId).length) {
    throw badRequest('На этом устройстве ещё не зарегистрирован push-токен');
  }
  const result = await sendNativeTestPush(req.user.id, req.sessionId);
  if (!result.configured) {
    return res.status(503).json({ error: 'FCM не настроен на сервере. Администратор должен задать FCM_SERVICE_ACCOUNT_FILE.' });
  }
  if (!result.sent) {
    return res.status(502).json({ error: 'FCM не доставил уведомление. Проверьте конфигурацию Firebase и разрешение Android.' });
  }
  res.json(result);
}));

/* ─────────────────────────── Поиск ─────────────────────────── */

/** Глобальный поиск: пользователи, группы, каналы, мои чаты, сообщения, медиа. */
apiRouter.get('/search', limit('search'), wrap((req, res) => {
  const raw = String(req.query.q || '').trim().slice(0, 80);
  const type = String(req.query.type || 'all');
  if (raw.length < 1) return res.json({ query: raw, users: [], chats: [], messages: [], total: 0 });
  const like = `%${raw.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const usernameLike = `${raw.replace(/^@/, '').toLowerCase()}%`;

  const foundUsers = type === 'all' || type === 'users'
    ? db.prepare(`SELECT * FROM users WHERE (username LIKE @u OR name LIKE @l) AND id <> @me
                  ORDER BY (username LIKE @u) DESC, name LIMIT 20`).all({ u: usernameLike, l: like, me: req.user.id })
    : [];

  const foundChats = type === 'all' || type === 'chats'
    ? db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) AS member_count,
        EXISTS(SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = @me) AS is_member
      FROM chats c
      WHERE c.type <> 'dm' AND (
        (c.is_public = 1 AND (c.username LIKE @u OR c.title LIKE @l OR c.description LIKE @l))
        OR c.id IN (SELECT chat_id FROM chat_members WHERE user_id = @me AND c.id = chat_id)
      )
      AND (c.title LIKE @l OR c.username LIKE @u)
      ORDER BY is_member DESC, member_count DESC LIMIT 20`).all({ u: usernameLike, l: like, me: req.user.id })
    : [];

  const foundMessages = type === 'all' || type === 'messages' || type === 'media'
    ? messages.searchInChats.all({ q: like.replace(/\\/g, ''), uid: req.user.id })
      .filter((m) => type !== 'media' || m.media_id)
      .map((m) => ({
        id: m.id, chatId: m.chat_id, chatTitle: m.chat_title, chatType: m.chat_type,
        chatAvatar: m.chat_avatar ? signMedia(m.chat_avatar) : null,
        senderId: m.sender_id, text: cleanText(m.text).slice(0, 240), type: m.type,
        hasMedia: !!m.media_id, createdAt: m.created_at, seq: m.seq,
      }))
    : [];

  res.json({
    query: raw,
    users: foundUsers.filter((u) => canViewProfile(u.id, req.user.id))
      .map((u) => ({ ...publicUser(u, req.user.id), online: canViewStatus(u.id, req.user.id) ? isOnline(u.id) : null })),
    chats: foundChats.map((c) => ({
      id: c.id, type: c.type, title: c.title, username: c.username, description: c.description,
      avatarUrl: c.avatar_url ? signMedia(c.avatar_url) : null,
      memberCount: c.member_count, isMember: !!c.is_member, isPublic: !!c.is_public,
    })),
    messages: foundMessages,
    total: foundUsers.length + foundChats.length + foundMessages.length,
  });
}));

/* ─────────────────────────── Настройки ─────────────────────────── */

apiRouter.get('/settings', wrap((req, res) => {
  res.json({ settings: settingsDTO(settings.byUser.get(req.user.id)) });
}));

const THEMES = ['light', 'dark', 'system'];
const ACCENTS = ['violet', 'ocean', 'sunset', 'mint', 'coral'];
const WALLPAPERS = ['aurora', 'dusk', 'dune', 'graphite', 'paper', ...PREMIUM_WALLPAPER_IDS];
const PRIVACY = ['everyone', 'contacts', 'nobody'];
const NOTIFICATION_SOUNDS = ['default', 'universfield-new-notification-051-494246', 'universfield-new-notification-040-493469', 'universfield-new-notification-017-352293'];

apiRouter.patch('/settings', limit('write'), wrap((req, res) => {
  const b = req.body || {};
  const bad = (msg) => { throw badRequest(msg); };
  const bool = (v) => (v === undefined ? null : v ? 1 : 0);
  if (b.theme !== undefined && !THEMES.includes(b.theme)) bad('Неизвестная тема');
  if (b.accent !== undefined && !ACCENTS.includes(b.accent)) bad('Неизвестный акцент');
  if (b.wallpaper !== undefined && !WALLPAPERS.includes(b.wallpaper)) bad('Неизвестные обои');
  if (PREMIUM_WALLPAPER_IDS.includes(b.wallpaper) && !commerce.premium.get(req.user.id, now())) {
    throw forbidden('Премиум-обои доступны только с Premium');
  }
  if (b.notifySound !== undefined && !NOTIFICATION_SOUNDS.includes(b.notifySound)) bad('Неизвестный звук уведомлений');
  if (b.fontScale !== undefined && (Number(b.fontScale) < 0.8 || Number(b.fontScale) > 1.4)) bad('Размер текста вне диапазона');
  for (const key of ['privacy']) {
    if (b[key]) for (const [k, v] of Object.entries(b[key])) {
      if (!PRIVACY.includes(v)) bad(`Неизвестное значение приватности: ${k}`);
    }
  }
  const n = b.notify || {};
  settings.update.run({
    user_id: req.user.id,
    theme: b.theme ?? null,
    accent: b.accent ?? null,
    font_scale: b.fontScale !== undefined ? Number(b.fontScale) : null,
    animations: bool(b.animations),
    compact: bool(b.compact),
    wallpaper: b.wallpaper ?? null,
    notify_messages: bool(n.messages), notify_groups: bool(n.groups), notify_channels: bool(n.channels),
    notify_sounds: bool(n.sounds), notify_sound: b.notifySound ?? n.sound ?? null, notify_vibration: bool(n.vibration), notify_preview: bool(n.preview),
    privacy_messages: b.privacy?.messages ?? null, privacy_profile: b.privacy?.profile ?? null,
    privacy_groups: b.privacy?.groups ?? null, privacy_status: b.privacy?.status ?? null,
    updated_at: now(),
  });
  const dto = settingsDTO(settings.byUser.get(req.user.id));
  if (b.privacy?.profile !== undefined || b.privacy?.status !== undefined) {
    const user = users.byId.get(req.user.id);
    broadcastToContacts(req.user.id, {
      type: 'user.update', userId: req.user.id, payload: { user: userDTO(user, null) }, ts: now(),
    });
  }
  if (b.privacy?.status !== undefined) {
    const user = users.byId.get(req.user.id);
    refreshPresence(req.user.id, user.presence, user.last_seen);
  }
  res.json({ settings: dto });
}));

/* ─────────────────────────── Профили ─────────────────────────── */

apiRouter.get('/users/:id', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const user = users.byId.get(id.value);
  if (!user) throw notFound('Пользователь не найден');
  if (!canViewProfile(user.id, req.user.id)) throw forbidden('Пользователь скрыл профиль');
  const shared = db.prepare(`
      SELECT c.id, c.type, c.title, c.avatar_url, c.username, c.description FROM chats c
      JOIN chat_members a ON a.chat_id = c.id AND a.user_id = @target
      JOIN chat_members b ON b.chat_id = c.id AND b.user_id = @me
      WHERE c.type IN ('group','channel') LIMIT 24`).all({ target: id.value, me: req.user.id });
  const sharedMedia = db.prepare(`
      SELECT m.id, m.kind, m.size, m.mime, m.width, m.height, msg.created_at
      FROM media m JOIN messages msg ON msg.media_id = m.id
      WHERE msg.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = @me)
        AND msg.deleted_for_all = 0 AND msg.sender_id = @target AND m.kind IN ('image','video')
      ORDER BY msg.created_at DESC LIMIT 30`).all({ me: req.user.id, target: id.value });
  const stats = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND deleted_for_all = 0').get(id.value);
  const profileGallery = users.gallery.all(id.value);
  const personalChannel = user.personal_channel_id ? chats.byId.get(user.personal_channel_id) : null;
  const gifts = db.prepare(`SELECT rg.*, g.emoji, g.name, g.description, g.animation, g.rarity, g.image_media_id,
    u.username AS sender_username, u.name AS sender_name
    FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.sender_id
    WHERE rg.recipient_id = ? AND rg.status = 'owned' AND rg.is_hidden = 0
    ORDER BY rg.pinned_order IS NULL, rg.pinned_order, rg.created_at DESC LIMIT 60`).all(id.value);
  res.json({
    user: { ...publicUser(user, req.user.id), online: canViewStatus(user.id, req.user.id) ? isOnline(user.id) : null },
    commonChats: shared.map((c) => ({
      id: c.id, type: c.type, title: c.title, username: c.username, description: c.description,
      avatarUrl: c.avatar_url ? signMedia(c.avatar_url) : null,
    })),
    media: sharedMedia.map((m) => ({ id: m.id, kind: m.kind, url: signMedia(m.id), width: m.width, height: m.height, createdAt: m.created_at })),
    profileGallery: profileGallery.map((m) => ({ id: m.id, kind: m.kind, url: signMedia(m.id), width: m.width, height: m.height })),
    personalChannel: personalChannel ? {
      id: personalChannel.id, title: personalChannel.title, username: personalChannel.username,
      description: personalChannel.description, avatarUrl: personalChannel.avatar_url ? signMedia(personalChannel.avatar_url) : null,
    } : null,
    stats: { messages: stats.c },
    gifts: gifts.map((g) => ({ id: g.gift_id, instanceId: g.id, emoji: g.emoji, name: g.name, description: g.description, animation: g.animation, rarity: g.rarity, imageUrl: giftImageUrl({ id: g.gift_id, image_media_id: g.image_media_id }), price: g.price, pinned: g.pinned_order !== null, sender: { username: g.sender_username, name: g.sender_name }, note: g.note, createdAt: g.created_at })),
  });
}));

apiRouter.post('/profile/gallery', limit('write'), wrap((req, res) => {
  const id = validate.id(req.body?.mediaId);
  if (id.error) throw badRequest('Некорректное медиа');
  const item = media.byId.get(id.value);
  if (!item || item.owner_id !== req.user.id || !['image', 'video'].includes(item.kind)) throw forbidden('Можно добавить только своё фото или видео');
  if (users.galleryCount.get(req.user.id).c >= 12) throw badRequest('В галерее может быть не более 12 файлов');
  users.galleryAdd.run(req.user.id, id.value, Date.now());
  res.status(201).json({ ok: true });
}));

apiRouter.delete('/profile/gallery/:mediaId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.mediaId);
  if (id.error) throw badRequest(id.error);
  users.galleryRemove.run(req.user.id, id.value);
  res.json({ ok: true });
}));

/** Блокировка/разблокировка пользователя — влияет на возможность писать. */
apiRouter.post('/users/:id/block', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  if (id.value === req.user.id) throw badRequest('Нельзя заблокировать себя');
  if (!users.byId.get(id.value)) throw notFound('Пользователь не найден');
  const blocked = req.body?.blocked !== false;
  if (blocked) blocks.add.run(req.user.id, id.value, now());
  else blocks.remove.run(req.user.id, id.value);
  res.json({ ok: true, blocked });
}));

apiRouter.post('/users/:id/report', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  if (id.value === req.user.id) throw badRequest('Нельзя пожаловаться на себя');
  if (!users.byId.get(id.value)) throw notFound('Пользователь не найден');
  const reason = String(req.body?.reason || '').trim().slice(0, 64);
  const details = String(req.body?.details || '').trim().slice(0, 500);
  if (!reason) throw badRequest('Укажите причину жалобы');
  reports.create.run(req.user.id, id.value, reason, details, now());
  res.status(201).json({ ok: true });
}));

apiRouter.get('/blocks', wrap((req, res) => {
  const rows = blocks.list.all(req.user.id).map((r) => users.byId.get(r.blocked_id)).filter(Boolean);
  res.json({ users: rows.map((u) => userDTO(u, req.user.id)) });
}));

/* ─────────────────────────── Синхронизация без WebSocket ─────────────────────────── */

/**
 * Журнал событий для scope пользователя и его чатов.
 * Клиент вызывает этот метод периодически, если WS недоступен — синхронизация не теряется.
 */
apiRouter.get('/updates', limit('read'), wrap((req, res) => {
  const since = Math.max(0, Number(req.query.since) || 0);
  const scopes = [`user:${req.user.id}`, ...chatsOf(req.user.id).map((id) => `chat:${id}`)];
  const rows = events.since.all(JSON.stringify(scopes), since);
  const parsed = [];
  for (const r of rows) {
    try { parsed.push({ ...JSON.parse(r.payload), eventId: r.id }); } catch { /* пропускаем битые записи */ }
  }
  res.json({ events: parsed, lastId: rows.length ? rows[rows.length - 1].id : since, serverTime: now() });
}));

/** Сводка состояния: непрочитанные, присутствие, счётчики — для бейджей и заголовка вкладки. */
apiRouter.get('/state', wrap((req, res) => {
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM messages x JOIN chat_members m ON m.chat_id = x.chat_id AND m.user_id = @uid
      WHERE x.seq > m.last_read_seq AND x.sender_id <> @uid AND x.deleted_for_all = 0`).get({ uid: req.user.id });
  res.json({ unread: unread.c, serverTime: now() });
}));

export default apiRouter;
