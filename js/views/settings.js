/**
 * Настройки: аккаунт, уведомления, приватность, внешний вид (темы, размер текста,
 * анимации, обои), данные и сессии. Все изменения применяются мгновенно и сохраняются на сервере.
 */
import { $, $$, el, esc, html, raw, debounce, fmtBytes, store9 } from '../util.js';
import { icons } from '../icons.js';
import { state, bus } from '../store.js';
import { avatarHTML, profileHeroHTML, contextMenu, toast, toastError, confirmDialog, promptDialog, modal, AVATAR_COLORS } from '../ui.js?v=20261029-no-toasts-1';
import { Api } from '../api.js?v=20261102-gifts-2';
import { shell } from './shell.js?v=20261028-ux-1';
import * as Modals from './modals.js?v=20261028-ux-1';
import { WALLPAPERS, ACCENTS } from './theme-options.js?v=20261028-ux-1';
import { rtStatus } from '../realtime.js';

export const settingsView = { el: null, mounted: false };
let section = null; // null — главный экран, иначе id раздела
let interactionVersion = 0;
let securityState = { sessions: [], twoFactor: false, protectivePassword: false, protectivePasswordSetupRequired: false, pushNotifications: false };

const PRIVACY_OPTIONS = [
  { id: 'everyone', label: 'Все' },
  { id: 'contacts', label: 'Общие контакты' },
  { id: 'nobody', label: 'Никто' },
];
async function requestAccountVerification(kind) {
  try {
    const result = await Api.requestSecurityVerification(kind);
    const current = state.user.securityVerification || { phone: false, official: false, pending: [] };
    state.user.securityVerification = {
      ...current,
      pending: [...(current.pending || []).filter((item) => item.kind !== kind), result.request],
    };
    toast('Заявка отправлена в Aurora Security', { type: 'success' });
    render();
  } catch (error) {
    toastError(error.message);
  }
}

function verificationLabel(kind) {
  const verification = state.user?.securityVerification;
  if (!verification) return 'Не подтверждено · подать заявку';
  if (verification[kind]) return 'Подтверждено';
  if ((verification.pending || []).some((item) => item.kind === kind)) return 'Заявка на рассмотрении';
  return 'Не подтверждено · подать заявку';
}

export function mountReady() {
  if (settingsView.mounted) return;
  settingsView.mounted = true;
  const container = el('section', { class: 'settings-screen', 'data-settings-screen': '' });
  container.classList.add('hidden');
  container.addEventListener('pointerdown', () => { interactionVersion += 1; }, true);
  container.addEventListener('keydown', () => { interactionVersion += 1; }, true);
  document.getElementById('root').append(container);
  settingsView.el = container;
  bus.on('settings:applied', () => { if (!container.classList.contains('hidden')) render(); });
  bus.on('user:updated', () => { if (!container.classList.contains('hidden')) render(); });
}

export function show() {
  mountReady();
  interactionVersion += 1;
  shell.sidebar.style.display = 'none';
  shell.conv.style.display = 'none';
  settingsView.el.classList.remove('hidden');
  section = null;
  render();
  loadSecurity();
}

export function hide() {
  interactionVersion += 1;
  section = null;
  settingsView.el?.classList.add('hidden');
  shell.sidebar.style.display = '';
  shell.conv.style.display = '';
}

// ── Иконки разделов (в стиле Telegram: цветные плитки с белым значком) ────
const ICON_PATHS = {
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  drop: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M12 18h.01"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4"/><path d="M18 5l3 3"/><path d="M15 8l3 3"/>',
  mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/>',
  slash: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  megaphone: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
};
const svgIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
const ico = (name, color = 'blue', size = '') => html`<span class="st-ico ${size}" data-c="${color}">${raw(svgIcon(name))}</span>`;

const SECTIONS = {
  account: { title: 'Аккаунт', icon: 'user', color: 'blue', note: 'Имя, username, почта и пароль вашего профиля.' },
  notifications: { title: 'Уведомления', icon: 'bell', color: 'red', note: 'Выберите, о чём и как Aurora будет вам напоминать.' },
  privacy: { title: 'Конфиденциальность', icon: 'lock', color: 'green', note: 'Решайте, кто может писать вам, видеть ваш профиль и добавлять вас в группы.' },
  security: { title: 'Безопасность', icon: 'shield', color: 'indigo', note: 'Защита входа, устройства и активные сеансы.' },
  data: { title: 'Данные и память', icon: 'database', color: 'teal', note: 'Загрузки, лимиты файлов и состояние соединения.' },
  appearance: { title: 'Внешний вид', icon: 'drop', color: 'purple', note: 'Тема, акцентный цвет, обои чатов и размер текста.' },
  about: { title: 'О приложении', icon: 'info', color: 'gray', note: 'Aurora Messenger — личные чаты, группы и каналы.' },
};

const ROW_ICONS = {
  'Premium и Авроры': ['star', 'gold'], 'Имя': ['user', 'blue'], 'Username': ['at', 'cyan'],
  'Описание профиля': ['edit', 'orange'], 'Статус': ['smile', 'amber'], 'Пароль': ['key', 'gray'],
  'E-mail': ['mail', 'blue'], 'Системные уведомления': ['bell', 'red'], 'Заблокированные': ['slash', 'red'],
  'Лимиты загрузок': ['upload', 'teal'], 'Мои загрузки': ['image', 'green'], 'Активные сеансы': ['phone', 'orange'],
  'Двухфакторная аутентификация': ['shield', 'green'], 'Защитный пароль': ['lock', 'indigo'],
  'Проверка телефона': ['phone', 'green'], 'Официальный аккаунт': ['shield', 'blue'],
  'Соединение': ['wifi', 'blue'], 'Выйти со всех устройств': ['logout', 'red'],
  'Сообщения': ['message', 'blue'], 'Группы': ['users', 'green'], 'Каналы': ['megaphone', 'orange'],
  'Звук': ['volume', 'red'], 'Вибрация': ['phone', 'purple'], 'Показывать текст': ['eye', 'gray'],
  'Анимации': ['zap', 'purple'], 'Компактный режим': ['list', 'teal'],
  'Кто может писать мне': ['message', 'blue'], 'Кто видит профиль': ['eye', 'green'],
  'Кто может добавлять в группы': ['users', 'orange'], 'Кто видит статус': ['smile', 'amber'],
};
const rowIco = (label) => (ROW_ICONS[label] ? ico(...ROW_ICONS[label]) : '');

const rowHandlers = new Map();

function go(next) {
  interactionVersion += 1;
  section = next;
  render();
  if (settingsView.el) settingsView.el.scrollTop = 0;
}

async function logoutEverywhere() {
  const ok = await confirmDialog({
    title: 'Выйти со всех устройств?',
    text: 'Все другие сессии будут завершены. Текущее устройство останется в аккаунте.',
    confirmLabel: 'Выйти везде', danger: true,
  });
  if (!ok) return;
  try {
    const res = await Api.logoutDevices();
    const { setToken } = await import('../api.js');
    setToken(res.token);
    const RT = await import('../realtime.js');
    RT.disconnect(); RT.connect();
    toast('Другие сессии завершены', { type: 'success' });
  } catch (err) { toastError(err); }
}

function render() {
  const host = settingsView.el;
  if (!host) return;
  const top = host.scrollTop;
  rowHandlers.clear();
  host.innerHTML = section && SECTIONS[section] ? subHTML() : mainHTML();
  bind();
  host.scrollTop = top;
}

// ── Главный экран: профиль + список разделов ─────────────────────────────
function mainHTML() {
  const u = state.user;
  const sessions = securityState.sessions.length;
  return html`<div class="settings-inner">
    <div class="settings-head">
      <button class="icon-btn" data-back aria-label="Назад">${raw(icons.back)}</button>
      <h2>Профиль</h2>
      <button class="icon-btn" data-edit-profile aria-label="Редактировать профиль">${raw(icons.edit)}</button>
    </div>

    ${profileHeroHTML(u, { sub: 'в сети', presence: 'online' })}

    <div class="tg-actions">
      <button class="tg-action" data-edit-profile>${raw(icons.edit)}<span>Изменить</span></button>
      <button class="tg-action" data-style-profile>${raw(icons.palette)}<span>Оформление</span></button>
      <button class="tg-action" data-nav-commerce>${raw(icons.sparkles)}<span>Premium</span></button>
    </div>

    <div class="tg-info">
      ${u.bio ? html`<div class="tg-info-row"><span class="tg-info-val">${u.bio}</span><span class="tg-info-lbl">О себе</span></div>` : ''}
      <div class="tg-info-row"><span class="tg-info-val">@${u.username}</span><span class="tg-info-lbl">Username</span></div>
      ${u.email ? html`<div class="tg-info-row"><span class="tg-info-val">${u.email}</span><span class="tg-info-lbl">Почта</span></div>` : ''}
      ${u.statusText ? html`<div class="tg-info-row"><span class="tg-info-val">${u.statusText}</span><span class="tg-info-lbl">Статус</span></div>` : ''}
    </div>

    <div class="settings-group">
      <div class="settings-card st-menu">
        ${navRow('account', `@${u.username}`)}
        ${navRow('notifications')}
        ${navRow('privacy')}
        ${navRow('security', securityState.twoFactor ? 'Двухфакторная защита включена' : sessions ? `Устройств: ${sessions}` : '')}
        ${navRow('data')}
        ${navRow('appearance')}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-card st-menu">
        ${row('Premium и Авроры', 'Подписка, баланс и цифровые подарки', () => bus.emit('nav:go', '#/commerce'))}
        ${navRow('about')}
      </div>
    </div>

    <button class="btn btn-danger btn-block st-logout" data-logout>${raw(svgIcon('logout'))}<span>Выйти из аккаунта</span></button>
  </div>`;
}

// ── Подстраница раздела ──────────────────────────────────────────────────
function subHTML() {
  const sec = SECTIONS[section];
  const bodies = { account: accountBody, notifications: notificationsBody, privacy: privacyBody, security: securityBody, data: dataBody, appearance: appearanceBody, about: aboutBody };
  return html`<div class="settings-inner st-sub">
    <header class="st-head">
      <button class="icon-btn" data-back aria-label="Назад">${raw(icons.back)}</button>
      <h2>${sec.title}</h2>
      <span class="st-head-sp"></span>
    </header>
    <div class="st-banner">${ico(sec.icon, sec.color, 'xl')}<p>${sec.note}</p></div>
    ${bodies[section]()}
  </div>`;
}

function accountBody() {
  const u = state.user;
  return html`
    <div class="settings-group">
      <h4>Профиль</h4>
      <div class="settings-card">
        ${row('Имя', u.name, () => Modals.openEditProfile('name'))}
        ${row('Username', `@${u.username}`, () => Modals.openEditProfile('username'))}
        ${row('Описание профиля', u.bio || 'Не заполнено', () => Modals.openEditProfile('bio'))}
        ${row('Статус', u.statusText || 'Не задан', () => Modals.openEditProfile('statusText'))}
      </div>
    </div>
    <div class="settings-group">
      <h4>Вход</h4>
      <div class="settings-card">
        ${row('Пароль', 'Сменить пароль', () => openChangePassword())}
      </div>
    </div>
    <div class="settings-group">
      <h4>Почта</h4>
      <div class="settings-card">
        ${row('E-mail', u.email || '—', () => Modals.openEditProfile('email'))}
        ${u.emailVerified ? html`<div class="settings-row"><div class="grow"><div class="label">Подтверждение почты</div><div class="desc">Адрес подтверждён</div></div><span class="chip accent">Подтверждена</span></div>` : html`
          <div class="settings-row" style="display:block">
            <div class="label">Подтверждение почты</div>
            <div class="desc">Код подтверждения отправляется автоматически. Подтвердите адрес в течение двух дней, чтобы профиль не был ограничен.</div>
            <button type="button" class="btn btn-primary btn-sm" data-email-code-request style="margin-top:12px">
              ${u.emailVerificationRequestedAt ? 'Запросить код повторно' : 'Получить код'}
            </button>
            <p class="muted small" data-email-code-status aria-live="polite" style="margin:10px 0 0">
              ${u.emailVerificationRequestedAt ? 'Код отправлен на вашу почту. Проверьте также папку «Спам».' : 'Запросите шестизначный код — он действует 10 минут.'}
            </p>
            <form class="row gap-2" data-email-code-form style="margin-top:12px">
              <input class="input" name="verificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-значный код" aria-label="Код подтверждения почты" required>
              <button type="submit" class="btn btn-sm" data-email-code-submit>Подтвердить</button>
            </form>
          </div>
        `}
      </div>
    </div>`;
}

function notificationsBody() {
  const s = state.settings;
  return html`
    <div class="settings-group">
      <h4>Уведомления о сообщениях</h4>
      <div class="settings-card">
        ${switchRow('Сообщения', 'Личные диалоги', 'notify.messages', s.notify.messages)}
        ${switchRow('Группы', 'Сообщения из групп', 'notify.groups', s.notify.groups)}
        ${switchRow('Каналы', 'Публикации каналов', 'notify.channels', s.notify.channels)}
      </div>
    </div>
    <div class="settings-group">
      <h4>Звук и вибрация</h4>
      <div class="settings-card">
        ${switchRow('Звук', 'Сигнал при новом сообщении', 'notify.sounds', s.notify.sounds)}
        <div class="settings-row" style="display:block">
          <div class="label">Мелодия уведомлений</div>
          <div class="desc">Выберите один из загруженных звуков</div>
          <select data-notify-sound aria-label="Мелодия уведомлений" style="margin-top:8px;width:100%">
            <option value="default" ${s.notify.sound === 'default' ? 'selected' : ''}>Стандартный сигнал</option>
            <option value="universfield-new-notification-051-494246" ${s.notify.sound === 'universfield-new-notification-051-494246' ? 'selected' : ''}>Звук 1</option>
            <option value="universfield-new-notification-040-493469" ${s.notify.sound === 'universfield-new-notification-040-493469' ? 'selected' : ''}>Звук 2</option>
            <option value="universfield-new-notification-017-352293" ${s.notify.sound === 'universfield-new-notification-017-352293' ? 'selected' : ''}>Звук 3</option>
          </select>
        </div>
        ${switchRow('Вибрация', 'На устройствах с поддержкой', 'notify.vibration', s.notify.vibration)}
        ${switchRow('Показывать текст', 'Превью сообщения в уведомлении', 'notify.preview', s.notify.preview)}
      </div>
    </div>
    <div class="settings-group">
      <h4>Система</h4>
      <div class="settings-card">
        ${row('Системные уведомления', typeof Notification === 'undefined' ? 'Не поддерживаются браузером' : Notification.permission === 'granted' ? 'Разрешены' : Notification.permission === 'denied' ? 'Запрещены в браузере' : 'Запросить разрешение', askNotifications)}
        <div class="settings-row">
          <div class="grow" style="min-width:0">
            <div class="label">Уведомления в фоне</div>
            <div class="desc">Получайте push о сообщениях и входящих звонках, даже когда Aurora закрыта. Звонок открывается в Aurora; звук и кнопки уведомления зависят от Android и браузера.</div>
          </div>
          <div class="row gap-2">
            ${securityState.pushNotifications ? html`<button type="button" class="btn btn-sm" data-push-test>Проверить</button>` : ''}
            <button type="button" class="btn btn-sm ${securityState.pushNotifications ? 'btn-danger' : 'btn-primary'}" data-push-toggle>
              ${securityState.pushNotifications ? 'Отключить' : 'Включить'}
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

function privacyBody() {
  const s = state.settings;
  return html`
    <div class="settings-group">
      <h4>Кто может…</h4>
      <div class="settings-card">
        ${selectRow('Кто может писать мне', 'privacy.messages', s.privacy.messages)}
        ${selectRow('Кто видит профиль', 'privacy.profile', s.privacy.profile)}
        ${selectRow('Кто может добавлять в группы', 'privacy.groups', s.privacy.groups)}
        ${selectRow('Кто видит статус', 'privacy.status', s.privacy.status)}
      </div>
      <p class="st-note">«Общие контакты» — люди, с которыми у вас уже есть общий чат.</p>
    </div>
    <div class="settings-group">
      <h4>Чёрный список</h4>
      <div class="settings-card">
        ${row('Заблокированные', 'Управление списком', openBlocked)}
      </div>
    </div>`;
}

function securityBody() {
  return html`
    <div class="settings-group">
      <h4>Проверка аккаунта</h4>
      <div class="settings-card">
        ${row('Проверка телефона', verificationLabel('phone'), () => requestAccountVerification('phone'))}
        ${row('Официальный аккаунт', verificationLabel('official'), () => requestAccountVerification('official'))}
      </div>
      <p class="st-note">Заявки рассматриваются владельцем вручную. Для заявки не передаются личные сообщения, номер телефона или документы.</p>
    </div>
    <div class="settings-group">
      <h4>Защита входа</h4>
      <div class="settings-card">
        ${row('Двухфакторная аутентификация', securityState.twoFactor ? 'Включена · Управление' : 'Выключена · Настроить', openTwoFactor)}
        ${row('Защитный пароль', securityState.protectivePassword ? 'Включён · Изменить или отключить' : 'Не настроен · Настроить', openProtectivePassword)}
      </div>
    </div>
    <div class="settings-group">
      <h4>Устройства</h4>
      <div class="settings-card">
        ${row('Активные сеансы', securityState.sessions.length ? `${securityState.sessions.length} устройств · Управление` : 'Загрузка…', openSessions)}
        ${row('Выйти со всех устройств', 'Завершит все сессии, кроме текущей', logoutEverywhere)}
      </div>
    </div>
    `;
}

function dataBody() {
  const rt = rtStatus();
  return html`
    <div class="settings-group">
      <h4>Загрузки</h4>
      <div class="settings-card">
        ${row('Лимиты загрузок', 'Размер файлов', openLimits)}
        ${row('Мои загрузки', 'Файлы, доступные для повторной отправки', openMyMedia)}
      </div>
    </div>
    <div class="settings-group">
      <h4>Сеть</h4>
      <div class="settings-card">
        ${row('Соединение', `${rt.connection === 'connected' ? 'WebSocket' : rt.connection === 'polling' ? 'Опрос' : 'Офлайн'} · задержка ${rt.latency || '—'} мс`, () => toast('Соединение проверяется автоматически', { type: 'info' }))}
      </div>
    </div>`;
}

function appearanceBody() {
  const s = state.settings;
  return html`
    <div class="settings-group">
      <h4>Тема</h4>
      <div class="settings-card">
        <div class="settings-row" style="display:block">
          <div class="theme-card">
            ${raw([['dark', 'Тёмная', 'dark'], ['light', 'Светлая', 'light'], ['system', 'Системная', 'system']]
    .map(([id, label, cls]) => html`<button class="theme-option" data-theme="${id}" aria-checked="${s.theme === id}">
              <span class="theme-preview ${cls}"></span><span>${label}</span></button>`).join(''))}
          </div>
        </div>
        <div class="settings-row" style="display:block">
          <div class="label" style="margin-bottom:10px">Акцентный цвет</div>
          <div class="swatches">
            ${ACCENTS.map((a) => html`<button class="swatch" data-accent="${a.id}" aria-checked="${s.accent === a.id}"
              style="background:linear-gradient(140deg, ${a.from}, ${a.to})" title="${a.label}" aria-label="${a.label}"></button>`)}
          </div>
        </div>
      </div>
    </div>
    <div class="settings-group">
      <h4>Обои чатов</h4>
      <div class="settings-card">
        <div class="settings-row" style="display:block">
          <div class="wall-swatches">
            ${WALLPAPERS.map((w) => html`<button class="wall-swatch ${w.premium && !state.user?.isPremium ? 'locked' : ''}" data-wallpaper="${w.id}" data-premium="${w.premium ? 1 : 0}" aria-checked="${s.wallpaper === w.id}"
              style="background-image:${w.preview}" title="${w.label}" aria-label="${w.label}"></button>`)}
          </div>
        </div>
      </div>
    </div>
    <div class="settings-group">
      <h4>Интерфейс</h4>
      <div class="settings-card">
        <div class="settings-row">
          <div class="grow">
            <div class="label">Размер текста</div>
            <div class="desc">Текущий: ${Math.round(s.fontScale * 100)}%</div>
          </div>
          <input type="range" min="0.85" max="1.3" step="0.05" value="${s.fontScale}" data-font-scale style="max-width:190px" aria-label="Размер текста">
        </div>
        ${switchRow('Анимации', 'Плавные переходы интерфейса', 'animations', s.animations)}
        ${switchRow('Компактный режим', 'Меньше отступов в списках', 'compact', s.compact)}
      </div>
    </div>`;
}

function aboutBody() {
  return html`
    <div class="settings-group">
      <div class="settings-card">
        <div class="settings-row">
          <div class="grow">
            <div class="label">Aurora Messenger 1.0</div>
            <div class="desc">Мессенджер для общения.</div>
          </div>
          <span class="chip accent">опенсорс-стек</span>
        </div>
      </div>
    </div>
    <div class="settings-group">
      <h4>Документы</h4>
      <div class="settings-card">
        <a class="settings-row" href="/terms.html">
          ${ico('list', 'blue')}
          <div class="grow" style="min-width:0">
            <div class="label">Пользовательское соглашение</div>
            <div class="desc">Условия использования Aurora</div>
          </div>
          <span class="mute st-chev">${raw(icons.chevronRight)}</span>
        </a>
        <a class="settings-row" href="/privacy.html">
          ${ico('lock', 'green')}
          <div class="grow" style="min-width:0">
            <div class="label">Политика конфиденциальности</div>
            <div class="desc">Обработка и защита персональных данных</div>
          </div>
          <span class="mute st-chev">${raw(icons.chevronRight)}</span>
        </a>
      </div>
    </div>`;
}

const navRow = (id, value = '') => {
  const sec = SECTIONS[id];
  return html`<button class="settings-row st-nav" data-section="${id}" style="width:100%;text-align:left">
  ${ico(sec.icon, sec.color)}
  <div class="grow" style="min-width:0">
    <div class="label">${sec.title}</div>
    ${value ? html`<div class="desc truncate">${value}</div>` : ''}
  </div>
  <span class="mute st-chev">${raw(icons.chevronRight)}</span>
</button>`;
};

const row = (label, value, onClick) => {
  if (onClick) rowHandlers.set(label, onClick);
  return html`<button class="settings-row" data-row="${esc(label)}" style="width:100%;text-align:left">
  ${rowIco(label)}
  <div class="grow" style="min-width:0">
    <div class="label">${label}</div>
    <div class="desc truncate">${value}</div>
  </div>
  <span class="mute st-chev">${raw(icons.chevronRight)}</span>
</button>`;
};

const switchRow = (label, desc, path, checked) => html`<div class="settings-row">
  ${rowIco(label)}
  <div class="grow">
    <div class="label">${label}</div>
    <div class="desc">${desc}</div>
  </div>
  <label class="switch">
    <input type="checkbox" data-switch="${path}" ${checked ? 'checked' : ''} aria-label="${label}">
    <span class="track"></span>
  </label>
</div>`;

const selectRow = (label, path, value) => html`<div class="settings-row st-select">
  <div class="st-select-top">
    ${rowIco(label)}
    <div class="grow" style="min-width:0"><div class="label">${label}</div></div>
  </div>
  <div class="segmented" data-select="${path}">
    ${raw(PRIVACY_OPTIONS.map((o) => html`<button data-option="${o.id}" aria-pressed="${value === o.id}">${o.label}</button>`).join(''))}
  </div>
</div>`;

function bind() {
  const host = settingsView.el;
  $('[data-back]', host)?.addEventListener('click', () => (section ? go(null) : bus.emit('nav:go', '#/chats')));
  $$('[data-section]', host).forEach((b) => b.addEventListener('click', () => go(b.dataset.section)));
  $$('[data-edit-profile]', host).forEach((b) => b.addEventListener('click', () => Modals.openEditProfile()));
  $('[data-style-profile]', host)?.addEventListener('click', () => import('./profile-studio.js?v=20261028-ux-1').then((m) => m.openProfileStudio(state.user)));
  $('[data-nav-commerce]', host)?.addEventListener('click', () => bus.emit('nav:go', '#/commerce'));
  $('[data-logout]', host)?.addEventListener('click', () => bus.emit('auth:logout'));
  $$('[data-row]', host).forEach((btn) => {
    const label = btn.dataset.row;
    const handlers = {
      'Имя': () => Modals.openEditProfile('name'),
      'Premium и Авроры': () => bus.emit('nav:go', '#/commerce'),
      'Username': () => Modals.openEditProfile('username'),
      'E-mail': () => Modals.openEditProfile('email'),
      'Описание профиля': () => Modals.openEditProfile('bio'),
      'Статус': () => Modals.openEditProfile('statusText'),
      'Пароль': openChangePassword,
      'Системные уведомления': askNotifications,
      'Заблокированные': openBlocked,
      'Лимиты загрузок': openLimits,
      'Мои загрузки': openMyMedia,
      'Активные сеансы': openSessions,
      'Двухфакторная аутентификация': openTwoFactor,
      'Защитный пароль': openProtectivePassword,
    };
    btn.addEventListener('click', () => (rowHandlers.get(label) || handlers[label] || (() => {}))());
  });

  const requestEmailCode = $('[data-email-code-request]', host);
  requestEmailCode?.addEventListener('click', async () => {
    const status = $('[data-email-code-status]', host);
    requestEmailCode.disabled = true;
    status.textContent = 'Отправляем код…';
    try {
      const result = await Api.requestEmailVerificationCode();
      if (result.alreadyVerified) {
        state.user.emailVerified = true;
        bus.emit('user:updated');
        return;
      }
      state.user.emailVerificationRequestedAt = result.requestedAt || state.user.emailVerificationRequestedAt || Date.now();
      status.textContent = result.message;
      requestEmailCode.textContent = 'Запросить код повторно';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      requestEmailCode.disabled = false;
    }
  });

  $('[data-push-toggle]', host)?.addEventListener('click', (event) => togglePushNotifications(event.currentTarget));
  $('[data-push-test]', host)?.addEventListener('click', (event) => testPushNotifications(event.currentTarget));

  $('[data-email-code-form]', host)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = form.elements.verificationCode.value.trim();
    const button = $('[data-email-code-submit]', form);
    if (!/^\d{6}$/.test(code)) {
      toast('Введите шестизначный код', { type: 'error' });
      return;
    }
    button.disabled = true;
    try {
      const result = await Api.verifyEmailCode(code);
      state.user = result.user;
      toast('Почта успешно подтверждена', { type: 'success' });
      bus.emit('user:updated');
      bus.emit('email:verified');
    } catch (err) {
      toastError(err);
    } finally {
      button.disabled = false;
    }
  });

  $$('[data-switch]', host).forEach((input) => {
    input.addEventListener('change', () => {
      const path = input.dataset.switch;
      const [group, key] = path.split('.');
      bus.emit('settings:change', { [group]: { [key]: input.checked } });
    });
  });

  $$('[data-select]', host).forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-option]');
      if (!btn) return;
      const [group, key] = seg.dataset.select.split('.');
      $$('[data-option]', seg).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      bus.emit('settings:change', { [group]: { [key]: btn.dataset.option } });
    });
  });

  $$('[data-theme]', host).forEach((btn) => btn.addEventListener('click', () => {
    bus.emit('settings:change', { theme: btn.dataset.theme });
    $$('[data-theme]', host).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  }));
  $$('[data-accent]', host).forEach((btn) => btn.addEventListener('click', () => {
    bus.emit('settings:change', { accent: btn.dataset.accent });
    $$('[data-accent]', host).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  }));
  $$('[data-wallpaper]', host).forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.premium === '1' && !state.user?.isPremium) {
      toast('Эти обои открываются с Premium', { type: 'info', action: { label: 'Открыть', onClick: () => bus.emit('nav:go', '#/commerce') } });
      return;
    }
    bus.emit('settings:change', { wallpaper: btn.dataset.wallpaper });
    $$('[data-wallpaper]', host).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  }));

  const range = $('[data-font-scale]', host);
  range?.addEventListener('input', () => {
    const value = Number(range.value);
    document.documentElement.style.setProperty('--fs', String(value));
    const desc = range.closest('.settings-row').querySelector('.desc');
    if (desc) desc.textContent = `Текущий: ${Math.round(value * 100)}%`;
  });
  range?.addEventListener('change', () => bus.emit('settings:change', { fontScale: Number(range.value) }));
  $('[data-notify-sound]', host)?.addEventListener('change', (event) => bus.emit('settings:change', { notifySound: event.target.value }));
}

async function loadSecurity() {
  const requestInteractionVersion = interactionVersion;
  const deadlineAt = state.user?.emailVerificationDeadlineAt;
  if (!state.user?.emailVerified && deadlineAt && deadlineAt <= Date.now()) return;
  try {
    const [sessionResult, twoFactorResult, protectivePasswordResult, pushResult] = await Promise.all([
      Api.sessions(), Api.twoFactorStatus(), Api.protectivePasswordStatus(), Api.pushSubscriptionStatus(),
    ]);
    securityState = {
      sessions: sessionResult.sessions || [],
      twoFactor: !!twoFactorResult.enabled,
      protectivePassword: !!protectivePasswordResult.enabled,
      protectivePasswordSetupRequired: !!protectivePasswordResult.setupRequired,
      pushNotifications: !!pushResult.enabled,
    };
    if (securityState.pushNotifications) store9.set('aurora.push.enabled', true);
    else store9.remove('aurora.push.enabled');
    if (
      !settingsView.el?.classList.contains('hidden')
      && interactionVersion === requestInteractionVersion
    ) render();
  } catch (err) { if (err.status !== 401) toastError(err); }
}

function applicationServerKey(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function togglePushNotifications(button) {
  button.disabled = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      throw new Error('Этот браузер не поддерживает push-уведомления');
    }
    if (!securityState.pushNotifications) {
      if (Notification.permission === 'denied') {
        throw new Error('Разрешите уведомления для Aurora в настройках браузера Android');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение на уведомления не получено');
    }
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (securityState.pushNotifications) {
      if (subscription) {
        await Api.removePushSubscription(subscription.toJSON());
        const unsubscribed = await subscription.unsubscribe();
        if (!unsubscribed) throw new Error('Браузер не смог отключить push-подписку');
      } else {
        await Api.removePushSubscription({});
      }
      securityState.pushNotifications = false;
      store9.remove('aurora.push.enabled');
      toast('Фоновые уведомления отключены', { type: 'success' });
    } else {
      const { publicKey } = await Api.pushVapidKey();
      const activeSubscription = subscription || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      try {
        await Api.savePushSubscription(activeSubscription.toJSON());
      } catch (error) {
        if (!subscription) {
          const unsubscribed = await activeSubscription.unsubscribe();
          if (!unsubscribed) console.warn('Aurora push subscription could not be rolled back after save failure');
        }
        throw error;
      }
      securityState.pushNotifications = true;
      store9.set('aurora.push.enabled', true);
      toast('Фоновые уведомления включены', { type: 'success' });
    }
    render();
  } catch (error) {
    toastError(error);
  } finally {
    button.disabled = false;
  }
}

async function testPushNotifications(button) {
  button.disabled = true;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      throw new Error('Сначала разрешите системные уведомления в настройках браузера');
    }
    const result = await Api.testPush();
    toast(result.failed ? `Push отправлен на ${result.sent} устройство(а), ошибок: ${result.failed}` : 'Тестовое push-уведомление отправлено', { type: result.failed ? 'info' : 'success' });
  } catch (error) {
    toastError(error);
  } finally {
    button.disabled = false;
  }
}

function sessionDateTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Неизвестно';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

async function openSessions() {
  const list = el('div', { class: 'sessions-list', 'aria-live': 'polite' });
  modal({
    title: 'Активные сеансы',
    subtitle: 'Устройства, на которых открыт ваш аккаунт',
    body: list,
  });
  list.innerHTML = '<div class="sessions-state"><span class="sessions-loader" aria-hidden="true"></span><span>Загружаем список устройств…</span></div>';
  const load = async () => {
    list.setAttribute('aria-busy', 'true');
    try {
      const result = await Api.sessions();
      securityState.sessions = result.sessions || [];
      const sessions = securityState.sessions;
      const countLabel = sessions.length === 1 ? 'устройстве' : 'устройствах';
      list.innerHTML = sessions.length
        ? html`<div class="sessions-summary">${raw(icons.shield)}<span>Аккаунт открыт на ${sessions.length} ${countLabel}. Незнакомые сеансы можно завершить.</span></div>
          <div class="sessions-cards">${sessions.map((session) => html`<article class="session-card ${session.current ? 'is-current' : ''}">
            <div class="session-card-top">
              <span class="session-device-icon">${raw(icons.monitor)}</span>
              <div class="session-device-copy">
                <div class="session-device-name">${esc(session.deviceName || 'Устройство')}</div>
                <div class="session-device-status">${session.current
                  ? html`<span class="session-current-badge"><span></span>Это устройство</span>`
                  : 'Активный сеанс'}</div>
              </div>
            </div>
            <dl class="session-details">
              <div><dt>Последняя активность</dt><dd>${esc(sessionDateTime(session.last_seen))}</dd></div>
              <div><dt>Вход в аккаунт</dt><dd>${esc(sessionDateTime(session.created_at))}</dd></div>
              ${session.ip ? html`<div><dt>IP-адрес</dt><dd class="session-ip">${esc(session.ip)}</dd></div>` : ''}
            </dl>
            ${session.current ? '' : html`<button class="btn btn-danger session-revoke" data-revoke="${esc(session.id)}">${raw(icons.close)}<span>Завершить сеанс</span></button>`}
          </article>`)}</div>`
        : html`<div class="sessions-empty">${raw(icons.monitor)}<strong>Нет активных сеансов</strong><span>Когда вы войдёте в аккаунт с другого устройства, оно появится здесь.</span></div>`;
      list.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Завершить сеанс?',
          text: 'На выбранном устройстве аккаунт будет закрыт. Чтобы продолжить, потребуется войти снова.',
          confirmLabel: 'Завершить', danger: true,
        });
        if (!ok) return;
        button.disabled = true;
        try {
          await Api.revokeSession(button.dataset.revoke);
          toast('Сеанс завершён', { type: 'success' });
          await load();
          render();
        }
        catch (err) { toastError(err); }
        finally { button.disabled = false; }
      }));
    } catch (err) {
      list.innerHTML = html`<div class="sessions-error"><strong>Не удалось загрузить сеансы</strong><span>${esc(err.message || 'Проверьте соединение и попробуйте ещё раз.')}</span><button class="btn" data-sessions-retry>Повторить</button></div>`;
      list.querySelector('[data-sessions-retry]')?.addEventListener('click', load);
    } finally {
      list.removeAttribute('aria-busy');
    }
  };
  load();
}

async function openTwoFactor() {
  if (securityState.twoFactor) {
    const code = await promptDialog({ title: 'Отключить 2FA', label: 'Код приложения или резервный код', placeholder: '000000', confirmLabel: 'Отключить' });
    if (!code) return;
    try { await Api.twoFactorDisable(code); securityState.twoFactor = false; toast('2FA отключена', { type: 'success' }); render(); }
    catch (err) { toastError(err); }
    return;
  }
  try {
    const setup = await Api.twoFactorSetup();
    const code = await promptDialog({
      title: 'Настройка 2FA',
      label: `Добавьте секрет в приложение-аутентификатор: ${setup.secret}`,
      placeholder: 'Код из приложения',
      confirmLabel: 'Включить',
    });
    if (!code) return;
    const result = await Api.twoFactorEnable(code);
    securityState.twoFactor = true;
    const recovery = (result.recoveryCodes || []).join('\n');
    const recoveryModal = modal({
      title: '2FA включена',
      subtitle: 'Сохраните резервные коды в безопасном месте.',
      body: el('pre', { class: 'settings-card', style: 'white-space:pre-wrap' }, recovery),
      footer: [el('button', { class: 'btn btn-primary', onClick: () => recoveryModal.close() }, 'Готово')],
    });
    render();
  } catch (err) { toastError(err); }
}

function openProtectivePassword() {
  const currentPassword = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль аккаунта' });
  const currentProtectivePassword = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Текущий защитный пароль' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Новый защитный пароль' });
  const again = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Повторите защитный пароль' });
  const message = el('p', { class: 'muted small', 'aria-live': 'polite' }, 'Не менее 6 символов. При входе сначала вводится пароль аккаунта, затем защитный пароль.');
  const body = el('div', { class: 'col gap-3' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Пароль аккаунта для подтверждения'), currentPassword),
    securityState.protectivePassword ? el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Текущий защитный пароль'), currentProtectivePassword) : '',
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, securityState.protectivePassword ? 'Новый защитный пароль' : 'Защитный пароль'), next),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Повторите защитный пароль'), again),
    message);
  let saving = false;
  const dialog = modal({
    title: 'Защитный пароль',
    subtitle: 'Это дополнительный пароль после основного пароля при каждом новом входе.',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => dialog.close() }, 'Отмена'),
      ...(securityState.protectivePassword ? [el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          if (saving) return;
          saving = true;
          try {
            await Api.disableProtectivePassword(currentPassword.value, currentProtectivePassword.value);
            securityState.protectivePassword = false;
            securityState.protectivePasswordSetupRequired = false;
            toast('Защитный пароль отключён', { type: 'success' });
            dialog.close();
            render();
          } catch (err) {
            message.textContent = err.message;
          } finally { saving = false; }
        },
      }, 'Отключить') ] : []),
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          if (saving) return;
          message.textContent = '';
          if (next.value.length < 6) { message.textContent = 'Минимум 6 символов.'; return; }
          if (next.value !== again.value) { message.textContent = 'Защитные пароли не совпадают.'; return; }
          saving = true;
          try {
            await Api.setProtectivePassword(currentPassword.value, next.value);
            securityState.protectivePassword = true;
            securityState.protectivePasswordSetupRequired = false;
            toast('Защитный пароль сохранён', { type: 'success' });
            dialog.close();
            render();
          } catch (err) {
            message.textContent = err.message;
          } finally { saving = false; }
        },
      }, securityState.protectivePassword ? 'Изменить' : 'Включить'),
    ],
  });
}

/* ── Отдельные диалоги настроек ───────────────────────────────────────── */

function openChangePassword() {
  const current = el('input', { class: 'input', type: 'password', placeholder: 'Текущий пароль', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', placeholder: 'Новый пароль', autocomplete: 'new-password' });
  const again = el('input', { class: 'input', type: 'password', placeholder: 'Повторите новый пароль', autocomplete: 'new-password' });
  const msg = el('div', { class: 'field-msg' });
  const body = el('div', { class: 'col gap-3' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Текущий пароль'), current),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Новый пароль'), next, el('span', { class: 'field-msg' }, 'Минимум 8 символов, буквы и цифры')),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Повтор'), again),
    msg);

  const m = modal({
    title: 'Смена пароля',
    subtitle: 'Все другие сессии будут завершены — это защищает аккаунт.',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          msg.textContent = '';
          if (next.value !== again.value) { msg.style.color = 'var(--err)'; msg.textContent = 'Пароли не совпадают'; return; }
          if (next.value.length < 8) { msg.style.color = 'var(--err)'; msg.textContent = 'Пароль короче 8 символов'; return; }
          try {
            const res = await Api.changePassword({ currentPassword: current.value, password: next.value });
            if (res.token) {
              const { setToken } = await import('../api.js');
              setToken(res.token);
            }
            toast('Пароль обновлён', { type: 'success' });
            m.close();
          } catch (err) {
            msg.style.color = 'var(--err)';
            msg.textContent = err.message;
          }
        },
      }, 'Сохранить'),
    ],
  });
}

async function askNotifications() {
  const { requestNotificationPermission } = await import('../notify.js?v=20261102-gifts-2');
  const ok = await requestNotificationPermission();
  const message = ok ? 'Системные уведомления включены'
    : typeof Notification === 'undefined' ? 'Этот браузер не поддерживает системные уведомления'
      : Notification.permission === 'denied' ? 'Разрешите уведомления для Aurora в настройках браузера'
        : 'Разрешение на уведомления не получено';
  toast(message, { type: ok ? 'success' : 'info' });
  render();
}

async function openBlocked() {
  const list = el('div', { class: 'col gap-1' });
  const m = modal({ title: 'Заблокированные', body: list });
  const load = async () => {
    try {
      const res = await Api.blocks();
      if (!res.users.length) {
        list.innerHTML = '<p class="muted">Список пуст. Заблокировать пользователя можно из его профиля.</p>';
        return;
      }
      list.innerHTML = res.users.map((u) => html`<div class="list-item">
        ${raw(avatarHTML({ name: u.name, avatarUrl: u.avatarUrl, color: u.avatarColor, size: 'sm' }))}
        <span class="col grow"><span class="title">${u.name}</span><span class="sub">@${u.username}</span></span>
        <button class="btn btn-sm" data-unblock="${u.id}">Разблокировать</button>
      </div>`).join('');
      list.querySelectorAll('[data-unblock]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await Api.blockUser(Number(btn.dataset.unblock), false);
          toast('Пользователь разблокирован', { type: 'success' });
          load();
        } catch (err) { toastError(err); }
      }));
    } catch (err) { list.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
  load();
}

function openLimits() {
  const limits = state.limits || {};
  const rows = Object.entries(limits).map(([kind, bytes]) => html`<div class="settings-row">
    <div class="grow"><div class="label">${{ image: 'Изображения', video: 'Видео', audio: 'Аудио', voice: 'Голосовые', file: 'Файлы', avatar: 'Аватары' }[kind] || kind}</div></div>
    <span class="chip">до ${fmtBytes(bytes)}</span>
  </div>`).join('');
  modal({
    title: 'Лимиты загрузок',
    subtitle: 'Максимальный размер файла для каждого типа.',
    body: el('div', { class: 'settings-card', html: rows || '<p class="muted">Лимиты загружаются…</p>' }),
  });
}

async function openMyMedia() {
  const grid = el('div', { class: 'media-grid' });
  const m = modal({ title: 'Мои загрузки', wide: true, body: grid });
  try {
    const res = await Api.myMedia();
    if (!res.media.length) { grid.innerHTML = '<p class="muted">Вы ещё ничего не загружали.</p>'; return; }
    grid.innerHTML = res.media.map((item) => html`<div class="media-cell" data-media="${item.id}">
      ${item.kind === 'image' ? raw(`<img src="${esc(item.thumbUrl || item.url)}" alt="${esc(item.filename)}" loading="lazy">`) : ''}
      ${item.kind !== 'image' ? html`<div class="center" style="height:100%;color:var(--text-mute)">
        <span style="width:26px;height:26px">${raw(icons[item.kind === 'video' ? 'video' : 'file'])}</span></div>` : ''}
      <span class="dur">${fmtBytes(item.size)}</span>
    </div>`).join('');
  } catch (err) { grid.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}
