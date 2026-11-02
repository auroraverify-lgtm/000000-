/**
 * Точка входа фронтенда: восстановление сессии, маршрутизация, применение настроек
 * и — главное — обработка real-time событий (единое место синхронизации состояния).
 */
import { Api, api, setToken, getToken, ApiError } from './api.js?v=20261104-payment-email-1';
import * as RT from './realtime.js';
import {
  state, bus, setChats, upsertChat, patchChat, removeChat, chatById, appendMessage,
  updateMessage, removeMessage, setMembers, setMemberCursor, refreshStatuses, setTyping,
  setPresence, setConnection, isMe, setMessages,
} from './store.js';
import { renderLogin, renderRegister, renderForgot } from './views/auth.js?v=20261102-seo-1';
import { renderShell, setNav, setView, syncThemeToggle, refreshMeAvatar } from './views/shell.js?v=20261028-ux-1';
import * as ChatList from './views/chatlist.js?v=20261104-stories-v2-2';
import * as Conversation from './views/conversation.js?v=20261031-channel-comments-1';
import * as Panels from './views/panels.js?v=20261031-channel-counts-1';
import * as Settings from './views/settings.js?v=20261103-settings-2';
import * as Admin from './views/admin.js?v=20261101-receipt-email-1';
import * as Commerce from './views/commerce.js?v=20261104-commerce-v2-2';
import * as SearchView from './views/search.js?v=20261031-channel-counts-1';
import * as Modals from './views/modals.js?v=20261028-ux-1';
import './views/polish-runtime.js?v=20261028-ux-1';
import { notifyMessage, playSent, updateTitle } from './notify.js?v=20261102-gifts-2';
import { toast, toastError, contextMenu } from './ui.js?v=20261029-no-toasts-1';
import { store9, rAFBatch, $, $$ } from './util.js';
import { installPremiumWallpapers, installVerifiedBadgeDialogs } from './premium.js?v=20261031-verified-badge-1';
import * as Calls from './calls.js?v=20261030-call-push-2';
import './chat-manage.js?v=20261030-manage-3';
import './emoji-packs.js?v=20261031-verified-badge-1';
import './profile-themes.js?v=20261031-profile-themes-2';
installPremiumWallpapers();
installVerifiedBadgeDialogs();

/* ───────────────────────── Настройки и тема ───────────────────────────── */

const SYSTEM_DARK = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

export function applySettings(settings, { persist = true } = {}) {
  state.settings = { ...state.settings, ...settings, notify: { ...state.settings.notify, ...(settings?.notify || {}) }, privacy: { ...state.settings.privacy, ...(settings?.privacy || {}) } };
  const s = state.settings;
  const html = document.documentElement;
  const theme = s.theme === 'system' ? (SYSTEM_DARK() ? 'dark' : 'light') : s.theme;
  html.dataset.theme = theme;
  html.dataset.accent = s.accent || 'ocean';
  html.dataset.wallpaper = s.wallpaper || 'aurora';
  html.style.setProperty('--fs', String(s.fontScale || 1));
  html.classList.toggle('no-anim', !s.animations);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#111113' : '#eef0f7');
  window.__auroraSettings = s;
  if (persist) store9.set('aurora.settings', JSON.stringify(s));
  syncThemeToggle();
  bus.emit('settings:applied', s);
}

async function saveSettings(patch, { silent = true } = {}) {
  applySettings(patch);
  try {
    const res = await Api.saveSettings(patch);
    applySettings(res.settings, { persist: true });
  } catch (err) {
    if (!silent) toastError(err);
  }
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (state.settings.theme === 'system') applySettings({});
});

/* ───────────────────────── Загрузка данных ───────────────────────────── */

async function loadChats({ silent = false } = {}) {
  try {
    const res = await Api.chats();
    setChats(res.chats);
    return res.chats;
  } catch (err) {
    if (!silent) toastError(err);
    throw err;
  }
}

async function loadBootstrap() {
  const [chats, limits] = await Promise.all([Api.chats(), Api.mediaLimits().catch(() => null)]);
  setChats(chats.chats);
  state.limits = limits?.limits || null;
}

/* ───────────────────────── Открытие чата ─────────────────────────────── */

export async function openChat(id, opts = {}) {
  const chatId = Number(id);
  navigate(`#/chat/${chatId}`, { replace: false });
  return Conversation.open(chatId, opts);
}

export async function markChatRead(chatId, seq) {
  const chat = chatById(chatId);
  try {
    await Api.markRead(chatId, seq);
    if (chat) patchChat(chatId, { unread: 0, lastReadSeq: Math.max(chat.lastReadSeq || 0, seq) });
    const meMember = state.membersByChat[chatId]?.find((m) => isMe(m.id));
    if (meMember) { meMember.lastReadSeq = Math.max(meMember.lastReadSeq || 0, seq); meMember.lastDeliveredSeq = Math.max(meMember.lastDeliveredSeq || 0, seq); }
  } catch { /* повторим при следующей активности */ }
}

export async function markDelivered(chatId, seq) {
  try { await Api.markDelivered(chatId, seq); } catch { /* noop */ }
}

/* ───────────────────────── Realtime: применение событий ──────────────── */

const normalizeReactions = (list) => (list || []).map((r) => ({ ...r, mine: !!r.users?.some((u) => isMe(u.id)) }));

function previewFromMessage(m) {
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: state.membersByChat[m.chatId]?.find((x) => x.id === m.senderId)?.name
      || (isMe(m.senderId) ? state.user?.name : null),
    fromMe: isMe(m.senderId),
    type: m.type,
    text: m.text || '',
    sticker: m.sticker,
    hasMedia: !!m.media,
    createdAt: m.createdAt,
  };
}

function handleRtEvent(ev) {
  switch (ev.type) {
    case 'message.new': {
      const m = ev.payload?.message;
      if (!m) return;
      const known = !!chatById(m.chatId);
      const activeId = Conversation.currentChatId();
      const isActive = activeId === m.chatId;
      const isActiveTopic = isActive && Conversation.matchesCurrentTopic(m);
      const chat = chatById(m.chatId);
      if (chat) {
        patchChat(m.chatId, {
          lastMessage: previewFromMessage(m),
          lastSeq: Math.max(chat.lastSeq || 0, m.seq),
          unread: isActiveTopic || isMe(m.senderId) ? 0 : (chat.unread || 0) + 1,
          pinned: chat.pinned,
        });
        if (isMe(m.senderId)) playSent();
      } else if (!known) {
        loadChats({ silent: true });
      }
      if (isActiveTopic) {
        appendMessage({ ...m, reactions: normalizeReactions(m.reactions) }, { animate: true });
        if (!isMe(m.senderId)) {
          markDelivered(m.chatId, m.seq);
          const visible = document.visibilityState === 'visible';
          if (visible && Conversation.isAtBottom()) markChatRead(m.chatId, m.seq);
        }
      }
      notifyMessage(m, { isActiveChat: isActiveTopic, windowHidden: document.visibilityState !== 'visible' });
      break;
    }
    case 'message.edit': {
      const m = ev.payload?.message;
      if (!m) return;
      if (state.messageIds.has(m.id)) updateMessage(m.id, { ...m, reactions: normalizeReactions(m.reactions) });
      const chat = chatById(m.chatId);
      if (chat?.lastMessage?.id === m.id) patchChat(m.chatId, { lastMessage: { ...chat.lastMessage, text: m.text } });
      break;
    }
    case 'message.delete': {
      const { id, chatId, forAll } = ev.payload || {};
      if (id) removeMessage(id);
      const chat = chatById(chatId);
      if (chat?.lastMessage?.id === id) {
        const last = state.messages[state.messages.length - 1];
        patchChat(chatId, { lastMessage: last && last.id !== id ? previewFromMessage(last) : null });
      }
      if (forAll && Conversation.currentChatId() === chatId) Conversation.refreshPinned();
      break;
    }
    case 'reaction.update': {
      const { messageId, reactions } = ev.payload || {};
      if (messageId && state.messageIds.has(messageId)) {
        updateMessage(messageId, { reactions: normalizeReactions(reactions) });
        Conversation.animateReaction(messageId, ev.payload?.emoji, ev.payload?.action);
      }
      break;
    }
    case 'comment.new': {
      const payload = ev.payload || {};
      if (payload.messageId && payload.commentsCount !== undefined) {
        const message = state.messages.find((item) => item.id === payload.messageId);
        if (message) updateMessage(payload.messageId, { commentsCount: Math.max(message.commentsCount || 0, payload.commentsCount) });
      }
      bus.emit('comment:new', payload);
      break;
    }
    case 'comment.update':
      bus.emit('comment:update', ev.payload || {});
      break;
    case 'comment.delete': {
      const payload = ev.payload || {};
      if (payload.messageId && payload.commentsCount !== undefined) {
        const message = state.messages.find((item) => item.id === payload.messageId);
        if (message) updateMessage(payload.messageId, { commentsCount: payload.commentsCount });
      }
      bus.emit('comment:delete', payload);
      break;
    }
    case 'comment.like':
      bus.emit('comment:like', ev.payload || {});
      break;
    case 'poll.update': {
      const message = ev.payload?.message;
      if (message && state.messageIds.has(message.id)) updateMessage(message.id, message);
      break;
    }
    case 'read.update': {
      const { chatId, userId, seq } = ev.payload || {};
      setMemberCursor(chatId, userId, seq, 'read');
      refreshStatuses(chatId);
      if (isMe(userId)) patchChat(chatId, { unread: 0 });
      break;
    }
    case 'delivered.update': {
      const { chatId, userId, seq } = ev.payload || {};
      setMemberCursor(chatId, userId, seq, 'delivered');
      refreshStatuses(chatId);
      break;
    }
    case 'typing':
      if (ev.userId !== state.user?.id) setTyping(ev.chatId, ev.userId, ev.isTyping);
      break;
    case 'presence':
      setPresence(ev.userId, ev.presence, ev.hidden ? null : ev.lastSeen ?? ev.ts);
      break;
    case 'chat.new':
      if (ev.payload?.chat) { upsertChat(ev.payload.chat); ChatList.pulse(ev.payload.chat.id); }
      break;
    case 'chat.update':
      if (ev.payload?.chat) {
        patchChat(ev.payload.chat.id, {
          title: ev.payload.chat.title, avatarUrl: ev.payload.chat.avatarUrl,
          bannerUrl: ev.payload.chat.bannerUrl,
          description: ev.payload.chat.description, username: ev.payload.chat.username,
          isPublic: ev.payload.isPublic,
          protectedContent: ev.payload.chat.protectedContent,
          commentsEnabled: ev.payload.chat.commentsEnabled,
          reactionsEnabled: ev.payload.chat.reactionsEnabled,
          allowedReactions: ev.payload.chat.allowedReactions,
          joinApprovalRequired: ev.payload.chat.joinApprovalRequired,
        });
        if (state.chat?.chat.id === ev.payload.chat.id) {
          state.chat = { ...state.chat, chat: { ...state.chat.chat, ...ev.payload.chat } };
        }
        Conversation.onChatUpdated(ev.payload.chat.id);
        Panels.onChatUpdated(ev.payload.chat.id);
      }
      break;
    case 'chat.topic.update':
      if (ev.payload?.chatId) bus.emit('chat:topics-updated', { chatId: ev.payload.chatId, topic: ev.payload.topic });
      break;
    case 'chat.join_request':
      toast(`Новая заявка на вступление в «${ev.payload?.chatId ? chatById(ev.payload.chatId)?.title || 'сообщество' : 'сообщество'}»`, { type: 'info' });
      break;
    case 'chat.join_request.update': {
      const stateLabel = { pending: 'ожидает рассмотрения', approved: 'одобрена', declined: 'отклонена' }[ev.payload?.status];
      if (stateLabel) toast(`Заявка на вступление ${stateLabel}`, { type: ev.payload.status === 'approved' ? 'success' : 'info' });
      break;
    }
    case 'chat.report.new':
      toast('Новая жалоба на публикацию в сообществе', { type: 'info' });
      break;
    case 'chat.report.update':
      toast('Решение по вашей жалобе принято', { type: 'info' });
      break;
    case 'chat.prefs': {
      const { chatId, muted, pinned, archived } = ev.payload || {};
      patchChat(chatId, { muted, pinned, archived });
      Conversation.onChatUpdated(chatId);
      break;
    }
    case 'chat.removed':
      removeChat(ev.payload?.chatId);
      if (Conversation.currentChatId() === ev.payload?.chatId) {
        Conversation.close();
        toast(ev.payload?.deleted ? 'Чат удалён' : 'Вы покинули чат', { type: 'info' });
      }
      break;
    case 'chat.member.add':
    case 'chat.member.join':
    case 'chat.member.remove':
    case 'chat.member.role': {
      const chatId = ev.payload?.chatId || ev.chatId;
      if (!chatId) return;
      if (ev.payload?.memberCount !== undefined) patchChat(chatId, { memberCount: ev.payload.memberCount });
      refreshChatMembers(chatId);
      break;
    }
    case 'user.update': {
      const u = ev.payload?.user;
      if (!u) return;
      for (const chat of state.chats) {
        if (chat.peer?.id === u.id) {
          patchChat(chat.id, { peer: { ...chat.peer, ...u }, title: u.name });
        }
      }
      for (const key of Object.keys(state.membersByChat)) {
        const list = state.membersByChat[key];
        const m = list.find((x) => x.id === u.id);
        if (m) { m.name = u.name; m.username = u.username; m.avatarUrl = u.avatarUrl; m.avatarColor = u.avatarColor; }
      }
      Panels.refreshUserProfile(u.id);
      bus.emit('members:any');
      break;
    }
    case 'message.pin': {
      const { messageId, chatId, pinned } = ev.payload || {};
      if (state.messageIds.has(messageId)) updateMessage(messageId, { pinned });
      Conversation.refreshPinned();
      const chat = chatById(chatId);
      if (chat) patchChat(chatId, { pinnedCount: Math.max(0, (chat.pinnedCount || 0) + (pinned ? 1 : -1)) });
      break;
    }
    case 'message.views': {
      const { messageId, views } = ev.payload || {};
      if (state.messageIds.has(messageId)) updateMessage(messageId, { views });
      break;
    }
    default: break;
  }
}

async function refreshChatMembers(chatId) {
  try {
    const info = await Api.chat(chatId);
    setMembers(chatId, info.members);
    if (state.chat?.chat.id === chatId) {
      state.chat = { ...info };
      Panels.onChatUpdated(chatId, info);
      Conversation.onChatUpdated(chatId);
    }
  } catch { /* чат мог быть удалён */ }
}

/* ───────────────────────── Маршрутизация ─────────────────────────────── */

const isDesktop = () => window.matchMedia('(min-width: 981px)').matches;
let appEventsBound = false;
let globalEventsBound = false;

export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) { handleRoute(); return; }
  if (replace) history.replaceState(null, '', target); else history.pushState(null, '', target);
  handleRoute();
}

async function handleRoute() {
  const hash = location.hash || '#/';
  const [pathPart, queryPart] = hash.slice(1).split('?');
  const params = new URLSearchParams(queryPart || '');
  const parts = pathPart.split('/').filter(Boolean);
  if (!state.ready) return;

  if (params.get('token') && parts[0] === 'reset') {
    renderAuthScreen('reset', params.get('token'));
    return;
  }

  const [section, arg] = parts;
  const verificationOverdue = !state.user.emailVerified
    && state.user.emailVerificationDeadlineAt
    && state.user.emailVerificationDeadlineAt <= Date.now();
  if (verificationOverdue && section !== 'settings') {
    navigate('#/settings', { replace: true });
    return;
  }
  if (section !== 'search') SearchView.hide();
  if (section !== 'settings' && section !== 'commerce') Settings.hide();
  if (section !== 'commerce') Commerce.hide();
  if (section !== 'admin') Admin.hide();
  switch (section) {
    case undefined:
    case '':
    case 'chats':
      setNav('chats'); setView(isDesktop() ? 'chat' : 'list');
      ChatList.show();
      if (!isDesktop()) Conversation.hidePane();
      if (isDesktop() && !Conversation.currentChatId() && state.chats.length) {
        // На компьютере открываем последний активный чат — привычно и быстро
        const first = state.chats.find((c) => c.unread > 0) || state.chats[0];
        if (first) Conversation.open(first.id);
      }
      break;
    case 'chat': {
      setNav('chats'); setView('chat'); ChatList.show();
      if (!Conversation.currentChatId() || Conversation.currentChatId() !== Number(arg)) {
        await Conversation.open(Number(arg));
      }
      break;
    }
    case 'settings':
      setNav('settings'); setView('settings'); Settings.show();
      break;
    case 'commerce':
      setView('settings'); Commerce.show();
      break;
    case 'admin':
      setView('settings'); Admin.show();
      break;
    case 'search':
      setNav('search'); setView('search'); SearchView.show(params.get('q') || '');
      break;
    case 'u':
      Panels.showUserProfile(Number(arg));
      break;
    case 'join':
      try {
        const res = await Api.joinChat(arg);
        if (res.requestPending) {
          toast('Заявка отправлена администраторам на рассмотрение', { type: 'success' });
          navigate('#/chats');
          break;
        }
        toast(`Вы присоединились: ${res.chat.title}`, { type: 'success' });
        navigate(`#/chat/${res.chat.id}`);
      } catch (err) { toastError(err); navigate('#/chats'); }
      break;
    case 'invite':
      try {
        const res = await Api.joinChatInvite(arg);
        if (res.requestPending) {
          toast('Заявка отправлена администраторам на рассмотрение', { type: 'success' });
          navigate('#/chats');
          break;
        }
        toast(`Вы присоединились: ${res.chat.title}`, { type: 'success' });
        navigate(`#/chat/${res.chat.id}`);
      } catch (err) { toastError(err); navigate('#/chats'); }
      break;
    default:
      navigate('#/chats', { replace: true });
  }
}

/* ───────────────────────── Авторизация ───────────────────────────────── */

function renderAuthScreen(mode = 'login', token = null) {
  setNav(null);
  const onDone = (data) => startApp(data);
  if (mode === 'register') renderRegister({ onDone });
  else if (mode === 'forgot') renderForgot({ onDone });
  else if (mode === 'reset') renderForgot({ onDone, token });
  else renderLogin({ onDone });
}

async function logout({ allDevices = false } = {}) {
  try { await (allDevices ? Api.logoutAll() : Api.logout()); } catch { /* выходим локально в любом случае */ }
  store9.remove('aurora.push.enabled');
  RT.disconnect();
  Calls.stop();
  setToken('');
  state.ready = false;
  state.user = null;
  state.chat = null;
  location.hash = '';
  renderAuthScreen('login');
  toast(allDevices ? 'Вы вышли на всех устройствах' : 'Вы вышли из аккаунта', { type: 'info' });
}

export async function startApp({ user, settings, token }) {
  if (state.ready && state.user?.id === user.id) {
    if (token) setToken(token);
    return;
  }
  if (token) setToken(token);
  state.user = user;
  state.ready = true;
  Calls.init();
  applySettings(settings || state.settings);
  renderShell({ onNav: handleNav });

  if (!appEventsBound) {
    appEventsBound = true;
    bus.on('nav:go', (hash) => navigate(hash));
    bus.on('auth:logout', () => logout());
    bus.on('auth:logout-all', () => logout({ allDevices: true }));
    bus.on('settings:change', (patch) => saveSettings(patch));
    bus.on('email:verified', async () => {
      try {
        RT.connect();
        await loadBootstrap();
        navigate('#/chats');
      } catch (err) {
        toastError(err);
      }
    });
    bus.on('message:focus', focusMessage);
    bus.on('unread:total', updateTitle);
  }

  const verificationOverdue = !user.emailVerified && user.emailVerificationDeadlineAt && user.emailVerificationDeadlineAt <= Date.now();
  if (!verificationOverdue) {
    RT.connect();
    try {
      await loadBootstrap();
    } catch (err) {
      toastError(err);
    }
  }
  ChatList.mount();
  Conversation.mount();
  Modals.mount();
  Panels.mount();
  Settings.mountReady();
  Commerce.mountReady();
  handleRoute();
  updateTitle(state.unreadTotal);
}

function handleNav(target) {
  if (target === 'chats') navigate('#/chats');
  if (target === 'search') navigate('#/search');
  if (target === 'settings') navigate('#/settings');
}

/**
 * Переход к конкретному сообщению (из поиска, закреплённых, медиавьюера):
 * при необходимости открывает нужный чат, затем подсвечивает сообщение.
 */
async function focusMessage(messageId) {
  const id = Number(messageId);
  if (!id) return;
  let msg = state.messages.find((m) => m.id === id);
  if (!msg) {
    try {
      const res = await Api.messageInfo(id);
      msg = res.message;
    } catch { return; }
  }
  const chatId = Number(msg?.chatId || msg?.chat_id);
  if (!chatId) return;
  if (Conversation.currentChatId() !== chatId) await openChat(chatId, { focusMessage: id });
  else Conversation.scrollToMessage(id, { highlight: true });
}

/* ───────────────────────── Глобальные обработчики ────────────────────── */

function bindGlobals() {
  if (globalEventsBound) return;
  globalEventsBound = true;
  document.addEventListener('contextmenu', (event) => {
    if (!event.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
      event.preventDefault();
    }
  });
  window.addEventListener('hashchange', () => handleRoute());
  window.addEventListener('popstate', () => handleRoute());
  bus.on('rt', handleRtEvent);
  bus.on('rt:resync', async ({ count }) => {
    if (count) await loadChats({ silent: true });
    Conversation.syncAfterReconnect();
  });
  bus.on('rt:hello', () => setConnection('connected'));
  bus.on('auth:expired', () => { if (state.ready) { toast('Сессия истекла — войдите заново', { type: 'error' }); logout(); } });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate('#/search'); setTimeout(() => $('#search-input')?.focus(), 120); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); Modals.openCreate('dm'); return; }
    if (e.key === 'Escape' && typing) { document.activeElement.blur(); return; }
    if (e.key === 'Escape' && Conversation.currentChatId() && !document.querySelector('.modal-root')) {
      if (Conversation.exitSelectionMode()) return;
      if (isDesktop()) { Conversation.close(); navigate('#/chats', { replace: true }); }
    }
  });

  // Возврат во вкладку: подтянуть свежие данные и выровнять непрочитанные
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.ready) return;
    await loadChats({ silent: true }).catch(() => {});
    Conversation.syncAfterReconnect();
    const id = Conversation.currentChatId();
    if (id) markChatRead(id, state.messages[state.messages.length - 1]?.seq || 0);
  });

  // Онлайн/офлайн
  window.addEventListener('offline', () => { setConnection('offline'); toast('Нет соединения — сообщения отправятся позже', { type: 'error' }); });
  window.addEventListener('online', () => { setConnection('connecting'); toast('Соединение восстановлено', { type: 'success' }); loadChats({ silent: true }).catch(() => {}); });
}

/* ───────────────────────── Старт ─────────────────────────────────────── */

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Aurora service worker registration failed:', error);
    });
  }
  const cached = store9.get('aurora.settings', null);
  if (cached) { try { applySettings(JSON.parse(cached), { persist: false }); } catch { /* игнорируем */ } }

  bindGlobals();

  if (!getToken()) {
    const tokenParam = new URLSearchParams((location.hash.split('?')[1] || '')).get('token');
    if (tokenParam) return renderAuthScreen('reset', tokenParam);
    if (store9.available === false && !getToken()) { /* сессии нет — обычный вход */ }
    return renderAuthScreen('login');
  }

  try {
    const data = await Api.me();
    await startApp(data);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setToken('');
      renderAuthScreen('login');
    } else {
      // Сервер недоступен — показываем честное состояние ошибки с повтором
      document.getElementById('root').innerHTML = `
        <div class="state" style="height:100dvh">
          <div class="state-illustration" style="color:var(--err)">${'⚠'}</div>
          <h3>Нет связи с сервером</h3>
          <p class="muted">Не удалось получить данные сессии. Проверьте соединение и повторите попытку.</p>
          <button class="btn btn-primary" id="boot-retry">Повторить</button>
        </div>`;
      document.getElementById('boot-retry')?.addEventListener('click', () => boot());
    }
  }
}

bus.on('bus:debug', () => {});

boot();

export { saveSettings, logout, loadChats, handleRtEvent };
