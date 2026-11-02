/**
 * Premium: значки, реакции, обои, лимиты. Один модуль — один источник правды.
 * Все значки симметричные, 24×24, с градиентами. Не зависят от остального приложения.
 */
export const PREMIUM_LIMITS = {
  free: { channels: 10, groups: 10 },
  premium: { channels: 40, groups: 50 },
  bannerVideoMB: 50,
};

const g = (id, a, b, c) => `<linearGradient id="${id}" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
const svg = (defs, body) => `<svg viewBox="0 0 24 24" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;

export const PREMIUM_BADGES = [
  { id: 'aurora', label: 'Аврора', svg: svg(g('pb-a', '#7cf2ff', '#7c5cff', '#d46bff'),
    '<rect x="5" y="5" width="14" height="14" rx="3.4" fill="url(#pb-a)"/><rect x="5" y="5" width="14" height="14" rx="3.4" fill="url(#pb-a)" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.6" fill="#fff" fill-opacity=".92"/>') },
  { id: 'diamond', label: 'Алмаз', svg: svg(g('pb-d', '#b8f4ff', '#4cc2ff', '#6a6bff'),
    '<path d="M7.2 3.6h9.6l4.6 5.6L12 20.8 2.6 9.2z" fill="url(#pb-d)" stroke="url(#pb-d)" stroke-width="1.6" stroke-linejoin="round"/><path d="M2.8 9.2h18.4M9.4 3.8 7.6 9.2 12 20.2l4.4-11-1.8-5.4" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.1" stroke-linejoin="round"/>') },
  { id: 'crown', label: 'Корона', svg: svg(g('pb-c', '#fff0b3', '#ffc94d', '#ff9a3d'),
    '<path d="M4 18.4 3 8.2l5.2 4.2L12 5l3.8 7.4L21 8.2l-1 10.2z" fill="url(#pb-c)" stroke="url(#pb-c)" stroke-width="1.6" stroke-linejoin="round"/><rect x="4" y="19" width="16" height="2.2" rx="1.1" fill="url(#pb-c)"/><circle cx="12" cy="5" r="1.5" fill="#fff"/><circle cx="3" cy="8" r="1.2" fill="#fff"/><circle cx="21" cy="8" r="1.2" fill="#fff"/>') },
  { id: 'spark', label: 'Сияние', svg: svg(g('pb-s', '#ffd6f2', '#ff6ec7', '#a855f7'),
    '<path d="M12 2.2c.7 5.6 4.2 9.1 9.8 9.8-5.6.7-9.1 4.2-9.8 9.8-.7-5.6-4.2-9.1-9.8-9.8 5.6-.7 9.1-4.2 9.8-9.8z" fill="url(#pb-s)" stroke="url(#pb-s)" stroke-width="1.2" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.7" fill="#fff"/>') },
  { id: 'seal', label: 'Печать', svg: svg(g('pb-l', '#b6ffd9', '#2fd6a0', '#1593d6'),
    '<path d="M12 2.6 20 7.3v9.4l-8 4.7-8-4.7V7.3z" fill="url(#pb-l)" stroke="url(#pb-l)" stroke-width="2" stroke-linejoin="round"/><path d="m8.2 12.2 2.7 2.7 5-5.4" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>') },
];

export const badgeById = (id) => PREMIUM_BADGES.find((b) => b.id === id) || PREMIUM_BADGES[0];

/** Наборы кастомных эмодзи: код в сообщении, id в профиле и реакциях. */
const item = (code, label, file, id = code) => ({ id, code, label, file });
export const EMOJI_PACKS = [
  {
    id: 'yabloko',
    title: 'Яблоко',
    keywords: ['яблоко', 'партия', 'yabloko', 'голубь', 'молния', 'скрепка', 'метка'],
    items: [
      item('yabloko-golub', 'Голубь', 'premium-yabloko-golub.svg'),
      item('yabloko-logo', 'Кольцо', 'premium-yabloko-logo.svg'),
      item('yabloko-text', 'Яблоко', 'premium-yabloko-text.svg'),
      item('yabloko-pin', 'Метка', 'premium-yabloko-pin.svg'),
      item('yabloko-clip', 'Скрепка', 'premium-yabloko-clip.svg'),
      item('yabloko-bolt', 'Молния', 'premium-yabloko-bolt.svg'),
    ],
  },
  {
    id: 'aurora',
    title: 'Аврора',
    keywords: ['аврора', 'aurora', 'космос', 'звезда', 'сердце', 'комета', 'пламя', 'корона'],
    items: [
      item('aurora-nova', 'Нова', 'premium-nova.svg', 'aurora-emoji-nova'),
      item('aurora-heart', 'Сердце Авроры', 'premium-heart.svg', 'aurora-emoji-heart'),
      item('aurora-comet', 'Комета', 'premium-comet.svg', 'aurora-emoji-comet'),
      item('aurora-flame', 'Пламя', 'premium-flame.svg', 'aurora-emoji-flame'),
      item('aurora-crown', 'Корона', 'premium-crown.svg', 'aurora-emoji-crown'),
    ],
  },
  {
    id: 'premium-news',
    title: 'Новости Premium',
    keywords: ['новости', 'пост', 'канал', 'уведомление', 'важно', 'информация', 'публикация'],
    items: [
      item('premium-news-megafon', 'Мегафон', 'premium-news-megafon.png'),
      item('premium-news-paper', 'Новости', 'premium-news-paper.png'),
      item('premium-news-rocket', 'Ракета', 'premium-news-rocket.png'),
      item('premium-news-star', 'Звезда', 'premium-news-star.png'),
      item('premium-news-alert', 'Внимание', 'premium-news-alert.png'),
      item('premium-news-aurora', 'Аврора', 'premium-news-aurora.png'),
      item('premium-news-bell', 'Уведомление', 'premium-news-bell.png'),
      item('premium-news-calendar', 'Календарь', 'premium-news-calendar.png'),
      item('premium-news-check', 'Готово', 'premium-news-check.png'),
      item('premium-news-info', 'Информация', 'premium-news-info.png'),
    ],
  },
];
export const PREMIUM_CUSTOM_EMOJIS = EMOJI_PACKS.flatMap((pack) => pack.items.map((emoji) => ({ ...emoji, pack: pack.id })));
const customEmojiById = new Map(PREMIUM_CUSTOM_EMOJIS.map((emoji) => [emoji.id, emoji]));
const customEmojiByCodeMap = new Map(PREMIUM_CUSTOM_EMOJIS.map((emoji) => [emoji.code, emoji]));
export { customEmojiById };
export const customEmojiByCode = (code) => customEmojiByCodeMap.get(String(code).toLowerCase()) || null;
export const customEmojiURL = (emoji) => `/assets/stickers/${emoji.file}`;
export const customEmojiHTML = (emoji, cls = '') => `<img class="premium-emoji ${cls}" src="${customEmojiURL(emoji)}" alt=":${emoji.code}:" title="${emoji.label}" width="28" height="28" draggable="false">`;

/** Значок верификации: выдаётся только администратором и показывается рядом с именем. */
const vg = (id, a, b, c) => `<linearGradient id="${id}" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
const CHECK = '<path class="vcheck" pathLength="1" d="M7.7 12.3l3 3 5.7-6.2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>';
const flow = (id, a, b, c) => `<linearGradient id="${id}" x1="0" y1="0" x2="12" y2="12" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop stop-color="${a}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/><animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="12 12" dur="2.8s" repeatCount="indefinite"/></linearGradient>`;
export const VERIFIED_BADGES = {
  official: svg(flow('vb-o', '#7be3ff', '#2f86ff', '#5a4dff'),
    '<path d="M12 1.8l2.3 1.6 2.8-.2 1.2 2.5 2.5 1.2-.2 2.8 1.6 2.3-1.6 2.3.2 2.8-2.5 1.2-1.2 2.5-2.8-.2-2.3 1.6-2.3-1.6-2.8.2-1.2-2.5-2.5-1.2.2-2.8L1.8 12l1.6-2.3-.2-2.8 2.5-1.2 1.2-2.5 2.8.2z" fill="url(#vb-o)" stroke="url(#vb-o)" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M12 3.4l1.8 1.3 2.2-.2 1 2 2 .9-.1 2.2 1.3 1.8-1.3 1.8.1 2.2-2 .9-1 2-2.2-.2-1.8 1.3-1.8-1.3-2.2.2-1-2-2-.9.1-2.2L3.4 12l1.3-1.8-.1-2.2 2-.9 1-2 2.2.2z" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width=".6"/>'
    + CHECK + '<path class="vspark" d="M19.8 2l.55 1.5 1.5.55-1.5.55-.55 1.5-.55-1.5-1.5-.55 1.5-.55z" fill="#fff"/><path class="vspark s2" d="M3.2 17.4l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4z" fill="#d9f3ff"/>'),
  verified: svg(vg('vb-v', '#6ff2c8', '#18c597', '#0b8f9e'),
    '<path d="M12 1.9 20.2 5v6.6c0 5-3.5 8.8-8.2 10.5-4.7-1.7-8.2-5.5-8.2-10.5V5z" fill="url(#vb-v)" stroke="url(#vb-v)" stroke-width="1.1" stroke-linejoin="round"/><path d="M12 3.6 18.7 6.1v5.4c0 4-2.7 7.1-6.7 8.7-4-1.6-6.7-4.7-6.7-8.7V6.1z" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width=".7"/>' + CHECK),
};
export const VERIFIED_INFO = {
  official: {
    user: ['Официальный аккаунт Aurora', 'Этот аккаунт принадлежит Aurora и ведётся командой мессенджера.'],
    channel: ['Официальный канал Aurora', 'Этот канал принадлежит Aurora. Здесь публикуются официальные новости и обновления.'],
    group: ['Официальная группа Aurora', 'Эта группа принадлежит Aurora и модерируется командой мессенджера.'],
  },
  verified: {
    user: ['Подтверждённый аккаунт', 'Aurora проверила, что этот аккаунт принадлежит тому, кем он представляется.'],
    channel: ['Подтверждённый канал', 'Aurora подтвердила подлинность этого канала и его владельца.'],
    group: ['Подтверждённая группа', 'Aurora подтвердила подлинность этой группы и её владельца.'],
  },
};

export const verifiedLevel = (entity) => (entity?.verified === 'official' ? 'official' : entity?.verified ? 'verified' : '');

export function verifiedBadgeHTML(entity, { size = '' } = {}) {
  const level = verifiedLevel(entity);
  if (!level) return '';
  const kind = ['channel', 'group'].includes(entity.type) ? entity.type : 'user';
  const title = VERIFIED_INFO[level][kind][0];
  return `<span class="vbadge ${size}" data-v="${level}" data-kind="${kind}" role="button" tabindex="0" aria-label="${title}" title="${title}">${VERIFIED_BADGES[level]}</span>`;
}

export function installVerifiedBadgeDialogs() {
  if (document.documentElement.dataset.verifiedBadgeDialogs === '1') return;
  document.documentElement.dataset.verifiedBadgeDialogs = '1';

  let currentWrap = null;
  let escapeHandler = null;
  const close = (restoreFocus = false) => {
    if (!currentWrap) return;
    document.removeEventListener('keydown', escapeHandler);
    const wrap = currentWrap;
    wrap.classList.add('out');
    const trigger = wrap._trigger;
    setTimeout(() => wrap.remove(), 200);
    currentWrap = null;
    escapeHandler = null;
    if (restoreFocus) trigger?.focus();
  };
  const open = (badge) => {
    close();
    const level = badge.dataset.v;
    const kind = ['channel', 'group'].includes(badge.dataset.kind) ? badge.dataset.kind : 'user';
    const [title, description] = VERIFIED_INFO[level]?.[kind] || VERIFIED_INFO.verified.user;
    const wrap = document.createElement('div');
    wrap.className = 'vpop-wrap';
    wrap.innerHTML = `<section class="vpop" data-v="${level}" role="dialog" aria-modal="true" aria-labelledby="vpop-title"><div class="vpop-ico">${VERIFIED_BADGES[level]}</div><span class="vpop-tag">${level === 'official' ? 'ОФИЦИАЛЬНЫЙ АККАУНТ' : 'ПОДЛИННОСТЬ ПОДТВЕРЖДЕНА'}</span><h3 id="vpop-title"></h3><p></p><button class="vpop-ok" type="button">Понятно</button></section>`;
    wrap._trigger = badge;
    currentWrap = wrap;
    wrap.querySelector('h3').textContent = title;
    wrap.querySelector('p').textContent = description;
    wrap.addEventListener('click', (event) => {
      if (event.target === wrap || event.target.closest('[data-vpop-close], .vpop-ok')) close(true);
    });
    escapeHandler = (event) => {
      if (event.key !== 'Escape') return;
      close(true);
    };
    document.addEventListener('keydown', escapeHandler);
    document.body.append(wrap);
    const rect = badge.getBoundingClientRect();
    const pop = wrap.querySelector('.vpop');
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - 312, rect.left + rect.width / 2 - 150))}px`;
    pop.style.top = `${Math.max(12, Math.min(window.innerHeight - 280, rect.bottom + 10))}px`;
    pop.querySelector('button').focus();
  };

  document.addEventListener('click', (event) => {
    const badge = event.target.closest?.('.vbadge[data-v]');
    if (badge) {
      event.preventDefault();
      event.stopPropagation();
      open(badge);
    } else if (event.target.closest?.('.vpop-wrap')) {
      return;
    } else {
      close();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.vbadge[data-v]')) {
      event.preventDefault();
      open(event.target);
    }
  });
}

/** Значки для имени: верификация + Premium. Используется в профиле, списке чатов, шапке диалога. */
export function premiumBadgeHTML(user, { size = '' } = {}) {
  const verified = verifiedBadgeHTML(user, { size });
  if (!user?.isPremium) return verified;
  const own = user.premiumEmoji ? customEmojiById.get(user.premiumEmoji) : null;
  if (own) {
    return `${verified}<span class="pbadge pemoji ${size}" data-emoji-id="${own.id}" title="${own.label}">${customEmojiHTML(own)}</span>`;
  }
  const b = badgeById(user.premiumBadge);
  return `${verified}<span class="pbadge ${size}" data-badge="${b.id}" title="Premium · ${b.label}">${b.svg}</span>`;
}

export const PREMIUM_REACTIONS = [
  '💎', '👑', '🚀', '🪐', '✨', '🌈', '🫶', '🦄', '🔮', '🥂',
  ...PREMIUM_CUSTOM_EMOJIS.map((emoji) => emoji.id),
];
export const isPremiumReaction = (emoji) => PREMIUM_REACTIONS.includes(emoji);
export const premiumReactionLabel = (emoji) => customEmojiById.get(emoji)?.label || emoji;
export const premiumReactionHTML = (emoji) => {
  const custom = customEmojiById.get(emoji);
  if (custom) return customEmojiHTML(custom);
  return String(emoji).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
};

export function searchEmojiPacks(query) {
  const q = String(query || '').trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return { packs: [], items: [] };
  const items = PREMIUM_CUSTOM_EMOJIS.filter((emoji) => emoji.label.toLowerCase().includes(q) || emoji.code.includes(q));
  const packs = EMOJI_PACKS.filter((pack) => pack.title.toLowerCase().includes(q) || pack.id.includes(q)
    || pack.keywords.some((keyword) => keyword.includes(q)) || items.some((emoji) => emoji.pack === pack.id));
  return { packs, items };
}

/** Обои, доступные только с Premium. Градиенты — без внешних ассетов. */
export const PREMIUM_WALLPAPERS = [
  { id: 'p-nebula', label: 'Туманность', premium: true,
    preview: 'radial-gradient(90% 70% at 20% 15%, #7c3aed, transparent 60%), radial-gradient(80% 70% at 85% 85%, #0ea5e9, transparent 55%), #0b0620',
    dark: 'radial-gradient(90% 70% at 20% 15%, rgba(124,58,237,.75), transparent 60%), radial-gradient(80% 70% at 85% 85%, rgba(14,165,233,.6), transparent 55%), #0b0620',
    light: 'radial-gradient(90% 70% at 20% 15%, #e3d8ff, transparent 60%), radial-gradient(80% 70% at 85% 85%, #cdeeff, transparent 55%), #f7f5ff' },
  { id: 'p-gold', label: 'Золотой час', premium: true,
    preview: 'radial-gradient(90% 70% at 80% 10%, #f59e0b, transparent 60%), radial-gradient(80% 70% at 10% 90%, #be185d, transparent 55%), #1a0b10',
    dark: 'radial-gradient(90% 70% at 80% 10%, rgba(245,158,11,.65), transparent 60%), radial-gradient(80% 70% at 10% 90%, rgba(190,24,93,.6), transparent 55%), #1a0b10',
    light: 'radial-gradient(90% 70% at 80% 10%, #ffe7b8, transparent 60%), radial-gradient(80% 70% at 10% 90%, #ffd3e4, transparent 55%), #fffaf4' },
  { id: 'p-emerald', label: 'Изумруд', premium: true,
    preview: 'radial-gradient(90% 70% at 15% 20%, #10b981, transparent 60%), radial-gradient(80% 70% at 90% 90%, #0e7490, transparent 55%), #04141a',
    dark: 'radial-gradient(90% 70% at 15% 20%, rgba(16,185,129,.6), transparent 60%), radial-gradient(80% 70% at 90% 90%, rgba(14,116,144,.65), transparent 55%), #04141a',
    light: 'radial-gradient(90% 70% at 15% 20%, #c9f5e4, transparent 60%), radial-gradient(80% 70% at 90% 90%, #cdeef5, transparent 55%), #f3fcf9' },
  { id: 'p-rose', label: 'Роза', premium: true,
    preview: 'radial-gradient(90% 70% at 85% 15%, #f43f5e, transparent 60%), radial-gradient(80% 70% at 10% 85%, #7c3aed, transparent 55%), #17070f',
    dark: 'radial-gradient(90% 70% at 85% 15%, rgba(244,63,94,.6), transparent 60%), radial-gradient(80% 70% at 10% 85%, rgba(124,58,237,.6), transparent 55%), #17070f',
    light: 'radial-gradient(90% 70% at 85% 15%, #ffd0da, transparent 60%), radial-gradient(80% 70% at 10% 85%, #e5d9ff, transparent 55%), #fff6f8' },
  { id: 'p-ice', label: 'Лёд', premium: true,
    preview: 'radial-gradient(90% 70% at 50% 0%, #38bdf8, transparent 60%), radial-gradient(80% 70% at 50% 100%, #6366f1, transparent 55%), #06101f',
    dark: 'radial-gradient(90% 70% at 50% 0%, rgba(56,189,248,.55), transparent 60%), radial-gradient(80% 70% at 50% 100%, rgba(99,102,241,.6), transparent 55%), #06101f',
    light: 'radial-gradient(90% 70% at 50% 0%, #d4efff, transparent 60%), radial-gradient(80% 70% at 50% 100%, #dfe0ff, transparent 55%), #f5faff' },
];

/** Внедряет градиенты премиум-обоев в :root (вызывается один раз при старте). */
export function installPremiumWallpapers() {
  if (document.getElementById('premium-wallpapers')) return;
  const rule = (sel, key) => PREMIUM_WALLPAPERS.map((w) => `${sel}[data-wallpaper='${w.id}'] .wallpaper-img{background-image:${w[key]}}`).join('');
  const style = document.createElement('style');
  style.id = 'premium-wallpapers';
  style.textContent = rule('[data-theme="dark"]', 'dark') + rule('[data-theme="light"]', 'light')
    + PREMIUM_WALLPAPERS.map((w) => `[data-wallpaper='${w.id}'] .wallpaper-img{background-image:${w.dark}}`).join('')
    + PREMIUM_WALLPAPERS.map((w) => `[data-theme='light'][data-wallpaper='${w.id}'] .wallpaper-img{background-image:${w.light}}`).join('');
  document.head.append(style);
}

/** Проверка лимита перед созданием группы/канала. Серверная проверка обязательна отдельно. */
export function chatLimitFor(user) {
  return user?.isPremium ? PREMIUM_LIMITS.premium : PREMIUM_LIMITS.free;
}
export function checkCreateLimit(user, chats, kind /* 'group' | 'channel' */) {
  const limit = chatLimitFor(user)[kind === 'channel' ? 'channels' : 'groups'];
  const owned = chats.filter((c) => c.type === kind && c.role === 'owner').length;
  return { ok: owned < limit, owned, limit };
}
