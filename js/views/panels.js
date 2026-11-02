/**
 * Правая панель: профиль собеседника, информация о группе/канале, медиа, файлы,
 * участники и панель администратора.
 */
import { $, $$, el, esc, html, raw, fmtBytes, fmtDuration, fmtFullDate, fmtLastSeen, plural } from '../util.js';
import { icons } from '../icons.js';
import { state, bus, isMe, patchChat } from '../store.js';
import { avatarHTML, profileHeroHTML, contextMenu, toast, toastError, confirmDialog, promptDialog, modal, stateScreen, loadingScreen, skeletonList, STICKERS, stickerUrl } from '../ui.js?v=20261029-no-toasts-1';
import { Api, api } from '../api.js?v=20261102-gifts-2';
import { shell } from './shell.js?v=20261028-ux-1';
import * as Modals from './modals.js';
import { openMediaList } from './mediaviewer.js';
import { compressImage, cropImage } from '../media.js?v=20261027-cropper-1';
import { openProfileStudio } from './profile-studio.js?v=20261028-ux-1';

export const panels = {
  open: false,
  mode: null,          // profile | chat
  userId: null,
  chatId: null,
  tab: 'media',
  mediaOffset: 0,
  mediaItems: [],
};
let mounted = false;

const isDesktop = () => window.matchMedia('(min-width: 1181px)').matches;

/** Событийная точка входа: «Информация» из меню чата открывает панель нужного чата. */
export function mount() {
  if (mounted) return;
  mounted = true;
  bus.on('panel:open', (payload = {}) => {
    if (payload.userId) return showUserProfile(payload.userId);
    if (payload.chatId) return toggleForChat(payload.chatId);
  });
}

export function onChatOpened(chatId) {
  panels.chatId = chatId;
  if (panels.open && panels.mode === 'chat') render();
}

export function onChatUpdated(chatId, info = null) {
  if (panels.open && (panels.chatId === chatId || panels.userId)) render();
}

export function toggleForChat(chatId) {
  if (panels.open && panels.mode === 'chat' && panels.chatId === chatId) return closePanel();
  panels.mode = 'chat';
  panels.chatId = chatId;
  panels.userId = null;
  panels.tab = state.chat?.chat.type === 'channel' ? 'media' : 'media';
  panels.mediaOffset = 0;
  panels.mediaItems = [];
  open();
}

export function showUserProfile(userId) {
  if (!userId) return;
  if (isMe(userId)) { bus.emit('nav:go', '#/settings'); return; }
  // Повторное событие открытия не должно закрывать профиль (например, после
  // повторного монтирования приложения или клика по пункту меню).
  panels.mode = 'profile';
  panels.userId = userId;
  open();
}

export function refreshUserProfile(userId) {
  if (panels.open && panels.mode === 'profile' && panels.userId === userId) render();
}

export function closePanel() {
  panels.open = false;
  shell.root.classList.remove('with-panel');
  shell.root.classList.remove('profile-fullscreen');
  const host = $('[data-panel]');
  if (host) {
    host.style.animation = 'fade-out .16s forwards';
    setTimeout(() => host.remove(), 160);
  }
}

function open() {
  panels.open = true;
  // На широком экране панель — колонка сетки, на узком CSS превращает её в оверлей.
  shell.root.classList.add('with-panel');
  shell.root.classList.toggle('profile-fullscreen', panels.mode === 'profile');
  render();
}

function render() {
  let host = $('[data-panel]');
  if (!host) {
    host = el('aside', { class: 'panel', 'data-panel': '' });
    shell.root.append(host);
  }
  if (!isDesktop()) shell.root.classList.add('with-panel');
  if (panels.mode === 'profile') renderProfile(host);
  else renderChatInfo(host);
}

/* ───────────────────────── Профиль пользователя ──────────────────────── */

async function renderProfile(host) {
  const userId = panels.userId;
  host.innerHTML = html`<div class="panel-head">
    <button class="icon-btn" data-close aria-label="Закрыть">${raw(icons.close)}</button>
    <h3>Профиль</h3>
  </div>
  <div class="panel-body">${raw(loadingScreen('Загружаем профиль…'))}</div>`;
  host.querySelector('[data-close]').addEventListener('click', closePanel);

  try {
    const res = await Api.userProfile(userId);
    if (!panels.open || panels.userId !== userId) return;
    const u = res.user;
    const isSelf = isMe(u.id);
    const presence = state.presence[u.id]?.presence || u.presence;
    const chat = state.chats.find((c) => c.type === 'dm' && c.peer?.id === u.id);

    const statusLine = presence === 'online' ? 'в сети' : (presence !== null && presence !== undefined ? fmtLastSeen(state.presence[u.id]?.lastSeen ?? u.lastSeen, presence) : '');
    host.querySelector('.panel-body').innerHTML = html`
      ${u.profileBg ? html`<div class="profile-bg" style="background-image:url('${esc(u.profileBg)}')"></div>` : ''}
      ${profileHeroHTML(u, { sub: statusLine, presence: presence === 'online' ? 'online' : null })}

      <div class="tg-actions">
        ${isSelf ? html`<button class="tg-action" data-edit-me>${raw(icons.edit)}<span>Изменить</span></button>
          <button class="tg-action" data-style-profile>${raw(icons.palette || icons.edit)}<span>Оформление</span></button>`
    : html`<button class="tg-action primary" data-write>${raw(icons.chats)}<span>Написать</span></button>
          <button class="tg-action" data-mute>${raw(chat?.muted ? icons.bell : icons.bellOff)}<span>${chat?.muted ? 'Включить' : 'Без звука'}</span></button>
          <button class="tg-action" data-gift-user>${raw(icons.sparkles)}<span>Подарить</span></button>`}
      </div>

      <div class="tg-info">
        ${u.statusText ? html`<div class="tg-info-row"><span class="tg-info-val">${u.statusText}</span><span class="tg-info-lbl">Статус</span></div>` : ''}
        ${u.bio ? html`<div class="tg-info-row"><span class="tg-info-val">${u.bio}</span><span class="tg-info-lbl">О себе</span></div>` : ''}
        <div class="tg-info-row"><span class="tg-info-val accent">@${u.username}</span><span class="tg-info-lbl">Username</span></div>
        <div class="tg-info-row"><span class="tg-info-val">${fmtFullDate(u.createdAt)}</span><span class="tg-info-lbl">В Aurora с</span></div>
        ${u.profileText ? html`<div class="tg-info-row"><span class="tg-info-val">${esc(u.profileEmoji || '✨')} ${u.profileText}</span><span class="tg-info-lbl">Оформление</span></div>` : ''}
      </div>
      ${u.profileStickers?.length ? html`<div class="profile-stickers">${raw(u.profileStickers.map((id) => `<img src="${esc(stickerUrl(id))}" alt="" title="${esc(id)}">`).join(''))}</div>` : ''}

      <div class="stat-row">
        <div class="stat"><b>${res.stats?.messages ?? 0}</b><span>сообщений</span></div>
        <div class="stat"><b>${res.commonChats.length}</b><span>общих чатов</span></div>
      </div>

      ${res.gifts?.length ? html`<div class="settings-group profile-gifts"><h4>Подарки</h4><div class="profile-gift-grid">${raw(res.gifts.map((g) => html`<button class="profile-gift-card rarity-${esc(g.rarity || 'обычный')}" data-profile-gift="${g.instanceId}">${g.imageUrl ? html`<img src="${esc(g.imageUrl)}" alt="${esc(g.name)}" loading="lazy">` : ''}<b>${esc(g.name)}</b><small>${esc(g.rarity || 'обычный')}</small><small>от @${esc(g.sender.username)}</small></button>`).join(''))}</div></div>` : ''}

      ${res.personalChannel ? html`<div class="settings-group">
        <h4>Личный канал</h4>
        <div class="settings-card flush"><button class="list-item" data-open-chat="${res.personalChannel.id}">
          ${raw(avatarHTML({ name: res.personalChannel.title, avatarUrl: res.personalChannel.avatarUrl, color: 'ocean', size: 'sm', rounded: true }))}
          <span class="col grow" style="min-width:0"><span class="title truncate">${esc(res.personalChannel.title)}</span>
          <span class="sub">${res.personalChannel.username ? `@${esc(res.personalChannel.username)}` : 'Канал'}</span></span>
        </button></div>
      </div>` : ''}

      ${res.profileGallery?.length ? html`<div class="settings-group">
        <h4>Галерея</h4>
        <div class="media-grid profile-gallery">${raw(res.profileGallery.map((m, i) => html`<div class="media-cell" data-profile-media-index="${i}">
          ${m.kind === 'video' ? html`<video src="${esc(m.url)}" muted playsinline preload="metadata"></video>` : html`<img src="${esc(m.url)}" alt="" loading="lazy">`}
        </div>`).join(''))}</div>
      </div>` : ''}

      ${res.commonChats.length ? html`<div class="settings-group">
        <h4>Общие группы и каналы</h4>
        <div class="settings-card flush">${raw(res.commonChats.map((c) => html`<button class="list-item" data-open-chat="${c.id}">
          ${raw(avatarHTML({ name: c.title, avatarUrl: c.avatarUrl, color: c.type === 'channel' ? 'ocean' : 'indigo', size: 'sm', rounded: true }))}
          <span class="col grow" style="min-width:0"><span class="title truncate">${c.title}</span>
          <span class="sub">${c.type === 'channel' ? 'Канал' : 'Группа'}${c.username ? ` · @${c.username}` : ''}</span></span>
        </button>`).join(''))}</div>
      </div>` : ''}`;

    host.querySelector('[data-write]')?.addEventListener('click', async () => {
      try {
        const res2 = await Api.openDm(u.id);
        bus.emit('nav:go', `#/chat/${res2.chat.id}`);
        if (!isDesktop()) closePanel();
      } catch (err) { toastError(err); }
    });
    host.querySelector('[data-gift-user]')?.addEventListener('click', () => {
      const recipientId = Number(u.id);
      if (!Number.isInteger(recipientId) || recipientId <= 0) return toast('Не удалось определить получателя', { type: 'error' });
      bus.emit('commerce:gift', { recipientId, recipient: { id: u.id, name: u.name, username: u.username } });
    });
    const doReport = async () => {
      const reason = await promptDialog({
        title: `Пожаловаться на ${u.name}`,
        label: 'Причина жалобы',
        placeholder: 'Например, спам или мошенничество',
        confirmLabel: 'Отправить жалобу',
        maxLength: 64,
      });
      if (!reason) return;
      try {
        await Api.reportUser(u.id, reason);
        toast('Жалоба отправлена', { type: 'success' });
      } catch (err) { toastError(err); }
    };
    const doBlock = async () => {
      const ok = await confirmDialog({
        title: `Заблокировать ${u.name}?`,
        text: 'Пользователь не сможет писать вам, а вы — ему. Диалог останется в списке.',
        confirmLabel: 'Заблокировать', danger: true,
      });
      if (!ok) return;
      try {
        await Api.blockUser(u.id, true);
        toast('Пользователь заблокирован', { type: 'success' });
        closePanel();
      } catch (err) { toastError(err); }
    };
    host.querySelector('[data-mute]')?.addEventListener('click', () => doMute());
    host.querySelector('[data-edit-me]')?.addEventListener('click', () => Modals.openEditProfile());
    host.querySelector('[data-style-profile]')?.addEventListener('click', () => openProfileStudio(u));
    host.querySelectorAll('[data-profile-media-index]').forEach((node) => node.addEventListener('click', () => {
      openMediaList(res.profileGallery, Number(node.dataset.profileMediaIndex));
    }));
    host.querySelectorAll('[data-profile-gift]').forEach((node) => node.addEventListener('click', () => {
      const gift = res.gifts.find((item) => String(item.instanceId) === node.dataset.profileGift);
      if (!gift) return;
      const body = el('div', { class: `gift-detail-card rarity-${gift.rarity || 'обычный'}` },
        gift.imageUrl ? el('img', { class: 'gift-detail-image', src: gift.imageUrl, alt: gift.name }) : null,
        el('span', { class: 'gift-rarity' }, gift.rarity || 'обычный'),
        el('h2', {}, gift.name),
        gift.description ? el('p', { class: 'muted' }, gift.description) : null,
        el('p', { class: 'muted' }, `От ${gift.sender.name} (@${gift.sender.username}) · ${fmtFullDate(gift.createdAt)}`),
        gift.pinned ? el('small', { class: 'gift-stock' }, 'Закреплён в профиле') : null,
        gift.note ? el('p', { class: 'gift-note' }, gift.note) : null);
      modal({ title: 'Подарок в профиле', body });
    }));
    const doMute = async () => {
      if (!chat) return toast('Откройте диалог, чтобы настроить уведомления', { type: 'info' });
      try {
        const r = await Api.chatPrefs(chat.id, { muted: !chat.muted });
        patchChat(chat.id, r);
        render();
      } catch (err) { toastError(err); }
    };
    // Меню «⋮» в углу профиля: уведомления, жалоба, блокировка.
    if (!isSelf) {
      const head = host.querySelector('.panel-head');
      head.querySelector('[data-more]')?.remove();
      const more = el('button', { class: 'icon-btn panel-more', type: 'button', 'data-more': '', 'aria-label': 'Ещё' });
      more.innerHTML = icons.more;
      more.addEventListener('click', () => contextMenu([
        { label: chat?.muted ? 'Включить уведомления' : 'Без уведомлений', icon: chat?.muted ? 'bell' : 'bellOff', onClick: doMute },
        { type: 'sep' },
        { label: 'Пожаловаться', icon: 'alert', onClick: doReport },
        { label: 'Заблокировать', icon: 'shield', danger: true, onClick: doBlock },
      ], { anchor: more, align: 'right' }));
      head.append(more);
    }
    host.querySelectorAll('[data-open-chat]').forEach((btn) => btn.addEventListener('click', () => {
      bus.emit('nav:go', `#/chat/${btn.dataset.openChat}`);
      if (!isDesktop()) closePanel();
    }));
  } catch (err) {
    host.querySelector('.panel-body').innerHTML = stateScreen({ icon: 'alert', tone: 'error', title: 'Профиль недоступен', text: err.message });
  }
}

/* ───────────────────────── Информация о чате ─────────────────────────── */

async function renderChatInfo(host) {
  const chatId = panels.chatId;
  host.innerHTML = html`<div class="panel-head">
    <button class="icon-btn" data-close aria-label="Закрыть">${raw(icons.close)}</button>
    <h3>Информация</h3>
  </div>
  <div class="panel-body">${raw(loadingScreen())}</div>`;
  host.querySelector('[data-close]').addEventListener('click', closePanel);

  let info;
  try {
    info = state.chat?.chat.id === chatId ? state.chat : await Api.chat(chatId);
  } catch (err) {
    host.querySelector('.panel-body').innerHTML = stateScreen({ icon: 'alert', tone: 'error', title: 'Недоступно', text: err.message });
    return;
  }
  if (!panels.open) return;
  const { chat, members, role, permissions, pinnedMessages } = info;

  if (chat.type === 'dm' && chat.peer) return showUserProfile(chat.peer.id); // личный чат: показываем профиль собеседника

  const isChannel = chat.type === 'channel';
  const tab = panels.tab;

  host.querySelector('.panel-body').innerHTML = html`
    ${profileHeroHTML({ title: chat.title, avatarUrl: chat.avatarUrl, bannerUrl: chat.bannerUrl, profileTheme: isChannel ? 'ocean' : 'aurora' }, { kind: isChannel ? 'channel' : 'group', sub: `${isChannel ? 'Канал' : 'Группа'} · ${members.length} ${plural(members.length, isChannel ? 'подписчик' : 'участник', isChannel ? 'подписчика' : 'участника', isChannel ? 'подписчиков' : 'участников')}` })}

    <div class="tg-info">
      ${chat.description ? html`<div class="tg-info-row"><span class="tg-info-val">${chat.description}</span><span class="tg-info-lbl">Описание</span></div>` : ''}
      ${chat.username ? html`<div class="tg-info-row"><span class="tg-info-val accent">@${esc(chat.username)}</span><span class="tg-info-lbl">Ссылка</span></div>` : ''}
      <div class="tg-info-row"><span class="tg-info-val">${chat.isPublic ? 'Публичный' : 'Приватный'}${role === 'owner' ? ' · вы владелец' : role === 'admin' ? ' · вы администратор' : ''}</span><span class="tg-info-lbl">Доступ</span></div>
    </div>

    ${permissions.canEditInfo ? html`<div class="tg-actions">
      <button class="tg-action" data-primary data-edit>${raw(icons.edit)}Изменить</button>
      ${permissions.canAddMembers ? html`<button class="tg-action" data-add>${raw(icons.userPlus)}Добавить</button>` : ''}
      ${permissions.canManageInvites ? html`<button class="tg-action" data-invites>${raw(icons.link)}Приглашения</button>` : ''}
      ${permissions.canManageMembers ? html`<button class="tg-action" data-join-requests>${raw(icons.users)}Заявки</button>` : ''}
      ${permissions.canModerate ? html`<button class="tg-action" data-reports>${raw(icons.alert)}Жалобы</button>` : ''}
      ${permissions.canEditInfo && !isChannel ? html`<button class="tg-action" data-topics>${raw(icons.chats)}Темы</button>` : ''}
      ${permissions.canViewStats && isChannel ? html`<button class="tg-action" data-stats>${raw(icons.eye)}Статистика</button>` : ''}
      ${permissions.canPost && isChannel ? html`<button class="tg-action" data-scheduled>${raw(icons.clock)}Отложенные посты</button>` : ''}
      ${chat.username ? html`<button class="tg-action" data-copy-link>${raw(icons.link)}Ссылка</button>` : ''}
      <button class="tg-action" data-pins>${raw(icons.pin)}Закреплённые</button>
    </div>` : html`<div class="tg-actions">
      ${chat.username ? html`<button class="tg-action" data-primary data-copy-link>${raw(icons.link)}Ссылка</button>` : ''}
      <button class="tg-action" ${chat.username ? '' : raw('data-primary')} data-pins>${raw(icons.pin)}Закреплённые</button>
    </div>`}

    ${chat.protectedContent ? html`<div class="auth-note" style="margin-bottom:var(--sp-4)"><span class="ic">${raw(icons.shield)}</span><span>Копирование и пересылка запрещены владельцем</span></div>` : ''}

    <div class="tabs" data-tabs style="margin-bottom:var(--sp-4)">
      ${raw([['media', 'Медиа'], ['files', 'Файлы'], ['members', 'Участники']].map(([id, label]) => html`<button data-tab="${id}" aria-selected="${tab === id}">${label}</button>`).join(''))}
    </div>

    <div data-tab-body></div>`;

  host.querySelector('[data-close]').addEventListener('click', closePanel);
  host.querySelector('[data-edit]')?.addEventListener('click', () => Modals.openEditChat(chatId));
  host.querySelector('[data-add]')?.addEventListener('click', () => Modals.openAddMembers(chatId));
  host.querySelector('[data-invites]')?.addEventListener('click', () => openInviteManager(chatId));
  host.querySelector('[data-join-requests]')?.addEventListener('click', () => openJoinRequests(chatId));
  host.querySelector('[data-reports]')?.addEventListener('click', () => openChatReports(chatId));
  host.querySelector('[data-topics]')?.addEventListener('click', () => openTopicManager(chatId));
  host.querySelector('[data-stats]')?.addEventListener('click', () => openChannelStats(chatId));
  host.querySelector('[data-scheduled]')?.addEventListener('click', () => openScheduledPosts(chatId));
  host.querySelector('[data-pins]')?.addEventListener('click', () => {
    if (!pinnedMessages?.length) return toast('Нет закреплённых сообщений', { type: 'info' });
    bus.emit('nav:go', `#/chat/${chatId}`);
    setTimeout(() => bus.emit('message:focus', pinnedMessages[0].id), 300);
  });
  host.querySelector('[data-copy-link]')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#/join/${chat.username}`;
    navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована', { type: 'success' }), () => toast(url));
  });
  const doDeleteChat = async () => {
    const ok = await confirmDialog({
      title: 'Удалить чат для всех?',
      text: 'Все сообщения и медиа будут удалены безвозвратно.',
      confirmLabel: 'Удалить', danger: true,
    });
    if (!ok) return;
    try {
      await Api.deleteChat(chatId, true);
      closePanel();
      bus.emit('nav:go', '#/chats');
    } catch (err) { toastError(err); }
  };
  if (role === 'owner') {
    const head = host.querySelector('.panel-head');
    head.querySelector('[data-more]')?.remove();
    const more = el('button', { class: 'icon-btn panel-more', type: 'button', 'data-more': '', 'aria-label': 'Ещё' });
    more.innerHTML = icons.more;
    more.addEventListener('click', () => contextMenu([
      { label: 'Удалить чат', icon: 'trash', danger: true, onClick: doDeleteChat },
    ], { anchor: more, align: 'right' }));
    head.append(more);
  }

  $('[data-tabs]', host).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    panels.tab = btn.dataset.tab;
    $$('[data-tab]', host).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    renderTab(host, chatId, members, role, isChannel);
  });
  renderTab(host, chatId, members, role, isChannel);
}

function openInviteManager(chatId) {
  const maxUses = el('input', { class: 'input', type: 'number', min: '1', max: '10000', placeholder: 'Без лимита' });
  const expiresInHours = el('input', { class: 'input', type: 'number', min: '1', max: '8760', placeholder: 'Без срока' });
  const error = el('div', { class: 'field-msg' });
  const linkInput = el('input', { class: 'input', readonly: true, 'aria-label': 'Созданная ссылка-приглашение' });
  const linkMessage = el('div', { class: 'field-msg' });
  const copyLinkButton = el('button', { class: 'btn btn-sm', type: 'button' }, 'Скопировать');
  const linkBox = el('div', { class: 'col gap-2', hidden: true },
    el('span', { class: 'field-label' }, 'Новая ссылка — сохраните её сейчас'),
    el('div', { class: 'row gap-2' }, linkInput, copyLinkButton),
    linkMessage);
  const list = el('div', { class: 'col gap-2' });
  const body = el('div', { class: 'col gap-3' },
    el('p', { class: 'muted small' }, 'Ссылки можно ограничить по числу вступлений и сроку действия. Отозванная ссылка сразу перестаёт работать.'),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Максимум использований'), maxUses),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Срок действия, часов'), expiresInHours),
    error,
    linkBox,
    el('h4', {}, 'Активные и прошлые приглашения'),
    list);
  const m = modal({
    title: 'Приглашения',
    subtitle: 'Ссылки дают доступ к этому чату. Не публикуйте их в открытом доступе, если чат закрытый.',
    body,
    footer: [
      el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть'),
      el('button', { class: 'btn btn-primary', type: 'button', onClick: createInvite }, 'Создать ссылку'),
    ],
  });
  copyLinkButton.addEventListener('click', copyInviteLink);

  async function refresh() {
    try {
      const { invites } = await Api.chatInvites(chatId);
      list.innerHTML = invites.map((invite) => {
        const stateLabel = invite.revoked_at ? 'Отозвана'
          : invite.expires_at && invite.expires_at <= Date.now() ? 'Истекла'
            : invite.max_uses !== null && invite.use_count >= invite.max_uses ? 'Лимит использован'
              : 'Действует';
        return html`<div class="settings-card col gap-2">
          <div class="row-between"><b>${stateLabel}</b><span class="muted small">${invite.use_count}${invite.max_uses === null ? '' : ` / ${invite.max_uses}`}</span></div>
          <div class="muted small">${invite.expires_at ? `До ${new Date(invite.expires_at).toLocaleString()}` : 'Без срока действия'}</div>
          ${!invite.revoked_at && (!invite.expires_at || invite.expires_at > Date.now()) && (invite.max_uses === null || invite.use_count < invite.max_uses)
            ? html`<button class="btn btn-sm btn-danger" type="button" data-revoke="${invite.id}">Отозвать</button>` : ''}
        </div>`;
      }).join('') || '<p class="muted">Приглашений пока нет.</p>';
      list.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', async () => {
        try {
          await Api.revokeChatInvite(chatId, Number(button.dataset.revoke));
          await refresh();
        } catch (err) { toastError(err); }
      }));
    } catch (err) {
      list.innerHTML = '';
      error.textContent = err.message;
    }
  }

  async function createInvite() {
    error.textContent = '';
    try {
      const result = await Api.createChatInvite(chatId, {
        maxUses: maxUses.value || null,
        expiresInHours: expiresInHours.value || null,
      });
      const url = `${location.origin}${location.pathname}#/invite/${result.invite.token}`;
      linkInput.value = url;
      linkBox.hidden = false;
      linkMessage.textContent = '';
      maxUses.value = '';
      expiresInHours.value = '';
      await refresh();
      try {
        await navigator.clipboard.writeText(url);
        toast('Ссылка создана и скопирована', { type: 'success' });
      } catch {
        linkMessage.textContent = 'Ссылка создана, но браузер не разрешил копирование. Скопируйте её из поля выше.';
        linkInput.focus();
        linkInput.select();
      }
    } catch (err) {
      error.textContent = err.message;
    }
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      linkMessage.textContent = '';
      toast('Ссылка скопирована', { type: 'success' });
    } catch {
      linkInput.focus();
      linkInput.select();
      linkMessage.textContent = 'Браузер не разрешил копирование. Выделите ссылку и скопируйте её вручную.';
    }
  }

  refresh();
}

function openJoinRequests(chatId) {
  const error = el('div', { class: 'field-msg' });
  const list = el('div', { class: 'col gap-2' }, 'Загрузка заявок…');
  const m = modal({
    title: 'Заявки на вступление',
    subtitle: 'Одобренные пользователи станут участниками сообщества.',
    body: el('div', { class: 'col gap-3' }, error, list),
    footer: [el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть')],
  });

  async function refresh() {
    error.textContent = '';
    try {
      const { requests } = await Api.chatJoinRequests(chatId);
      list.innerHTML = requests.map((request) => html`<div class="settings-card col gap-2">
        <div class="row gap-3">
          ${avatarHTML({ name: request.name, avatarUrl: request.avatarUrl, color: request.avatarColor, size: 'sm' })}
          <div class="col grow">
            <b>${esc(request.name)}</b>
            <span class="muted small">@${esc(request.username)} · ${new Date(request.createdAt).toLocaleString()}</span>
          </div>
        </div>
        ${request.bio ? html`<div class="muted small">${esc(request.bio)}</div>` : ''}
        <div class="row gap-2">
          <button class="btn btn-sm btn-primary" type="button" data-approve="${request.id}">Одобрить</button>
          <button class="btn btn-sm btn-danger" type="button" data-decline="${request.id}">Отклонить</button>
        </div>
      </div>`).join('') || '<p class="muted">Ожидающих заявок нет.</p>';
      list.querySelectorAll('[data-approve], [data-decline]').forEach((button) => button.addEventListener('click', async () => {
        const requestId = Number(button.dataset.approve || button.dataset.decline);
        const action = button.hasAttribute('data-approve') ? 'approve' : 'decline';
        button.disabled = true;
        try {
          await Api.decideChatJoinRequest(chatId, requestId, action);
          await refresh();
        } catch (err) {
          button.disabled = false;
          error.textContent = err.message;
        }
      }));
    } catch (err) {
      list.innerHTML = '';
      error.textContent = err.message;
    }
  }

  refresh();
}

function openChannelStats(chatId) {
  const error = el('div', { class: 'field-msg' });
  const content = el('div', { class: 'col gap-3' }, 'Загрузка статистики…');
  const m = modal({
    title: 'Статистика канала',
    subtitle: 'Сводные показатели и активность за последние 30 дней.',
    body: el('div', { class: 'col gap-3' }, error, content),
    footer: [el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть')],
  });
  Api.chatStats(chatId).then(({ summary, activity }) => {
    const cards = [
      ['Подписчики', summary.subscribers],
      ['Публикации', summary.posts],
      ['Просмотры', summary.views],
      ['Комментарии', summary.comments],
      ['Реакции', summary.reactions],
    ];
    content.innerHTML = html`
      <div class="grid-2 gap-2">${raw(cards.map(([label, count]) => html`<div class="settings-card">
        <div class="muted small">${label}</div><strong>${Number(count).toLocaleString()}</strong>
      </div>`).join(''))}</div>
      <h4>Активность по дням</h4>
      ${activity.length ? html`<div class="col gap-1">${raw(activity.slice().reverse().map((day) => html`
        <div class="row-between settings-card">
          <strong>${new Date(`${day.day}T00:00:00Z`).toLocaleDateString()}</strong>
          <span class="muted small">${day.posts} постов · ${day.views} просмотров · ${day.comments} комментариев · ${day.reactions} реакций</span>
        </div>`).join(''))}</div>` : '<p class="muted">За последние 30 дней активности пока нет.</p>'}`;
  }).catch((err) => {
    content.innerHTML = '';
    error.textContent = err.message;
  });
}

function openChatReports(chatId) {
  const error = el('div', { class: 'field-msg' });
  const list = el('div', { class: 'col gap-2' }, 'Загрузка жалоб…');
  const m = modal({
    title: 'Жалобы на публикации',
    subtitle: 'Выберите действие. Удаление поста и участника применяется ко всем участникам сообщества.',
    body: el('div', { class: 'col gap-3' }, error, list),
    footer: [el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть')],
  });

  async function refresh() {
    error.textContent = '';
    try {
      const { reports } = await Api.chatReports(chatId);
      list.innerHTML = reports.map((report) => html`<div class="settings-card col gap-2">
        <div><b>${esc(report.authorName || 'Удалённый пользователь')}</b> · <span class="muted small">@${esc(report.authorUsername || '')}</span></div>
        <div class="muted small">Жалоба от ${esc(report.reporterName)} (@${esc(report.reporterUsername)}) · ${new Date(report.createdAt).toLocaleString()}</div>
        <div><b>Причина:</b> ${esc({ spam: 'Спам', abuse: 'Оскорбления', scam: 'Мошенничество', other: 'Другое' }[report.reason] || report.reason)}</div>
        ${report.details ? html`<div>${esc(report.details)}</div>` : ''}
        <blockquote class="muted">${report.messageText ? esc(report.messageText) : `Сообщение типа «${esc(report.messageType)}»`}</blockquote>
        <div class="row gap-2">
          <button class="btn btn-sm" type="button" data-report-dismiss="${report.id}">Отклонить жалобу</button>
          <button class="btn btn-sm btn-danger" type="button" data-report-delete="${report.id}">Удалить пост</button>
          ${report.authorId ? html`<button class="btn btn-sm btn-danger" type="button" data-report-remove="${report.id}">Удалить автора</button>` : ''}
        </div>
      </div>`).join('') || '<p class="muted">Ожидающих жалоб нет.</p>';
      list.querySelectorAll('[data-report-dismiss], [data-report-delete], [data-report-remove]').forEach((button) => button.addEventListener('click', async () => {
        const reportId = Number(button.dataset.reportDismiss || button.dataset.reportDelete || button.dataset.reportRemove);
        const action = button.hasAttribute('data-report-dismiss') ? 'dismiss'
          : button.hasAttribute('data-report-delete') ? 'removeMessage' : 'removeMember';
        button.disabled = true;
        try {
          await Api.decideChatReport(chatId, reportId, action);
          await refresh();
        } catch (err) {
          button.disabled = false;
          error.textContent = err.message;
        }
      }));
    } catch (err) {
      list.innerHTML = '';
      error.textContent = err.message;
    }
  }

  refresh();
}

function openScheduledPosts(chatId) {
  const text = el('textarea', { class: 'textarea', maxlength: 10000, placeholder: 'Текст публикации' });
  const scheduleAt = el('input', { class: 'input', type: 'datetime-local' });
  const error = el('div', { class: 'field-msg' });
  const list = el('div', { class: 'col gap-2' }, 'Загрузка публикаций…');
  const create = el('button', { class: 'btn btn-primary', type: 'button' }, 'Запланировать');
  const m = modal({
    title: 'Отложенные публикации',
    subtitle: 'Текстовые посты публикуются сервером автоматически в указанное время.',
    body: el('div', { class: 'col gap-3' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Текст поста'), text),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Дата и время (ваше местное время)'), scheduleAt),
      error, create, el('h4', {}, 'Запланированные и неудачные'), list),
    footer: [el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть')],
  });
  const minDate = new Date(Date.now() + 60 * 1000 - new Date().getTimezoneOffset() * 60 * 1000);
  scheduleAt.min = minDate.toISOString().slice(0, 16);
  create.addEventListener('click', async () => {
    error.textContent = '';
    const scheduledAt = new Date(scheduleAt.value).getTime();
    try {
      await Api.createScheduledPost(chatId, { text: text.value, scheduledAt });
      text.value = '';
      scheduleAt.value = '';
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  });

  async function refresh() {
    try {
      const { posts } = await Api.scheduledPosts(chatId);
      list.innerHTML = posts.map((post) => html`<div class="settings-card col gap-2">
        <div class="row-between"><b>${post.status === 'failed' ? 'Не опубликовано' : 'Запланировано'}</b>
          <span class="muted small">${new Date(post.scheduledAt).toLocaleString()}</span></div>
        <div>${esc(post.text)}</div>
        ${post.failureReason ? html`<div class="field-msg">${esc(post.failureReason)}</div>` : ''}
        ${post.status === 'scheduled' ? html`<button class="btn btn-sm btn-danger" type="button" data-cancel-scheduled="${post.id}">Отменить</button>` : ''}
      </div>`).join('') || '<p class="muted">Отложенных публикаций нет.</p>';
      list.querySelectorAll('[data-cancel-scheduled]').forEach((button) => button.addEventListener('click', async () => {
        try {
          await Api.cancelScheduledPost(chatId, Number(button.dataset.cancelScheduled));
          await refresh();
        } catch (err) {
          error.textContent = err.message;
        }
      }));
    } catch (err) {
      list.innerHTML = '';
      error.textContent = err.message;
    }
  }

  refresh();
}

export function openTopicManager(chatId) {
  const title = el('input', { class: 'input', maxlength: 50, placeholder: 'Название темы' });
  const error = el('div', { class: 'field-msg' });
  const list = el('div', { class: 'col gap-2' });
  const create = el('button', { class: 'btn btn-primary', type: 'button' }, 'Создать тему');
  const m = modal({
    title: 'Темы группы',
    subtitle: 'В каждой теме отдельная лента сообщений. Закрытая тема доступна для чтения, но не для новых сообщений.',
    body: el('div', { class: 'col gap-3' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Новая тема'), title),
      error, create, list),
    footer: [el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Закрыть')],
  });
  create.addEventListener('click', async () => {
    error.textContent = '';
    try {
      await Api.createChatTopic(chatId, title.value);
      title.value = '';
      bus.emit('chat:topics-updated', { chatId });
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  });

  async function refresh() {
    try {
      const { topics } = await Api.chatTopics(chatId);
      list.innerHTML = topics.map((topic) => html`<div class="settings-card row-between">
        <div class="col"><b>${esc(topic.title)}</b>${topic.isDefault ? '<span class="muted small">Основная тема</span>' : ''}</div>
        ${topic.isDefault ? '' : html`<button class="btn btn-sm" type="button" data-topic-toggle="${topic.id}" data-closed="${topic.isClosed}">
          ${topic.isClosed ? 'Открыть' : 'Закрыть'}
        </button>`}
      </div>`).join('');
      list.querySelectorAll('[data-topic-toggle]').forEach((button) => button.addEventListener('click', async () => {
        try {
          await Api.setChatTopicClosed(chatId, Number(button.dataset.topicToggle), button.dataset.closed !== 'true');
          bus.emit('chat:topics-updated', { chatId });
          await refresh();
        } catch (err) {
          error.textContent = err.message;
        }
      }));
    } catch (err) {
      error.textContent = err.message;
    }
  }

  refresh();
}

async function renderTab(host, chatId, members, role, isChannel = false) {
  const body = host.querySelector('[data-tab-body]');
  if (!body) return;

  if (panels.tab === 'members') {
    const online = members.filter((m) => !isMe(m.id) && (state.presence[m.id]?.presence || m.presence) === 'online').length;
    body.innerHTML = html`
      <div class="row-between" style="margin-bottom:8px">
        <span class="settings-group" style="margin:0"><h4 style="margin:0">${isChannel ? 'Подписчики' : `Участники · ${members.length}`}</h4></span>
        <span class="chip">${online ? `${online} в сети` : 'все офлайн'}</span>
      </div>
      <div class="col gap-1">${raw(members.map((m) => memberRow(m, role, chatId)).join(''))}</div>`;
    body.querySelectorAll('[data-member]').forEach((node) => {
      node.addEventListener('click', () => {
        const id = Number(node.dataset.member);
        const member = members.find((x) => x.id === id);
        if (isMe(id)) return showUserProfile(id);
        const items = [
          { label: 'Открыть профиль', icon: 'user', onClick: () => showUserProfile(id) },
          { label: 'Написать', icon: 'reply', onClick: async () => {
            try { const r = await Api.openDm(id); bus.emit('nav:go', `#/chat/${r.chat.id}`); } catch (err) { toastError(err); }
          } },
        ];
        if (role === 'owner' && !isMe(id) && member.role !== 'owner') {
          items.push({ type: 'sep' });
          if (member.role === 'admin') {
            items.push({ label: 'Настроить права администратора', icon: 'shield', onClick: () => openAdminPermissions(chatId, id, member.permissions || null) });
            items.push({ label: 'Снять администратора', icon: 'userMinus', onClick: () => setRole(chatId, id, 'member') });
          } else {
            items.push({ label: 'Сделать администратором', icon: 'shield', onClick: () => openAdminPermissions(chatId, id) });
          }
        }
        if (state.chat?.permissions?.canManageMembers && !isMe(id) && member.role !== 'owner') {
          items.push({ label: 'Удалить из чата', icon: 'userMinus', danger: true, onClick: () => kick(chatId, id, member.name) });
        }
        contextMenu(items, { x: 0, y: 0, anchor: node, align: 'auto' });
      });
    });
    return;
  }

  // Медиа / файлы: постраничная подгрузка
  body.innerHTML = panels.tab === 'media' ? skeletonList(2) : '<div class="spinner"></div>';
  try {
    if (panels.tab === 'media') {
      const res = await Api.chatMedia(chatId, panels.mediaOffset);
      panels.mediaItems.push(...res.items);
      if (!panels.mediaItems.length) {
        body.innerHTML = stateScreen({ icon: 'image', title: 'Медиа пока нет', text: 'Фото и видео из этого чата появятся здесь.' });
        return;
      }
      body.innerHTML = html`<div class="media-grid">${raw(panels.mediaItems.map((m, i) => html`<div class="media-cell" data-media-index="${i}" ${m.kind === 'video' ? `data-video="${m.messageId}"` : `data-photo="${m.messageId}"`}>
          ${m.kind === 'video' ? html`<video src="${esc(m.url)}" muted playsinline preload="metadata"></video>` : html`<img src="${esc(m.url)}" alt="" loading="lazy">`}
          ${m.kind === 'video' ? html`<span class="dur">${raw(icons.play)} ${fmtDuration(m.duration || 0)}</span>` : ''}
        </div>`).join(''))}</div>
        ${res.hasMore ? html`<button class="btn btn-block" style="margin-top:12px" data-more>Показать ещё</button>` : ''}`;
      body.querySelectorAll('[data-media-index]').forEach((cell) => cell.addEventListener('click', () => {
        openMediaList(panels.mediaItems, Number(cell.dataset.mediaIndex));
      }));
      body.querySelector('[data-more]')?.addEventListener('click', () => { panels.mediaOffset += 24; renderTab(host, chatId, members, role, isChannel); });
    } else {
      const res = await Api.chatFiles(chatId, 0);
      if (!res.items.length) {
        body.innerHTML = stateScreen({ icon: 'file', title: 'Файлов нет', text: 'Документы и голосовые сообщения появятся здесь.' });
        return;
      }
      body.innerHTML = html`<div class="col gap-1">${raw(res.items.map((f) => html`<div class="list-item">
        <span class="ic" style="width:34px;height:34px;border-radius:11px;background:var(--surface-2);display:grid;place-items:center">${raw(icons[f.kind === 'voice' ? 'mic' : f.mime?.startsWith('audio') ? 'volume' : 'file'])}</span>
        <span class="col grow" style="min-width:0">
          <span class="title truncate">${f.kind === 'voice' ? 'Голосовое сообщение' : f.filename}</span>
          <span class="sub">${fmtBytes(f.size)}${f.duration ? ` · ${fmtDuration(f.duration)}` : ''}</span>
        </span>
        <a class="icon-btn" href="${esc(f.url)}" download="${esc(f.filename || 'file')}" title="Скачать">${raw(icons.download)}</a>
      </div>`).join(''))}</div>`;
    }
  } catch (err) {
    body.innerHTML = stateScreen({ icon: 'alert', tone: 'error', title: 'Не удалось загрузить', text: err.message });
  }
}

function memberRow(m, role, chatId) {
  const presence = state.presence[m.id]?.presence || m.presence;
  const roleChip = m.role === 'owner' ? '<span class="role-chip owner">владелец</span>'
    : m.role === 'admin' ? '<span class="role-chip admin">админ</span>' : '';
  return html`<div class="member-row" data-member="${m.id}" role="button" tabindex="0">
    ${raw(avatarHTML({ name: m.name, avatarUrl: m.avatarUrl, color: m.avatarColor, size: 'sm', presence: presence === 'online' ? 'online' : null }))}
    <span class="col grow" style="min-width:0">
      <span class="row gap-2" style="min-width:0"><span class="bold truncate">${m.name}</span>${isMe(m.id) ? raw('<span class="mute tiny">(вы)</span>') : ''}${raw(roleChip)}</span>
      <span class="sub truncate">@${m.username}${presence === 'online' ? ' · в сети' : ''}</span>
    </span>
  </div>`;
}

async function setRole(chatId, userId, nextRole) {
  try {
    await Api.setRole(chatId, userId, nextRole);
    toast(nextRole === 'admin' ? 'Права администратора выданы' : 'Права сняты', { type: 'success' });
    const info = await Api.chat(chatId);
    if (state.chat?.chat.id === chatId) state.chat = info;
    render();
  } catch (err) { toastError(err); }
}

function openAdminPermissions(chatId, userId, selectedPermissions = null) {
  const items = [
    ['manage_info', 'Изменять информацию и настройки'],
    ['publish', 'Публиковать сообщения'],
    ['manage_members', 'Добавлять, удалять участников и обрабатывать заявки'],
    ['manage_invites', 'Создавать и отзывать ссылки-приглашения'],
    ['moderate', 'Рассматривать жалобы и удалять публикации'],
    ['view_stats', 'Просматривать статистику'],
    ['pin_messages', 'Закреплять сообщения'],
  ];
  const checkboxes = items.map(([permission]) => el('input', {
    type: 'checkbox', value: permission,
    checked: selectedPermissions ? selectedPermissions.includes(permission) : true,
  }));
  const body = el('div', { class: 'col gap-2' },
    ...items.map(([permission, label], index) => el('label', { class: 'switch' },
      checkboxes[index], el('span', { class: 'track' }), el('span', { class: 'label' }, label))));
  const m = modal({
    title: 'Права администратора',
    body,
    footer: [
      el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Отмена'),
      el('button', { class: 'btn btn-primary', type: 'button', onClick: async () => {
        try {
          await Api.setRole(chatId, userId, 'admin', checkboxes.filter((input) => input.checked).map((input) => input.value));
          toast('Права администратора сохранены', { type: 'success' });
          const info = await Api.chat(chatId);
          if (state.chat?.chat.id === chatId) state.chat = info;
          render();
          m.close();
        } catch (err) {
          toastError(err);
        }
      } }, 'Назначить'),
    ],
  });
}

async function kick(chatId, userId, name) {
  const ok = await confirmDialog({
    title: `Удалить ${name} из чата?`,
    text: 'Участник перестанет видеть сообщения и не сможет вернуться без приглашения.',
    confirmLabel: 'Удалить', danger: true,
  });
  if (!ok) return;
  try {
    await Api.removeMember(chatId, userId);
    toast('Участник удалён', { type: 'success' });
    const info = await Api.chat(chatId);
    if (state.chat?.chat.id === chatId) state.chat = info;
    render();
  } catch (err) { toastError(err); }
}

export const isPanelOpen = () => panels.open;
export const panelChatId = () => panels.chatId;
