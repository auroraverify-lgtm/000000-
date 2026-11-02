import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { getSecurityStore } from './security-store.js';

const WINDOW_MS = 10 * 60 * 1000;
const EVENT_TYPES = new Set([
  'auth.login_failed',
  'auth.login_success',
  'auth.session_created',
  'auth.session_revoked',
  'auth.session_invalid',
  'api.rate_limited',
  'access.denied',
  'ws.origin_rejected',
  'ws.auth_rejected',
  'ws.protocol_anomaly',
  'admin.action',
  'admin.reauth_failed',
  'security.response',
]);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const RECOMMENDATIONS = {
  'auth.login_failed': 'Проверить повторяемость попыток и при необходимости усилить аутентификацию.',
  'auth.login_success': 'Проверить, соответствует ли новая сессия ожидаемой активности пользователя.',
  'auth.session_created': 'Подтвердить новое устройство с владельцем аккаунта при подозрении.',
  'auth.session_revoked': 'Проверить, что отзыв был ожидаемым.',
  'auth.session_invalid': 'Проверить повторяющиеся отказы аутентификации и состояние сессии.',
  'api.rate_limited': 'Проверить всплеск запросов; не блокировать только по IP.',
  'access.denied': 'Проверить серию отказов доступа и связанные аккаунты.',
  'ws.origin_rejected': 'Проверить источник и частоту неуспешных WebSocket handshake.',
  'ws.auth_rejected': 'Проверить повторяющиеся отказы аутентификации WebSocket.',
  'ws.protocol_anomaly': 'Проверить частоту некорректных realtime-событий.',
  'admin.action': 'Проверить действие администратора по неизменяемому журналу.',
  'admin.reauth_failed': 'Проверить неудачные попытки повторной авторизации администратора.',
  'security.response': 'Проверить состояние режима защиты и сохранённый аудит.',
};

function normalizeIp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
  return isIP(normalized) ? normalized.toLowerCase() : null;
}

function peerIp(req) {
  const peer = normalizeIp(req?.socket?.remoteAddress);
  if (!peer) return { ipAddress: null, ipConfidence: 'not_available' };
  if (peer === '::1' || (isIP(peer) === 4 && peer.split('.')[0] === '127')) {
    return { ipAddress: null, ipConfidence: 'unknown_proxy_peer' };
  }
  return { ipAddress: peer, ipConfidence: 'tcp_peer' };
}

function subjectHash(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function safeDetails(details = {}) {
  const result = {};
  const reasonCodes = new Set([
    'invalid_credentials', 'rate_limited', 'authorization_denied', 'invalid_origin',
    'invalid_token', 'invalid_session', 'malformed_message', 'new_session',
    'logout', 'manual_revocation', 'password_change',
  ]);
  if (reasonCodes.has(details.reason)) result.reason = details.reason;
  if (typeof details.route === 'string' && /^\/[a-zA-Z0-9/_:-]{1,100}$/.test(details.route)) result.route = details.route;
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(details.method)) result.method = details.method;
  if (Number.isSafeInteger(details.status) && details.status >= 100 && details.status <= 599) result.status = details.status;
  if (Number.isSafeInteger(details.count) && details.count >= 0) result.count = details.count;
  if (['account', 'session', 'chat', 'file', 'message', 'resource'].includes(details.resourceType)) result.resourceType = details.resourceType;
  if (['login', 'websocket', 'admin', 'registration'].includes(details.source)) result.source = details.source;
  return result;
}

function severityFor(type, thresholdCount) {
  if (type === 'auth.login_failed' && thresholdCount >= 10) return 'critical';
  if (type === 'auth.login_failed' && thresholdCount >= 5) return 'high';
  if (type === 'auth.session_invalid' && thresholdCount >= 5) return 'high';
  if (type === 'api.rate_limited' && thresholdCount >= 8) return 'high';
  if (type === 'access.denied' && thresholdCount >= 5) return 'high';
  if (type.startsWith('ws.') && thresholdCount >= 10) return 'high';
  if (type === 'admin.action' && thresholdCount >= 20) return 'high';
  if (type === 'admin.reauth_failed' && thresholdCount >= 5) return 'high';
  if (type === 'auth.session_created') return 'medium';
  if (type === 'admin.action') return 'medium';
  if (type === 'security.response') return 'high';
  if (type === 'auth.login_failed' || type === 'auth.session_invalid' || type === 'api.rate_limited' || type === 'access.denied') return 'low';
  return 'info';
}

export function getRequestIpAssessment(req) {
  return peerIp(req);
}

export function recordSecurityEvent({
  type,
  req = null,
  actorId = null,
  sessionId = null,
  subject = '',
  severity,
  details = {},
  eventKey = null,
} = {}) {
  if (!EVENT_TYPES.has(type)) throw new Error('Unsupported security event type.');
  const now = Date.now();
  const subjectDigest = subjectHash(subject || actorId || req?.socket?.remoteAddress || 'system');
  const thresholdCount = getSecurityStore().incrementThreshold(type, subjectDigest, now, WINDOW_MS);
  const classifiedSeverity = severity || severityFor(type, thresholdCount);
  if (!SEVERITIES.has(classifiedSeverity)) throw new Error('Invalid security event severity.');
  const ip = peerIp(req);
  const sessionKey = sessionId ? `:${subjectHash(sessionId)}` : '';
  const key = eventKey || `${type}:${subjectDigest}${sessionKey}:${Math.floor(now / 60_000)}:${classifiedSeverity}`;
  const result = getSecurityStore().appendEvent({
    createdAt: now,
    type,
    severity: classifiedSeverity,
    actorId: Number.isSafeInteger(actorId) ? actorId : null,
    sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 80) : null,
    ipAddress: ip.ipAddress,
    ipConfidence: ip.ipConfidence,
    subjectHash: subjectDigest,
    details: safeDetails(details),
    eventKey: key.slice(0, 220),
  });
  if (['high', 'critical'].includes(classifiedSeverity)) {
    const incidentKey = `${type}:${subjectDigest}`;
    getSecurityStore().upsertIncident({
      incidentKey,
      type,
      severity: classifiedSeverity,
      subjectHash: subjectDigest,
      actorId: Number.isSafeInteger(actorId) ? actorId : null,
      ipAddress: ip.ipAddress,
      ipConfidence: ip.ipConfidence,
      recommendation: RECOMMENDATIONS[type],
      now,
    });
    if (result.inserted) {
      const observedAddress = ip.ipConfidence === 'tcp_peer' ? `TCP peer: ${ip.ipAddress}. ` : 'IP: адрес узла proxy не подтверждает клиента. ';
      getSecurityStore().addNotification({
        eventId: result.id,
        title: `Событие безопасности: ${type}`,
        body: `Уровень риска: ${classifiedSeverity}. Аккаунт: ${actorId ?? 'не определён'}. Сессия: ${sessionId || 'не определена'}. ${observedAddress}${RECOMMENDATIONS[type]}`,
        createdAt: now,
      });
    }
  }
  return result;
}

export function recordLoginFailure(req, account, userId = null) {
  return recordSecurityEvent({
    type: 'auth.login_failed',
    req,
    actorId: userId,
    subject: `account:${account}`,
    details: { reason: 'invalid_credentials', route: '/api/auth/login', method: 'POST', status: 401 },
  });
}

export function recordRateLimit(req, route, actorId = null) {
  return recordSecurityEvent({
    type: 'api.rate_limited',
    req,
    actorId,
    subject: `peer:${req?.socket?.remoteAddress || 'unknown'}:${route}`,
    details: { route, method: req?.method || '', status: 429 },
  });
}

export function recordAccessDenied(req, { actorId = null, resourceType = 'resource', subject = '' } = {}) {
  return recordSecurityEvent({
    type: 'access.denied',
    req,
    actorId,
    subject: subject || `actor:${actorId || 'unknown'}:${resourceType}`,
    details: { resourceType, method: req?.method || '', status: 403 },
  });
}

export function recordAuthRejection(req) {
  return recordSecurityEvent({
    type: 'auth.session_invalid',
    req,
    actorId: req?.user?.id || null,
    subject: req?.user ? `user:${req.user.id}` : `peer:${req?.socket?.remoteAddress || 'unknown'}`,
    details: { reason: 'invalid_session', route: req?.path || '', method: req?.method || '', status: 401 },
  });
}

export function recordSessionCreated(req, { actorId, sessionId, isKnownDevice, userAgent }) {
  const unusual = !isKnownDevice || !userAgent;
  return recordSecurityEvent({
    type: 'auth.session_created',
    req,
    actorId,
    sessionId,
    subject: `user:${actorId}`,
    severity: unusual ? 'medium' : 'info',
    details: { source: 'login' },
  });
}

export function recordSessionRevoked(req, { actorId, sessionId, reason = 'manual_revocation' }) {
  return recordSecurityEvent({
    type: 'auth.session_revoked',
    req,
    actorId,
    sessionId,
    subject: `session:${sessionId}`,
    details: { reason },
  });
}

export function recordAdminAction({ actorId, action, targetType = '', targetId = '', reason = '', idempotencyKey }) {
  const now = Date.now();
  const result = getSecurityStore().appendAdminAudit({
    createdAt: now,
    actorId,
    action: String(action).slice(0, 80),
    targetType: String(targetType).slice(0, 40),
    targetId: String(targetId).slice(0, 100),
    reason: String(reason).slice(0, 300),
    details: {},
    idempotencyKey: idempotencyKey || `${action}:${actorId}:${now}:${crypto.randomBytes(8).toString('hex')}`,
  });
  recordSecurityEvent({
    type: 'admin.action',
    actorId,
    subject: `admin:${actorId}`,
    details: { reason: String(action).slice(0, 80), resourceType: targetType },
  });
  return result;
}

export function recordAdminReauthFailure(req, actorId, status) {
  return recordSecurityEvent({
    type: 'admin.reauth_failed',
    req,
    actorId,
    subject: `admin:${actorId}`,
    details: { reason: 'authorization_denied', route: '/internal/security/reauth', method: 'POST', status, source: 'admin' },
  });
}
