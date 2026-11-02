/**
 * Middleware: аутентификация, ограничение частоты, единый формат ошибок.
 * Принцип: ни один маршрут не доверяет данным клиента — вся валидация на сервере.
 */
import { createHash } from 'node:crypto';
import { users, sessions, now } from './db.js';
import { verifyToken, rateLimit } from './security.js';
import { SESSION_DAYS } from './config.js';
import { getSecurityStore } from './security-store.js';
import { getRequestIpAssessment, recordRateLimit } from './security-events.js';

export const COOKIE = 'aurora_token';

export function attachUser(req, res, next) {
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) token = header.slice(7);
  if (!token) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (m) token = decodeURIComponent(m[1]);
  }
  const payload = verifyToken(token);
  req.tokenPayload = payload;
  if (payload) {
    const user = users.byId.get(payload.sub);
    // token_version позволяет мгновенно инвалидировать все сессии (смена пароля, «выйти везде»)
    const session = payload.jti ? sessions.active.get(payload.jti, now()) : null;
    if (user && user.token_version === payload.tv && (!payload.jti || session?.user_id === user.id)) {
      req.user = user;
      req.sessionId = payload.jti || null;
      if (payload.jti) sessions.touch.run(now(), payload.jti);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт', code: 'unauthorized' });
  if (isSecurityRestricted(req)) return res.status(423).json({ error: 'Доступ к аккаунту или сеансу временно ограничен', code: 'security_restricted' });
  if (req.user.is_blocked) return res.status(403).json({ error: 'Аккаунт заблокирован', code: 'account_blocked' });
  if (req.user.is_frozen) return res.status(403).json({ error: 'Аккаунт временно заморожен', code: 'account_frozen' });
  if (!req.user.email_verified && req.user.email_verification_deadline_at && req.user.email_verification_deadline_at <= now()) {
    return res.status(403).json({ error: 'Срок подтверждения почты истёк. Подтвердите адрес в настройках аккаунта.', code: 'email_verification_overdue' });
  }
  next();
}

export function requireEmailVerificationAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт', code: 'unauthorized' });
  if (isSecurityRestricted(req)) return res.status(423).json({ error: 'Доступ к аккаунту или сеансу временно ограничен', code: 'security_restricted' });
  if (req.user.is_blocked) return res.status(403).json({ error: 'Аккаунт заблокирован', code: 'account_blocked' });
  if (req.user.is_frozen) return res.status(403).json({ error: 'Аккаунт временно заморожен', code: 'account_frozen' });
  next();
}

function isSecurityRestricted(req) {
  const store = getSecurityStore();
  if (store.isRestricted('account', String(req.user.id))) return true;
  if (req.sessionId && store.isRestricted('session', req.sessionId)) return true;
  const ip = getRequestIpAssessment(req);
  return ip.ipAddress !== null && store.isRestricted('ip', ip.ipAddress);
}

export function limit(kind) {
  return (req, res, next) => {
    const key = req.user ? `u${req.user.id}` : (req.ip || req.socket.remoteAddress || 'unknown');
    const r = rateLimit(kind, key);
    res.set('X-RateLimit-Remaining', String(r.remaining));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      recordRateLimit(req, req.path, req.user?.id || null);
      return res.status(429).json({ error: `Слишком много запросов. Попробуйте через ${r.retryAfter} с.`, code: 'rate_limited' });
    }
    next();
  };
}

export function limitByAccount(kind) {
  return (req, res, next) => {
    const account = String(req.body?.email || '').trim().toLowerCase();
    if (!account) return next();
    const key = createHash('sha256').update(account).digest('hex');
    const r = rateLimit(kind, key);
    res.set('X-RateLimit-Remaining', String(r.remaining));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      recordRateLimit(req, req.path, req.user?.id || null);
      return res.status(429).json({ error: `Слишком много запросов. Попробуйте через ${r.retryAfter} с.`, code: 'rate_limited' });
    }
    next();
  };
}

export function limitByIp(kind) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const r = rateLimit(kind, key);
    res.set('X-RateLimit-Remaining', String(r.remaining));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      recordRateLimit(req, req.path, req.user?.id || null);
      return res.status(429).json({ error: `Слишком много запросов. Попробуйте через ${r.retryAfter} с.`, code: 'rate_limited' });
    }
    next();
  };
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1',
    maxAge: SESSION_DAYS * 86400 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Обёртка для async-обработчиков: ошибки уходят в errorHandler, а не роняют процесс. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  const message = status >= 500 && !err.expose ? 'Внутренняя ошибка сервера' : err.message;
  res.status(status).json({ error: message, code: err.code || 'error', details: err.details });
}

export const badRequest = (message, details) => Object.assign(new Error(message), { status: 400, details });
export const forbidden = (message = 'Недостаточно прав') => Object.assign(new Error(message), { status: 403 });
export const notFound = (message = 'Не найдено') => Object.assign(new Error(message), { status: 404 });
export const conflict = (message, details) => Object.assign(new Error(message), { status: 409, details });

export function touchActivity(req) {
  req.user && now();
}
