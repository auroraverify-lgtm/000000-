/**
 * Экран авторизации: вход, пошаговая регистрация (4 окна), восстановление доступа.
 * Каркас создаётся один раз — меняется только карточка, с направленной анимацией «вперёд/назад».
 * Реальная валидация — на сервере, подсказки и проверки «на лету» — на клиенте.
 */
import { api, Api, setToken } from '../api.js?v=20261102-gifts-2';
import { $, $$, el, esc, html, raw, sleep, store9, initials, copyToClipboard } from '../util.js';
import { toast, toastError, AVATAR_COLORS, modal } from '../ui.js?v=20261029-no-toasts-1';
import { icons } from '../icons.js';
import { compressImage, makeThumb } from '../media.js?v=20261028-ux-1';

const root = () => document.getElementById('root');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const USERNAME_RE = /^[a-z0-9_]{4,24}$/;
const LAST_EMAIL_KEY = 'aurora.lastEmail';
const REGISTRATION_DRAFT_KEY = 'aurora.registrationDraft';
const REG_STEPS = 4;
const EMAIL_DOMAINS = ['gmail.com', 'mail.ru', 'yandex.ru', 'icloud.com', 'outlook.com'];
const AVATAR_CROP_SIZE = 320;

function cropAvatar(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const sourceUrl = URL.createObjectURL(file);
    let cropModal = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(sourceUrl);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error('Не удалось открыть это изображение'));
    };
    image.onload = () => {
      const canvas = el('canvas', { class: 'pf-crop-canvas', width: AVATAR_CROP_SIZE, height: AVATAR_CROP_SIZE, 'aria-label': 'Область обрезки фото' });
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(sourceUrl);
        reject(new Error('Браузер не смог подготовить область обрезки'));
        return;
      }
      const zoom = el('input', { class: 'pf-crop-zoom', type: 'range', min: '1', max: '3', step: '0.01', value: '1', 'aria-label': 'Масштаб фото' });
      const hint = el('p', { class: 'muted small pf-crop-hint' }, 'Перетащите фото, чтобы выбрать область. Используйте ползунок для масштаба.');
      const body = el('div', { class: 'pf-crop' }, canvas, el('label', { class: 'field pf-crop-control' }, el('span', { class: 'field-label' }, 'Масштаб'), zoom), hint);
      const baseScale = AVATAR_CROP_SIZE / Math.min(image.naturalWidth, image.naturalHeight);
      let scale = baseScale;
      let offsetX = 0;
      let offsetY = 0;
      let drag = null;

      const clampOffset = () => {
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        offsetX = Math.max((AVATAR_CROP_SIZE - width) / 2, Math.min((width - AVATAR_CROP_SIZE) / 2, offsetX));
        offsetY = Math.max((AVATAR_CROP_SIZE - height) / 2, Math.min((height - AVATAR_CROP_SIZE) / 2, offsetY));
      };
      const draw = () => {
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.clearRect(0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
        context.save();
        context.beginPath();
        context.rect(0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
        context.clip();
        context.drawImage(image, (AVATAR_CROP_SIZE - width) / 2 + offsetX, (AVATAR_CROP_SIZE - height) / 2 + offsetY, width, height);
        context.restore();
      };
      const setZoom = () => {
        const centerX = offsetX;
        const centerY = offsetY;
        scale = baseScale * Number(zoom.value);
        offsetX = centerX * Number(zoom.value);
        offsetY = centerY * Number(zoom.value);
        clampOffset();
        draw();
      };
      zoom.addEventListener('input', setZoom);
      canvas.addEventListener('pointerdown', (event) => {
        drag = { x: event.clientX, y: event.clientY, offsetX, offsetY };
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const bounds = canvas.getBoundingClientRect();
        offsetX = drag.offsetX + (event.clientX - drag.x) * (AVATAR_CROP_SIZE / bounds.width);
        offsetY = drag.offsetY + (event.clientY - drag.y) * (AVATAR_CROP_SIZE / bounds.height);
        clampOffset();
        draw();
      });
      canvas.addEventListener('pointerup', () => { drag = null; });
      canvas.addEventListener('pointercancel', () => { drag = null; });
      draw();

      const cancel = el('button', { class: 'btn', type: 'button', onClick: () => cropModal.close(null) }, 'Отмена');
      const apply = el('button', { class: 'btn btn-primary', type: 'button', onClick: () => {
        apply.disabled = true;
        const output = document.createElement('canvas');
        output.width = 512;
        output.height = 512;
        const outputContext = output.getContext('2d');
        if (!outputContext) {
          apply.disabled = false;
          toast('Не удалось подготовить фото', { type: 'error' });
          return;
        }
        const left = (AVATAR_CROP_SIZE - image.naturalWidth * scale) / 2 + offsetX;
        const top = (AVATAR_CROP_SIZE - image.naturalHeight * scale) / 2 + offsetY;
        const sourceSize = AVATAR_CROP_SIZE / scale;
        outputContext.drawImage(image, -left / scale, -top / scale, sourceSize, sourceSize, 0, 0, output.width, output.height);
        output.toBlob((blob) => {
          if (!blob) {
            apply.disabled = false;
            toast('Не удалось обработать фото', { type: 'error' });
            return;
          }
          const baseName = file.name.replace(/\.[^.]+$/, '');
          cropModal.close(new File([blob], `${baseName || 'avatar'}.webp`, { type: blob.type || 'image/webp' }));
        }, 'image/webp', 0.9);
      } }, 'Использовать фото');
      cropModal = modal({
        title: 'Обрезать фото',
        subtitle: 'Выберите квадратную область для аватара.',
        body,
        footer: [cancel, apply],
        onClose: finish,
      });
    };
    image.src = sourceUrl;
  });
}

let goHandler = null; // один обработчик [data-go] на весь экран — без накопления слушателей
let restoringRegistrationDraft = false;

/* ── Каркас ──────────────────────────────────────────────────────────────── */

function ensureStage() {
  const existing = $('[data-auth-stage]', root());
  if (existing) return existing;
  root().innerHTML = html`<div class="auth">
    <div class="auth-visual">
      <div class="auth-orbs" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-brand">
        <span class="logo">${raw(icons.logo)}</span>
        <span>Aurora Messenger</span>
      </div>
      <div class="auth-headline">
        <h1>Aurora Messenger — мессенджер для общения</h1>
        <p>Личные и групповые чаты, каналы, звонки и истории.</p>
        <ul class="auth-points">
          <li><span>${raw(icons.shield)}</span>Защищённые сессии и вход в два шага</li>
          <li><span>${raw(icons.sparkles)}</span>Голосовые и видеозвонки, стикеры и реакции</li>
          <li><span>${raw(icons.megaphone)}</span>Каналы для любой аудитории</li>
          <li><span>${raw(icons.sparkles)}</span>Истории, фото и видео в чатах</li>
        </ul>
      </div>
    </div>
    <div class="auth-panel">
      <div class="auth-glow" aria-hidden="true"></div>
      <div class="auth-card">
        <div class="auth-mobile-brand"><span class="logo" style="width:34px;height:34px">${raw(icons.logo)}</span> Aurora</div>
        <div class="auth-stage" data-auth-stage></div>
      </div>
    </div>
  </div>`;
  $('.auth', root()).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-go]');
    if (btn) goHandler?.(btn.dataset.go);
  });
  return $('[data-auth-stage]', root());
}

/** Показывает окно с анимацией. dir: next (вперёд) | prev (назад). */
function view(content, dir = 'next') {
  const stage = ensureStage();
  stage.innerHTML = `<div class="auth-view auth-in-${dir}">${content}</div>`;
  const node = stage.firstElementChild;
  if (window.matchMedia('(min-width: 981px)').matches) {
    setTimeout(() => node.querySelector('input:not([type=file]), textarea')?.focus({ preventScroll: true }), 300);
  }
  return node;
}

/* ── Поля ────────────────────────────────────────────────────────────────── */

function fieldHTML({ name, label, type = 'text', icon, autocomplete = 'off', maxlength, hint = '', toggle = false, inputmode = '', value = '' }) {
  return html`<label class="af" data-field="${name}">
    <span class="af-ic">${raw(icons[icon] || '')}</span>
    <input class="af-input" name="${name}" type="${type}" placeholder=" " autocomplete="${autocomplete}" value="${value}"
      autocapitalize="off" autocorrect="off" spellcheck="false"
      ${raw(maxlength ? `maxlength="${maxlength}"` : '')} ${raw(inputmode ? `inputmode="${inputmode}"` : '')}>
    <span class="af-label">${label}</span>
    ${toggle ? html`<button type="button" class="af-toggle" data-toggle-pass tabindex="-1" aria-label="Показать пароль">${raw(icons.eye)}</button>` : ''}
    <span class="af-state" aria-hidden="true"></span>
    <span class="af-msg" data-base="${hint}">${hint}</span>
  </label>`;
}

const fieldEl = (scope, name) => scope.querySelector(`[data-field="${name}"]`);

/** state: idle | checking | ok | error */
function setField(scope, name, state, message) {
  const f = fieldEl(scope, name);
  if (!f) return;
  f.classList.remove('is-checking', 'is-ok', 'is-error', 'is-warn');
  if (state && state !== 'idle') f.classList.add(`is-${state}`);
  const msg = $('.af-msg', f);
  if (msg) msg.textContent = message ?? msg.dataset.base ?? '';
  if (state === 'error') shake(f);
}

function shake(node) {
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 480);
}

const focusField = (scope, name) => fieldEl(scope, name)?.querySelector('input, textarea')?.focus({ preventScroll: true });

function bindToggles(scope) {
  $$('[data-toggle-pass]', scope).forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const input = btn.closest('.af')?.querySelector('input');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    });
  });
}

function busy(button, isBusy, label) {
  if (!button) return;
  button.disabled = isBusy;
  button.classList.toggle('is-busy', isBusy);
  button.innerHTML = isBusy ? `<span class="spinner"></span> ${esc(label)}` : esc(label);
}

/** Проверка «свободно ли» с дебаунсом; wait() — дождаться результата перед переходом дальше. */
function availability(scope, name, fetcher, { okText }) {
  let seq = 0;
  let timer = null;
  let last = 'idle';
  let settled = Promise.resolve();
  return {
    get status() { return last; },
    reset() { clearTimeout(timer); seq++; last = 'idle'; settled = Promise.resolve(); },
    input(value) {
      clearTimeout(timer);
      const id = ++seq;
      last = 'checking';
      setField(scope, name, 'checking', 'Проверяем…');
      settled = new Promise((resolve) => {
        timer = setTimeout(async () => {
          try {
            const res = await fetcher(value);
            const info = res?.[name];
            if (id === seq) {
              if (!info) { last = 'unknown'; setField(scope, name, 'idle'); }
              else if (info.error) { last = 'error'; setField(scope, name, 'error', info.error); }
              else { last = 'ok'; setField(scope, name, 'ok', okText); }
            }
          } catch {
            if (id === seq) { last = 'unknown'; setField(scope, name, 'idle'); }
          }
          resolve();
        }, 380);
      });
    },
    wait() { return settled; },
  };
}

/* ── Блок пароля (регистрация и сброс) ───────────────────────────────────── */

const passwordRules = (p) => ({
  len: p.length >= 8,
  mix: /[a-zA-Zа-яА-Я]/.test(p) && /\d/.test(p),
  bonus: /[A-ZА-Я]/.test(p) || /[^a-zA-Zа-яА-Я0-9]/.test(p),
});

function passwordLevel(p) {
  let level = 0;
  if (p.length >= 8) level++;
  if (/[A-ZА-Я]/.test(p) || /[^a-zA-Zа-яА-Я0-9]/.test(p)) level++;
  if (/\d/.test(p) && /[a-zA-Zа-яА-Я]/.test(p)) level++;
  if (p.length >= 12) level++;
  return Math.min(4, level);
}

function passwordBlockHTML(value = '') {
  return html`
    ${fieldHTML({ name: 'password', label: 'Пароль', type: 'password', icon: 'lock', autocomplete: 'new-password', toggle: true, value })}
    <div class="pw-meter" data-meter data-level="0"><i></i><i></i><i></i><i></i></div>
    <div class="pw-label" data-meter-label>Придумайте пароль</div>
    <ul class="pw-rules">
      <li data-rule="len"><span class="tick">${raw(icons.check)}</span>От 8 символов</li>
      <li data-rule="mix"><span class="tick">${raw(icons.check)}</span>Буквы и цифры</li>
      <li data-rule="bonus"><span class="tick">${raw(icons.check)}</span>Заглавная буква или символ</li>
    </ul>
    ${fieldHTML({ name: 'passwordConfirm', label: 'Повторите пароль', type: 'password', icon: 'key', autocomplete: 'new-password', toggle: true, value })}
    <button type="button" class="af-link" data-gen>${raw(icons.sparkles)} Придумать надёжный пароль</button>`;
}

function bindPasswordBlock(form) {
  const pw = form.elements.password;
  const cf = form.elements.passwordConfirm;
  const meter = $('[data-meter]', form);
  const label = $('[data-meter-label]', form);
  const update = () => {
    const p = pw.value;
    const rules = passwordRules(p);
    $$('[data-rule]', form).forEach((li) => li.classList.toggle('ok', !!rules[li.dataset.rule]));
    const level = passwordLevel(p);
    meter.dataset.level = String(p ? Math.max(1, level) : 0);
    label.textContent = p ? ['', 'Слабый пароль', 'Средний пароль', 'Хороший пароль', 'Отличный пароль'][Math.max(1, level)] : 'Придумайте пароль';
    if (cf.value) {
      if (cf.value === p) setField(form, 'passwordConfirm', 'ok', 'Пароли совпадают');
      else if (p.startsWith(cf.value)) setField(form, 'passwordConfirm', 'idle');
      else setField(form, 'passwordConfirm', 'error', 'Пароли не совпадают');
    } else setField(form, 'passwordConfirm', 'idle');
  };
  pw.addEventListener('input', update);
  cf.addEventListener('input', update);
  $('[data-gen]', form).addEventListener('click', () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join('');
    const value = `${pick(letters, 9)}${pick('23456789', 3)}${pick('!@#$%*?', 1)}${pick(letters, 2)}`;
    pw.value = value; cf.value = value;
    pw.type = 'text'; cf.type = 'text';
    $$('[data-toggle-pass]', form).forEach((b) => b.classList.add('on'));
    update();
    copyToClipboard(value).then(() => toast('Пароль придуман и скопирован — сохраните его', { type: 'success' }), () => toast('Пароль придуман — сохраните его', { type: 'info' }));
  });
  update();
  return {
    validate() {
      const p = pw.value;
      const rules = passwordRules(p);
      if (p.length < 8) { setField(form, 'password', 'error', 'Пароль короче 8 символов'); focusField(form, 'password'); return false; }
      if (!rules.mix) { setField(form, 'password', 'error', 'Нужны и буквы, и цифры'); focusField(form, 'password'); return false; }
      if (p !== cf.value) { setField(form, 'passwordConfirm', 'error', 'Пароли не совпадают'); focusField(form, 'passwordConfirm'); return false; }
      return true;
    },
    value: () => pw.value,
  };
}

/* ── Вход ────────────────────────────────────────────────────────────────── */

export function renderLogin({ onDone, dir = 'next' }) {
  const savedDraft = readRegistrationDraft();
  if (savedDraft) {
    if (restoringRegistrationDraft) return;
    restoringRegistrationDraft = true;
    renderRegister({ onDone, draft: savedDraft });
    return;
  }
  restoringRegistrationDraft = false;
  goHandler = (t) => {
    if (t === 'register') renderRegister({ onDone });
    if (t === 'forgot') renderForgot({ onDone });
  };
  const lastEmail = store9.get(LAST_EMAIL_KEY, '');
  const v = view(html`
    <div class="auth-badge">${raw(icons.user)}</div>
    <h2>С возвращением</h2>
    <p class="lead">Войдите, чтобы продолжить общение.</p>
    <form class="auth-form" novalidate>
      ${fieldHTML({ name: 'email', label: 'E-mail', type: 'email', icon: 'mail', autocomplete: 'email', inputmode: 'email', value: lastEmail })}
      ${fieldHTML({ name: 'password', label: 'Пароль', type: 'password', icon: 'lock', autocomplete: 'current-password', toggle: true })}
      <div data-two-factor-step hidden>
        ${fieldHTML({ name: 'code', label: 'Код из приложения-аутентификатора', type: 'text', icon: 'key', autocomplete: 'one-time-code', inputmode: 'numeric' })}
        <p class="muted small" data-two-factor-hint></p>
      </div>
      <div data-protective-password-step hidden>
        ${fieldHTML({ name: 'protectivePassword', label: 'Защитный пароль', type: 'password', icon: 'lock', autocomplete: 'current-password', toggle: true })}
        <p class="muted small" data-protective-password-hint></p>
      </div>
      <div class="auth-row-end"><button type="button" class="af-link" data-go="forgot">Забыли пароль?</button></div>
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>Войти</button>
    </form>
    <div class="auth-alt">Нет аккаунта? <button type="button" data-go="register">Создать аккаунт</button></div>
  `, dir);

  const form = $('form', v);
  bindToggles(form);
  form.elements.password.addEventListener('keydown', (e) => {
    const caps = e.getModifierState?.('CapsLock');
    const f = fieldEl(form, 'password');
    if (caps) { f.classList.add('is-warn'); $('.af-msg', f).textContent = 'Включён Caps Lock'; }
    else if (f.classList.contains('is-warn')) setField(form, 'password', 'idle');
  });
  ['email', 'password', 'code', 'protectivePassword'].forEach((n) => form.elements[n].addEventListener('input', () => setField(form, n, 'idle')));
  if (lastEmail) setTimeout(() => form.elements.password.focus({ preventScroll: true }), 320);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!EMAIL_RE.test(email)) { setField(form, 'email', 'error', 'Введите корректный e-mail'); focusField(form, 'email'); return; }
    if (!password) { setField(form, 'password', 'error', 'Введите пароль'); focusField(form, 'password'); return; }
    const button = $('[data-submit]', form);
    busy(button, true, 'Входим…');
    try {
      const data = await Api.login({
        email,
        password,
        ...(form.elements.code.value ? { code: form.elements.code.value.trim() } : {}),
        ...(form.elements.protectivePassword.value ? { protectivePassword: form.elements.protectivePassword.value } : {}),
      });
      if (data.stepRequired === 'two_factor') {
        $('[data-two-factor-step]', form).hidden = false;
        $('[data-two-factor-hint]', form).textContent = data.invalid ? 'Код неверный. Попробуйте ещё раз.' : 'Для этого аккаунта включена двухфакторная аутентификация.';
        busy(button, false, 'Продолжить');
        form.elements.code.focus();
        return;
      }
      if (data.stepRequired === 'protective_password') {
        $('[data-protective-password-step]', form).hidden = false;
        $('[data-protective-password-hint]', form).textContent = data.invalid ? 'Защитный пароль неверный.' : 'Введите защитный пароль для продолжения.';
        busy(button, false, 'Продолжить');
        form.elements.protectivePassword.focus();
        return;
      }
      if (data.stepRequired === 'protective_password_setup') {
        renderProtectivePasswordSetup({ onDone, setupToken: data.setupToken });
        return;
      }
      setToken(data.token);
      store9.set(LAST_EMAIL_KEY, email);
      toast(`С возвращением, ${data.user.name}!`, { type: 'success' });
      onDone(data);
    } catch (err) {
      busy(button, false, 'Войти');
      if (err.field === 'email') { setField(form, 'email', 'error', err.message); focusField(form, 'email'); }
      else if (err.field === 'password') { setField(form, 'password', 'error', err.message); form.elements.password.select?.(); }
      else { shake($('.auth-form', v)); toastError(err); }
    }
  });
}

function renderProtectivePasswordSetup({ onDone, setupToken }) {
  goHandler = (t) => { if (t === 'login') renderLogin({ onDone, dir: 'prev' }); };
  const v = view(html`
    <div class="auth-badge">${raw(icons.lock)}</div>
    <h2>Защитите вход</h2>
    <p class="lead">Для продолжения задайте защитный пароль. Он будет запрашиваться после обычного пароля при следующих входах.</p>
    <form class="auth-form" novalidate>
      ${fieldHTML({ name: 'protectivePassword', label: 'Защитный пароль', type: 'password', icon: 'lock', autocomplete: 'new-password', toggle: true })}
      ${fieldHTML({ name: 'confirmProtectivePassword', label: 'Повторите защитный пароль', type: 'password', icon: 'key', autocomplete: 'new-password', toggle: true })}
      <p class="muted small">Минимум 6 символов. Не используйте основной пароль аккаунта.</p>
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>Сохранить и войти</button>
    </form>
  `);
  const form = $('form', v);
  bindToggles(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const protectivePassword = form.elements.protectivePassword.value;
    if (protectivePassword.length < 6) {
      setField(form, 'protectivePassword', 'error', 'Защитный пароль должен содержать минимум 6 символов');
      focusField(form, 'protectivePassword');
      return;
    }
    if (protectivePassword !== form.elements.confirmProtectivePassword.value) {
      setField(form, 'confirmProtectivePassword', 'error', 'Пароли не совпадают');
      focusField(form, 'confirmProtectivePassword');
      return;
    }
    const button = $('[data-submit]', form);
    busy(button, true, 'Сохраняем…');
    try {
      const data = await Api.setupProtectivePasswordAfterLogin(setupToken, protectivePassword);
      setToken(data.token);
      toast(`С возвращением, ${data.user.name}!`, { type: 'success' });
      onDone(data);
    } catch (err) {
      busy(button, false, 'Сохранить и войти');
      toastError(err);
    }
  });
}

/* ── Регистрация: 4 окна ─────────────────────────────────────────────────── */

function readRegistrationDraft() {
  const saved = sessionStorage.getItem(REGISTRATION_DRAFT_KEY);
  if (!saved) return null;
  try {
    const draft = JSON.parse(saved);
    if (!draft || typeof draft !== 'object') return null;
    return {
      step: Number.isInteger(draft.step) ? Math.min(Math.max(draft.step, 0), REG_STEPS - 1) : 0,
      name: typeof draft.name === 'string' ? draft.name.slice(0, 64) : '',
      username: typeof draft.username === 'string' ? draft.username.slice(0, 24) : '',
      email: typeof draft.email === 'string' ? draft.email.slice(0, 254) : '',
      bio: typeof draft.bio === 'string' ? draft.bio.slice(0, 400) : '',
      color: typeof draft.color === 'string' ? draft.color : 'ocean',
      legalConsent: draft.legalConsent === true,
      personalDataConsent: draft.personalDataConsent === true,
      ageGuardianAttestation: draft.ageGuardianAttestation === true,
      passwordNeedsReentry: draft.passwordNeedsReentry === true,
    };
  } catch (error) {
    console.warn('Не удалось восстановить черновик регистрации:', error);
    sessionStorage.removeItem(REGISTRATION_DRAFT_KEY);
    return null;
  }
}

function clearRegistrationDraft() {
  sessionStorage.removeItem(REGISTRATION_DRAFT_KEY);
}

export function renderRegister({ onDone, draft = null }) {
  const data = {
    name: draft?.name || '',
    username: draft?.username || '',
    email: draft?.email || '',
    password: '',
    bio: draft?.bio || '',
    color: AVATAR_COLORS.some((color) => color.id === draft?.color) ? draft.color : 'ocean',
    avatarFile: null,
    previewUrl: null,
    legalConsent: Boolean(draft?.legalConsent),
    personalDataConsent: Boolean(draft?.personalDataConsent),
    ageGuardianAttestation: Boolean(draft?.ageGuardianAttestation),
    passwordNeedsReentry: Boolean(draft?.passwordNeedsReentry || Number(draft?.step) >= 3),
  };
  let currentStep = Math.min(Math.max(Number(draft?.step) || 0, 0), REG_STEPS - 1);
  if (currentStep === 3) currentStep = 2;
  const saveDraft = () => {
    sessionStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify({
      step: currentStep,
      name: data.name,
      username: data.username,
      email: data.email,
      bio: data.bio,
      color: data.color,
      legalConsent: data.legalConsent,
      personalDataConsent: data.personalDataConsent,
      ageGuardianAttestation: data.ageGuardianAttestation,
      passwordNeedsReentry: data.passwordNeedsReentry,
    }));
  };
  const returnToLogin = () => {
    clearRegistrationDraft();
    restoringRegistrationDraft = false;
    renderLogin({ onDone, dir: 'prev' });
  };
  goHandler = (t) => { if (t === 'login') returnToLogin(); };
  const steps = [stepIdentity, stepEmail, stepPassword, stepProfile];
  const go = (i, dir = 'next') => {
    currentStep = i;
    saveDraft();
    goHandler = (t) => { if (t === 'login') returnToLogin(); };
    steps[i](dir);
  };

  const frame = (step, { title, lead, body, cta }) => html`
    <div class="wz-top">
      <button type="button" class="wz-back" data-wz-back aria-label="Назад">${raw(icons.back)}</button>
      <div class="wz-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${REG_STEPS}" aria-valuenow="${step + 1}">
        <i style="--from:${(step / REG_STEPS) * 100}%;--to:${((step + 1) / REG_STEPS) * 100}%"></i>
      </div>
      <span class="wz-count">${step + 1} / ${REG_STEPS}</span>
    </div>
    <h2>${title}</h2>
    <p class="lead">${lead}</p>
    <form class="auth-form" novalidate>
      ${body}
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>${cta}</button>
    </form>
    <div class="auth-alt">Уже есть аккаунт? <button type="button" data-go="login">Войти</button></div>`;

  const bindBack = (v, step) => $('[data-wz-back]', v).addEventListener('click', () => (step === 0 ? returnToLogin() : go(step - 1, 'prev')));

  /* 1 · Знакомство */
  function stepIdentity(dir) {
    const v = view(frame(0, {
      title: 'Давайте знакомиться',
      lead: 'Как вас зовут и каким будет ваш username?',
      body: html`
        ${fieldHTML({ name: 'displayName', label: 'Имя', icon: 'user', autocomplete: 'name', maxlength: 64, value: data.name })}
        ${fieldHTML({ name: 'username', label: 'Username', icon: 'at', maxlength: 24, hint: 'Латиница, цифры и _ · от 4 до 24 символов', value: data.username })}`,
      cta: 'Далее',
    }), dir);
    const form = $('form', v);
    bindBack(v, 0);
    const nameIn = form.elements.displayName;
    const userIn = form.elements.username;
    const avail = availability(form, 'username', (value) => Api.checkAvailability({ username: value }), { okText: 'Формат username подходит' });
    nameIn.addEventListener('input', () => setField(form, 'displayName', 'idle'));
    userIn.addEventListener('input', () => {
      userIn.value = userIn.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      if (userIn.value.length < 4) { avail.reset(); setField(form, 'username', 'idle'); return; }
      avail.input(userIn.value);
    });
    if (data.username.length >= 4) avail.input(data.username);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      const username = userIn.value.trim().toLowerCase();
      let bad = false;
      if (name.length < 2) { setField(form, 'displayName', 'error', 'Имя — минимум 2 символа'); bad = true; }
      if (!USERNAME_RE.test(username)) { setField(form, 'username', 'error', 'Латиница, цифры и _ · от 4 до 24 символов'); bad = true; }
      if (bad) { focusField(form, name.length < 2 ? 'displayName' : 'username'); return; }
      await avail.wait();
      if (avail.status === 'error') { shake(fieldEl(form, 'username')); focusField(form, 'username'); return; }
      data.name = name; data.username = username;
      go(1);
    });
  }

  /* 2 · Почта */
  function stepEmail(dir) {
    const v = view(frame(1, {
      title: 'Ваша почта',
      lead: 'Она нужна для входа и восстановления пароля. Мы не рассылаем спам.',
      body: html`
        ${fieldHTML({ name: 'email', label: 'E-mail', type: 'email', icon: 'mail', autocomplete: 'email', inputmode: 'email', hint: 'Например, you@example.com', value: data.email })}
        <div class="af-suggest" data-suggest hidden></div>`,
      cta: 'Далее',
    }), dir);
    const form = $('form', v);
    bindBack(v, 1);
    const input = form.elements.email;
    const suggest = $('[data-suggest]', form);
    const avail = availability(form, 'email', (value) => Api.checkAvailability({ email: value }), { okText: 'Формат адреса подходит' });
    const onInput = () => {
      const value = input.value.trim();
      const at = value.indexOf('@');
      if (at > 0 && !value.slice(at + 1).includes('.')) {
        const typed = value.slice(at + 1).toLowerCase();
        const list = EMAIL_DOMAINS.filter((d) => d.startsWith(typed));
        suggest.innerHTML = list.map((d) => `<button type="button" data-domain="${d}">@${d}</button>`).join('');
        suggest.hidden = !list.length;
      } else suggest.hidden = true;
      if (EMAIL_RE.test(value)) avail.input(value);
      else { avail.reset(); setField(form, 'email', 'idle'); }
    };
    input.addEventListener('input', onInput);
    suggest.addEventListener('click', (e) => {
      const b = e.target.closest('[data-domain]');
      if (!b) return;
      input.value = `${input.value.trim().split('@')[0]}@${b.dataset.domain}`;
      input.focus();
      onInput();
    });
    if (EMAIL_RE.test(data.email)) avail.input(data.email);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!EMAIL_RE.test(email)) { setField(form, 'email', 'error', 'Проверьте адрес — например, you@example.com'); input.focus(); return; }
      await avail.wait();
      if (avail.status === 'error') { shake(fieldEl(form, 'email')); return; }
      data.email = email;
      go(2);
    });
  }

  /* 3 · Пароль */
  function stepPassword(dir) {
    const v = view(frame(2, {
      title: 'Надёжный пароль',
      lead: data.passwordNeedsReentry
        ? 'Данные регистрации сохранены. Введите пароль ещё раз — мы не сохраняем его на устройстве.'
        : 'Он защищает вашу переписку. Можно придумать его автоматически.',
      body: passwordBlockHTML(data.password),
      cta: 'Далее',
    }), dir);
    const form = $('form', v);
    bindBack(v, 2);
    bindToggles(form);
    const block = bindPasswordBlock(form);
    ['password', 'passwordConfirm'].forEach((n) => form.elements[n].addEventListener('input', () => { if (n === 'password') setField(form, 'password', 'idle'); }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!block.validate()) return;
      data.password = block.value();
      data.passwordNeedsReentry = false;
      go(3);
    });
  }

  /* 4 · Профиль */
  function stepProfile(dir) {
    const v = view(frame(3, {
      title: 'Ваш профиль',
      lead: 'Добавьте фото или выберите цвет — остальное можно изменить позже.',
      body: html`
        <div class="pf-avatar">
          <label class="pf-drop" data-pf-drop data-c="${data.color}" title="Выбрать фото">
            <span data-ph>${data.previewUrl ? raw(`<img src="${esc(data.previewUrl)}" alt="">`) : raw(`<b>${esc(initials(data.name))}</b>`)}</span>
            <span class="pf-cam">${raw(icons.camera)}</span>
            <input type="file" accept="image/*" hidden data-pf-input>
          </label>
          <div class="pf-colors" data-colors>
            ${raw(AVATAR_COLORS.map((c) => `<button type="button" class="pf-dot" data-c="${c.id}" aria-label="${esc(c.label)}" aria-checked="${c.id === data.color}"></button>`).join(''))}
          </div>
        </div>
        <label class="af af-area" data-field="bio">
          <textarea class="af-input" name="bio" maxlength="400" rows="3" placeholder=" ">${esc(data.bio)}</textarea>
          <span class="af-label">О себе · необязательно</span>
          <span class="af-count" data-count>${data.bio.length}/400</span>
          <span class="af-msg" data-base=""></span>
        </label>
        <div class="pf-preview" data-preview>
          <span class="pf-mini" data-pf-mini data-c="${data.color}"></span>
          <span class="pf-text"><b data-pv-name></b><small data-pv-user></small><em data-pv-bio></em></span>
        </div>`,
      cta: 'Создать аккаунт',
    }), dir);
    const form = $('form', v);
    bindBack(v, 3);
    const drop = $('[data-pf-drop]', form);
    const mini = $('[data-pf-mini]', form);
    const bio = form.elements.bio;
    const legalConsent = el('section', { class: 'auth-legal-consent', 'aria-label': 'Документы и согласия' },
      el('div', { class: 'auth-legal-heading' },
        el('span', { class: 'auth-legal-icon', 'aria-hidden': 'true' }, raw(icons.shield)),
        el('div', {},
          el('strong', {}, 'Перед созданием аккаунта'),
          el('p', {}, 'Откройте документы в новой вкладке — ваши данные и отметки останутся здесь.'),
        ),
      ),
      el('label', { class: 'auth-legal-item' },
        el('input', { type: 'checkbox', name: 'legalConsent', required: true }),
        el('span', {},
          el('span', { class: 'auth-legal-copy' }, 'Я прочитал(а) и принимаю условия'),
          el('span', { class: 'auth-legal-link-row' },
            el('a', { class: 'auth-legal-link', href: '/terms.html', target: '_blank', rel: 'noopener noreferrer' }, 'Пользовательское соглашение'),
            el('span', {}, 'и'),
            el('a', { class: 'auth-legal-link', href: '/privacy.html', target: '_blank', rel: 'noopener noreferrer' }, 'Политика конфиденциальности'),
          ),
        ),
      ),
      el('label', { class: 'auth-legal-item' },
        el('input', { type: 'checkbox', name: 'personalDataConsent', required: true }),
        el('span', {},
          el('span', { class: 'auth-legal-copy' }, 'Я отдельно согласен(на) на обработку персональных данных для работы сервиса'),
          el('span', { class: 'auth-legal-link-row' }, el('a', { class: 'auth-legal-link', href: '/privacy.html', target: '_blank', rel: 'noopener noreferrer' }, 'Подробнее в политике конфиденциальности')),
        ),
      ),
      el('label', { class: 'auth-legal-item' },
        el('input', { type: 'checkbox', name: 'ageGuardianAttestation', required: true }),
        el('span', { class: 'auth-legal-copy' }, 'Мне не менее 6 лет. Если мне нет 14 лет, родитель или законный представитель прочитал документы и согласен на регистрацию.'),
      ),
    );
    const preview = $('[data-preview]', form);
    preview.insertAdjacentElement('afterend', legalConsent);
    const legalCheck = form.elements.legalConsent;
    const personalDataCheck = form.elements.personalDataConsent;
    const ageGuardianCheck = form.elements.ageGuardianAttestation;
    legalCheck.checked = data.legalConsent;
    personalDataCheck.checked = data.personalDataConsent;
    ageGuardianCheck.checked = data.ageGuardianAttestation;
    const persistConsents = () => {
      data.legalConsent = legalCheck.checked;
      data.personalDataConsent = personalDataCheck.checked;
      data.ageGuardianAttestation = ageGuardianCheck.checked;
      saveDraft();
    };
    legalConsent.addEventListener('change', persistConsents);
    legalConsent.addEventListener('click', (event) => { if (event.target.closest('a')) saveDraft(); });
    saveDraft();
    let avatarUpload = Promise.resolve();

    const paintPreview = () => {
      $('[data-pv-name]', form).textContent = data.name;
      $('[data-pv-user]', form).textContent = `@${data.username}`;
      $('[data-pv-bio]', form).textContent = bio.value.trim() || 'Здесь появится ваше описание';
      mini.dataset.c = data.color;
      mini.innerHTML = data.previewUrl ? `<img src="${esc(data.previewUrl)}" alt="">` : esc(initials(data.name));
      $('[data-count]', form).textContent = `${bio.value.length}/400`;
    };
    paintPreview();
    bio.addEventListener('input', () => { data.bio = bio.value; paintPreview(); saveDraft(); });

    $('[data-colors]', form).addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      data.color = b.dataset.c;
      $$('.pf-dot', form).forEach((d) => d.setAttribute('aria-checked', String(d === b)));
      drop.dataset.c = data.color;
      paintPreview();
      saveDraft();
    });

    const setAvatar = async (file) => {
      if (!file) return;
      if (!file.type.startsWith('image/')) return toast('Аватар должен быть изображением', { type: 'error' });
      if (file.size > 8 * 1024 * 1024) return toast('Изображение больше 8 МБ', { type: 'error' });
      try {
        const cropped = await cropAvatar(file);
        if (!cropped) return;
        if (data.previewUrl) URL.revokeObjectURL(data.previewUrl);
        data.avatarFile = cropped;
        data.previewUrl = URL.createObjectURL(cropped);
        $('[data-ph]', drop).innerHTML = `<img src="${esc(data.previewUrl)}" alt="">`;
        paintPreview();
      } catch (err) {
        toastError(err);
      }
    };
    $('[data-pf-input]', form).addEventListener('change', (e) => {
      avatarUpload = setAvatar(e.target.files?.[0]);
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { avatarUpload = setAvatar(e.dataTransfer?.files?.[0]); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!legalCheck.checked || !personalDataCheck.checked || !ageGuardianCheck.checked) {
        toast('Примите документы и подтвердите возраст/согласие представителя для регистрации', { type: 'error' });
        return;
      }
      const button = $('[data-submit]', form);
      busy(button, true, 'Создаём аккаунт…');
      try {
        await avatarUpload;
        const registered = await Api.register({
          name: data.name, username: data.username, email: data.email, password: data.password,
          bio: bio.value.trim(),
          termsVersion: '2026-10-30-v2',
          privacyVersion: '2026-10-30-v2',
          personalDataConsent: personalDataCheck.checked,
          ageGuardianAttestation: ageGuardianCheck.checked,
        });
        clearRegistrationDraft();
        restoringRegistrationDraft = false;
        store9.set(LAST_EMAIL_KEY, data.email);
        await completeRegistration(registered);
      } catch (err) {
        busy(button, false, 'Создать аккаунт');
        // Ошибка относится к другому шагу — возвращаем человека туда, где её можно исправить
        const back = { username: 0, name: 0, email: 1, password: 2 }[err.field];
        if (back !== undefined) { go(back, 'prev'); setTimeout(() => { const n = { name: 'displayName' }[err.field] || err.field; setField($('form', $('[data-auth-stage]')), n, 'error', err.message); }, 360); }
        else { shake($('.auth-form', v)); toastError(err); }
      }
    });

    async function completeRegistration(res) {
      setToken(res.token);
      try {
        const profile = { avatarColor: data.color };
        if (data.avatarFile) {
          const button = $('[data-submit]', $('[data-auth-stage]'));
          busy(button, true, 'Загружаем фото…');
          try {
            const { file: compressed } = await compressImage(data.avatarFile, { maxDim: 512, quality: 0.9 });
            const thumb = await makeThumb(compressed, { maxDim: 256, quality: 0.8 });
            const uploaded = await api.upload(compressed, { kind: 'avatar', thumb, width: 512, height: 512 });
            profile.avatarMediaId = uploaded.media.id;
          } catch (err) {
            toastError(new Error(`Аккаунт создан, но фото не удалось загрузить: ${err.message}`));
          }
        }
        const updated = await Api.updateProfile(profile);
        res.user = updated.user;
        res.settings = updated.settings;
      } catch (err) {
        toastError(new Error(`Аккаунт создан, но настройки профиля не удалось сохранить: ${err.message}`));
      }
      if (data.previewUrl) URL.revokeObjectURL(data.previewUrl);
      renderEmailVerification({ onDone, account: res, delivery: res.emailVerification });
    }
  }

  go(draft ? currentStep : 0, draft ? 'prev' : 'next');
}

/* ── Восстановление доступа ──────────────────────────────────────────────── */

function renderEmailVerification({ onDone, account, delivery = {} }) {
  goHandler = (target) => {
    if (target === 'login') renderLogin({ onDone, dir: 'prev' });
  };
  const v = view(html`
    <button type="button" class="wz-back solo" data-go="login" aria-label="Назад">${raw(icons.back)}</button>
    <div class="auth-badge">${raw(icons.key)}</div>
    <h2>Подтвердите почту</h2>
    <p class="lead">Введите шестизначный код из письма, отправленного на <b data-email-address>${delivery.email || account.user.email}</b>. Код действует 10 минут.</p>
    <form class="auth-form" data-verification-form novalidate>
      ${fieldHTML({ name: 'code', label: 'Код из письма', type: 'text', icon: 'key', autocomplete: 'one-time-code', maxlength: 6, inputmode: 'numeric' })}
      <p class="muted small" data-verification-status aria-live="polite">${delivery.sent ? 'Письмо отправлено. Проверьте также папку «Спам».' : delivery.message || 'Не удалось отправить письмо. Попробуйте ещё раз позже.'}</p>
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>Подтвердить</button>
    </form>
    <div class="auth-alt">
      <button type="button" data-resend-code>Отправить код повторно</button>
      <p class="muted small" data-resend-timer aria-live="polite"></p>
      <button type="button" data-toggle-email>Изменить почту</button>
      <form class="auth-form" data-change-email-form hidden novalidate>
        ${fieldHTML({ name: 'email', label: 'Новый e-mail', type: 'email', icon: 'mail', autocomplete: 'email', inputmode: 'email' })}
        <button class="btn btn-primary btn-block" type="submit" data-change-email-submit>Сохранить почту</button>
      </form>
      <button type="button" data-go="login">Войти позже</button>
    </div>
  `);
  const form = $('[data-verification-form]', v);
  const codeInput = form.elements.code;
  const status = $('[data-verification-status]', v);
  const resend = $('[data-resend-code]', v);
  const timer = $('[data-resend-timer]', v);
  let seconds = Math.max(0, Number(delivery.retryAfter) || 0);
  let timerId = null;
  const renderTimer = () => {
    resend.disabled = seconds > 0;
    timer.textContent = seconds > 0 ? `Повторная отправка через ${seconds} с.` : '';
  };
  const startTimer = (value) => {
    clearInterval(timerId);
    seconds = Math.max(0, Number(value) || 0);
    renderTimer();
    if (seconds > 0) timerId = setInterval(() => { seconds -= 1; renderTimer(); if (!seconds) clearInterval(timerId); }, 1000);
  };
  startTimer(seconds);
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(codeInput.value)) {
      setField(form, 'code', 'error', 'Введите шестизначный код');
      return;
    }
    const button = $('[data-submit]', form);
    busy(button, true, 'Проверяем…');
    try {
      const verified = await Api.verifyEmailCode(codeInput.value);
      clearInterval(timerId);
      status.textContent = 'Почта успешно подтверждена.';
      await sleep(350);
      onDone({ ...account, user: verified.user });
    } catch (error) {
      busy(button, false, 'Подтвердить');
      status.textContent = error.message;
      codeInput.focus();
    }
  });
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    status.textContent = 'Отправляем код…';
    try {
      const result = await Api.requestEmailVerificationCode();
      if (result.alreadyVerified) {
        onDone({ ...account, user: result.user || account.user });
        return;
      }
      $('[data-email-address]', v).textContent = result.email || account.user.email;
      status.textContent = result.message;
      startTimer(result.retryAfter || 60);
    } catch (error) {
      status.textContent = error.message;
      startTimer(0);
    }
  });
  const changeForm = $('[data-change-email-form]', v);
  $('[data-toggle-email]', v).addEventListener('click', () => {
    changeForm.hidden = !changeForm.hidden;
    if (!changeForm.hidden) changeForm.elements.email.focus();
  });
  changeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nextEmail = changeForm.elements.email.value.trim();
    if (!EMAIL_RE.test(nextEmail)) {
      setField(changeForm, 'email', 'error', 'Введите корректный e-mail');
      return;
    }
    const button = $('[data-change-email-submit]', changeForm);
    busy(button, true, 'Сохраняем…');
    try {
      const result = await Api.changeEmail(nextEmail);
      account.user = result.user;
      if (result.emailVerification.alreadyVerified) {
        onDone({ ...account, user: result.user });
        return;
      }
      $('[data-email-address]', v).textContent = result.emailVerification.email || nextEmail;
      status.textContent = result.emailVerification.sent
        ? 'Код отправлен на новый адрес. Он действует 10 минут.'
        : result.emailVerification.message || 'Не удалось отправить письмо. Попробуйте ещё раз позже.';
      changeForm.hidden = true;
      changeForm.elements.email.value = '';
      startTimer(result.emailVerification.retryAfter || 0);
    } catch (error) {
      busy(button, false, 'Сохранить почту');
      setField(changeForm, error.field || 'email', 'error', error.message);
    }
  });
}

export function renderForgot({ onDone, token = null }) {
  if (token) return renderReset({ onDone, token });
  goHandler = (t) => { if (t === 'login') renderLogin({ onDone, dir: 'prev' }); };
  const v = view(html`
    <button type="button" class="wz-back solo" data-go="login" aria-label="Назад">${raw(icons.back)}</button>
    <div class="auth-badge">${raw(icons.key)}</div>
    <h2>Восстановление доступа</h2>
    <p class="lead">Укажите e-mail, связанный с аккаунтом. Результат запроса не раскрывает, зарегистрирован ли адрес.</p>
    <form class="auth-form" novalidate>
      ${fieldHTML({ name: 'email', label: 'E-mail', type: 'email', icon: 'mail', autocomplete: 'email', inputmode: 'email' })}
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>Отправить ссылку</button>
    </form>
    <div class="auth-alt"><button type="button" data-go="login">Вспомнили пароль? Войти</button></div>
  `);
  const form = $('form', v);
  form.elements.email.addEventListener('input', () => setField(form, 'email', 'idle'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    if (!EMAIL_RE.test(email)) { setField(form, 'email', 'error', 'Введите корректный e-mail'); return; }
    const button = $('[data-submit]', form);
    busy(button, true, 'Отправляем…');
    try {
      const res = await Api.forgot(email);
      goHandler = (t) => { if (t === 'login') renderLogin({ onDone, dir: 'prev' }); };
      const sent = view(html`
        <div class="auth-success">
          <div class="ok-ring"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 14-16"/></svg></div>
          <h2>Запрос принят</h2>
          <p class="lead">${res.message}</p>
          <div class="auth-alt"><button type="button" data-go="login">Вернуться ко входу</button></div>
        </div>`);
    } catch (err) {
      busy(button, false, 'Отправить ссылку');
      if (err.field) setField(form, err.field, 'error', err.message); else toastError(err);
    }
  });
}

function renderReset({ onDone, token }) {
  goHandler = (t) => { if (t === 'login') renderLogin({ onDone, dir: 'prev' }); };
  const v = view(html`
    <button type="button" class="wz-back solo" data-go="login" aria-label="Назад">${raw(icons.back)}</button>
    <div class="auth-badge">${raw(icons.lock)}</div>
    <h2>Новый пароль</h2>
    <p class="lead">Придумайте новый пароль — остальные сессии завершатся.</p>
    <form class="auth-form" novalidate>
      ${passwordBlockHTML()}
      <button class="btn btn-primary btn-lg btn-block auth-cta" type="submit" data-submit>Сохранить пароль</button>
    </form>
  `);
  const form = $('form', v);
  bindToggles(form);
  const block = bindPasswordBlock(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!block.validate()) return;
    const button = $('[data-submit]', form);
    busy(button, true, 'Сохраняем…');
    try {
      await Api.reset({ token, password: block.value() });
      goHandler = (target) => { if (target === 'login') renderLogin({ onDone, dir: 'prev' }); };
      view(html`<div class="auth-success">
        <div class="ok-ring"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 14-16"/></svg></div>
        <h2>Пароль успешно изменён</h2>
        <p class="lead">Теперь войдите в Aurora с новым паролем.</p>
        <div class="auth-alt"><button type="button" data-go="login">Перейти ко входу</button></div>
      </div>`);
    } catch (err) {
      busy(button, false, 'Сохранить пароль');
      if (err.field) setField(form, err.field === 'confirm' ? 'passwordConfirm' : err.field, 'error', err.message); else toastError(err);
    }
  });
}
