import { Api } from './api.js?v=20261102-gifts-2';
import { toastError } from './ui.js?v=20261029-no-toasts-1';

/**
 * Темы и кастомизация профиля (Хеллоуин, Новый год, Лето, Джунгли/лианы, Снег, Неон),
 * кнопка «Оформление», сравнение Free/Premium на экране Premium.
 */
const KEY = 'aurora.profileTheme.v1';

export const PROFILE_THEMES = [
  { id: 'none', label: 'Без темы', em: '🚫', bg: 'linear-gradient(160deg,#3b4252,#1c2029)' },
  { id: 'halloween', label: 'Хеллоуин', em: '🎃', bg: 'linear-gradient(160deg,#2b0f3d,#ff7a18)' },
  { id: 'newyear', label: 'Новый год', em: '🎄', bg: 'linear-gradient(160deg,#0b3d2b,#d62839)' },
  { id: 'summer', label: 'Лето', em: '🌴', bg: 'linear-gradient(160deg,#38bdf8,#fbbf24)' },
  { id: 'jungle', label: 'Джунгли', em: '🌿', bg: 'linear-gradient(160deg,#052e16,#22c55e)' },
  { id: 'snow', label: 'Снегопад', em: '❄️', bg: 'linear-gradient(160deg,#1e3a5f,#bae6fd)' },
  { id: 'neon', label: 'Неон', em: '🌆', bg: 'linear-gradient(160deg,#7c3aed,#06b6d4)' },
];
const RINGS = [['none', 'Без кольца'], ['gradient', 'Акцент'], ['rainbow', 'Радуга']];
const NAMEFX = [['none', 'Обычное'], ['glow', 'Свечение'], ['gradient', 'Градиент']];
const DEFAULT_CONFIG = { theme: 'none', ring: 'none', nameFx: 'none', dim: 0 };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
let pendingProfileSave = Promise.resolve();

function normalizeConfig(value = {}) {
  const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    theme: PROFILE_THEMES.some((theme) => theme.id === cfg.theme) ? cfg.theme : DEFAULT_CONFIG.theme,
    ring: RINGS.some(([id]) => id === cfg.ring) ? cfg.ring : DEFAULT_CONFIG.ring,
    nameFx: NAMEFX.some(([id]) => id === cfg.nameFx) ? cfg.nameFx : DEFAULT_CONFIG.nameFx,
    dim: Number.isFinite(Number(cfg.dim)) ? clamp(Number(cfg.dim), 0, 6) : DEFAULT_CONFIG.dim,
  };
}

const load = () => {
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (error) {
    console.error('Не удалось загрузить оформление профиля из браузера.', error);
    return { ...DEFAULT_CONFIG };
  }
};

const save = (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeConfig(value)));
  } catch (error) {
    console.error('Не удалось сохранить оформление профиля в браузере.', error);
  }
};
function readProfileEffects(hero) {
  try {
    return normalizeConfig(JSON.parse(hero.dataset.profileEffects || '{}'));
  } catch (error) {
    console.error('Не удалось прочитать оформление профиля.', error);
    return { ...DEFAULT_CONFIG };
  }
}

function persistProfileEffects(value) {
  const effects = normalizeConfig(value);
  pendingProfileSave = pendingProfileSave.catch(() => {}).then(async () => {
    const result = await Api.updateProfile({ profileEffects: effects });
    if (!result?.user?.profileEffects) throw new Error('Сервер не подтвердил сохранение оформления профиля');
    return normalizeConfig(result.user.profileEffects);
  });
  return pendingProfileSave;
}
const rnd = (a, b) => a + Math.random() * (b - a);

const snow = (n = 26, chars = ['❄', '•', '❅']) => Array.from({ length: n }, () =>
  `<i class="pt-flake" style="left:${rnd(0, 100)}%;font-size:${rnd(8, 18)}px;animation-duration:${rnd(5, 11)}s;animation-delay:${-rnd(0, 10)}s;--dx:${rnd(-30, 40)}px;font-style:normal">${chars[Math.floor(rnd(0, chars.length))]}</i>`).join('');

const vine = (x, len, c) => `<svg class="pt-sway" style="left:${x}%;top:0;width:46px;height:${len}px" viewBox="0 0 46 ${len}">
  <path d="M23 0 C 8 ${len * .2}, 38 ${len * .4}, 23 ${len * .6} S 10 ${len * .85}, 23 ${len}" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
  ${[.15, .32, .5, .68, .86].map((t, i) => `<ellipse cx="${i % 2 ? 36 : 10}" cy="${len * t}" rx="11" ry="5.5" fill="${c}" opacity=".9" transform="rotate(${i % 2 ? 25 : -25} ${i % 2 ? 36 : 10} ${len * t})"/>`).join('')}
</svg>`;

const tinsel = (y, a, b) => `<svg style="left:0;top:${y}px;width:100%;height:46px" viewBox="0 0 400 46" preserveAspectRatio="none">
  <path d="M0 8 Q 50 44 100 12 T 200 12 T 300 12 T 400 8" fill="none" stroke="${a}" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 4" opacity=".95"/>
  <path d="M0 8 Q 50 44 100 12 T 200 12 T 300 12 T 400 8" fill="none" stroke="${b}" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 5" class="pt-twinkle"/>
</svg>`;

const lights = () => `<div style="left:0;right:0;top:44px;display:flex;justify-content:space-around">${['#ff4d6d', '#ffd166', '#4ade80', '#60a5fa', '#f0abfc', '#ff4d6d', '#ffd166', '#4ade80', '#60a5fa'].map((c, i) =>
  `<span class="pt-twinkle" style="position:static;width:11px;height:15px;border-radius:50% 50% 45% 45%;background:${c};box-shadow:0 0 14px 3px ${c};animation-delay:${i * .25}s;margin-top:${i % 2 ? 10 : 0}px"></span>`).join('')}</div>`;

const web = (flip) => `<svg style="${flip ? 'right:0;transform:scaleX(-1)' : 'left:0'};top:0;width:130px;height:130px" viewBox="0 0 100 100" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1">
  <path d="M0 0 L100 0 M0 0 L100 40 M0 0 L100 100 M0 0 L40 100 M0 0 L0 100"/><path d="M0 22 Q 22 22 22 0 M0 44 Q 44 44 44 0 M0 70 Q 70 70 70 0"/></svg>`;

const DECOR = {
  halloween: () => `${web(false)}${web(true)}<span class="pt-bat" style="top:30px">🦇</span><span class="pt-bat" style="top:80px;animation-delay:-4s;font-size:16px">🦇</span>
    <span style="left:10px;bottom:6px;font-size:34px">🎃</span><span style="right:12px;bottom:4px;font-size:30px">👻</span><span style="left:46%;top:12px;font-size:24px" class="pt-sway">🕷️</span>
    <div class="pt-glow-bottom" style="background:radial-gradient(60% 100% at 50% 100%,rgba(255,120,20,.4),transparent)"></div>`,
  newyear: () => `${tinsel(0, '#ffd166', '#fff')}${tinsel(14, '#ff4d6d', '#ffd1dc')}${lights()}${snow(18)}`,
  summer: () => `<span style="right:18px;top:16px;font-size:46px" class="pt-twinkle">☀️</span><span style="left:12px;bottom:34px;font-size:34px">🌴</span><span style="right:14px;bottom:30px;font-size:28px">🍹</span>
    <svg style="left:0;bottom:0;width:100%;height:46px" viewBox="0 0 400 46" preserveAspectRatio="none"><path d="M0 22 Q 50 4 100 22 T 200 22 T 300 22 T 400 22 V46 H0Z" fill="rgba(14,165,233,.8)"/><path d="M0 32 Q 50 16 100 32 T 200 32 T 300 32 T 400 32 V46 H0Z" fill="rgba(2,132,199,.9)"/></svg>`,
  jungle: () => `${[3, 14, 30, 52, 70, 86, 94].map((x, i) => vine(x, 80 + (i % 3) * 36, i % 2 ? '#22c55e' : '#16a34a')).join('')}<span style="left:42%;bottom:8px;font-size:26px">🦜</span><span style="right:10px;bottom:6px;font-size:24px">🌺</span>`,
  snow: () => `${snow(34)}<svg style="left:0;bottom:0;width:100%;height:38px" viewBox="0 0 400 38" preserveAspectRatio="none"><path d="M0 18 Q 40 0 90 16 T 200 14 T 310 16 T 400 12 V38 H0Z" fill="#fff"/></svg><span style="right:16px;bottom:22px;font-size:30px">⛄</span>`,
  neon: () => `<svg style="left:0;bottom:0;width:100%;height:70%" viewBox="0 0 400 140" preserveAspectRatio="none" stroke="rgba(240,171,252,.55)" stroke-width="1">${Array.from({ length: 9 }, (_, i) => `<path d="M${i * 50} 140 L${200 + (i - 4) * 12} 40"/>`).join('')}${[50, 80, 105, 125].map((y) => `<path d="M0 ${y} H400"/>`).join('')}</svg>
    <i class="pt-twinkle" style="left:12%;top:20%;width:6px;height:6px;border-radius:50%;background:#7cf2ff;box-shadow:0 0 14px 4px #7cf2ff"></i><i class="pt-twinkle" style="right:16%;top:30%;width:6px;height:6px;border-radius:50%;background:#f0abfc;box-shadow:0 0 14px 4px #f0abfc;animation-delay:.6s"></i>`,
};

const pageOf = (hero) => hero.closest('[data-pt-page], .settings-inner, .panel-body, .panel, .profile, .tg-profile') || hero.parentElement;

export function apply(hero, value) {
  if (!hero) return;
  const cfg = normalizeConfig(value ?? readProfileEffects(hero));
  const theme = cfg.theme === 'none' ? '' : cfg.theme;
  const page = pageOf(hero);
  [hero, page].forEach((node) => {
    if (!node) return;
    if (theme) node.dataset.ptheme = theme;
    else delete node.dataset.ptheme;
    node.dataset.ring = cfg.ring;
    node.dataset.nameFx = cfg.nameFx;
    node.style.setProperty('--pt-dim', String(cfg.dim));
  });
  hero.dataset.profileEffects = JSON.stringify(cfg);
  const cover = hero.querySelector('.tg-cover');
  cover?.querySelector(':scope > .pt-deco')?.remove();
  page?.querySelector(':scope > .pt-page')?.remove();
  if (page) {
    if (theme) page.dataset.ptPage = '1';
    else delete page.dataset.ptPage;
  }
  if (theme && DECOR[theme] && page) {
    const layer = document.createElement('div');
    layer.className = 'pt-page';
    layer.innerHTML = `<div class="pt-page-in pt-deco">${DECOR[theme]()}</div>`;
    page.prepend(layer);
  }
}

function openSheet(hero) {
  const cfg = readProfileEffects(hero);
  const sheet = document.createElement('div');
  const previousBodyOverflow = document.body.style.overflow;
  sheet.className = 'pt-sheet';
  const draw = () => {
    sheet.innerHTML = `<div class="pt-panel" role="dialog" aria-modal="true" aria-label="Оформление профиля">
      <h3>Оформление профиля</h3><p style="margin:0;color:var(--text-dim);font-size:13px">Оформление сохраняется в профиле и видно другим пользователям.</p>
      <h4>Тема</h4><div class="pt-themes" role="radiogroup">${PROFILE_THEMES.map((t) =>
        `<button type="button" class="pt-theme" role="radio" aria-checked="${cfg.theme === t.id}" data-theme="${t.id}" style="background:${t.bg}"><span class="em">${t.em}</span>${t.label}</button>`).join('')}</div>
      <h4>Кольцо аватара</h4><div class="pt-opts" role="radiogroup">${RINGS.map(([id, label]) => `<button type="button" class="pt-chip" role="radio" aria-checked="${cfg.ring === id}" data-ring="${id}">${label}</button>`).join('')}</div>
      <h4>Эффект имени</h4><div class="pt-opts" role="radiogroup">${NAMEFX.map(([id, label]) => `<button type="button" class="pt-chip" role="radio" aria-checked="${cfg.nameFx === id}" data-fx="${id}">${label}</button>`).join('')}</div>
      <h4>Затемнение баннера</h4><input class="pt-range" type="range" min="0" max="6" step="1" value="${cfg.dim}" data-dim aria-label="Затемнение баннера">
      <button type="button" class="pt-done">Готово</button></div>`;
  };
  let persistTimer;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = undefined;
    persistProfileEffects(cfg).catch(toastError);
  };
  const commit = () => {
    save(cfg);
    apply(hero, cfg);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 300);
  };
  const close = () => {
    if (persistTimer) persist();
    document.removeEventListener('keydown', onKey, true);
    document.body.style.overflow = previousBodyOverflow;
    sheet.remove();
    hero.querySelector('.pt-fab')?.focus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  draw();
  sheet.addEventListener('click', (event) => {
    if (!event.target || event.target.nodeType !== 1) return;
    const target = event.target;
    if (target === sheet || target.closest('.pt-done')) { close(); return; }
    const theme = target.closest('[data-theme]');
    const ring = target.closest('[data-ring]');
    const fx = target.closest('[data-fx]');
    if (theme) cfg.theme = theme.dataset.theme;
    else if (ring) cfg.ring = ring.dataset.ring;
    else if (fx) cfg.nameFx = fx.dataset.fx;
    else return;
    commit();
    draw();
  });
  sheet.addEventListener('input', (event) => {
    if (event.target?.matches?.('input[data-dim]')) {
      cfg.dim = Number(event.target.value);
      commit();
    }
  });
  document.body.style.overflow = 'hidden';
  document.body.append(sheet);
  document.addEventListener('keydown', onKey, true);
  sheet.querySelector('.pt-theme')?.focus();
}

const VS = [['Каналов и групп', '10', '40 / 50'], ['Значок у имени', '—', '✓'], ['Кастомные эмодзи и реакции', '—', '✓'], ['Видео-баннер профиля', '—', '✓'], ['Темы оформления профиля', '6', '6'], ['Премиум-обои чатов', '—', '5'], ['Видео до', '—', '50 МБ']];
function enhancePremium(pm) {
  if (pm.querySelector('.pm-vsbox')) return;
  const box = document.createElement('section');
  box.className = 'pm-sec';
  box.innerHTML = `<h3>Free и Premium — что меняется</h3><div class="pm-vsbox"><div class="pm-vsrow"><span></span><span>Free</span><span class="pro">Premium</span></div>${
    VS.map(([name, free, premium]) => `<div class="pm-vsrow"><span>${name}</span><span class="no">${free}</span><span class="pro">${premium}</span></div>`).join('')}</div>`;
  const anchor = pm.querySelector('.pm-plans')?.closest('.pm-hero') || pm.querySelector('.pm-hero');
  anchor?.after(box);
  const plans = pm.querySelector('.pm-plans');
  if (plans && !pm.querySelector('.pm-cta')) {
    const cta = document.createElement('div');
    cta.className = 'pm-cta';
    cta.innerHTML = '<span>Откройте возможности Aurora</span><button type="button">Выбрать план</button>';
    cta.querySelector('button').onclick = () => plans.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pm.append(cta);
  }
}

function scan(root = document) {
  const premiumViews = [...(root.querySelectorAll?.('.pm') || [])];
  if (root.nodeType === 1 && root.matches('.pm')) premiumViews.unshift(root);
  premiumViews.forEach(enhancePremium);
  const heroes = [...(root.querySelectorAll?.('.tg-hero') || [])];
  if (root.nodeType === 1 && root.matches('.tg-hero')) heroes.unshift(root);
  heroes.forEach((hero) => {
    if (hero.dataset.ptReady) return;
    hero.dataset.ptReady = '1';
    const own = hero.matches('[data-own], .is-own, .own') || !!hero.closest('[data-own], .is-own, .settings-screen');
    const serverEffects = readProfileEffects(hero);
    const localEffects = load();
    const hasLocalCustomization = JSON.stringify(localEffects) !== JSON.stringify(DEFAULT_CONFIG);
    const hasServerCustomization = JSON.stringify(serverEffects) !== JSON.stringify(DEFAULT_CONFIG);
    const effects = own && !hasServerCustomization && hasLocalCustomization ? localEffects : serverEffects;
    apply(hero, effects);
    if (own && hasLocalCustomization && !hasServerCustomization) persistProfileEffects(effects).catch(toastError);
    if (!own) return;
    const cover = hero.querySelector('.tg-cover');
    if (!cover) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pt-fab';
    button.textContent = '🎨 Оформление';
    button.setAttribute('aria-label', 'Открыть оформление профиля');
    button.addEventListener('click', (event) => { event.stopPropagation(); openSheet(hero); });
    cover.append(button);
  });
}

new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
  if (node.nodeType === 1) scan(node);
}))).observe(document.documentElement, { childList: true, subtree: true });
scan();
window.AuroraProfileTheme = { apply, themes: PROFILE_THEMES, open: openSheet };
