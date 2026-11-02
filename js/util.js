/** Общие утилиты фронтенда: DOM, форматирование, время, безопасный ввод. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];


/**
 * Строка, помеченная как «уже безопасный HTML». Наследует String, поэтому ведёт себя
 * как обычная строка во всех операциях, но сохраняет маркер безопасности и при
 * вложении шаблонов, и при передаче массивами.
 */
export class SafeHTML extends String {
  constructor(value) { super(String(value ?? '')); this.__raw = true; }
  get value() { return this.toString(); }
}

/**
 * Безопасная вставка строк в HTML (весь пользовательский контент проходит через escape).
 * Возвращает SafeHTML, поэтому повторного экранирования при подстановке в html`…` не
 * происходит: URL с «&» и текст с кавычками не портятся.
 */
export function esc(s) {
  if (s instanceof SafeHTML) return s;
  return new SafeHTML(String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
}

/** Разметка с автоэкранированием: html`<b>${name}</b>` — подстановки безопасны. */
export function html(strings, ...values) {
  return new SafeHTML(strings.reduce((acc, str, i) => acc + str + (i < values.length ? valueToHtml(values[i]) : ''), ''));
}
function valueToHtml(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(valueToHtml).join('');
  if (v && typeof v === 'object' && v.__raw) return v.value;
  return esc(v);
}
/** Пометить строку как «уже безопасный HTML» (используется для вложенных шаблонов). */
export const raw = (value) => (value instanceof SafeHTML ? value : new SafeHTML(value));

export function formatRichText(value, mentions = new Set()) {
  const inlinePattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+|www\.[^\s<>]+)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|(^|[\s(])@([a-z0-9_]{4,24})\b/gi;
  const renderInline = (line) => {
    let output = '';
    let last = 0;
    for (const match of line.matchAll(inlinePattern)) {
      const [token, linkLabel, markdownUrl, plainUrl, boldA, boldB, strike, italicA, italicB, code, mentionPrefix, username] = match;
      output += esc(line.slice(last, match.index));
      if (markdownUrl) {
        output += `<a href="${esc(markdownUrl)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel)}</a>`;
      } else if (plainUrl) {
        let url = plainUrl;
        let trailing = '';
        while (/[.,!?;:]$/.test(url)) {
          trailing = url.slice(-1) + trailing;
          url = url.slice(0, -1);
        }
        const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
        output += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(trailing)}`;
      } else if (boldA || boldB) {
        output += `<strong>${esc(boldA || boldB)}</strong>`;
      } else if (strike) {
        output += `<del>${esc(strike)}</del>`;
      } else if (italicA || italicB) {
        output += `<em>${esc(italicA || italicB)}</em>`;
      } else if (code) {
        output += `<code>${esc(code)}</code>`;
      } else if (username && mentions.has(username.toLowerCase())) {
        output += `${esc(mentionPrefix)}<span class="mention" data-mention="@${esc(username)}">@${esc(username)}</span>`;
      } else {
        output += esc(token);
      }
      last = match.index + token.length;
    }
    return output + esc(line.slice(last));
  };
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const quote = line.match(/^>\s?(.*)$/);
    return quote ? `<blockquote class="msg-quote">${renderInline(quote[1])}</blockquote>` : renderInline(line);
  }).join('<br>');
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    if (c instanceof SafeHTML) {
      node.insertAdjacentHTML('beforeend', c.value);
    } else {
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}

export const debounce = (fn, ms = 250) => {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
};

export const throttle = (fn, ms = 100) => {
  let last = 0; let timer;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
  };
};

export const raf = (fn) => requestAnimationFrame(fn);
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function rAFBatch(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; fn(...args); });
  };
}

/* ── Форматирование ─────────────────────────────────────────────────────── */

const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const pad2 = (n) => String(n).padStart(2, '0');

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtTime(ts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'вчера';
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return DAYS[d.getDay()].slice(0, 2);
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function fmtDayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Вчера';
  const diff = Math.floor((now - d) / 86400000);
  if (diff < 7) return DAYS[d.getDay()][0].toUpperCase() + DAYS[d.getDay()].slice(1);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}

export function fmtFullDate(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

export function fmtLastSeen(ts, presence) {
  if (presence === 'online') return 'в сети';
  if (!ts) return 'был(а) недавно';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'был(а) только что';
  const d = new Date(ts);
  if (diff < 86400000) return `был(а) в ${fmtTime(ts)}`;
  if (diff < 172800000) return `был(а) вчера в ${fmtTime(ts)}`;
  return `был(а) ${fmtFullDate(ts)}`;
}

export function plural(n, one, few, many) {
  const mod10 = n % 10; const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0]?.toUpperCase() || '').join('') || '?';
};

/** Локальное хранилище с деградацией: в изолированных песочницах localStorage может быть недоступен. */
export const store9 = (() => {
  const mem = new Map();
  let ok = true;
  try {
    const k = '__aurora_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
  } catch { ok = false; }
  return {
    available: ok,
    get(key, fallback = null) {
      try { const v = ok ? window.localStorage.getItem(key) : mem.get(key); return v === null || v === undefined ? fallback : v; }
      catch { return mem.get(key) ?? fallback; }
    },
    set(key, value) {
      try { if (ok) window.localStorage.setItem(key, value); else mem.set(key, value); }
      catch { mem.set(key, value); }
    },
    remove(key) {
      try { if (ok) window.localStorage.removeItem(key); else mem.delete(key); } catch { mem.delete(key); }
    },
  };
})();

export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* не поддерживается */ }
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

/** UUID для оптимистичных сообщений. */
export const tempId = () => `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
