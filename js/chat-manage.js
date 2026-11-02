const actionGroups = [
  { id: 'manage', title: 'Управление' },
  { id: 'content', title: 'Публикации и аналитика' },
  { id: 'other', title: 'Другое' },
  { id: 'danger', title: 'Опасная зона' },
];

const actionRules = [
  { pattern: /измен|редакт/i, group: 'manage', color: 'blue', hint: 'Название, описание, фото и тип' },
  { pattern: /добав/i, group: 'manage', color: 'green', hint: 'Пригласить людей из контактов' },
  { pattern: /пригл/i, group: 'manage', color: 'cyan', hint: 'Ссылка-приглашение' },
  { pattern: /заяв/i, group: 'manage', color: 'orange', hint: 'Запросы на вступление' },
  { pattern: /ссыл/i, group: 'manage', color: 'teal', hint: 'Публичная и пригласительные ссылки' },
  { pattern: /участ|админ|прав/i, group: 'manage', color: 'indigo', hint: 'Роли и права' },
  { pattern: /статист/i, group: 'content', color: 'purple', hint: 'Охват и рост аудитории' },
  { pattern: /отлож|заплан/i, group: 'content', color: 'amber', hint: 'Запланированные публикации' },
  { pattern: /закреп/i, group: 'content', color: 'indigo', hint: 'Закреплённые сообщения' },
  { pattern: /жалоб|покин|удал|заблок|выйти/i, group: 'danger', color: 'red', hint: '' },
];

const createElement = (tag, className = '', text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const actionLabel = (button) => (button.querySelector('span')?.textContent || button.textContent || '').trim();
const actionButtons = () => [...document.querySelectorAll('.panel .tg-actions .tg-action')];

function classifyAction(label, button) {
  if (button.classList.contains('danger')) return { group: 'danger', color: 'red', hint: '' };
  return actionRules.find((rule) => rule.pattern.test(label)) || { group: 'other', color: 'gray', hint: '' };
}

function panelKind() {
  const subtitle = document.querySelector('.panel .tg-sub')?.textContent || '';
  if (/канал/i.test(subtitle)) return 'канал';
  if (/групп|участник/i.test(subtitle)) return 'группа';
  return '';
}

let dialog = null;
let returnFocus = null;
let queued = false;

function closeDialog(restoreFocus = true) {
  if (!dialog) return;
  const closingDialog = dialog;
  dialog = null;
  closingDialog.classList.add('closing');
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
  window.setTimeout(() => closingDialog.remove(), 200);
}

function makeIconButton(originalButton) {
  const icon = createElement('span', 'mg-ico');
  icon.dataset.c = 'gray';
  const svg = originalButton.querySelector('svg');
  if (svg) icon.append(svg.cloneNode(true));
  return icon;
}

function openDialog(trigger) {
  if (dialog) return;
  const kind = panelKind();
  const buttons = actionButtons();
  if (!buttons.length) return;

  dialog = createElement('div', 'mg-root');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', kind === 'канал' ? 'Управление каналом' : 'Управление группой');
  returnFocus = trigger;

  const sheet = createElement('div', 'mg-sheet');
  const header = createElement('header', 'mg-head');
  const back = createElement('button', 'mg-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Закрыть');
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  back.addEventListener('click', () => closeDialog());
  header.append(back, createElement('h2', '', kind === 'канал' ? 'Управление каналом' : 'Управление группой'), createElement('span', 'mg-head-sp'));

  const scroll = createElement('div', 'mg-scroll');
  const identity = createElement('div', 'mg-id');
  const avatar = document.querySelector('.panel .tg-id .avatar-wrap')?.cloneNode(true);
  if (avatar) identity.append(avatar);
  identity.append(
    createElement('b', '', document.querySelector('.panel .tg-name')?.textContent.trim() || ''),
    createElement('small', '', document.querySelector('.panel .tg-sub')?.textContent.trim() || ''),
  );
  scroll.append(identity);

  const groupedActions = new Map(actionGroups.map(({ id }) => [id, []]));
  buttons.forEach((button) => {
    const label = actionLabel(button);
    if (!label) return;
    const meta = classifyAction(label, button);
    const row = createElement('button', `mg-row${meta.group === 'danger' ? ' danger' : ''}`);
    row.type = 'button';
    const icon = makeIconButton(button);
    icon.dataset.c = meta.color;
    const text = createElement('span', 'mg-txt');
    text.append(createElement('span', 'mg-label', label));
    if (meta.hint) text.append(createElement('span', 'mg-hint', meta.hint));
    const chevron = createElement('span', 'mg-chev');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    row.append(icon, text, chevron);
    row.addEventListener('click', () => {
      const liveButton = actionButtons().find((candidate) => actionLabel(candidate) === label);
      if (!liveButton) {
        console.error(`Aurora management action is no longer available: ${label}`);
        return;
      }
      liveButton.click();
    });
    groupedActions.get(meta.group).push(row);
  });

  actionGroups.forEach(({ id, title }) => {
    const rows = groupedActions.get(id);
    if (!rows.length) return;
    const section = createElement('section', 'mg-group');
    section.append(createElement('h4', '', title));
    const card = createElement('div', 'mg-card');
    card.append(...rows);
    section.append(card);
    scroll.append(section);
  });

  sheet.append(header, scroll);
  dialog.append(sheet);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  document.body.append(dialog);
  back.focus();
}

function enhanceActionGrid(grid) {
  if (grid.dataset.mg) return;
  const buttons = [...grid.querySelectorAll('.tg-action')];
  const kind = panelKind();
  if (!kind || buttons.length < 5) return;
  grid.dataset.mg = '1';

  const open = createElement('button', 'mg-open');
  open.type = 'button';
  open.setAttribute('aria-haspopup', 'dialog');
  const icon = createElement('span', 'mg-open-ico');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const text = createElement('span', 'mg-open-txt');
  text.append(
    createElement('b', '', kind === 'канал' ? 'Управление каналом' : 'Управление группой'),
    createElement('small', '', 'Редактирование, участники, ссылки, заявки и другое'),
  );
  const chevron = createElement('span', 'mg-chev');
  chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  open.append(icon, text, chevron);
  open.addEventListener('click', () => openDialog(open));
  grid.before(open);
}

function scan() {
  document.querySelectorAll('.panel .tg-actions:not([data-mg])').forEach(enhanceActionGrid);
  if (dialog && !document.querySelector('.panel .tg-actions')) closeDialog(false);
}

document.addEventListener('keydown', (event) => {
  if (!dialog) return;
  if (document.querySelector('.modal-root') && event.key === 'Tab') return;
  if (event.key === 'Escape' && !document.querySelector('.modal-root')) {
    closeDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button:not(:disabled)')];
  if (focusable.length < 2) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    scan();
  });
}).observe(document.documentElement, { childList: true, subtree: true });

scan();
