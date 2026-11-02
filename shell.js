/**
 * Каркас приложения: боковая навигация (rail), мобильная нижняя панель,
 * точка монтирования списка чатов и области диалога.
 */
import { $, $$, html, raw, haptic } from '../util.js';
import { icons } from '../icons.js';
import { state, bus } from '../store.js';
import { avatarHTML, contextMenu, toast } from '../ui.js?v=20261029-no-toasts-1';
import { Api } from '../api.js?v=20261102-gifts-2';

export const shell = {
  root: null,
  sidebar: null,
  conv: null,
  panelHost: null,
  nav: null,
  logoClicks: 0,
  logoTimer: null,
};
let unreadListenerBound = false;

const RAIL_ITEMS = [
  { id: 'chats', icon: 'chats', label: 'Чаты' },
  { id: 'search', icon: 'search', label: 'Поиск' },
  { id: 'settings', icon: 'user', label: 'Профиль' },
];

const MOBILE_ITEMS = [
  { id: 'chats', icon: 'chats', label: 'Чаты' },
  { id: 'search', icon: 'search', label: 'Поиск' },
  { id: 'settings', icon: 'user', label: 'Профиль' },
];

export function renderShell({ onNav }) {
  const root = document.getElementById('root');
  root.innerHTML = html`<div class="app" data-view="list">
    <aside class="rail" data-rail>
      <button class="logo" data-rail-logo title="Aurora Messenger" aria-label="Aurora Messenger">${raw(icons.logo)}</button>
      <nav class="rail-nav" data-rail-nav>
        ${RAIL_ITEMS.map((item) => html`<button class="rail-btn" data-nav="${item.id}" data-tip="${item.label}" data-tip-pos="right" aria-label="${item.label}">
          ${raw(icons[item.icon])}
          ${item.id === 'chats' ? html`<span class="badge hidden" data-nav-badge>0</span>` : ''}
        </button>`)}
      </nav>
      <div class="rail-bottom">
        <button class="rail-btn" data-tip="Тема" data-tip-pos="right" data-theme-toggle aria-label="Переключить тему">${raw(icons.moon)}</button>
        <button class="avatar-wrap" data-me-btn aria-label="Мой профиль" style="background:none">${avatarHTML({ name: state.user?.name, avatarUrl: state.user?.avatarUrl, color: state.user?.avatarColor, size: 'sm', presence: 'online' })}</button>
      </div>
    </aside>

    <section class="sidebar" data-sidebar></section>

    <main class="conv" data-conv></main>

    <nav class="mobile-nav" data-mobile-nav>
      ${MOBILE_ITEMS.map((item) => html`<button data-nav="${item.id}" aria-label="${item.label}">
        <span class="nm">${raw(icons[item.icon])}${item.id === 'chats' ? raw('<span class="badge hidden" data-nav-badge>0</span>') : ''}</span>
        <span>${item.label}</span>
      </button>`)}
    </nav>

  </div>`;

  shell.root = $('.app', root);
  shell.sidebar = $('[data-sidebar]', root);
  shell.conv = $('[data-conv]', root);
  shell.mobileNav = $('[data-mobile-nav]', root);
  shell.panelHost = shell.root; // правая панель встраивается как колонка сетки

  // Навигация: rail + нижняя панель
  root.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { haptic(6); onNav(nav.dataset.nav); return; }
  });

  $('[data-me-btn]', root).addEventListener('click', (e) => openProfileMenu(e.currentTarget));
  $('[data-theme-toggle]', root).addEventListener('click', toggleTheme);
  $('[data-rail-logo]', root).addEventListener('click', async () => {
    shell.logoClicks++;
    clearTimeout(shell.logoTimer);
    shell.logoTimer = setTimeout(() => { shell.logoClicks = 0; }, 1800);
    if (shell.logoClicks < 10) return onNav('chats');
    shell.logoClicks = 0;
    const password = window.prompt('Пароль администратора');
    if (!password) return;
    try {
      await Api.adminUnlock(password);
      location.hash = '#/admin';
    } catch (err) { toast(err.message, { type: 'error' }); }
  });

  syncThemeToggle();
  if (!unreadListenerBound) {
    unreadListenerBound = true;
    bus.on('unread:total', paintUnread);
  }
  paintUnread(state.unreadTotal);
  return shell;
}

function paintUnread(total) {
  $$('[data-nav-badge]').forEach((badge) => {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.classList.toggle('hidden', !total);
    if (total) { badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop'); }
  });
}

export function setNav(active) {
  $$('[data-nav]').forEach((btn) => btn.classList.toggle('active', btn.dataset.nav === active));
}

export function setView(view) {
  state.view = view;
  shell.root.dataset.view = view;
}

export function openProfileMenu(anchor) {
  const u = state.user;
  contextMenu([
    { type: 'label', label: u?.username ? `@${u.username}` : 'Профиль' },
    { label: 'Профиль и настройки', icon: 'user', onClick: () => bus.emit('nav:go', '#/settings') },
    { label: 'Редактировать профиль', icon: 'edit', onClick: () => bus.emit('profile:edit') },
    { type: 'sep' },
    { label: 'Выйти', icon: 'logout', danger: true, onClick: () => bus.emit('auth:logout') },
  ], { anchor, align: 'right' });
}

export function toggleTheme() {
  const order = ['dark', 'light', 'system'];
  const current = state.settings.theme || 'dark';
  const next = order[(order.indexOf(current) + 1) % order.length];
  bus.emit('settings:change', { theme: next });
  const labels = { dark: 'Тёмная тема', light: 'Светлая тема', system: 'Системная тема' };
  toast(labels[next], { type: 'info', timeout: 1600 });
  syncThemeToggle();
}

export function syncThemeToggle() {
  const btn = $('[data-theme-toggle]');
  if (!btn) return;
  const theme = state.settings.theme || 'dark';
  btn.innerHTML = icons[theme === 'light' ? 'sun' : theme === 'system' ? 'monitor' : 'moon'];
  btn.dataset.tip = theme === 'light' ? 'Светлая' : theme === 'system' ? 'Системная' : 'Тёмная';
}

export function refreshMeAvatar() {
  const host = $('[data-me-btn]');
  if (host) host.innerHTML = avatarHTML({ name: state.user?.name, avatarUrl: state.user?.avatarUrl, color: state.user?.avatarColor, size: 'sm', presence: 'online' });
}
