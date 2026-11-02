/**
 * Глобальный поиск: пользователи, группы, каналы, сообщения и медиа.
 * Живой поиск с дебаунсом, подсветкой совпадений и переходом прямо к сообщению.
 */
import { $, $$, el, esc, html, raw, debounce, fmtDayLabel, fmtTime, fmtBytes } from '../util.js';
import { icons } from '../icons.js';
import { premiumBadgeHTML } from '../premium.js?v=20261031-verified-badge-1';
import { state, bus } from '../store.js';
import { avatarHTML, stateScreen, skeletonList, toast, toastError } from '../ui.js?v=20261029-no-toasts-1';
import { Api } from '../api.js?v=20261102-gifts-2';
import { shell } from './shell.js?v=20261028-ux-1';
import * as Modals from './modals.js';
import * as Panels from './panels.js?v=20261029-group-topics-2';

export const search = { el: null, query: '', type: 'all', results: null, loading: false, mounted: false };

const TABS = [
  { id: 'all', label: 'Всё' },
  { id: 'users', label: 'Люди' },
  { id: 'chats', label: 'Группы и каналы' },
  { id: 'messages', label: 'Сообщения' },
  { id: 'media', label: 'Медиа' },
];

export function mount() {
  if (search.mounted) return;
  search.mounted = true;
  const host = document.getElementById('root');
  const container = el('section', { class: 'search-screen', 'data-search-screen': '' });
  container.innerHTML = html`
    <div class="search-head">
      <div class="row gap-3">
        <button class="icon-btn" data-search-back aria-label="Назад">${raw(icons.back)}</button>
        <h2 style="font-size:var(--t-xl);font-weight:700">Поиск</h2>
      </div>
      <div class="search-field">
        ${raw(icons.search)}
        <input class="input" id="search-input" data-search-input placeholder="Люди, группы, каналы, сообщения…" autocomplete="off" aria-label="Поисковый запрос">
      </div>
      <div class="search-tabs" data-search-tabs>
        ${TABS.map((t) => html`<button class="filter-chip" data-tab="${t.id}" aria-pressed="${t.id === 'all'}">${t.label}</button>`)}
      </div>
    </div>
    <div class="search-results scroll-y" data-search-results></div>`;
  host.append(container);
  search.el = container;

  const input = $('[data-search-input]', container);
  const results = $('[data-search-results]', container);

  const run = debounce(async () => {
    const q = input.value.trim();
    search.query = q;
    if (!q) { search.results = null; render(); return; }
    search.loading = true; render();
    try {
      search.results = await Api.search(q, search.type === 'media' ? 'media' : search.type);
    } catch (err) {
      search.results = { error: err };
    } finally {
      search.loading = false; render();
    }
  }, 240);

  input.addEventListener('input', () => run());
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') showList(); });
  $('[data-search-back]', container).addEventListener('click', () => showList());
  $('[data-search-tabs]', container).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    search.type = tab.dataset.tab;
    $$('[data-tab]', container).forEach((b) => b.setAttribute('aria-pressed', String(b === tab)));
    if (search.query) run();
  });

  results.addEventListener('click', async (e) => {
    const user = e.target.closest('[data-user-id]');
    if (user) { Panels.showUserProfile(Number(user.dataset.userId)); return; }
    const chat = e.target.closest('[data-chat-open]');
    if (chat) {
      const { chatOpen } = chat.dataset;
      if (chat.dataset.joined === '1') bus.emit('nav:go', `#/chat/${chatOpen}`);
      else {
        try {
          const res = await Api.joinChat(chat.dataset.username);
          if (res.requestPending) {
            toast('Заявка отправлена администраторам на рассмотрение', { type: 'success' });
            return;
          }
          toast(`Вы присоединились: ${res.chat.title}`, { type: 'success' });
          bus.emit('nav:go', `#/chat/${res.chat.id}`);
        } catch (err) { toastError(err); }
      }
      return;
    }
    const msg = e.target.closest('[data-msg-id]');
    if (msg) {
      const chatId = Number(msg.dataset.chatId);
      const messageId = Number(msg.dataset.msgId);
      bus.emit('nav:go', `#/chat/${chatId}`);
      setTimeout(() => bus.emit('message:focus', messageId), 260);
      return;
    }
    const write = e.target.closest('[data-write-to]');
    if (write) { Modals.openDmWith(Number(write.dataset.writeTo)); }
  });

  bus.on('search:focus', () => { input.focus(); input.select(); });
}

export function show(initialQuery = '') {
  mount();
  shell.sidebar.style.display = 'none';
  shell.conv.style.display = 'none';
  search.el.classList.remove('hidden');
  const input = $('[data-search-input]', search.el);
  if (initialQuery && input.value !== initialQuery) {
    input.value = initialQuery;
    search.query = initialQuery;
    Api.search(initialQuery, search.type).then((r) => { search.results = r; render(); }).catch(() => {});
  }
  if (window.matchMedia('(min-width: 981px)').matches) {
    setTimeout(() => input.focus(), 80);
  }
  render();
}

export function hide() {
  search.el?.classList.add('hidden');
  shell.sidebar.style.display = '';
  shell.conv.style.display = '';
}

function showList() {
  bus.emit('nav:go', '#/chats');
}

function render() {
  const host = $('[data-search-results]', search.el);
  if (!host) return;

  if (!search.query) {
    const recent = state.chats.slice(0, 6);
    host.innerHTML = html`
      <div class="result-group">
        <h4>Подсказки</h4>
        <div class="col gap-2">
          ${raw([['@username', 'Найти человека по username'], ['🔥', 'Поиск по сообщениям'], ['#aurora', 'Публичные каналы']]
    .map(([q, label]) => html`<button class="list-item" data-hint="${q}">
            <span class="ic">${raw(icons.search)}</span><span class="grow">${label}</span><span class="mute small">${q}</span></button>`).join(''))}
        </div>
      </div>
      ${recent.length ? html`<div class="result-group">
        <h4>Недавние чаты</h4>
        <div class="col gap-1">${recent.map((chat) => html`<button class="list-item" data-chat-open="${chat.id}" data-joined="1">
          ${raw(avatarHTML({ name: chat.title, avatarUrl: chat.avatarUrl || chat.peer?.avatarUrl, color: chat.peer?.avatarColor || (chat.type === 'channel' ? 'ocean' : 'indigo'), size: 'sm', rounded: chat.type !== 'dm' }))}
          <span class="col grow" style="min-width:0"><span class="title truncate">${chat.title}</span>
          <span class="sub truncate">${chat.type === 'dm' ? 'Личный чат' : chat.type === 'group' ? 'Группа' : 'Канал'}</span></span>
        </button>`)}</div>
      </div>` : ''}`;
    host.querySelectorAll('[data-hint]').forEach((btn) => btn.addEventListener('click', () => {
      const input = $('[data-search-input]', search.el);
      input.value = btn.dataset.hint.replace(/^[@#]/, '');
      input.dispatchEvent(new Event('input'));
    }));
    return;
  }

  if (search.loading && !search.results) { host.innerHTML = skeletonList(5); return; }
  const r = search.results;
  if (!r) return;
  if (r.error) {
    host.innerHTML = stateScreen({
      icon: 'alert', tone: 'error', title: 'Поиск недоступен', text: r.error.message,
      actions: [{ id: 'retry', label: 'Повторить', kind: 'primary' }],
    });
    return;
  }

  const showUsers = search.type === 'all' || search.type === 'users';
  const showChats = search.type === 'all' || search.type === 'chats';
  const showMessages = search.type === 'all' || search.type === 'messages' || search.type === 'media';
  const hasAny = (showUsers && r.users.length) || (showChats && r.chats.length) || (showMessages && r.messages.length);

  if (!hasAny) {
    host.innerHTML = stateScreen({
      icon: 'search',
      title: 'Ничего не найдено',
      text: `По запросу «${search.query}» результатов нет. Попробуйте другое слово или проверьте написание username.`,
    });
    return;
  }

  host.innerHTML = html`
    ${showUsers && r.users.length ? html`<div class="result-group">
      <h4>Люди · ${r.users.length}</h4>
      <div class="col gap-1">${raw(r.users.map(userRow).join(''))}</div>
    </div>` : ''}
    ${showChats && r.chats.length ? html`<div class="result-group">
      <h4>Группы и каналы · ${r.chats.length}</h4>
      <div class="col gap-1">${raw(r.chats.map(chatRow).join(''))}</div>
    </div>` : ''}
    ${showMessages && r.messages.length ? html`<div class="result-group">
      <h4>${search.type === 'media' ? 'Медиа' : 'Сообщения'} · ${r.messages.length}</h4>
      <div class="col gap-1">${raw(r.messages.map(messageRow).join(''))}</div>
    </div>` : ''}`;
}

const hl = (text, query) => esc(String(text || '').slice(0, 220))
  .replace(new RegExp(`(${String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');

const userRow = (u) => html`<div class="list-item" data-user-id="${u.id}" role="button">
  ${raw(avatarHTML({ name: u.name, avatarUrl: u.avatarUrl, color: u.avatarColor, presence: u.online ? 'online' : null }))}
  <span class="col grow" style="min-width:0">
    <span class="title truncate">${hl(u.name, search.query)}${raw(premiumBadgeHTML(u))}</span>
    <span class="sub truncate">@${hl(u.username, search.query)}${u.bio ? ` · ${esc(u.bio).slice(0, 60)}` : ''}</span>
  </span>
  <button class="btn btn-sm btn-primary" data-write-to="${u.id}">Написать</button>
</div>`;

const chatRow = (c) => html`<div class="list-item" data-chat-open="${c.id}" data-joined="${c.isMember ? 1 : 0}" data-username="${esc(c.username || '')}" role="button">
  ${raw(avatarHTML({ name: c.title, avatarUrl: c.avatarUrl, color: c.type === 'channel' ? 'ocean' : 'indigo', rounded: true }))}
  <span class="col grow" style="min-width:0">
    <span class="title truncate">${c.type === 'channel' ? raw(`<span class="type-ic">${icons.megaphone}</span>`) : ''}${hl(c.title, search.query)}</span>
    <span class="sub truncate">${c.isMember ? 'Вы участник' : 'Публичный'}${c.username ? ` · @${esc(c.username)}` : ''} · ${c.memberCount} ${c.type === 'channel' ? 'подписчиков' : 'участников'}</span>
  </span>
  <span class="chip ${c.isMember ? '' : 'accent'}">${c.isMember ? 'Открыть' : 'Войти'}</span>
</div>`;

const messageRow = (m) => html`<div class="list-item" data-msg-id="${m.id}" data-chat-id="${m.chatId}" role="button">
  ${raw(avatarHTML({ name: m.chatTitle, avatarUrl: m.chatAvatar, size: 'sm', rounded: m.chatType !== 'dm' }))}
  <span class="col grow" style="min-width:0">
    <span class="title truncate">${hl(m.chatTitle || 'Чат', search.query)}</span>
    <span class="sub truncate">${m.hasMedia ? raw(`<span class="ic" style="display:inline-flex;width:14px;height:14px">${icons[m.type === 'photo' ? 'image' : m.type === 'video' ? 'video' : 'file']}</span>`) : ''}${hl(m.text, search.query)}</span>
  </span>
  <span class="tiny mute">${fmtDayLabel(m.createdAt)}</span>
</div>`;
