/**
 * Диалоги: новый чат, создание группы/канала, пересылка, добавление участников,
 * редактирование чата и профиля, информация о сообщении.
 */
import { $, $$, el, esc, html, raw, debounce, fmtBytes, fmtDayLabel, fmtTime, initials } from '../util.js';
import { icons } from '../icons.js';
import { checkCreateLimit } from '../premium.js?v=20261031-verified-badge-1';
import { state, bus, chatById, patchChat, upsertChat } from '../store.js';
import { avatarHTML, modal, toast, toastError, confirmDialog, AVATAR_COLORS, contextMenu } from '../ui.js?v=20261029-no-toasts-1';
import { Api, api } from '../api.js?v=20261102-gifts-2';
import { compressImage, cropImage, makeThumb } from '../media.js?v=20261027-cropper-1';

let mounted = false;

/**
 * Подписка на события интерфейса: модалки открываются по действиям из rail, шапки,
 * списка чатов и контекстных меню — единая точка входа вместо разрозненных вызовов.
 */
export function mount() {
  if (mounted) return;
  mounted = true;
  bus.on('create:dm', () => openCreate('dm'));
  bus.on('create:group', () => openCreate('group'));
  bus.on('create:channel', () => openCreate('channel'));
  bus.on('profile:edit', (payload) => openEditProfile(payload?.field || null));
  bus.on('forward:messages', ({ ids } = {}) => { if (ids?.length) openForward(ids); });
  bus.on('chat:edit', ({ chatId } = {}) => { if (chatId) openEditChat(chatId); });
  bus.on('chat:add-members', ({ chatId } = {}) => { if (chatId) openAddMembers(chatId); });
}

/* ───────────────────────── Универсальный выбор людей ──────────────────── */

/**
 * Список пользователей с поиском и множественным выбором — используется в группе,
 * канале и добавлении участников.
 */
function userPicker({ title, subtitle = '', multiple = true, selected = new Set(), exclude = [], onConfirm, confirmLabel = 'Готово', extra = null }) {
  const list = el('div', { class: 'col gap-1', style: 'min-height:180px;max-height:44vh;overflow:auto' });
  const search = el('input', { class: 'input', placeholder: 'Поиск по имени или @username', 'aria-label': 'Поиск пользователей' });
  const footer = el('div', { class: 'row-between', style: 'width:100%' });
  let results = [];
  let query = '';

  const body = el('div', { class: 'col gap-3' }, subtitle ? el('p', { class: 'muted small' }, subtitle) : null, search, list, extra);
  const m = modal({
    title,
    body,
    footer: [footer],
  });

  const draw = () => {
    if (!results.length) {
      list.innerHTML = `<p class="muted small" style="padding:12px">${query ? 'Никого не найдено' : 'Начните вводить имя или username'}</p>`;
      return;
    }
    list.innerHTML = results.map((u) => html`<button class="list-item ${selected.has(u.id) ? 'selected' : ''}" data-user="${u.id}">
      ${raw(avatarHTML({ name: u.name, avatarUrl: u.avatarUrl, color: u.avatarColor, presence: u.online ? 'online' : null, size: 'sm' }))}
      <span class="col grow" style="min-width:0">
        <span class="title truncate">${u.name}</span>
        <span class="sub truncate">@${u.username}${u.bio ? ` · ${esc(u.bio).slice(0, 40)}` : ''}</span>
      </span>
      ${multiple ? html`<span class="check">${raw(icons.check)}</span>` : ''}
    </button>`).join('');
    list.querySelectorAll('[data-user]').forEach((btn) => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.user);
      if (multiple) {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        btn.classList.toggle('selected', selected.has(id));
      } else {
        selected.clear(); selected.add(id);
        onConfirm([...selected]);
        m.close();
      }
      paintFooter();
    }));
  };

  const paintFooter = () => {
    footer.innerHTML = html`
      <div class="row gap-3">
        <span class="small muted">${selected.size ? `Выбрано: ${selected.size}` : 'Выберите участников'}</span>
      </div>
      <div class="row gap-2">
        <button class="btn" data-cancel>Отмена</button>
        <button class="btn btn-primary" data-confirm ${multiple && !selected.size ? 'disabled' : ''}>${confirmLabel}${selected.size ? ` (${selected.size})` : ''}</button>
      </div>`;
    footer.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    footer.querySelector('[data-confirm]').addEventListener('click', () => { onConfirm([...selected]); m.close(); });
  };

  const run = debounce(async () => {
    if (!query) { results = []; draw(); return; }
    list.innerHTML = `<div class="row center" style="padding:20px"><span class="spinner"></span></div>`;
    try {
      const res = await Api.search(query, 'users');
      results = res.users.filter((u) => !exclude.includes(u.id));
      draw();
    } catch (err) {
      list.innerHTML = `<p class="muted small" style="padding:12px">${esc(err.message)}</p>`;
    }
  }, 240);

  search.addEventListener('input', () => { query = search.value.trim(); run(); });
  paintFooter();
  setTimeout(() => search.focus(), 90);
  return m;
}

/* ───────────────────────── Создание чата / группы / канала ───────────── */

export function openCreate(type = 'dm') {
  if (type === 'dm') return openNewChat();
  if (type === 'group') return openNewGroup();
  if (type === 'channel') return openNewChannel();
  if (type === 'search') return bus.emit('nav:go', '#/search');
}

function openNewChat() {
  const selected = new Set();
  userPicker({
    title: 'Новый чат',
    subtitle: 'Найдите человека по имени или username. Если диалог уже есть — он просто откроется.',
    multiple: false,
    selected,
    confirmLabel: 'Написать',
    onConfirm: async ([userId]) => {
      if (!userId) return;
      try {
        const res = await Api.openDm(userId);
        upsertChat(res.chat);
        bus.emit('nav:go', `#/chat/${res.chat.id}`);
      } catch (err) { toastError(err); }
    },
  });
}

export function openDmWith(userId) {
  Api.openDm(userId).then((res) => {
    upsertChat(res.chat);
    bus.emit('nav:go', `#/chat/${res.chat.id}`);
  }).catch(toastError);
}

async function waitForUploads(...getUploads) {
  while (true) {
    const uploads = getUploads.map((getUpload) => getUpload());
    const results = await Promise.allSettled(uploads);
    const failed = results.findIndex((result, index) =>
      result.status === 'rejected' && uploads[index] === getUploads[index]());
    if (failed !== -1) throw results[failed].reason;
    if (uploads.every((upload, index) => upload === getUploads[index]())) return;
  }
}

function openNewGroup() {
  const titleInput = el('input', { class: 'input', placeholder: 'Например: «Команда Aurora»', maxlength: 64 });
  const descInput = el('textarea', { class: 'textarea', placeholder: 'О чём чат? (необязательно)', maxlength: 400, style: 'min-height:70px' });
  const avatarInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const avatarPreview = el('label', { class: 'avatar-drop', style: 'width:84px;height:84px', html: `<span data-ph>${icons.camera}</span><span class="hint">Фото</span>` });
  avatarPreview.append(avatarInput);
  const selected = new Set();
  const chips = el('div', { class: 'row gap-2', style: 'flex-wrap:wrap' });
  const msg = el('div', { class: 'field-msg' });
  let avatarMedia = null;
  let avatarUpload = Promise.resolve();
  let avatarUploadSequence = 0;

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('Файл больше 8 МБ', { type: 'error' });
    const sequence = ++avatarUploadSequence;
    avatarMedia = null;
    avatarUpload = (async () => {
      const cropped = await cropImage(file, { aspectRatio: 1, title: 'Обрезать фото группы', subtitle: 'Выберите квадратную область для аватара.' });
      if (!cropped || sequence !== avatarUploadSequence) return;
      const { file: compressed } = await compressImage(cropped, { maxDim: 512, quality: 0.9 });
      if (sequence !== avatarUploadSequence) return;
      avatarPreview.querySelector('[data-ph]').innerHTML = `<img src="${URL.createObjectURL(compressed)}" style="width:100%;height:100%;object-fit:cover">`;
      const thumb = await makeThumb(compressed, { maxDim: 256, quality: 0.8 });
      const up = await api.upload(compressed, { kind: 'avatar', thumb });
      if (sequence === avatarUploadSequence) avatarMedia = up.media;
    })();
    try {
      await waitForUploads(() => avatarUpload);
    } catch (err) {
      if (sequence === avatarUploadSequence) toastError(err);
    }
  });

  const body = el('div', { class: 'col gap-4 create-form' },
    el('div', { class: 'create-avatar' }, avatarPreview, el('span', { class: 'create-avatar-hint' }, 'Фото группы')),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Название группы'), titleInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Описание'), descInput),
    el('div', { class: 'create-section' },
      el('span', { class: 'field-label' }, 'Участники'),
      el('button', { class: 'btn btn-block', type: 'button', onClick: () => pickMembers(selected, chips) }, 'Добавить участников'),
      chips, msg));

  const m = modal({
    title: 'Новая группа',
    subtitle: 'Название, описание, фото и участники — группа появится у всех сразу.',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          const title = titleInput.value.trim();
          if (title.length < 2) { msg.style.color = 'var(--err)'; msg.textContent = 'Название минимум 2 символа'; return; }
          {
            const lim = checkCreateLimit(state.user, state.chats, 'group');
            if (!lim.ok) { msg.style.color = 'var(--err)'; msg.textContent = `Достигнут лимит: групп ${lim.limit}.${state.user?.isPremium ? '' : ' С Premium можно больше'}`; return; }
          }
          try {
            await waitForUploads(() => avatarUpload);
            const res = await Api.createGroup({
              title,
              description: descInput.value.trim(),
              avatarMediaId: avatarMedia?.id || null,
              memberIds: [...selected],
            });
            upsertChat(res.chat);
            toast('Группа создана', { type: 'success' });
            m.close();
            bus.emit('nav:go', `#/chat/${res.chat.id}`);
          } catch (err) { msg.style.color = 'var(--err)'; msg.textContent = err.message; }
        },
      }, 'Создать группу'),
    ],
  });

  function pickMembers(set, chipHost) {
    const localSelected = new Set(set);
    userPicker({
      title: 'Кого добавить?',
      multiple: true,
      selected: localSelected,
      exclude: [state.user.id],
      confirmLabel: 'Добавить',
      onConfirm: (ids) => {
        set.clear();
        ids.forEach((id) => set.add(id));
        paintChips(set, chipHost);
      },
    });
  }

  function paintChips(set, chipHost) {
    chipHost.innerHTML = [...set].map((id) => {
      const c = state.chats.find((x) => x.peer?.id === id);
      const name = c?.peer?.name || `ID ${id}`;
      return `<span class="chip accent">${esc(name)}<button data-remove-user="${id}" style="margin-left:4px">×</button></span>`;
    }).join('');
    chipHost.querySelectorAll('[data-remove-user]').forEach((btn) => btn.addEventListener('click', () => {
      set.delete(Number(btn.dataset.removeUser));
      paintChips(set, chipHost);
    }));
  }
}

function openNewChannel() {
  const titleInput = el('input', { class: 'input', placeholder: 'Например: «Aurora News»', maxlength: 64 });
  const usernameInput = el('input', { class: 'input', placeholder: 'aurora_news', maxlength: 24 });
  const descInput = el('textarea', { class: 'textarea', placeholder: 'О чём канал?', maxlength: 400, style: 'min-height:70px' });
  const publicInput = el('input', { type: 'checkbox', checked: true });
  const msg = el('div', { class: 'field-msg' });
  const avatarInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const avatarPreview = el('label', { class: 'avatar-drop', style: 'width:84px;height:84px;border-radius:22px', html: `<span data-ph>${icons.camera}</span><span class="hint">Фото</span>` });
  avatarPreview.append(avatarInput);
  let avatarMedia = null;
  let avatarUpload = Promise.resolve();
  let avatarUploadSequence = 0;

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const sequence = ++avatarUploadSequence;
    avatarMedia = null;
    avatarUpload = (async () => {
      const cropped = await cropImage(file, { aspectRatio: 1, title: 'Обрезать фото канала', subtitle: 'Выберите квадратную область для аватара.' });
      if (!cropped || sequence !== avatarUploadSequence) return;
      const { file: compressed } = await compressImage(cropped, { maxDim: 512, quality: 0.9 });
      if (sequence !== avatarUploadSequence) return;
      avatarPreview.querySelector('[data-ph]').innerHTML = `<img src="${URL.createObjectURL(compressed)}" style="width:100%;height:100%;object-fit:cover">`;
      const thumb = await makeThumb(compressed, { maxDim: 256, quality: 0.8 });
      const up = await api.upload(compressed, { kind: 'avatar', thumb });
      if (sequence === avatarUploadSequence) avatarMedia = up.media;
    })();
    try {
      await avatarUpload;
    } catch (err) {
      if (sequence === avatarUploadSequence) toastError(err);
    }
  });

  usernameInput.addEventListener('input', () => { usernameInput.value = usernameInput.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase(); });

  const linkField = el('label', { class: 'field create-link' },
    el('span', { class: 'field-label' }, 'Публичная ссылка'), usernameInput,
    el('span', { class: 'field-hint' }, 'Латиница, цифры и _ · минимум 4 символа'));
  const body = el('div', { class: 'col gap-4 create-form' },
    el('div', { class: 'create-avatar' }, avatarPreview, el('span', { class: 'create-avatar-hint' }, 'Фото канала')),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Название'), titleInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Описание'), descInput),
    el('div', { class: 'create-card' },
      el('label', { class: 'switch create-switch' }, publicInput, el('span', { class: 'track' }),
        el('span', { class: 'create-switch-text' },
          el('span', { class: 'label' }, 'Публичный канал'),
          el('span', { class: 'desc' }, 'Любой сможет найти канал и подписаться'))),
      linkField),
    msg);
  publicInput.addEventListener('change', () => { linkField.hidden = !publicInput.checked; });

  const m = modal({
    title: 'Новый канал',
    subtitle: 'Публикации, просмотры и реакции. Писать могут только администраторы.',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          const title = titleInput.value.trim();
          if (title.length < 2) { msg.style.color = 'var(--err)'; msg.textContent = 'Название минимум 2 символа'; return; }
          if (publicInput.checked && usernameInput.value.trim().length < 4) { msg.style.color = 'var(--err)'; msg.textContent = 'Username минимум 4 символа'; return; }
          {
            const lim = checkCreateLimit(state.user, state.chats, 'channel');
            if (!lim.ok) { msg.style.color = 'var(--err)'; msg.textContent = `Достигнут лимит: каналов ${lim.limit}.${state.user?.isPremium ? '' : ' С Premium можно больше'}`; return; }
          }
          try {
            await avatarUpload;
            const res = await Api.createChannel({
              title,
              username: publicInput.checked ? usernameInput.value.trim() : null,
              description: descInput.value.trim(),
              avatarMediaId: avatarMedia?.id || null,
              isPublic: publicInput.checked,
            });
            upsertChat(res.chat);
            toast('Канал создан', { type: 'success' });
            m.close();
            bus.emit('nav:go', `#/chat/${res.chat.id}`);
          } catch (err) { msg.style.color = 'var(--err)'; msg.textContent = err.message; }
        },
      }, 'Создать канал'),
    ],
  });
}

/* ───────────────────────── Пересылка ─────────────────────────────────── */

export function openForward(messageIds) {
  const selected = new Set();
  const list = el('div', { class: 'col gap-1', style: 'max-height:52vh;overflow:auto' });
  const footer = el('div', { class: 'row-between', style: 'width:100%' });
  const search = el('input', { class: 'input', placeholder: 'Поиск чата', 'aria-label': 'Поиск чата' });
  const m = modal({ title: 'Переслать сообщение', subtitle: messageIds.length > 1 ? `Выбрано сообщений: ${messageIds.length}` : '', body: el('div', { class: 'col gap-3' }, search, list), footer: [footer] });

  const draw = (query = '') => {
    const q = query.toLowerCase();
    const items = state.chats.filter((c) => !q || [c.title, c.username, c.peer?.username].filter(Boolean).join(' ').toLowerCase().includes(q));
    list.innerHTML = items.map((c) => html`<button class="list-item ${selected.has(c.id) ? 'selected' : ''}" data-chat="${c.id}">
      ${raw(avatarHTML({ name: c.title, avatarUrl: c.avatarUrl || c.peer?.avatarUrl, color: c.peer?.avatarColor || (c.type === 'channel' ? 'ocean' : 'indigo'), size: 'sm', rounded: c.type !== 'dm' }))}
      <span class="col grow" style="min-width:0">
        <span class="title truncate">${c.title}</span>
        <span class="sub truncate">${c.type === 'dm' ? 'Личный чат' : c.type === 'group' ? 'Группа' : 'Канал'}${c.role && c.type === 'channel' && !['owner', 'admin'].includes(c.role) ? ' · только чтение' : ''}</span>
      </span>
      <span class="check">${raw(icons.check)}</span>
    </button>`).join('') || '<p class="muted small" style="padding:10px">Ничего не найдено</p>';

    list.querySelectorAll('[data-chat]').forEach((btn) => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.chat);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      btn.classList.toggle('selected', selected.has(id));
      paint();
    }));
  };

  const paint = () => {
    footer.innerHTML = html`
      <span class="small muted">${selected.size ? `Выбрано чатов: ${selected.size}` : 'Выберите, куда переслать'}</span>
      <div class="row gap-2">
        <button class="btn" data-cancel>Отмена</button>
        <button class="btn btn-primary" data-go ${selected.size ? '' : 'disabled'}>Переслать</button>
      </div>`;
    footer.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    footer.querySelector('[data-go]').addEventListener('click', async () => {
      try {
        const res = await Api.forward(messageIds, [...selected]);
        toast(`Переслано сообщений: ${res.total}`, { type: 'success' });
        m.close();
      } catch (err) { toastError(err); }
    });
  };

  search.addEventListener('input', debounce(() => draw(search.value.trim()), 160));
  draw();
  paint();
}

/* ───────────────────────── Участники чата ────────────────────────────── */

export function openAddMembers(chatId) {
  const info = state.chat?.chat.id === chatId ? state.chat : chatById(chatId);
  const existing = (state.membersByChat[chatId] || []).map((m) => m.id);
  const selected = new Set();
  userPicker({
    title: 'Добавить участников',
    subtitle: 'Пользователи сразу получат чат в списке и смогут читать историю.',
    multiple: true,
    selected,
    exclude: existing,
    confirmLabel: 'Добавить',
    onConfirm: async (ids) => {
      if (!ids.length) return;
      try {
        const res = await Api.addMembers(chatId, ids);
        toast(`Добавлено: ${res.added.length}`, { type: 'success' });
      } catch (err) { toastError(err); }
    },
  });
}

/* ───────────────────────── Редактирование чата ───────────────────────── */

export function openEditChat(chatId) {
  const chat = chatById(chatId);
  const info = state.chat?.chat.id === chatId ? state.chat.chat : chat;
  const titleInput = el('input', { class: 'input', value: info.title || '', maxlength: 64 });
  const descInput = el('textarea', { class: 'textarea', maxlength: 400, style: 'min-height:70px' });
  descInput.value = info.description || '';
  let avatarMedia;
  let bannerMedia;
  let bannerCleared = false;
  let avatarUpload = Promise.resolve();
  let bannerUpload = Promise.resolve();
  let avatarUploadSequence = 0;
  let bannerUploadSequence = 0;
  const avatarInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const avatarPreview = el('label', {
    class: 'avatar-drop',
    style: 'width:84px;height:84px',
    html: info.avatarUrl ? `<img src="${esc(info.avatarUrl)}">` : `<span data-ph>${icons.camera}</span>`,
  });
  avatarPreview.append(avatarInput);
  const bannerInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const bannerPreview = el('label', {
    class: 'avatar-drop',
    style: 'width:100%;height:72px;border-radius:16px;border-style:dashed',
    html: info.bannerUrl ? `<img src="${esc(info.bannerUrl)}" style="width:100%;height:100%;object-fit:cover">` : '<span class="tiny">Баннер канала</span>',
  });
  bannerPreview.append(bannerInput);
  const bannerRemove = el('button', {
    class: 'btn btn-sm btn-danger',
    type: 'button',
    hidden: !info.bannerUrl,
  }, 'Удалить баннер');
  bannerRemove.addEventListener('click', () => {
    bannerUploadSequence++;
    bannerMedia = null;
    bannerCleared = true;
    bannerPreview.style.background = '';
    bannerPreview.innerHTML = '<span class="tiny">Баннер канала</span>';
    bannerPreview.append(bannerInput);
    bannerRemove.hidden = true;
  });
  const msg = el('div', { class: 'field-msg' });
  const isChannel = info.type === 'channel';
  const usernameInput = el('input', { class: 'input', value: info.username || '', maxlength: 24 });
  const publicInput = el('input', { type: 'checkbox', checked: info.isPublic !== false });
  const protectedInput = el('input', { type: 'checkbox', checked: !!info.protectedContent });
  const commentsInput = el('input', { type: 'checkbox', checked: info.commentsEnabled !== false });
  const reactionsInput = el('input', { type: 'checkbox', checked: info.reactionsEnabled !== false });
  const approvalInput = el('input', { type: 'checkbox', checked: !!info.joinApprovalRequired });
  const allowedReactionsInput = el('input', {
    class: 'input',
    value: Array.isArray(info.allowedReactions) ? info.allowedReactions.join(', ') : '',
    placeholder: 'Все реакции (оставьте пустым)',
  });

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const sequence = ++avatarUploadSequence;
    avatarMedia = null;
    avatarUpload = (async () => {
      const cropped = await cropImage(file, { aspectRatio: 1, title: 'Обрезать фото', subtitle: 'Выберите квадратную область для аватара.' });
      if (!cropped || sequence !== avatarUploadSequence) return;
      const { file: compressed } = await compressImage(cropped, { maxDim: 512, quality: 0.9 });
      if (sequence !== avatarUploadSequence) return;
      avatarPreview.innerHTML = `<img src="${URL.createObjectURL(compressed)}">`;
      avatarPreview.append(avatarInput);
      const thumb = await makeThumb(compressed, { maxDim: 256, quality: 0.8 });
      const up = await api.upload(compressed, { kind: 'avatar', thumb });
      if (sequence === avatarUploadSequence) avatarMedia = up.media;
    })();
    try {
      await avatarUpload;
    } catch (err) {
      if (sequence === avatarUploadSequence) toastError(err);
    }
  });
  bannerInput.addEventListener('change', async () => {
    const file = bannerInput.files?.[0];
    if (!file) return;
    const sequence = ++bannerUploadSequence;
    bannerMedia = null;
    bannerUpload = (async () => {
      const cropped = await cropImage(file, { aspectRatio: 16 / 6, title: 'Обрезать баннер', subtitle: 'Выберите широкую область для баннера канала.' });
      if (!cropped || sequence !== bannerUploadSequence) return;
      const { file: compressed } = await compressImage(cropped, { maxDim: 1600, quality: 0.88 });
      const thumb = await makeThumb(compressed, { maxDim: 640, quality: 0.8 });
      const up = await api.upload(compressed, { kind: 'image', thumb });
      if (sequence !== bannerUploadSequence) return;
      bannerMedia = up.media;
      bannerCleared = false;
      bannerPreview.style.background = `url("${esc(bannerMedia.url)}") center/cover`;
      bannerPreview.innerHTML = '<span class="tiny" style="background:rgba(0,0,0,.45);padding:4px 8px;border-radius:8px">Изменить баннер</span>';
      bannerPreview.append(bannerInput);
      bannerRemove.hidden = false;
    })();
    try {
      await bannerUpload;
    } catch (err) {
      if (sequence === bannerUploadSequence) toastError(err);
    }
  });

  const body = el('div', { class: 'col gap-4' },
    el('div', { class: 'row gap-4', style: 'align-items:flex-start' }, avatarPreview,
      el('div', { class: 'col gap-3 grow' },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Название'), titleInput),
        isChannel ? el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Публичный username'), usernameInput) : null)),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Описание'), descInput),
    isChannel ? el('label', { class: 'switch' }, publicInput, el('span', { class: 'track' }), el('span', { class: 'label' }, 'Публичный канал')) : null,
    isChannel ? el('label', { class: 'switch' }, protectedInput, el('span', { class: 'track' }), el('span', { class: 'label' }, 'Запретить копирование и пересылку')) : null,
    isChannel ? el('label', { class: 'switch' }, commentsInput, el('span', { class: 'track' }), el('span', { class: 'label' }, 'Разрешить комментарии')) : null,
    isChannel ? el('label', { class: 'switch' }, reactionsInput, el('span', { class: 'track' }), el('span', { class: 'label' }, 'Разрешить реакции')) : null,
    el('label', { class: 'switch' }, approvalInput, el('span', { class: 'track' }),
      el('span', { class: 'label' }, isChannel ? 'Одобрять заявки на вступление' : 'Одобрять вступление по приглашениям')),
    isChannel ? el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Доступные реакции'),
      allowedReactionsInput,
      el('span', { class: 'tiny' }, 'Перечислите эмодзи через запятую. Пустое поле разрешает все реакции.')) : null,
    isChannel ? el('div', { class: 'col gap-2' }, bannerPreview, bannerRemove) : null,
    msg);

  const m = modal({
    title: isChannel ? 'Настройки канала' : 'Настройки группы',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await waitForUploads(() => avatarUpload, () => bannerUpload);
            const payload = {
              title: titleInput.value.trim(),
              description: descInput.value.trim(),
            };
            if (avatarMedia) payload.avatarMediaId = avatarMedia.id;
            if (bannerMedia) payload.bannerMediaId = bannerMedia.id;
            else if (bannerCleared) payload.bannerMediaId = null;
            if (isChannel) {
              payload.username = usernameInput.value.trim() || null;
              payload.isPublic = publicInput.checked;
              payload.protectedContent = protectedInput.checked;
              payload.commentsEnabled = commentsInput.checked;
              payload.reactionsEnabled = reactionsInput.checked;
              const allowedReactions = allowedReactionsInput.value.split(',').map((emoji) => emoji.trim()).filter(Boolean);
              payload.allowedReactions = allowedReactions.length ? allowedReactions : null;
            }
            payload.joinApprovalRequired = approvalInput.checked;
            const res = await Api.updateChat(chatId, payload);
            patchChat(chatId, res.chat);
            if (state.chat?.chat.id === chatId) state.chat = { ...state.chat, chat: { ...state.chat.chat, ...res.chat } };
            toast('Изменения сохранены', { type: 'success' });
            bus.emit('chat:updated', chatId);
            m.close();
          } catch (err) { msg.style.color = 'var(--err)'; msg.textContent = err.message; }
        },
      }, 'Сохранить'),
    ],
  });
}

/* ───────────────────────── Профиль ───────────────────────────────────── */

function openChangeEmail() {
  const verified = Boolean(state.user?.emailVerified);
  const emailInput = el('input', { class: 'input', type: 'email', value: state.user?.email || '', autocomplete: 'email', maxlength: 254 });
  const passwordInput = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const twoFactorInput = el('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12 });
  const msg = el('div', { class: 'field-msg' });
  const body = el('div', { class: 'col gap-3' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Новый e-mail'), emailInput),
    verified ? el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Текущий пароль'), passwordInput) : '',
    verified ? el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Код 2FA, если включена'), twoFactorInput) : '',
    el('p', { class: 'muted small' }, 'На новый адрес будет отправлен код подтверждения.'),
    msg);
  let saving = false;
  let saveButton;
  const m = modal({
    title: 'Сменить e-mail',
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      (saveButton = el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          if (saving) return;
          saving = true;
          saveButton.disabled = true;
          saveButton.textContent = 'Сохраняем…';
          msg.textContent = '';
          try {
            const credentials = verified ? {
              currentPassword: passwordInput.value,
              twoFactorCode: twoFactorInput.value.trim(),
            } : {};
            const result = await Api.changeEmail(emailInput.value.trim(), credentials);
            state.user = { ...state.user, ...result.user };
            bus.emit('user:updated', state.user);
            const verification = result.emailVerification;
            const notice = verification?.alreadyVerified
              ? 'Этот адрес уже подтверждён'
              : verification?.message || (verification?.sent === false
                ? 'Не удалось отправить код подтверждения'
                : 'Код подтверждения отправлен на новый адрес');
            toast(notice, { type: verification?.sent === false && !verification?.alreadyVerified ? 'error' : 'success' });
            m.close();
          } catch (error) {
            msg.style.color = 'var(--err)';
            msg.textContent = error.message;
            toastError(error);
          } finally {
            saving = false;
            saveButton.disabled = false;
            saveButton.textContent = 'Сохранить';
          }
        },
      }, 'Сохранить')),
    ],
  });
  setTimeout(() => emailInput.focus(), 120);
}

export function openEditProfile(focusField = null) {
  if (focusField === 'email') return openChangeEmail();
  const u = state.user;
  const nameInput = el('input', { class: 'input', value: u.name, maxlength: 64 });
  const usernameInput = el('input', { class: 'input', value: u.username, maxlength: 24 });
  const bioInput = el('textarea', { class: 'textarea', maxlength: 400, style: 'min-height:80px' });
  bioInput.value = u.bio || '';
  const statusInput = el('input', { class: 'input', value: u.statusText || '', maxlength: 80, placeholder: 'Например: «на связи до 18:00»' });
  const msg = el('div', { class: 'field-msg' });

  let avatarMedia;
  let bgMedia;
  let avatarUpload = Promise.resolve();
  let bgUpload = Promise.resolve();
  let avatarUploadSequence = 0;
  let bgUploadSequence = 0;
  const avatarInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const bgInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const avatarPreview = el('label', { class: 'avatar-drop', style: 'width:96px;height:96px', html: u.avatarUrl ? `<img src="${esc(u.avatarUrl)}">` : `<span>${initials(u.name)}</span><span class="hint">Фото</span>` });
  avatarPreview.append(avatarInput);
  const bgPreview = el('label', {
    class: 'avatar-drop',
    style: 'width:100%;height:88px;border-radius:16px;border-style:dashed',
    html: u.profileBg ? `<img src="${esc(u.profileBg)}" alt="Фон профиля" style="width:100%;height:100%;object-fit:cover">` : '<span class="tiny">Фон профиля</span>',
  });
  bgPreview.append(bgInput);
  let bgCleared = false;
  const bgRemove = el('button', { class: 'btn btn-sm btn-danger', type: 'button', hidden: !u.profileBg }, 'Удалить фото фона');
  bgRemove.addEventListener('click', () => {
    bgUploadSequence++;
    bgMedia = null;
    bgCleared = true;
    bgPreview.style.background = '';
    bgPreview.innerHTML = '<span class="tiny">Фон профиля</span>';
    bgPreview.append(bgInput);
    bgRemove.hidden = true;
  });

  const uploadImage = async (file, field) => {
    if (!file.type.startsWith('image/')) throw new Error('Можно выбрать только изображение');
    if (file.size > 8 * 1024 * 1024) throw new Error('Изображение больше 8 МБ');
    const cropped = await cropImage(file, {
      aspectRatio: field === 'bg' ? 16 / 6 : 1,
      title: field === 'bg' ? 'Обрезать фон профиля' : 'Обрезать аватар',
      subtitle: field === 'bg' ? 'Выберите широкую область для фона профиля.' : 'Выберите квадратную область для аватара.',
    });
    if (!cropped) return null;
    const { file: compressed } = await compressImage(cropped, { maxDim: field === 'bg' ? 1600 : 512, quality: 0.88 });
    const thumb = await makeThumb(compressed, { maxDim: 320, quality: 0.75 });
    const up = await api.upload(compressed, { kind: 'image', thumb });
    return up.media;
  };

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const sequence = ++avatarUploadSequence;
    avatarMedia = null;
    avatarUpload = (async () => {
      const uploaded = await uploadImage(file, 'avatar');
      if (!uploaded) return;
      if (sequence !== avatarUploadSequence) return;
      avatarMedia = uploaded;
      avatarPreview.innerHTML = `<img src="${esc(avatarMedia.url ?? URL.createObjectURL(file))}" alt="Аватар">`;
      avatarPreview.append(avatarInput);
    })();
    try {
      await avatarUpload;
    } catch (err) {
      if (sequence === avatarUploadSequence) toastError(err);
    }
  });
  bgInput.addEventListener('change', async () => {
    const file = bgInput.files?.[0];
    if (!file) return;
    const sequence = ++bgUploadSequence;
    bgMedia = null;
    bgUpload = (async () => {
      const uploaded = await uploadImage(file, 'bg');
      if (!uploaded) return;
      if (sequence !== bgUploadSequence) return;
      bgMedia = uploaded;
      bgCleared = false;
      bgPreview.style.background = `url("${esc(bgMedia.url)}") center/cover`;
      bgPreview.innerHTML = `<span class="tiny" style="position:relative;z-index:1;background:rgba(0,0,0,.4);padding:3px 8px;border-radius:8px">Изменить фон</span>`;
      bgPreview.append(bgInput);
      bgRemove.hidden = false;
    })();
    try {
      await bgUpload;
    } catch (err) {
      if (sequence === bgUploadSequence) toastError(err);
    }
  });

  const colorRow = el('div', { class: 'row gap-2', style: 'flex-wrap:wrap' },
    AVATAR_COLORS.map((c) => el('button', {
      class: 'swatch',
      style: `width:30px;height:30px;background:linear-gradient(140deg,var(--c1),var(--c2))`,
      'data-c': c.id,
      'aria-checked': String(u.avatarColor === c.id),
      onClick: (e) => {
        colorRow.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
      },
    })));

  const body = el('div', { class: 'col gap-4' },
    el('div', { class: 'row gap-4', style: 'align-items:flex-start' },
      el('div', { class: 'col gap-3' }, avatarPreview, colorRow),
      el('div', { class: 'col gap-3 grow' },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Имя'), nameInput),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Username'), usernameInput),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Статус'), statusInput))),
    el('div', { class: 'col gap-2' }, bgPreview, bgRemove),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Описание'), bioInput),
    el('div', { class: 'auth-note' }, el('span', { class: 'ic' }, raw(icons.info)),
      el('span', {}, 'E-mail в этом диалоге не меняется — напишите в поддержку, если нужно сменить адрес.')),
    msg);

  let saving = false;
  let saveButton;
  const m = modal({
    title: 'Редактировать профиль',
    wide: true,
    body,
    footer: [
      el('button', { class: 'btn', onClick: () => m.close() }, 'Отмена'),
      (saveButton = el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          if (saving) return;
          saving = true;
          saveButton.disabled = true;
          saveButton.textContent = 'Сохранение…';
          msg.textContent = 'Загрузка изображения и сохранение профиля…';
          msg.style.color = 'var(--text-mute)';
          try {
            await waitForUploads(() => avatarUpload, () => bgUpload);
            const payload = {
              name: nameInput.value.trim(),
              username: usernameInput.value.trim().toLowerCase(),
              bio: bioInput.value.trim(),
              statusText: statusInput.value.trim(),
              avatarColor: colorRow.querySelector('[aria-checked="true"]')?.dataset.c || u.avatarColor,
            };
            if (avatarMedia) payload.avatarMediaId = avatarMedia.id;
            if (bgMedia) payload.profileBgMediaId = bgMedia.id;
            else if (bgCleared) payload.profileBgMediaId = null;
            const res = await Api.updateProfile(payload);
            state.user = { ...state.user, ...res.user };
            bus.emit('user:updated', state.user);
            const { applySettings } = await import('../app.js');
            applySettings(res.settings);
            toast('Профиль обновлён', { type: 'success' });
            m.close();
          } catch (err) {
            msg.style.color = 'var(--err)';
            msg.textContent = `Не удалось сохранить профиль: ${err.message}`;
            toastError(err);
          } finally {
            saving = false;
            saveButton.disabled = false;
            saveButton.textContent = 'Сохранить';
          }
        },
      }, 'Сохранить')),
    ],
  });

  if (focusField) {
    const map = { name: nameInput, username: usernameInput, bio: bioInput, statusText: statusInput };
    setTimeout(() => { map[focusField]?.focus(); map[focusField]?.select?.(); }, 120);
  }
}

/* ───────────────────────── Информация о сообщении ────────────────────── */

export async function showMessageInfo(messageId) {
  const body = el('div', { class: 'col gap-3' }, el('div', { class: 'row center', style: 'padding:20px' }, el('span', { class: 'spinner' })));
  const m = modal({ title: 'Информация о сообщении', body });
  try {
    const res = await Api.messageInfo(messageId);
    const msg = res.message;
    body.innerHTML = html`
      <div class="settings-card">
        <div class="settings-row"><div class="grow"><div class="label">Отправлено</div><div class="desc">${fmtDayLabel(msg.createdAt)}, ${fmtTime(msg.createdAt)}</div></div></div>
        ${msg.editedAt ? html`<div class="settings-row"><div class="grow"><div class="label">Изменено</div><div class="desc">${fmtDayLabel(msg.editedAt)}, ${fmtTime(msg.editedAt)}</div></div></div>` : ''}
        <div class="settings-row"><div class="grow"><div class="label">Тип</div><div class="desc">${({ text: 'Текст', photo: 'Фото', video: 'Видео', voice: 'Голосовое', file: 'Файл', sticker: 'Стикер' })[msg.type] || msg.type}</div></div></div>
        ${msg.media ? html`<div class="settings-row"><div class="grow"><div class="label">Файл</div><div class="desc">${msg.media.filename} · ${fmtBytes(msg.media.size)}</div></div></div>` : ''}
        ${msg.views ? html`<div class="settings-row"><div class="grow"><div class="label">Просмотры</div><div class="desc">${msg.views}</div></div></div>` : ''}
        ${res.forwardedFrom ? html`<div class="settings-row"><div class="grow"><div class="label">Переслано из</div><div class="desc">${res.forwardedFrom.title || 'чата'}${res.forwardedFrom.username ? ` · @${res.forwardedFrom.username}` : ''}</div></div></div>` : ''}
      </div>
      ${res.message.senderId === state.user.id || ['owner', 'admin'].includes(state.chat?.role) ? html`<div class="col gap-2">
        <div class="field-label">Статус доставки</div>
        <div class="col gap-1">${raw(res.readers.filter((r) => r.id !== state.user.id).map((r) => html`<div class="list-item">
          ${raw(avatarHTML({ name: r.name, avatarUrl: r.avatarUrl, size: 'sm' }))}
          <span class="col grow"><span class="title">${r.name}</span><span class="sub">@${r.username}</span></span>
          <span class="chip ${r.read ? 'accent' : ''}">${r.read ? 'прочитано' : r.delivered ? 'доставлено' : 'отправлено'}</span>
        </div>`).join('') || '<p class="muted small">Нет других участников</p>')}</div>
      </div>` : ''}
      ${state.chat?.chat.type === 'channel' ? html`<div class="auth-note"><span class="ic">${raw(icons.eye)}</span><span>Просмотры публикаций канала обновляются автоматически, когда подписчики читают ленту.</span></div>` : ''}`;
  } catch (err) {
    body.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}
