/**
 * Премиум-эмодзи (как в Telegram): вкладка с паками в пикере, поиск, коллекция,
 * вставка в текст кодом :code:, показ эмодзи в сообщениях и «эмодзи рядом с именем».
 *
 * Подключение: в app.js добавить
 *   import './emoji-packs.js?v=20261030-emoji-inline-2';
 * Работает через наблюдение за DOM (как chat-manage.js), остальной код не меняет.
 * Серверная проверка Premium обязательна отдельно — клиенту доверять нельзя.
 */
import { state, bus } from './store.js';
import { store9 } from './util.js';
import { Api } from './api.js?v=20261102-gifts-2';
import {
  EMOJI_PACKS, customEmojiByCode, customEmojiById, customEmojiURL, searchEmojiPacks,
} from './premium.js?v=20261031-verified-badge-1';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const isPremium = () => !!state.user?.isPremium;

/* ── Коллекция (локально, отдельно для каждого аккаунта) ─────────────────── */
let collection = null;
let collectionOwner = null;
const colKey = () => `aurora.emoji.collection.${state.user?.id ?? 'guest'}`;
function col() {
  if (collection === null || collectionOwner !== state.user?.id) {
    try { const v = JSON.parse(store9.get(colKey(), '[]')); collection = new Set(Array.isArray(v) ? v : []); } catch (error) {
      console.error('Unable to load emoji collection:', error);
      collection = new Set();
    }
    collectionOwner = state.user?.id;
  }
  return collection;
}
const saveCollection = () => store9.set(colKey(), JSON.stringify([...col()]));

function upsell() {
  location.hash = '#/commerce';
}

/* ── Эмодзи рядом с именем ───────────────────────────────────────────────── */
async function setNameEmoji(id) {
  if (!isPremium()) return upsell();
  const prev = state.user.premiumEmoji || null;
  state.user.premiumEmoji = id || null;
  bus.emit('chats', state.chats);
  bus.emit('profile:changed', state.user);
  paintAll();
  try {
    await Api.updateProfile({ premiumEmoji: id || null });
  } catch (err) {
    state.user.premiumEmoji = prev;
    bus.emit('chats', state.chats);
    bus.emit('profile:changed', state.user);
    paintAll();
    console.error('Unable to save premium name emoji:', err);
  }
}

/* ── Разметка ────────────────────────────────────────────────────────────── */
const tileImg = (item) => `<img class="premium-emoji" src="${customEmojiURL(item)}" alt="${esc(item.label)}" loading="lazy" draggable="false">`;

function tile(item, mode) {
  if (!isPremium()) return `<button type="button" class="pk-tile locked" data-pk-locked title="${esc(item.label)}">${tileImg(item)}</button>`;
  if (mode === 'name') {
    const on = state.user.premiumEmoji === item.id;
    return `<button type="button" class="pk-tile ${on ? 'on' : ''}" data-pk-name="${item.id}" title="${esc(item.label)}" aria-pressed="${on}">${tileImg(item)}</button>`;
  }
  return `<button type="button" class="pk-tile" data-emoji=":${item.code}:" title="${esc(item.label)} · :${item.code}:">${tileImg(item)}</button>`;
}

function packCard(pack, ctx) {
  const added = col().has(pack.id);
  const open = ctx.q.trim() ? true : ctx.open === pack.id;
  return `<section class="pk-pack ${open ? 'open' : ''}" data-pack="${pack.id}">
    <div class="pk-pack-head" data-pk-toggle="${pack.id}" role="button" tabindex="0" aria-expanded="${open}">
      <span class="pk-cover">${pack.items.slice(0, 3).map((i) => `<img src="${customEmojiURL(i)}" alt="" draggable="false">`).join('')}</span>
      <span class="pk-meta"><b>${esc(pack.title)}</b><small>${pack.items.length} эмодзи</small></span>
      <button type="button" class="pk-add ${added ? 'added' : ''}" data-pk-add="${pack.id}">${added ? 'В коллекции' : 'Добавить'}</button>
    </div>
    ${open ? `<div class="pk-grid">${pack.items.map((i) => tile(i, ctx.mode)).join('')}</div>` : ''}
  </section>`;
}

function bodyHTML(ctx) {
  const q = ctx.q.trim();
  let out = '';
  if (ctx.mode === 'name') {
    out += `<div class="pk-banner"><span>Выберите эмодзи рядом с именем</span>
      <span class="pk-banner-act"><button type="button" data-pk-name-clear>Убрать</button><button type="button" data-pk-mode="insert">Готово</button></span></div>`;
  }
  if (!q) {
    const mine = EMOJI_PACKS.filter((p) => col().has(p.id));
    if (mine.length) {
      out += '<h5 class="pk-title">Моя коллекция</h5>';
      out += mine.map((p) => `<div class="pk-mine"><div class="pk-mine-name">${esc(p.title)}</div><div class="pk-grid">${p.items.map((i) => tile(i, ctx.mode)).join('')}</div></div>`).join('');
    }
    out += `<h5 class="pk-title">${mine.length ? 'Все наборы' : 'Наборы эмодзи'}</h5>`;
    out += EMOJI_PACKS.map((p) => packCard(p, ctx)).join('');
    if (isPremium() && ctx.mode !== 'name') {
      out += '<button type="button" class="pk-name-btn" data-pk-mode="name"><span>✦</span> Эмодзи рядом с именем</button>';
    }
  } else {
    const { packs, items } = searchEmojiPacks(q);
    if (!packs.length && !items.length) {
      out += '<div class="pk-empty">Ничего не найдено<small>Попробуйте «яблоко» или «аврора»</small></div>';
    } else {
      if (items.length) out += `<h5 class="pk-title">Эмодзи</h5><div class="pk-grid">${items.map((i) => tile(i, ctx.mode)).join('')}</div>`;
      if (packs.length) out += `<h5 class="pk-title">Наборы</h5>${packs.map((p) => packCard(p, ctx)).join('')}`;
    }
  }
  return out;
}

const LOCK_HTML = `<div class="pk-lock"><b>Premium</b><span>Наборы эмодзи, значки у имени и реакции — только для Premium</span>
  <button type="button" data-pk-upsell>Подключить</button></div>`;
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.4"/><path d="m16 16 4.2 4.2"/></svg>';

/* ── Вкладка в пикере ────────────────────────────────────────────────────── */
const painters = new Set();
function paintAll() { painters.forEach((fn) => fn()); }

function enhancePicker(picker) {
  if (picker.dataset.pk) return;
  const tabs = picker.querySelector('[data-tabs]');
  const scroll = picker.querySelector('[data-scroll]');
  if (!tabs || !scroll) return;
  picker.dataset.pk = '1';

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'picker-tab pk-tab';
  tab.dataset.tab = 'packs';
  tab.title = 'Премиум-эмодзи';
  tab.innerHTML = `<img class="pk-tab-ic" src="${customEmojiURL(EMOJI_PACKS[0].items[0])}" alt="" draggable="false">`;
  const stickersTab = tabs.querySelector('[data-tab="stickers"]');
  if (stickersTab) tabs.insertBefore(tab, stickersTab); else tabs.append(tab);

  const group = document.createElement('div');
  group.dataset.group = 'packs';
  group.className = 'hidden pk';
  group.innerHTML = `<label class="pk-search">${SEARCH_ICON}<input type="search" placeholder="Поиск наборов и эмодзи" autocomplete="off" enterkeyhint="search" aria-label="Поиск наборов эмодзи"></label>
    <div class="pk-lockhost"></div><div class="pk-body"></div>`;
  scroll.append(group);

  const ctx = { q: '', open: null, mode: 'insert' };
  const body = group.querySelector('.pk-body');
  const lock = group.querySelector('.pk-lockhost');
  const input = group.querySelector('input');
  const paint = () => {
    if (!picker.isConnected) { painters.delete(paint); return; }
    lock.innerHTML = isPremium() ? '' : LOCK_HTML;
    body.innerHTML = bodyHTML(ctx);
  };
  painters.add(paint);
  paint();

  input.addEventListener('input', () => { ctx.q = input.value; paint(); });
  group.addEventListener('keydown', (e) => {
    const head = e.target.closest?.('[data-pk-toggle]');
    if (head && e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); head.click(); }
  });
  group.addEventListener('click', (e) => {
    if (e.target.closest('[data-pk-upsell]') || e.target.closest('[data-pk-locked]')) return upsell();
    const add = e.target.closest('[data-pk-add]');
    if (add) {
      if (!isPremium()) return upsell();
      const id = add.dataset.pkAdd;
      if (col().has(id)) col().delete(id); else col().add(id);
      saveCollection();
      return paint();
    }
    const head = e.target.closest('[data-pk-toggle]');
    if (head) { ctx.open = ctx.open === head.dataset.pkToggle ? null : head.dataset.pkToggle; return paint(); }
    const mode = e.target.closest('[data-pk-mode]');
    if (mode) { ctx.mode = mode.dataset.pkMode; return paint(); }
    const name = e.target.closest('[data-pk-name]');
    if (name) return setNameEmoji(name.dataset.pkName);
    if (e.target.closest('[data-pk-name-clear]')) return setNameEmoji(null);
  });
}

/* ── Карточка «Эмодзи рядом с именем» на экране Premium ──────────────────── */
function enhancePremiumPage(pm) {
  if (pm.dataset.pkName) return;
  pm.dataset.pkName = '1';
  const sec = document.createElement('section');
  sec.className = 'pm-sec pk-name-sec';
  const hero = pm.querySelector('.pm-hero');
  if (hero) hero.after(sec); else pm.prepend(sec);
  const paint = () => {
    if (!sec.isConnected) { painters.delete(paint); return; }
    const own = state.user?.premiumEmoji ? customEmojiById.get(state.user.premiumEmoji) : null;
    sec.innerHTML = `<h3>Эмодзи рядом с именем</h3>
      <div class="pm-card ${isPremium() ? '' : 'locked'}">
        ${isPremium() ? '' : '<div class="pm-lock">Нужен Premium</div>'}
        <div class="pm-preview">${esc(state.user?.name || 'Вы')}${own ? `<span class="pbadge pemoji">${tileImg(own)}</span>` : ''}</div>
        ${EMOJI_PACKS.map((p) => `<div class="pk-mine"><div class="pk-mine-name">${esc(p.title)}</div><div class="pk-grid">${p.items.map((i) => tile(i, 'name')).join('')}</div></div>`).join('')}
        <button type="button" class="btn pk-clear" data-pk-name-clear ${own ? '' : 'disabled'}>Убрать эмодзи</button>
      </div>`;
  };
  painters.add(paint);
  paint();
  sec.addEventListener('click', (e) => {
    if (e.target.closest('[data-pk-locked]')) return upsell();
    const name = e.target.closest('[data-pk-name]');
    if (name) return setNameEmoji(name.dataset.pkName);
    if (e.target.closest('[data-pk-name-clear]')) return setNameEmoji(null);
  });
}

/* ── Эмодзи в тексте сообщений: :code: → картинка ────────────────────────── */
const TOKEN = /:([a-z0-9-]{3,32}):/gi;
const SKIP = 'textarea, input, script, style, code, pre, [contenteditable="true"], .pk-input-overlay';

function emojiNode(item) {
  const img = document.createElement('img');
  img.className = 'premium-emoji ce';
  img.src = customEmojiURL(item);
  img.alt = `:${item.code}:`;
  img.title = item.label;
  img.draggable = false;
  img.decoding = 'async';
  return img;
}

function processTextNode(node) {
  const text = node.nodeValue;
  if (!text || text.indexOf(':') === -1) return null;
  TOKEN.lastIndex = 0;
  let last = 0; let found = false; let m;
  const frag = document.createDocumentFragment();
  while ((m = TOKEN.exec(text))) {
    const item = customEmojiByCode(m[1]);
    if (!item) { TOKEN.lastIndex = m.index + 1; continue; }
    found = true;
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(emojiNode(item));
    last = m.index + m[0].length;
  }
  if (!found) return null;
  if (last < text.length) frag.append(text.slice(last));
  node.replaceWith(frag);
  return true;
}

function markJumbo(el) {
  if (!el?.matches?.('.bubble-text, .cs-text')) return;
  const imgs = el.querySelectorAll('img.ce');
  const onlyEmoji = imgs.length > 0 && imgs.length <= 3 && el.textContent.trim() === '';
  el.classList.toggle('ce-jumbo', onlyEmoji);
  el.closest('.bubble, .cs-bubble')?.classList.toggle('ce-only', onlyEmoji);
}

function processTree(root) {
  if (!root || !root.isConnected) return;
  const host = root.nodeType === 3 ? root.parentElement : root;
  if (!host || host.closest?.(SKIP)) return;
  const walker = document.createTreeWalker(root.nodeType === 3 ? host : root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.includes(':') && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const touched = new Set();
  for (const n of nodes) {
    const parent = n.parentElement;
    if (processTextNode(n)) touched.add(parent);
  }
  touched.forEach(markJumbo);
}

/* ── Отображение эмодзи прямо в поле ввода ───────────────────────────────── */
function inputEmojiHTML(text) {
  let found = false;
  const html = esc(text).replace(TOKEN, (whole, code) => {
    const item = customEmojiByCode(code);
    if (!item) return whole;
    found = true;
    return `<span class="pk-input-token">${whole}<img src="${customEmojiURL(item)}" alt="${esc(item.label)}" draggable="false"></span>`;
  });
  return found ? html : null;
}
function refreshPreview(ta) {
  const wrap = ta?.closest?.('.composer-input-wrap');
  if (!wrap) return;
  const overlay = wrap.querySelector('.pk-input-overlay');
  if (!overlay) return;
  const html = inputEmojiHTML(ta.value);
  ta.classList.toggle('has-custom-emoji', html !== null);
  overlay.innerHTML = html || '';
  const style = getComputedStyle(ta);
  overlay.style.font = style.font;
  overlay.style.lineHeight = style.lineHeight;
  overlay.style.letterSpacing = style.letterSpacing;
  overlay.style.padding = style.padding;
  overlay.style.textIndent = style.textIndent;
  overlay.scrollTop = ta.scrollTop;
  overlay.scrollLeft = ta.scrollLeft;
}
document.addEventListener('input', (e) => { if (e.target?.matches?.('[data-input]')) refreshPreview(e.target); });
document.addEventListener('keyup', (e) => { if (e.target?.matches?.('[data-input]')) refreshPreview(e.target); });
document.addEventListener('scroll', (e) => { if (e.target?.matches?.('[data-input]')) refreshPreview(e.target); }, true);
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.composer-wrap')) return;
  setTimeout(() => refreshPreview(document.querySelector('[data-input]')), 120);
});

/* ── Наблюдатель ─────────────────────────────────────────────────────────── */
const pending = new Set();
let queued = false;
function flush() {
  queued = false;
  const batch = [...pending];
  pending.clear();
  batch.forEach(processTree);
  for (const node of batch) {
    if (node.matches?.('.composer-input[data-input]')) refreshPreview(node);
    node.querySelectorAll?.('.composer-input[data-input]').forEach(refreshPreview);
  }
  document.querySelectorAll('.picker[data-picker]:not([data-pk])').forEach(enhancePicker);
  document.querySelectorAll('.pm:not([data-pk-name])').forEach(enhancePremiumPage);
}
new MutationObserver((records) => {
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType === 1 || node.nodeType === 3) pending.add(node);
    }
  }
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
}).observe(document.documentElement, { childList: true, subtree: true });

if (document.body) { pending.add(document.body); flush(); }
