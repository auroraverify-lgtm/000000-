/**
 * Диалог: лента сообщений с пагинацией, композер (текст, файлы, голосовые, эмодзи, стикеры),
 * ответы, правка, удаление, реакции, закрепления, выделение нескольких сообщений.
 * Модуль владеет DOM диалога: изменения в store приходят событиями и точечно патчат узлы.
 */
import {
  $, $$, el, esc, html, raw, formatRichText, debounce, throttle, fmtTime, fmtDayLabel, fmtBytes, fmtDuration, store9,
  fmtLastSeen, plural, tempId, haptic, copyToClipboard, clamp,
} from '../util.js';
import { icons } from '../icons.js';
import { premiumBadgeHTML, PREMIUM_REACTIONS, isPremiumReaction, premiumReactionHTML, premiumReactionLabel } from '../premium.js?v=20261031-verified-badge-1';
import {
  state, bus, chatById, patchChat, appendMessage, prependMessages, updateMessage, removeMessage,
  setMembers, memberById, computeStatus, replaceMessageId, updateMessageByTemp, isMe, me,
} from '../store.js';
import {
  avatarHTML, contextMenu, closeMenu, toast, toastError, confirmDialog, modal, stateScreen, loadingScreen,
  emojiPickerHTML, bindEmojiPicker, stickerUrl, icon,
} from '../ui.js?v=20261029-no-toasts-1';
import { Api, api } from '../api.js?v=20261102-gifts-2';
import { sendTyping, rtStatus } from '../realtime.js';
import * as Calls from '../calls.js?v=20261030-call-push-2';
import {
  compressImage, makeThumb, videoMeta, classifyFile, fileIconName,
  VoiceRecorder, VoicePlayer, waveformHTML,
  mediaDownloadUrl,
} from '../media.js?v=20261028-ux-1';
import { VideoNoteRecorder, isCircleMedia } from './videonote.js';
import * as Modals from './modals.js?v=20261028-ux-1';
import * as Panels from './panels.js?v=20261102-gifts-2';
import { openMediaViewer } from './mediaviewer.js?v=20261028-ux-1';
import { markChatRead, markDelivered, navigate } from '../app.js';

export const conv = {
  host: null,
  chatId: null,
  loading: false,
  sending: false,
  recorder: null,
  recState: null,
  typingSent: false,
  viewed: new Set(),
  replyPreview: null,
  editing: null,
  formatSelectionHandler: null,
  uploadingAttachments: false,
  topics: [],
  topicId: null,
};

const player = () => VoicePlayer.get();
const isDesktop = () => window.matchMedia('(min-width: 981px)').matches;

/* ───────────────────────── Монтирование каркаса ───────────────────────── */

export function mount() {
  if (conv.mounted) return;
  conv.mounted = true;
  conv.host = document.querySelector('[data-conv]');
  renderEmptyPane();
  bindDropZone();
  bus.on('messages', onMessagesEvent);
  bus.on('members', ({ chatId }) => { if (chatId === conv.chatId) renderSubtitle(); });
  bus.on('typing', ({ chatId }) => { if (chatId === conv.chatId) renderSubtitle(); });
  bus.on('presence', () => { renderSubtitle(); renderThreadAvatars(); });
  bus.on('chat:active', ({ chatId }) => { if (chatId) renderEmptyPane(); });
  bus.on('chat:topics-updated', ({ chatId }) => { if (chatId === conv.chatId) refreshTopics(); });
  bus.on('voice:progress', onVoiceProgress);
  bus.on('voice:ended', () => $$('.waveform i.on').forEach((i) => i.classList.remove('on')));
}

function renderEmptyPane() {
  if (conv.chatId) return;
  conv.host.innerHTML = html`<div class="conv-empty">
    <div class="aurora-orb"></div>
    <div class="inner">
      <span style="width:84px;height:84px;border-radius:26px;display:grid;place-items:center;background:var(--surface);border:1px solid var(--border)">${raw(icons.logo)}</span>
      <h2>Выберите чат</h2>
      <p>Слева — ваши диалоги, группы и каналы. Или начните новый разговор: поиск по username, группа или канал.</p>
      <div class="row gap-3">
        <button class="btn btn-primary" data-empty="new">Начать общение</button>
        <button class="btn" data-empty="search">Найти людей</button>
      </div>
    </div>
  </div>`;
  conv.host.querySelector('[data-empty="new"]')?.addEventListener('click', () => Modals.openCreate('dm'));
  conv.host.querySelector('[data-empty="search"]')?.addEventListener('click', () => navigate('#/search'));
}

export function close() {
  conv.chatId = null;
  state.chat = null;
  state.chatError = null;
  setSelectionMode(false);
  renderEmptyPane();
  bus.emit('chat:active', { chatId: null });
}

export function hidePane() {
  if (!isDesktop()) { /* на мобильном диалог скрыт через data-view */ }
}

export const currentChatId = () => conv.chatId;
export const matchesCurrentTopic = (message) => {
  if (state.chat?.chat.id !== conv.chatId) return false;
  return state.chat.chat.type !== 'group'
    || (message.topicId != null && Number(message.topicId) === Number(conv.topicId));
};
export const isVisible = () => !!conv.chatId && document.body.contains(conv.host);

/* ───────────────────────── Открытие чата ──────────────────────────────── */

export async function open(chatId, { focusMessage = null, highlight = false } = {}) {
  chatId = Number(chatId);
  if (!chatId) return close();
  const sameChat = conv.chatId === chatId;
  conv.chatId = chatId;
  bus.emit('chat:active', { chatId });

  if (!sameChat) {
    conv.viewed = new Set();
    conv.topicId = null;
    conv.topics = [];
    setSelectionMode(false);
    state.replies = {};
    renderSkeleton();
  }

  try {
    const info = await Api.chat(chatId);
    if (conv.chatId !== chatId) return;
    conv.topics = info.chat.type === 'group' ? (await Api.chatTopics(chatId)).topics : [];
    if (info.chat.type === 'group') {
      if (!conv.topics.some((topic) => topic.id === conv.topicId)) {
        conv.topicId = conv.topics.find((topic) => topic.isDefault)?.id || null;
      }
    } else {
      conv.topicId = null;
    }
    const page = await Api.messages(chatId, { topicId: conv.topicId });
    if (conv.chatId !== chatId) return; // пользователь успел переключиться
    state.chat = info;
    setMembers(chatId, info.members);
    for (const m of info.members) if (m.id === state.user.id) { /* мой курсор */ }
    state.messages = [];
    state.messageIds = new Set();
    prependMessages(page.messages);
    state.replies = { ...page.replies };
    state.hasMoreHistory = page.hasMore;
    state.chatLoading = false;
    render();
    renderTopicBar();

    const lastSeq = state.messages[state.messages.length - 1]?.seq || 0;
    markChatRead(chatId, lastSeq);
    markDelivered(chatId, lastSeq);

    requestAnimationFrame(() => {
      if (focusMessage) scrollToMessage(focusMessage, { highlight: true });
      else if (!sameChat) scrollToBottom(false);
    });
    if (info.chat.type === 'channel') markVisibleAsViewed();
    Panels.onChatOpened(chatId);
  } catch (err) {
    if (conv.chatId !== chatId) return;
    state.chatLoading = false;
    state.chatError = err;
    renderError(err);
  }
}

/** Дозагрузка пропущенных сообщений после переподключения. */
export async function syncAfterReconnect() {
  const chatId = conv.chatId;
  if (!chatId) return;
  const lastSeq = state.messages[state.messages.length - 1]?.seq || 0;
  try {
    const res = await Api.messagesAfter(chatId, lastSeq, conv.topicId);
    if (conv.chatId !== chatId || !res.messages.length) return;
    const wasBottom = isAtBottom();
    for (const m of res.messages) appendMessage(m, { animate: false });
    if (wasBottom) scrollToBottom(true);
    markDelivered(chatId, res.messages[res.messages.length - 1].seq);
  } catch { /* повторим при следующем входе */ }
}

export async function refreshPinned() {
  if (!conv.chatId) return;
  try {
    const info = await Api.chat(conv.chatId);
    state.chat = info;
    renderPinnedBar();
  } catch { /* noop */ }
}

export function onChatUpdated(chatId) {
  if (chatId !== conv.chatId || !state.chat) return;
  const messages = $('[data-messages]');
  const scrollTop = messages?.scrollTop;
  renderHeader();
  renderMessages();
  if (messages) messages.scrollTop = scrollTop;
}

/* ───────────────────────── Скелетон и ошибки ─────────────────────────── */

function renderSkeleton() {
  conv.host.innerHTML = html`<div class="conv-skel" style="display:flex;flex-direction:column;height:100%">
    <div class="conv-head">
      <div class="row gap-3 grow" style="padding:8px 10px">
        <div class="skeleton" style="width:44px;height:44px;border-radius:50%"></div>
        <div class="col gap-2" style="width:180px">
          <div class="skeleton" style="height:12px;width:60%"></div>
          <div class="skeleton" style="height:10px;width:40%"></div>
        </div>
      </div>
    </div>
    <div style="flex:1;display:grid;place-items:center">${raw(loadingScreen('Загружаем историю…'))}</div>
  </div>`;
}

function renderError(err) {
  conv.host.innerHTML = html`<div style="height:100%;display:grid;place-items:center">
    ${raw(stateScreen({
    icon: 'alert',
    tone: 'error',
    title: err?.status === 403 ? 'Нет доступа к чату' : 'Не удалось открыть чат',
    text: err?.message || 'Проверьте соединение и попробуйте снова.',
    actions: [{ id: 'retry', label: 'Повторить', kind: 'primary' }, { id: 'back', label: 'К списку', kind: 'ghost' }],
  }))}
  </div>`;
  conv.host.querySelector('[data-action="retry"]')?.addEventListener('click', () => open(conv.chatId));
  conv.host.querySelector('[data-action="back"]')?.addEventListener('click', () => navigate('#/chats'));
}

/* ───────────────────────── Основной рендер ───────────────────────────── */

function render() {
  const info = state.chat;
  if (!info) return;
  const { chat } = info;
  conv.host.innerHTML = html`
    <div class="wallpaper"><div class="wallpaper-img"></div></div>

    <header class="conv-head" data-head></header>
    <div class="pinned-slot" data-pinned></div>
    <div class="topic-bar" data-topic-bar hidden></div>

    <div class="thread">
      <div class="thread-scroll scroll-y" data-scroll>
        <div class="thread-inner" data-thread>
          <div class="thread-top" data-thread-top>
            ${state.hasMoreHistory ? html`<button class="btn btn-sm" data-load-more>Загрузить ещё</button>` : html`<span class="chip">Начало переписки</span>`}
          </div>
          <div data-messages></div>
          <div class="typing-slot" data-typing></div>
        </div>
      </div>
      <button class="scroll-down hidden" data-scroll-down aria-label="Вниз">
        ${raw(icons.arrowDown)}<span class="badge hidden" data-scroll-badge>0</span>
      </button>
    </div>

    <div class="composer-wrap" data-composer-wrap></div>
    <div class="selection-slot" data-selection></div>
    <div class="drop-overlay hidden" data-drop>
      <div class="inner">
        <span style="width:56px;height:56px;color:var(--accent-soft)">${raw(icons.paperclip)}</span>
        <b>Отпустите файл — и он отправится в чат</b>
        <span class="muted small">Фото, видео, документы · до 200 МБ</span>
      </div>
    </div>`;

  renderHeader();
  renderTopicBar();
  renderMessages();
  renderPinnedBar();
  renderComposer();
  bindThreadEvents();
  renderSelectionBar();
  renderTyping();
}

function renderTopicBar() {
  const host = $('[data-topic-bar]');
  if (!host) return;
  const isGroup = state.chat?.chat.type === 'group';
  host.hidden = !isGroup;
  if (!isGroup) return;
  const topics = conv.topics;
  host.innerHTML = html`
    <label class="sr-only" for="active-topic">Тема группы</label>
    <select id="active-topic" class="input topic-select">
      ${raw(topics.map((topic) => html`<option value="${topic.id}" ${topic.id === conv.topicId ? 'selected' : ''}>
        ${topic.title}${topic.isClosed ? ' · закрыта' : ''}
      </option>`).join(''))}
    </select>
    ${state.chat.permissions?.canEditInfo ? html`<button class="btn btn-sm" type="button" data-manage-topics>Темы</button>` : ''}
  `;
  host.querySelector('select')?.addEventListener('change', () => {
    conv.topicId = Number(host.querySelector('select').value);
    open(conv.chatId);
  });
  host.querySelector('[data-manage-topics]')?.addEventListener('click', () => Panels.openTopicManager(conv.chatId));
}

async function refreshTopics() {
  if (!conv.chatId || state.chat?.chat.type !== 'group') return;
  try {
    const { topics } = await Api.chatTopics(conv.chatId);
    if (conv.chatId !== state.chat.chat.id) return;
    conv.topics = topics;
    if (!topics.some((topic) => topic.id === conv.topicId)) {
      conv.topicId = topics.find((topic) => topic.isDefault)?.id || null;
      open(conv.chatId);
      return;
    }
    renderTopicBar();
  } catch (error) {
    toastError(error);
  }
}

function renderHeader() {
  const host = $('[data-head]');
  if (!host || !state.chat) return;
  const { chat, role, permissions } = state.chat;
  const peer = chat.peer;
  const isSupportBot = chat.type === 'dm' && peer?.username === 'aurora_support' && peer?.isBot;
  const members = state.membersByChat[chat.id] || [];
  const title = chat.title || peer?.name || 'Чат';
  const avatar = chat.type === 'dm'
    ? avatarHTML({ name: title, avatarUrl: peer?.avatarUrl, color: peer?.avatarColor, size: 'md', presence: presenceOf(peer?.id) === 'online' ? 'online' : null })
    : avatarHTML({ name: title, avatarUrl: chat.avatarUrl, color: chat.type === 'channel' ? 'ocean' : 'indigo', rounded: true, size: 'md' });

  host.innerHTML = html`
    ${!isDesktop() ? html`<button class="icon-btn" data-back aria-label="К списку чатов">${raw(icons.back)}</button>` : ''}
    <div class="peer ${isSupportBot ? 'bot-peer' : ''}" ${isSupportBot ? '' : 'data-open-panel role="button" tabindex="0"'}>
      ${raw(avatar)}
      <div class="col grow" style="min-width:0">
        <span class="title truncate">${isSupportBot ? raw(`${esc(title)}<span class="bot-badge">ОФИЦИАЛЬНЫЙ</span>`) : raw(`${esc(title)}${premiumBadgeHTML(peer)}`)}</span>
        <span class="sub truncate" data-subtitle></span>
      </div>
    </div>
    <div class="conv-actions">
      ${chat.type !== 'channel' && !isSupportBot ? html`
        <button class="icon-btn" data-call-mode="audio" data-tip="Аудиозвонок" aria-label="Начать аудиозвонок">${raw(icons.mic)}</button>
        <button class="icon-btn" data-call-mode="video" data-tip="Видеозвонок" aria-label="Начать видеозвонок">${raw(icons.video)}</button>
        <button class="icon-btn" data-call-history data-tip="История звонков" aria-label="История звонков">${raw(icons.clock)}</button>
      ` : ''}
      <button class="icon-btn" data-search-in-chat data-tip="Поиск в чате" aria-label="Поиск в чате">${raw(icons.search)}</button>
      <button class="icon-btn" data-pinned-list data-tip="Закреплённые" aria-label="Закреплённые сообщения">${raw(icons.pin)}</button>
      ${chat.type === 'dm' && peer?.username === 'aurora_support' ? html`<button class="icon-btn" data-support-request data-tip="Позвать специалиста" aria-label="Позвать специалиста">${raw(icons.alert)}</button>` : ''}
      <button class="icon-btn" data-toggle-panel data-tip="${chat.type === 'dm' ? 'Профиль' : 'Информация'}" aria-label="Информация">${raw(icons.info)}</button>
      <button class="icon-btn" data-chat-menu aria-label="Ещё">${raw(icons.more)}</button>
    </div>`;

  $('[data-back]', host)?.addEventListener('click', () => { navigate('#/chats'); if (!isDesktop()) { document.querySelector('.app').dataset.view = 'list'; } });
  $$('[data-call-mode]', host).forEach((button) => button.addEventListener('click', () => {
    Calls.startCall(chat.id, button.dataset.callMode);
  }));
  $('[data-call-history]', host)?.addEventListener('click', () => Calls.openHistory(chat.id));
  $('[data-open-panel]', host)?.addEventListener('click', () => togglePanel());
  $('[data-toggle-panel]', host).addEventListener('click', () => togglePanel());
  $('[data-chat-menu]', host).addEventListener('click', (e) => openChatMenu(e.currentTarget, role, permissions));
  $('[data-pinned-list]', host).addEventListener('click', scrollToFirstPinned);
  $('[data-support-request]', host)?.addEventListener('click', async () => {
    try { await Api.requestSupport(chat.id); toast('Запрос специалиста отправлен', { type: 'success' }); }
    catch (err) { toastError(err); }
  });
  $('[data-search-in-chat]', host).addEventListener('click', () => openInChatSearch());
  renderSubtitle();
}

function presenceOf(userId) {
  return state.presence[userId]?.presence || state.chats.find((c) => c.peer?.id === userId)?.peer?.presence;
}

function renderSubtitle() {
  const node = $('[data-subtitle]');
  if (!node || !state.chat) return;
  const { chat } = state.chat;
  const typing = [...(state.typing[chat.id] || [])].filter((id) => !isMe(id));
  if (typing.length) {
    const names = typing.map((id) => memberById(chat.id, id)?.name || 'Кто-то').slice(0, 3);
    node.className = 'sub typing';
    node.innerHTML = `${esc(names.join(', '))} ${raw('<span class="typing-dots"><i></i><i></i><i></i></span>')}`;
    return;
  }
  if (chat.type === 'dm') {
    const peer = chat.peer;
    if (peer?.isBot && peer?.username === 'aurora_support') {
      node.className = 'sub bot-subtitle';
      node.textContent = 'официальный помощник Aurora';
      return;
    }
    const presence = presenceOf(peer?.id) || 'offline';
    node.className = `sub ${presence === 'online' ? 'online' : ''}`;
    node.textContent = presence === 'online' ? 'в сети' : fmtLastSeen(state.presence[peer?.id]?.lastSeen ?? peer?.lastSeen, 'offline');
    return;
  }
  const count = state.chat.members?.length || chat.memberCount || 0;
  node.className = 'sub';
  node.textContent = chat.type === 'channel'
    ? `${count} ${plural(count, 'подписчик', 'подписчика', 'подписчиков')}${chat.username ? ` · @${chat.username}` : ''}`
    : `${count} ${plural(count, 'участник', 'участника', 'участников')}${onlineCount(chat.id) ? ` · ${onlineCount(chat.id)} в сети` : ''}`;
}

/**
 * Индикатор «печатает…» в ленте: живёт отдельной строкой под последним сообщением.
 * Состояние приходит из store (setTyping) и обновляется точечно, без перерисовки списка.
 */
function renderTyping() {
  if (!conv.chatId) return;
  const thread = $('[data-thread]');
  if (!thread) return;
  const typing = [...(state.typing[conv.chatId] || [])].filter((id) => !isMe(id));
  const row = $('[data-typing-row]', thread);
  if (!typing.length) { row?.remove(); return; }
  const first = memberById(conv.chatId, typing[0]);
  const names = typing.map((id) => memberById(conv.chatId, id)?.name || 'Кто-то').slice(0, 3);
  const isDm = state.chat?.chat.type === 'dm';
  const label = isDm ? 'печатает…' : `${names.join(', ')} ${typing.length === 1 ? 'печатает' : 'печатают'}…`;
  const markup = html`${typing.length === 1 && !isDm
    ? avatarHTML({ name: first?.name, avatarUrl: first?.avatarUrl, color: first?.avatarColor, size: 'xs' })
    : ''}<span class="typing-row"><span class="typing-dots"><i></i><i></i><i></i></span><span>${label}</span></span>`;
  let node = row;
  if (!node) {
    node = el('div', { class: 'typing-row-holder', 'data-typing-row': '' });
    thread.appendChild(node);
  }
  node.innerHTML = markup;
  scrollToBottomIfNeeded();
}

/**
 * Точечно обновляет аватары в уже отрисованной ленте: смена фото профиля или
 * присутствия не должна требовать полной перерисовки истории.
 */
function renderThreadAvatars() {
  if (!conv.chatId) return;
  const thread = $('[data-thread]');
  if (!thread) return;
  for (const m of state.messages) {
    if (isMe(m.senderId)) continue;
    const node = $(`[data-msg-id="${m.id}"]`, thread);
    const col = node ? $('.av-col', node) : null;
    if (!col || !col.childElementCount) continue;
    const sender = memberById(m.chatId, m.senderId);
    const signature = `${sender?.avatarUrl || ''}|${sender?.name || ''}|${sender?.avatarColor || ''}`;
    if (col.dataset.avSig === signature) continue;
    col.dataset.avSig = signature;
    col.innerHTML = avatarHTML({ name: sender?.name || 'Удалён', avatarUrl: sender?.avatarUrl, color: sender?.avatarColor, size: 'xs' });
  }
}

function onlineCount(chatId) {
  return (state.membersByChat[chatId] || []).filter((m) => !isMe(m.id) && presenceOf(m.id) === 'online').length;
}

/* ───────────────────────── Лента сообщений ───────────────────────────── */

function renderMessages({ animate = false } = {}) {
  const host = $('[data-messages]');
  if (!host) return;
  const list = state.messages;
  if (!list.length) {
    host.innerHTML = html`<div class="state" style="padding-top:40px">
      <div class="state-illustration">${raw(state.chat?.chat.type === 'channel' ? icons.megaphone : icons.chats)}</div>
      <h3>${state.chat?.chat.type === 'channel' ? 'Пока нет публикаций' : 'Начните переписку'}</h3>
      <p class="muted">${state.chat?.chat.type === 'channel' ? 'Опубликуйте первое сообщение — подписчики увидят его сразу.' : 'Отправьте первое сообщение: текст, фото, видео, файл или голосовое.'}</p>
    </div>`;
    return;
  }
  const grouped = groupMessages(list);
  host.innerHTML = grouped.map((entry, i) => (entry.separator
    ? html`<div class="day-sep" data-day="${entry.day}"><span>${entry.day}</span></div>`
    : messageHTML(entry.message, { index: i, animate, grouped: entry.grouped }))).join('');
  markVisibleAsViewed();
}

const groupMessages = (list) => {
  const out = [];
  let lastDay = null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { out.push({ separator: true, day: fmtDayLabel(m.createdAt) }); lastDay = day; }
    const prev = list[i - 1];
    const grouped = !!prev && !prev.deletedForAll && prev.senderId === m.senderId
      && prev.type !== 'sticker' && m.type !== 'sticker'
      && m.createdAt - prev.createdAt < 5 * 60 * 1000
      && !m.replyTo && !m.forward
      && new Date(prev.createdAt).toDateString() === day
      && Date.now() - m.createdAt > 1500; // только «историчные» сообщения группируем
    out.push({ message: m, grouped });
  }
  return out;
};

function messageHTML(m, { animate = false, grouped = false, index = 0 } = {}) {
  const own = isMe(m.senderId);
  const info = state.chat || {};
  const members = state.membersByChat[m.chatId] || [];
  const sender = members.find((x) => x.id === m.senderId);
  const status = computeStatus(m, m.chatId);
  const showAvatar = !own && !grouped;
  const isChannelChat = state.chat?.chat.type === 'channel';
  const channelChat = isChannelChat ? state.chat.chat : null;
  const canReact = !isChannelChat || channelChat.reactionsEnabled !== false;
  const canComment = !isChannelChat || channelChat.commentsEnabled !== false;
  const animStyle = animate ? '' : 'animation:none';
  const delay = index > 40 ? '' : `animation-delay:${Math.min(index * 14, 160)}ms`;

  return html`<div class="msg ${own ? 'own' : ''} ${m.type === 'gift' && m.gift ? 'gift-message-row' : ''} ${grouped ? 'grouped' : ''} ${state.selection.has(m.id) ? 'selected' : ''}"
      data-msg-id="${m.id}" data-seq="${m.seq}" style="${delay};${animStyle}">
    <button class="msg-pick" data-pick="${m.id}" aria-label="Выбрать сообщение">${raw(icons.check)}</button>
    <div class="av-col">${showAvatar ? avatarHTML({ name: sender?.name || 'Удалён', avatarUrl: sender?.avatarUrl, color: sender?.avatarColor, size: 'xs' }) : ''}</div>
    <div class="msg-stack">
      ${showAvatar && info.chat?.type !== 'dm' ? html`      <span class="sender-name"><button data-open-user="${m.senderId}">${sender?.name || 'Удалённый аккаунт'}${raw(premiumBadgeHTML(sender))}</button></span>` : ''}
      <div class="bubble ${m.media ? 'has-media' : ''} ${m.type === 'sticker' ? 'sticker-bubble' : ''} ${m.deletedForAll ? 'deleted' : ''}"
           data-bubble="${m.id}" ${own ? '' : 'data-incoming="1"'}>
        ${m.forward ? forwardLabel(m) : ''}
        ${m.replyTo ? renderQuote(m) : ''}
        ${m.deletedForAll ? 'Сообщение удалено' : ''}
        ${m.deletedForAll ? '' : mediaHTML(m)}
        ${m.type === 'sticker' && !m.deletedForAll ? html`<img class="att-sticker" src="${stickerUrl(m.sticker)}" alt="Стикер" width="112" height="112">` : ''}
        ${m.type === 'poll' && m.poll ? pollHTML(m) : ''}
        ${m.type === 'gift' && m.gift ? giftHTML(m) : ''}
        ${!m.deletedForAll && (m.type === 'text' || m.text) && m.type !== 'sticker'
    ? html`<span class="bubble-text">${raw(formatRichText(m.text, new Set((state.membersByChat[conv.chatId] || []).map((member) => String(member.username || '').toLowerCase()))))}</span>` : ''}
        ${m.editedAt ? html`<span class="msg-meta"><span class="edited">изменено</span>${metaTail(m, own, status)}</span>` : html`<span class="msg-meta">${metaTail(m, own, status)}</span>`}
      </div>
      ${m.reactions?.length || (isChannelChat && canReact && !m.deletedForAll && !m.pending) ? html`<div class="reactions" data-reactions="${m.id}">${raw((m.reactions || []).map((r) => reactionHTML(m, r)).join(''))}${isChannelChat && canReact && !m.deletedForAll && !m.pending ? raw(`<button class="reaction-add" data-react-add="${m.id}" aria-label="Поставить реакцию">${icons.smile}</button>`) : ''}</div>` : ''}
      ${isChannelChat && !m.deletedForAll && !m.pending ? html`<div class="post-foot">
        ${canComment ? html`
        <button class="post-comments" data-comments="${m.id}">${raw(icons.chats)}<span>${m.commentsCount ? 'Комментарии' : 'Оставить комментарий'}</span>${m.commentsCount ? html`<span class="cnt">${m.commentsCount}</span>` : ''}</button>
        ` : ''}
        ${m.views ? html`<span class="post-views">${raw(icons.eye)}${m.views}</span>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

function giftHTML(m) {
  const g = m.gift;
  const viewed = store9.get(`aurora.gift.viewed.${state.user?.id}.${m.id}`) === '1';
  return html`<button class="gift-message rarity-${esc(g.rarity || 'обычный')}" data-open-gift="${m.id}">
    <span class="gift-message-kicker">ПОДАРОК</span>
    ${g.imageUrl ? html`<img class="gift-message-image ${viewed ? 'gift-viewed' : ''}" src="${esc(g.imageUrl)}" alt="${esc(g.name)}" loading="lazy" decoding="async">` : ''}
    <span class="gift-message-from">${esc(g.senderName || g.senderUsername || 'Aurora')} отправил(а) вам подарок</span>
    <strong>${esc(g.name)}</strong>
    <span class="gift-rarity">${esc(g.rarity || 'обычный')}</span>
    <span class="btn btn-sm">Открыть подарок</span>
  </button>`;
}

const reactionHTML = (m, r) => html`<button class="reaction ${r.mine ? 'mine' : ''} ${isPremiumReaction(r.emoji) ? 'prem' : ''}" data-react="${m.id}" data-emoji="${r.emoji}"
  title="${(r.users || []).map((u) => u.name).join(', ')}"><span class="emo">${raw(premiumReactionHTML(r.emoji))}</span><span class="cnt">${r.count}</span></button>`;

function metaTail(m, own, status) {
  const time = html`<span>${fmtTime(m.createdAt)}</span>`;
  if (!own) return time;
  const map = { sending: 'clock', sent: 'check', delivered: 'doubleCheck', read: 'doubleCheck', failed: 'alert' };
  const cls = status === 'read' ? 'read' : status || 'sent';
  const title = { sending: 'Отправляется', sent: 'Отправлено', delivered: 'Доставлено', read: 'Прочитано', failed: 'Ошибка отправки' }[cls];
  if (cls === 'failed') {
    return html`<button class="ticks failed" data-retry="${m.tempId || ''}" title="Не отправлено — нажмите, чтобы повторить">${raw(icons.alert)}</button>${time}`;
  }
  return html`<span class="ticks ${cls}" title="${title}" style="${cls === 'read' ? 'color:#8ce0ff' : ''}">${raw(icons[map[cls] || 'check'])}</span>${time}`;
}

function forwardLabel(m) {
  const chat = chatById(m.forward.chatId);
  const members = state.membersByChat[m.chatId] || [];
  const from = members.find((x) => x.id === m.forward.userId);
  const source = chat?.title || (from ? from.name : 'другого чата');
  return html`<div class="fwd-label">${raw(icons.forward)} Пересланное из «${source}»</div>`;
}

function renderQuote(m) {
  const reply = state.replies[m.replyTo];
  if (!reply) return html`<div class="quote" data-jump="${m.replyTo}"><span class="txt">Сообщение скрыто</span></div>`;
  const own = isMe(m.senderId);
  const author = isMe(reply.senderId) ? 'Вы' : esc(reply.senderName || 'Сообщение');
  return html`<div class="quote" data-jump="${m.replyTo}" role="button">
    <span class="who">${raw(author)}</span>
    <span class="txt">${raw(quotePreview(reply))}</span>
  </div>`;
}

function quotePreview(reply) {
  if (!reply) return 'Сообщение удалено';
  const byType = {
    photo: `📷 ${reply.text || 'Фото'}`, video: `🎬 ${reply.text || 'Видео'}`,
    voice: '🎤 Голосовое сообщение', file: '📎 Файл', sticker: '✨ Стикер',
  };
  const body = byType[reply.type] || String(reply.preview || '').slice(0, 120);
  return esc(body.replace(/\n/g, ' '));
}

/** Медиа внутри пузыря: фото (зум по клику), видео (инлайн-плеер), файл, голосовое. */
function pollHTML(m) {
  const poll = m.poll;
  return html`<div class="poll" data-poll="${m.id}">
    <strong class="poll-question">${esc(poll.question)}</strong>
    <div class="poll-options">${poll.options.map((option) => html`
      <button class="poll-option ${option.selected ? 'selected' : ''}" data-poll-option="${option.id}" data-poll-message="${m.id}">
        <span class="poll-radio">${option.selected ? '✓' : ''}</span>
        <span class="poll-option-text">${esc(option.text)}</span>
        <span class="poll-votes">${option.votes || 0}</span>
      </button>`).join('')}</div>
    <span class="poll-hint">${poll.allowMultiple ? 'Можно выбрать несколько вариантов' : 'Один вариант'}</span>
  </div>`;
}

function mediaHTML(m) {
  const media = m.media;
  if (!media) return '';
  const mediaItems = m.mediaItems?.length > 1 ? m.mediaItems : [media];
  if (mediaItems.length > 1) {
    return html`<div class="att-album n${Math.min(mediaItems.length, 4)}" data-album="${m.id}">
      ${raw(mediaItems.map((item, index) => item.kind === 'video'
        ? `<div class="att-video" data-video="${m.id}" data-media-index="${index}"><video src="${esc(item.url)}" poster="${esc(item.thumbUrl || '')}" muted playsinline preload="metadata"></video><span class="play-badge" aria-hidden="true"><span class="circle">${raw(icons.play)}</span></span></div>`
        : `<div class="att-photo" data-photo="${m.id}" data-media-index="${index}" role="button" tabindex="0"><img src="${esc(item.thumbUrl || item.url)}" alt="${esc(item.filename || 'Фото')}" loading="lazy"></div>`).join(''))}
    </div>`;
  }

  if (m.type === 'voice') {
    return html`<div class="voice" data-voice="${m.id}">
      <button class="voice-play" data-voice-toggle="${m.id}" data-url="${esc(media.url)}" aria-label="Воспроизвести">${raw(icons.play)}</button>
      <div class="voice-body">
        <div class="waveform" data-waveform="${m.id}" title="Перемотка">${raw(waveformHTML(media.peaks, m.id))}</div>
        <div class="row-between">
          <span class="voice-time" data-voice-time="${m.id}">${fmtDuration(media.duration || 0)}</span>
          <button class="voice-rate" data-voice-rate title="Скорость">1×</button>
        </div>
      </div>
    </div>`;
  }
  if (m.type === 'photo') {
    return html`<div class="att-photo" data-photo="${m.id}" data-media-index="0" data-media-id="${media.id}" role="button" tabindex="0">
      <img src="${esc(media.thumbUrl || media.url)}" alt="${esc(media.filename || 'Фото')}" loading="lazy" decoding="async"
           width="${media.width || ''}" height="${media.height || ''}"
           onerror="this.src='${esc(media.url)}'">
    </div>`;
  }
  if (m.type === 'video' && isCircleMedia(media)) {
    return html`<div class="att-video round" data-circle="${m.id}" role="button" tabindex="0" aria-label="Воспроизвести видеокружок">
      <video src="${esc(media.url)}" poster="${esc(media.thumbUrl || '')}" preload="metadata" playsinline loop></video>
      <span class="vn-badge">${fmtDuration(media.duration || 0)}</span>
      <span class="vn-play">${raw(icons.play)}</span>
    </div>`;
  }
  if (m.type === 'video') {
    return html`<div class="att-video" data-video="${m.id}" data-media-index="0" role="button" tabindex="0" aria-label="Открыть видео">
      <video src="${esc(media.url)}" poster="${esc(media.thumbUrl || '')}" preload="metadata" muted playsinline style="max-height:420px"></video>
      <span class="play-badge" aria-hidden="true"><span class="circle">${raw(icons.play)}</span></span>
    </div>`;
  }
  return html`<div class="att-file" data-file="${m.id}">
    <span class="ic">${raw(icons[fileIconName(media.mime, media.filename)])}</span>
    <div class="col grow" style="min-width:0">
      <span class="fn truncate">${media.filename}</span>
      <span class="fs">${media.mime === 'application/vnd.android.package-archive' ? 'Android-приложение · ' : ''}${fmtBytes(media.size)}${media.duration ? ` · ${fmtDuration(media.duration)}` : ''}</span>
    </div>
    ${state.chat?.chat?.protectedContent ? '' : html`<a class="icon-btn" href="${esc(mediaDownloadUrl(media.url))}" download="${esc(media.filename)}" title="Скачать" aria-label="Скачать">${raw(icons.download)}</a>`}
  </div>`;
}

/* ───────────────────────── События ленты ─────────────────────────────── */

function onMessagesEvent(ev) {
  if (!conv.chatId) return;
  const host = $('[data-messages]');
  if (!host) return;
  if (ev.type === 'replace' && ev.message?.chatId === conv.chatId) { /* смена чата — полный рендер сделан в open() */ }

  if (ev.type === 'add' && ev.message.chatId === conv.chatId && matchesCurrentTopic(ev.message)) {
    const wasBottom = isAtBottom(180);
    appendMessageNode(ev.message, { animate: ev.animate });
    if (wasBottom) requestAnimationFrame(() => scrollToBottom(true));
    renderEmptyIfNeeded();
    return;
  }
  if (ev.type === 'update' && ev.message.chatId === conv.chatId) {
    patchMessageNode(ev.message, { statusOnly: ev.statusOnly });
    return;
  }
  if (ev.type === 'remove') {
    const node = host.querySelector(`[data-msg-id="${ev.id}"]`);
    if (node) {
      node.style.transition = 'opacity .18s, transform .18s';
      node.style.opacity = '0';
      node.style.transform = 'scale(.97)';
      setTimeout(() => { node.remove(); renderEmptyIfNeeded(); }, 180);
    }
    return;
  }
  if (ev.type === 'prepend') { renderMessages(); return; }
  if (ev.type === 'replace') {
    const node = host.querySelector(`[data-msg-id="${ev.tempId}"], [data-msg-id="${ev.message.id}"]`);
    if (node) node.outerHTML = messageHTML(ev.message, { grouped: node.classList.contains('grouped') });
  }
}

function appendMessageNode(m, { animate = true } = {}) {
  const host = $('[data-messages]');
  if (!host || !m) return;
  const prev = host.lastElementChild?.querySelector?.('.msg');
  const prevMsg = prev ? state.messages.find((x) => x.id === Number(prev.dataset.msgId)) : null;
  const grouped = !!prevMsg && prevMsg.senderId === m.senderId && m.createdAt - prevMsg.createdAt < 5 * 60 * 1000 && !m.replyTo && !m.forward;
  const day = new Date(m.createdAt).toDateString();
  const dayNodes = host.querySelectorAll('.day-sep');
  const lastDayNode = dayNodes[dayNodes.length - 1];
  if (!lastDayNode || lastDayNode.dataset.day !== day) {
    host.insertAdjacentHTML('beforeend', html`<div class="day-sep" data-day="${day}"><span>${fmtDayLabel(m.createdAt)}</span></div>`);
  }
  const htmlString = messageHTML(m, { animate, grouped });
  host.insertAdjacentHTML('beforeend', htmlString);
  const node = host.lastElementChild;
  if (animate) node.querySelector('.bubble')?.classList.add('new');
  if (m.type === 'voice') bindVoiceNode(node);
  markVisibleAsViewed();
}

function patchMessageNode(m, { statusOnly = false } = {}) {
  const host = $('[data-messages]');
  const node = host?.querySelector(`[data-msg-id="${m.id}"]`);
  if (!node) return;
  if (statusOnly) {
    const meta = node.querySelector('.msg-meta');
    const own = isMe(m.senderId);
    if (meta) meta.innerHTML = `${m.editedAt ? '<span class="edited">изменено</span>' : ''}${metaTail(m, own, computeStatus(m, m.chatId))}`;
    return;
  }
  const grouped = node.classList.contains('grouped');
  const wasSelected = state.selection.has(m.id);
  node.outerHTML = messageHTML(m, { grouped, animate: false });
  const fresh = host.querySelector(`[data-msg-id="${m.id}"]`);
  if (fresh) {
    fresh.classList.toggle('selected', wasSelected);
    if (m.type === 'voice') bindVoiceNode(fresh);
  }
}

function renderEmptyIfNeeded() {
  const host = $('[data-messages]');
  if (host && !state.messages.length) renderMessages();
}

/* ───────────────────────── Скролл ────────────────────────────────────── */

export function isAtBottom(threshold = 120) {
  const scroller = $('[data-scroll]');
  if (!scroller) return true;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold;
}

export function scrollToBottom(smooth = true) {
  const scroller = $('[data-scroll]');
  if (!scroller) return;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  const badge = $('[data-scroll-badge]');
  if (badge) badge.classList.add('hidden');
}

export function scrollToMessage(id, { highlight = true } = {}) {
  const host = $('[data-messages]');
  const node = host?.querySelector(`[data-msg-id="${id}"]`);
  if (!node) {
    // Сообщение за пределами загруженной истории — подгружаем контекст
    loadContext(id).then(() => {
      const later = host?.querySelector(`[data-msg-id="${id}"]`);
      later?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (highlight) flash(later);
    });
    return;
  }
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (highlight) flash(node);
}

function flash(node) {
  if (!node) return;
  const bubble = node.querySelector('.bubble');
  bubble?.classList.add('flash');
  setTimeout(() => bubble?.classList.remove('flash'), 1700);
}

async function loadContext(messageId) {
  try {
    const res = await api.get(`/api/messages/${messageId}/context`);
    state.messages = [];
    state.messageIds = new Set();
    prependMessages(res.messages);
    renderMessages();
  } catch (err) { toastError(err); }
}

async function loadOlder() {
  if (state.historyLoading || !state.hasMoreHistory || !conv.chatId) return;
  state.historyLoading = true;
  const scroller = $('[data-scroll]');
  const before = state.messages[0]?.seq;
  const prevHeight = scroller?.scrollHeight || 0;
  try {
    const page = await Api.messages(conv.chatId, { before });
    state.hasMoreHistory = page.hasMore;
    const added = prependMessages(page.messages);
    state.replies = { ...state.replies, ...page.replies };
    if (added) {
      renderMessages();
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight - prevHeight;
      });
    }
    const top = $('[data-thread-top]');
    if (top) top.innerHTML = state.hasMoreHistory ? '<button class="btn btn-sm" data-load-more>Загрузить ещё</button>' : '<span class="chip">Начало переписки</span>';
  } catch (err) { toastError(err); } finally {
    state.historyLoading = false;
  }
}

function bindThreadEvents() {
  const scroller = $('[data-scroll]');
  const thread = $('[data-thread]');
  if (!scroller) return;

  scroller.addEventListener('scroll', throttle(() => {
    const btn = $('[data-scroll-down]');
    const atBottom = isAtBottom(200);
    btn?.classList.toggle('hidden', atBottom);
    if (scroller.scrollTop < 220) loadOlder();
    if (atBottom && conv.chatId) {
      const lastSeq = state.messages[state.messages.length - 1]?.seq || 0;
      markChatRead(conv.chatId, lastSeq);
    }
    if (!atBottom && conv.chatId) {
      const lastSeq = state.messages[state.messages.length - 1]?.seq || 0;
      markDelivered(conv.chatId, lastSeq);
    }
  }, 140), { passive: true });

  $('[data-scroll-down]')?.addEventListener('click', () => scrollToBottom(true));
  $('[data-load-more]')?.addEventListener('click', loadOlder);

  thread.addEventListener('click', (e) => handleThreadClick(e));
  thread.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const circle = e.target.closest('[data-circle][role="button"]');
    if (circle) {
      e.preventDefault();
      toggleCirclePlayback(circle);
      return;
    }
    const media = e.target.closest('[data-photo], [data-video]');
    if (!media) return;
    e.preventDefault();
    openMediaViewer(Number(media.dataset.photo || media.dataset.video), Number(media.dataset.mediaIndex) || 0);
  });
  thread.addEventListener('contextmenu', (e) => {
    const msgNode = e.target.closest('[data-msg-id]');
    if (!msgNode) return;
    e.preventDefault();
    openMessageMenu(Number(msgNode.dataset.msgId), e.clientX, e.clientY);
  });
  // долгое нажатие — контекстное меню сообщения
  let press = null;
  let swipe = null;
  thread.addEventListener('pointerdown', (e) => {
    const msgNode = e.target.closest('[data-msg-id]');
    if (!msgNode || e.pointerType === 'mouse') return;
    swipe = { node: msgNode, x: e.clientX, y: e.clientY, active: false };
    press = setTimeout(() => { haptic(14); openMessageMenu(Number(msgNode.dataset.msgId), e.clientX, e.clientY); }, 460);
  });
  thread.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerType === 'mouse') return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    clearTimeout(press);
    if (Math.abs(dx) > Math.abs(dy) && dx > 0) {
      swipe.active = true;
      swipe.node.style.transform = `translateX(${Math.min(dx, 78)}px)`;
      swipe.node.style.transition = 'none';
    }
  });
  thread.addEventListener('pointerup', (e) => {
    clearTimeout(press);
    if (swipe?.active) {
      const dx = e.clientX - swipe.x;
      swipe.node.style.transition = 'transform .18s ease';
      swipe.node.style.transform = '';
      if (dx >= 56) startReply(Number(swipe.node.dataset.msgId));
    }
    swipe = null;
  });
  thread.addEventListener('pointercancel', () => { clearTimeout(press); if (swipe?.node) swipe.node.style.transform = ''; swipe = null; });
  thread.addEventListener('dblclick', (e) => {
    const msgNode = e.target.closest('[data-msg-id]');
    if (msgNode) startReply(Number(msgNode.dataset.msgId));
  });

  $$('.waveform', thread).forEach(bindWaveform);
  $$('.voice-play', thread).forEach(bindVoiceButton);
}

function handleThreadClick(e) {
  const target = e.target;
  const pick = target.closest('[data-pick]');
  if (pick) { toggleSelect(Number(pick.dataset.pick)); return; }

  const circle = target.closest('[data-circle]');
  if (circle) {
    e.preventDefault();
    e.stopPropagation();
    toggleCirclePlayback(circle);
    return;
  }

  const photo = target.closest('[data-photo]');
  const video = target.closest('[data-video]');
  const media = photo || video;
  if (media) {
    openMediaViewer(Number(media.dataset.photo || media.dataset.video), Number(media.dataset.mediaIndex) || 0);
    return;
  }

  const comments = target.closest('[data-comments]');
  if (comments) { openComments(Number(comments.dataset.comments)); return; }
  const reactAdd = target.closest('[data-react-add]');
  if (reactAdd) { openMessageMenu(Number(reactAdd.dataset.reactAdd), null, null, reactAdd); return; }
  const react = target.closest('[data-react]');
  if (react) { toggleReaction(Number(react.dataset.react), react.dataset.emoji); return; }

  const pollOption = target.closest('[data-poll-option]');
  if (pollOption) { votePoll(Number(pollOption.dataset.pollMessage), pollOption.dataset.pollOption); return; }

  const jump = target.closest('[data-jump]');
  if (jump) { scrollToMessage(Number(jump.dataset.jump)); return; }

  const voice = target.closest('[data-voice-toggle]');
  if (voice) { toggleVoice(Number(voice.dataset.voiceToggle), voice.dataset.url); return; }

  const rate = target.closest('[data-voice-rate]');
  if (rate) { const r = player().cycleRate(); rate.textContent = `${r}×`; return; }

  const userBtn = target.closest('[data-open-user]');
  if (userBtn) { Panels.showUserProfile(Number(userBtn.dataset.openUser)); return; }
  const gift = target.closest('[data-open-gift]');
  if (gift) {
    const message = state.messages.find((item) => item.id === Number(gift.dataset.openGift));
    if (message?.gift) {
      const g = message.gift;
      const viewKey = `aurora.gift.viewed.${state.user?.id}.${message.id}`;
      const viewed = store9.get(viewKey) === '1';
      const body = el('div', { class: 'gift-opening' },
      g.imageUrl
        ? el('img', { class: `gift-opening-art gift-opening-image gift-${g.animation} ${viewed ? 'gift-viewed' : ''}`, src: g.imageUrl, alt: g.name })
        : null,
        el('div', { class: 'eyebrow' }, 'ПОДАРОК AURORA'),
        el('h2', {}, g.name),
        el('p', { class: 'muted' }, `От: @${g.senderUsername}`),
        el('strong', {}, `✦ ${Number(g.price).toLocaleString('ru-RU')} Аврор`),
        g.note ? el('p', { class: 'gift-note' }, g.note) : null);
      store9.set(viewKey, '1');
      modal({ title: '', body, footer: [] });
    }

    return;
  }

  const file = target.closest('[data-file]');
  if (file && !target.closest('a')) { window.open(file.querySelector('a')?.href, '_blank'); return; }

  const retry = target.closest('[data-retry]');
  if (retry) { resendMessage(retry.dataset.retry); return; }

  const msgNode = target.closest('[data-msg-id]');
  if (msgNode && state.selectionMode) { toggleSelect(Number(msgNode.dataset.msgId)); return; }
  if (msgNode && !state.selectionMode) {
    const bubble = target.closest('.bubble');
    if (bubble && !target.closest('a,button,video,audio')) openMessageMenu(Number(msgNode.dataset.msgId));
  }

}

function toggleCirclePlayback(container) {
  const video = container.querySelector('video');
  if (!video) return;
  if (video.paused) {
    video.muted = false;
    video.play()
      .then(() => container.classList.add('playing'))
      .catch((err) => toastError(err));
  } else {
    video.pause();
    container.classList.remove('playing');
  }
}

async function votePoll(messageId, optionId) {
  try {
    const res = await Api.votePoll(messageId, [optionId]);
    updateMessage(messageId, res.message);
  } catch (err) { toastError(err); }
}

/* ───────────────────────── Комментарии к постам канала ───────────────── */

let commentsScreen = null;

function closeCommentsScreen() {
  if (!commentsScreen) return;
  const { node, cleanup } = commentsScreen;
  commentsScreen = null;
  cleanup();
  node.classList.add('closing');
  setTimeout(() => node.remove(), 220);
}

const commentBubbleHTML = (comment, parent = null) => {
  const authorId = comment.author?.id ?? comment.userId ?? comment.senderId;
  const own = isMe(authorId);
  const name = comment.author?.name || 'Пользователь';
  const canModerate = !!state.chat?.permissions?.canModerate;
  const deleted = !!comment.deleted;
  return html`<div class="cs-msg ${own ? 'own' : ''} ${comment.parentId ? 'reply' : ''} ${deleted ? 'deleted' : ''}" data-comment="${comment.id}">
    ${own ? '' : avatarHTML({ name, avatarUrl: comment.author?.avatarUrl, color: comment.author?.avatarColor, size: 'xs' })}
    <div class="cs-bubble">
      ${own ? '' : html`<div class="cs-who">${name}</div>`}
      ${parent ? html`<div class="cs-reply-ref">${esc(parent.author?.name || 'Пользователь')}: ${esc(parent.deleted ? 'Комментарий удалён' : parent.text.slice(0, 100))}</div>` : ''}
      <span class="cs-text">${deleted ? 'Комментарий удалён' : raw(formatRichText(comment.text))}</span>
      <span class="cs-time">${fmtTime(comment.createdAt)}${comment.editedAt ? ' · изменено' : ''}</span>
      ${!deleted ? html`<div class="cs-actions">
        <button type="button" class="cs-action ${comment.likedByMe ? 'active' : ''}" data-comment-like="${comment.id}" aria-label="Нравится" aria-pressed="${comment.likedByMe ? 'true' : 'false'}">♥ ${comment.likesCount || ''}</button>
        ${!comment.parentId ? html`<button type="button" class="cs-action" data-comment-reply="${comment.id}">Ответить</button>` : ''}
        ${own ? html`<button type="button" class="cs-action" data-comment-edit="${comment.id}">Изменить</button>` : ''}
        ${own || canModerate ? html`<button type="button" class="cs-action danger" data-comment-delete="${comment.id}">Удалить</button>` : ''}
      </div>` : ''}
    </div>
  </div>`;
};

export async function openComments(messageId) {
  const post = state.messages.find((message) => message.id === messageId);
  if (!post) return;
  closeCommentsScreen();

  const postLabel = post.text || (post.type === 'photo' ? '📷 Фото' : post.type === 'video' ? '🎬 Видео' : 'Публикация');
  const count = el('span', { class: 'cs-count' }, 'Загрузка…');
  const list = el('div', { class: 'cs-list' });
  const scroll = el('div', { class: 'cs-scroll' },
    el('div', { class: 'cs-post' },
      el('div', { class: 'cs-post-label' }, `${state.chat?.chat.title || 'Канал'} · публикация`),
      el('div', { class: 'cs-post-text' }, postLabel.length > 320 ? `${postLabel.slice(0, 320)}…` : postLabel)),
    list);
  const input = el('textarea', { class: 'cs-input', rows: 1, maxlength: 1000, placeholder: 'Комментарий…', 'aria-label': 'Комментарий' });
  const send = el('button', { class: 'cs-send', type: 'button', 'aria-label': 'Отправить', disabled: true, html: icons.send });
  const composerMode = el('div', { class: 'cs-composer-mode', hidden: true });
  const composerModeText = el('span', { class: 'cs-composer-mode-text' });
  const cancelMode = el('button', { class: 'cs-action', type: 'button' }, 'Отмена');
  composerMode.append(composerModeText, cancelMode);
  const back = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Назад', html: icons.back, onClick: closeCommentsScreen });
  const head = el('header', { class: 'cs-head' }, back, el('div', { class: 'cs-title' }, el('strong', {}, 'Комментарии'), count));
  const composer = el('div', { class: 'cs-composer' }, composerMode, input, send);
  const screen = el('div', { class: 'comments-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Комментарии' },
    el('div', { class: 'cs-backdrop', onClick: closeCommentsScreen }),
    el('div', { class: 'cs-sheet' }, head, scroll, composer));
  document.getElementById('overlays').append(screen);

  const viewport = window.visualViewport;
  const fit = () => {
    if (!viewport || window.innerWidth > 980) return;
    screen.style.height = `${viewport.height}px`;
    screen.style.transform = `translateY(${viewport.offsetTop}px)`;
  };
  viewport?.addEventListener('resize', fit);
  viewport?.addEventListener('scroll', fit);
  fit();
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeCommentsScreen(); }
  };
  document.addEventListener('keydown', onKey, true);

  let items = [];
  let totalCount = post.commentsCount || 0;
  let replyParentId = null;
  let editingCommentId = null;
  const setComposerMode = ({ reply = null, edit = null } = {}) => {
    replyParentId = reply?.id || null;
    editingCommentId = edit?.id || null;
    composerMode.hidden = !reply && !edit;
    composerModeText.textContent = edit
      ? 'Редактирование комментария'
      : reply ? `Ответ ${reply.author?.name || 'пользователю'}: ${reply.text.slice(0, 100)}` : '';
    input.value = edit?.text || '';
    input.placeholder = edit ? 'Измените комментарий…' : 'Комментарий…';
    autosize();
    input.focus({ preventScroll: true });
  };
  const toBottom = (smooth = false) => scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  const paint = () => {
    count.textContent = totalCount
      ? `${totalCount} ${plural(totalCount, 'комментарий', 'комментария', 'комментариев')}`
      : 'Пока нет комментариев';
    list.innerHTML = items.length
      ? items.map((comment) => commentBubbleHTML(
        comment,
        comment.parentId ? items.find((item) => item.id === comment.parentId) : null,
      ).value).join('')
      : '<div class="cs-empty"><div class="cs-empty-ic">💬</div><b>Комментариев пока нет</b><span>Напишите первым</span></div>';
  };
  const addComment = (comment, commentsCount = 0, { scrollToNew = true } = {}) => {
    const added = !!comment && !items.some((item) => item.id === comment.id);
    if (added) items.push(comment);
    totalCount = Number(commentsCount) || 0;
    paint();
    if (added && scrollToNew) toBottom(true);
    updateMessage(messageId, { commentsCount: totalCount });
    return added;
  };
  const updateComment = (comment) => {
    const index = items.findIndex((item) => item.id === comment?.id);
    if (index < 0) return;
    items[index] = comment;
    paint();
  };
  const deleteComment = (commentId, commentsCount) => {
    const comment = items.find((item) => item.id === commentId);
    if (comment) items[items.indexOf(comment)] = { ...comment, text: '', deleted: true, likedByMe: false, likesCount: 0 };
    totalCount = Number(commentsCount) || 0;
    updateMessage(messageId, { commentsCount: totalCount });
    paint();
  };
  const updateLike = (commentId, likedByMe, likesCount) => {
    const comment = items.find((item) => item.id === commentId);
    if (!comment) return;
    comment.likedByMe = !!likedByMe;
    comment.likesCount = Number(likesCount) || 0;
    paint();
  };
  const unsubscribe = bus.on('comment:new', (payload) => {
    if (Number(payload?.messageId) !== messageId) return;
    addComment(payload.comment, payload.commentsCount);
  });
  const unsubscribeUpdate = bus.on('comment:update', (payload) => {
    if (Number(payload?.messageId) === messageId) updateComment(payload.comment);
  });
  const unsubscribeDelete = bus.on('comment:delete', (payload) => {
    if (Number(payload?.messageId) === messageId) deleteComment(Number(payload.commentId), payload.commentsCount);
  });
  const unsubscribeLike = bus.on('comment:like', (payload) => {
    if (Number(payload?.messageId) === messageId) {
      updateLike(Number(payload.commentId), payload.likedByMe && isMe(payload.userId), payload.likesCount);
    }
  });
  commentsScreen = {
    node: screen,
    cleanup: () => {
      unsubscribe();
      unsubscribeUpdate();
      unsubscribeDelete();
      unsubscribeLike();
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
      document.removeEventListener('keydown', onKey, true);
    },
  };

  list.innerHTML = '<div class="cs-empty"><span>Загрузка…</span></div>';
  try {
    const result = await Api.messageComments(messageId);
    if (commentsScreen?.node !== screen) return;
    const liveComments = items;
    items = result.comments || [];
    for (const comment of liveComments) {
      if (!items.some((item) => item.id === comment.id)) items.push(comment);
    }
    totalCount = Number(result.commentsCount) || 0;
    paint();
    updateMessage(messageId, { commentsCount: totalCount });
    toBottom();
  } catch (error) {
    if (commentsScreen?.node === screen) list.innerHTML = '';
    toastError(error);
  }

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    send.disabled = !input.value.trim();
  };
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = Number(button.dataset.commentLike || button.dataset.commentReply
      || button.dataset.commentEdit || button.dataset.commentDelete);
    if (!id) return;
    const comment = items.find((item) => item.id === id);
    if (!comment) return;
    if (button.dataset.commentReply) {
      setComposerMode({ reply: comment });
      return;
    }
    if (button.dataset.commentEdit) {
      setComposerMode({ edit: comment });
      return;
    }
    button.disabled = true;
    try {
      if (button.dataset.commentDelete) {
        const ok = await confirmDialog({
          title: 'Удалить комментарий?',
          text: 'Комментарий будет скрыт у всех участников, ответы на него сохранятся.',
          confirmLabel: 'Удалить',
          danger: true,
        });
        if (!ok) return;
        const result = await Api.deleteComment(messageId, id);
        deleteComment(id, result.commentsCount);
      } else {
        const result = await Api.likeComment(messageId, id);
        updateLike(id, result.likedByMe, result.likesCount);
      }
    } catch (error) {
      toastError(error);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  cancelMode.addEventListener('click', () => {
    setComposerMode();
    input.value = '';
    autosize();
  });
  input.addEventListener('input', autosize);
  const submit = async () => {
    const text = input.value.trim();
    if (!text || send.disabled || send.dataset.busy) return;
    send.dataset.busy = '1';
    send.disabled = true;
    try {
      const result = editingCommentId
        ? await Api.editComment(messageId, editingCommentId, text)
        : await Api.sendComment(messageId, text, replyParentId);
      if (commentsScreen?.node !== screen) return;
      if (editingCommentId) {
        updateComment(result.comment);
        setComposerMode();
      } else {
        addComment(result.comment, result.commentsCount);
        input.value = '';
        replyParentId = null;
        composerMode.hidden = true;
        composerModeText.textContent = '';
      }
      autosize();
      input.focus({ preventScroll: true });
    } catch (error) {
      toastError(error);
    } finally {
      delete send.dataset.busy;
      if (commentsScreen?.node === screen) autosize();
    }
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && window.innerWidth > 980) {
      event.preventDefault();
      submit();
    }
  });
}

/* ───────────────────────── Реакции ───────────────────────────────────── */

const hasMyReaction = (message, emoji) => {
  const ownReactions = (message.reactions || []).filter((reaction) =>
    reaction.mine || (reaction.users || []).some((user) => isMe(user.id)));
  return ownReactions.length
    ? ownReactions.some((reaction) => reaction.emoji === emoji)
    : message.myReaction === emoji;
};

export async function toggleReaction(messageId, emoji) {
  if (isPremiumReaction(emoji) && !state.user?.isPremium) {
    toast('Премиум-реакции доступны с Premium', { type: 'info', action: { label: 'Открыть', onClick: () => navigate('#/commerce') } });
    return;
  }
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const before = { reactions: msg.reactions, myReaction: msg.myReaction };
  const mine = hasMyReaction(msg, emoji);
  const optimistic = (msg.reactions || []).map((r) => ({ ...r, users: [...(r.users || [])] }));
  const target = optimistic.find((r) => r.emoji === emoji);
  if (mine) {
    if (target) { target.count--; target.mine = false; target.users = target.users.filter((u) => !isMe(u.id)); }
  } else {
    if (target) { target.count++; target.mine = true; target.users.push({ id: state.user.id, name: state.user.name }); }
    else optimistic.push({ emoji, count: 1, mine: true, users: [{ id: state.user.id, name: state.user.name }] });
  }
  updateMessage(messageId, { reactions: optimistic.filter((r) => r.count > 0), myReaction: mine ? null : emoji });
  animateReaction(messageId, emoji, mine ? 'removed' : 'added');
  try {
    const res = await Api.react(messageId, emoji);
    const myReaction = res.myReaction === undefined ? (mine ? null : emoji) : res.myReaction;
    const reactions = (res.reactions || []).map((reaction) => ({
      ...reaction,
      mine: reaction.emoji === myReaction || !!reaction.mine || (reaction.users || []).some((user) => isMe(user.id)),
    }));
    updateMessage(messageId, { reactions, myReaction });
  } catch (err) {
    toastError(err);
    updateMessage(messageId, before);
  }
}

/** Пульсация «таблетки» реакции — заметная, но ненавязчивая анимация. */
export function animateReaction(messageId, emoji, action) {
  if (action !== 'added') return;
  const node = $(`[data-reactions="${messageId}"] [data-emoji="${emoji}"]`);
  if (!node) return;
  node.classList.remove('burst');
  void node.offsetWidth;
  node.classList.add('burst');
}

/* ───────────────────────── Голосовые ─────────────────────────────────── */

function bindVoiceNode(node) {
  $$('.waveform', node).forEach(bindWaveform);
  $$('.voice-play', node).forEach(bindVoiceButton);
}

function bindWaveform(wave) {
  wave.addEventListener('click', (e) => {
    const rect = wave.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const bars = [...wave.children];
    const idx = Math.round(ratio * (bars.length - 1));
    const id = Number(wave.dataset.waveform);
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return;
    if (player().currentId !== id) toggleVoice(id, msg.media?.url).then(() => player().seek(idx / bars.length));
    else player().seek(idx / bars.length);
  });
}

function bindVoiceButton(button) {
  const id = Number(button.dataset.voiceToggle);
  button.addEventListener('click', (e) => { e.stopPropagation(); toggleVoice(id, button.dataset.url); });
}

async function toggleVoice(id, url) {
  const snap = await player().toggle(id, url);
  updateVoiceUI(snap);
  if (snap.playing) {
    const msg = state.messages.find((m) => m.id === id);
    if (msg) {
      // для голосовых считаем «прослушано» при первом запуске (аналог «прочитано»)
      if (!conv.viewed.has(`voice-${id}`)) { conv.viewed.add(`voice-${id}`); Api.viewMessage(id).catch(() => {}); }
    }
  }
}

function onVoiceProgress(snap) {
  if (!snap?.id) return;
  updateVoiceUI(snap);
}

function updateVoiceUI(snap) {
  $$('.voice-play').forEach((btn) => {
    const isCurrent = Number(btn.dataset.voiceToggle) === snap.id;
    if (isCurrent) btn.innerHTML = snap.playing ? icons.pause : icons.play;
  });
  const wave = $(`[data-waveform="${snap.id}"]`);
  const time = $(`[data-voice-time="${snap.id}"]`);
  const msg = state.messages.find((m) => m.id === snap.id);
  const total = snap.duration || msg?.media?.duration || 0;
  if (wave) {
    const bars = [...wave.children];
    const ratio = total ? clamp(snap.current / total, 0, 1) : 0;
    const upto = Math.round(ratio * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle('on', i < upto));
  }
  if (time) time.textContent = `${fmtDuration(snap.current)} / ${fmtDuration(total)}`;
}

/* ───────────────────────── Отправка сообщений ────────────────────────── */

function composerNode() { return $('[data-composer]'); }
function inputNode() { return $('[data-input]'); }

export function renderComposer() {
  const host = $('[data-composer-wrap]');
  if (!host) return;
  const info = state.chat;
  const canPost = info?.permissions?.canPost !== false;
  const draft = state.drafts[conv.chatId] || '';

  host.innerHTML = html`
    ${state.chat?.chat?.peer?.isBot ? html`<div class="bot-actions" data-bot-actions>
      <span class="bot-actions-label">Помощь Aurora</span>
      <button class="chip" data-support-category="security">Безопасность</button>
      <button class="chip" data-support-category="login">Не могу войти</button>
      <button class="chip" data-support-category="report">Пожаловаться</button>
      <button class="chip" data-support-category="idea">Предложить идею</button>
    </div>` : ''}
    <div data-reply-slot></div>
    ${canPost ? html`<div class="composer-format-tools" data-format-tools aria-label="Форматирование выделенного текста" hidden>
      <button type="button" class="composer-format-btn" data-format="bold" title="Жирный" aria-label="Жирный текст"><strong>B</strong></button>
      <button type="button" class="composer-format-btn" data-format="italic" title="Курсив" aria-label="Курсив"><em>I</em></button>
      <button type="button" class="composer-format-btn" data-format="quote" title="Цитата" aria-label="Цитата">&gt;</button>
      <button type="button" class="composer-format-btn" data-format="link" title="Вставить ссылку" aria-label="Вставить ссылку">${raw(icons.link)}</button>
    </div>` : ''}
    <div class="composer" data-composer>
      <div class="composer-side">
        <button class="icon-btn" data-emoji-btn data-tip="Эмодзи и стикеры" aria-label="Эмодзи и стикеры">${raw(icons.smile)}</button>
        ${canPost ? html`<button class="icon-btn hide-sm" data-poll-btn data-tip="Создать опрос" aria-label="Создать опрос">?</button>` : ''}
        <button class="icon-btn hide-sm" data-attach-btn data-tip="Прикрепить файл" aria-label="Прикрепить файл">${raw(icons.paperclip)}</button>
      </div>
      <div class="composer-input-wrap">
        <div class="pk-input-overlay" aria-hidden="true"></div>
        <textarea class="composer-input" data-input rows="1" placeholder="${canPost ? 'Сообщение…' : 'В этом канале публикуют только администраторы'}"
          ${canPost ? '' : 'disabled'} aria-label="Текст сообщения">${esc(draft)}</textarea>
      </div>
      <div class="composer-side">
        ${canPost ? html`<button class="mic-btn" data-mic data-tip="Голос · удерживайте. Нажмите — кружок" aria-label="Голосовое сообщение">${raw(micIconHTML())}</button>` : ''}
        <button class="send-btn" data-send aria-label="Отправить" disabled>${raw(icons.send)}</button>
      </div>
      <input type="file" hidden multiple data-file-input accept="image/*,video/*,audio/*,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json,.apk">
    </div>`;

  const input = inputNode();
  const send = $('[data-send]', host);
  const formatTools = $('[data-format-tools]', host);
  let touchFormatPointer = false;
  if (conv.formatSelectionHandler) document.removeEventListener('selectionchange', conv.formatSelectionHandler);
  const updateFormatTools = () => {
    const hasSelection = document.activeElement === input && input.selectionStart !== input.selectionEnd;
    if (formatTools) formatTools.hidden = !hasSelection;
  };
  conv.formatSelectionHandler = updateFormatTools;
  document.addEventListener('selectionchange', updateFormatTools);
  input.addEventListener('select', updateFormatTools);
  input.addEventListener('keyup', updateFormatTools);
  input.addEventListener('mouseup', updateFormatTools);
  input.addEventListener('blur', () => { if (formatTools && !touchFormatPointer) formatTools.hidden = true; });
  $('[data-format-tools]', host)?.addEventListener('mousedown', (event) => {
    if (!touchFormatPointer && event.target.closest('button')) event.preventDefault();
  });
  $('[data-format-tools]', host)?.addEventListener('pointerdown', (event) => {
    touchFormatPointer = event.pointerType === 'touch';
  });
  $('[data-format-tools]', host)?.addEventListener('pointerup', () => { touchFormatPointer = false; });
  $('[data-format-tools]', host)?.addEventListener('pointercancel', () => { touchFormatPointer = false; });
  $('[data-format-tools]', host)?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (!button) return;
    applyComposerFormat(input, button.dataset.format);
    touchFormatPointer = false;
    updateFormatTools();
  });
  $$('[data-bot-action]', host).forEach((button) => button.addEventListener('click', () => {
    const input = inputNode();
    if (!input) return;
    input.value = button.dataset.botAction || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }));
  $$('[data-support-category]', host).forEach((button) => button.addEventListener('click', async () => {
    try {
      await Api.createSupportRequest({ chatId: conv.chatId, category: button.dataset.supportCategory });
      toast('Обращение создано. Специалист увидит его в очереди.', { type: 'success' });
    } catch (err) { toastError(err); }
  }));
  const updateSendState = () => {
    const hasText = input.value.trim().length > 0;
    send.disabled = (!hasText && !state.attachments.length) || conv.uploadingAttachments;
    autoGrow(input);
  };
  updateSendState();

  input.addEventListener('input', () => {
    updateSendState();
    state.drafts[conv.chatId] = input.value;
    notifyTyping();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && window.matchMedia('(min-width: 641px)').matches) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'ArrowUp' && !input.value && !conv.editing) {
      const lastOwn = [...state.messages].reverse().find((m) => isMe(m.senderId) && m.type === 'text' && !m.deletedForAll);
      if (lastOwn) { e.preventDefault(); startEdit(lastOwn.id); }
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  send.addEventListener('click', () => submit());
  $('[data-attach-btn]', host)?.addEventListener('click', () => $('[data-file-input]', host).click());
  $('[data-file-input]', host).addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('[data-emoji-btn]', host).addEventListener('click', (e) => togglePicker(e.currentTarget));
  $('[data-poll-btn]', host)?.addEventListener('click', createPoll);

  bindMic($('[data-mic]', host));
  if (draft) setTimeout(() => autoGrow(input), 0);
  renderReplyBar();
}

async function createPoll() {
  if (!canPostHere()) return;
  const question = window.prompt('Вопрос опроса');
  if (!question?.trim()) return;
  const rawOptions = window.prompt('Варианты через запятую (минимум 2)');
  const options = (rawOptions || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (options.length < 2) return toast('Нужно указать минимум два варианта', { type: 'error' });
  try {
    const res = await sendInCurrentChat({ type: 'poll', poll: { question: question.trim(), options } });
    appendMessage(res.message, { animate: true });
    scrollToBottom(true);
  } catch (err) { toastError(err); }
}

function autoGrow(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(220, Math.max(40, input.scrollHeight))}px`;
}

function applyComposerFormat(input, format) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const selected = input.value.slice(start, end);
  let replacement = selected;
  let selectionStart = start;
  let selectionEnd = end;
  if (format === 'quote') {
    const lineStart = input.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEnd = input.value.indexOf('\n', end);
    const endOffset = lineEnd === -1 ? input.value.length : lineEnd;
    const lines = input.value.slice(lineStart, endOffset).split('\n');
    const quoted = lines.map((line) => line.startsWith('> ') ? line : `> ${line}`).join('\n');
    input.setRangeText(quoted, lineStart, endOffset, 'select');
    selectionStart = lineStart;
    selectionEnd = lineStart + quoted.length;
  } else if (format === 'link') {
    const url = window.prompt('Вставьте ссылку, начинающуюся с https://');
    if (!url) return;
    let parsedUrl;
    try { parsedUrl = new URL(url.trim()); } catch { return toast('Введите корректную ссылку', { type: 'error' }); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return toast('Разрешены только ссылки http и https', { type: 'error' });
    const label = selected || 'ссылка';
    replacement = `[${label}](${parsedUrl.href})`;
    input.setRangeText(replacement, start, end, selected ? 'select' : 'end');
    selectionStart = selected ? start + 1 : start + replacement.length;
    selectionEnd = selected ? start + 1 + label.length : selectionStart;
  } else {
    const marker = format === 'bold' ? '**' : '*';
    replacement = selected ? `${marker}${selected}${marker}` : `${marker}${marker}`;
    input.setRangeText(replacement, start, end, selected ? 'select' : 'end');
    selectionStart = selected ? start + marker.length : start + marker.length;
    selectionEnd = selected ? start + marker.length + selected.length : selectionStart;
  }
  if (format === 'quote') input.setSelectionRange(selectionStart, selectionEnd);
  else if (format !== 'link' && selected) input.setSelectionRange(selectionStart, selectionEnd);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/** Индикатор набора: не чаще одного запроса в 2 секунды, с автосбросом. */
const notifyTyping = (() => {
  let lastSent = 0;
  let stopTimer = null;
  return () => {
    if (!conv.chatId) return;
    const now = Date.now();
    if (now - lastSent > 2000) { lastSent = now; sendTyping(conv.chatId, true); }
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { lastSent = 0; sendTyping(conv.chatId, false); }, 2200);
  };
})();

export async function submit() {
  if (conv.uploadingAttachments) return;
  const input = inputNode();
  if (!input) return;
  const text = input.value.trim();

  if (state.attachments.length) {
    await sendAttachments(text);
    renderComposerSendState();
    return;
  }
  if (!text) return;
  if (conv.editing) return submitEdit(text);
  if (!canPostHere()) return;

  input.value = '';
  state.drafts[conv.chatId] = '';
  autoGrow(input);
  $('[data-send]')?.setAttribute('disabled', '');

  await sendText(text);
}

function canPostHere() {
  const can = state.chat?.permissions?.canPost !== false;
  if (!can) toast('В этом канале публикуют только администраторы', { type: 'error' });
  const topic = conv.topics.find((item) => item.id === conv.topicId);
  const topicOpen = !topic?.isClosed || state.chat?.permissions?.canEditInfo;
  if (!topicOpen) toast('Эта тема закрыта для новых сообщений', { type: 'error' });
  return can && topicOpen;
}

function sendInCurrentChat(payload) {
  return Api.sendMessage(conv.chatId, {
    ...payload,
    ...(state.chat?.chat.type === 'group' && conv.topicId ? { topicId: conv.topicId } : {}),
  });
}

async function sendText(text, { replyTo = state.replyTo?.id || null, retryOf = null } = {}) {
  if (conv.sending && !retryOf) return;
  conv.sending = true;
  const tid = retryOf || tempId();
  const optimistic = {
    id: tid, tempId: tid, chatId: conv.chatId, topicId: conv.topicId, senderId: state.user.id, seq: Number.MAX_SAFE_INTEGER,
    type: 'text', text, media: null, sticker: null, replyTo, reactions: [], createdAt: Date.now(),
    status: 'sending', pending: true, editedAt: null, deletedForAll: false, pinned: false, views: 0,
  };
  if (retryOf) updateMessageByTemp(retryOf, { status: 'sending' });
  else appendMessage(optimistic, { animate: true });
  requestAnimationFrame(() => scrollToBottom(true));

  clearReply();
  try {
    const res = await sendInCurrentChat({ type: 'text', text, replyToId: replyTo });
    if (res.reply) state.replies = { ...state.replies, [res.reply.id]: res.reply };
    replaceMessageId(tid, { ...res.message, reactions: res.message.reactions || [] });
  } catch (err) {
    updateMessageByTemp(tid, { status: 'failed', error: err.message });
    toastError(err);
  } finally {
    conv.sending = false;
  }
}

async function submitEdit(text) {
  const id = conv.editing;
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) return;
  const input = inputNode();
  updateMessage(id, { text, edited: true });
  conv.editing = null;
  renderReplyBar();
  try {
    const res = await Api.editMessage(id, text);
    updateMessage(id, res.message);
    toast('Сообщение изменено', { type: 'success', timeout: 1600 });
  } catch (err) {
    updateMessage(id, { text: msg.text, editedAt: msg.editedAt });
    toastError(err);
  } finally {
    if (input) { input.value = ''; autoGrow(input); }
  }
}

/* ───────────────────────── Вложения ──────────────────────────────────── */

export async function addFiles(files) {
  if (!files?.length || !canPostHere()) return;
  for (const file of files.slice(0, 20)) {
    const kind = classifyFile(file);
    const limitKind = kind === 'photo' ? 'image' : kind === 'video' ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
    const fallbackLimits = { image: 100, video: 500, audio: 100, file: 500 };
    const limit = state.limits?.[limitKind] || fallbackLimits[limitKind] * 1024 * 1024;
    if (file.size > limit) { toast(`${file.name}: превышен лимит ${fmtBytes(limit)}`, { type: 'error' }); continue; }
    const item = {
      id: tempId(), file, kind, name: file.name, size: file.size,
      previewUrl: kind === 'photo' || kind === 'video' ? URL.createObjectURL(file) : null,
      progress: 0, uploading: false, uploadPhase: '', meta: null,
    };
    state.attachments.push(item);
  }
  renderAttachments();
}

function renderAttachments() {
  const host = $('[data-composer-wrap]');
  if (!host) return;
  const existing = $('[data-attach-strip]', host);
  if (!state.attachments.length) { existing?.remove(); return; }
  const strip = existing || el('div', { class: 'attach-strip', 'data-attach-strip': '' });
  strip.innerHTML = state.attachments.map((item, index) => html`<div class="attach-item ${item.kind === 'file' ? 'file' : ''} ${item.uploading ? 'uploading' : ''}" data-attach="${item.id}">
    ${item.previewUrl && item.kind === 'photo' ? raw(`<img src="${esc(item.previewUrl)}" alt="">`) : ''}
    ${item.previewUrl && item.kind === 'video' ? raw(`<video src="${esc(item.previewUrl)}" muted playsinline></video>`) : ''}
    ${item.kind === 'file' ? html`<div class="col gap-1 center" style="padding:6px">
      <span style="width:22px;height:22px;color:var(--accent-soft)">${raw(icons.file)}</span>
      <span class="tiny truncate" style="max-width:74px">${item.name}</span>
      <span class="tiny mute">${fmtBytes(item.size)}</span></div>` : ''}
    ${item.uploading || item.uploadPhase === 'error' ? html`<div class="attach-upload-state">
      <span class="attach-upload-label">${item.uploadPhase === 'error' ? 'Ошибка загрузки · повторите' : item.uploadPhase === 'prepare' ? `Подготовка · ${index + 1}/${state.attachments.length}` : `Загрузка · ${index + 1}/${state.attachments.length} · ${item.progress}%`}</span>
      ${item.uploading ? html`<div class="progress attach-progress"><i style="width:${item.progress}%"></i></div>` : ''}
    </div>` : ''}
    ${item.uploading ? '' : html`<button class="rm" data-remove="${item.id}" aria-label="Убрать">×</button>`}
  </div>`).join('');
  if (!existing) {
    const composer = $('[data-composer]', host);
    host.insertBefore(strip, composer);
  }
  strip.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
    const item = state.attachments.find((a) => a.id === btn.dataset.remove);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    state.attachments = state.attachments.filter((a) => a.id !== btn.dataset.remove);
    renderAttachments();
  }));
  const input = inputNode();
  const hasText = !!input?.value.trim();
  const send = $('[data-send]');
  if (send) send.disabled = conv.uploadingAttachments || (!hasText && !state.attachments.length);
}

/** Загрузка во вложения с прогрессом, затем отправка сообщениями. */
async function sendAttachments(caption = '') {
  if (conv.uploadingAttachments) return;
  const items = [...state.attachments];
  const input = inputNode();
  if (input) { input.value = ''; autoGrow(input); }
  state.drafts[conv.chatId] = '';
  conv.uploadingAttachments = true;
  for (const item of items) {
    item.uploading = false;
    item.uploadPhase = '';
    item.progress = 0;
  }
  renderAttachments();
  renderComposerSendState();

  const visual = items.length > 1 && items.length <= 5 && items.every((item) => item.kind === 'photo' || item.kind === 'video');
  if (visual) {
    try {
      const uploaded = [];
      for (let index = 0; index < items.length; index++) {
        uploaded.push(await uploadItem(items[index], index, items.length));
        updateAttachmentProgress(items[index], 100, 'sending');
      }
      await sendMediaMessage({ type: 'photo', media: uploaded[0], mediaIds: uploaded.map((item) => item.media.id), mediaItems: uploaded.map((item) => item.media), text: caption });
      items.forEach(removeUploadedAttachment);
    } catch (err) {
      markAttachmentUploadError(items.find((item) => item.uploading) || items[0]);
      if (!err?.details?.aborted) toastError(err);
    } finally {
      items.forEach((item) => {
        if (item.uploadPhase !== 'error') {
          item.uploading = false;
          item.uploadPhase = '';
        }
      });
      conv.uploadingAttachments = false;
      renderAttachments();
      renderComposerSendState();
    }
    return;
  }
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = i === 0 ? caption : '';
      try {
        const uploaded = await uploadItem(item, i, items.length);
        updateAttachmentProgress(item, 100, 'sending');
        const type = item.kind === 'photo' ? 'photo' : item.kind === 'video' ? 'video' : 'file';
        await sendMediaMessage({ type, media: uploaded, text });
        removeUploadedAttachment(item);
      } catch (err) {
        markAttachmentUploadError(item);
        if (!err?.details?.aborted) toastError(err);
      }
    }
  } finally {
    conv.uploadingAttachments = false;
    renderAttachments();
    renderComposerSendState();
  }
}

function renderComposerSendState() {
  const send = $('[data-send]');
  const input = inputNode();
  if (send) send.disabled = conv.uploadingAttachments || (!input?.value.trim() && !state.attachments.length);
}

function updateAttachmentProgress(item, percent, phase = 'upload') {
  item.uploading = true;
  item.uploadPhase = phase;
  item.progress = percent;
  const strip = $('[data-attach-strip]');
  if (!strip) return;
  const row = $$('[data-attach]', strip).find((node) => node.dataset.attach === item.id);
  if (!row) return;
  row.classList.add('uploading');
  let status = $('.attach-upload-state', row);
  if (!status) {
    status = el('div', { class: 'attach-upload-state' });
    status.innerHTML = '<span class="attach-upload-label"></span><div class="progress attach-progress"><i></i></div>';
    row.append(status);
  }
  const index = state.attachments.findIndex((entry) => entry.id === item.id);
  const position = item.uploadIndex ?? index;
  const total = item.uploadTotal ?? state.attachments.length;
  const label = $('.attach-upload-label', status);
  if (label) label.textContent = phase === 'prepare'
    ? `Подготовка · ${position + 1}/${total}`
    : phase === 'sending'
      ? `Отправка · ${position + 1}/${total}`
      : `Загрузка · ${position + 1}/${total} · ${percent}%`;
  const bar = $('.attach-progress i', status);
  if (bar) bar.style.width = `${percent}%`;
  $('.rm', row)?.remove();
}

function removeUploadedAttachment(item) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  state.attachments = state.attachments.filter((entry) => entry.id !== item.id);
}

function markAttachmentUploadError(item) {
  if (!item) return;
  item.uploading = false;
  item.uploadPhase = 'error';
}

async function uploadItem(item, index, total) {
  item.uploadIndex = index;
  item.uploadTotal = total;
  if (item.kind === 'photo') {
    updateAttachmentProgress(item, 0, 'prepare');
    const { file: compressed, width, height } = await compressImage(item.file);
    const thumb = await makeThumb(compressed);
    updateAttachmentProgress(item, 0);
    return api.upload(compressed, {
      kind: 'photo', thumb, width, height,
      onProgress: (progress) => updateAttachmentProgress(item, progress),
    });
  }
  if (item.kind === 'video') {
    updateAttachmentProgress(item, 0, 'prepare');
    const meta = await videoMeta(item.file);
    updateAttachmentProgress(item, 0);
    return api.upload(item.file, {
      kind: 'video', thumb: meta.poster, duration: meta.duration,
      width: meta.width, height: meta.height,
      onProgress: (progress) => updateAttachmentProgress(item, progress),
    });
  }
  updateAttachmentProgress(item, 0);
  return api.upload(item.file, {
    kind: 'file',
    onProgress: (progress) => updateAttachmentProgress(item, progress),
  });
}

async function sendMediaMessage({ type, media, mediaIds = [media.media.id], mediaItems = [media.media], text = '' }) {
  const tid = tempId();
  appendMessage({
    id: tid, tempId: tid, chatId: conv.chatId, topicId: conv.topicId, senderId: state.user.id, seq: Number.MAX_SAFE_INTEGER,
    type, text, media: media.media, mediaItems, sticker: null, replyTo: state.replyTo?.id || null,
    reactions: [], createdAt: Date.now(), status: 'sending', pending: true, deletedForAll: false, pinned: false, views: 0,
  }, { animate: true });
  try {
    const res = await sendInCurrentChat({
      type, text, mediaId: media.media.id, mediaIds, replyToId: state.replyTo?.id || null,
    });
    if (res.reply) state.replies = { ...state.replies, [res.reply.id]: res.reply };
    replaceMessageId(tid, res.message);
    clearReply();
  } catch (err) {
    updateMessageByTemp(tid, { status: 'failed' });
    toastError(err);
  }
}

async function resendMessage(temp) {
  const msg = state.messages.find((m) => m.tempId === temp);
  if (!msg) return;
  if (msg.type === 'text') return sendText(msg.text, { replyTo: msg.replyTo, retryOf: temp });
  toast('Повторите отправку файла', { type: 'info' });
}

/* ───────────────────────── Эмодзи/стикеры ────────────────────────────── */

function togglePicker(anchor) {
  const existing = $('.picker', conv.host);
  if (existing) { existing.remove(); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = emojiPickerHTML();
  const picker = wrap.firstElementChild;
  picker.style.left = '8px';
  picker.style.bottom = 'calc(100% + 10px)';
  anchor.closest('.composer-wrap').style.position = 'relative';
  anchor.closest('.composer').append(picker);

  bindEmojiPicker(picker, {
    onEmoji: (emoji) => {
      const input = inputNode();
      const pos = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, pos)}${emoji}${input.value.slice(input.selectionEnd ?? pos)}`;
      input.focus();
      input.selectionStart = input.selectionEnd = pos + emoji.length;
      input.dispatchEvent(new Event('input'));
    },
    onSticker: (id) => { picker.remove(); sendSticker(id); },
  });

  const closeOnOutside = (e) => {
    if (!picker.contains(e.target) && !anchor.contains(e.target)) {
      picker.remove();
      document.removeEventListener('click', closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);
}

async function sendSticker(stickerId) {
  if (!canPostHere()) return;
  const tid = tempId();
  appendMessage({
    id: tid, tempId: tid, chatId: conv.chatId, topicId: conv.topicId, senderId: state.user.id, seq: Number.MAX_SAFE_INTEGER,
    type: 'sticker', text: '', media: null, sticker: stickerId, replyTo: null, reactions: [],
    createdAt: Date.now(), status: 'sending', pending: true, deletedForAll: false, pinned: false, views: 0,
  }, { animate: true });
  try {
    const res = await sendInCurrentChat({ type: 'sticker', sticker: stickerId });
    replaceMessageId(tid, res.message);
  } catch (err) {
    updateMessageByTemp(tid, { status: 'failed' });
    toastError(err);
  }
}

/* ───────────────── Голосовые и кружки: нажатие — смена режима, удержание — запись ───────────────── */

const HOLD_MS = 220;
const REC_HINT = '← отмена · ↑ закрепить';
const VIDEO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><rect x="7.6" y="9" width="5.8" height="6" rx="1.5"/><path d="M13.4 11.3l3-1.7v4.8l-3-1.7"/></svg>';
const videoNote = { active: false, locked: false, finish: null };
let recBlurBound = false;

function getRecMode() {
  try { return localStorage.getItem('aurora.recMode') === 'video' ? 'video' : 'voice'; } catch { return 'voice'; }
}
function setRecMode(mode) {
  try { localStorage.setItem('aurora.recMode', mode); } catch { /* приватный режим */ }
}
function micIconHTML() { return getRecMode() === 'video' ? VIDEO_ICON : icons.mic; }

function bindMic(button) {
  if (!button) return;
  const paint = () => {
    const video = getRecMode() === 'video';
    button.innerHTML = video ? VIDEO_ICON : icons.mic;
    button.classList.toggle('video-mode', video);
    button.setAttribute('aria-label', video ? 'Видеокружок: удерживайте для записи' : 'Голосовое: удерживайте для записи');
    button.dataset.tip = video ? 'Кружок · удерживайте. Нажмите — голос' : 'Голос · удерживайте. Нажмите — кружок';
  };
  paint();
  button.addEventListener('contextmenu', (e) => e.preventDefault());

  if (!recBlurBound) {
    recBlurBound = true;
    window.addEventListener('blur', () => {
      if (conv.recState && !conv.recState.locked) finishRecording();
      if (videoNote.active && !videoNote.locked) videoNote.finish?.(false);
    });
  }

  button.addEventListener('pointerdown', (e) => {
    if ((e.button ?? 0) > 0 || !canPostHere() || conv.recState || videoNote.active) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const mode = getRecMode();
    let session = null;
    const timer = setTimeout(() => {
      haptic(12);
      session = mode === 'video' ? beginVideoNote(start) : beginVoice(start);
    }, HOLD_MS);
    const move = (ev) => session?.move(ev);
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    function up(ev) {
      cleanup();
      clearTimeout(timer);
      if (session) { session.end(ev); return; }
      // Короткое нажатие: переключаем голос ↔ кружок
      const next = mode === 'video' ? 'voice' : 'video';
      if (next === 'video' && !VideoNoteRecorder.supported()) {
        toast('Запись видео не поддерживается этим браузером', { type: 'error' });
        return;
      }
      setRecMode(next);
      paint();
      haptic(8);
      toast(next === 'video' ? 'Видеокружок — удерживайте кнопку для записи' : 'Голосовое — удерживайте кнопку для записи', { type: 'info', timeout: 1400 });
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* ── Голос ── */
function beginVoice(start) {
  if (!VoiceRecorder.supported()) {
    toast('Запись голосовых не поддерживается этим браузером', { type: 'error' });
    return { move() {}, end() {} };
  }
  let cancelZone = false;
  const recorder = new VoiceRecorder();
  conv.recorder = recorder;
  conv.recState = { holding: true, locked: false, cancelled: false, elapsed: 0 };
  const ready = recorder.start({
    onLevel: (level) => pushLiveLevel(level),
    onTick: (elapsed) => {
      const time = $('[data-rec-time]');
      if (time) time.textContent = fmtDuration(elapsed);
      if (elapsed >= 300) finishRecording(); // 5 минут — предел разумной длины
    },
  }).then(() => { if (conv.recState) renderRecordingUI(); return true; })
    .catch(() => {
      conv.recState = null; conv.recorder = null;
      toast('Нет доступа к микрофону — проверьте разрешения', { type: 'error' });
      return false;
    });
  return {
    move(e) {
      if (!conv.recState || conv.recState.locked) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dy < -70) { conv.recState.locked = true; haptic(14); renderRecordingUI(); return; }
      const now = dx < -70;
      if (now !== cancelZone) {
        cancelZone = now;
        haptic(10);
        $('[data-rec-bar]')?.classList.toggle('cancel', now);
        const hint = $('[data-rec-hint]');
        if (hint) hint.textContent = now ? 'Отпустите — отмена' : REC_HINT;
      }
    },
    async end() {
      const ok = await ready;
      if (!ok || !conv.recState) return;
      conv.recState.holding = false;
      if (cancelZone) { cancelRecording(); return; }
      if (conv.recState.locked) { renderRecordingUI(); return; }
      await finishRecording();
    },
  };
}

/* ── Видеокружок ── */
function beginVideoNote(start) {
  const rec = new VideoNoteRecorder();
  const root = document.createElement('div');
  root.className = 'vn-overlay';
  root.innerHTML = `<div class="vn-stage">
    <div class="vn-circle">
      <video class="vn-video" muted playsinline autoplay></video>
      <svg class="vn-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="vn-ring-bg" cx="50" cy="50" r="48"/><circle class="vn-ring-fg" cx="50" cy="50" r="48" pathLength="100"/></svg>
    </div>
    <div class="vn-time"><span class="rec-dot"></span><span data-vn-time>0:00</span></div>
    <div class="vn-hint" data-vn-hint>${REC_HINT}</div>
    <div class="vn-actions" hidden>
      <button class="vn-btn danger" data-vn-cancel aria-label="Отменить">${icons.trash}</button>
      <button class="vn-btn primary" data-vn-send aria-label="Отправить">${icons.send}</button>
    </div>
  </div>`;
  document.getElementById('overlays').append(root);
  videoNote.active = true;
  videoNote.locked = false;

  let cancelZone = false;
  let stopped = false;
  const onKey = (e) => { if (e.key === 'Escape') finish(false); };
  document.addEventListener('keydown', onKey);

  const closeUI = () => {
    document.removeEventListener('keydown', onKey);
    root.classList.add('closing');
    setTimeout(() => root.remove(), 180);
    videoNote.active = false;
    videoNote.locked = false;
    videoNote.finish = null;
  };

  const ready = (async () => {
    try {
      const stream = await rec.openCamera('user');
      if (stopped) { rec.cancel(); return false; }
      const video = root.querySelector('.vn-video');
      video.srcObject = stream;
      await video.play().catch(() => {});
      rec.start({
        onTick: (elapsed) => {
          const t = root.querySelector('[data-vn-time]');
          if (t) t.textContent = fmtDuration(elapsed);
          root.querySelector('.vn-ring-fg')?.style.setProperty('stroke-dashoffset', String(100 - Math.min(100, (elapsed / 60) * 100)));
        },
        onLimit: () => finish(true),
      });
      root.classList.add('live');
      return true;
    } catch (err) {
      stopped = true;
      rec.cancel();
      closeUI();
      toast('Не удалось начать запись видео — проверьте разрешения камеры и микрофона', { type: 'error' });
      console.error('Video note initialization failed:', err);
      return false;
    }
  })();

  async function finish(send) {
    if (stopped) return;
    stopped = true;
    const ok = await ready;
    if (!ok) { closeUI(); return; }
    if (!send) {
      rec.cancel();
      closeUI();
      toast('Запись отменена', { type: 'info', timeout: 1500 });
      return;
    }
    let result = null;
    try { result = await rec.stop(); } catch (err) {
      toastError(err);
    }
    closeUI();
    if (!result) return;
    if (result.duration < 0.8) { toast('Слишком короткая запись', { type: 'info' }); return; }
    sendVideoNote(result);
  }
  videoNote.finish = finish;

  const lock = () => {
    videoNote.locked = true;
    haptic(14);
    root.classList.add('locked');
    root.querySelector('.vn-actions').hidden = false;
    root.querySelector('[data-vn-hint]').textContent = 'Запись закреплена';
  };
  root.querySelector('[data-vn-cancel]').addEventListener('click', () => finish(false));
  root.querySelector('[data-vn-send]').addEventListener('click', () => finish(true));

  return {
    move(e) {
      if (videoNote.locked || stopped) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dy < -70) { lock(); return; }
      const now = dx < -70;
      if (now !== cancelZone) {
        cancelZone = now;
        haptic(10);
        root.classList.toggle('cancel', now);
        root.querySelector('[data-vn-hint]').textContent = now ? 'Отпустите — отмена' : REC_HINT;
      }
    },
    async end() {
      if (videoNote.locked) return;
      await finish(!cancelZone);
    },
  };
}

async function sendVideoNote(result) {
  const tid = tempId();
  const localUrl = URL.createObjectURL(result.file);
  const media = { url: localUrl, thumbUrl: '', filename: result.file.name, width: result.width, height: result.height, duration: result.duration };
  appendMessage({
    id: tid, tempId: tid, chatId: conv.chatId, topicId: conv.topicId, senderId: state.user.id, seq: Number.MAX_SAFE_INTEGER,
    type: 'video', text: '', media, mediaItems: [media], sticker: null, replyTo: state.replyTo?.id || null,
    reactions: [], createdAt: Date.now(), status: 'sending', pending: true, deletedForAll: false, pinned: false, views: 0,
  }, { animate: true });
  try {
    const up = await api.upload(result.file, {
      kind: 'video', duration: result.duration, width: result.width, height: result.height,
    });
    const res = await sendInCurrentChat({
      type: 'video', text: '', mediaId: up.media.id, mediaIds: [up.media.id], replyToId: state.replyTo?.id || null,
    });
    replaceMessageId(tid, res.message);
    clearReply();
  } catch (err) {
    updateMessageByTemp(tid, { status: 'failed' });
    toastError(err);
  } finally {
    setTimeout(() => URL.revokeObjectURL(localUrl), 60000);
  }
}

let liveLevels = [];
const pushLiveLevel = throttle((level) => {
  liveLevels.push(level);
  if (liveLevels.length > 120) liveLevels.shift();
  const host = $('[data-rec-live]');
  if (host) {
    host.innerHTML = liveLevels.slice(-40).map((l) => `<i style="height:${Math.round(4 + l * 26)}px"></i>`).join('');
  }
}, 70);

function renderRecordingUI() {
  const wrap = $('[data-composer]');
  if (!wrap || !conv.recState) return;
  const locked = conv.recState.locked;
  const side = wrap.querySelectorAll('.composer-side')[1];
  if (!side) return;
  side.innerHTML = locked
    ? `<button class="icon-btn rec-cancel" data-rec-cancel title="Отменить запись" aria-label="Отменить запись">${icons.trash}</button>
       <button class="send-btn" data-rec-send aria-label="Отправить">${icons.send}</button>`
    : `<span class="rec-orb" aria-hidden="true">${icons.mic}</span>`;
  const middle = wrap.querySelector('[data-input]') || wrap.querySelector('[data-rec-bar]');
  const bar = document.createElement('div');
  bar.className = 'rec-bar';
  bar.setAttribute('data-rec-bar', '');
  bar.innerHTML = `<span class="rec-dot"></span>
    <span class="rec-time" data-rec-time>0:00</span>
    <span class="rec-live" data-rec-live></span>
    <span class="rec-hint" data-rec-hint>${locked ? 'Нажмите ➤, чтобы отправить' : REC_HINT}</span>`;
  middle?.replaceWith(bar);
  $('[data-rec-cancel]')?.addEventListener('click', cancelRecording);
  $('[data-rec-send]')?.addEventListener('click', () => finishRecording());
}

function stopRecordingUI() {
  const wrap = $('[data-composer]');
  if (!wrap) return;
  conv.recState = null;
  conv.recorder = null;
  liveLevels = [];
  renderComposer();
}

async function finishRecording() {
  if (!conv.recorder || !conv.recState) return;
  if (!canPostHere()) {
    conv.recorder.cancel();
    stopRecordingUI();
    return;
  }
  const recorder = conv.recorder;
  conv.recState = null;
  const result = await recorder.stop().catch(() => null);
  stopRecordingUI();
  if (!result) return;
  if (result.duration < 0.6) return toast('Слишком короткая запись', { type: 'info' });
  const tid = tempId();
  appendMessage({
    id: tid, tempId: tid, chatId: conv.chatId, topicId: conv.topicId, senderId: state.user.id, seq: Number.MAX_SAFE_INTEGER,
    type: 'voice', text: '', media: null, sticker: null, replyTo: null, reactions: [],
    createdAt: Date.now(), status: 'sending', pending: true, deletedForAll: false, pinned: false, views: 0,
    uploading: true, uploadProgress: 0,
  }, { animate: true });
  try {
    const up = await api.upload(result.file, {
      kind: 'voice', duration: result.duration, peaks: result.peaks,
      onProgress: (p) => updateMessageByTemp(tid, { uploadProgress: p }),
    });
    const res = await sendInCurrentChat({ type: 'voice', mediaId: up.media.id });
    replaceMessageId(tid, res.message);
  } catch (err) {
    updateMessageByTemp(tid, { status: 'failed' });
    toastError(err);
  }
}

function cancelRecording() {
  conv.recorder?.cancel();
  stopRecordingUI();
  toast('Запись отменена', { type: 'info', timeout: 1500 });
}

/* ───────────────────────── Ответ и правка ────────────────────────────── */

export function startReply(messageId) {
  const msg = state.messages.find((m) => m.id === messageId) || state.replies[messageId];
  if (!msg) return;
  const members = state.membersByChat[conv.chatId] || [];
  const sender = members.find((x) => x.id === msg.senderId);
  state.replyTo = {
    id: msg.id,
    senderName: isMe(msg.senderId) ? 'Вы' : sender?.name || 'Сообщение',
    preview: msg.type === 'text' ? String(msg.text || '').slice(0, 120) : { photo: '📷 Фото', video: '🎬 Видео', voice: '🎤 Голосовое', file: '📎 Файл', sticker: '✨ Стикер' }[msg.type] || 'Сообщение',
    text: msg.text,
  };
  conv.editing = null;
  renderReplyBar();
  inputNode()?.focus();
}

function startEdit(messageId) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg || !isMe(msg.senderId) || msg.deletedForAll) return;
  conv.editing = messageId;
  state.replyTo = null;
  const input = inputNode();
  if (input) {
    input.value = msg.text || '';
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    autoGrow(input);
    $('[data-send]')?.removeAttribute('disabled');
  }
  renderReplyBar();
}

export function clearReply() {
  state.replyTo = null;
  renderReplyBar();
}

function renderReplyBar() {
  const slot = $('[data-reply-slot]');
  if (!slot) return;
  if (conv.editing) {
    const msg = state.messages.find((m) => m.id === conv.editing);
    slot.innerHTML = html`<div class="reply-bar edit-bar">
      <span class="bar"></span>
      <div class="col grow" style="min-width:0">
        <span class="small bold" style="color:var(--warn)">Редактирование</span>
        <span class="small muted truncate">${msg?.text || ''}</span>
      </div>
      <button class="icon-btn" data-cancel-reply aria-label="Отменить">${raw(icons.close)}</button>
    </div>`;
  } else if (state.replyTo) {
    slot.innerHTML = html`<div class="reply-bar">
      <span class="bar"></span>
      <div class="col grow" style="min-width:0">
        <span class="small bold" style="color:var(--accent-soft)">Ответ ${state.replyTo.senderName}</span>
        <span class="small muted truncate">${state.replyTo.preview}</span>
      </div>
      <button class="icon-btn" data-cancel-reply aria-label="Отменить">${raw(icons.close)}</button>
    </div>`;
  } else {
    slot.innerHTML = '';
  }
  $('[data-cancel-reply]', slot)?.addEventListener('click', () => {
    conv.editing = null;
    clearReply();
    const input = inputNode();
    if (input) { input.value = ''; autoGrow(input); $('[data-send]')?.setAttribute('disabled', ''); }
  });
}

/* ───────────────────────── Меню сообщения ────────────────────────────── */

const QUICK_REACTIONS = ['❤️', '😂', '👍', '🔥', '😢', '😮', '👎'];

export function openMessageMenu(messageId, x = null, y = null, anchor = null) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const own = isMe(msg.senderId);
  const isModerator = ['owner', 'admin'].includes(state.chat?.role) && state.chat?.chat.type !== 'dm';
  const isChannel = state.chat?.chat.type === 'channel';

  const reactions = el('div', { class: 'menu-reactions', role: 'group', 'aria-label': 'Быстрые реакции' },
    ...QUICK_REACTIONS.map((emoji) => el('button', {
      class: `reaction-pick ${hasMyReaction(msg, emoji) ? 'active' : ''}`,
      type: 'button',
      'aria-label': `${hasMyReaction(msg, emoji) ? 'Убрать' : 'Поставить'} реакцию ${emoji}`,
      onClick: () => { closeMenu(); toggleReaction(messageId, emoji); },
    }, emoji, el('span', { class: 'sr-only' }, hasMyReaction(msg, emoji) ? 'Убрать' : 'Поставить'))));

  const premiumRow = el('div', { class: 'menu-reactions prem-row', role: 'group', 'aria-label': 'Премиум-реакции' },
    el('div', { class: 'prem-row-label' }, state.user?.isPremium ? '✦ Premium-реакции' : '✦ Premium-реакции · нужна подписка'),
    ...PREMIUM_REACTIONS.map((emoji) => el('button', {
      class: `reaction-pick ${hasMyReaction(msg, emoji) ? 'active' : ''} ${state.user?.isPremium ? '' : 'locked'}`,
      type: 'button',
      'aria-label': `Премиум-реакция ${premiumReactionLabel(emoji)}`,
      onClick: () => { closeMenu(); toggleReaction(messageId, emoji); },
    }, raw(premiumReactionHTML(emoji)))));

  const items = [
    { type: 'custom', node: reactions },
    { type: 'custom', node: premiumRow },
    { type: 'sep' },
    { label: 'Ответить', icon: 'reply', onClick: () => startReply(messageId) },
    { label: 'Копировать', icon: 'copy', onClick: () => copyToClipboard(msg.text || '').then(() => toast('Скопировано', { type: 'success', timeout: 1400 })) },
    own ? { label: 'Изменить', icon: 'edit', onClick: () => startEdit(messageId) } : null,
    !own && state.chat?.chat.type !== 'dm'
      ? { label: 'Пожаловаться', icon: 'alert', onClick: () => openMessageReport(messageId) } : null,
    { label: msg.pinned ? 'Открепить' : 'Закрепить', icon: 'pin', onClick: () => togglePin(messageId, !msg.pinned) },
    { label: 'Переслать', icon: 'forward', onClick: () => Modals.openForward([messageId]) },
    { type: 'sep' },
    { label: 'Удалить', icon: 'trash', danger: true, onClick: () => openMessageDeleteMenu(messageId, { x, y, anchor, isModerator, own }) },
    { type: 'sep' },
    { type: 'label', label: 'Ещё' },
    { label: 'Выбрать', icon: 'check', onClick: () => { setSelectionMode(true); toggleSelect(messageId); } },
    { label: 'Информация', icon: 'info', onClick: () => Modals.showMessageInfo(messageId) },
  ].filter(Boolean);

  contextMenu(items, {
    ...(anchor ? { anchor, align: 'right' } : { x: (x ?? 232) - 220, y: y ?? 100, align: 'auto' }),
    className: 'message-menu',
  });
}

function openMessageReport(messageId) {
  const reason = el('select', { class: 'input' },
    el('option', { value: 'spam' }, 'Спам'),
    el('option', { value: 'abuse' }, 'Оскорбления'),
    el('option', { value: 'scam' }, 'Мошенничество'),
    el('option', { value: 'other' }, 'Другое'));
  const details = el('textarea', { class: 'textarea', maxlength: 500, placeholder: 'Дополнительная информация (необязательно)' });
  const message = el('div', { class: 'field-msg' });
  const m = modal({
    title: 'Пожаловаться на публикацию',
    body: el('div', { class: 'col gap-3' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Причина'), reason),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Пояснение'), details),
      message),
    footer: [
      el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Отмена'),
      el('button', { class: 'btn btn-primary', type: 'button', onClick: async () => {
        try {
          await Api.reportMessage(messageId, reason.value, details.value);
          toast('Жалоба отправлена администраторам', { type: 'success' });
          m.close();
        } catch (err) {
          message.textContent = err.message;
        }
      } }, 'Отправить'),
    ],
  });
}

function openMessageDeleteMenu(messageId, { x, y, anchor, isModerator, own }) {
  const items = [
    { label: 'Удалить у себя', icon: 'trash', danger: true, onClick: () => removeMessageAction(messageId, false) },
    own || isModerator
      ? { label: 'Удалить у всех', icon: 'trash', danger: true, onClick: () => removeMessageAction(messageId, true) }
      : null,
  ].filter(Boolean);
  contextMenu(items, {
    ...(anchor ? { anchor, align: 'right' } : { x: (x ?? 232) - 220, y: y ?? 100, align: 'auto' }),
    className: 'message-menu message-delete-menu',
  });
}

async function togglePin(messageId, pinned) {
  try {
    await Api.pinMessage(messageId, pinned);
    updateMessage(messageId, { pinned });
    refreshPinned();
    toast(pinned ? 'Сообщение закреплено' : 'Сообщение откреплено', { type: 'success', timeout: 1600 });
  } catch (err) { toastError(err); }
}

async function removeMessageAction(messageId, forAll) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  if (forAll) {
    const ok = await confirmDialog({
      title: 'Удалить сообщение для всех?',
      text: 'Сообщение исчезнет у всех участников чата.',
      confirmLabel: 'Удалить у всех',
      danger: true,
    });
    if (!ok) return;
  }
  const backup = { ...msg };
  removeMessage(messageId);
  try {
    await Api.deleteMessage(messageId, forAll);
    toast(forAll ? 'Удалено у всех' : 'Удалено у вас', { type: 'success', timeout: 1600 });
  } catch (err) {
    appendMessage(backup);
    toastError(err);
  }
}

/* ───────────────────────── Выделение нескольких ──────────────────────── */

export function setSelectionMode(on) {
  state.selectionMode = on;
  if (!on) state.selection.clear();
  conv.host.classList.toggle('selection-mode', on);
  renderSelectionBar();
  $$('.msg', conv.host).forEach((node) => node.classList.toggle('selected', on && state.selection.has(Number(node.dataset.msgId))));
}

export function exitSelectionMode() {
  if (!state.selectionMode) return false;
  setSelectionMode(false);
  return true;
}

export function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
  if (!state.selection.size) { setSelectionMode(false); return; }
  state.selectionMode = true;
  const node = $(`[data-msg-id="${id}"]`);
  node?.classList.toggle('selected', state.selection.has(id));
  renderSelectionBar();
}

function renderSelectionBar() {
  const slot = $('[data-selection]');
  if (!slot) return;
  if (!state.selectionMode || !state.selection.size) { slot.innerHTML = ''; return; }
  const ids = [...state.selection];
  const all = state.messages.filter((m) => ids.includes(m.id));
  const canDeleteAll = all.every((m) => isMe(m.senderId)) || ['owner', 'admin'].includes(state.chat?.role);
  const text = all.map((message) => message.text).filter(Boolean).join('\n\n');
  slot.innerHTML = html`<div class="selection-bar">
    <span class="count">${ids.length} выбрано</span>
    <button class="icon-btn" data-sel-reply data-tip="Ответить">${raw(icons.reply)}</button>
    <button class="icon-btn" data-sel-forward data-tip="Переслать">${raw(icons.forward)}</button>
    <button class="icon-btn" data-sel-copy data-tip="Копировать">${raw(icons.copy)}</button>
    <button class="icon-btn" data-sel-pin data-tip="Закрепить">${raw(icons.pin)}</button>
    <button class="icon-btn" data-sel-delete data-tip="Удалить" style="color:var(--err)">${raw(icons.trash)}</button>
    <button class="icon-btn" data-sel-close data-tip="Отмена">${raw(icons.close)}</button>
  </div>`;
  $('[data-sel-close]', slot).addEventListener('click', () => setSelectionMode(false));
  $('[data-sel-reply]', slot).addEventListener('click', () => { startReply(ids[ids.length - 1]); setSelectionMode(false); });
  $('[data-sel-forward]', slot).addEventListener('click', () => { Modals.openForward(ids); setSelectionMode(false); });
  $('[data-sel-copy]', slot).addEventListener('click', () => {
    copyToClipboard(text).then(() => toast(`Скопировано сообщений: ${all.length}`, { type: 'success' }));
    setSelectionMode(false);
  });
  $('[data-sel-pin]', slot).addEventListener('click', async () => {
    for (const m of all) { try { await Api.pinMessage(m.id, !m.pinned); updateMessage(m.id, { pinned: !m.pinned }); } catch { /* noop */ } }
    refreshPinned();
    toast('Закрепление обновлено', { type: 'success' });
    setSelectionMode(false);
  });
  $('[data-sel-delete]', slot).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Удалить ${all.length} ${plural(all.length, 'сообщение', 'сообщения', 'сообщений')}?`,
      text: canDeleteAll ? 'Сообщения будут удалены у всех участников.' : 'Сообщения будут удалены только у вас.',
      confirmLabel: 'Удалить', danger: true,
    });
    if (!ok) return;
    for (const m of all) {
      if (m.pending) { removeMessage(m.id); continue; }
      try { await Api.deleteMessage(m.id, canDeleteAll); } catch { /* noop */ }
    }
    setSelectionMode(false);
  });
}

/* ───────────────────────── Закреплённые, просмотры, панель ───────────── */

function renderPinnedBar() {
  const host = $('[data-pinned]');
  if (!host) return;
  const pinned = state.chat?.pinnedMessages || [];
  if (!pinned.length) { host.innerHTML = ''; return; }
  const top = pinned[0];
  const members = state.membersByChat[conv.chatId] || [];
  const sender = members.find((x) => x.id === top.senderId);
  host.innerHTML = html`<div class="pinned-bar" data-open-pin="${top.id}">
    <span class="bar"></span>
    <div class="col grow" style="min-width:0">
      <span class="small bold">Закреплённое сообщение${pinned.length > 1 ? ` · ${pinned.length}` : ''}</span>
      <span class="txt truncate">${isMe(top.senderId) ? 'Вы' : sender?.name || ''}: ${previewOfPinned(top)}</span>
    </div>
    <button class="icon-btn" data-unpin title="Открепить">${raw(icons.unpin)}</button>
  </div>`;
  host.querySelector('[data-open-pin]')?.addEventListener('click', () => scrollToMessage(top.id));
  host.querySelector('[data-unpin]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await Api.pinMessage(top.id, false); toast('Сообщение откреплено', { type: 'success', timeout: 1500 }); } catch (err) { toastError(err); }
    refreshPinned();
  });
}

const previewOfPinned = (m) => ({
  photo: '📷 Фото', video: '🎬 Видео', voice: '🎤 Голосовое', file: '📎 Файл', sticker: '✨ Стикер',
}[m.type] || String(m.text || '').slice(0, 120));

function scrollToFirstPinned() {
  const pinned = state.chat?.pinnedMessages || [];
  if (!pinned.length) return toast('Нет закреплённых сообщений', { type: 'info' });
  scrollToMessage(pinned[0].id);
}

function markVisibleAsViewed() {
  if (state.chat?.chat.type !== 'channel') return;
  const scroller = $('[data-scroll]');
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  $$('[data-msg-id]', scroller).forEach((node) => {
    const id = Number(node.dataset.msgId);
    if (conv.viewed.has(id)) return;
    const r = node.getBoundingClientRect();
    if (r.top < rect.bottom && r.bottom > rect.top) {
      conv.viewed.add(id);
      Api.viewMessage(id).catch(() => {});
    }
  });
}

export function togglePanel() {
  Panels.toggleForChat(conv.chatId);
}

function openChatMenu(anchor, role, permissions) {
  const chat = state.chat?.chat;
  if (!chat) return;
  const info = chatById(chat.id);
  contextMenu([
    ...(chat.type === 'dm' ? [
      { label: 'Профиль собеседника', icon: 'user', onClick: () => Panels.showUserProfile(chat.peer?.id) },
    ] : [
      { label: 'Информация о чате', icon: 'info', onClick: () => Panels.toggleForChat(chat.id) },
      permissions?.canEditInfo ? { label: 'Редактировать', icon: 'edit', onClick: () => Modals.openEditChat(chat.id) } : null,
      permissions?.canAddMembers ? { label: 'Добавить участников', icon: 'userPlus', onClick: () => Modals.openAddMembers(chat.id) } : null,
    ]),
    { label: 'Поиск в чате', icon: 'search', onClick: () => openInChatSearch() },
    { label: info?.muted ? 'Включить уведомления' : 'Отключить уведомления', icon: info?.muted ? 'bell' : 'bellOff', onClick: () => toggleMute(chat.id) },
    { label: info?.pinned ? 'Открепить чат' : 'Закрепить чат', icon: 'pin', onClick: () => toggleChatPin(chat.id) },
    { type: 'sep' },
    { label: 'Очистить историю у себя', icon: 'archive', onClick: () => clearHistoryLocal() },
    { label: chat.type === 'dm' ? 'Удалить чат у себя' : 'Покинуть чат', icon: 'logout', danger: true, onClick: () => leaveCurrent(chat.id) },
  ].filter(Boolean), { anchor, align: 'right' });
}

async function toggleMute(chatId) {
  const chat = chatById(chatId);
  try {
    const res = await Api.chatPrefs(chatId, { muted: !chat.muted });
    patchChat(chatId, res);
    toast(res.muted ? 'Уведомления отключены' : 'Уведомления включены', { type: 'success', timeout: 1700 });
  } catch (err) { toastError(err); }
}

async function toggleChatPin(chatId) {
  const chat = chatById(chatId);
  try {
    const res = await Api.chatPrefs(chatId, { pinned: !chat.pinned });
    patchChat(chatId, res);
    toast(res.pinned ? 'Чат закреплён' : 'Чат откреплён', { type: 'success', timeout: 1700 });
  } catch (err) { toastError(err); }
}

async function clearHistoryLocal() {
  const ok = await confirmDialog({
    title: 'Очистить историю?',
    text: 'Сообщения этого чата исчезнут только у вас. У остальных участников они останутся.',
    confirmLabel: 'Очистить', danger: true,
  });
  if (!ok) return;
  const ids = state.messages.filter((m) => !m.pending).map((m) => m.id);
  state.messages = [];
  state.messageIds = new Set();
  renderMessages();
  for (const id of ids) await Api.deleteMessage(id, false).catch(() => {});
  toast('История очищена у вас', { type: 'success' });
}

async function leaveCurrent(chatId) {
  const chat = state.chat?.chat;
  const isOwner = state.chat?.role === 'owner' && chat?.type !== 'dm';
  const ok = await confirmDialog({
    title: isOwner ? 'Удалить чат для всех?' : chat?.type === 'dm' ? 'Удалить чат у себя?' : 'Покинуть чат?',
    text: isOwner ? 'Чат и все сообщения будут удалены для всех участников без возможности восстановления.' : 'История останется у других участников.',
    confirmLabel: isOwner ? 'Удалить для всех' : 'Подтвердить', danger: true,
  });
  if (!ok) return;
  try {
    await Api.deleteChat(chatId, isOwner);
    bus.emit('nav:go', '#/chats');
    close();
  } catch (err) { toastError(err); }
}

/* ───────────────────────── Поиск внутри чата ─────────────────────────── */

async function openInChatSearch() {
  let query = '';
  let results = [];
  const list = el('div', { class: 'col gap-2', style: 'max-height:52vh;overflow:auto' });
  const input = el('input', { class: 'input', placeholder: 'Поиск сообщений в этом чате', 'aria-label': 'Поиск сообщений' });
  const status = el('div', { class: 'small muted', style: 'min-height:18px' });
  const body = el('div', { class: 'col gap-3' }, input, status, list);

  const m = modal({ title: 'Поиск в чате', body, wide: true });
  const run = debounce(async () => {
    if (!query) { list.innerHTML = ''; status.textContent = ''; return; }
    status.textContent = 'Ищем…';
    try {
      const res = await api.get(`/api/search?q=${encodeURIComponent(query)}&type=messages`);
      results = res.messages.filter((x) => x.chatId === conv.chatId);
      status.textContent = results.length ? `Найдено: ${results.length}` : 'Ничего не найдено';
      list.innerHTML = results.map((r) => html`<button class="list-item" data-msg="${r.id}">
        <span class="ic">${raw(icons.chats)}</span>
        <span class="col grow" style="min-width:0">
          <span class="truncate">${highlight(r.text, query)}</span>
          <span class="sub">${fmtDayLabel(r.createdAt)} ${fmtTime(r.createdAt)}</span>
        </span></button>`).join('');
      list.querySelectorAll('[data-msg]').forEach((btn) => btn.addEventListener('click', () => {
        m.close();
        scrollToMessage(Number(btn.dataset.msg));
      }));
    } catch (err) { status.textContent = err.message; }
  }, 260);

  input.addEventListener('input', () => { query = input.value.trim(); run(); });
  setTimeout(() => input.focus(), 80);
}

export const highlight = (text, query) => esc(String(text || '').slice(0, 200))
  .replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');

/* ───────────────────────── Drag & drop файлов ───────────────────────── */

export function bindDropZone() {
  const pane = conv.host;
  const overlay = () => $('[data-drop]');
  let depth = 0;
  pane.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    overlay()?.classList.remove('hidden');
    $('.composer')?.classList.add('dragging');
  });
  pane.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { overlay()?.classList.add('hidden'); $('.composer')?.classList.remove('dragging'); } });
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay()?.classList.add('hidden');
    $('.composer')?.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });
}

/* ───────────────────────── Прочее ───────────────────────────────────── */

export function setDraft(chatId, text) {
  state.drafts[chatId] = text;
}

export function scrollToBottomIfNeeded() {
  if (isAtBottom(160)) scrollToBottom(true);
}

/** Кнопка «вниз» со счётчиком новых сообщений, пока пользователь читает историю. */
export function bumpUnseen(count) {
  const badge = $('[data-scroll-badge]');
  if (!badge) return;
  const current = Number(badge.textContent || 0) + count;
  badge.textContent = current > 99 ? '99+' : String(current);
  badge.classList.remove('hidden');
}

/** Аварии сети: сообщение не отправилось — показываем честный статус. */
export function connectionLabel() {
  const { connection, latency } = rtStatus();
  if (connection === 'connected') return `Подключено · ${latency || '—'} мс`;
  if (connection === 'polling') return 'Синхронизация через опрос';
  return 'Нет соединения';
}
