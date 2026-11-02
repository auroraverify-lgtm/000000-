/**
 * Список чатов: поиск, фильтры, закреплённые, непрочитанные, контекстные действия.
 * Рендер оптимизирован: при обновлении одного чата список не пересобирается целиком без нужды.
 */
import { $, $$, el, esc, html, raw, debounce, fmtListTime, haptic } from '../util.js';
import { icons } from '../icons.js';
import { premiumBadgeHTML } from '../premium.js?v=20261031-verified-badge-1';
import { state, bus, chatById, patchChat, removeChat, sortChats } from '../store.js';
import { avatarHTML, contextMenu, toast, toastError, confirmDialog, skeletonList, stateScreen } from '../ui.js?v=20261029-no-toasts-1';
import { Api } from '../api.js?v=20261102-gifts-2';
import { shell } from './shell.js?v=20261028-ux-1';
import * as Stories from './stories.js?v=20261104-stories-v2-2';

export const chatList = { filter: 'all', query: '', mounted: false, el: null, listEl: null };

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'unread', label: 'Непрочитанные' },
  { id: 'dm', label: 'Личные' },
  { id: 'group', label: 'Группы' },
  { id: 'channel', label: 'Каналы' },
  { id: 'archived', label: 'Архив' },
];

/** Текст превью последнего сообщения (единая логика для списка и уведомлений). */
export function previewText(last, chat) {
  if (!last) return { html: 'Нет сообщений', dim: true };
  const author = chat.type === 'dm' ? '' : last.fromMe ? 'Вы: ' : (last.senderName ? `${last.senderName}: ` : '');
  let body = '';
  let icon = null;
  switch (last.type) {
    case 'photo': icon = 'image'; body = last.text || 'Фото'; break;
    case 'video': icon = 'video'; body = last.text || 'Видео'; break;
    case 'voice': icon = 'mic'; body = 'Голосовое сообщение'; break;
    case 'file': icon = 'file'; body = last.text || 'Файл'; break;
    case 'sticker': icon = 'sticker'; body = last.text || 'Стикер'; break;
    default: body = String(last.text || '').replace(/\n/g, ' ');
  }
  return {
    html: `${esc(author)}${icon ? `<span class="ic" style="display:inline-block;vertical-align:-2px">${icons[icon]}</span> ` : ''}${esc(body.slice(0, 120))}`,
    dim: false,
  };
}

export function mount() {
  if (chatList.mounted) return;
  chatList.mounted = true;
  const host = shell.sidebar;
  host.innerHTML = html`<div class="sb-head">
      <div class="sb-title">
        <h1>Чаты</h1>
        <button class="icon-btn" data-new-chat data-tip="Новый чат" aria-label="Новый чат">${raw(icons.edit)}</button>
        <button class="icon-btn" data-create-menu data-tip="Создать" aria-label="Создать">${raw(icons.plus)}</button>
      </div>
      <div class="sb-search">
        ${raw(icons.search)}
        <input class="input" data-chat-search placeholder="Поиск по чатам" aria-label="Поиск по чатам" autocomplete="off">
        <button class="clear hidden" data-clear-search aria-label="Очистить">${raw(icons.close)}</button>
      </div>
    </div>
    <div class="sb-filters" data-filters>
      ${FILTERS.map((f) => html`<button class="filter-chip" data-filter="${f.id}" aria-pressed="${f.id === 'all'}">${f.label}</button>`)}
    </div>
    <div data-story-bar></div>
    <div class="sb-list scroll-y" data-chat-list>
      ${skeletonList(7)}
    </div>`;

  chatList.el = host;
  chatList.listEl = $('[data-chat-list]', host);
  Stories.mount($('[data-story-bar]', host));

  const search = $('[data-chat-search]', host);
  const clear = $('[data-clear-search]', host);
  const runSearch = debounce(() => { chatList.query = search.value.trim(); render(); }, 160);
  search.addEventListener('input', () => {
    clear.classList.toggle('hidden', !search.value);
    runSearch();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && search.value.trim()) {
      bus.emit('nav:go', `#/search?q=${encodeURIComponent(search.value.trim())}`);
    }
  });
  clear.addEventListener('click', () => { search.value = ''; clear.classList.add('hidden'); chatList.query = ''; render(); search.focus(); });

  $('[data-filters]', host).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    chatList.filter = btn.dataset.filter;
    $$('[data-filter]', host).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    haptic(5);
    render();
  });

  host.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-chat-id]');
    if (item) { openFromList(Number(item.dataset.chatId)); return; }
    const action = e.target.closest('[data-empty-action]');
    if (action) {
      if (action.dataset.emptyAction === 'new') bus.emit('create:dm');
      if (action.dataset.emptyAction === 'search') bus.emit('nav:go', '#/search');
    }
  });

  host.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('[data-chat-id]');
    if (!item) return;
    e.preventDefault();
    openChatMenu(Number(item.dataset.chatId), e.clientX, e.clientY);
  });
  // Долгое нажатие на телефоне = контекстное меню
  let pressTimer = null;
  host.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('[data-chat-id]');
    if (!item || e.pointerType === 'mouse') return;
    pressTimer = setTimeout(() => { haptic(12); openChatMenu(Number(item.dataset.chatId), e.clientX, e.clientY); }, 480);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => host.addEventListener(ev, () => clearTimeout(pressTimer)));

  $('[data-new-chat]', host).addEventListener('click', () => bus.emit('create:dm'));
  $('[data-create-menu]', host).addEventListener('click', (event) => {
    const anchor = event.currentTarget;
    contextMenu([
      { label: 'Создать группу', icon: 'users', onClick: () => bus.emit('create:group') },
      { label: 'Создать канал', icon: 'megaphone', onClick: () => bus.emit('create:channel') },
      { type: 'sep' },
      { label: 'Найти человека', icon: 'search', onClick: () => bus.emit('create:dm') },
    ], { anchor, align: 'right' });
  });

  bus.on('chats', render);
  bus.on('chat:active', render);
  bus.on('members:any', render);
  render();
}

export function show() {
  if (shell.sidebar) shell.sidebar.style.display = '';
}

function filtered() {
  const q = chatList.query.toLowerCase();
  return state.chats.filter((chat) => {
    if (chatList.filter === 'archived' && !chat.archived) return false;
    if (chatList.filter !== 'archived' && chat.archived) return false;
    if (chatList.filter === 'unread' && !chat.unread) return false;
    if (chatList.filter === 'dm' && chat.type !== 'dm') return false;
    if (chatList.filter === 'group' && chat.type !== 'group') return false;
    if (chatList.filter === 'channel' && chat.type !== 'channel') return false;
    if (!q) return true;
    const haystack = [chat.title, chat.username, chat.peer?.username, chat.description, chat.lastMessage?.text]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

export function render() {
  if (!chatList.mounted || !chatList.listEl) return;
  const items = filtered();

  if (!state.chatsLoaded) {
    chatList.listEl.innerHTML = skeletonList(7);
    return;
  }

  if (!items.length) {
    const isBase = !chatList.query && chatList.filter === 'all';
    chatList.listEl.innerHTML = isBase
      ? stateScreen({
        icon: 'chats',
        title: 'Пока здесь нет чатов',
        text: 'Начните первое общение — найдите человека по username или создайте группу.',
        actions: [
          { id: 'new', label: 'Начать общение', kind: 'primary' },
          { id: 'search', label: 'Найти людей', kind: 'ghost' },
        ],
      })
      : stateScreen({
        icon: chatList.query ? 'search' : 'filter',
        title: chatList.query ? 'Ничего не найдено' : 'Здесь пусто',
        text: chatList.query ? `По запросу «${chatList.query}» среди ваших чатов ничего нет.` : 'В этой категории пока нет чатов.',
        actions: chatList.query ? [{ id: 'search', label: 'Искать везде', kind: 'primary' }] : [{ id: 'new', label: 'Начать общение', kind: 'ghost' }],
      });
    return;
  }

  const activeId = state.chat?.chat.id;
  const sections = { pinned: [], rest: [] };
  for (const chat of items) (chat.pinned ? sections.pinned : sections.rest).push(chat);

  const renderSection = (list, title, startIndex) => (!list.length ? '' : html`
    ${title ? html`<div class="sb-section">${title}</div>` : ''}
    ${raw(list.map((chat, i) => chatItemHTML(chat, activeId, startIndex + i)).join(''))}`);

  chatList.listEl.innerHTML = `${renderSection(sections.pinned, sections.pinned.length ? 'Закреплённые' : '', 0)}${renderSection(sections.rest, sections.pinned.length ? 'Все чаты' : '', sections.pinned.length)}`;
}

function chatItemHTML(chat, activeId, index) {
  const last = chat.lastMessage;
  const preview = previewText(last, chat);
  const unread = chat.unread > 0;
  const dim = index > 11 ? 'animation-delay:.24s' : `animation-delay:${Math.min(index * 26, 240)}ms`;
  const peerPresence = chat.type === 'dm' ? state.presence[chat.peer?.id]?.presence || chat.peer?.presence : null;
  const isSupportBot = chat.type === 'dm' && chat.peer?.username === 'aurora_support' && chat.peer?.isBot;
  const nameIcon = chat.type === 'group' ? icons.users : chat.type === 'channel' ? icons.megaphone : '';

  return html`<div class="chat-item anim-list ${unread ? 'unread' : ''} ${chat.id === activeId ? 'active' : ''}"
      data-chat-id="${chat.id}" role="button" tabindex="0" style="${dim}" aria-label="${chat.title}">
    ${chat.type === 'dm'
      ? avatarHTML({ name: chat.peer?.name || chat.title, avatarUrl: chat.peer?.avatarUrl, color: chat.peer?.avatarColor, presence: peerPresence === 'online' ? 'online' : null })
      : avatarHTML({ name: chat.title, avatarUrl: chat.avatarUrl, color: chat.type === 'channel' ? 'ocean' : 'indigo', rounded: true })}
    <div class="body">
      <div class="top">
        <span class="name truncate">
          ${nameIcon ? raw(`<span class="type-ic">${nameIcon}</span>`) : ''}${chat.title}${chat.type === 'dm' ? raw(premiumBadgeHTML(chat.peer)) : ''}${isSupportBot ? raw('<span class="bot-badge">ОФИЦИАЛЬНЫЙ</span>') : ''}
          ${chat.username ? raw(`<span class="mute tiny"> @${esc(chat.username)}</span>`) : ''}
        </span>
        <span class="time">
          ${chat.pinned && !chat.unread ? raw(`<span class="ic" style="width:12px;height:12px;color:var(--text-mute)">${icons.pin}</span>`) : ''}
          ${fmtListTime(last?.createdAt || chat.createdAt)}
        </span>
      </div>
      <div class="top">
        <span class="preview grow">
          ${last?.fromMe ? raw(`<span class="ic" style="display:inline-flex;width:14px;height:14px">${icons.doubleCheck}</span>`) : ''}
          <span class="txt truncate">${raw(preview.html)}</span>
        </span>
        <span class="meta">
          ${unread ? html`<span class="badge ${chat.muted ? 'muted-badge' : ''}" data-unread>${unread > 99 ? '99+' : unread}</span>` : ''}
          ${chat.muted ? raw(`<span class="muted-ic">${icons.bellOff}</span>`) : ''}
        </span>
      </div>
    </div>
  </div>`;
}

/** Короткая пульсация нового чата в списке. */
export function pulse(chatId) {
  requestAnimationFrame(() => {
    const node = chatList.listEl?.querySelector(`[data-chat-id="${chatId}"]`);
    if (!node) return;
    node.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' },
    );
  });
}

async function openFromList(chatId) {
  haptic(6);
  bus.emit('chat:open', chatId);
  bus.emit('nav:go', `#/chat/${chatId}`);
  // На мобильных сразу переключаем экран, не дожидаясь сети
  if (!window.matchMedia('(min-width: 981px)').matches) {
    shell.root.dataset.view = 'chat';
    state.view = 'chat';
  }
}

export function openChatMenu(chatId, x, y) {
  const chat = chatById(chatId);
  if (!chat) return;
  const isAdmin = ['owner', 'admin'].includes(chat.role);
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
  contextMenu([
    { type: 'label', label: chat.title },
    { label: chat.unread ? 'Отметить прочитанным' : 'Отметить непрочитанным', icon: 'check', onClick: () => toggleRead(chatId) },
    { label: chat.pinned ? 'Открепить' : 'Закрепить', icon: 'pin', onClick: () => setPref(chatId, { pinned: !chat.pinned }) },
    { label: chat.muted ? 'Включить уведомления' : 'Отключить уведомления', icon: chat.muted ? 'bell' : 'bellOff', onClick: () => setPref(chatId, { muted: !chat.muted }) },
    { label: chat.archived ? 'Вернуть из архива' : 'В архив', icon: 'archive', onClick: () => setPref(chatId, { archived: !chat.archived }) },
    { type: 'sep' },
    { label: 'Информация', icon: 'info', onClick: () => bus.emit('panel:open', { chatId }) },
    chat.type === 'channel' && chat.username ? { label: 'Скопировать ссылку', icon: 'link', onClick: () => copyLink(chat) } : null,
    { type: 'sep' },
    chat.type === 'dm'
      ? { label: 'Удалить чат у себя', icon: 'trash', danger: true, onClick: () => leaveChat(chatId) }
      : { label: isAdmin && chat.role === 'owner' ? 'Удалить для всех' : 'Покинуть чат', icon: 'logout', danger: true, onClick: () => leaveChat(chatId, isAdmin) },
  ], { x, y, anchor, align: 'auto' });
}

async function toggleRead(chatId) {
  const chat = chatById(chatId);
  if (!chat) return;
  if (chat.unread) { await Api.markRead(chatId, chat.lastSeq || 0); patchChat(chatId, { unread: 0 }); }
  else {
    // «Непрочитанным» чат становится только визуально: курсор не двигаем, а счётчик показываем локально
    patchChat(chatId, { unread: 1 });
  }
}

async function setPref(chatId, prefs) {
  try {
    const res = await Api.chatPrefs(chatId, prefs);
    patchChat(chatId, res);
    if (prefs.archived !== undefined) toast(prefs.archived ? 'Чат в архиве' : 'Чат возвращён', { type: 'success', timeout: 1800 });
  } catch (err) { toastError(err); }
}

function copyLink(chat) {
  const url = `${location.origin}${location.pathname}#/join/${chat.username}`;
  navigator.clipboard?.writeText(url).then(
    () => toast('Ссылка скопирована', { type: 'success', timeout: 1800 }),
    () => toast(url, { timeout: 6000 }),
  );
}

async function leaveChat(chatId, canHardDelete = false) {
  const chat = chatById(chatId);
  if (!chat) return;
  const isOwner = chat.role === 'owner' && chat.type !== 'dm' && canHardDelete;
  const ok = await confirmDialog({
    title: isOwner ? 'Удалить чат для всех?' : chat.type === 'dm' ? 'Удалить чат у себя?' : 'Покинуть чат?',
    text: isOwner
      ? 'Чат, все сообщения и медиа будут удалены для всех участников. Это действие необратимо.'
      : chat.type === 'dm'
        ? 'Переписка исчезнет из списка. Собеседник сможет снова написать вам — история сохранится.'
        : 'Вы перестанете получать сообщения этого чата. Вернуться можно по ссылке или через поиск.',
    confirmLabel: isOwner ? 'Удалить для всех' : 'Подтвердить',
    danger: true,
  });
  if (!ok) return;
  try {
    await Api.deleteChat(chatId, isOwner);
    removeChat(chatId);
    toast(isOwner ? 'Чат удалён' : 'Готово', { type: 'success' });
  } catch (err) { toastError(err); }
}
