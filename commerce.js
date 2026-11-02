import { $, el, esc, html, raw, fmtFullDate } from '../util.js';
import { bus, state } from '../store.js';
import { Api, api } from '../api.js?v=20261104-payment-email-1';
import { PREMIUM_BADGES, PREMIUM_WALLPAPERS, PREMIUM_REACTIONS, PREMIUM_CUSTOM_EMOJIS, PREMIUM_LIMITS, badgeById } from '../premium.js?v=20261031-verified-badge-1';
import { shell } from './shell.js?v=20261028-ux-1';
import { toast, toastError, promptDialog, confirmDialog, modal } from '../ui.js?v=20261029-no-toasts-1';
import * as CommerceV2 from '../commerce-v2.js?v=20261104-commerce-v2-2';

export const commerceView = {
  el: null, mounted: false, catalog: null, wallet: null, recipientId: null,
  recipient: null, giftRarity: 'all', giftSort: 'new', loadingMoreGifts: false, sendingGift: false,
  checkingPaymentOrder: null,
};
const GIFT_RARITIES = ['обычный', 'необычный', 'редкий', 'эпический', 'легендарный', 'мифический'];

function routeRecipientId() {
  const query = location.hash.slice(1).split('?')[1] || '';
  const value = Number(new URLSearchParams(query).get('recipientId'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function routePaymentOrderId() {
  const query = location.hash.slice(1).split('?')[1] || '';
  return new URLSearchParams(query).get('paymentOrder') || '';
}

function routeSection() {
  const query = location.hash.slice(1).split('?')[1] || '';
  return new URLSearchParams(query).get('section') || '';
}

export function mountReady() {
  if (commerceView.mounted) return;
  commerceView.mounted = true;
  const node = el('section', { class: 'commerce-screen hidden', 'data-commerce-screen': '' });
  document.getElementById('root').append(node);
  commerceView.el = node;
  bus.on('commerce:gift', ({ recipientId, recipient } = {}) => {
    commerceView.recipientId = Number(recipientId) || null;
    commerceView.recipient = recipient || null;
    bus.emit('nav:go', commerceView.recipientId ? `#/commerce?recipientId=${commerceView.recipientId}` : '#/commerce');
  });
  bus.on('commerce:gift-shop', () => {
    CommerceV2.close(true, false);
    bus.emit('nav:go', '#/commerce?section=gifts');
  });
}

export async function show() {
  mountReady();
  commerceView.recipientId = routeRecipientId();
  if (!commerceView.recipientId) commerceView.recipient = null;
  const giftCenter = routeSection() === 'gifts' || !!commerceView.recipientId;
  shell.sidebar.style.display = 'none';
  shell.conv.style.display = 'none';
  document.querySelector('[data-settings-screen]')?.classList.add('hidden');
  commerceView.el.classList.toggle('hidden', !giftCenter);
  if (!giftCenter) {
    void CommerceV2.open('premium');
    const paymentOrderId = routePaymentOrderId();
    if (paymentOrderId) void checkPaymentReturn(paymentOrderId);
    return;
  }
  commerceView.el.innerHTML = '<div class="commerce-inner"><div class="spinner"></div></div>';
  try {
    [commerceView.catalog, commerceView.wallet] = await Promise.all([Api.commerceCatalog(), Api.commerceWallet()]);
    if (commerceView.recipientId && commerceView.recipient?.id !== commerceView.recipientId) {
      commerceView.recipient = (await Api.userProfile(commerceView.recipientId)).user;
    }
    render();
    commerceView.el.querySelector('[data-gift-grid]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { commerceView.el.innerHTML = `<p class="state-empty">${esc(err.message)}</p>`; }
}

export function hide() {
  commerceView.el?.classList.add('hidden');
  shell.sidebar.style.display = '';
  shell.conv.style.display = '';
}

function money(value) {
  return `${commerceView.catalog?.symbol || '✦'} ${Number(value).toLocaleString('ru-RU')}`;
}

async function checkPaymentReturn(orderId) {
  if (!/^[\da-f-]{36}$/i.test(orderId) || commerceView.checkingPaymentOrder === orderId) return;
  commerceView.checkingPaymentOrder = orderId;
  try {
    let order;
    for (let attempt = 0; attempt < 8; attempt++) {
      order = await Api.commercePaymentStatus(orderId, attempt === 0);
      if (order.status === 'succeeded' || order.status === 'canceled') break;
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    history.replaceState(null, '', '#/commerce');
    if (order?.status === 'succeeded') {
      await CommerceV2.refresh();
      toast(order.kind === 'auroras' ? `Зачислено ${order.units} Аврор` : 'Aurora Premium активирован', { type: 'success' });
    } else if (order?.status === 'canceled') {
      toast('Платёж отменён. Баланс и Premium не изменены.', { type: 'info' });
    } else {
      toast('Платёж ещё обрабатывается. Покупка применится после подтверждения YooKassa.', { type: 'info' });
    }
  } catch (error) {
    history.replaceState(null, '', '#/commerce');
    toastError(error);
  } finally {
    commerceView.checkingPaymentOrder = null;
  }
}

function render() {
  const w = commerceView.wallet;
  commerceView.el.innerHTML = html`<div class="commerce-inner">
    <header class="commerce-head"><button class="icon-btn" data-back aria-label="Назад">←</button><div><h2>Магазин подарков</h2><small>${money(w.balance)} Аврор</small></div></header>
    <section class="commerce-section"><div class="section-title"><h3>Подарки</h3><span class="muted small">${commerceView.recipient ? `Для ${esc(commerceView.recipient.name)}` : 'Выберите знак внимания'}</span></div>
      <div class="gift-filters" role="group" aria-label="Фильтр по редкости">
        <button class="btn btn-sm ${commerceView.giftRarity === 'all' ? 'btn-primary' : ''}" data-rarity="all">Все</button>
        ${raw(GIFT_RARITIES.map((rarity) => html`<button class="btn btn-sm ${commerceView.giftRarity === rarity ? 'btn-primary' : ''}" data-rarity="${rarity}">${rarity[0].toLocaleUpperCase('ru-RU') + rarity.slice(1)}</button>`).join(''))}
        <label class="gift-sort-label">Сортировка
          <select class="input gift-sort" data-gift-sort aria-label="Сортировка подарков">
            <option value="new" ${commerceView.giftSort === 'new' ? 'selected' : ''}>Новинки</option>
            <option value="cheap" ${commerceView.giftSort === 'cheap' ? 'selected' : ''}>Сначала дешевле</option>
            <option value="expensive" ${commerceView.giftSort === 'expensive' ? 'selected' : ''}>Сначала дороже</option>
            <option value="rarity" ${commerceView.giftSort === 'rarity' ? 'selected' : ''}>По редкости</option>
          </select>
        </label>
      </div>
      <div class="gift-grid" data-gift-grid></div>
    </section>
    <section class="commerce-section"><div class="section-title"><h3>Мои подарки</h3></div>
      <div class="received-grid">${raw((w.receivedGifts || []).length ? w.receivedGifts.map((g) => html`<article class="received-gift rarity-${esc(g.rarity)} ${g.hidden ? 'is-hidden' : ''}">
        ${g.imageUrl ? html`<img src="${esc(g.imageUrl)}" alt="${esc(g.name)}" loading="lazy">` : ''}
        <div class="received-gift-info"><b>${esc(g.name)}</b><small>${esc(g.rarity)}</small><small>от @${esc(g.sender?.username || '')}</small><small>${fmtFullDate(g.createdAt)}</small>${g.hidden ? html`<small>Скрыт из профиля</small>` : ''}${g.pinned ? html`<small>Закреплён в профиле</small>` : ''}</div>
        <div class="received-gift-actions">
          <button class="btn btn-sm" data-owned-gift="${g.instanceId}">История</button>
          <button class="btn btn-sm" data-gift-hidden="${g.instanceId}" data-hidden="${g.hidden ? '1' : '0'}">${g.hidden ? 'Показать' : 'Скрыть'}</button>
          <button class="btn btn-sm" data-gift-pin="${g.instanceId}" data-pinned="${g.pinned ? '1' : '0'}">${g.pinned ? 'Открепить' : 'Закрепить'}</button>
          <button class="btn btn-sm btn-danger" data-gift-sell="${g.instanceId}">Продать</button>
        </div>
      </article>`).join('') : '<p class="muted">Подарков в коллекции пока нет.</p>')}</div>
    </section>
  </div>`;
  bind();
  renderGiftGrid();
}

function bind() {
  $('[data-back]', commerceView.el)?.addEventListener('click', () => bus.emit('nav:go', '#/chats'));
  commerceView.el.querySelectorAll('[data-rarity]').forEach((b) => b.addEventListener('click', () => {
    commerceView.giftRarity = b.dataset.rarity;
    commerceView.el.querySelectorAll('[data-rarity]').forEach((button) => button.classList.toggle('btn-primary', button === b));
    renderGiftGrid();
  }));
  $('[data-gift-sort]', commerceView.el)?.addEventListener('change', (event) => {
    commerceView.giftSort = event.currentTarget.value;
    renderGiftGrid();
  });
  commerceView.el.querySelectorAll('[data-owned-gift]').forEach((button) => button.addEventListener('click', () => showOwnedGift(button.dataset.ownedGift)));
  commerceView.el.querySelectorAll('[data-gift-hidden]').forEach((button) => button.addEventListener('click', () => updateOwnedGift(button.dataset.giftHidden, { hidden: button.dataset.hidden !== '1' })));
  commerceView.el.querySelectorAll('[data-gift-pin]').forEach((button) => button.addEventListener('click', () => updateOwnedGift(button.dataset.giftPin, { pinned: button.dataset.pinned !== '1' })));
  commerceView.el.querySelectorAll('[data-gift-sell]').forEach((button) => button.addEventListener('click', () => sellGift(button.dataset.giftSell)));
  $('[data-history]', commerceView.el)?.addEventListener('click', showGiftHistory);
}

function renderGiftGrid() {
  const host = $('[data-gift-grid]', commerceView.el);
  if (!host) return;
  const rank = new Map(GIFT_RARITIES.map((rarity, index) => [rarity, index]));
  const gifts = commerceView.catalog.gifts
    .filter((gift) => commerceView.giftRarity === 'all' || gift.rarity === commerceView.giftRarity)
    .sort((a, b) => {
      if (commerceView.giftSort === 'cheap') return a.price - b.price;
      if (commerceView.giftSort === 'expensive') return b.price - a.price;
      if (commerceView.giftSort === 'rarity') return (rank.get(b.rarity) ?? 0) - (rank.get(a.rarity) ?? 0) || a.price - b.price;
      return b.createdAt - a.createdAt || a.price - b.price;
    });
  host.innerHTML = gifts.length ? gifts.map((g) => html`<article class="gift-card gift-${esc(g.animation)} rarity-${esc(g.rarity || 'обычный')}">
    ${g.imageUrl ? html`<img class="gift-image" src="${esc(g.imageUrl)}" alt="${esc(g.name)}" loading="lazy" decoding="async">` : html`<div class="gift-image-placeholder">Изображение недоступно</div>`}
    <span class="gift-rarity">${esc(g.rarity || 'обычный')}</span><h4>${esc(g.name)}</h4><p>${esc(g.description)}</p>
    <strong>${money(g.price)}</strong>${g.stockRemaining !== null ? html`<small class="gift-stock">Осталось ${g.stockRemaining}</small>` : ''}
    <button class="btn btn-primary btn-sm" data-gift="${esc(g.id)}">Посмотреть</button></article>`).join('')
    : '<p class="muted gift-empty">В этой категории пока нет подарков.</p>';
  if (commerceView.catalog.giftsHasMore) {
    host.insertAdjacentHTML('beforeend', `<button class="btn gift-load-more" data-gift-load-more ${commerceView.loadingMoreGifts ? 'disabled' : ''}>${commerceView.loadingMoreGifts ? 'Загрузка…' : 'Показать ещё'}</button>`);
    host.querySelector('[data-gift-load-more]')?.addEventListener('click', loadMoreGifts);
  }
  host.querySelectorAll('[data-gift]').forEach((button) => button.addEventListener('click', () => sendGift(button.dataset.gift)));
}

async function loadMoreGifts() {
  if (commerceView.loadingMoreGifts || !commerceView.catalog.giftsHasMore) return;
  commerceView.loadingMoreGifts = true;
  renderGiftGrid();
  try {
    const page = await Api.commerceCatalog(commerceView.catalog.gifts.length);
    commerceView.catalog.gifts.push(...page.gifts);
    commerceView.catalog.giftsTotal = page.giftsTotal;
    commerceView.catalog.giftsHasMore = page.giftsHasMore;
  } catch (error) {
    toastError(error);
  } finally {
    commerceView.loadingMoreGifts = false;
    renderGiftGrid();
  }
}

async function sendGift(giftId) {
  const recipientId = commerceView.recipientId || routeRecipientId();
  if (!recipientId) return toast('Откройте профиль получателя и нажмите «Подарить»', { type: 'info' });
  const gift = commerceView.catalog.gifts.find((g) => g.id === giftId);
  if (!gift) return toast('Этот подарок больше недоступен', { type: 'error' });
  const detail = el('div', { class: `gift-detail-card rarity-${gift.rarity || 'обычный'}` },
    gift.imageUrl ? el('img', { class: 'gift-detail-image', src: gift.imageUrl, alt: gift.name }) : el('div', { class: 'gift-image-placeholder' }, 'Изображение недоступно'),
    el('span', { class: 'gift-rarity' }, gift.rarity || 'обычный'),
    el('h2', {}, gift.name),
    el('p', { class: 'muted' }, gift.description),
    el('strong', { class: 'gift-detail-price' }, money(gift.price)),
    gift.stockRemaining !== null ? el('small', { class: 'gift-stock' }, `Осталось экземпляров: ${gift.stockRemaining}`) : null,
    el('p', { class: 'gift-recipient' }, `Получатель: ${commerceView.recipient?.name || `пользователь #${recipientId}`} (@${commerceView.recipient?.username || recipientId})`));
  const canContinue = await new Promise((resolve) => {
    let result = false;
    const dialog = modal({
      title: 'Подарок Aurora',
      subtitle: 'Проверьте подарок и получателя перед отправкой.',
      body: detail,
      footer: [
        el('button', { class: 'btn', onClick: () => dialog.close() }, 'Отмена'),
        el('button', { class: 'btn btn-primary', onClick: () => { result = true; dialog.close(); } }, 'Продолжить'),
      ],
      onClose: () => resolve(result),
    });
  });
  if (!canContinue) return;
  const note = await promptDialog({
    title: `Подарок для ${commerceView.recipient?.name || 'пользователя'}`,
    label: 'Добавить сообщение',
    placeholder: 'Напишите что-нибудь тёплое…',
    confirmLabel: 'Дальше к подтверждению',
    allowEmpty: true,
  });
  if (note === null) return;
  if (commerceView.wallet.balance < gift.price) {
    const topUp = await confirmDialog({
      title: 'Недостаточно Аврор',
      text: `Для подарка нужно ${money(gift.price)}, на балансе ${money(commerceView.wallet.balance)}. Перейти к пополнению?`,
      confirmLabel: 'Перейти к пополнению',
    });
    if (topUp) void CommerceV2.open('aurorki');
    return;
  }
  const confirmed = await confirmDialog({
    title: 'Подтвердить отправку?',
    text: `${gift.name} для ${commerceView.recipient?.name || `пользователя #${recipientId}`} будет оплачен с вашего баланса. Стоимость: ${money(gift.price)}. После оплаты подарок появится в личном чате.`,
    confirmLabel: `Подарить за ${money(gift.price)}`,
  });
  if (!confirmed || commerceView.sendingGift) return;
  commerceView.sendingGift = true;
  const progress = modal({
    title: 'Отправляем подарок',
    body: el('div', { class: 'gift-send-progress' },
      el('div', { class: 'spinner' }),
      el('p', { class: 'muted' }, 'Проверяем оплату и доставляем подарок в личный чат…')),
    closable: false,
  });
  try {
    const r = await Api.commerceSendGift(recipientId, giftId, note);
    progress.close();
    showGiftCelebration(gift, commerceView.recipient?.name);
    commerceView.recipientId = null;
    commerceView.recipient = null;
    history.replaceState(null, '', '#/commerce');
    if (r.chatId) bus.emit('nav:go', `#/chat/${r.chatId}`);
    else showGiftSendError(new Error('Подарок оплачен, но сервер не вернул личный чат. Обновите список чатов.'));
  } catch (err) {
    progress.close();
    if (err.status === 403 && /Недостаточно Аврор/.test(err.message)) {
      const topUp = await confirmDialog({
        title: 'Недостаточно Аврор',
        text: err.message,
        confirmLabel: 'Перейти к пополнению',
      });
      if (topUp) void CommerceV2.open('aurorki');
    } else {
      showGiftSendError(err);
    }
  } finally {
    commerceView.sendingGift = false;
  }
}

function showGiftSendError(error) {
  const message = error?.status === 408 || error?.status === 0
    ? `${error.message || 'Сервер не ответил вовремя.'} Запрос мог успеть завершиться: сначала проверьте личный чат и коллекцию подарков, чтобы не отправить подарок повторно.`
    : error?.message || 'Не удалось отправить подарок. Попробуйте ещё раз.';
  const errorDialog = modal({
    title: 'Не удалось отправить подарок',
    body: el('p', { class: 'muted' }, message),
    footer: el('button', { class: 'btn btn-primary', type: 'button', onClick: () => errorDialog.close() }, 'Понятно'),
  });
}

function showGiftCelebration(gift, recipientName = '') {
  const layer = el('div', { class: 'gift-celebration' });
  layer.innerHTML = `<div class="confetti">${Array.from({ length: 28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
    <div class="celebration-card rarity-${esc(gift.rarity || 'обычный')}"><div class="celebration-rays"></div>${gift.imageUrl ? `<div class="celebration-art"><img src="${esc(gift.imageUrl)}" alt="${esc(gift.name)}"></div>` : ''}<div class="eyebrow">ПОДАРОК ОТПРАВЛЕН</div><h2>${esc(gift.name)}</h2><p>${recipientName ? `Для ${esc(recipientName)} · ` : ''}${money(gift.price)} · ${esc(gift.rarity || 'обычный')}</p></div>`;
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1500);
}

async function updateOwnedGift(id, payload) {
  try { await Api.giftCollectionUpdate(id, payload); await show(); }
  catch (error) { toastError(error); }
}

async function sellGift(id) {
  const gift = commerceView.wallet.receivedGifts.find((item) => String(item.instanceId) === String(id));
  if (!gift) return toast('Подарок не найден', { type: 'error' });
  const refund = Math.floor(gift.price * gift.sellbackPercent / 100);
  const confirmed = await confirmDialog({
    title: `Продать «${gift.name}»?`,
    text: `На баланс будет возвращено ${money(refund)}. После продажи подарок исчезнет из вашей коллекции, действие нельзя отменить.`,
    confirmLabel: `Продать за ${money(refund)}`,
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await Api.giftSell(id);
    toast(`Подарок продан. Начислено ${money(result.refund)}`, { type: 'success' });
    await show();
  } catch (error) { toastError(error); }
}

async function showOwnedGift(id) {
  const gift = commerceView.wallet.receivedGifts.find((item) => String(item.instanceId) === String(id));
  if (!gift) return toast('Подарок не найден', { type: 'error' });
  try {
    const { history: entries } = await Api.giftInstanceHistory(id);
    const body = el('div', { class: 'gift-detail-card' },
      gift.imageUrl ? el('img', { class: 'gift-detail-image', src: gift.imageUrl, alt: gift.name }) : null,
      el('span', { class: 'gift-rarity' }, gift.rarity),
      el('h2', {}, gift.name),
      el('p', { class: 'muted' }, `Получен от @${gift.sender?.username || 'неизвестно'} · ${fmtFullDate(gift.createdAt)}`),
      gift.note ? el('p', { class: 'gift-note' }, gift.note) : null,
      el('div', { class: 'gift-history-list' }, entries.map((entry) => el('p', { class: 'muted small' },
        `${giftOperationLabel(entry.operation)} · ${fmtFullDate(entry.created_at)}${entry.other_username ? ` · @${entry.other_username}` : ''}${entry.amount ? ` · ${money(Math.abs(entry.amount))}` : ''}`))));
    modal({ title: 'Информация о подарке', body });
  } catch (error) { toastError(error); }
}

async function showGiftHistory() {
  try {
    const { history: entries } = await Api.giftHistory();
    const body = el('div', { class: 'gift-history-list' }, entries.length
      ? entries.map((entry) => el('article', { class: 'admin-row' },
        el('span', {}, el('b', {}, entry.gift_name),
          el('small', {}, `${giftOperationLabel(entry.operation)} · ${fmtFullDate(entry.created_at)}${entry.other_username ? ` · @${entry.other_username}` : ''}`)),
        el('strong', {}, entry.amount ? money(Math.abs(entry.amount)) : '—')))
      : el('p', { class: 'muted' }, 'История подарков пока пуста.'));
    modal({ title: 'История подарков', body, wide: true });
  } catch (error) { toastError(error); }
}

function giftOperationLabel(operation) {
  return ({ received: 'Получен', added: 'Добавлен в коллекцию', sent: 'Отправлен', sold: 'Продан', hidden: 'Скрыт из профиля', shown: 'Возвращён в профиль' })[operation] || operation;
}


/* ───────────────────────── Экран Premium ───────────────────────────── */

const CROWN = '<svg viewBox="0 0 24 24"><path d="M4 18.4 3 8.2l5.2 4.2L12 5l3.8 7.4L21 8.2l-1 10.2z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><rect x="4" y="19" width="16" height="2.2" rx="1.1" fill="#fff"/></svg>';

function monthsWord(n) { return n === 1 ? 'месяц' : n < 5 ? 'месяца' : 'месяцев'; }

function _premiumHTML(c, premium) {
  const pro = !!premium || !!state.user?.isPremium;
  const plans = c.premiumPlans || [];
  const bestId = plans.length ? plans.reduce((a, b) => (b.price / b.months < a.price / a.months ? b : a)).id : null;
  const cur = badgeById(state.user?.premiumBadge);
  const lock = pro ? '' : '<div class="pm-lock">Откроется с Premium</div>';
  const lim = PREMIUM_LIMITS;
  return html`<div class="pm">
    <section class="pm-hero">
      <div class="pm-orb">${raw(CROWN)}</div>
      <h1>Aurora Premium</h1>
      <p>Значок, анимированный баннер, эксклюзивные обои и реакции, а ещё в несколько раз больше каналов и групп.</p>
      ${pro ? html`<div class="pm-status">✦ Активен до ${new Date(premium?.expiresAt || state.user?.premiumUntil || Date.now()).toLocaleDateString('ru-RU')}</div>`
        : c.premiumRequest ? html`<div class="pm-status">Заявка отправлена. Ждём решения модератора</div>`
        : html`<div class="pm-plans">${raw(plans.map((p) => html`<button class="pm-plan ${p.id === bestId ? 'best' : ''}" data-premium="${esc(p.id)}"><b>${p.months} ${monthsWord(p.months)}</b><span class="pr">${p.price} ₽</span><small>${Math.round(p.price / p.months)} ₽ в месяц</small></button>`).join(''))}</div>`}
    </section>

    <section class="pm-sec"><h3>Что входит</h3><div class="pm-perks">
      <div class="pm-perk"><span class="ico">💠</span><div><b>Значок рядом с именем</b><span class="d">Пять оформлений на выбор. Виден в чатах, профиле и поиске.</span></div></div>
      <div class="pm-perk"><span class="ico">🎬</span><div><b>Анимированный баннер</b><span class="d">Загрузите своё видео до ${lim.bannerVideoMB} МБ. Оно играет в шапке профиля.</span></div></div>
      <div class="pm-perk"><span class="ico">🖼️</span><div><b>5 эксклюзивных обоев</b><span class="d">Туманность, Золотой час, Изумруд, Роза и Лёд.</span></div></div>
      <div class="pm-perk"><span class="ico">📣</span><div><b>Больше каналов и групп</b><span class="d">Создавайте и ведите больше сообществ.</span>
        <span class="pm-vs"><i>Каналы ${lim.free.channels}</i><i class="pro">Premium ${lim.premium.channels}</i></span>
        <span class="pm-vs"><i>Группы ${lim.free.groups}</i><i class="pro">Premium ${lim.premium.groups}</i></span></div></div>
      <div class="pm-perk"><span class="ico">✨</span><div><b>Премиум-реакции</b><span class="d">Анимированные реакции на сообщения. Их видят все в чате.</span></div></div>
    </div></section>

    <section class="pm-sec"><h3>Ваш значок</h3><div class="pm-card ${pro ? '' : 'locked'}">${raw(lock)}
      <div class="pm-preview"><span data-pm-name>${esc(state.user?.name || 'Вы')}</span><span class="pbadge lg" data-pm-cur data-badge="${cur.id}">${raw(cur.svg)}</span></div>
      <div class="pm-badges" role="radiogroup" aria-label="Значок Premium">${raw(PREMIUM_BADGES.map((b) => `<button class="pm-badge-opt" role="radio" data-badge-pick="${b.id}" aria-checked="${b.id === cur.id}" aria-label="${esc(b.label)}"><span class="pbadge">${b.svg}</span><small>${esc(b.label)}</small></button>`).join(''))}</div>
    </div></section>

    <section class="pm-sec"><h3>Анимированный баннер</h3><div class="pm-card pm-video ${pro ? '' : 'locked'}">${raw(lock)}
      <div class="pm-video-frame" data-pm-vframe>${state.user?.profileBannerVideo ? html`<video src="${esc(state.user.profileBannerVideo)}" muted loop autoplay playsinline></video>` : 'Видео не выбрано'}</div>
      <div class="pm-bar" hidden data-pm-bar><i></i></div>
      <div class="pm-video-row"><label class="btn btn-primary">Загрузить видео<input type="file" accept="video/mp4,video/webm" data-pm-video hidden></label>${state.user?.profileBannerVideo ? html`<button class="btn" data-pm-video-del>Убрать</button>` : ''}</div>
      <small class="muted">MP4 или WebM, до ${lim.bannerVideoMB} МБ. Звука в баннере нет.</small>
    </div></section>

    <section class="pm-sec"><h3>Премиум-обои</h3><div class="pm-card ${pro ? '' : 'locked'}">${raw(lock)}
      <div class="pm-walls">${raw(PREMIUM_WALLPAPERS.map((w) => `<button class="pm-wall" data-wall-pick="${w.id}" aria-checked="${state.settings?.wallpaper === w.id}" style="background:${w.preview}"><span>${esc(w.label)}</span></button>`).join(''))}</div>
    </div></section>

    <section class="pm-sec"><h3>Премиум-реакции</h3><div class="pm-card">
      <div class="pm-react">${raw(PREMIUM_REACTIONS.map((e) => {
        const custom = PREMIUM_CUSTOM_EMOJIS.find((item) => item.id === e);
        return `<button type="button" aria-label="${esc(custom?.label || e)}">${custom ? `<img class="premium-emoji" src="/assets/stickers/${esc(custom.file)}" alt="${esc(custom.label)}" width="32" height="32">` : e}</button>`;
      }).join(''))}</div>
      <p class="muted small" style="text-align:center;margin:12px 0 0">Откройте меню сообщения: премиум-реакции в отдельном ряду.</p>
    </div></section>
  </div>`;
}

function _bindPremium() {
  const root = commerceView.el;
  const pro = !!commerceView.catalog?.premium || !!state.user?.isPremium;
  const needPro = () => { toast('Эта функция открывается с Premium', { type: 'info' }); };

  root.querySelectorAll('[data-badge-pick]').forEach((b) => b.addEventListener('click', async () => {
    if (!pro) return needPro();
    const id = b.dataset.badgePick;
    try {
      const r = await Api.updateProfile({ premiumBadge: id });
      if (state.user) Object.assign(state.user, r?.user || { premiumBadge: id });
      bus.emit('user:updated', state.user);
      const cur = $('[data-pm-cur]', root);
      cur.innerHTML = badgeById(id).svg; cur.dataset.badge = id;
      root.querySelectorAll('[data-badge-pick]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      toast('Значок обновлён', { type: 'success', timeout: 1400 });
    } catch (e) { toastError(e); }
  }));

  root.querySelectorAll('[data-wall-pick]').forEach((b) => b.addEventListener('click', () => {
    if (!pro) return needPro();
    bus.emit('settings:change', { wallpaper: b.dataset.wallPick });
    root.querySelectorAll('[data-wall-pick]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));

  const input = $('[data-pm-video]', root);
  input?.addEventListener('click', (e) => { if (!pro) { e.preventDefault(); needPro(); } });
  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!['video/mp4', 'video/webm'].includes(file.type)) return toast('Поддерживаются только MP4 и WebM', { type: 'error' });
    if (file.size > PREMIUM_LIMITS.bannerVideoMB * 1024 * 1024) {
      return toast(`Видео больше ${PREMIUM_LIMITS.bannerVideoMB} МБ. Сожмите его и попробуйте снова`, { type: 'error' });
    }
    const bar = $('[data-pm-bar]', root);
    bar.hidden = false;
    try {
      const up = await api.upload(file, { kind: 'video', onProgress: (p) => { bar.firstElementChild.style.width = `${p}%`; } });
      const r = await Api.updateProfile({ profileBannerVideoMediaId: up.media.id });
      if (state.user) Object.assign(state.user, r?.user || { profileBannerVideo: up.media.url });
      bus.emit('user:updated', state.user);
      toast('Баннер обновлён', { type: 'success' });
      await show();
    } catch (e) { bar.hidden = true; toastError(e); }
  });
  $('[data-pm-video-del]', root)?.addEventListener('click', async () => {
    try {
      const r = await Api.updateProfile({ profileBannerVideoMediaId: null });
      if (state.user) Object.assign(state.user, r?.user || { profileBannerVideo: '' });
      bus.emit('user:updated', state.user);
      await show();
    } catch (e) { toastError(e); }
  });
}
