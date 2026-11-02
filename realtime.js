/**
 * Realtime Hub: WebSocket + журнал событий для fallback-синхронизации.
 * Любое изменение состояния проходит через publishChat/publishUser — благодаря этому
 * клиенты синхронны независимо от транспорта (WS или поллинг /api/updates).
 */
import { WebSocketServer } from 'ws';
import { db, events, chats, users, sessions, settings, now } from './db.js';
import { verifyToken } from './security.js';
import { canViewStatus, userDTO } from './helpers.js';
import { getRequestIpAssessment, recordSecurityEvent } from './security-events.js';
import { getSecurityStore } from './security-store.js';

/** chatId -> Set(userId) — для маршрутизации событий (перестроен при старте). */
const chatMembers = new Map();
/** userId -> Set(chatId) */
const userChats = new Map();
/** userId -> Set(WebSocket) — несколько устройств на пользователя. */
const sockets = new Map();
/** userId -> Set<userId>, кому транслировать presence/typing. */
const contacts = new Map();

export const hub = {
  chatMembers,
  userChats,
  sockets,
};

export function indexChat(chatId) {
  const ids = chats.memberIds.all(chatId).map((r) => r.user_id);
  chatMembers.set(chatId, new Set(ids));
  for (const uid of ids) {
    if (!userChats.has(uid)) userChats.set(uid, new Set());
    userChats.get(uid).add(chatId);
  }
  rebuildContacts();
}

export function unindexChat(chatId) {
  const ids = chatMembers.get(chatId) || new Set();
  chatMembers.delete(chatId);
  for (const uid of ids) userChats.get(uid)?.delete(chatId);
  rebuildContacts();
}

export function rebuildContacts() {
  contacts.clear();
  for (const [chatId, ids] of chatMembers) {
    for (const a of ids) {
      if (!contacts.has(a)) contacts.set(a, new Set());
      for (const b of ids) if (a !== b) contacts.get(a).add(b);
    }
  }
}

export function bootstrapIndex() {
  chatMembers.clear();
  userChats.clear();
  for (const row of db.prepare('SELECT DISTINCT chat_id FROM chat_members').all()) indexChat(row.chat_id);
  rebuildContacts();
}

/** Публикация в чат: персистентный журнал + рассылка подключённым. */
export function publishChat(chatId, type, payload, { skip = null } = {}) {
  const event = { type, chatId, payload, ts: now() };
  const info = events.push.run(`chat:${chatId}`, type, JSON.stringify(event), event.ts);
  event.eventId = Number(info.lastInsertRowid);
  const members = chatMembers.get(chatId);
  if (members) for (const uid of members) if (uid !== skip) sendTo(uid, event);
  return event;
}

export function publishUser(userId, type, payload) {
  const event = { type, userId, payload, ts: now() };
  const info = events.push.run(`user:${userId}`, type, JSON.stringify(event), event.ts);
  event.eventId = Number(info.lastInsertRowid);
  sendTo(userId, event);
  return event;
}

export function sendTo(userId, event) {
  const set = sockets.get(userId);
  if (!set) return 0;
  const data = JSON.stringify(event);
  let delivered = 0;
  for (const ws of set) if (ws.readyState === 1) { ws.send(data); delivered++; }
  return delivered;
}

/** Typing — эфемерное событие, в журнал не пишем. */
export function publishTyping(chatId, userId, isTyping) {
  const members = chatMembers.get(chatId) || new Set();
  for (const uid of members) if (uid !== userId) sendTo(uid, { type: 'typing', chatId, userId, isTyping, ts: now() });
}

export function broadcastPresence(userId, presence, lastSeen) {
  const set = contacts.get(userId);
  if (!set) return;
  for (const uid of set) {
    if (canViewStatus(userId, uid, settings.byUser.get(userId))) {
      sendTo(uid, { type: 'presence', userId, presence, lastSeen, ts: now() });
    }
  }
}

export function refreshPresence(userId, presence, lastSeen) {
  const set = contacts.get(userId);
  if (!set) return;
  for (const uid of set) {
    const visible = canViewStatus(userId, uid, settings.byUser.get(userId));
    sendTo(uid, {
      type: 'presence', userId,
      presence: visible ? presence : null,
      lastSeen: visible ? lastSeen : null,
      hidden: !visible,
      ts: now(),
    });
  }
}

/** Эфемерное событие контактам пользователя (обновление профиля/аватара). */
export function broadcastToContacts(userId, event) {
  const set = contacts.get(userId);
  if (!set) return;
  for (const uid of set) {
    const socks = sockets.get(uid);
    if (!socks) continue;
    const user = event.type === 'user.update' ? users.byId.get(userId) : null;
    const outgoing = user
      ? { ...event, payload: { ...event.payload, user: userDTO(user, uid) } }
      : event;
    const data = JSON.stringify(outgoing);
    for (const ws of socks) if (ws.readyState === 1) ws.send(data);
  }
}

export function isOnline(userId) {
  return (sockets.get(userId)?.size || 0) > 0;
}

export function isSessionOnline(userId, sessionId) {
  const set = sockets.get(userId);
  return !!set && [...set].some((ws) => ws.sessionId === sessionId && ws.readyState === 1);
}

export function closeUserSockets(userId) {
  const set = sockets.get(userId);
  if (!set) return;
  for (const ws of set) {
    try { ws.close(4001, 'Credentials changed'); } catch { ws.terminate(); }
  }
}

export function closeSessionSockets(sessionId) {
  for (const set of sockets.values()) {
    for (const ws of set) {
      if (ws.sessionId !== sessionId) continue;
      try { ws.close(4001, 'Session revoked'); } catch { ws.terminate(); }
    }
  }
}

/* ───────────────────────────── WebSocket ───────────────────────────── */

export function attachRealtime(server, isAllowedOrigin = () => false) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      if (url.pathname === '/rtc' || url.pathname === '/rtc/v1') return;
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      recordSecurityEvent({ type: 'ws.origin_rejected', req, subject: `peer:${req.socket.remoteAddress}` });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let token = url.searchParams.get('token');
    if (!token) {
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/(?:^|;\s*)aurora_token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    const payload = verifyToken(token);
    if (!payload) {
      recordSecurityEvent({ type: 'ws.auth_rejected', req, subject: `peer:${req.socket.remoteAddress}`, details: { reason: 'invalid_token' } });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    const user = users.byId.get(payload.sub);
    const session = payload.jti ? sessions.active.get(payload.jti, now()) : null;
    if (!user || user.is_blocked || user.is_frozen
      || user.token_version !== payload.tv || (payload.jti && session?.user_id !== user.id)) {
      recordSecurityEvent({ type: 'ws.auth_rejected', req, subject: `peer:${req.socket.remoteAddress}`, details: { reason: 'invalid_session' } });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const store = getSecurityStore();
    const peer = getRequestIpAssessment(req);
    if (store.isRestricted('account', String(user.id))
      || (payload.jti && store.isRestricted('session', payload.jti))
      || (peer.ipAddress && store.isRestricted('ip', peer.ipAddress))) {
      recordSecurityEvent({ type: 'ws.auth_rejected', req, actorId: user.id, sessionId: payload.jti || null, subject: `user:${user.id}`, details: { reason: 'invalid_session' } });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user, payload.jti || null));
  });

  wss.on('connection', (ws, req, user, sessionId) => {
    ws.userId = user.id;
    ws.sessionId = sessionId;
    ws.isAlive = true;
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    const first = sockets.get(user.id).size === 0;
    sockets.get(user.id).add(ws);

    if (first) {
      users.setPresence.run('online', Date.now(), user.id);
      broadcastPresence(user.id, 'online', Date.now());
    }
    sendTo(user.id, { type: 'hello', userId: user.id, presence: 'online', ts: now() });

    ws.on('pong', () => { ws.isAlive = true; });
    let messageWindowStart = Date.now();
    let messageCount = 0;
    ws.on('message', (raw) => {
      const timestamp = Date.now();
      if (timestamp - messageWindowStart >= 60_000) {
        messageWindowStart = timestamp;
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount === 121) {
        recordSecurityEvent({
          type: 'ws.protocol_anomaly',
          req,
          actorId: user.id,
          sessionId,
          subject: `user:${user.id}`,
          details: { reason: 'rate_limited', count: messageCount },
        });
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        recordSecurityEvent({ type: 'ws.protocol_anomaly', req, actorId: user.id, sessionId, subject: `user:${user.id}`, details: { reason: 'malformed_message' } });
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        recordSecurityEvent({ type: 'ws.protocol_anomaly', req, actorId: user.id, sessionId, subject: `user:${user.id}`, details: { reason: 'malformed_message' } });
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: now() })); return; }
      if (msg.type === 'typing' && Number.isInteger(msg.chatId)) {
        if ((chatMembers.get(msg.chatId) || new Set()).has(user.id)) publishTyping(msg.chatId, user.id, !!msg.isTyping);
      }
    });

    ws.on('close', () => {
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && set.size === 0) {
        sockets.delete(user.id);
        users.setPresence.run('offline', Date.now(), user.id);
        broadcastPresence(user.id, 'offline', Date.now());
      }
    });
    ws.on('error', () => ws.terminate());
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  interval.unref?.();

  // Периодическая очистка журнала событий: держим последние ~2000 записей.
  const prune = setInterval(() => {
    const last = events.lastId.get().id;
    if (last > 2000) events.prune.run(last - 2000);
  }, 5 * 60 * 1000);
  prune.unref?.();

  return wss;
}
