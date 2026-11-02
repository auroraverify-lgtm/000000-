import express from 'express';
import { randomBytes } from 'node:crypto';
import { db, users, chats, emailVerifications, passwordResetRequests, resets, now, tx } from '../db.js';
import { verifyPassword, validate, hashOneTimeCode } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { broadcastToContacts, closeUserSockets, indexChat } from '../realtime.js';
import { userDTO } from '../helpers.js';
import { COMMERCE } from '../config.js';
import { commerce } from '../db.js';
import { signMedia } from '../security.js';
import { recordAdminAction } from '../security-events.js';

export const adminRouter = express.Router();
adminRouter.use(requireAuth, limit('write'));
adminRouter.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300 && req.user?.is_admin) {
      recordAdminAction({
        actorId: req.user.id,
        action: `${req.method} ${req.path}`.slice(0, 80),
        targetType: 'admin_api',
        targetId: req.path.slice(0, 100),
      });
    }
    return sendJson(body);
  };
  next();
});

function isAdmin(user) {
  return !!user.is_admin;
}

function requireAdmin(req) {
  if (!isAdmin(req.user)) throw forbidden('Панель администратора недоступна');
}

adminRouter.post('/unlock', wrap((req, res) => {
  requireAdmin(req);
  const password = String(req.body?.password || '');
  if (!verifyPassword(password, req.user.password_hash)) throw forbidden('Неверный пароль администратора');
  res.json({ ok: true, admin: true });
}));

adminRouter.get('/overview', wrap((req, res) => {
  requireAdmin(req);
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_bot = 0').get().count;
  const chatCount = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count;
  const openRequests = db.prepare("SELECT COUNT(*) AS count FROM support_requests WHERE status IN ('open','in_progress')").get().count;
  res.json({ userCount, chatCount, openRequests });
}));

adminRouter.get('/users', wrap((req, res) => {
  requireAdmin(req);
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`SELECT u.id, u.name, u.username, u.email, u.is_bot, u.is_admin, u.is_blocked, u.is_frozen, u.created_at,
      EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = u.id AND b.badge = 'verified') AS is_verified
    FROM users u WHERE u.username LIKE @q OR u.name LIKE @q OR u.email LIKE @q ORDER BY u.created_at DESC LIMIT 100`).all({ q: `%${q}%` });
  res.json({ users: rows });
}));

adminRouter.get('/email-verifications', wrap((req, res) => {
  requireAdmin(req);
  const ts = now();
  const rows = db.prepare(`SELECT u.id, u.name, u.username, u.email, u.email_verification_deadline_at,
      u.email_verification_requested_at, ev.expires_at
    FROM users u LEFT JOIN email_verifications ev ON ev.user_id = u.id
    WHERE u.is_bot = 0 AND u.email_verified = 0
    ORDER BY COALESCE(u.email_verification_requested_at, u.created_at) DESC LIMIT 200`).all();
  res.json({
    users: rows.map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      deadlineAt: user.email_verification_deadline_at,
      requestedAt: user.email_verification_requested_at,
      codeExpiresAt: user.expires_at > ts ? user.expires_at : null,
    })),
  });
}));

adminRouter.get('/password-reset-requests', wrap((req, res) => {
  requireAdmin(req);
  res.json({ requests: passwordResetRequests.list.all() });
}));

adminRouter.post('/password-reset-requests/:id/issue', wrap((req, res) => {
  requireAdmin(req);
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const request = passwordResetRequests.byId.get(id.value);
  if (!request || !['pending', 'issued'].includes(request.status)) throw notFound('Запрос на сброс пароля не найден или уже закрыт');
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  const issueReset = tx(() => {
    resets.invalidateForUser.run(request.user_id);
    resets.create.run(hashOneTimeCode(token), request.user_id, ts + 60 * 60 * 1000, ts);
    passwordResetRequests.setStatus.run('issued', ts, id.value);
  });
  issueReset();
  res.json({ ok: true, resetPath: `/#/reset?token=${encodeURIComponent(token)}`, expiresAt: ts + 60 * 60 * 1000 });
}));

adminRouter.patch('/users/:id', wrap((req, res) => {
  requireAdmin(req);
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const user = users.byId.get(id.value);
  if (!user) throw notFound('Пользователь не найден');
  if (id.value === req.user.id && (req.body?.blocked || req.body?.frozen)) throw badRequest('Нельзя заблокировать или заморозить собственный аккаунт');
  const body = req.body || {};
  if (body.verified !== undefined) {
    if (typeof body.verified !== 'boolean') throw badRequest('Статус галочки должен быть логическим значением');
    if (body.verified) {
      db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge, granted_by, created_at) VALUES (?, ?, ?, ?)')
        .run(id.value, 'verified', req.user.id, now());
    } else {
      db.prepare("DELETE FROM user_badges WHERE user_id = ? AND badge = 'verified'").run(id.value);
    }
    const updatedUser = users.byId.get(id.value);
    broadcastToContacts(id.value, {
      type: 'user.update',
      userId: id.value,
      payload: { user: userDTO(updatedUser, null) },
      ts: now(),
    });
  }
  if (body.blocked !== undefined || body.frozen !== undefined) {
    db.prepare(`UPDATE users SET is_blocked = COALESCE(@blocked, is_blocked),
      is_frozen = COALESCE(@frozen, is_frozen), token_version = token_version + 1, updated_at = @updated_at WHERE id = @id`)
      .run({ id: id.value, blocked: body.blocked === undefined ? null : (body.blocked ? 1 : 0), frozen: body.frozen === undefined ? null : (body.frozen ? 1 : 0), updated_at: now() });
    closeUserSockets(id.value);
  }
  if (body.badge) {
    const allowed = ['owner', 'assistant', 'admin', 'user', 'verified'];
    if (!allowed.includes(body.badge)) throw badRequest('Неизвестный значок');
    db.prepare('INSERT OR REPLACE INTO user_badges (user_id, badge, granted_by, created_at) VALUES (?, ?, ?, ?)')
      .run(id.value, body.badge, req.user.id, now());
    const updatedUser = users.byId.get(id.value);
    broadcastToContacts(id.value, {
      type: 'user.update',
      userId: id.value,
      payload: { user: userDTO(updatedUser, null) },
      ts: now(),
    });
  }
  return res.json({
    user: users.byId.get(id.value),
    verified: db.prepare("SELECT 1 FROM user_badges WHERE user_id = ? AND badge = 'verified'").get(id.value) !== undefined,
  });
}));

adminRouter.get('/chats', wrap((req, res) => {
  requireAdmin(req);
  res.json({ chats: db.prepare(`SELECT id, type, title, username, owner_id, is_public, is_frozen, created_at FROM chats WHERE type <> 'dm' ORDER BY created_at DESC LIMIT 100`).all() });
}));

adminRouter.patch('/chats/:id', wrap((req, res) => {
  requireAdmin(req);
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  if (chat.type === 'dm') throw badRequest('Личные чаты нельзя удалять или замораживать из админ-панели');
  if (req.body?.deleted) db.prepare('DELETE FROM chats WHERE id = ?').run(id.value);
  else if (req.body?.frozen !== undefined) db.prepare('UPDATE chats SET is_frozen = ? WHERE id = ?').run(req.body.frozen ? 1 : 0, id.value);
  res.json({ ok: true });
}));

adminRouter.get('/support', wrap((req, res) => {
  requireAdmin(req);
  const status = String(req.query.status || 'all');
  const where = status === 'all' ? '' : 'WHERE sr.status = @status';
  const requests = db.prepare(`SELECT sr.*, u.name, u.username, c.title AS chat_title FROM support_requests sr JOIN users u ON u.id = sr.user_id LEFT JOIN chats c ON c.id = sr.chat_id ${where} ORDER BY sr.updated_at DESC LIMIT 100`).all({ status });
  res.json({ requests });
}));

adminRouter.get('/commerce', wrap((req, res) => {
  requireAdmin(req);
  const read = (key, fallback) => { const row = commerce.config.get(key); if (!row) return fallback; try { return JSON.parse(row.value); } catch { return fallback; } };
  const gifts = db.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM received_gifts rg WHERE rg.gift_id = g.id) AS issued_count,
      (SELECT COUNT(*) FROM received_gifts rg WHERE rg.gift_id = g.id AND rg.status = 'sold') AS sold_count,
      (SELECT COUNT(*) FROM received_gifts rg WHERE rg.gift_id = g.id AND rg.status = 'owned') AS owned_count
    FROM gifts g ORDER BY g.is_active DESC, g.price`).all().map((g) => ({ ...g, image_url: g.image_media_id ? signMedia(g.image_media_id) : null }));
  const paymentOrders = db.prepare(`SELECT po.id, po.kind, po.product_id, po.units, po.amount_minor,
      po.currency, po.receipt_email, po.status, po.paid_at, po.created_at,
      u.name, u.username, u.email AS account_email
    FROM payment_orders po JOIN users u ON u.id = po.user_id
    WHERE po.status = 'succeeded'
    ORDER BY po.paid_at DESC, po.created_at DESC LIMIT 100`).all();
  res.json({ pendingPremium: commerce.pendingPremium.all(), premium: db.prepare('SELECT ps.*, u.username, u.name FROM premium_subscriptions ps JOIN users u ON u.id = ps.user_id ORDER BY ps.created_at DESC LIMIT 100').all(), paymentOrders, gifts, balancePackages: read('balancePackages', COMMERCE.balancePackages), premiumPlans: read('premiumPlans', COMMERCE.premiumPlans) });
}));

adminRouter.patch('/commerce/premium/:id', wrap((req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  const row = commerce.premiumById.get(id);
  if (!row) throw notFound('Заявка Premium не найдена');
  const status = String(req.body?.status || '');
  if (!['active', 'revoked', 'rejected'].includes(status)) throw badRequest('Некорректный статус Premium');
  const ts = now();
  const expires = status === 'active' ? (row.expires_at > ts ? row.expires_at : ts + 30 * 24 * 60 * 60 * 1000) : row.expires_at;
  commerce.updatePremium.run(status, status === 'active' ? ts : row.starts_at, expires, id);
  res.json({ ok: true, status });
}));

adminRouter.patch('/commerce/config', wrap((req, res) => {
  requireAdmin(req);
  for (const key of ['balancePackages', 'premiumPlans']) {
    if (req.body?.[key] !== undefined) {
      if (!Array.isArray(req.body[key])) throw badRequest(`Некорректная конфигурация ${key}`);
      commerce.setConfig.run(key, JSON.stringify(req.body[key]));
    }
  }
  res.json({ ok: true });
}));

adminRouter.post('/commerce/gifts', wrap((req, res) => {
  requireAdmin(req);
  const b = req.body || {};
  const id = String(b.id || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  const description = String(b.description || '').trim();
  const price = Number(b.price);
  const rarity = String(b.rarity || 'обычный');
  const stockTotal = b.stockTotal === undefined || b.stockTotal === null || b.stockTotal === '' ? null : Number(b.stockTotal);
  const sellbackPercent = Number(b.sellbackPercent ?? 50);
  const active = b.isActive === undefined ? 1 : (b.isActive === true ? 1 : b.isActive === false ? 0 : null);
  if (!/^[a-z0-9_-]{1,40}$/.test(id) || !name || name.length > 80 || description.length > 300
    || !Number.isSafeInteger(price) || price < 1 || price > 1000000000) {
    throw badRequest('Проверьте ID, название, описание и цену подарка');
  }
  if (!['обычный', 'необычный', 'редкий', 'эпический', 'легендарный', 'мифический'].includes(rarity)) throw badRequest('Некорректная редкость');
  if (stockTotal !== null && (!Number.isSafeInteger(stockTotal) || stockTotal < 1 || stockTotal > 1000000)) throw badRequest('Укажите лимит от 1 до 1 000 000 или оставьте поле пустым');
  if (!Number.isInteger(sellbackPercent) || sellbackPercent < 0 || sellbackPercent > 100) throw badRequest('Процент возврата должен быть от 0 до 100');
  if (active === null) throw badRequest('Некорректный статус доступности');
  const imageId = b.imageMediaId ? Number(b.imageMediaId) : null;
  const image = imageId && db.prepare('SELECT id, mime FROM media WHERE id = ? AND owner_id = ? AND kind = ?').get(imageId, req.user.id, 'image');
  if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) throw badRequest('Загрузите изображение PNG, WebP или GIF через Aurora');
  const ts = now();
  if (commerce.giftById.get(id)) throw conflict('Подарок с таким ID уже существует');
  commerce.giftCreate.run(id, '', name, description, price, String(b.animation || 'aurora').slice(0, 40), active, rarity, imageId, stockTotal, stockTotal, sellbackPercent, ts, ts);
  res.status(201).json({ gift: commerce.gift.get(id) });
}));

adminRouter.patch('/commerce/gifts/:id', wrap((req, res) => {
  requireAdmin(req);
  const current = commerce.giftById.get(req.params.id);
  if (!current) throw notFound('Подарок не найден');
  const b = req.body || {};
  const imageId = b.imageMediaId === undefined ? current.image_media_id : (b.imageMediaId ? Number(b.imageMediaId) : null);
  const image = imageId && db.prepare('SELECT id, owner_id, mime FROM media WHERE id = ? AND kind = ?').get(imageId, 'image');
  const supportedImage = image && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime);
  if (imageId && (!supportedImage || (imageId !== current.image_media_id && image.owner_id !== req.user.id))) {
    throw badRequest('Загрузите изображение PNG, JPEG, WebP или GIF через Aurora');
  }
  const price = Number(b.price ?? current.price);
  const name = String(b.name ?? current.name).trim();
  const description = String(b.description ?? current.description).trim();
  const rarity = String(b.rarity ?? current.rarity);
  const active = b.isActive === undefined ? current.is_active : (b.isActive === true ? 1 : b.isActive === false ? 0 : null);
  const sellbackPercent = Number(b.sellbackPercent ?? current.sellback_percent);
  const total = b.stockTotal === undefined ? current.stock_total : (b.stockTotal === null || b.stockTotal === '' ? null : Number(b.stockTotal));
  if (!name || name.length > 80 || description.length > 300 || !Number.isSafeInteger(price) || price < 1 || price > 1000000000) throw badRequest('Проверьте название, описание и цену подарка');
  if (!['обычный', 'необычный', 'редкий', 'эпический', 'легендарный', 'мифический'].includes(rarity)) throw badRequest('Некорректная редкость');
  if (total !== null && (!Number.isSafeInteger(total) || total < 1 || total > 1000000)) throw badRequest('Укажите лимит от 1 до 1 000 000 или оставьте поле пустым');
  if (!Number.isInteger(sellbackPercent) || sellbackPercent < 0 || sellbackPercent > 100 || active === null) throw badRequest('Проверьте доступность и процент возврата');
  const issued = commerce.giftIssuedCount.get(current.id).count;
  if (total !== null && total < issued) throw badRequest(`Нельзя установить лимит ниже уже выданного количества (${issued})`);
  const remaining = total === null ? null : total - issued;
  commerce.giftUpdate.run(
    '', name, description, price,
    String(b.animation ?? current.animation).slice(0, 40), rarity, imageId, total, remaining,
    sellbackPercent, active, now(), current.id,
  );
  res.json({ gift: commerce.giftById.get(current.id) });
}));

adminRouter.delete('/commerce/gifts/:id', wrap((req, res) => {
  requireAdmin(req);
  const gift = commerce.giftById.get(req.params.id);
  if (!gift) throw notFound('Подарок не найден');
  const issued = commerce.giftIssuedCount.get(gift.id).count;
  if (issued) commerce.giftDelete.run(gift.id);
  else db.prepare('DELETE FROM gifts WHERE id = ?').run(gift.id);
  res.json({ ok: true, archived: issued > 0 });
}));

function ensureOperatorChat(adminId, userId) {
  if (adminId === userId) throw badRequest('Нельзя открыть чат с самим собой');
  const key = `dm:${Math.min(adminId, userId)}:${Math.max(adminId, userId)}`;
  let chat = db.prepare('SELECT * FROM chats WHERE dm_key = ?').get(key);
  if (!chat) {
    const ts = now();
    const result = db.prepare(`INSERT INTO chats (type, title, description, owner_id, is_public, dm_key, created_at)
      VALUES ('dm', NULL, '', NULL, 0, ?, ?)`).run(key, ts);
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(id, adminId, ts);
    db.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(id, userId, ts);
    chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    indexChat(id);
  }
  return chat;
}

adminRouter.post('/support/:id/open', wrap((req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Некорректный идентификатор обращения');
  const request = db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id);
  if (!request) throw notFound('Обращение не найдено');
  const chat = ensureOperatorChat(req.user.id, request.user_id);
  db.prepare("UPDATE support_requests SET status = CASE WHEN status = 'closed' THEN status ELSE 'in_progress' END, assigned_to = ?, updated_at = ? WHERE id = ?")
    .run(req.user.id, now(), id);
  res.json({ chatId: chat.id, requestId: id, status: request.status === 'closed' ? 'closed' : 'in_progress' });
}));

adminRouter.patch('/support/:id', wrap((req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isInteger(id) || !['open', 'in_progress', 'closed'].includes(status)) throw badRequest('Некорректный статус обращения');
  const request = db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id);
  if (!request) throw notFound('Обращение не найдено');
  const chat = status === 'closed' ? null : ensureOperatorChat(req.user.id, request.user_id);
  db.prepare('UPDATE support_requests SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?').run(status, req.user.id, now(), id);
  res.json({ ok: true, chatId: chat?.id || null });
}));

export default adminRouter;
