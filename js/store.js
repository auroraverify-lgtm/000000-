/**
 * Состояние приложения и шина событий.
 * Одно место правды: view-модули читают state и подписываются на события шины,
 * сетевой слой и realtime только меняют состояние через хелперы ниже.
 */

/* ── Шина ────────────────────────────────────────────────────────────────── */
const listeners = new Map();

export const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => bus.off(event, handler);
  },
  off(event, handler) { listeners.get(event)?.delete(handler); },
  emit(event, payload) {
    const set = listeners.get(event);
    if (set) for (const handler of [...set]) {
      try { handler(payload); } catch (err) { console.error(`[bus:${event}]`, err); }
    }
    const all = listeners.get('*');
    if (all) for (const handler of [...all]) { try { handler(event, payload); } catch { /* noop */ } }
  },
};

/* ── Состояние ───────────────────────────────────────────────────────────── */
export const state = {
  ready: false,
  user: null,
  settings: {
    theme: 'dark', accent: 'ocean', fontScale: 1, animations: true, compact: false, wallpaper: 'aurora',
    notify: { messages: true, groups: true, channels: true, sounds: true, vibration: true, preview: true },
    privacy: { messages: 'everyone', profile: 'everyone', groups: 'everyone', status: 'everyone' },
  },
  chats: [],                      // список чатов (отсортирован сервером)
  chatsLoaded: false,
  chat: null,                     // полная информация об активном чате
  chatLoading: false,
  chatError: null,
  messages: [],                   // сообщения активного чата (по возрастанию seq)
  messageIds: new Set(),
  hasMoreHistory: false,
  historyLoading: false,
  replies: {},                    // id → превью для ответов
  drafts: {},                     // chatId → текст черновика
  replyTo: null,
  editing: null,
  selection: new Set(),
  selectionMode: false,
  typing: {},                     // chatId → Set(userId)
  presence: {},                   // userId → {presence, lastSeen}
  membersByChat: {},              // chatId → [{id, name, ..., lastReadSeq, lastDeliveredSeq, role}]
  panel: null,                    // 'profile' | 'info' | null
  view: 'list',                   // мобильные экраны: list | chat | settings | search | profile
  connection: 'connecting',       // connected | polling | offline
  unreadTotal: 0,
  attachments: [],                // выбранные, но ещё не отправленные файлы (превью в композере)
  scrollTarget: null,             // id сообщения, к которому нужно прокрутить
  focusedMessage: null,
  limits: null,
  serverTimeOffset: 0,
};

/* ── Хелперы чатов ───────────────────────────────────────────────────────── */

export function setChats(list) {
  state.chats = list;
  state.chatsLoaded = true;
  bus.emit('chats', list);
  updateUnreadTotal();
}

export function chatById(id) {
  return state.chats.find((c) => c.id === Number(id)) || null;
}

export function upsertChat(chat, { moveTop = true } = {}) {
  if (!chat) return null;
  const idx = state.chats.findIndex((c) => c.id === chat.id);
  if (idx === -1) {
    state.chats.push(chat);
  } else {
    const merged = { ...state.chats[idx], ...chat };
    state.chats.splice(idx, 1);
    state.chats.push(merged);
    chat = merged;
  }
  sortChats(moveTop);
  bus.emit('chats', state.chats);
  updateUnreadTotal();
  return chat;
}

export function patchChat(id, patch) {
  const chat = chatById(id);
  if (!chat) return null;
  Object.assign(chat, patch);
  sortChats(false);
  bus.emit('chats', state.chats);
  updateUnreadTotal();
  return chat;
}

export function removeChat(id) {
  const idx = state.chats.findIndex((c) => c.id === Number(id));
  if (idx !== -1) state.chats.splice(idx, 1);
  bus.emit('chats', state.chats);
  updateUnreadTotal();
}

export function sortChats(moveTop = true) {
  state.chats.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    const at = a.lastMessage?.createdAt || a.createdAt || 0;
    const bt = b.lastMessage?.createdAt || b.createdAt || 0;
    if (moveTop && bt !== at) return bt - at;
    return bt - at;
  });
}

export function updateUnreadTotal() {
  const total = state.chats.reduce((sum, c) => sum + (c.unread || 0), 0);
  if (total !== state.unreadTotal) {
    state.unreadTotal = total;
    bus.emit('unread:total', total);
  }
}

/* ── Хелперы сообщений ───────────────────────────────────────────────────── */

export function setMessages(list) {
  state.messages = list;
  state.messageIds = new Set(list.map((m) => m.id));
  bus.emit('messages', { type: 'replace' });
}

export function appendMessage(msg, { animate = true } = {}) {
  if (state.messageIds.has(msg.id)) return updateMessage(msg.id, msg);
  const last = state.messages[state.messages.length - 1];
  if (last && msg.seq < last.seq) {
    const idx = state.messages.findIndex((m) => m.seq > msg.seq);
    state.messages.splice(idx === -1 ? state.messages.length : idx, 0, msg);
  } else {
    state.messages.push(msg);
  }
  state.messageIds.add(msg.id);
  bus.emit('messages', { type: 'add', message: msg, animate });
  return msg;
}

export function prependMessages(list) {
  const fresh = list.filter((m) => !state.messageIds.has(m.id));
  if (!fresh.length) return 0;
  state.messages.unshift(...fresh);
  for (const m of fresh) state.messageIds.add(m.id);
  state.messages.sort((a, b) => a.seq - b.seq);
  bus.emit('messages', { type: 'prepend', count: fresh.length });
  return fresh.length;
}

export function updateMessage(id, patch) {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const merged = { ...state.messages[idx], ...patch };
  state.messages[idx] = merged;
  bus.emit('messages', { type: 'update', message: merged });
  return merged;
}

export function removeMessage(id) {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  state.messages.splice(idx, 1);
  state.messageIds.delete(id);
  bus.emit('messages', { type: 'remove', id });
  return true;
}

export function replaceMessageId(tempId, msg) {
  const idx = state.messages.findIndex((m) => m.tempId === tempId || m.id === tempId);
  const duplicateIdx = state.messages.findIndex((m) => m.id === msg.id && m.id !== tempId);
  if (duplicateIdx !== -1) {
    if (idx !== -1 && idx !== duplicateIdx) {
      state.messages.splice(idx, 1);
      state.messageIds.delete(tempId);
    }
    const targetIdx = idx !== -1 && idx < duplicateIdx ? duplicateIdx - 1 : duplicateIdx;
    state.messages[targetIdx] = { ...state.messages[targetIdx], ...msg, pending: false };
    bus.emit('messages', { type: 'update', message: state.messages[targetIdx] });
    return state.messages[targetIdx];
  }
  if (idx === -1) return appendMessage(msg);
  const old = state.messages[idx];
  state.messageIds.delete(old.id);
  state.messages[idx] = msg;
  state.messageIds.add(msg.id);
  bus.emit('messages', { type: 'replace', message: msg, tempId });
  return msg;
}

export function updateMessageByTemp(tempId, patch) {
  const msg = state.messages.find((m) => m.tempId === tempId);
  if (!msg) return null;
  Object.assign(msg, patch);
  bus.emit('messages', { type: 'update', message: msg });
  return msg;
}

/* ── Участники и статусы ─────────────────────────────────────────────────── */

export function setMembers(chatId, members) {
  state.membersByChat[chatId] = members;
  bus.emit('members', { chatId, members });
}

export function members(chatId) {
  return state.membersByChat[chatId] || [];
}

export function memberById(chatId, userId) {
  return members(chatId).find((m) => m.id === userId) || null;
}

export function setMemberCursor(chatId, userId, seq, kind = 'read') {
  const list = state.membersByChat[chatId];
  if (!list) return;
  const m = list.find((x) => x.id === userId);
  if (!m) return;
  if (kind === 'read') m.lastReadSeq = Math.max(m.lastReadSeq || 0, seq);
  else m.lastDeliveredSeq = Math.max(m.lastDeliveredSeq || 0, seq);
  bus.emit('members', { chatId, members: list });
}

/** Статус исходящего сообщения по курсорам остальных участников. */
export function computeStatus(message, chatId = message.chatId) {
  if (!state.user || message.senderId !== state.user.id) return null;
  const others = members(chatId).filter((m) => m.id !== state.user.id);
  if (!others.length) return 'sent';
  if (others.every((m) => (m.lastReadSeq || 0) >= message.seq)) return 'read';
  if (others.every((m) => (m.lastDeliveredSeq || 0) >= message.seq)) return 'delivered';
  return 'sent';
}

/** Пересчёт статусов всех своих сообщений (после read/delivered событий). */
export function refreshStatuses(chatId) {
  if (!state.user) return;
  for (const m of state.messages) {
    if (m.senderId !== state.user.id) continue;
    const status = computeStatus(m, chatId);
    if (status && status !== m.status) {
      m.status = status;
      bus.emit('messages', { type: 'update', message: m, statusOnly: true });
    }
  }
}

/* ── Прочее ──────────────────────────────────────────────────────────────── */

export function setTyping(chatId, userId, isTyping) {
  if (!state.typing[chatId]) state.typing[chatId] = new Set();
  const set = state.typing[chatId];
  const had = set.has(userId);
  if (isTyping) set.add(userId); else set.delete(userId);
  if (had !== isTyping) bus.emit('typing', { chatId, userId, isTyping });
}

export function setPresence(userId, presence, lastSeen) {
  state.presence[userId] = { presence, lastSeen };
  bus.emit('presence', { userId, presence, lastSeen });
}

export function me() { return state.user; }
export const isMe = (id) => state.user && state.user.id === id;

export function myChatIds() { return state.chats.map((c) => c.id); }

export function setConnection(status) {
  if (state.connection === status) return;
  state.connection = status;
  bus.emit('connection', status);
}
