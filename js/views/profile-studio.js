/**
 * Студия профиля: рисуем баннер (фон, фото, рисунок, эмодзи, стикеры, текст) и настраиваем оформление.
 * Баннер собирается в одну картинку на canvas и загружается как profileBannerMediaId — поэтому
 * эмодзи можно расставлять где угодно, а на сервере ничего менять не нужно.
 */
import { $, $$, clamp, esc } from '../util.js';
import { state, bus } from '../store.js';
import { Api, api } from '../api.js?v=20261102-gifts-2';
import { toast, toastError, confirmDialog, STICKERS, stickerUrl } from '../ui.js?v=20261029-no-toasts-1';
import { icons } from '../icons.js';
import { compressImage } from '../media.js?v=20261028-ux-1';

const W = 1000;
const H = 900;
const FONT = '-apple-system, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/* ── Фоны: градиент + световые пятна ─────────────────────────────────────── */
const PRESETS = [
  { id: 'aurora', label: 'Аврора', base: ['#1b1247', '#0f6f86'], blobs: [['#7c5cff', .2, .15, .55], ['#35d3ff', .85, .75, .5], ['#c084fc', .7, .1, .35]] },
  { id: 'sunset', label: 'Закат', base: ['#5a1f4d', '#e07a3f'], blobs: [['#ff5d8f', .15, .8, .5], ['#ffd166', .85, .2, .45]] },
  { id: 'ocean', label: 'Океан', base: ['#0b3a63', '#12a4b8'], blobs: [['#51b3ff', .8, .2, .5], ['#16c79a', .2, .85, .4]] },
  { id: 'forest', label: 'Лес', base: ['#0f3d30', '#6a9d49'], blobs: [['#c6ff7a', .8, .15, .35], ['#16c79a', .15, .8, .45]] },
  { id: 'mono', label: 'Графит', base: ['#1b1d27', '#7a7f90'], blobs: [['#ffffff', .8, .1, .25], ['#9aa0b4', .1, .9, .4]] },
  { id: 'neon', label: 'Неон', base: ['#3a0f58', '#067a82'], blobs: [['#ff2fd1', .15, .2, .45], ['#2fffe0', .85, .8, .45]] },
  { id: 'candy', label: 'Конфета', base: ['#ff9acb', '#9a7bff'], blobs: [['#ffe27a', .85, .15, .4], ['#7ee8ff', .15, .85, .45]] },
  { id: 'gold', label: 'Золото', base: ['#2d1f08', '#d9a441'], blobs: [['#fff1b8', .8, .2, .4], ['#ff9a3d', .2, .8, .4]] },
  { id: 'night', label: 'Ночь', base: ['#05060f', '#1c2a6b'], blobs: [['#4f46e5', .75, .25, .5], ['#0ea5e9', .2, .9, .35]] },
  { id: 'rose', label: 'Роза', base: ['#4a0f2b', '#ff7a9c'], blobs: [['#ffd1dc', .8, .15, .4], ['#ff2d75', .1, .85, .45]] },
  { id: 'mint', label: 'Мята', base: ['#0c4f46', '#7ee8c8'], blobs: [['#d1fff2', .85, .2, .4], ['#16c79a', .1, .8, .5]] },
  { id: 'paper', label: 'Бумага', base: ['#f7f1e3', '#e0c9ff'], blobs: [['#ffd6a5', .15, .2, .45], ['#a5d8ff', .85, .85, .45]] },
];
const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
const PATTERNS = [['none', 'Нет'], ['stars', 'Звёзды'], ['dots', 'Точки'], ['grid', 'Сетка']];
const THEMES = ['aurora', 'sunset', 'ocean', 'forest', 'mono', 'neon'];
const THEME_LABELS = { aurora: 'Аврора', sunset: 'Закат', ocean: 'Океан', forest: 'Лес', mono: 'Графит', neon: 'Неон' };

const EMOJI = {
  'Смайлы': '😀 😄 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😎 🤩 🥳 😴 🤔 😏 😌 😜 🤪 🥹 😭 😤 😱 🤗 🫶 🙌 👏 🔥 💯 ✨ 💫 ⭐ 🌟 💥',
  'Сердца': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💖 💗 💓 💞 💕 💘 💝 👍 👌 ✌️ 🤞 🤟 🤙 👋 🙏 💪 👑 💎 🎁 🎉 🎊 🏆 🥇 🎯 🎵 🎶 🎧',
  'Природа': '🌸 🌺 🌹 🌷 🌼 🌻 🍀 🌿 🍃 🌴 🌵 🌲 🍁 🍄 🌈 ☀️ 🌙 ☁️ ⛅ ❄️ 🌊 ⚡ 🌍 🦋 🐝 🐱 🐶 🦊 🐼 🦄 🐬',
  'Еда': '🍓 🍒 🍑 🍋 🍉 🍇 🍍 🥑 🍕 🍔 🍟 🍣 🍩 🍪 🎂 🍰 🍫 🍿 ☕ 🧋 🍷 🥂 🍹 🍭 🍬 🧁 🍦 🥐 🥨 🌮',
  'Космос': '🚀 🛸 🌌 🪐 🌠 ☄️ 👾 🤖 🛰️ 🔭 🌑 🌕 🔮 🧿 🪄 🎮 🕹️ 💿 🎬 📸 ✈️ 🏝️ 🗼 🏔️ 🏙️',
};
const BRUSH_COLORS = ['#ffffff', '#111111', '#ff5d73', '#ffb648', '#ffd166', '#35d39a', '#38d6ff', '#7c5cff', '#ff7ad9'];
const TEXT_COLORS = ['#ffffff', '#111111', '#ffd166', '#ff7ad9', '#38d6ff', '#35d39a'];

/* ── Рисование ───────────────────────────────────────────────────────────── */
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const presetCss = (p) => [...p.blobs.map(([c, x, y, r]) => `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${hexA(c, .85)}, transparent ${r * 100}%)`), `linear-gradient(135deg, ${p.base[0]}, ${p.base[1]})`].join(',');

function paintPreset(c, p) {
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.base[0]); g.addColorStop(1, p.base[1]);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  for (const [color, x, y, r] of p.blobs) {
    const R = r * Math.max(W, H) * 1.1;
    const rg = c.createRadialGradient(x * W, y * H, 0, x * W, y * H, R);
    rg.addColorStop(0, hexA(color, .85)); rg.addColorStop(1, hexA(color, 0));
    c.fillStyle = rg; c.fillRect(0, 0, W, H);
  }
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintPattern(c, kind) {
  if (kind === 'none') return;
  c.save();
  c.fillStyle = '#fff'; c.strokeStyle = '#fff';
  if (kind === 'stars') {
    const r = rng(7);
    for (let i = 0; i < 90; i++) { c.globalAlpha = .3 + r() * .6; c.beginPath(); c.arc(r() * W, r() * H * .85, r() * 2.6 + .7, 0, 7); c.fill(); }
  } else if (kind === 'dots') {
    c.globalAlpha = .16;
    for (let y = 30; y < H; y += 46) for (let x = (y / 46) % 2 ? 53 : 30; x < W; x += 46) { c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill(); }
  } else if (kind === 'grid') {
    c.globalAlpha = .1; c.lineWidth = 2;
    for (let x = 0; x <= W; x += 62) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y <= H; y += 62) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  }
  c.restore();
}

function drawStroke(c, s) {
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = s.size;
  c.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
  c.strokeStyle = s.color; c.fillStyle = s.color;
  const p = s.points;
  if (p.length === 1) { c.beginPath(); c.arc(p[0].x, p[0].y, s.size / 2, 0, 7); c.fill(); }
  else {
    c.beginPath(); c.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) c.quadraticCurveTo(p[i - 1].x, p[i - 1].y, (p[i - 1].x + p[i].x) / 2, (p[i - 1].y + p[i].y) / 2);
    c.lineTo(p[p.length - 1].x, p[p.length - 1].y); c.stroke();
  }
  c.restore();
}

/* ── Студия ──────────────────────────────────────────────────────────────── */
let opened = false;

export function openProfileStudio(user = state.user) {
  if (opened || !user) return;
  if (!state.user || String(user.id) !== String(state.user.id)) {
    toast('Оформление можно менять только у своего профиля', { type: 'error' });
    return;
  }
  opened = true;
  const previousBodyOverflow = document.body.style.overflow;
  const objectUrls = new Set();
  let closing = false;

  const S = {
    tab: 'bg', preset: PRESET_BY_ID[user.profileTheme] ? user.profileTheme : 'aurora', pattern: 'none',
    photo: null, strokes: [], objects: [], selected: null, current: null, drag: null, pinch: null,
    brush: { color: '#ffffff', size: 18, eraser: false }, textColor: '#ffffff', dirty: false, removeBanner: false, emojiCat: Object.keys(EMOJI)[0],
    theme: THEMES.includes(user.profileTheme) ? user.profileTheme : 'aurora',
    stickers: new Set(user.profileStickers || []),
  };

  const root = document.createElement('div');
  root.className = 'studio';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const initialsOf = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((p) => [...p][0]?.toUpperCase() || '').join('') || '?';
  const myChannels = state.chats.filter((c) => c.type === 'channel' && c.ownerId === state.user?.id);

  root.innerHTML = `
  <div class="studio-card">
    <header class="studio-head">
      <button type="button" class="icon-btn" data-close aria-label="Закрыть">${icons.close}</button>
      <div class="studio-title"><h3>Студия профиля</h3><span>Баннер, эмодзи, рисунок и стиль</span></div>
      <button type="button" class="btn btn-primary btn-sm" data-save>Сохранить</button>
    </header>
    <div class="studio-body">
      <section class="studio-stage">
        <div class="studio-canvas-wrap">
          <canvas class="studio-canvas" width="${W}" height="${H}"></canvas>
          <div class="studio-mock" data-mock>
            <span class="mock-avatar" data-c="${esc(user.avatarColor || 'violet')}">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="">` : initialsOf(user.name)}</span>
            <b>${esc(user.name || '')}</b><small>@${esc(user.username || '')}</small>
          </div>
        </div>
        <div class="studio-stage-bar">
          <label class="studio-switch"><input type="checkbox" data-mock-toggle checked><span class="track"></span><span>Макет профиля</span></label>
          <span class="studio-hint">Главное размещайте выше аватара</span>
        </div>
        <div class="studio-sel" data-sel hidden>
          <label>Размер<input type="range" min="30" max="700" value="150" data-sel-size></label>
          <label>Поворот<input type="range" min="-180" max="180" value="0" data-sel-rot></label>
          <div class="studio-sel-actions">
            <button type="button" class="btn btn-sm" data-sel-dup>Копия</button>
            <button type="button" class="btn btn-sm" data-sel-front>Наверх</button>
            <button type="button" class="btn btn-sm btn-danger" data-sel-del>Удалить</button>
          </div>
        </div>
      </section>

      <section class="studio-tools">
        <nav class="studio-tabs" data-tabs>
          <button type="button" data-tab="bg" aria-selected="true">Фон</button>
          <button type="button" data-tab="emoji" aria-selected="false">Эмодзи</button>
          <button type="button" data-tab="draw" aria-selected="false">Рисунок</button>
          <button type="button" data-tab="profile" aria-selected="false">Профиль</button>
        </nav>

        <div class="studio-panel" data-panel="bg">
          <h4>Стиль</h4>
          <div class="preset-grid" data-presets>
            ${PRESETS.map((p) => `<button type="button" class="preset" data-preset="${p.id}" title="${p.label}" aria-checked="${p.id === S.preset}" style="background:${presetCss(p)}"><span>${p.label}</span></button>`).join('')}
          </div>
          <h4>Узор</h4>
          <div class="chip-row" data-patterns>${PATTERNS.map(([id, label]) => `<button type="button" class="chip-btn" data-pattern="${id}" aria-pressed="${id === 'none'}">${label}</button>`).join('')}</div>
          <h4>Фото</h4>
          <div class="chip-row">
            <label class="btn btn-sm">Загрузить фото<input type="file" accept="image/*" hidden data-photo-input></label>
            ${user.profileBanner ? '<button type="button" class="btn btn-sm" data-photo-current>Текущий баннер</button>' : ''}
            <button type="button" class="btn btn-sm btn-ghost" data-photo-clear hidden>Убрать фото</button>
            ${user.profileBanner ? '<button type="button" class="btn btn-sm btn-danger" data-banner-delete>Удалить баннер</button>' : ''}
            ${user.profileBanner ? '<span class="studio-hint" data-banner-delete-status hidden>Баннер будет удалён после сохранения.</span>' : ''}
          </div>
          <div class="studio-photo-ctl" data-photo-ctl hidden>
            <label>Масштаб<input type="range" min="1" max="3" step="0.01" value="1" data-photo-zoom></label>
            <label>Затемнение<input type="range" min="0" max="0.7" step="0.01" value="0" data-photo-dim></label>
            <p class="studio-hint">Перетащите фото на холсте, чтобы подвинуть.</p>
          </div>
        </div>

        <div class="studio-panel" data-panel="emoji" hidden>
          <div class="chip-row scroll" data-emoji-cats>
            ${Object.keys(EMOJI).map((k, i) => `<button type="button" class="chip-btn" data-cat="${k}" aria-pressed="${i === 0}">${k}</button>`).join('')}
            <button type="button" class="chip-btn" data-cat="__stickers" aria-pressed="false">Стикеры</button>
          </div>
          <div class="emoji-board" data-emoji-board></div>
          <h4>Текст на баннере</h4>
          <div class="studio-text">
            <input class="input" maxlength="40" placeholder="Ваш текст" data-text-input>
            <button type="button" class="btn btn-primary btn-sm" data-text-add>Добавить</button>
          </div>
          <div class="color-row" data-text-colors>${TEXT_COLORS.map((c, i) => `<button type="button" class="color-dot" data-color="${c}" aria-checked="${i === 0}" style="background:${c}"></button>`).join('')}</div>
          <p class="studio-hint">Нажмите на эмодзи — он появится на баннере. Тащите, чтобы двигать; двумя пальцами — менять размер и поворот.</p>
        </div>

        <div class="studio-panel" data-panel="draw" hidden>
          <h4>Кисть</h4>
          <div class="color-row" data-brush-colors>${BRUSH_COLORS.map((c, i) => `<button type="button" class="color-dot" data-color="${c}" aria-checked="${i === 0}" style="background:${c}"></button>`).join('')}
            <label class="color-dot custom" title="Свой цвет"><input type="color" value="#ffffff" data-brush-custom></label></div>
          <label class="studio-range">Толщина<input type="range" min="4" max="70" value="18" data-brush-size></label>
          <div class="chip-row">
            <button type="button" class="chip-btn" data-eraser aria-pressed="false">Ластик</button>
            <button type="button" class="btn btn-sm" data-undo>Отменить штрих</button>
            <button type="button" class="btn btn-sm btn-danger" data-clear-ink>Стереть всё</button>
          </div>
          <p class="studio-hint">Рисуйте пальцем или мышью прямо на холсте.</p>
        </div>

        <div class="studio-panel" data-panel="profile" hidden>
          <h4>Цвет карточки</h4>
          <div class="theme-cards" data-themes>
            ${THEMES.map((id) => `<button type="button" class="theme-card-opt" data-theme="${id}" aria-checked="${id === S.theme}"><span class="swatch-theme profile-theme-${id}"></span><span>${THEME_LABELS[id]}</span></button>`).join('')}
          </div>
          <h4>Подпись</h4>
          <div class="studio-caption">
            <input class="input" maxlength="8" value="${esc(user.profileEmoji || '✨')}" data-caption-emoji aria-label="Эмодзи подписи">
            <textarea class="textarea" maxlength="180" placeholder="Короткая подпись профиля" data-caption>${esc(user.profileText || '')}</textarea>
          </div>
          <h4>Личный канал</h4>
          <select class="input" data-channel>
            <option value="">Без личного канала</option>
            ${myChannels.map((c) => `<option value="${esc(c.id)}" ${c.id === user.personalChannelId ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
          </select>
          <h4>Стикеры в профиле <small>до 6</small></h4>
          <div class="profile-sticker-grid" data-profile-stickers>
            ${STICKERS.map((s) => `<button type="button" class="sticker-choice ${S.stickers.has(s.id) ? 'selected' : ''}" data-sticker="${s.id}" title="${s.title}"><img src="${stickerUrl(s.id)}" alt="${s.title}"></button>`).join('')}
          </div>
          <h4>Галерея <small>до 12 фото и видео</small></h4>
          <input class="input" type="file" accept="image/*,video/*" multiple data-gallery>
        </div>
      </section>
    </div>
  </div>`;

  document.getElementById('overlays').append(root);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => root.classList.add('in'));

  const canvas = $('.studio-canvas', root);
  const ctx = canvas.getContext('2d');
  const ink = document.createElement('canvas');
  ink.width = W; ink.height = H;
  const inkCtx = ink.getContext('2d');

  /* — отрисовка — */
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const markDirty = () => { S.dirty = true; };

  function measure(o) {
    ctx.save(); ctx.font = `800 ${o.size}px ${FONT}`;
    const w = ctx.measureText(o.value).width; ctx.restore();
    return w;
  }
  function drawObject(c, o) {
    c.save(); c.translate(o.x, o.y); c.rotate(o.rot); c.textAlign = 'center'; c.textBaseline = 'middle';
    if (o.type === 'sticker') { if (o.img?.complete && o.img.naturalWidth) c.drawImage(o.img, -o.size / 2, -o.size / 2, o.size, o.size); }
    else if (o.type === 'emoji') { c.font = `${o.size}px ${EMOJI_FONT}`; c.fillText(o.value, 0, 0); }
    else { c.font = `800 ${o.size}px ${FONT}`; c.fillStyle = o.color; c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = o.size * .12; c.fillText(o.value, 0, 0); }
    c.restore();
  }
  function bounds(o) { return { w: (o.type === 'text' ? measure(o) : o.size) + 16, h: o.size + 16 }; }
  function hit(o, x, y) {
    const dx = x - o.x; const dy = y - o.y;
    const cos = Math.cos(-o.rot); const sin = Math.sin(-o.rot);
    const lx = dx * cos - dy * sin; const ly = dx * sin + dy * cos;
    const b = bounds(o);
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }
  function render(exporting = false) {
    ctx.clearRect(0, 0, W, H);
    if (S.photo) {
      const { img, zoom, ox, oy, dim } = S.photo;
      const s = Math.max(W / img.width, H / img.height) * zoom;
      ctx.drawImage(img, W / 2 - (img.width * s) / 2 + ox, H / 2 - (img.height * s) / 2 + oy, img.width * s, img.height * s);
      if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, W, H); }
    } else paintPreset(ctx, PRESET_BY_ID[S.preset]);
    paintPattern(ctx, S.pattern);
    ctx.drawImage(ink, 0, 0);
    for (const o of S.objects) drawObject(ctx, o);
    if (!exporting && S.selected) {
      const b = bounds(S.selected);
      ctx.save(); ctx.translate(S.selected.x, S.selected.y); ctx.rotate(S.selected.rot);
      ctx.setLineDash([14, 10]); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6;
      ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
  }

  const clampPhoto = () => {
    if (!S.photo) return;
    const { img, zoom } = S.photo;
    const s = Math.max(W / img.width, H / img.height) * zoom;
    const mx = Math.max(0, (img.width * s - W) / 2); const my = Math.max(0, (img.height * s - H) / 2);
    S.photo.ox = clamp(S.photo.ox, -mx, mx); S.photo.oy = clamp(S.photo.oy, -my, my);
  };

  /* — выбор объекта и слайдеры — */
  const sel = $('[data-sel]', root);
  const selSize = $('[data-sel-size]', root);
  const selRot = $('[data-sel-rot]', root);
  function select(o) {
    S.selected = o;
    sel.hidden = !o;
    if (o) { selSize.value = String(Math.round(o.size)); selRot.value = String(Math.round((o.rot * 180) / Math.PI)); }
  }
  selSize.addEventListener('input', () => { if (S.selected) { S.selected.size = Number(selSize.value); markDirty(); schedule(); } });
  selRot.addEventListener('input', () => { if (S.selected) { S.selected.rot = (Number(selRot.value) * Math.PI) / 180; markDirty(); schedule(); } });
  $('[data-sel-del]', root).addEventListener('click', () => { S.objects = S.objects.filter((o) => o !== S.selected); select(null); markDirty(); schedule(); });
  $('[data-sel-dup]', root).addEventListener('click', () => { if (!S.selected) return; const c = { ...S.selected, x: S.selected.x + 50, y: S.selected.y + 40 }; S.objects.push(c); select(c); markDirty(); schedule(); });
  $('[data-sel-front]', root).addEventListener('click', () => { if (!S.selected) return; S.objects = [...S.objects.filter((o) => o !== S.selected), S.selected]; markDirty(); schedule(); });

  function addObject(partial) {
    const o = { x: W / 2 + (Math.random() - .5) * 220, y: H * 0.26 + (Math.random() - .5) * 120, size: 160, rot: 0, ...partial };
    S.objects.push(o); select(o); markDirty(); schedule();
  }

  /* — указатель на холсте — */
  const pts = new Map();
  const toCanvas = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    const p = toCanvas(e); pts.set(e.pointerId, p);
    if (S.tab === 'draw') {
      S.current = { color: S.brush.color, size: S.brush.size, eraser: S.brush.eraser, points: [p] };
      S.strokes.push(S.current); drawStroke(inkCtx, S.current); markDirty(); schedule(); return;
    }
    if (pts.size === 2 && S.selected) {
      const [a, b] = [...pts.values()];
      S.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, a: Math.atan2(b.y - a.y, b.x - a.x), size: S.selected.size, rot: S.selected.rot };
      S.drag = null; return;
    }
    const target = [...S.objects].reverse().find((o) => hit(o, p.x, p.y));
    if (target) { select(target); S.drag = { o: target, dx: p.x - target.x, dy: p.y - target.y }; }
    else { select(null); S.drag = S.tab === 'bg' && S.photo ? { photo: true, sx: p.x, sy: p.y, ox: S.photo.ox, oy: S.photo.oy } : null; }
    schedule();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = toCanvas(e); pts.set(e.pointerId, p);
    if (S.current) {
      const last = S.current.points[S.current.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
      S.current.points.push(p); drawStroke(inkCtx, S.current); schedule(); return;
    }
    if (S.pinch && pts.size >= 2 && S.selected) {
      const [a, b] = [...pts.values()];
      S.selected.size = clamp((S.pinch.size * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / S.pinch.d, 30, 700);
      S.selected.rot = S.pinch.rot + (Math.atan2(b.y - a.y, b.x - a.x) - S.pinch.a);
      select(S.selected); markDirty(); schedule(); return;
    }
    if (S.drag?.o) { S.drag.o.x = clamp(p.x - S.drag.dx, -60, W + 60); S.drag.o.y = clamp(p.y - S.drag.dy, -60, H + 60); markDirty(); schedule(); }
    else if (S.drag?.photo) { S.photo.ox = S.drag.ox + (p.x - S.drag.sx); S.photo.oy = S.drag.oy + (p.y - S.drag.sy); clampPhoto(); markDirty(); schedule(); }
  });
  const endPointer = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) S.pinch = null;
    if (!pts.size) { S.current = null; S.drag = null; }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    if (!S.selected) return;
    e.preventDefault();
    S.selected.size = clamp(S.selected.size * (e.deltaY < 0 ? 1.06 : 0.94), 30, 700);
    select(S.selected); markDirty(); schedule();
  }, { passive: false });

  /* — вкладки — */
  const tabs = $('[data-tabs]', root);
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    S.tab = b.dataset.tab;
    $$('[data-tab]', tabs).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('[data-panel]', root).forEach((p) => { p.hidden = p.dataset.panel !== S.tab; });
    root.dataset.tab = S.tab;
    canvas.style.cursor = S.tab === 'draw' ? 'crosshair' : 'grab';
  });
  root.dataset.tab = 'bg';

  /* — фон — */
  $('[data-presets]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    S.preset = b.dataset.preset; S.photo = null; syncPhotoUi();
    S.removeBanner = false;
    $('[data-banner-delete]', root)?.removeAttribute('hidden');
    $('[data-banner-delete-status]', root)?.setAttribute('hidden', '');
    $$('[data-preset]', root).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    markDirty(); schedule();
  });
  $('[data-patterns]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-pattern]'); if (!b) return;
    S.pattern = b.dataset.pattern;
    $$('[data-pattern]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    markDirty(); schedule();
  });
  const photoCtl = $('[data-photo-ctl]', root);
  const photoClear = $('[data-photo-clear]', root);
  function syncPhotoUi() { photoCtl.hidden = !S.photo; photoClear.hidden = !S.photo; if (S.photo) { $('[data-photo-zoom]', root).value = String(S.photo.zoom); $('[data-photo-dim]', root).value = String(S.photo.dim); } }
  function setPhoto(img) {
    if (closing) return;
    S.photo = { img, zoom: 1, ox: 0, oy: 0, dim: 0 };
    S.removeBanner = false;
    $('[data-banner-delete]', root)?.removeAttribute('hidden');
    $('[data-banner-delete-status]', root)?.setAttribute('hidden', '');
    syncPhotoUi(); markDirty(); schedule();
  }
  $('[data-banner-delete]', root)?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Удалить баннер?', text: 'Фото баннера исчезнет из профиля после сохранения.', confirmLabel: 'Удалить', danger: true }))) return;
    S.removeBanner = true;
    S.photo = null;
    syncPhotoUi();
    S.dirty = true;
    schedule();
    $('[data-banner-delete]', root).hidden = true;
    $('[data-banner-delete-status]', root).hidden = false;
  });
  $('[data-photo-input]', root).addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Нужна картинка', { type: 'error' });
    try {
      const { file: small } = await compressImage(file, { maxDim: 2000, quality: 0.9 });
      const url = URL.createObjectURL(small); const img = new Image();
      objectUrls.add(url);
      img.onload = () => { URL.revokeObjectURL(url); objectUrls.delete(url); if (!closing) setPhoto(img); };
      img.onerror = () => { URL.revokeObjectURL(url); objectUrls.delete(url); toast('Не удалось открыть изображение', { type: 'error' }); };
      img.src = url;
    } catch (err) { toastError(err); }
    e.target.value = '';
  });
  $('[data-photo-current]', root)?.addEventListener('click', () => {
    const img = new Image(); img.onload = () => setPhoto(img); img.onerror = () => toast('Не удалось загрузить текущий баннер', { type: 'error' });
    img.src = user.profileBanner;
  });
  photoClear.addEventListener('click', () => { S.photo = null; syncPhotoUi(); markDirty(); schedule(); });
  $('[data-photo-zoom]', root).addEventListener('input', (e) => { if (S.photo) { S.photo.zoom = Number(e.target.value); clampPhoto(); markDirty(); schedule(); } });
  $('[data-photo-dim]', root).addEventListener('input', (e) => { if (S.photo) { S.photo.dim = Number(e.target.value); markDirty(); schedule(); } });
  $('[data-mock-toggle]', root).addEventListener('change', (e) => { $('[data-mock]', root).hidden = !e.target.checked; });

  /* — эмодзи, стикеры, текст — */
  const board = $('[data-emoji-board]', root);
  function paintBoard() {
    if (S.emojiCat === '__stickers') {
      board.className = 'emoji-board stickers';
      board.innerHTML = STICKERS.map((s) => `<button type="button" data-add-sticker="${s.id}" title="${s.title}"><img src="${stickerUrl(s.id)}" alt="${s.title}"></button>`).join('');
    } else {
      board.className = 'emoji-board';
      board.innerHTML = EMOJI[S.emojiCat].split(' ').map((em) => `<button type="button" data-add-emoji="${em}">${em}</button>`).join('');
    }
  }
  paintBoard();
  $('[data-emoji-cats]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    S.emojiCat = b.dataset.cat;
    $$('[data-cat]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paintBoard();
  });
  board.addEventListener('click', (e) => {
    const em = e.target.closest('[data-add-emoji]');
    if (em) return addObject({ type: 'emoji', value: em.dataset.addEmoji });
    const st = e.target.closest('[data-add-sticker]');
    if (st) {
      const img = new Image(); img.onload = schedule; img.src = stickerUrl(st.dataset.addSticker);
      addObject({ type: 'sticker', value: st.dataset.addSticker, img, size: 200 });
    }
  });
  $('[data-text-colors]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    S.textColor = b.dataset.color;
    $$('[data-text-colors] [data-color]', root).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (S.selected?.type === 'text') { S.selected.color = S.textColor; markDirty(); schedule(); }
  });
  const textInput = $('[data-text-input]', root);
  const addText = () => { const v = textInput.value.trim(); if (!v) return textInput.focus(); addObject({ type: 'text', value: v, color: S.textColor, size: 120 }); textInput.value = ''; };
  $('[data-text-add]', root).addEventListener('click', addText);
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addText(); } });

  /* — рисунок — */
  const brushColors = $('[data-brush-colors]', root);
  brushColors.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    S.brush.color = b.dataset.color; S.brush.eraser = false;
    $$('[data-color]', brushColors).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('[data-eraser]', root).setAttribute('aria-pressed', 'false');
  });
  $('[data-brush-custom]', root).addEventListener('input', (e) => {
    S.brush.color = e.target.value; S.brush.eraser = false;
    $$('[data-color]', brushColors).forEach((x) => x.setAttribute('aria-checked', 'false'));
    $('[data-eraser]', root).setAttribute('aria-pressed', 'false');
  });
  $('[data-brush-size]', root).addEventListener('input', (e) => { S.brush.size = Number(e.target.value); });
  $('[data-eraser]', root).addEventListener('click', (e) => { S.brush.eraser = !S.brush.eraser; e.currentTarget.setAttribute('aria-pressed', String(S.brush.eraser)); });
  const rebuildInk = () => { inkCtx.clearRect(0, 0, W, H); S.strokes.forEach((s) => drawStroke(inkCtx, s)); };
  $('[data-undo]', root).addEventListener('click', () => { S.strokes.pop(); rebuildInk(); markDirty(); schedule(); });
  $('[data-clear-ink]', root).addEventListener('click', () => { S.strokes = []; rebuildInk(); markDirty(); schedule(); });

  /* — оформление профиля — */
  $('[data-themes]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    S.theme = b.dataset.theme;
    $$('[data-theme]', root).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });
  $('[data-profile-stickers]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-sticker]'); if (!b) return;
    const id = b.dataset.sticker;
    if (S.stickers.has(id)) S.stickers.delete(id); else if (S.stickers.size < 6) S.stickers.add(id); else toast('Можно выбрать до 6 стикеров', { type: 'info' });
    b.classList.toggle('selected', S.stickers.has(id));
  });

  /* — закрытие и сохранение — */
  let saving = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey, true);
    document.body.style.overflow = previousBodyOverflow;
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    root.classList.remove('in');
    setTimeout(() => { root.remove(); opened = false; }, 220);
  };
  const requestClose = async () => {
    if (saving) return;
    if (S.dirty && !(await confirmDialog({ title: 'Закрыть без сохранения?', text: 'Изменения баннера будут потеряны.', confirmLabel: 'Закрыть', danger: true }))) return;
    close();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); requestClose(); } };
  document.addEventListener('keydown', onKey, true);
  $('[data-close]', root).addEventListener('click', requestClose);

  const saveBtn = $('[data-save]', root);
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    saving = true; saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> Сохраняем…';
    try {
      const payload = {
        profileTheme: S.theme,
        profileEmoji: $('[data-caption-emoji]', root).value.trim() || '✨',
        profileText: $('[data-caption]', root).value.trim(),
        personalChannelId: $('[data-channel]', root).value ? Number($('[data-channel]', root).value) : null,
        profileStickers: [...S.stickers],
      };
      if (S.dirty) {
        if (S.removeBanner) {
          payload.profileBannerMediaId = null;
        } else {
          select(null); render(true);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
          if (!blob) throw new Error('Не удалось собрать баннер');
          const file = new File([blob], 'profile-banner.jpg', { type: 'image/jpeg' });
          const up = await api.upload(file, { kind: 'image', width: W, height: H });
          payload.profileBannerMediaId = up.media.id;
        }
      }
      const updated = await Api.updateProfile(payload);
      const gallery = $('[data-gallery]', root);
      for (const f of [...(gallery.files || [])].slice(0, 12)) {
        const { file: prepared } = f.type.startsWith('image/') ? await compressImage(f, { maxDim: 1600, quality: 0.86 }) : { file: f };
        const uploaded = await api.upload(prepared, { kind: f.type.startsWith('video/') ? 'video' : 'image' });
        await Api.addProfileGallery(uploaded.media.id);
      }
      if (updated?.user && state.user) Object.assign(state.user, updated.user);
      bus.emit('user:updated', state.user);
      toast('Профиль обновлён', { type: 'success' });
      S.dirty = false; saving = false;
      close();
      bus.emit('panel:open', { userId: state.user.id });
    } catch (err) {
      saving = false; saveBtn.disabled = false; saveBtn.textContent = 'Сохранить';
      toastError(err);
    }
  });

  /* — стартовый фон — */
  if (user.profileBanner) {
    const img = new Image();
    img.onload = () => { S.photo = { img, zoom: 1, ox: 0, oy: 0, dim: 0 }; syncPhotoUi(); schedule(); };
    img.src = user.profileBanner;
  }
  schedule();
  canvas.style.cursor = 'grab';
}
