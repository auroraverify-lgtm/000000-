/**
 * Realtime-клиент: WebSocket с автоматическим переподключением и
 * «страховкой» — поллинг журнала событий, когда сокет недоступен (прокси, корпоративная сеть).
 * Благодаря этому синхронизация между устройствами не теряется ни при каких условиях.
 */
import { api, getToken } from './api.js?v=20261102-gifts-2';
import { bus, state, setConnection } from './store.js';

let ws = null;
let userClosed = false;
let attempts = 0;
let reconnectTimer = null;
let pollTimer = null;
let pingTimer = null;
let lastEventId = 0;
let latency = 0;
let connectedAt = 0;
let heartbeatSent = 0;
const seenEventIds = new Set();

function emitEventOnce(data) {
  if (data.eventId) {
    if (seenEventIds.has(data.eventId)) return;
    seenEventIds.add(data.eventId);
    if (seenEventIds.size > 1000) {
      const first = seenEventIds.values().next().value;
      seenEventIds.delete(first);
    }
    lastEventId = Math.max(lastEventId, data.eventId);
  }
  bus.emit('rt', data);
}

const wsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(getToken())}`;
};

export function connect() {
  userClosed = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setConnection(attempts > 2 ? 'polling' : 'connecting');
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    startPolling();
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    attempts = 0;
    connectedAt = Date.now();
    setConnection('connected');
    stopPolling();
    bus.emit('rt:open');
    syncGaps();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        heartbeatSent = Date.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'pong') { latency = Date.now() - heartbeatSent; bus.emit('rt:latency', latency); return; }
    if (data.type === 'hello') {
      if (data.presence) bus.emit('rt', { type: 'presence', userId: data.userId, presence: data.presence, lastSeen: data.ts });
      bus.emit('rt:hello', data);
      return;
    }
    emitEventOnce(data);
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    if (userClosed) return;
    setConnection('polling');
    startPolling();
    scheduleReconnect();
  };

  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 800 * 2 ** Math.min(attempts, 4));
  attempts++;
  reconnectTimer = setTimeout(() => {
    if (!userClosed && (!ws || ws.readyState === WebSocket.CLOSED)) connect();
  }, delay);
}

export function disconnect() {
  userClosed = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  stopPolling();
  try { ws?.close(); } catch { /* noop */ }
  ws = null;
  lastEventId = 0;
}

/** Догнать пропущенные события: журнал хранит последние изменения по чатам пользователя. */
async function syncGaps() {
  if (!getToken()) return;
  if (!lastEventId) {
    try {
      const r = await api.updates(0);
      lastEventId = r.lastId || 0;
      // При первом подключении события не применяем: состояние уже получено через REST.
      bus.emit('rt:resync', { initial: true });
      return;
    } catch { return; }
  }
  try {
    const r = await api.updates(lastEventId);
    if (r.lastId) lastEventId = Math.max(lastEventId, r.lastId);
    if (r.events?.length) {
      for (const ev of r.events) {
        emitEventOnce(ev);
      }
      bus.emit('rt:resync', { count: r.events.length });
    }
  } catch { /* повторим позже */ }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { syncGaps(); }, 3000);
  syncGaps();
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

export function sendTyping(chatId, isTyping) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'typing', chatId, isTyping }));
  } else {
    api.typing(chatId, isTyping).catch(() => {});
  }
}

export const rtStatus = () => ({ connection: state.connection, latency, lastEventId });

/* Реакция на возврат во вкладку и восстановление сети */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      bus.emit('app:visible');
      if (!ws || ws.readyState > WebSocket.OPEN) connect(); else syncGaps();
    }
  });
  window.addEventListener('online', () => connect());
  window.addEventListener('offline', () => setConnection('offline'));
}
