/**
 * UI-примитивы: модальные окна, контекстные меню, диалоги подтверждения,
 * аватары, состояния экранов, эмодзи-пикер и палитра стикеров.
 */
import { $, $$, el, esc, html, raw, initials, fmtBytes, haptic, rAFBatch } from './util.js';
import { icons } from './icons.js';

export const overlays = () => document.getElementById('overlays');

export function toast() {}

export const toastError = (err) => toast(err?.message || String(err), { type: 'error', timeout: 5200 });

/* ── Модальные окна ──────────────────────────────────────────────────────── */

let openModals = 0;

export function modal({ title, subtitle = null, body, footer = null, wide = false, closable = true, onClose = null, id = null }) {
  const root = el('div', { class: 'modal-root', id: id || undefined });
  const backdrop = el('div', { class: 'modal-backdrop' });
  const panel = el('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Диалог' });
  const header = el('div', { class: 'modal-header' },
    el('div', { class: 'grow' },
      el('h3', {}, title || ''),
      subtitle ? el('p', { class: 'muted small' }, subtitle) : null),
    closable ? el('button', { class: 'icon-btn', 'aria-label': 'Закрыть', html: icons.close, onClick: () => close() }) : null);
  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body instanceof Node) bodyNode.append(body);
  panel.append(header, bodyNode);

  if (footer) {
    const footerNode = el('div', { class: 'modal-footer' });
    if (typeof footer === 'string') footerNode.innerHTML = footer;
    else if (footer instanceof Node) footerNode.append(footer);
    else if (Array.isArray(footer)) footerNode.append(...footer);
    panel.append(footerNode);
  }

  root.append(backdrop, panel);
  overlays().append(root);
  openModals++;

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    openModals = Math.max(0, openModals - 1);
    panel.classList.add('closing');
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity .18s';
    setTimeout(() => { root.remove(); onClose?.(result); }, 200);
  }

  if (closable) {
    backdrop.addEventListener('click', () => close());
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); document.removeEventListener('keydown', onKey, true); }
    };
    document.addEventListener('keydown', onKey, true);
  }
  // Фокус на первое поле — чтобы можно было сразу печатать
  setTimeout(() => {
    const focusable = panel.querySelector('input:not([type=hidden]), textarea, button.btn-primary');
    focusable?.focus({ preventScroll: true });
  }, 60);

  return { root, panel, body: bodyNode, close };
}

export function confirmDialog({ title, text = '', confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title,
      body: el('p', { class: 'muted' }, text),
      footer: [
        el('button', { class: 'btn', onClick: () => m.close() }, cancelLabel),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          onClick: () => { result = true; m.close(); },
        }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, label = '', value = '', placeholder = '', confirmLabel = 'Сохранить', multiline = false, maxLength = 400, allowEmpty = false }) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline
      ? el('textarea', { class: 'textarea', placeholder, maxlength: maxLength })
      : el('input', { class: 'input', placeholder, maxlength: maxLength, value });
    if (multiline) input.value = value;
    const form = el('form', { class: 'col gap-3' }, label ? el('span', { class: 'field-label' }, label) : null, input);
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel);
    const m = modal({
      title,
      body: form,
      footer: [
        el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Отмена'),
        submit,
      ],
      onClose: () => resolve(result),
    });
    const save = (e) => {
      e.preventDefault();
      result = input.value.trim();
      if (result || allowEmpty) m.close();
    };
    form.addEventListener('submit', save);
    submit.addEventListener('click', save);
    setTimeout(() => input.focus(), 60);
  });
}

/* ── Контекстные меню ────────────────────────────────────────────────────── */
let openMenuNode = null;

export function closeMenu() {
  if (openMenuNode) { openMenuNode.remove(); openMenuNode = null; }
  document.removeEventListener('click', outsideClose, true);
  document.removeEventListener('keydown', escClose, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
}
function outsideClose(e) { if (openMenuNode && !openMenuNode.contains(e.target)) closeMenu(); }
function escClose(e) { if (e.key === 'Escape') closeMenu(); }

/**
 * Показать меню. items: [{label, icon, onClick, danger, checked}] или {type:'sep'} / {type:'label', label}
 * Позиционирование: рядом с точкой вызова, с автоматическим «отражением» у краёв экрана.
 */
export function contextMenu(items, { x, y, anchor = null, className = '', align = 'auto' } = {}) {
  closeMenu();
  const node = el('div', { class: `menu ${className}`, role: 'menu' });
  node.dataset.floating = '1';
  node.style.position = 'fixed';

  for (const item of items) {
    if (!item) continue;
    if (item.type === 'sep') { node.append(el('div', { class: 'menu-sep' })); continue; }
    if (item.type === 'label') { node.append(el('div', { class: 'menu-label' }, item.label)); continue; }
    if (item.type === 'custom' && item.node instanceof Node) { node.append(item.node); continue; }
    const btn = el('button', {
      class: `menu-item ${item.danger ? 'danger' : ''}`,
      role: 'menuitem',
      onClick: (e) => { e.stopPropagation(); closeMenu(); item.onClick?.(e); },
    }, item.icon ? el('span', { html: icons[item.icon] || '', style: 'display:flex;width:18px' }) : null,
      el('span', { class: 'grow' }, item.label),
      item.hint ? el('span', { class: 'mute tiny' }, item.hint) : null,
      item.checked ? el('span', { style: 'color:var(--accent-soft)', html: icons.check }) : null);
    node.append(btn);
  }

  overlays().append(node);
  openMenuNode = node;

  const rect = node.getBoundingClientRect();
  let left = x ?? 0;
  let top = y ?? 0;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    if (align === 'right' || (align === 'auto' && a.right + rect.width > window.innerWidth - 12)) left = a.right - rect.width;
    else left = a.left;
    top = a.bottom + 6;
    if (top + rect.height > window.innerHeight - 12) top = Math.max(12, a.top - rect.height - 6);
  }
  left = Math.max(12, Math.min(left, window.innerWidth - rect.width - 12));
  top = Math.max(12, Math.min(top, window.innerHeight - rect.height - 12));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.setProperty('--menu-origin', anchor && align !== 'right' ? 'top left' : 'top right');

  setTimeout(() => {
    document.addEventListener('click', outsideClose, true);
    document.addEventListener('keydown', escClose, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }, 0);
  return node;
}

/* ── Аватар ──────────────────────────────────────────────────────────────── */
export function avatarHTML({ name, avatarUrl = null, color = 'violet', size = 'md', presence = null, rounded = false } = {}) {
  const cls = `avatar ${size === 'md' ? '' : `avatar-${size}`} ${rounded ? 'rounded' : ''}`.trim();
  const inner = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" loading="lazy" decoding="async">`
    : esc(initials(name));
  const dot = presence ? `<span class="presence-dot ${presence === 'online' ? 'online' : ''}"></span>` : '';
  return raw(`<div class="avatar-wrap">${`<div class="${cls}" data-c="${esc(color)}" title="${esc(name || '')}">${inner}</div>`}${dot}</div>`);
}

export const AVATAR_COLORS = [
  { id: 'violet', label: 'Аметист' }, { id: 'ocean', label: 'Океан' }, { id: 'sunset', label: 'Закат' },
  { id: 'mint', label: 'Мята' }, { id: 'coral', label: 'Коралл' }, { id: 'indigo', label: 'Индиго' },
];

/* ── Состояния экранов ───────────────────────────────────────────────────── */

export function stateScreen({ icon = 'chats', title, text = '', actions = [], tone = 'default' }) {
  return raw(html`<div class="state">
    <div class="state-illustration" style="${tone === 'error' ? 'color:var(--err)' : ''}">${raw(icons[icon] || icons.chats)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ''}
    ${actions.length ? html`<div class="row">${actions.map((a) => html`<button class="btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'ghost' ? 'btn-ghost' : ''}" data-action="${a.id}">${a.label}</button>`)}</div>` : ''}
  </div>`);
}

export function loadingScreen(text = 'Загрузка…') {
  return raw(html`<div class="state"><div class="spinner lg"></div><p>${text}</p></div>`);
}

export function skeletonList(count = 6) {
  return raw(html`<div class="col gap-3" style="padding:12px">
    ${Array.from({ length: count }, () => html`<div class="row gap-3">
      <div class="skeleton" style="width:48px;height:48px;border-radius:50%"></div>
      <div class="col gap-2 grow">
        <div class="skeleton" style="height:12px;width:38%"></div>
        <div class="skeleton" style="height:10px;width:66%"></div>
      </div>
    </div>`)}
  </div>`);
}

/* ── Иконки-хелперы ──────────────────────────────────────────────────────── */
export const icon = (name, cls = '') => raw(`<span class="ic ${cls}">${icons[name] || ''}</span>`);

/* ── Эмодзи и стикеры ────────────────────────────────────────────────────── */

export const EMOJI_GROUPS = [
  { id: 'smileys', tab: '😀', title: 'Эмоции', items: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 💩 🎃 😺 😸'.split(' ') },
  { id: 'gestures', tab: '👍', title: 'Жесты', items: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 🖖 👋 🤝 🙏 💪 🦾 👏 🙌 👐 🤲 🤜 🤛 ✊ 👊 🫰 🫶 🫂'.split(' ') },
  { id: 'hearts', tab: '❤️', title: 'Сердца', items: '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💋 🫀 ✨ ⭐ 🌟 💫 ⚡️ 🔥 💥 💯'.split(' ') },
  { id: 'animals', tab: '🐱', title: 'Животные', items: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦐 🦀 🐬 🐳 🐊 🦓 🦒 🐘 🦔 🌸 🌼 🌻 🌷 🌹 🌺 🍀 🌿 🍁 🍂'.split(' ') },
  { id: 'food', tab: '🍕', title: 'Еда', items: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽 🥕 🍞 🥐 🥯 🧇 🧈 🧀 🍳 🥞 🧊 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍿 🧂 🥫 🍱 🍣 🍤 🍜 🍝 🍦 🍰 🎂 🍮 🍫 🍬 🍭 ☕️ 🍵 🧋 🍺 🍻 🥂 🍷 🥤 🧉'.split(' ') },
  { id: 'activity', tab: '⚽️', title: 'Активности', items: '⚽️ 🏀 🏈 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏹 🎯 🪀 🎮 🕹 🎲 🧩 ♟️ 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎪 🎭 🎫 🏆 🥇 🥈 🥉 🏅 🚀 ✈️ 🛸 🚁 ⛵️ 🚗 🏎 🚲 🛴 🏔 ⛰ 🏕 🏖 🏝 🗺 🧭 ⌚️ 📱 💻 🖥 ⌨️ 🖨 🖱 💡 🔋 🔌 📷 📹 🎥'.split(' ') },
  { id: 'symbols', tab: '♾', title: 'Символы', items: '♾ ✅ ❌ ⭕️ ❗️ ❓ ❕ ❔ ⚠️ 🔔 🔕 📌 📍 📎 🔗 🔒 🔓 🔑 🛡 ⚙️ 🧲 🧪 🧬 🔬 🔭 📡 💎 🪙 💰 💳 🧾 📦 📫 📮 📝 📖 📚 🗂 📅 📆 ⏰ ⏳ 🕐 🎉 🎊 🎈 🎁 🏳️ 🏴 ☮️ ✝️ ☪️ 🕉 ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈️ ♉️ ♊️ ♋️ ♌️ ♍️ ♎️ ♏️ ♐️ ♑️ ♒️ ♓️ 🔱 📶 🔆 🎵'.split(' ') },
];

/** Палитра стикеров — собственный набор SV-иллюстраций (см. /assets/stickers). */
export const STICKERS = [
  { id: 'aurora-hi', title: 'Привет' }, { id: 'aurora-news', title: 'Новости' },
  { id: 'aurora-new', title: 'Новинка' }, { id: 'aurora-love', title: 'Любовь' },
  { id: 'aurora-lol', title: 'Смех' }, { id: 'aurora-wow', title: 'Вау' },
  { id: 'aurora-thanks', title: 'Спасибо' }, { id: 'aurora-star', title: 'Звезда' },
  { id: 'aurora-coffee', title: 'Кофе' }, { id: 'aurora-rocket', title: 'Ракета' },
];

export function emojiPickerHTML() {
  return raw(html`<div class="picker" data-picker>
    <div class="picker-tabs" data-tabs>
      ${raw(EMOJI_GROUPS.map((g, i) => `<button class="picker-tab ${i === 0 ? 'active' : ''}" data-tab="${g.id}">${g.tab}</button>`).join(''))}
      <button class="picker-tab" data-tab="stickers" title="Стикеры">${raw(icons.sticker)}</button>
    </div>
    <div class="picker-scroll" data-scroll>
      ${EMOJI_GROUPS.map((g) => html`<div data-group="${g.id}">
        <div class="picker-title">${g.title}</div>
        <div class="emoji-grid">${raw(g.items.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join(''))}</div>
      </div>`)}
      <div data-group="stickers" class="hidden">
        <div class="picker-title">Стикеры Aurora</div>
        <div class="sticker-grid">${raw(STICKERS.map((s) => `<button type="button" data-sticker="${s.id}" title="${esc(s.title)}"><img src="/assets/stickers/${s.id}.svg" alt="${esc(s.title)}" style="width:64px;height:64px"></button>`).join(''))}</div>
      </div>
    </div>
  </div>`);
}

export const stickerUrl = (id) => `/assets/stickers/${id}.svg`;

/* ── Утилита: привязка пикера ────────────────────────────────────────────── */
export function bindEmojiPicker(container, { onEmoji, onSticker }) {
  const tabs = container.querySelector('[data-tabs]');
  const scroll = container.querySelector('[data-scroll]');
  tabs?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    const id = tab.dataset.tab;
    $$('.picker-tab', tabs).forEach((t) => t.classList.toggle('active', t === tab));
    $$('[data-group]', scroll).forEach((g) => g.classList.toggle('hidden', g.dataset.group !== id));
    scroll.scrollTop = 0;
  });
  scroll?.addEventListener('click', (e) => {
    const emoji = e.target.closest('[data-emoji]');
    if (emoji) return onEmoji?.(emoji.dataset.emoji);
    const sticker = e.target.closest('[data-sticker]');
    if (sticker) return onSticker?.(sticker.dataset.sticker);
  });
}

/* ── Прочее ──────────────────────────────────────────────────────────────── */

export function bytesLabel(size) { return fmtBytes(size); }

export function attachTileHTML(item) {
  const isImage = item.kind === 'photo' && item.previewUrl;
  const isVideo = item.kind === 'video' && item.previewUrl;
  return raw(html`<div class="attach-item ${item.kind === 'file' ? 'file' : ''}" data-attach="${item.id}">
    ${isImage ? raw(`<img src="${esc(item.previewUrl)}" alt="">`) : ''}
    ${isVideo ? raw(`<video src="${esc(item.previewUrl)}" muted playsinline></video>`) : ''}
    ${item.kind === 'file' ? html`<div class="col gap-1 center"><span class="ic">${raw(icons.file)}</span><span class="tiny truncate" style="max-width:76px">${item.name}</span><span class="tiny mute">${fmtBytes(item.size)}</span></div>` : ''}
    ${item.uploading ? html`<div class="progress" style="position:absolute;bottom:6px;left:6px;right:6px"><i style="width:${item.progress || 0}%"></i></div>` : ''}
    ${item.kind !== 'file' && !item.uploading ? html`<span class="nm truncate">${item.name}</span>` : ''}
    <button class="rm" data-remove="${item.id}" title="Убрать">×</button>
  </div>`);
}

/** Прячем «тяжёлые» движки анимации, если пользователь их отключил. */
export const applyAnimationPrefs = rAFBatch(() => {
  const s = window.__auroraSettings;
  document.documentElement.classList.toggle('no-anim', s ? !s.animations : false);
  document.documentElement.classList.toggle('low-power', !!s?.compact && false);
});

export { el, html, esc, raw, $, $$ };


/* ── Герой профиля (баннер + аватар), общий для «Профиля» и чужих профилей ── */
import { premiumBadgeHTML } from './premium.js?v=20261031-verified-badge-1';
export function profileHeroHTML(u, { sub = '', presence = null, kind = 'user' } = {}) {
  const theme = esc(u.profileTheme || (kind === 'channel' ? 'ocean' : 'aurora'));
  const bannerUrl = u.profileBanner || u.bannerUrl || '';
  const banner = bannerUrl ? ` style="--banner:url('${esc(bannerUrl)}')"` : '';
  const profileEffects = esc(JSON.stringify(u.profileEffects || { theme: 'none', ring: 'none', nameFx: 'none', dim: 0 }));
  const premium = premiumBadgeHTML(u, { size: 'lg' });
  const videoUrl = u.isPremium ? (u.profileBannerVideo || '') : '';
  const video = videoUrl ? `<video class="cover-video" src="${esc(videoUrl)}" muted loop autoplay playsinline preload="metadata"></video>` : '';
  return raw(`<section class="tg-hero profile-theme-${theme}${bannerUrl ? ' has-banner' : ''}${videoUrl ? ' has-video' : ''}" data-profile-effects="${profileEffects}"${banner}>
    <div class="tg-cover">${video}</div>
    <div class="tg-id">
      ${avatarHTML({ name: u.name || u.title, avatarUrl: u.avatarUrl, color: u.avatarColor || (kind === 'channel' ? 'ocean' : 'violet'), size: '2xl', presence, rounded: kind !== 'user' })}
      <h2 class="tg-name">${esc(u.name || u.title)}${premium}</h2>
      ${sub ? `<p class="tg-sub${presence === 'online' ? ' online' : ''}">${esc(sub)}</p>` : ''}
    </div>
  </section>`);
}
