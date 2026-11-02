/**
 * Истории v2 — создание (текст на фонах, фото/видео, стикеры, подписи, фильтры) и просмотр во весь экран.
 * Заменяет js/views/stories.js. Экспорты прежние: mount(host), refresh().
 * Оформление истории (фон, шрифт, стикеры…) хранится в начале поля text как скрытый конверт — серверных изменений не нужно.
 * Стили: /css/stories-v2.css
 */
import { state, bus } from '../store.js';
import { Api, api } from '../api.js?v=20261104-payment-email-1';
import { avatarHTML, toast, toastError } from '../ui.js?v=20261029-no-toasts-1';
import { EMOJI_PACKS, customEmojiById, customEmojiURL } from '../premium.js';

const REFRESH_MS = 60_000;
const MAX_TOTAL = 500; // максимум символов в text (подпись + конверт со стикерами)
const MARK = '\u2063';
const SV = { host: null, stories: [], loading: false, timer: null };
const me = () => Number(state.user?.id);
const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

/* ── Справочники оформления ─────────────────────────────────────────────── */
const BGS = [
  { c: 'linear-gradient(135deg,#7c5cff,#2fb8ff)' }, { c: 'linear-gradient(135deg,#ff6ec7,#ffb347)' },
  { c: 'linear-gradient(135deg,#00c6a7,#1e4d92)' }, { c: 'linear-gradient(135deg,#f12711,#f5af19)' },
  { c: 'linear-gradient(135deg,#8e2de2,#4a00e0)' }, { c: 'linear-gradient(135deg,#11998e,#38ef7d)' },
  { c: 'linear-gradient(135deg,#ee0979,#ff6a00)' }, { c: 'linear-gradient(135deg,#0f2027,#2c5364)' },
  { c: 'linear-gradient(135deg,#fc466b,#3f5efb)' }, { c: 'linear-gradient(135deg,#ffd200,#f7971e)', light: true },
  { c: 'radial-gradient(90% 70% at 20% 10%,#ff7ad9,transparent 60%),radial-gradient(80% 70% at 85% 90%,#5b8cff,transparent 60%),#1a1040' },
  { c: 'radial-gradient(90% 70% at 80% 10%,#ffb347,transparent 60%),radial-gradient(80% 70% at 10% 90%,#be185d,transparent 60%),#1a0b10' },
  { c: 'radial-gradient(90% 70% at 15% 20%,#34d399,transparent 60%),radial-gradient(80% 70% at 90% 90%,#0e7490,transparent 60%),#04141a' },
  { c: 'radial-gradient(90% 70% at 50% 0%,#7dd3fc,transparent 60%),radial-gradient(80% 70% at 50% 100%,#6366f1,transparent 60%),#06101f' },
  { c: 'linear-gradient(160deg,#232526,#414345)' }, { c: '#0b0b10' }, { c: '#ffffff', light: true }, { c: 'linear-gradient(135deg,#fbc2eb,#a6c1ee)', light: true },
];
const FONTS = [
  { n: 'Классика', f: '-apple-system,"Segoe UI",Roboto,Helvetica,sans-serif', w: 800 },
  { n: 'Книга', f: 'Georgia,"Times New Roman",serif', w: 700 },
  { n: 'Рукопись', f: '"Bradley Hand","Segoe Script","Snell Roundhand","Comic Sans MS",cursive', w: 700 },
  { n: 'Моно', f: 'ui-monospace,Menlo,Consolas,monospace', w: 700 },
  { n: 'Мягкий', f: 'ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",system-ui,sans-serif', w: 800 },
  { n: 'Плакат', f: 'Impact,"Arial Black","Haettenschweiler",sans-serif', w: 400, up: true },
];
const COLORS = [['#ffffff', '#111111'], ['#111111', '#ffffff'], ['#ffd54a', '#111111'], ['#ff6ec7', '#ffffff'], ['#5ee1ff', '#111111'], ['#6dffa0', '#111111'], ['#ff9a3d', '#111111'], ['#a58bff', '#ffffff']];
const TS_NAMES = ['Обычный', 'Плашка', 'Неон', 'Контур'];
const FILTERS = [['Оригинал', ''], ['Яркий', 'saturate(1.45) contrast(1.08)'], ['Тёплый', 'sepia(.28) saturate(1.3) hue-rotate(-8deg)'], ['Холод', 'saturate(1.1) hue-rotate(14deg) brightness(1.04)'], ['Ч/Б', 'grayscale(1) contrast(1.12)'], ['Плёнка', 'sepia(.35) contrast(.95) brightness(1.06) saturate(.9)'], ['Мечта', 'brightness(1.1) saturate(1.25) contrast(.92)']];
const EMOJIS = '🔥 ❤️ 😍 😂 🥹 😎 🤩 😭 🥳 😴 🤯 😈 👀 🙌 👏 💪 🙏 ✨ 🎉 🎂 🎁 🎈 🌈 ☀️ 🌙 ⭐ ⚡ ❄️ 🌸 🌴 🍕 🍔 🍓 🍿 ☕ 🍷 🎧 🎮 📸 🎬 🎵 🚀 ✈️ 🏖️ 🏔️ 🚗 🐶 🐱 🦊 🐼 🦄 💎 👑 💯 ✅ ❓ ❗ 💬 🧠 💀 👻 🎃 🎄 🎆 ❤️‍🔥 🫶 🤝 👋 🤙 😇 🥰 😏 🫠 🤌'.split(' ');
const REACTS = ['❤️', '🔥', '😂', '😮', '😢', '👏'];

/* ── Конверт: оформление ⇄ text ─────────────────────────────────────────── */
const r3 = (n) => Math.round(n * 1000) / 1000;
function pack(meta, caption) {
  const m = {};
  if (meta.b) m.b = meta.b; if (meta.f) m.f = meta.f; if (meta.a) m.a = meta.a; if (meta.s) m.s = meta.s; if (meta.l) m.l = meta.l;
  if (meta.y?.length) m.y = meta.y.map((l) => l.map((v) => (typeof v === 'number' ? r3(v) : v)));
  if (meta.q) m.q = meta.q.map(r3);
  return (Object.keys(m).length ? `${MARK}${JSON.stringify(m)}${MARK}` : '') + caption;
}
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const mediaView = (value) => {
  const [scale, x, y, rotation] = Array.isArray(value) ? value : [];
  return [
    clamp(finite(scale, 1), .5, 4),
    clamp(finite(x, 0), -.8, .8),
    clamp(finite(y, 0), -.8, .8),
    clamp(finite(rotation, 0), -360, 360),
  ];
};
function unpack(text = '') {
  if (text[0] !== MARK) return { meta: {}, caption: text };
  const end = text.indexOf(MARK, 1);
  if (end < 0) return { meta: {}, caption: text };
  try {
    const meta = JSON.parse(text.slice(1, end)) || {};
    if (meta.q) meta.q = mediaView(meta.q);
    return { meta, caption: text.slice(end + 1) };
  } catch { return { meta: {}, caption: text.slice(end + 1) }; }
}
const prep = (s) => { const u = unpack(s.text); s.meta = u.meta; s.caption = u.caption; return s; };

/* ── Общая разметка кадра (создание и просмотр) ─────────────────────────── */
const fitK = (len) => (len <= 14 ? .12 : len <= 40 ? .09 : len <= 90 ? .07 : len <= 180 ? .055 : .044);
const bgStyle = (i) => { const b = BGS[i || 0] || BGS[0]; return `background:${b.c};${b.c.startsWith('linear') ? 'background-size:240% 240%;' : ''}`; };
function mainHTML(meta, text) {
  const f = FONTS[meta.f || 0] || FONTS[0]; const bg = BGS[meta.b || 0] || BGS[0];
  return `<div class="sx-main sx-ts-${meta.s || 0}" style="--tc:${bg.light ? '#111' : '#fff'};--ti:${bg.light ? '#fff' : '#111'};--k:${fitK(text.length)};font-family:${f.f};font-weight:${f.w};text-align:${['center', 'left', 'right'][meta.a || 0]};${f.up ? 'text-transform:uppercase;' : ''}"><span class="sx-txt">${E(text)}</span></div>`;
}
function layerHTML(l, i, edit) {
  const [k, v, x, y, s = 1, r = 0, c = 0, f = 0, st = 0] = l;
  let inner = '';
  if (k === 'e') inner = `<span class="sx-em">${E(v)}</span>`;
  else if (k === 'c') { const em = customEmojiById.get(v); inner = em ? `<img class="sx-em-img" src="${customEmojiURL(em)}" alt="" draggable="false">` : ''; }
  else if (k === 'p') inner = `<span class="sx-pill">${E(v)}</span>`;
  else { const col = COLORS[c] || COLORS[0]; const ff = FONTS[f] || FONTS[0]; inner = `<span class="sx-lt sx-ts-${st}" style="--tc:${col[0]};--ti:${col[1]};font-family:${ff.f};font-weight:${ff.w};${ff.up ? 'text-transform:uppercase;' : ''}">${E(v)}</span>`; }
  const pos = `left:${x * 100}%;top:${y * 100}%;--s:${s};--r:${r}deg`;
  return `<div class="sx-l${edit ? ' sx-edit' : ''}"${edit ? ` data-li="${i}"` : ''} style="${edit ? '' : `--d:${200 + i * 90}ms;`}${pos}">${inner}</div>`;
}
const filterOf = (m) => (FILTERS[m.l || 0] || FILTERS[0])[1] || 'none';
function frameHTML(st) {
  const m = st.meta || {}; let media = ''; let main = '';
  const [scale = 1, x = 0, y = 0, rotation = 0] = m.q || [];
  const mediaTransform = `filter:${filterOf(m)};transform:translate(${x * 100}%,${y * 100}%) scale(${scale}) rotate(${rotation}deg)`;
  if (st.type === 'text') { media = '<i class="sx-orb o1"></i><i class="sx-orb o2"></i>'; main = mainHTML(m, st.caption || ''); }
  else if (st.type === 'image') media = `<img class="sx-media" src="${E(st.mediaUrl)}" style="${mediaTransform}" alt="" decoding="async" draggable="false">`;
  else media = `<video class="sx-media" src="${E(st.mediaUrl)}" style="${mediaTransform}" playsinline webkit-playsinline autoplay preload="auto"></video>`;
  return `<div class="sx-frame ${st.type === 'text' ? 'sx-shift' : ''}" data-frame style="${st.type === 'text' ? bgStyle(m.b) : ''}">${media}${main}<div class="sx-layers">${(m.y || []).map((l, i) => layerHTML(l, i, false)).join('')}</div></div>`;
}
function watchWidth(frame) {
  const set = () => frame.style.setProperty('--fw', `${frame.clientWidth}px`);
  set();
  if (window.ResizeObserver) { const ro = new ResizeObserver(set); ro.observe(frame); return () => ro.disconnect(); }
  return () => {};
}

/* ── Лента историй ──────────────────────────────────────────────────────── */
function groupedStories() {
  const groups = new Map();
  for (const story of SV.stories) {
    prep(story); const key = String(story.author.id);
    if (!groups.has(key)) groups.set(key, { author: story.author, stories: [] });
    groups.get(key).stories.push(story);
  }
  const list = [...groups.values()];
  const rank = (g) => (g.author.id === me() ? -1 : g.stories.some((s) => !s.viewedByMe) ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b));
}
const ava = (a, size = 'md') => avatarHTML({ name: a.name, avatarUrl: a.avatarUrl, color: a.avatarColor, size });

function renderBar() {
  if (!SV.host) return;
  const groups = groupedStories(); const ownId = me();
  const own = groups.find((g) => g.author.id === ownId); const others = groups.filter((g) => g.author.id !== ownId);
  const ownUnseen = own?.stories.some((s) => !s.viewedByMe);
  const item = (g) => {
    const unseen = g.stories.some((s) => !s.viewedByMe);
    return `<button class="sx-item" type="button" data-story-author="${g.author.id}" aria-label="Истории ${E(g.author.name)}">
      <span class="sx-ava ${unseen ? 'unseen' : 'seen'}"><span class="sx-ring"></span><span class="sx-ava-in">${ava(g.author)}</span>${g.stories.length > 1 ? `<span class="sx-count">${g.stories.length}</span>` : ''}</span>
      <span class="sx-name">${E((g.author.name || g.author.username || '').split(' ')[0])}</span></button>`;
  };
  SV.host.innerHTML = `<section class="sx-strip" aria-label="Истории"><div class="sx-strip-items">
    <div class="sx-item sx-own">
      <button class="sx-ava ${own ? (ownUnseen ? 'unseen' : 'seen') : 'none'}" type="button" data-story-own="${own ? ownId : ''}" aria-label="${own ? 'Моя история' : 'Добавить историю'}"><span class="sx-ring"></span><span class="sx-ava-in">${ava({ name: state.user?.name, avatarUrl: state.user?.avatarUrl, avatarColor: state.user?.avatarColor })}</span></button>
      <button class="sx-plus" type="button" data-story-add aria-label="Добавить историю"><svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg></button>
      <span class="sx-name">${own ? 'Моя' : 'Добавить'}</span></div>
    ${others.map(item).join('')}
    ${SV.loading && !SV.stories.length ? Array.from({ length: 4 }, () => '<span class="sx-item sx-skel"><span class="sx-ava"></span><span class="sx-name">&nbsp;</span></span>').join('') : ''}
    ${!SV.loading && !others.length && !own ? '<span class="sx-hint">Здесь появятся истории контактов</span>' : ''}
  </div></section>`;
}

export async function refresh() {
  if (!SV.host || SV.loading) return;
  SV.loading = true; renderBar();
  try { SV.stories = (await Api.stories()).stories || []; } catch (e) { toastError(e); } finally { SV.loading = false; renderBar(); }
}

export function mount(host) {
  if (!host || SV.host === host) return;
  SV.host = host;
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-story-refresh]')) { refresh(); return; }
    if (e.target.closest('[data-story-add]')) { openCreator(); return; }
    const own = e.target.closest('[data-story-own]');
    if (own) { if (own.dataset.storyOwn) openViewer(Number(own.dataset.storyOwn)); else openCreator(); return; }
    const a = e.target.closest('[data-story-author]'); if (a) openViewer(Number(a.dataset.storyAuthor));
  });
  renderBar(); refresh();
  if (!SV.timer) SV.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  window.addEventListener('focus', refresh);
}

/* ═══ ПРОСМОТР ═══════════════════════════════════════════════════════════ */
let V = null;
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000)); return m < 1 ? 'только что' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч`; };
const I = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-8-4.7-8-10.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.9c0 5.900-8 10.600-8 10.600z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4-6.500z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.500 8.500a5 5 0 0 1 0 7"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6"/></svg>',
};

function openViewer(authorId) {
  const groups = groupedStories(); const gi = groups.findIndex((g) => g.author.id === authorId);
  if (gi < 0) return;
  closeViewer(true);
  const root = document.createElement('div'); root.className = 'sx-v';
  root.innerHTML = '<div class="sx-v-bg"></div><div class="sx-v-stage" data-stage></div>';
  document.body.append(root); document.body.classList.add('sx-lock');
  V = { root, groups, gi, si: 0, raf: 0, reasons: new Set(), elapsed: 0, dur: 6000, ready: false, last: 0, p: 0, video: null, bar: null, ptr: null, holdT: 0, delArm: 0, unwatch: null };
  const first = groups[gi].stories.findIndex((s) => !s.viewedByMe); V.si = first < 0 ? 0 : first;
  bindViewer(root);
  requestAnimationFrame(() => root.classList.add('in'));
  show('fade');
}

function closeViewer(instant) {
  if (!V) return;
  const v = V; V = null; cancelAnimationFrame(v.raf); clearTimeout(v.holdT); v.unwatch?.();
  v.root.querySelector('video')?.pause(); document.removeEventListener('keydown', onKey, true);
  document.body.classList.remove('sx-lock');
  if (instant) v.root.remove(); else { v.root.classList.remove('in'); v.root.classList.add('out'); setTimeout(() => v.root.remove(), 280); }
  renderBar();
}

const curStory = () => V.groups[V.gi].stories[V.si];
function setPause(reason, on) {
  if (!V) return; if (on) V.reasons.add(reason); else V.reasons.delete(reason);
  const paused = V.reasons.size > 0; V.root.classList.toggle('sx-paused', paused);
  if (V.video) { if (paused) V.video.pause(); else V.video.play().catch(() => {}); }
}

function show(anim = 'fade') {
  const g = V.groups[V.gi]; const st = g.stories[V.si]; const own = st.author.id === me(); const total = g.stories.length;
  cancelAnimationFrame(V.raf); V.unwatch?.(); V.elapsed = 0; V.p = 0; V.ready = false; V.video = null; V.reasons.clear(); V.root.classList.remove('sx-paused', 'sx-hold');
  V.dur = st.type === 'text' ? clamp(4500 + (st.caption || '').length * 45, 5000, 11000) : 6000;
  const stage = V.root.querySelector('[data-stage]');
  stage.className = `sx-v-stage sx-in-${anim}`; stage.style.transform = '';
  const bgUrl = st.type === 'image' ? st.mediaUrl : '';
  V.root.querySelector('.sx-v-bg').style.backgroundImage = bgUrl ? `url("${bgUrl.replace(/"/g, '%22')}")` : '';
  stage.innerHTML = `${frameHTML(st)}<i class="sx-shade t"></i><i class="sx-shade b"></i><span class="sx-spin"></span>
    <div class="sx-prog">${Array.from({ length: total }, (_, i) => `<i class="${i < V.si ? 'done' : ''}"><b></b></i>`).join('')}</div>
    <header class="sx-vh">${ava(st.author, 'sm')}<span class="sx-vh-t"><b>${E(st.author.name)}</b><small>${ago(st.createdAt)}</small></span>
      ${st.type === 'video' ? `<button class="sx-ib" data-mute aria-label="Звук">${I.sound}</button>` : ''}<button class="sx-ib" data-vclose aria-label="Закрыть">${I.close}</button></header>
    ${st.type !== 'text' && st.caption ? `<p class="sx-cap-v">${E(st.caption)}</p>` : ''}
    ${own ? `<footer class="sx-foot own"><span class="sx-views">${I.eye}${st.viewCount || 0}</span><button class="sx-del" data-del aria-label="Удалить">${I.trash}<span>Удалить</span></button></footer>`
      : `<footer class="sx-foot"><div class="sx-react">${REACTS.map((r) => `<button type="button" data-react="${r}">${r}</button>`).join('')}</div>
      <form class="sx-reply" data-reply><input name="reply" maxlength="1000" placeholder="Ответить ${E((st.author.name || '').split(' ')[0])}…" autocomplete="off" enterkeyhint="send"><button class="sx-send" type="submit" aria-label="Отправить">${I.send}</button></form>
      <button class="sx-like ${st.likedByMe ? 'on' : ''}" type="button" data-like aria-pressed="${!!st.likedByMe}">${I.heart}<span>${st.likeCount || 0}</span></button></footer>`}`;
  V.bar = stage.querySelectorAll('.sx-prog i')[V.si]?.querySelector('b');
  const frame = stage.querySelector('[data-frame]'); V.unwatch = watchWidth(frame);
  const start = () => { if (!V) return; V.ready = true; V.last = performance.now(); stage.classList.add('ready'); };
  const media = stage.querySelector('.sx-media');
  if (st.type === 'text') start();
  else if (st.type === 'image') { if (media.complete && media.naturalWidth) start(); else { media.addEventListener('load', start, { once: true }); media.addEventListener('error', start, { once: true }); } }
  else {
    V.video = media; media.muted = !!V.muted;
    media.addEventListener('loadedmetadata', () => { V.dur = (media.duration || 6) * 1000; }, { once: true });
    media.addEventListener('playing', start, { once: true });
    media.play().catch(() => { media.muted = true; V.muted = true; media.play().catch(() => {}); stage.querySelector('[data-mute]')?.classList.add('off'); });
  }
  V.raf = requestAnimationFrame(tick);
  if (!own && !st.viewedByMe) Api.viewStory(st.id).then((r) => { st.viewedByMe = r.viewed; st.viewCount = r.viewCount; }).catch(() => {});
  const nx = g.stories[V.si + 1]; if (nx?.type === 'image') new Image().src = nx.mediaUrl;
}

function tick(now) {
  if (!V) return;
  if (V.finished) return;
  if (V.ready && !V.reasons.size) {
    if (V.video) {
      const d = V.video.duration || 0; V.p = d ? V.video.currentTime / d : 0;
      if (V.video.ended) { next(true); return; }
    } else {
      V.elapsed += now - V.last; V.p = V.elapsed / V.dur;
      if (V.p >= 1) { next(true); return; }
    }
    if (V.bar) V.bar.style.transform = `scaleX(${clamp(V.p, 0, 1)})`;
  }
  V.last = now; V.raf = requestAnimationFrame(tick);
}
const firstUnseen = (g) => { const i = g.stories.findIndex((s) => !s.viewedByMe); return i < 0 ? 0 : i; };
function next(automatic = false) { if (!V) return; const g = V.groups[V.gi]; if (V.si + 1 < g.stories.length) { V.si += 1; show('fade'); } else nextGroup(automatic); }
function nextGroup(automatic = false) {
  if (V.gi + 1 < V.groups.length) { V.gi += 1; V.si = firstUnseen(V.groups[V.gi]); show('r'); }
  else if (automatic) {
    V.finished = true;
    V.video?.pause();
    if (V.bar) V.bar.style.transform = 'scaleX(1)';
  } else closeViewer();
}
function prevGroup() { if (V.gi > 0) { V.gi -= 1; V.si = 0; show('l'); } else { V.elapsed = 0; V.root.querySelector('[data-stage]').style.transform = ''; } }
function prev() { if (V.si > 0) { V.si -= 1; show('fade'); } else if (V.elapsed > 1500 || V.gi === 0) { V.elapsed = 0; if (V.video) V.video.currentTime = 0; } else prevGroup(); }

function onKey(e) {
  if (!V || e.target.matches?.('input,textarea')) { if (e.key === 'Escape' && V) { e.stopPropagation(); closeViewer(); } return; }
  if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); } else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev();
  else if (e.key === ' ') { e.preventDefault(); setPause('key', !V.reasons.has('key')); }
}

function burst(btn) {
  const r = btn.getBoundingClientRect();
  for (let i = 0; i < 9; i += 1) {
    const h = document.createElement('i'); h.className = 'sx-heart'; h.textContent = '❤️';
    h.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top}px;--dx:${(Math.random() - .5) * 110}px;--dy:${-90 - Math.random() * 130}px;--rot:${(Math.random() - .5) * 60}deg;animation-delay:${i * 35}ms;font-size:${16 + Math.random() * 14}px`;
    V.root.append(h); setTimeout(() => h.remove(), 1300);
  }
}
async function sendReply(st, replyText) {
  const quote = st.caption ? ` «${st.caption.slice(0, 120)}»` : '';
  const { chat } = await Api.openDm(st.author.id);
  await Api.sendMessage(chat.id, { text: `↩ Ответ на историю${quote}\n${replyText}` });
}

function bindViewer(root) {
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('click', async (e) => {
    const t = e.target; const st = curStory();
    if (t.closest('[data-vclose]')) { closeViewer(); return; }
    const mute = t.closest('[data-mute]');
    if (mute && V.video) { V.video.muted = !V.video.muted; V.muted = V.video.muted; mute.classList.toggle('off', V.video.muted); mute.innerHTML = V.video.muted ? I.mute : I.sound; return; }
    if (t.closest('[data-like]')) {
      const btn = t.closest('[data-like]');
      try { const r = await Api.likeStory(st.id); st.likedByMe = r.liked; st.likeCount = r.likeCount; btn.classList.toggle('on', r.liked); btn.setAttribute('aria-pressed', r.liked); btn.querySelector('span').textContent = r.likeCount; if (r.liked) { burst(btn); haptic(14); } } catch (err) { toastError(err); }
      return;
    }
    const re = t.closest('[data-react]');
    if (re) { try { await sendReply(st, re.dataset.react); burst(re); toast('Реакция отправлена', { type: 'success' }); } catch (err) { toastError(err); } return; }
    if (t.closest('[data-del]')) {
      const b = t.closest('[data-del]');
      if (!V.delArm) { V.delArm = setTimeout(() => { V.delArm = 0; b?.classList.remove('arm'); b.querySelector('span').textContent = 'Удалить'; }, 2600); b.classList.add('arm'); b.querySelector('span').textContent = 'Точно удалить?'; return; }
      clearTimeout(V.delArm); V.delArm = 0;
      try {
        await Api.deleteStory(st.id); SV.stories = SV.stories.filter((s) => s.id !== st.id);
        const g = V.groups[V.gi]; g.stories.splice(V.si, 1); toast('История удалена', { type: 'success' });
        if (!g.stories.length) { V.groups.splice(V.gi, 1); if (!V.groups.length) { closeViewer(); return; } V.gi = Math.min(V.gi, V.groups.length - 1); V.si = 0; show('fade'); } else { V.si = Math.min(V.si, g.stories.length - 1); show('fade'); }
      } catch (err) { toastError(err); }
    }
  });
  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-reply]')) return; e.preventDefault();
    const input = e.target.reply; const text = input.value.trim(); if (!text) return;
    const st = curStory(); e.target.classList.add('busy');
    try { await sendReply(st, text); input.value = ''; input.blur(); toast('Ответ отправлен в личный чат', { type: 'success' }); } catch (err) { toastError(err); } finally { e.target.classList.remove('busy'); }
  });
  root.addEventListener('focusin', (e) => { if (e.target.matches('.sx-reply input')) { setPause('input', true); root.classList.add('sx-typing'); } });
  root.addEventListener('focusout', (e) => { if (e.target.matches('.sx-reply input')) { setTimeout(() => { setPause('input', false); root.classList.remove('sx-typing'); }, 120); } });
  /* жесты: тап — вперёд/назад, удержание — пауза, свайп вниз — закрыть, свайп в стороны — другой автор */
  const stageEl = () => root.querySelector('[data-stage]');
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,input,form,.sx-react') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    V.ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, mode: null, held: false };
    clearTimeout(V.holdT); V.holdT = setTimeout(() => { if (V?.ptr && !V.ptr.mode) { V.ptr.held = true; setPause('hold', true); root.classList.add('sx-hold'); haptic(8); } }, 230);
    try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  root.addEventListener('pointermove', (e) => {
    const p = V?.ptr; if (!p || p.id !== e.pointerId) return;
    p.dx = e.clientX - p.x; p.dy = e.clientY - p.y;
    if (!p.mode && Math.hypot(p.dx, p.dy) > 12) { p.mode = Math.abs(p.dy) > Math.abs(p.dx) ? (p.dy > 0 ? 'close' : 'up') : 'h'; clearTimeout(V.holdT); if (p.mode !== 'up') setPause('drag', true); }
    const s = stageEl();
    if (p.mode === 'close') { s.style.transition = 'none'; s.style.transform = `translateY(${Math.max(0, p.dy)}px) scale(${1 - clamp(p.dy, 0, 500) / 1700})`; root.style.setProperty('--sx-o', String(1 - clamp(p.dy, 0, 400) / 600)); }
    else if (p.mode === 'h') { s.style.transition = 'none'; s.style.transform = `translateX(${p.dx * .55}px) rotateY(${clamp(-p.dx / 14, -18, 18)}deg)`; }
  });
  const end = (e) => {
    const p = V?.ptr; if (!p || p.id !== e.pointerId) return; V.ptr = null; clearTimeout(V.holdT);
    const s = stageEl(); s.style.transition = 'transform .32s cubic-bezier(.2,.9,.25,1)'; root.style.removeProperty('--sx-o');
    setPause('drag', false);
    if (p.held) { setPause('hold', false); root.classList.remove('sx-hold'); return; }
    if (p.mode === 'close') { if (p.dy > 120 && e.type === 'pointerup') { closeViewer(); haptic(8); } else s.style.transform = ''; return; }
    if (p.mode === 'h') { s.style.transform = ''; if (Math.abs(p.dx) > 70 && e.type === 'pointerup') { if (p.dx < 0) nextGroup(); else prevGroup(); haptic(8); } return; }
    if (p.mode) return;
    if (e.type !== 'pointerup') return;
    const r = s.getBoundingClientRect(); if (e.clientX < r.left + r.width * .33) prev(); else next();
  };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
}

/* ═══ СОЗДАНИЕ ═══════════════════════════════════════════════════════════ */
const CI = {
  close: I.close, text: '<svg viewBox="0 0 24 24"><path d="M5 7V5h14v2M12 5v14M9 19h6"/></svg>', sticker: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-8-8h1v5a3 3 0 0 0 3 3h4z"/><path d="M9 14c1 1.500 4 1.500 6 0M9 10h.01M13 10h.01"/></svg>',
  palette: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1.500 0 2-1 1.500-2s0-2 1.500-2h2a3 3 0 0 0 3-3C20 8 16.500 3 12 3z"/><path d="M7.500 11h.01M10 7.500h.01M14.500 7.500h.01"/></svg>',
  font: '<svg viewBox="0 0 24 24"><path d="M4 19 10 5l6 14M6.500 14h7M17 19l3-7 2 5"/></svg>', align: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
  box: '<svg viewBox="0 0 24 24"><rect x="3.500" y="5" width="17" height="14" rx="3"/><path d="M8 15l2-6 2 6M8.700 13h2.600"/></svg>', send: I.send, trash: I.trash,
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.600"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>', cam: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.500"/></svg>',
};

function sheet(parent, body, onMount) {
  const w = document.createElement('div'); w.className = 'sx-sheet-wrap';
  w.innerHTML = `<div class="sx-sheet"><div class="sx-grab"></div>${body}</div>`;
  const shut = () => { w.classList.remove('in'); setTimeout(() => w.remove(), 280); };
  w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-shut]')) shut(); });
  parent.append(w); requestAnimationFrame(() => w.classList.add('in')); onMount?.(w, shut); return shut;
}
async function prepareFile(file, kind) {
  if (kind !== 'image' || /gif|svg/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file); const k = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', .88));
    return blob ? new File([blob], `${file.name.replace(/\.\w+$/, '')}.jpg`, { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

function openCreator() {
  const C = { mode: 'text', bg: 0, font: 0, align: 0, ts: 0, flt: 0, layers: [], text: '', cap: '', file: null, url: '', kind: '', tool: 'bg', busy: false, zoom: { scale: 1, x: 0, y: 0, rotation: 0 } };
  const root = document.createElement('div'); root.className = 'sx-c';
  root.innerHTML = `<div class="sx-c-bg"></div>
  <header class="sx-c-top"><button class="sx-ib" data-cclose aria-label="Закрыть">${CI.close}</button><b>Новая история</b><span class="sx-c-note">24 часа</span></header>
  <div class="sx-c-stage">
    <div class="sx-frame sx-c-frame" data-cframe>
      <div data-cmedia></div>
      <div class="sx-main" data-cmain><span class="sx-txt" contenteditable="true" spellcheck="false" data-ph="Напишите что-нибудь…" data-ctxt></span></div>
      <div class="sx-layers" data-clayers></div>
      <div class="sx-trash" data-ctrash>${CI.trash}</div>
    </div>
    <div class="sx-media-controls" data-media-controls aria-label="Настроить фото или видео">
      <button type="button" data-media-action="zoom-out" aria-label="Отдалить">−</button>
      <button type="button" data-media-action="zoom-in" aria-label="Приблизить">+</button>
      <button type="button" data-media-action="rotate" aria-label="Повернуть на 90 градусов">↻</button>
      <button type="button" data-media-action="reset" aria-label="Сбросить кадр">Сброс</button>
    </div>
    <div class="sx-c-rail">
      <button data-rail="text" aria-label="Добавить текст">${CI.text}</button><button data-rail="sticker" aria-label="Стикеры">${CI.sticker}</button>
      <button data-rail="bg" aria-label="Фон и фильтры">${CI.palette}</button>
      <button data-rail="font" class="only-text" aria-label="Шрифт">${CI.font}</button><button data-rail="align" class="only-text" aria-label="Выравнивание">${CI.align}</button><button data-rail="ts" class="only-text" aria-label="Стиль текста">${CI.box}</button>
    </div>
  </div>
  <div class="sx-c-bottom">
    <div class="sx-tray" data-tray></div>
    <input class="sx-capin" data-cap maxlength="500" placeholder="Добавить подпись…" hidden>
    <div class="sx-c-row">
      <div class="sx-modes"><button data-mode="text" class="on">Текст</button><button data-pick="g">${CI.image}Галерея</button><button data-pick="c">${CI.cam}Камера</button></div>
      <button class="sx-publish" data-publish aria-label="Опубликовать">${CI.send}</button>
    </div>
    <small class="sx-count" data-count></small>
  </div>
  <input type="file" hidden data-fg accept="image/*,video/*"><input type="file" hidden data-fc accept="image/*,video/*" capture="environment">`;
  document.body.append(root); document.body.classList.add('sx-lock'); requestAnimationFrame(() => root.classList.add('in'));
  const q = (s) => root.querySelector(s);
  const frame = q('[data-cframe]'); const txt = q('[data-ctxt]'); const mainEl = q('[data-cmain]'); const tray = q('[data-tray]'); const layersEl = q('[data-clayers]');
  const unwatch = watchWidth(frame);
  const metaOf = () => ({
    b: C.mode === 'text' ? C.bg : 0, f: C.font, a: C.align, s: C.ts, l: C.mode === 'text' ? 0 : C.flt, y: C.layers,
    q: C.mode === 'media' && (C.zoom.scale !== 1 || C.zoom.x !== 0 || C.zoom.y !== 0 || C.zoom.rotation !== 0)
      ? [C.zoom.scale, C.zoom.x, C.zoom.y, C.zoom.rotation] : null,
  });
  const textLen = () => (C.mode === 'text' ? C.text.length : C.cap.length);
  const room = () => MAX_TOTAL - pack(metaOf(), '').length;
  const paintMediaTransform = () => {
    const media = q('[data-cmedia] .sx-media');
    if (!media) return;
    media.style.transform = `translate(${C.zoom.x * 100}%,${C.zoom.y * 100}%) scale(${C.zoom.scale}) rotate(${C.zoom.rotation}deg)`;
  };
  const updateZoom = (change) => {
    C.zoom = { ...C.zoom, ...change };
    C.zoom.scale = clamp(C.zoom.scale, .5, 4);
    C.zoom.x = clamp(C.zoom.x, -.8, .8);
    C.zoom.y = clamp(C.zoom.y, -.8, .8);
    C.zoom.rotation = ((C.zoom.rotation % 360) + 360) % 360;
    paintMediaTransform();
    paintFrame();
  };

  const paintFrame = () => {
    root.classList.toggle('is-text', C.mode === 'text');
    root.classList.toggle('is-media', C.mode === 'media');
    frame.classList.toggle('sx-shift', C.mode === 'text'); frame.style.background = C.mode === 'text' ? BGS[C.bg].c : '#000'; frame.style.backgroundSize = C.mode === 'text' && BGS[C.bg].c.startsWith('linear') ? '240% 240%' : '';
    const bg = BGS[C.bg] || BGS[0]; const f = FONTS[C.font];
    const media = q('[data-cmedia]');
    if (C.mode === 'text') { media.innerHTML = '<i class="sx-orb o1"></i><i class="sx-orb o2"></i>'; }
    else media.innerHTML = C.kind === 'video'
      ? `<video class="sx-media" src="${C.url}" style="filter:${FILTERS[C.flt][1] || 'none'};transform:translate(${C.zoom.x * 100}%,${C.zoom.y * 100}%) scale(${C.zoom.scale}) rotate(${C.zoom.rotation}deg)" muted loop autoplay playsinline></video>`
      : `<img class="sx-media" src="${C.url}" style="filter:${FILTERS[C.flt][1] || 'none'};transform:translate(${C.zoom.x * 100}%,${C.zoom.y * 100}%) scale(${C.zoom.scale}) rotate(${C.zoom.rotation}deg)" alt="">`;
    mainEl.hidden = C.mode !== 'text';
    mainEl.className = `sx-main sx-ts-${C.ts}`;
    mainEl.style.cssText = `--tc:${bg.light ? '#111' : '#fff'};--ti:${bg.light ? '#fff' : '#111'};--k:${fitK(C.text.length)};font-family:${f.f};font-weight:${f.w};text-align:${['center', 'left', 'right'][C.align]};${f.up ? 'text-transform:uppercase;' : ''}`;
    q('[data-cap]').hidden = C.mode === 'text';
    root.querySelectorAll('.only-text').forEach((b) => { b.hidden = C.mode !== 'text'; });
    root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', C.mode === 'text'));
    const left = room() - textLen(); const cnt = q('[data-count]');
    cnt.textContent = left < 80 ? `Осталось символов: ${left}` : ''; cnt.classList.toggle('bad', left < 0);
  };
  const paintLayers = () => { layersEl.innerHTML = C.layers.map((l, i) => layerHTML(l, i, true)).join(''); };
  const paintTray = () => {
    if (C.mode === 'media' && C.tool === 'font') C.tool = 'bg';
    if (C.tool === 'bg' && C.mode === 'text') tray.innerHTML = `<div class="sx-sw">${BGS.map((b, i) => `<button class="${i === C.bg ? 'on' : ''}" data-bg="${i}" aria-label="Фон ${i + 1}" style="background:${b.c}"></button>`).join('')}</div>`;
    else if (C.tool === 'bg') tray.innerHTML = `<div class="sx-flt">${FILTERS.map((f, i) => `<button class="${i === C.flt ? 'on' : ''}" data-flt="${i}"><span style="${C.kind === 'image' ? `background-image:url(${C.url});` : 'background:linear-gradient(135deg,#7c5cff,#ff6ec7);'}filter:${f[1] || 'none'}"></span>${f[0]}</button>`).join('')}</div>`;
    else if (C.tool === 'font') tray.innerHTML = `<div class="sx-fonts">${FONTS.map((f, i) => `<button class="${i === C.font ? 'on' : ''}" data-font="${i}" style="font-family:${f.f};font-weight:${f.w}">${f.n}</button>`).join('')}</div>`;
    else tray.innerHTML = '';
    root.querySelectorAll('[data-rail]').forEach((b) => b.classList.toggle('on', b.dataset.rail === C.tool));
  };
  const repaint = () => { paintFrame(); paintLayers(); paintTray(); };
  repaint();

  /* текст */
  txt.addEventListener('input', () => { C.text = txt.innerText.replace(/\n{3,}/g, '\n\n').replace(/\u00a0/g, ' '); if (C.text === '\n') { C.text = ''; txt.textContent = ''; } paintFrame(); });
  txt.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain')); });
  q('[data-cap]').addEventListener('input', (e) => { C.cap = e.target.value; paintFrame(); });
  setTimeout(() => txt.focus(), 380);

  const addLayer = (l) => {
    C.layers.push(l);
    if (room() - textLen() < 0) { C.layers.pop(); toast('Слишком много элементов — уберите что-нибудь', { type: 'info' }); return false; }
    paintLayers(); paintFrame(); haptic(10); return true;
  };

  const openTextSheet = (idx) => {
    const L = idx == null ? ['t', '', .5, .42, 1, 0, 0, C.font, 0] : C.layers[idx]; const draft = { v: L[1], c: L[6], f: L[7], st: L[8] };
    sheet(root, `<h3>${idx == null ? 'Новый текст' : 'Текст'}</h3><textarea class="sx-ta" data-ta maxlength="120" placeholder="Что написать?">${E(draft.v)}</textarea>
      <div class="sx-colors">${COLORS.map((c, i) => `<button class="${i === draft.c ? 'on' : ''}" data-c="${i}" style="background:${c[0]}"></button>`).join('')}</div>
      <div class="sx-fonts">${FONTS.map((f, i) => `<button class="${i === draft.f ? 'on' : ''}" data-f="${i}" style="font-family:${f.f};font-weight:${f.w}">${f.n}</button>`).join('')}</div>
      <div class="sx-sheet-row"><button class="sx-chip" data-st>Стиль: ${TS_NAMES[draft.st]}</button><button class="sx-primary" data-ok>Готово</button></div>${idx != null ? '<button class="sx-link" data-rm>Удалить текст</button>' : ''}`, (w, shut) => {
      const ta = w.querySelector('[data-ta]'); setTimeout(() => ta.focus(), 320);
      w.addEventListener('click', (e) => {
        const c = e.target.closest('[data-c]'); const f = e.target.closest('[data-f]');
        if (c) { draft.c = +c.dataset.c; w.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b === c)); }
        if (f) { draft.f = +f.dataset.f; w.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b === f)); }
        if (e.target.closest('[data-st]')) { draft.st = (draft.st + 1) % 4; e.target.closest('[data-st]').textContent = `Стиль: ${TS_NAMES[draft.st]}`; }
        if (e.target.closest('[data-rm]')) { C.layers.splice(idx, 1); paintLayers(); paintFrame(); shut(); }
        if (e.target.closest('[data-ok]')) {
          const v = ta.value.trim();
          if (!v) { if (idx != null) C.layers.splice(idx, 1); paintLayers(); paintFrame(); shut(); return; }
          if (idx == null) { if (addLayer(['t', v, .5, .42, 1, 0, draft.c, draft.f, draft.st])) shut(); } else { Object.assign(L, [L[0], v, L[2], L[3], L[4], L[5], draft.c, draft.f, draft.st]); paintLayers(); paintFrame(); shut(); }
        }
      });
    });
  };

  const openStickers = () => {
    const premium = !!state.user?.isPremium; let tab = 'e';
    const now = new Date(); const pills = [now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }), 'Привет!', '🔥 Огонь', '#мойдень', 'Скоро…', 'Люблю ❤️', 'Новый день', 'Ночной режим 🌙', 'Лето ☀️', 'На связи', 'Вайб ✨'];
    sheet(root, '<div class="sx-tabs"><button class="on" data-tab="e">Эмодзи</button><button data-tab="c">Premium</button><button data-tab="p">Надписи</button></div><div class="sx-st-body" data-body></div>', (w, shut) => {
      const body = w.querySelector('[data-body]');
      const draw = () => {
        w.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
        if (tab === 'e') body.innerHTML = `<div class="sx-grid">${EMOJIS.map((e) => `<button data-e="${E(e)}">${e}</button>`).join('')}</div>`;
        else if (tab === 'p') body.innerHTML = `<div class="sx-pills">${pills.map((p) => `<button data-p="${E(p)}"><span class="sx-pill">${E(p)}</span></button>`).join('')}</div>`;
        else body.innerHTML = EMOJI_PACKS.map((pk) => `<h4>${E(pk.title)}${premium ? '' : ' 🔒'}</h4><div class="sx-grid c ${premium ? '' : 'lock'}">${pk.items.map((it) => `<button data-c="${it.id}"><img src="${customEmojiURL(it)}" alt="" draggable="false"></button>`).join('')}</div>`).join('') + (premium ? '' : '<button class="sx-primary" data-buy>Открыть с Premium</button>');
      };
      draw();
      w.addEventListener('click', (e) => {
        const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; draw(); return; }
        const em = e.target.closest('[data-e]'); if (em) { if (addLayer(['e', em.dataset.e, .5, .45, 1, 0])) shut(); return; }
        const pl = e.target.closest('[data-p]'); if (pl) { if (addLayer(['p', pl.dataset.p, .5, .5, 1, 0])) shut(); return; }
        const cu = e.target.closest('[data-c]'); if (cu) { if (!premium) { haptic(20); toast('Эти стикеры открываются с Premium', { type: 'info' }); return; } if (addLayer(['c', cu.dataset.c, .5, .45, 1.2, 0])) shut(); return; }
        if (e.target.closest('[data-buy]')) { shut(); bus.emit('commerce:open', 'premium'); }
      });
    });
  };

  /* жесты над слоями: перетаскивание, щипок (масштаб+поворот), корзина */
  const trash = q('[data-ctrash]'); let g = null;
  const gesturePoints = new Map();
  let mediaGesture = null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]); const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  const mid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const rebase = () => { const pts = [...g.pts.values()]; g.base = [...C.layers[g.i]]; g.m0 = mid(pts); g.d0 = pts.length > 1 ? dist(pts[0], pts[1]) : 0; g.a0 = pts.length > 1 ? ang(pts[0], pts[1]) : 0; };
  const rebaseMedia = () => {
    const points = [...gesturePoints.values()];
    if (!points.length) { mediaGesture = null; return; }
    const bounds = frame.getBoundingClientRect();
    mediaGesture = {
      base: { ...C.zoom },
      center: mid(points),
      distance: points.length > 1 ? dist(points[0], points[1]) : 0,
      angle: points.length > 1 ? ang(points[0], points[1]) : 0,
      width: bounds.width,
      height: bounds.height,
    };
  };
  const mediaHost = q('[data-cmedia]');
  mediaHost.addEventListener('pointerdown', (event) => {
    const media = event.target.closest('.sx-media');
    if (!media || gesturePoints.size >= 2) return;
    event.preventDefault();
    try { media.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    gesturePoints.set(event.pointerId, [event.clientX, event.clientY]);
    rebaseMedia();
  });
  mediaHost.addEventListener('pointermove', (event) => {
    if (!gesturePoints.has(event.pointerId) || !mediaGesture) return;
    event.preventDefault();
    gesturePoints.set(event.pointerId, [event.clientX, event.clientY]);
    const points = [...gesturePoints.values()];
    const center = mid(points);
    const change = {
      x: mediaGesture.base.x + (center[0] - mediaGesture.center[0]) / mediaGesture.width,
      y: mediaGesture.base.y + (center[1] - mediaGesture.center[1]) / mediaGesture.height,
      scale: mediaGesture.base.scale,
      rotation: mediaGesture.base.rotation,
    };
    if (points.length > 1 && mediaGesture.distance > 0) {
      change.scale *= dist(points[0], points[1]) / mediaGesture.distance;
      change.rotation += ang(points[0], points[1]) - mediaGesture.angle;
    }
    C.zoom = change;
    C.zoom.scale = clamp(C.zoom.scale, .5, 4);
    C.zoom.x = clamp(C.zoom.x, -.8, .8);
    C.zoom.y = clamp(C.zoom.y, -.8, .8);
    paintMediaTransform();
  });
  const endMediaGesture = (event) => {
    if (!gesturePoints.delete(event.pointerId)) return;
    rebaseMedia();
  };
  mediaHost.addEventListener('pointerup', endMediaGesture);
  mediaHost.addEventListener('pointercancel', endMediaGesture);
  layersEl.addEventListener('pointerdown', (e) => {
    const n = e.target.closest('[data-li]'); if (!n) return; e.preventDefault();
    const i = +n.dataset.li; if (!g || g.i !== i) g = { i, el: n, pts: new Map(), moved: false };
    try { n.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    g.pts.set(e.pointerId, [e.clientX, e.clientY]); rebase(); frame.classList.add('dragging');
  });
  layersEl.addEventListener('pointermove', (e) => {
    if (!g || !g.pts.has(e.pointerId)) return;
    g.pts.set(e.pointerId, [e.clientX, e.clientY]); const pts = [...g.pts.values()]; const r = frame.getBoundingClientRect(); const m = mid(pts); const L = C.layers[g.i];
    if (Math.hypot(m[0] - g.m0[0], m[1] - g.m0[1]) > 5 || pts.length > 1) g.moved = true;
    L[2] = clamp(g.base[2] + (m[0] - g.m0[0]) / r.width, .02, .98); L[3] = clamp(g.base[3] + (m[1] - g.m0[1]) / r.height, .02, .98);
    if (pts.length > 1 && g.d0) { L[4] = clamp(g.base[4] * dist(pts[0], pts[1]) / g.d0, .4, 5); L[5] = Math.round(g.base[5] + ang(pts[0], pts[1]) - g.a0); }
    g.el.style.left = `${L[2] * 100}%`; g.el.style.top = `${L[3] * 100}%`; g.el.style.setProperty('--s', L[4]); g.el.style.setProperty('--r', `${L[5]}deg`);
    const hot = m[1] > r.bottom - r.height * .13; if (hot && !trash.classList.contains('hot')) haptic(12); trash.classList.toggle('hot', hot);
  });
  const endG = (e) => {
    if (!g || !g.pts.has(e.pointerId)) return; const hot = trash.classList.contains('hot'); g.pts.delete(e.pointerId);
    if (g.pts.size) { rebase(); return; }
    const { i, moved } = g; g = null; frame.classList.remove('dragging'); trash.classList.remove('hot');
    if (hot) { C.layers.splice(i, 1); paintLayers(); paintFrame(); return; }
    if (!moved && C.layers[i]?.[0] === 't') openTextSheet(i);
  };
  layersEl.addEventListener('pointerup', endG); layersEl.addEventListener('pointercancel', endG);

  /* выбор медиа */
  const setMedia = (file) => {
    if (!file) return; const kind = file.type.startsWith('video') ? 'video' : file.type.startsWith('image') ? 'image' : '';
    if (!kind) { toast('Выберите фото или видео', { type: 'error' }); return; }
    if (C.url) URL.revokeObjectURL(C.url);
    Object.assign(C, { mode: 'media', file, kind, url: URL.createObjectURL(file), flt: 0, tool: 'bg', zoom: { scale: 1, x: 0, y: 0, rotation: 0 } }); repaint();
  };
  q('[data-fg]').addEventListener('change', (e) => { setMedia(e.target.files?.[0]); e.target.value = ''; });
  q('[data-fc]').addEventListener('change', (e) => { setMedia(e.target.files?.[0]); e.target.value = ''; });

  const close = () => { unwatch(); if (C.url) URL.revokeObjectURL(C.url); document.body.classList.remove('sx-lock'); root.classList.remove('in'); setTimeout(() => root.remove(), 280); };
  const publish = async () => {
    if (C.busy) return;
    const caption = (C.mode === 'text' ? C.text : C.cap).trim();
    if (C.mode === 'text' && !caption) { toast('Напишите текст истории', { type: 'info' }); txt.focus(); return; }
    if (C.mode === 'media' && !C.file) { toast('Выберите фото или видео', { type: 'info' }); return; }
    const text = pack(metaOf(), caption);
    if (text.length > MAX_TOTAL) { toast('Слишком длинно: сократите текст или уберите стикеры', { type: 'error' }); return; }
    C.busy = true; root.classList.add('busy');
    try {
      const payload = { type: C.mode === 'text' ? 'text' : C.kind, text };
      if (C.mode === 'media') { const file = await prepareFile(C.file, C.kind); const up = await api.upload(file, { kind: C.kind }); payload.mediaId = up.media.id; }
      await Api.createStory(payload); haptic(18); close(); await refresh(); toast('История опубликована на 24 часа', { type: 'success' });
    } catch (e) { toastError(e); } finally { C.busy = false; root.classList.remove('busy'); }
  };

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-cclose]')) { close(); return; }
    if (t.closest('[data-publish]')) { publish(); return; }
    const mediaAction = t.closest('[data-media-action]');
    if (mediaAction) {
      if (mediaAction.dataset.mediaAction === 'zoom-in') updateZoom({ scale: C.zoom.scale + .25 });
      else if (mediaAction.dataset.mediaAction === 'zoom-out') updateZoom({ scale: C.zoom.scale - .25 });
      else if (mediaAction.dataset.mediaAction === 'rotate') updateZoom({ rotation: C.zoom.rotation + 90 });
      else if (mediaAction.dataset.mediaAction === 'reset') updateZoom({ scale: 1, x: 0, y: 0, rotation: 0 });
      return;
    }
    const rail = t.closest('[data-rail]');
    if (rail) {
      const k = rail.dataset.rail;
      if (k === 'text') openTextSheet(); else if (k === 'sticker') openStickers();
      else if (k === 'align') { C.align = (C.align + 1) % 3; paintFrame(); }
      else if (k === 'ts') { C.ts = (C.ts + 1) % 4; paintFrame(); toast(`Стиль: ${TS_NAMES[C.ts]}`, { type: 'info' }); }
      else { C.tool = C.tool === k ? '' : k; paintTray(); }
      haptic(6); return;
    }
    const bg = t.closest('[data-bg]'); if (bg) { C.bg = +bg.dataset.bg; paintFrame(); paintTray(); haptic(6); return; }
    const fl = t.closest('[data-flt]'); if (fl) { C.flt = +fl.dataset.flt; paintFrame(); paintTray(); return; }
    const fo = t.closest('[data-font]'); if (fo) { C.font = +fo.dataset.font; paintFrame(); paintTray(); return; }
    if (t.closest('[data-mode]')) { C.mode = 'text'; C.tool = 'bg'; repaint(); setTimeout(() => txt.focus(), 50); return; }
    const pick = t.closest('[data-pick]'); if (pick) q(pick.dataset.pick === 'g' ? '[data-fg]' : '[data-fc]').click();
  });
}
