import { $, html, raw, el } from '../util.js';
import { icons } from '../icons.js';
import { Api, api } from '../api.js?v=20261104-payment-email-1';
import { toast, toastError, confirmDialog, modal } from '../ui.js?v=20261029-no-toasts-1';

export const adminView = { el: null, unlocked: false, gifts: [] };
let adminEventsBound = false;
let adminVerificationEventsBound = false;

export function show() {
  if (!adminView.el) {
    adminView.el = document.createElement('section');
    adminView.el.className = 'admin-screen';
    document.getElementById('root').append(adminView.el);
  }
  adminView.el.classList.remove('hidden');
  render();
}

export function hide() { adminView.el?.classList.add('hidden'); }

async function render() {
  const host = adminView.el;
  host.innerHTML = html`<div class="admin-inner">
    <header class="settings-head"><button class="icon-btn" data-admin-back aria-label="Назад">${raw(icons.back)}</button><h2>Панель администратора</h2></header>
    <div class="admin-grid">
      <button class="admin-card" data-admin-tab="overview">Обзор</button>
      <button class="admin-card" data-admin-tab="users">Пользователи</button>
      <button class="admin-card" data-admin-tab="email-verifications">Подтверждение почты</button>
      <button class="admin-card" data-admin-tab="password-resets">Сброс пароля</button>
      <button class="admin-card" data-admin-tab="support">Поддержка</button>
      <button class="admin-card" data-admin-tab="chats">Группы и каналы</button>
      <button class="admin-card" data-admin-tab="commerce">Premium и Авроры</button>
      <button class="admin-card" data-admin-tab="gifts">Подарки</button>
    </div>
    <div class="admin-content" data-admin-content>Загрузка…</div>
  </div>`;
  $('[data-admin-back]', host).addEventListener('click', () => { location.hash = '#/chats'; });
  if (!adminEventsBound) {
    host.addEventListener('click', onClick);
    adminEventsBound = true;
  }
  if (!adminVerificationEventsBound) {
    host.addEventListener('change', onVerificationChange);
    adminVerificationEventsBound = true;
  }
  await loadTab('overview');
}

async function onVerificationChange(event) {
  const toggle = event.target.closest?.('[data-verified-toggle]');
  if (!toggle) return;
  const verified = toggle.checked;
  toggle.disabled = true;
  try {
    await Api.adminUserAction(toggle.dataset.id, { verified });
    toast(verified ? 'Галочка выдана' : 'Галочка снята', { type: 'success' });
    await loadTab('users');
  } catch (error) {
    toggle.checked = !verified;
    toggle.disabled = false;
    toastError(error);
  }
}

async function onClick(event) {
  const tab = event.target.closest('[data-admin-tab]')?.dataset.adminTab;
  if (tab) await loadTab(tab);
  const action = event.target.closest('[data-admin-action]');
  if (!action) return;
  try {
    if (action.dataset.adminAction === 'freeze-user' || action.dataset.adminAction === 'block-user') {
      const active = action.dataset.active === '1';
      await Api.adminUserAction(action.dataset.id, { [action.dataset.adminAction === 'freeze-user' ? 'frozen' : 'blocked']: !active });
      toast('Действие применено', { type: 'success' });
      await loadTab('users');
    } else if (action.dataset.adminAction === 'issue-password-reset') {
      const result = await Api.adminIssuePasswordReset(action.dataset.id);
      showPasswordResetLink(`${location.origin}${result.resetPath}`);
      await loadTab('password-resets');
    } else if (action.dataset.adminAction === 'badge-user') {
      const badge = adminView.el.querySelector(`[data-badge-select="${action.dataset.id}"]`)?.value || 'verified';
      await Api.adminUserAction(action.dataset.id, { badge });
      toast('Значок выдан', { type: 'success' });
    } else if (action.dataset.adminAction === 'support-status') {
      const result = await Api.adminSupportAction(action.dataset.id, action.dataset.status);
      if (result.chatId && action.dataset.status === 'in_progress') location.hash = `#/chat/${result.chatId}`;
      else await loadTab('support');
    } else if (action.dataset.adminAction === 'support-open') {
      const result = await Api.adminSupportOpen(action.dataset.id);
      location.hash = `#/chat/${result.chatId}`;
    } else if (action.dataset.adminAction === 'freeze-chat' || action.dataset.adminAction === 'delete-chat') {
      if (action.dataset.adminAction === 'delete-chat' && !(await confirmDialog({
        title: 'Удалить чат?',
        text: 'Группа или канал будут удалены для всех участников.',
        confirmLabel: 'Удалить',
        danger: true,
      }))) return;
      await Api.adminChatAction(action.dataset.id, action.dataset.adminAction === 'delete-chat'
        ? { deleted: true }
        : { frozen: action.dataset.value !== '1' });
      toast(action.dataset.adminAction === 'delete-chat' ? 'Чат удалён' : 'Статус чата изменён', { type: 'success' });
      await loadTab('chats');
    } else if (action.dataset.adminAction === 'premium') {
      await Api.adminPremiumAction(action.dataset.id, action.dataset.status);
      toast('Статус Premium обновлён', { type: 'success' });
      await loadTab('commerce');
    } else if (action.dataset.adminAction === 'gift-delete') {
      if (!(await confirmDialog({ title: 'Удалить подарок?', text: 'Он исчезнет из магазина, но уже отправленные подарки сохранятся.', confirmLabel: 'Удалить', danger: true }))) return;
      await Api.adminGiftDelete(action.dataset.id);
      toast('Подарок удалён', { type: 'success' });
      await loadTab('gifts');
    } else if (action.dataset.adminAction === 'gift-create') {
      const payload = await giftPrompt(null, (gift) => Api.adminGiftCreate(gift));
      if (!payload) return;
      toast('Подарок добавлен', { type: 'success' });
      await loadTab('gifts');
    } else if (action.dataset.adminAction === 'gift-edit') {
      const gift = adminView.gifts.find((item) => item.id === action.dataset.id);
      if (!gift) throw new Error('Подарок не найден. Обновите раздел и попробуйте снова.');
      const payload = await giftPrompt(gift, (updated) => Api.adminGiftUpdate(gift.id, updated));
      if (!payload) return;
      toast('Подарок обновлён', { type: 'success' });
      await loadTab('gifts');
    } else if (action.dataset.adminAction === 'gift-toggle') {
      await Api.adminGiftUpdate(action.dataset.id, { isActive: action.dataset.active !== '1' });
      toast('Доступность подарка обновлена', { type: 'success' });
      await loadTab('gifts');
    } else if (action.dataset.adminAction === 'prices') {
      const value = window.prompt('Новые цены Premium через запятую (1м, 3м, 12м), например: 299,799,2499', '299,799,2499');
      if (!value) return;
      const prices = value.split(',').map((v) => Number(v.trim()));
      if (prices.length !== 3 || prices.some((v) => !Number.isInteger(v) || v < 0)) throw new Error('Нужно указать три целых неотрицательных цены');
      const current = await Api.adminCommerce();
      await Api.adminCommerceConfig({ premiumPlans: current.premiumPlans.map((p, i) => ({ ...p, price: prices[i] })) });
      toast('Цены Premium изменены', { type: 'success' });
      await loadTab('commerce');
    }
  } catch (err) { toastError(err); }
}

async function loadTab(tab) {
  const content = $('[data-admin-content]', adminView.el);
  try {
    if (tab === 'overview') {
      const d = await Api.adminOverview();
      content.innerHTML = html`<div class="admin-stats"><div>${d.userCount}<small>пользователей</small></div><div>${d.chatCount}<small>чатов</small></div><div>${d.openRequests}<small>обращений</small></div></div>`;
    } else if (tab === 'users') {
      const d = await Api.adminUsers();
      content.innerHTML = html`<div class="admin-list">${raw(d.users.map((u) => html`<div class="admin-row"><span><b>${u.name}</b><small>@${u.username}</small></span><span class="admin-actions"><label class="admin-verified-toggle"><input type="checkbox" data-verified-toggle data-id="${u.id}" ${u.is_verified ? 'checked' : ''}><span>Галочка</span></label><button class="btn btn-sm" data-admin-action="freeze-user" data-active="${u.is_frozen ? '1' : '0'}" data-id="${u.id}">${u.is_frozen ? 'Разморозить' : 'Заморозить'}</button><button class="btn btn-sm btn-danger" data-admin-action="block-user" data-active="${u.is_blocked ? '1' : '0'}" data-id="${u.id}">${u.is_blocked ? 'Разблокировать' : 'Заблокировать'}</button><select data-badge-select="${u.id}" aria-label="Значок"><option value="owner">Владелец</option><option value="assistant">Помощник</option><option value="admin">Администратор</option><option value="user">Пользователь</option></select><button class="btn btn-sm" data-admin-action="badge-user" data-id="${u.id}">Выдать</button></span></div>`).join(''))}</div>`;
    } else if (tab === 'email-verifications') {
      const d = await Api.adminEmailVerifications();
      content.innerHTML = html`<div class="admin-list">
        <p class="muted">Письмо с кодом отправляется пользователю автоматически. Код действует 10 минут.</p>
        ${raw(d.users.length ? d.users.map((u) => html`<div class="admin-row">
          <span><b>${u.name} · @${u.username}</b><small>${u.email}<br>
            ${u.requestedAt ? `Письмо запрошено: ${new Date(u.requestedAt).toLocaleString('ru-RU')}` : 'Ожидает подтверждения почты'} ·
            подтвердить до ${u.deadlineAt ? new Date(u.deadlineAt).toLocaleString('ru-RU') : '—'}</small></span>
          <span class="admin-actions"><span class="muted small">${u.codeExpiresAt ? 'Код отправлен автоматически' : 'Код не запрошен'}</span></span>
        </div>`).join('') : '<p class="muted">Нет пользователей, ожидающих подтверждения.</p>')}
      </div>`;
    } else if (tab === 'password-resets') {
      const d = await Api.adminPasswordResetRequests();
      content.innerHTML = html`<div class="admin-list">
        <p class="muted">Пользователь запрашивает сброс на экране входа. Создайте одноразовую ссылку и передайте её лично. Ссылка действует один час; при выпуске предыдущая ссылка этого пользователя аннулируется.</p>
        ${raw(d.requests.length ? d.requests.map((request) => html`<div class="admin-row">
          <span><b>${request.name} · @${request.username}</b><small>${request.email}<br>
            Запрос: ${new Date(request.created_at).toLocaleString('ru-RU')} · ${request.status === 'issued' ? 'ссылка уже создавалась' : 'ожидает обработки'}</small></span>
          <span class="admin-actions"><button class="btn btn-sm btn-primary" data-admin-action="issue-password-reset" data-id="${request.id}">Создать ссылку</button></span>
        </div>`).join('') : '<p class="muted">Нет запросов на сброс пароля.</p>')}
      </div>`;
    } else if (tab === 'support') {
      const d = await Api.adminSupport();
      content.innerHTML = html`<div class="admin-list">${raw(d.requests.map((r) => html`<div class="admin-row"><span><b>#${r.id} · ${r.category}</b><small>${r.name} · ${r.status}</small></span><span class="admin-actions">${r.status !== 'closed' ? html`<button class="btn btn-sm" data-admin-action="support-open" data-id="${r.id}">Открыть чат</button><button class="btn btn-sm" data-admin-action="support-status" data-id="${r.id}" data-status="${r.status === 'open' ? 'in_progress' : 'closed'}">${r.status === 'open' ? 'Взять в работу' : 'Закрыть'}</button>` : html`<button class="btn btn-sm" data-admin-action="support-open" data-id="${r.id}">Открыть чат</button>`}</span></div>`).join(''))}</div>`;
    } else if (tab === 'commerce') {
      const d = await Api.adminCommerce();
      adminView.gifts = d.gifts;
      content.innerHTML = html`<div class="admin-list">
        <h3>Заявки Premium</h3>
        ${raw(d.pendingPremium.length ? d.pendingPremium.map((p) => html`<div class="admin-row"><span><b>${p.name}</b><small>@${p.username} · ${p.plan_id}</small></span><span class="admin-actions"><button class="btn btn-sm btn-primary" data-admin-action="premium" data-status="active" data-id="${p.id}">Одобрить</button><button class="btn btn-sm btn-danger" data-admin-action="premium" data-status="rejected" data-id="${p.id}">Отклонить</button></span></div>`).join('') : '<p class="muted">Новых заявок нет.</p>')}
        <h3 style="margin-top:24px">Активные подписки</h3>
        ${raw(d.premium.filter((p) => p.status === 'active').map((p) => html`<div class="admin-row"><span><b>${p.name}</b><small>@${p.username} · до ${new Date(p.expires_at).toLocaleDateString('ru-RU')}</small></span><button class="btn btn-sm btn-danger" data-admin-action="premium" data-status="revoked" data-id="${p.id}">Забрать Premium</button></div>`).join('') || '<p class="muted">Активных подписок нет.</p>')}
        <h3 style="margin-top:24px">Оплаченные покупки · почта для чека</h3>
        <p class="muted small">Почту ввёл покупатель. Отправьте чек через подключённую кассу.</p>
        ${raw(d.paymentOrders.length ? d.paymentOrders.map((order) => html`<div class="admin-row">
          <span><b>${order.kind === 'auroras' ? `${order.units} Аврор` : `Premium · ${order.units} мес.`}</b>
            <small>${order.name} · @${order.username} · ${order.receipt_email || 'Почта не указана'}</small>
            <small>${(order.amount_minor / 100).toLocaleString('ru-RU')} ${order.currency} · ${order.paid_at ? new Date(order.paid_at).toLocaleString('ru-RU') : 'дата не указана'}</small>
          </span>
        </div>`).join('') : '<p class="muted">Оплаченных покупок пока нет.</p>')}
      </div>`;
    } else if (tab === 'gifts') {
      const d = await Api.adminCommerce();
      adminView.gifts = d.gifts;
      content.innerHTML = html`<div class="admin-list">
        <div class="row-between"><div><h3>Каталог подарков</h3><p class="muted small">Загружайте изображение, задавайте редкость, ограниченный тираж и возврат при продаже.</p></div>
          <button class="btn btn-primary btn-sm" data-admin-action="gift-create">Добавить подарок</button></div>
        ${raw(d.gifts.length ? d.gifts.map((g) => html`<div class="admin-row">
          <span class="admin-gift-summary">${g.image_url ? html`<img class="admin-gift-thumb" src="${g.image_url}" alt="">` : ''}<span><b>${g.name}</b>
            <small>${g.price} Аврор · ${g.rarity || 'обычный'} · ${g.description}</small>
            <small>Выдано: ${g.issued_count} · В коллекции: ${g.owned_count} · Продано: ${g.sold_count} · Остаток: ${g.stock_remaining === null ? '∞' : g.stock_remaining} · Возврат: ${g.sellback_percent}% · ${g.is_active ? 'В каталоге' : 'Скрыт'}</small>
          </span></span>
          <span class="admin-actions">
            <button class="btn btn-sm" data-admin-action="gift-edit" data-id="${g.id}">Изменить</button>
            <button class="btn btn-sm" data-admin-action="gift-toggle" data-id="${g.id}" data-active="${g.is_active ? '1' : '0'}">${g.is_active ? 'Отключить' : 'Включить'}</button>
            <button class="btn btn-sm btn-danger" data-admin-action="gift-delete" data-id="${g.id}">${g.issued_count ? 'Архивировать' : 'Удалить'}</button>
          </span>
        </div>`).join('') : '<p class="muted">Каталог подарков пока пуст.</p>')}
      </div>`;
    } else {
      const d = await Api.adminChats();
      content.innerHTML = html`<div class="admin-list">${raw(d.chats.map((c) => html`<div class="admin-row"><span><b>${c.title || 'Без названия'}</b><small>${c.type} · #${c.id}${c.is_frozen ? ' · заморожен' : ''}</small></span><span class="admin-actions"><button class="btn btn-sm" data-admin-action="freeze-chat" data-id="${c.id}" data-value="${c.is_frozen ? '1' : '0'}">${c.is_frozen ? 'Разморозить' : 'Заморозить'}</button><button class="btn btn-sm btn-danger" data-admin-action="delete-chat" data-id="${c.id}">Удалить</button></span></div>`).join(''))}</div>`;
    }
  } catch (err) { content.textContent = err.message; }
}

function showPasswordResetLink(link) {
  const field = el('input', { class: 'input', value: link, readonly: true, 'aria-label': 'Одноразовая ссылка для сброса пароля' });
  const dialog = modal({
    title: 'Ссылка для сброса готова',
    subtitle: 'Скопируйте её и передайте только пользователю, который запросил сброс. Срок действия — один час.',
    body: field,
    footer: [
      el('button', { class: 'btn', onClick: () => dialog.close() }, 'Закрыть'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          toast('Ссылка скопирована', { type: 'success' });
        } catch {
          field.focus();
          field.select();
          toast('Скопируйте выделенную ссылку вручную', { type: 'info' });
        }
      } }, 'Скопировать'),
    ],
  });
  field.addEventListener('focus', () => field.select());
}

async function giftPrompt(existing = null, saveGift) {
  const form = el('form', { class: 'gift-editor-form' });
  const id = el('input', {
    class: 'input',
    required: true,
    maxlength: 40,
    pattern: '[A-Za-z0-9_-]{1,40}',
    title: 'Используйте латинские буквы, цифры, дефис или подчёркивание',
    placeholder: 'Уникальный ID, например galaxy',
    value: existing?.id || '',
  });
  id.readOnly = !!existing;
  const name = el('input', { class: 'input', required: true, maxlength: 80, placeholder: 'Название подарка', value: existing?.name || '' });
  const description = el('textarea', { class: 'textarea', required: true, maxlength: 300, placeholder: 'Описание подарка' });
  description.value = existing?.description || '';
  const price = el('input', { class: 'input', required: true, type: 'number', min: '1', step: '1', placeholder: 'Цена в Аврорах', value: existing?.price || '' });
  const rarity = el('select', { class: 'input' });
  ['обычный', 'необычный', 'редкий', 'эпический', 'легендарный', 'мифический'].forEach((value) => rarity.append(el('option', { value }, value)));
  rarity.value = existing?.rarity || 'обычный';
  const animation = el('select', { class: 'input' });
  ['aurora', 'bloom', 'sparkle', 'diamond', 'crown', 'rocket', 'galaxy'].forEach((value) => animation.append(el('option', { value }, value)));
  animation.value = existing?.animation || 'aurora';
  const stock = el('input', { class: 'input', type: 'number', min: '1', max: '1000000', step: '1', placeholder: 'Пусто — без ограничений', value: existing?.stock_total ?? '' });
  const sellback = el('input', { class: 'input', type: 'number', min: '0', max: '100', step: '1', value: existing?.sellback_percent ?? 50 });
  const active = el('input', { type: 'checkbox' });
  active.checked = existing ? !!existing.is_active : true;
  const file = el('input', { class: 'input', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  file.required = !existing;
  const preview = el('div', { class: 'gift-upload-preview muted' });
  const errorNotice = el('p', { class: 'gift-form-error', role: 'alert', hidden: true });
  let previewUrl = null;
  const setPreview = (src, isObjectUrl = false) => {
    if (previewUrl && previewUrl !== src) URL.revokeObjectURL(previewUrl);
    previewUrl = isObjectUrl ? src : null;
    preview.replaceChildren();
    if (!src) { preview.textContent = 'Загрузите PNG, WebP или GIF'; return; }
    const image = el('img', { src, alt: 'Предпросмотр подарка' });
    preview.append(image);
  };
  setPreview(existing?.image_url || null);
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    if (!selected) { setPreview(existing?.image_url || null); return; }
    setPreview(URL.createObjectURL(selected), true);
  });
  const field = (label, control) => el('label', { class: 'gift-editor-field' }, el('span', { class: 'field-label' }, label), control);
  form.append(
    field('Название', name), field('Описание', description), field('Цена, Авроры', price),
    field('Редкость', rarity), field('Лимит экземпляров', stock),
    field('Процент возврата при продаже', sellback), field('Эффект', animation),
    field('ID подарка', id), field('Изображение подарка (PNG, JPEG, WebP или GIF)', file),
    preview, errorNotice, field('Доступен в каталоге', active),
  );
  return new Promise((resolve) => {
    let result = null;
    let saving = false;
    const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Сохранить изменения' : 'Создать подарок');
    const dialog = modal({
      title: existing ? 'Изменить подарок' : 'Создать подарок',
      subtitle: 'Настройте изображение, стоимость, редкость, количество и возврат при продаже.',
      body: form,
      wide: true,
      footer: [
        el('button', { class: 'btn', type: 'button', onClick: () => dialog.close() }, 'Отмена'),
        submitButton,
      ],
      onClose: () => { if (previewUrl) URL.revokeObjectURL(previewUrl); resolve(result); },
    });
    const save = async (event) => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      saving = true;
      submitButton.disabled = true;
      errorNotice.hidden = true;
      submitButton.textContent = 'Сохранение…';
      try {
        let imageMediaId = existing?.image_media_id || null;
        if (file.files?.[0]) {
          submitButton.textContent = 'Загрузка изображения… 0%';
          const uploaded = await api.upload(file.files[0], {
            kind: 'image',
            onProgress: (progress) => {
              submitButton.textContent = progress < 100
                ? `Загрузка изображения… ${progress}%`
                : 'Обработка изображения…';
            },
          });
          if (uploaded.media?.kind !== 'image') throw new Error('Файл не распознан как изображение. Выберите PNG, JPEG, WebP или GIF.');
          imageMediaId = uploaded.media.id;
        }
        submitButton.textContent = 'Сохранение подарка…';
        const payload = {
          id: id.value.trim(), name: name.value.trim(),
          description: description.value.trim(), price: Number(price.value), rarity: rarity.value,
          animation: animation.value, imageMediaId,
          stockTotal: stock.value.trim() ? Number(stock.value) : null,
          sellbackPercent: Number(sellback.value), isActive: active.checked,
        };
        await saveGift(payload);
        result = payload;
        dialog.close();
      } catch (error) {
        saving = false;
        submitButton.disabled = false;
        submitButton.textContent = existing ? 'Сохранить изменения' : 'Создать подарок';
        errorNotice.textContent = error?.message || 'Не удалось сохранить подарок. Проверьте данные и повторите попытку.';
        errorNotice.hidden = false;
      }
    };
    form.addEventListener('submit', save);
    submitButton.addEventListener('click', save);
  });
}
