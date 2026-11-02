/**
 * Aurora Messenger — точка входа сервера.
 * Express (REST) + WebSocket (realtime) + защищённая отдача медиа.
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { PORT, HOST, PUBLIC_DIR, ROOT, SECURITY_PUBLIC_URL, SECURITY_STORE_FILE, SECURITY_SSO_SECRET } from './config.js';
import { attachUser, COOKIE, errorHandler, limit } from './middleware.js';
import { requireSecurityService } from './internal-auth.js';
import { authRouter } from './routes/auth.js';
import { chatsRouter } from './routes/chats.js';
import { messagesRouter } from './routes/messages.js';
import { mediaRouter } from './routes/media.js';
import { apiRouter } from './routes/misc.js';
import { adminRouter } from './routes/admin.js';
import { supportRouter } from './routes/support.js';
import { commerceRouter } from './routes/commerce.js';
import { storiesRouter, startStoryMaintenance } from './routes/stories.js';
import { callsRouter, startCallMaintenance } from './routes/calls.js';
import { attachRealtime, bootstrapIndex, closeSessionSockets, closeUserSockets } from './realtime.js';
import { attachLiveKitProxy } from './livekit-proxy.js';
import { db, chats, media, now, users, sessions, twoFactor } from './db.js';
import { checkMediaSig, verifyPassword, verifyTotp } from './security.js';
import { mediaPath, streamFile } from './storage.js';
import { publishDueScheduledPosts } from './services/scheduled-posts.js';
import { isAllowedPublicOrigin, parsePublicOrigin, parseTrustedProxyAddresses } from './request-security.js';
import { openSecurityStore, getSecurityStore } from './security-store.js';
import { recordAccessDenied, recordAdminReauthFailure, recordAuthRejection, recordSecurityEvent } from './security-events.js';
import crypto from 'node:crypto';

openSecurityStore(SECURITY_STORE_FILE);
const app = express();
app.disable('x-powered-by');
const trustedProxyAddresses = parseTrustedProxyAddresses(process.env.TRUST_PROXY_ADDRESSES);
const publicOrigin = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
app.set('trust proxy', trustedProxyAddresses);
const protectedMediaAccess = db.prepare(`SELECT EXISTS (
  SELECT 1
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  WHERE c.type = 'channel'
    AND c.protected_content = 1
    AND (m.media_id = ? OR EXISTS (
      SELECT 1 FROM message_media mm WHERE mm.message_id = m.id AND mm.media_id = ?
    ))
) AS protected, EXISTS (
  SELECT 1
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  WHERE c.type = 'channel'
    AND c.protected_content = 1
    AND (m.media_id = ? OR EXISTS (
      SELECT 1 FROM message_media mm WHERE mm.message_id = m.id AND mm.media_id = ?
    ))
    AND NOT EXISTS (
      SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = ?
    )
) AS denied`);

/* ── CORS: API доступен и из встроенных песочниц (opaque origin) — авторизация по Bearer-токену,
      куки не обязательны, поэтому «*» не повышает риск: без токена данных не получить. ── */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  let securityOrigin = '';
  try {
    const url = new URL(SECURITY_PUBLIC_URL);
    if (url.protocol === 'https:') securityOrigin = ` ${url.origin}`;
  } catch { /* Security service is not configured yet. */ }
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' ws: wss: stun: turn: turns:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${securityOrigin}`,
  ].join('; '));
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(attachUser);
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  let recorded = false;
  res.json = (body) => {
    if (!recorded && (res.statusCode === 401 || res.statusCode === 403)
      && (req.path.startsWith('/api/') || req.path.startsWith('/media/'))) {
      recorded = true;
      if (res.statusCode === 401) {
        recordAuthRejection(req);
      } else {
        let resourceType = 'resource';
        if (req.path.includes('/messages')) resourceType = 'message';
        else if (req.path.includes('/media')) resourceType = 'file';
        else if (req.path.includes('/chats')) resourceType = 'chat';
        recordAccessDenied(req, { actorId: req.user?.id || null, resourceType });
      }
    }
    return sendJson(body);
  };
  next();
});
app.use((req, res, next) => {
  const { level } = getSecurityStore().getState();
  const pathname = req.path;
  const isRegister = req.method === 'POST' && pathname === '/api/auth/register';
  const isLogin = req.method === 'POST' && pathname === '/api/auth/login';
  const isLoginCompletion = req.method === 'POST' && pathname === '/api/auth/protective-password/setup-after-login';
  const isMessageWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
    && (/^\/api\/chats\/[^/]+\/messages(?:\/|$)/.test(pathname)
      || /^\/api\/messages(?:\/|$)/.test(pathname));
  const isStoryWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
    && /^\/api\/stories(?:\/|$)/.test(pathname);
  const isUpload = req.method === 'POST' && /^\/api\/media\/?$/.test(pathname);
  const isAdminApi = pathname === '/api/admin' || pathname.startsWith('/api/admin/');
  const loginUser = isLogin ? users.byEmail.get(String(req.body?.email || '').trim().toLowerCase()) : null;
  const blockedLogin = isLogin && !loginUser?.is_admin;
  if (level >= 3 && (isRegister || blockedLogin || isLoginCompletion || isMessageWrite || isStoryWrite || isUpload || isAdminApi)) {
    return res.status(503).json({
      error: 'Эта операция временно приостановлена аварийным режимом Aurora Security.',
      code: 'security_emergency_mode',
    });
  }
  next();
});
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    || req.headers.authorization?.startsWith('Bearer ')
    || !new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).test(req.headers.cookie || '')) {
    return next();
  }
  const origin = req.get('origin');
  if (origin) {
    let parsedOrigin;
    try { parsedOrigin = new URL(origin); } catch { return res.status(403).json({ error: 'Источник запроса не разрешён', code: 'csrf_rejected' }); }
    if (parsedOrigin.origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Источник запроса не разрешён', code: 'csrf_rejected' });
    }
    return next();
  }
  if (req.get('sec-fetch-site') === 'same-origin') return next();
  return res.status(403).json({ error: 'Не удалось проверить источник запроса', code: 'csrf_rejected' });
});

app.post('/internal/security/chats', requireSecurityService, (req, res) => {
  const type = String(req.body?.type || 'all');
  const rawCursor = req.body?.cursor;
  const cursor = rawCursor === null || rawCursor === undefined || rawCursor === '' ? null : Number(rawCursor);
  const requestedLimit = req.body?.limit === undefined ? 50 : Number(req.body.limit);
  if (!['all', 'group', 'channel'].includes(type)
    || (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1))
    || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    return res.status(400).json({ error: 'Некорректные параметры списка чатов' });
  }

  const rows = chats.securityList.all({ type, cursor, limit: requestedLimit + 1 });
  const hasMore = rows.length > requestedLimit;
  const chatRows = rows.slice(0, requestedLimit).map((chat) => ({
    id: chat.id,
    type: chat.type,
    title: chat.title || (chat.username ? `@${chat.username}` : `Чат #${chat.id}`),
    username: chat.username,
    description: chat.description,
    isPublic: Boolean(chat.is_public),
    isFrozen: Boolean(chat.is_frozen),
    memberCount: chat.member_count,
    createdAt: chat.created_at,
  }));
  res.json({ chats: chatRows, nextCursor: hasMore ? chatRows[chatRows.length - 1].id : null });
});

function isCurrentAdmin(userId) {
  const user = db.prepare('SELECT id, is_admin, is_blocked, is_frozen FROM users WHERE id = ?').get(userId);
  return user && user.is_admin && !user.is_blocked && !user.is_frozen ? user : null;
}

function securityRequestSignature(req) {
  const timestamp = String(req.get('x-aurora-timestamp') || '');
  const nonce = String(req.get('x-aurora-nonce') || '');
  const signature = String(req.get('x-aurora-signature') || '');
  if (!SECURITY_SSO_SECRET || Buffer.byteLength(SECURITY_SSO_SECRET) < 32
    || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000
    || !/^[a-f0-9]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const body = JSON.stringify(req.body ?? {});
  const expected = crypto.createHmac('sha256', SECURITY_SSO_SECRET)
    .update(`${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${body}`).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return { timestamp, nonce };
}

function requireSecurityControlPlane(req, res, next) {
  const verified = securityRequestSignature(req);
  if (!verified) return res.status(401).json({ error: 'Подпись Aurora Security не подтверждена' });
  if (!getSecurityStore().claimServiceNonce(verified.nonce, Date.now() + 60_000)) {
    return res.status(401).json({ error: 'Повторный запрос Aurora Security' });
  }
  const actorId = Number(req.body?.actorId);
  const actor = Number.isSafeInteger(actorId) ? isCurrentAdmin(actorId) : null;
  if (!actor) return res.status(403).json({ error: 'Текущая роль администратора не подтверждена' });
  req.securityActor = actor;
  next();
}

app.post('/internal/security/admin-status', requireSecurityService, (req, res) => {
  const userId = Number(req.body?.actorId);
  const actor = Number.isSafeInteger(userId) ? isCurrentAdmin(userId) : null;
  res.json({ isAdmin: Boolean(actor) });
});

app.post('/internal/security/dashboard', requireSecurityService, requireSecurityControlPlane, (req, res) => {
  const store = getSecurityStore();
  const current = store.getState();
  const activeSessions = db.prepare(`SELECT s.id AS sessionId, s.user_id AS userId, u.username,
      s.created_at AS createdAt, s.last_seen AS lastSeen, s.user_agent AS userAgent
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ?
    ORDER BY s.last_seen DESC LIMIT 200`).all(Date.now());
  res.json({
    state: current,
    counts: {
      critical: store.countOpenCriticalIncidents(),
      failedLogins: store.countThresholdEvents('auth.login_failed', Date.now() - 24 * 60 * 60 * 1000, 10 * 60 * 1000),
      newSessions: store.countThresholdEvents('auth.session_created', Date.now() - 24 * 60 * 60 * 1000, 10 * 60 * 1000),
    },
    events: store.listEvents({ limit: 100 }).map((event) => ({
      ...event,
      details: JSON.parse(event.details_json),
    })),
    incidents: store.listIncidents({ limit: 100 }),
    restrictions: store.listRestrictions(),
    sessions: activeSessions,
    audit: store.listAdminAudit(100),
    notifications: store.listNotifications(100),
  });
});

const SECURITY_REASONS = new Set([
  'suspected_compromise', 'confirmed_compromise', 'credential_stuffing', 'malware',
  'account_takeover', 'service_abuse', 'incident_containment', 'recovery',
]);

app.post('/internal/security/reauth', requireSecurityService, requireSecurityControlPlane, (req, res) => {
  const actorId = req.securityActor.id;
  const attempt = getSecurityStore().consumeReauthAttempt(actorId, Date.now());
  if (!attempt.ok) {
    recordAdminReauthFailure(req, actorId, 429);
    return res.status(429).json({ error: 'Слишком много попыток повторной авторизации. Попробуйте позже.' });
  }
  const user = users.byId.get(actorId);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const command = typeof req.body?.command === 'string' ? req.body.command : '';
  if (!/^security:(?:level:[0-3]|restriction:(?:add|lift))$/.test(command)) {
    return res.status(400).json({ error: 'Некорректная критическая операция' });
  }
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAdminReauthFailure(req, actorId, 401);
    return res.status(401).json({ error: 'Повторная проверка пароля не пройдена' });
  }
  const factor = twoFactor.byUser.get(actorId);
  if (!factor?.enabled || !verifyTotp(factor.secret, code)) {
    recordAdminReauthFailure(req, actorId, 403);
    return res.status(403).json({ error: 'Для критических действий требуется настроенная MFA и актуальный код' });
  }
  const proof = crypto.randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  getSecurityStore().createReauth({
    proofHash: crypto.createHash('sha256').update(proof).digest('hex'),
    actorId,
    action: command,
    createdAt,
    expiresAt: createdAt + 5 * 60_000,
  });
  res.json({ proof, expiresAt: createdAt + 5 * 60_000 });
});

app.post('/internal/security/response', requireSecurityService, requireSecurityControlPlane, (req, res) => {
  const store = getSecurityStore();
  const actorId = req.securityActor.id;
  const action = String(req.body?.command || '');
  const reason = String(req.body?.reason || '');
  const idempotencyKey = String(req.body?.idempotencyKey || '');
  const proof = String(req.body?.proof || '');
  const timestamp = Date.now();
  const current = store.getState();
  const targetLevel = /^security:level:[0-3]$/.test(action) ? Number(action.slice(-1)) : null;
  const kind = String(req.body?.kind || '');
  const target = String(req.body?.target || '');
  const durationMs = Number(req.body?.durationMs);
  const restrictionId = Number(req.body?.restrictionId);

  if (!SECURITY_REASONS.has(reason)) return res.status(400).json({ error: 'Выберите допустимую причину операции' });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(idempotencyKey)) {
    return res.status(400).json({ error: 'Некорректный ключ операции' });
  }
  if (targetLevel === null && !['security:restriction:add', 'security:restriction:lift'].includes(action)) {
    return res.status(400).json({ error: 'Неизвестная операция безопасности' });
  }
  if (targetLevel !== null && (Math.abs(targetLevel - current.level) !== 1
    || (targetLevel === 3 && req.body?.consequencesConfirmed !== true)
    || (targetLevel < current.level && req.body?.recoveryConfirmed !== true))) {
    return res.status(409).json({ error: 'Уровень меняется только на один шаг; подтвердите последствия эскалации или проверенное восстановление' });
  }
  if (action === 'security:restriction:add') {
    if (!['account', 'session', 'ip'].includes(kind) || !target || target.length > 100
      || !Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60_000) {
      return res.status(400).json({ error: 'Некорректное временное ограничение' });
    }
    if (kind === 'account') {
      if (!/^[1-9]\d*$/.test(target)) return res.status(400).json({ error: 'Некорректный идентификатор' });
      const targetUserId = Number(target);
      if (!Number.isSafeInteger(targetUserId)) return res.status(400).json({ error: 'Некорректный идентификатор' });
      const targetUser = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetUserId);
      if (!targetUser || targetUser.is_admin || targetUser.id === actorId) {
        return res.status(403).json({ error: 'Нельзя ограничить администратора, оператора или неизвестный аккаунт' });
      }
    } else if (kind === 'session') {
      const targetSession = sessions.active.get(target, timestamp);
      const targetIsAdmin = targetSession
        && db.prepare('SELECT is_admin FROM users WHERE id = ?').get(targetSession.user_id)?.is_admin;
      if (!targetSession || targetSession.user_id === actorId || targetIsAdmin) {
        return res.status(403).json({ error: 'Нельзя отозвать собственный сеанс или сеанс администратора' });
      }
    }
    if (kind === 'ip') {
      return res.status(503).json({ error: 'IP-ограничения отключены, пока адрес оператора и доверие к proxy не подтверждены.' });
    }
  }
  if (action === 'security:restriction:lift'
    && (!/^[1-9]\d*$/.test(String(req.body?.restrictionId || ''))
      || !Number.isSafeInteger(restrictionId) || restrictionId < 1)) {
    return res.status(400).json({ error: 'Некорректный ID ограничения' });
  }

  const proofHash = crypto.createHash('sha256').update(proof).digest('hex');
  let result;
  let sessionToRevoke = null;
  let accountToRestrict = null;
  let stateBeforeAction = current;
  try {
    store.transaction(() => {
      if (!store.consumeReauth({ proofHash, actorId, action, timestamp })) {
        throw new Error('REAUTH_REJECTED');
      }
      stateBeforeAction = store.getState();
      if (targetLevel !== null && (Math.abs(targetLevel - stateBeforeAction.level) !== 1
        || (targetLevel === 3 && req.body?.consequencesConfirmed !== true)
        || (targetLevel < stateBeforeAction.level && req.body?.recoveryConfirmed !== true))) {
        throw new Error('LEVEL_CONFLICT');
      }
      let targetType = '';
      let targetId = '';
      let payload = {};
      if (targetLevel !== null) {
        store.setState({ level: targetLevel, updatedAt: timestamp, updatedBy: actorId, reason });
        payload = { state: store.getState() };
      } else if (action === 'security:restriction:add') {
        const activeSession = kind === 'session' ? sessions.active.get(target, timestamp) : null;
        const newRestrictionId = store.addRestriction({
          kind, target, reason, createdBy: actorId, createdAt: timestamp, expiresAt: timestamp + durationMs,
        });
        if (kind === 'account') accountToRestrict = Number(target);
        if (activeSession) sessionToRevoke = { id: target, userId: activeSession.user_id };
        targetType = kind;
        targetId = target;
        payload = { restrictionId: newRestrictionId, expiresAt: timestamp + durationMs };
      } else {
        if (!store.liftRestriction(restrictionId, actorId, timestamp)) throw new Error('RESTRICTION_NOT_FOUND');
        targetType = 'restriction';
        targetId = String(restrictionId);
        payload = { restrictionId, lifted: true };
      }
      const audit = store.appendAdminAudit({
        createdAt: timestamp, actorId, action, targetType, targetId, reason,
        details: {
          resultingLevel: store.getState().level,
          ...(targetLevel !== null && targetLevel < current.level ? {
            previousLevel: stateBeforeAction.level,
            criticalIncidents: store.countOpenCriticalIncidents(),
            activeSessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > ?').get(timestamp).count,
          } : {}),
        },
        idempotencyKey,
      });
      if (!audit.inserted) throw new Error('DUPLICATE_COMMAND');
      result = payload;
    });
  } catch (error) {
    if (error.message === 'REAUTH_REJECTED') return res.status(403).json({ error: 'Повторная авторизация истекла или уже использована' });
    if (error.message === 'LEVEL_CONFLICT') return res.status(409).json({ error: 'Состояние изменилось параллельно; обновите панель и подтвердите операцию заново' });
    if (error.message === 'RESTRICTION_NOT_FOUND') return res.status(404).json({ error: 'Активное ограничение не найдено' });
    if (error.message === 'DUPLICATE_COMMAND') return res.status(409).json({ error: 'Операция уже была выполнена' });
    throw error;
  }
  if (sessionToRevoke) {
    sessions.revoke.run(timestamp, sessionToRevoke.id, sessionToRevoke.userId);
    closeSessionSockets(sessionToRevoke.id);
  }
  if (accountToRestrict) closeUserSockets(accountToRestrict);
  recordSecurityEvent({ type: 'security.response', actorId, subject: `admin:${actorId}`, details: { reason: action, source: reason } });
  res.json({ ok: true, ...result });
});

/* ── Медиа: отдаётся только по подписанной ссылке (HMAC + срок) ── */
app.get(['/media/:id', '/media/:id/:variant'], limit('read'), (req, res) => {
  const id = Number(req.params.id);
  const variant = req.params.variant || '';
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Некорректный идентификатор' });
  if (!checkMediaSig(id, variant, req.query.e, req.query.s)) return res.status(403).json({ error: 'Ссылка недействительна или истекла' });
  const row = media.byId.get(id);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  const access = protectedMediaAccess.get(id, id, id, id, req.user?.id || 0);
  if (access.denied) {
    return res.status(403).json({ error: 'Нет доступа к защищённому содержимому' });
  }
  if (variant === 'thumb' && row.thumb_path) {
    const p = mediaPath({ path: row.thumb_path });
    if (fs.existsSync(p)) {
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': access.protected ? 'private, no-store' : 'private, max-age=604800, immutable',
      });
      return fs.createReadStream(p).pipe(res);
    }
  }
  return streamFile(req, res, row, {
    cacheControl: access.protected ? 'private, no-store' : undefined,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: now(), uptime: process.uptime() }));
app.get('/vendor/livekit-client.umd.js', (req, res, next) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js'), (error) => {
    if (error) next(error);
  });
});

const assetLinksFile = path.join(PUBLIC_DIR, '.well-known', 'assetlinks.json');
app.get('/.well-known/assetlinks.json', (req, res, next) => {
  if (!fs.existsSync(assetLinksFile)) return res.status(404).json({ error: 'Digital Asset Links are not configured' });
  res.type('application/json').sendFile(assetLinksFile, { dotfiles: 'allow' }, (error) => {
    if (error) next(error);
  });
});

/* ── REST API ── */
app.use('/api/auth', authRouter);
app.use('/api/commerce', commerceRouter);
app.use('/api/stories', storiesRouter);
app.use('/api', messagesRouter);   // /api/chats/:id/messages, /api/messages/:id...
app.use('/api/media', mediaRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/support', supportRouter);
app.use('/api', callsRouter);
app.use('/api/admin', adminRouter);
app.use('/api', apiRouter);        // /api/search, /api/settings, /api/users/:id, /api/updates, /api/state

/* ── Статика (SPA) ── */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: 0,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(?:html?|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));
// SPA-fallback (Express 5: без wildcard-шаблона — используем middleware)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/media/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use(errorHandler);

const server = http.createServer(app);
attachLiveKitProxy(server);
attachRealtime(server, (origin) => isAllowedPublicOrigin(origin, publicOrigin));
bootstrapIndex();
startCallMaintenance();
startStoryMaintenance();
const scheduledPostsTimer = setInterval(() => {
  publishDueScheduledPosts().catch((error) => {
    console.error('Unable to process scheduled channel posts:', error.message);
  });
}, 5000);
scheduledPostsTimer.unref();
publishDueScheduledPosts().catch((error) => {
  console.error('Unable to process scheduled channel posts:', error.message);
});

server.listen(PORT, HOST, () => {
  console.log(`Aurora Messenger запущен: http://localhost:${PORT}  (host ${HOST})`);
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  console.log(`Пользователей в базе: ${count}`);
});

function shutdown(signal) {
  console.log(`\n${signal}: останавливаем сервер…`);
  clearInterval(scheduledPostsTimer);
  server.close(() => {
    try { db.close(); } catch { /* noop */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
