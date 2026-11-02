/**
 * Premium и баланс Аврор — два отдельных экрана в стиле «жидкое стекло».
 * Положить в /js/commerce-v2.js и подключить:  <script type="module" src="/js/commerce-v2.js"></script>
 * Открытие:  bus.emit('commerce:open', 'premium' | 'aurorki')   или   AuroraCommerce.open('premium')
 * Покупки используют актуальный каталог Aurora и существующий checkout.
 * Нигде в интерфейсе не упоминается платёжный провайдер: только «Оплатить», «Пополнить», «Пополнено».
 */
import { state, bus } from './store.js';
import { Api, newOperationKey } from './api.js?v=20261104-payment-email-1';
import { promptDialog, toastError } from './ui.js?v=20261029-no-toasts-1';

/* ── Тарифы и функции (как сейчас в приложении) ─────────────────────────── */
export let PLANS = [];
export const PERKS = [
  { ico: '💎', c: 'violet', t: 'Значок у имени', d: 'Один из 5 значков или свой эмодзи рядом с именем' },
  { ico: '😍', c: 'pink', t: 'Премиум-реакции и эмодзи', d: 'Эксклюзивные реакции и наборы кастомных эмодзи' },
  { ico: '🎬', c: 'blue', t: 'Видео-баннер профиля', d: 'Анимированный баннер до 50 МБ' },
  { ico: '🎨', c: 'amber', t: 'Темы профиля и обои', d: 'Хеллоуин, Новый год, Лето и другие темы, плюс премиум-обои чатов' },
  { ico: '📂', c: 'teal', t: 'Больше каналов и групп', d: 'До 40 каналов и 50 групп вместо 10' },
];
let catalog = null;
let wallet = null;
let selectedPlanId = '';
let history = [];

/* ── Утилиты ────────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtN = (n) => Number(n || 0).toLocaleString('ru-RU');
const rub = (n) => `${fmtN(n)} ₽`;
let uid = 0;
const isPrem = () => !!catalog?.premium || !!state.user?.isPremium;
const fmtDate = (v) => { const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); return Number.isNaN(+d) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); };
const fmtWhen = (v) => {
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); if (Number.isNaN(+d)) return esc(v || '');
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? `Сегодня, ${t}` : days === 1 ? `Вчера, ${t}` : `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

/* ── Анимированная звезда (SVG) ─────────────────────────────────────────── */
const starPts = (cx, cy, R, r) => Array.from({ length: 10 }, (_, i) => {
  const a = ((-90 + i * 36) * Math.PI) / 180; const k = i % 2 ? r : R;
  return [cx + Math.cos(a) * k, cy + Math.sin(a) * k];
});
const P = (a) => a.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
const spark = (x, y, s, d, cls = '') => `<path class="cm-tw ${cls}" style="animation-delay:${d}s;transform-origin:${x}px ${y}px" d="M${x} ${y - s}c.8 ${s * .55} ${s * .45} ${s * .8} ${s} ${s}-${s * .55}.8-${s * .8} ${s * .45}-${s} ${s}-.8-${s * .55}-${s * .45}-${s * .8}-${s}-${s}${s * .55}-.8 ${s * .8}-${s * .45} ${s}-${s}z" fill="#fff"/>`;

export function starScene(kind = 'premium') {
  const id = `st${++uid}`; const crystal = kind === 'crystal';
  const pts = starPts(120, 106, 62, 29); const out = starPts(120, 106, 70, 36);
  const facets = crystal ? Array.from({ length: 5 }, (_, i) => {
    const o = pts[i * 2]; const l = pts[(i * 2 + 9) % 10]; const r = pts[i * 2 + 1]; const c = [120, 106];
    return `<polygon class="cm-facet" style="animation-delay:${i * .55}s" points="${P([c, l, o])}" fill="#fff" fill-opacity=".16"/><polygon class="cm-facet" style="animation-delay:${i * .55 + .27}s" points="${P([c, o, r])}" fill="#fff" fill-opacity=".05"/>`;
  }).join('') : '';
  const orbit = 'M12 106a108 34 0 1 0 216 0a108 34 0 1 0-216 0';
  return `<div class="cm-scene ${crystal ? 'is-crystal' : ''}" data-scene>
  <div class="cm-aura"></div>
  <div class="cm-tilt"><div class="cm-float">
  <svg viewBox="0 0 240 200" class="cm-star" aria-hidden="true">
    <defs>
      <linearGradient id="${id}f" x1="80" y1="40" x2="170" y2="170" gradientUnits="userSpaceOnUse"><stop stop-color="${crystal ? '#c9b6ff' : '#d3a8ff'}"/><stop offset=".5" stop-color="${crystal ? '#7d5cff' : '#8d5cff'}"/><stop offset="1" stop-color="${crystal ? '#3f3fe0' : '#3b6dff'}"/></linearGradient>
      <linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}o" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#8d7bff" stop-opacity="0"/><stop offset=".5" stop-color="#b9a8ff" stop-opacity=".85"/><stop offset="1" stop-color="#7cc8ff" stop-opacity=".2"/></linearGradient>
      <clipPath id="${id}k"><polygon points="${P(out)}"/></clipPath>
    </defs>
    <g transform="rotate(-16 120 106)"><path d="${orbit}" fill="none" stroke="url(#${id}o)" stroke-width="1.6" class="cm-ring"/></g>
    <polygon points="${P(pts)}" fill="url(#${id}f)" stroke="url(#${id}f)" stroke-width="16" stroke-linejoin="round"/>
    ${facets}
    <polygon points="${P(starPts(116, 100, 46, 21))}" fill="url(#${id}h)" opacity="${crystal ? '.28' : '.5'}" stroke="url(#${id}h)" stroke-width="10" stroke-linejoin="round" stroke-opacity=".25"/>
    <g clip-path="url(#${id}k)"><g transform="rotate(22 120 106)"><rect x="-70" y="20" width="38" height="170" fill="url(#${id}s)" opacity=".48"/></g></g>
    ${kind === 'premium' ? '<g class="cm-crown"><path d="M184 40l4 14 8-8 8 8 4-14-6-2-6 8-6-8z" fill="none" stroke="#e7dcff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></g>' : ''}
    ${spark(36, 52, 7, 0)}${spark(206, 150, 8, .7)}${spark(52, 154, 4.5, 1.3)}
  </svg></div></div></div>`;
}

export async function refresh() {
  await loadCommerce();
  if (root) await render(stack[stack.length - 1] || 'premium', 1);
}

/* ── Разметка экранов ───────────────────────────────────────────────────── */
const icoBack = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>';
const icoChev = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';
const icoStarMini = '<svg viewBox="0 0 24 24" class="cm-mini"><defs><linearGradient id="msg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#c9a8ff"/><stop offset="1" stop-color="#5b6bff"/></linearGradient></defs><polygon points="12 2.6 14.9 8.6 21.4 9.5 16.7 14.1 17.8 20.6 12 17.5 6.2 20.6 7.3 14.1 2.6 9.5 9.1 8.6" fill="url(#msg)" stroke="url(#msg)" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const OPS = {
  topup: { c: 'blue', svg: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M3 10h18"/></svg>' },
  buy: { c: 'violet', svg: '<svg viewBox="0 0 24 24"><path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg>' },
  gift: { c: 'pink', svg: '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M3 13h18M7.5 9C5 9 5 4.5 8 5c2 .3 4 4 4 4s2-3.700 4-4c3-.5 3 4-.5 4"/></svg>' },
  spend: { c: 'gray', svg: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>' },
};
const opRow = (o) => { const k = OPS[o.type] || OPS.spend; const a = Number(o.amount || 0);
  return `<li class="cm-op"><span class="cm-opico" data-c="${k.c}">${k.svg}</span><span class="cm-opt"><b>${esc(o.title)}</b><small>${fmtWhen(o.time)}</small></span><span class="cm-opa ${a < 0 ? 'neg' : 'pos'}">${a > 0 ? '+' : '−'}${fmtN(Math.abs(a))}${icoStarMini}</span></li>`; };

function premiumHTML() {
  const active = isPrem();
  const plans = catalog?.premiumPlans || [];
  const selected = plans.find((item) => item.id === selectedPlanId) || plans[0];
  const until = active ? fmtDate(catalog?.premium?.expiresAt || state.user?.premiumUntil) : '';
  return `<section class="cm-view" data-view="premium">
  <header class="cm-nav"><button class="cm-back cm-glass" data-close aria-label="Назад">${icoBack}</button><h2>Premium</h2><span></span></header>
  <div class="cm-body">
    ${starScene('premium')}
    <h1 class="cm-h1">Aurora Premium</h1>
    <p class="cm-sub">Больше возможностей<br>для комфортного общения</p>
    <button class="cm-pill cm-glass" data-goto="aurorki"><span class="cm-crown-i">${icoStarMini}</span>Баланс: ${fmtN(wallet?.balance || 0)} Аврор<span class="cm-chev">${icoChev}</span></button>
    ${active ? `<div class="cm-pill cm-glass is-on"><span class="cm-dot"></span>Premium активен${until ? ` до ${until}` : ''}</div>` : ''}
    <ul class="cm-perks cm-glass">${PERKS.map((p) => `<li><span class="cm-perk-ico" data-c="${p.c}">${p.ico}</span><span><b>${p.t}</b><small>${p.d}</small></span></li>`).join('')}</ul>
    ${plans.length ? `<div class="cm-plans" role="radiogroup" aria-label="Тариф">${plans.map((p) => {
      const per = p.months > 1 ? Math.round(p.price / p.months) : 0; const save = p.oldPrice ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
      const title = p.title || `${p.months} ${p.months === 1 ? 'месяц' : p.months < 5 ? 'месяца' : 'месяцев'}`;
      return `<button class="cm-plan cm-glass ${p.id === selected?.id ? 'is-sel' : ''}" role="radio" aria-checked="${p.id === selected?.id}" data-plan="${esc(p.id)}" ${catalog?.paymentsEnabled ? '' : 'disabled'}>
        <span class="cm-plan-t"><b>${esc(title)}</b><span class="cm-plan-p">${rub(p.price)}${p.oldPrice ? `<s>${rub(p.oldPrice)}</s>` : ''}</span>${per ? `<small>${rub(per)} в месяц</small>` : ''}</span>
        ${save ? `<em class="cm-save">−${save}%</em>` : ''}<span class="cm-radio"><i></i></span></button>`; }).join('')}</div>` : '<p class="cm-sub">Тарифы временно недоступны.</p>'}
    ${catalog?.paymentsEnabled ? '' : '<p class="cm-sub">Покупки временно недоступны.</p>'}
    <p class="cm-secure"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9zm-8-2a3 3 0 0 1 6 0v2H9z"/></svg>Безопасная оплата</p>
  </div>
  <footer class="cm-bar"><button class="cm-pay" data-pay-premium ${!catalog?.paymentsEnabled || !selected ? 'disabled' : ''}><span class="cm-pay-t">${selected ? `${active ? 'Продлить' : 'Оплатить'} · ${rub(selected.price)}` : 'Тариф недоступен'}</span></button></footer>
  </section>`;
}

function aurorkiHTML(history) {
  const prem = isPrem();
  const ops = history.slice(0, 4);
  return `<section class="cm-view" data-view="aurorki">
  <header class="cm-nav"><button class="cm-back cm-glass" data-close aria-label="Назад">${icoBack}<span>Назад</span></button><h2>Мои Авроры</h2><span></span></header>
  <div class="cm-body">
    ${starScene('crystal')}
    <div class="cm-balance"><span class="cm-bal-star">${icoStarMini}</span><b data-count="${Number(wallet?.balance || 0)}">0</b></div>
    <p class="cm-unit">Авроры</p>
    <button class="cm-pill cm-glass" data-goto="premium"><span class="cm-crown-i">👑</span>${prem ? 'Premium активен' : 'Premium не активен'}<span class="cm-chev">${icoChev}</span></button>
    <div class="cm-actions">
      <button class="cm-act cm-glass" data-topup><span class="cm-act-ico" data-c="violet"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>Пополнить баланс</button>
      <button class="cm-act cm-glass" data-gift><span class="cm-act-ico" data-c="pink">${OPS.gift.svg}</span>Магазин подарков</button>
      <button class="cm-act cm-glass" data-history><span class="cm-act-ico" data-c="blue"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>История операций</button>
    </div>
    <div class="cm-sec-h"><h3>Последние операции</h3>${history.length > 4 ? '<button data-history>Все ' + icoChev + '</button>' : ''}</div>
    ${ops.length ? `<ul class="cm-ops cm-glass">${ops.map(opRow).join('')}</ul>` : '<div class="cm-empty cm-glass">Операций пока нет.<br>Пополните баланс — и они появятся здесь.</div>'}
  </div></section>`;
}

/* ── Оверлей и навигация ────────────────────────────────────────────────── */
let root = null; let stack = [];

function showToast(text) {
  if (!root) return; root.querySelector('.cm-toast')?.remove();
  const t = document.createElement('div'); t.className = 'cm-toast cm-glass'; t.textContent = text; root.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 2200);
}

function countUp(node, to) {
  const from = Number(node.dataset.shown || 0); const t0 = performance.now(); const dur = 1100;
  const tick = (now) => { const k = Math.min(1, (now - t0) / dur); const e = 1 - (1 - k) ** 4; node.textContent = fmtN(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(tick); else node.dataset.shown = to; };
  requestAnimationFrame(tick);
}

async function render(screen, dir = 1) {
  if (!root) return;
  const holder = root.querySelector('.cm-stage');
  const next = document.createElement('div'); next.className = `cm-page ${dir > 0 ? 'in-r' : 'in-l'}`;
  next.innerHTML = screen === 'premium' ? premiumHTML() : aurorkiHTML(history);
  const prev = holder.querySelector('.cm-page');
  holder.append(next);
  if (prev) { prev.classList.add(dir > 0 ? 'out-l' : 'out-r'); setTimeout(() => prev.remove(), 380); }
  requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove('in-r', 'in-l')));
  const c = next.querySelector('[data-count]'); if (c) countUp(c, Number(c.dataset.count));
  bindScene(next);
}

async function loadCommerce() {
  const [nextCatalog, nextWallet] = await Promise.all([Api.commerceCatalog(), Api.commerceWallet()]);
  catalog = nextCatalog;
  wallet = nextWallet;
  PLANS = [...(catalog.premiumPlans || [])];
  if (!PLANS.some((item) => item.id === selectedPlanId)) selectedPlanId = PLANS[0]?.id || '';
  history = (wallet.transactions || []).map((item) => ({
    type: /gift/i.test(item.kind) ? 'gift' : Number(item.amount) >= 0 ? 'topup' : 'spend',
    title: /gift/i.test(item.kind) ? 'Операция с подарком'
      : Number(item.amount) >= 0 ? 'Покупка Аврор' : 'Списание Аврор',
    time: item.created_at,
    amount: item.amount,
  }));
}

function bindScene(page) {
  const scene = page.querySelector('[data-scene]');
  scene?.addEventListener('click', () => navigator.vibrate?.(8));
}

function sheet(html, onMount) {
  const s = document.createElement('div'); s.className = 'cm-sheet-wrap';
  s.innerHTML = `<div class="cm-sheet cm-glass" role="dialog"><div class="cm-grab"></div>${html}</div>`;
  const shut = () => { s.classList.add('out'); setTimeout(() => s.remove(), 260); };
  s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-shut]')) shut(); });
  root.append(s); onMount?.(s, shut); requestAnimationFrame(() => s.classList.add('in'));
}

function openTopUp() {
  const packages = catalog?.balancePackages || [];
  let selected = packages[0]?.id || '';
  sheet(`<h3>Пополнить баланс</h3><p class="cm-sheet-s">Выберите пакет из каталога Aurora</p>
    <div class="cm-chips">${packages.map((item) => `<button class="cm-chip ${item.id === selected ? 'is-sel' : ''}" data-amt="${esc(item.id)}" ${catalog?.paymentsEnabled ? '' : 'disabled'}>${icoStarMini}${fmtN(item.auroras)} · ${rub(item.price)}</button>`).join('')}</div>
    <button class="cm-pay" data-do-topup ${!catalog?.paymentsEnabled || !selected ? 'disabled' : ''}><span class="cm-pay-t"></span></button>`, (s, shut) => {
    const btn = s.querySelector('[data-do-topup]');
    const paint = () => {
      const item = packages.find((entry) => entry.id === selected);
      btn.querySelector('.cm-pay-t').textContent = item ? `Пополнить ${fmtN(item.auroras)} · ${rub(item.price)}` : 'Пакеты недоступны';
      s.querySelectorAll('[data-amt]').forEach((chip) => chip.classList.toggle('is-sel', chip.dataset.amt === selected));
      btn.disabled = !catalog?.paymentsEnabled || !item;
    };
    paint();
    s.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-amt]');
      if (!chip || chip.disabled) return;
      selected = chip.dataset.amt;
      paint();
    });
    btn.addEventListener('click', async () => {
      if (!packages.some((item) => item.id === selected)) return;
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        await beginCheckout('auroras', selected);
        shut();
      } catch (error) {
        toastError(error);
      } finally {
        btn.classList.remove('is-busy');
        if (btn.isConnected) paint();
      }
    });
  });
}

async function beginCheckout(kind, productId) {
  if (!catalog?.paymentsEnabled) throw new Error('Покупки временно недоступны');
  const receiptEmail = await promptDialog({
    title: 'Почта для чека',
    label: 'Укажите email, который нужно показать администратору для отправки чека',
    value: state.user?.email || '',
    placeholder: 'name@example.com',
    confirmLabel: 'Перейти к оплате',
    maxLength: 254,
  });
  if (!receiptEmail) return;
  if (receiptEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiptEmail)) {
    throw new Error('Укажите корректный адрес электронной почты');
  }
  const result = kind === 'premium'
    ? await Api.commercePremium(productId, receiptEmail, newOperationKey())
    : await Api.commercePurchase(productId, receiptEmail, newOperationKey());
  if (result.confirmationUrl) {
    const confirmation = new URL(result.confirmationUrl);
    if (confirmation.protocol !== 'https:') throw new Error('Получена небезопасная ссылка оплаты');
    location.assign(confirmation.href);
    return;
  }
  if (result.status === 'succeeded') {
    await loadCommerce();
    await render(kind === 'premium' ? 'premium' : 'aurorki', 1);
    showToast(kind === 'premium' ? 'Aurora Premium активирован' : 'Авроры зачислены');
    return;
  }
  showToast('Платёж создан. Дождитесь подтверждения оплаты.');
}

function openHistory() {
  sheet(`<h3>История операций</h3>${history.length ? `<ul class="cm-ops cm-ops-full">${history.map(opRow).join('')}</ul>` : '<div class="cm-empty">Операций пока нет.</div>'}<button class="cm-pay cm-pay-ghost" data-shut><span class="cm-pay-t">Закрыть</span></button>`);
}

function onClick(e) {
  if (e.target.closest('[data-close]')) { if (stack.length > 1) { stack.pop(); render(stack[stack.length - 1], -1); } else close(); return; }
  const go = e.target.closest('[data-goto]'); if (go) { stack.push(go.dataset.goto); render(go.dataset.goto, 1); return; }
  const pl = e.target.closest('[data-plan]');
  if (pl) {
    selectedPlanId = pl.dataset.plan;
    root.querySelectorAll('[data-plan]').forEach((button) => { const on = button === pl; button.classList.toggle('is-sel', on); button.setAttribute('aria-checked', on); });
    const selected = PLANS.find((item) => item.id === selectedPlanId);
    const text = root.querySelector('.cm-bar .cm-pay-t');
    if (text && selected) text.textContent = `${isPrem() ? 'Продлить' : 'Оплатить'} · ${rub(selected.price)}`;
    navigator.vibrate?.(8); return;
  }
  const pay = e.target.closest('[data-pay-premium]');
  if (pay) {
    if (!selectedPlanId) return;
    pay.disabled = true;
    pay.classList.add('is-busy');
    beginCheckout('premium', selectedPlanId).catch(toastError).finally(() => {
      pay.classList.remove('is-busy');
      if (pay.isConnected) pay.disabled = !catalog?.paymentsEnabled;
    });
    return;
  }
  if (e.target.closest('[data-topup]')) openTopUp();
  else if (e.target.closest('[data-gift]')) bus.emit('commerce:gift-shop');
  else if (e.target.closest('[data-history]')) openHistory();
}

export async function open(screen = 'premium') {
  close(true, false);
  const activeScreen = screen === 'aurorki' ? 'aurorki' : 'premium';
  root = document.createElement('div'); root.className = 'cm'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', activeScreen === 'premium' ? 'Premium' : 'Мои Авроры');
  const currentRoot = root;
  root.innerHTML = '<div class="cm-bg"><i class="b1"></i><i class="b2"></i><i class="b3"></i><div class="cm-stars"></div></div><div class="cm-stage"></div>';
  const st = root.querySelector('.cm-stars');
  st.innerHTML = Array.from({ length: 10 }, (_, index) => `<i style="left:${(index * 37 + 13) % 100}%;top:${(index * 61 + 17) % 100}%;width:2px;height:2px"></i>`).join('');
  root.addEventListener('click', onClick);
  document.body.append(root); document.body.classList.add('cm-lock');
  stack = [activeScreen];
  requestAnimationFrame(() => currentRoot.classList.add('in'));
  try {
    await loadCommerce();
    if (root === currentRoot) await render(activeScreen, 1);
  } catch (error) {
    if (root === currentRoot) close(true);
    toastError(error);
  }
}
export function close(instant, navigate = true) {
  if (!root) return; const r = root; root = null; document.body.classList.remove('cm-lock');
  if (instant) r.remove(); else { r.classList.remove('in'); r.classList.add('out'); setTimeout(() => r.remove(), 320); }
  if (navigate) {
    const giftCenter = location.hash.includes('section=gifts') || location.hash.includes('recipientId=');
    bus.emit('nav:go', giftCenter ? '#/commerce?section=gifts' : '#/chats');
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root) close(); });
bus.on('commerce:open', (screen) => { void open(screen === 'aurorki' ? 'aurorki' : 'premium'); });
window.AuroraCommerce = { open, close, get PLANS() { return PLANS; } };
