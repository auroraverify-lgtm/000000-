/**
 * Аккаунты: регистрация, вход, сессии, восстановление доступа, смена пароля, профиль.
 * Пароли — только scrypt-хеши. Все входные данные валидируются на сервере.
 */
import express from 'express';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { db, users, settings, resets, passwordResetRequests, loginChallenges, pushSubscriptions, nativePushTokens, registrationConsents, media, chats, sessions, securitySsoCodes, twoFactor, emailVerifications, commerce, now, tx } from '../db.js';
import { EMAIL_VERIFICATION, PASSWORD_RESET, PREMIUM_LIMITS, SECURITY_PUBLIC_URL, SECURITY_SSO_SECRET } from '../config.js';
import { getSecurityVerification } from '../security-client.js';
import { LEGAL_VERSIONS } from '../legal.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, validate, createTotpSecret, verifyTotp, hashOneTimeCode, hashEmailVerificationCode } from '../security.js';
import { requireAuth, requireEmailVerificationAuth, limit, limitByIp, limitByAccount, setAuthCookie, clearAuthCookie, wrap, conflict, badRequest, forbidden } from '../middleware.js';
import { userDTO, settingsDTO, uid } from '../helpers.js';
import { hub, broadcastToContacts, closeUserSockets, indexChat } from '../realtime.js';
import { createMessage } from '../services/messages.js';
import { EmailDeliveryError, sendEmailChangeNotice, sendPasswordResetEmail, sendVerificationEmail } from '../email.js';
import { PREMIUM_EMOJI_IDS } from '../premium.js';
import { recordLoginFailure, recordSecurityEvent, recordSessionCreated, recordSessionRevoked } from '../security-events.js';
import { getSecurityStore } from '../security-store.js';

export const authRouter = express.Router();

const EMAIL_TAKEN = 'Этот e-mail уже зарегистрирован';
const USERNAME_TAKEN = 'Этот username занят — попробуйте другой';
const AVATAR_COLORS = ['violet', 'ocean', 'sunset', 'mint', 'coral', 'indigo'];
const PROFILE_THEMES = ['aurora', 'sunset', 'ocean', 'forest', 'mono', 'neon'];
const PROFILE_EFFECT_THEMES = ['none', 'halloween', 'newyear', 'summer', 'jungle', 'snow', 'neon'];
const PROFILE_RINGS = ['none', 'gradient', 'rainbow'];
const PROFILE_NAME_EFFECTS = ['none', 'glow', 'gradient'];
const SECURITY_SSO_CODE_TTL = 60 * 1000;
const securitySsoNonces = new Map();

function hashSecuritySsoCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

function trustedSecurityServiceRequest(req) {
  const timestamp = String(req.get('x-aurora-timestamp') || '');
  const nonce = String(req.get('x-aurora-nonce') || '');
  const signature = String(req.get('x-aurora-signature') || '');
  if (!SECURITY_SSO_SECRET || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000
    || !/^[a-f0-9]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const body = JSON.stringify(req.body || {});
  const requestPath = `${req.baseUrl}${req.path}`;
  const expected = createHmac('sha256', SECURITY_SSO_SECRET)
    .update(`${req.method}\n${requestPath}\n${timestamp}\n${nonce}\n${body}`).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
  const nowMs = Date.now();
  for (const [key, expiresAt] of securitySsoNonces) if (expiresAt <= nowMs) securitySsoNonces.delete(key);
  if (securitySsoNonces.has(nonce)) return false;
  if (securitySsoNonces.size > 20000) securitySsoNonces.clear();
  securitySsoNonces.set(nonce, nowMs + 60_000);
  return true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function securitySsoDestination(res) {
  if (!SECURITY_PUBLIC_URL || !SECURITY_SSO_SECRET || Buffer.byteLength(SECURITY_SSO_SECRET) < 32) {
    res.status(503).json({ error: 'Центр безопасности ещё не подключён' });
    return null;
  }
  let destination;
  try {
    destination = new URL('/auth/sso', SECURITY_PUBLIC_URL);
  } catch {
    res.status(503).json({ error: 'Адрес центра безопасности настроен неверно' });
    return null;
  }
  if (process.env.NODE_ENV === 'production' && destination.protocol !== 'https:') {
    res.status(503).json({ error: 'Для центра безопасности требуется HTTPS' });
    return null;
  }
  return destination;
}

function securitySsoCode(user) {
  const timestamp = now();
  const code = randomBytes(32).toString('base64url');
  securitySsoCodes.removeExpired.run(timestamp);
  securitySsoCodes.create.run({
    code_hash: hashSecuritySsoCode(code),
    user_id: user.id,
    created_at: timestamp,
    expires_at: timestamp + SECURITY_SSO_CODE_TTL,
  });
  return code;
}

function requireSecurityAdmin(user) {
  if (!user.is_admin || !user.email_verified) {
    throw forbidden('Центр безопасности доступен подтверждённому администратору Aurora');
  }
}

function renderSecuritySsoBootstrap(res, destination) {
  const nonce = randomBytes(18).toString('base64url');
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action ${destination.origin}; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в Aurora Security</title>
    <body><p id="status">Проверяем вход в Aurora Messenger…</p>
    <script nonce="${nonce}">(async () => {
      const status = document.getElementById('status');
      try {
        const headers = {};
        try {
          const token = localStorage.getItem('aurora.token');
          if (token) headers.Authorization = 'Bearer ' + token;
        } catch {}
        const response = await fetch('/api/auth/security-sso/launch', {
          method: 'POST', headers, cache: 'no-store',
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          status.textContent = data.error || 'Не удалось проверить вход. Войдите в Aurora Messenger и повторите попытку.';
          return;
        }
        const form = document.createElement('form');
        form.method = 'post';
        form.action = data.destination;
        const code = document.createElement('input');
        code.type = 'hidden';
        code.name = 'code';
        code.value = data.code;
        form.append(code);
        document.body.append(form);
        form.submit();
      } catch {
        status.textContent = 'Не удалось связаться с Aurora Messenger. Обновите страницу и попробуйте снова.';
      }
    })();</script></body></html>`);
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}

function testEmailSecret(secretName, value) {
  return process.env.NODE_ENV === 'test' && process.env.EMAIL_TEST_MODE === '1'
    ? { [secretName]: value }
    : {};
}

async function issueVerificationCode(user) {
  const ts = now();
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  emailVerifications.upsert.run({
    user_id: user.id,
    code_hash: hashEmailVerificationCode(user.id, code),
    code_ciphertext: '',
    expires_at: ts + EMAIL_VERIFICATION.codeTtlMs,
    last_sent_at: ts,
    created_at: ts,
  });
  try {
    await sendVerificationEmail(user.email, code);
  } catch (error) {
    emailVerifications.remove.run(user.id);
    throw error;
  }
  users.setEmailVerificationRequestedAt.run(ts, ts, user.id);
  return {
    sent: true,
    requestedAt: ts,
    retryAfter: EMAIL_VERIFICATION.resendCooldownMs / 1000,
    ...testEmailSecret('testCode', code),
  };
}

function isReservedAdminUsername(username) {
  return String(process.env.AURORA_ADMIN_USERNAMES || '')
    .split(',')
    .some((value) => value.trim().toLowerCase() === String(username).toLowerCase());
}

function sessionPayload(user, req, sessionId = null) {
  const st = settings.byUser.get(user.id);
  const id = sessionId || uid() + uid();
  if (!sessionId) {
    const ts = now();
    const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 300);
    const knownDevice = sessions.byUser.all(user.id, ts).some((session) => session.user_agent === userAgent && userAgent);
    sessions.create.run({ id, user_id: user.id, created_at: ts, last_seen: ts, expires_at: ts + 30 * 86400 * 1000, user_agent: userAgent, ip: String(req?.ip || '').slice(0, 80) });
    recordSessionCreated(req, { actorId: user.id, sessionId: id, isKnownDevice: knownDevice, userAgent });
  }
  return { user: userDTO(user, user.id, st), settings: settingsDTO(st), token: issueToken(user, id) };
}

function validSecondFactor(user, code, consumeRecoveryCode = true) {
  const config = twoFactor.byUser.get(user.id);
  if (!config?.enabled) return true;
  if (verifyTotp(config.secret, code)) return true;
  const hash = hashOneTimeCode(String(code || '').replace(/\s|-/g, '').toUpperCase());
  const codes = JSON.parse(config.recovery_codes || '[]');
  const index = codes.indexOf(hash);
  if (index < 0) return false;
  if (!consumeRecoveryCode) return true;
  codes.splice(index, 1);
  twoFactor.updateCodes.run(JSON.stringify(codes), now(), user.id);
  return true;
}

function deviceName(userAgent = '') {
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'браузер';
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'устройство';
  return `${browser} на ${os}`;
}

function requestCity(req) {
  const forwardedCity = req.headers['x-aurora-city'] || req.headers['x-vercel-ip-city'];
  return forwardedCity ? String(forwardedCity).slice(0, 80) : 'не определён';
}

function ensureSupportChat(user, req, { alert = true, registration = false } = {}) {
  let bot = users.byBotUsername.get('aurora_support');
  const ts = now();
  if (!bot) {
    const info = users.create.run({
      email: 'aurora.support@system.invalid',
      username: 'aurora_support',
      name: 'Aurora Support ✦',
      password_hash: hashPassword(uid()),
      bio: 'Официальный помощник Aurora. Безопасность, аккаунт и поддержка.',
      avatar_url: null, avatar_color: 'ocean', email_verified: 1, email_verification_deadline_at: null, created_at: ts, updated_at: ts, is_bot: 1,
    });
    bot = users.byId.get(Number(info.lastInsertRowid));
    users.markBot.run(bot.id);
    settings.create.run(bot.id, ts);
  }
  if (bot.name !== 'Aurora Support ✦') {
    users.update.run({
      id: bot.id,
      name: 'Aurora Support ✦',
      username: null,
      bio: null,
      status_text: null,
      avatar_color: null,
      updated_at: ts,
    });
    bot = users.byId.get(bot.id);
  }
  const key = `dm:${Math.min(user.id, bot.id)}:${Math.max(user.id, bot.id)}`;
  let chat = chats.byDmKey.get(key);
  if (!chat) {
    const create = db.transaction(() => {
      const info = chats.create.run({ type: 'dm', title: null, username: null, description: '', avatar_url: null, owner_id: null, is_public: 0, dm_key: key, created_at: ts });
      const id = Number(info.lastInsertRowid);
      chats.addMember.run(id, user.id, 'member', ts, 0);
      chats.addMember.run(id, bot.id, 'member', ts, 0);
      return chats.byId.get(id);
    });
    chat = create();
    indexChat(chat.id);
  }
  if (!alert) return;
  const text = [
    'Добро пожаловать в Aurora!',
    'Я официальный бот-помощник Aurora ✦',
    ...(registration ? [
      '',
      'Подтвердите адрес электронной почты в течение 2 дней, иначе доступ к профилю будет временно ограничен.',
      'Введите шестизначный код из письма на экране подтверждения в Aurora. Если письмо не пришло, проверьте папку «Спам» или запросите новый код в настройках.',
    ] : []),
    `В ваш аккаунт выполнен вход: ${new Date(ts).toLocaleString('ru-RU')}.`,
    `Город: ${requestCity(req)}.`,
    `Устройство: ${deviceName(req.headers['user-agent'])}.`,
    '',
    'Если это были не вы, немедленно завершите подозрительные сеансы в разделе «Активные сеансы» и смените пароль.',
    'Быстрые разделы: безопасность аккаунта, вход, жалоба или идея.',
    'Если нужна помощь человека, напишите «оператор» — мы подключим специалиста.',
  ].join('\n');
  createMessage({ chat, sender: bot, type: 'text', text, createdAt: ts });
}

/** Регистрация: почта, пароль, имя, username, описание, аватар. */
authRouter.post('/register', limit('auth'), limitByIp('authIp'), wrap(async (req, res) => {
  const email = validate.email(req.body?.email);
  if (email.error) throw badRequest(email.error, { field: 'email' });
  const password = validate.password(req.body?.password);
  if (password.error) throw badRequest(password.error, { field: 'password' });
  const name = validate.name(req.body?.name);
  if (name.error) throw badRequest(name.error, { field: 'name' });
  const username = validate.username(req.body?.username);
  if (username.error) throw badRequest(username.error, { field: 'username' });
  if (isReservedAdminUsername(username.value)) throw conflict(USERNAME_TAKEN, { field: 'username' });
  const bio = validate.bio(req.body?.bio || '');
  if (bio.error) throw badRequest(bio.error, { field: 'bio' });
  if (req.body?.termsVersion !== LEGAL_VERSIONS.terms || req.body?.privacyVersion !== LEGAL_VERSIONS.privacy) {
    throw badRequest('Перед регистрацией ознакомьтесь с актуальными документами и подтвердите согласие', { field: 'consent' });
  }
  if (req.body?.personalDataConsent !== true) {
    throw badRequest('Подтвердите отдельное согласие на обработку персональных данных', { field: 'personalDataConsent' });
  }
  if (req.body?.ageGuardianAttestation !== true) {
    throw badRequest('Подтвердите возраст и согласие родителя или законного представителя, если оно требуется', { field: 'ageGuardianAttestation' });
  }

  if (users.byEmail.get(email.value)) throw conflict(EMAIL_TAKEN, { field: 'email' });
  if (users.byUsername.get(username.value)) throw conflict(USERNAME_TAKEN, { field: 'username' });

  const ts = now();
  const createUser = tx(() => {
    const info = users.create.run({
      email: email.value,
      username: username.value,
      name: name.value,
      password_hash: hashPassword(password.value),
      bio: bio.value,
      avatar_url: null,
      avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      email_verified: 0,
      email_verification_deadline_at: ts + EMAIL_VERIFICATION.accountDeadlineMs,
      created_at: ts,
      updated_at: ts,
    });
    const user = users.byId.get(Number(info.lastInsertRowid));
    settings.create.run(user.id, ts);
    registrationConsents.create.run({
      user_id: user.id,
      terms_version: LEGAL_VERSIONS.terms,
      privacy_version: LEGAL_VERSIONS.privacy,
      personal_data_consent: 1,
      age_guardian_attested: 1,
      accepted_at: ts,
      ip: String(req.ip || '').slice(0, 80),
      user_agent: String(req.headers?.['user-agent'] || '').slice(0, 300),
    });
    return user;
  });
  const user = createUser();
  let emailVerification;
  try {
    emailVerification = await issueVerificationCode(user);
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    console.error('[email] Registration verification delivery failed:', error.diagnosticCode);
    emailVerification = { sent: false, message: error.message };
  }
  const payload = sessionPayload(user, req);
  ensureSupportChat(user, req, { registration: true });
  setAuthCookie(res, payload.token);
  res.status(201).json({ ...payload, emailVerification: { ...emailVerification, email: maskEmail(user.email) } });
}));

authRouter.post('/email-verification/request', requireEmailVerificationAuth, limit('auth'), limitByIp('authIp'), wrap(async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, alreadyVerified: true, user: userDTO(req.user, req.user.id), message: 'Эта почта уже подтверждена.' });
  const ts = now();
  const current = emailVerifications.byUser.get(req.user.id);
  if (current && current.expires_at <= ts) emailVerifications.remove.run(req.user.id);
  else if (current && current.last_sent_at + EMAIL_VERIFICATION.resendCooldownMs > ts) {
    return res.json({
      ok: true,
      requestedAt: req.user.email_verification_requested_at,
      retryAfter: Math.ceil((current.last_sent_at + EMAIL_VERIFICATION.resendCooldownMs - ts) / 1000),
      sent: true,
      email: maskEmail(req.user.email),
      message: 'Код уже отправлен. Проверьте почту и папку «Спам».',
    });
  }
  try {
    const emailVerification = await issueVerificationCode(req.user);
    res.status(201).json({
      ok: true,
      ...emailVerification,
      email: maskEmail(req.user.email),
      message: 'Код отправлен на вашу почту. Он действует 10 минут.',
    });
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    console.error('[email] Verification delivery failed:', error.diagnosticCode);
    res.status(503).json({ ok: false, error: error.message, code: error.code });
  }
}));

authRouter.post('/email-verification/verify', requireEmailVerificationAuth, limit('auth'), limitByIp('authIp'), wrap((req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, alreadyVerified: true, user: userDTO(req.user, req.user.id) });
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw badRequest('Введите шестизначный код', { field: 'code' });
  const verification = emailVerifications.byUser.get(req.user.id);
  if (!verification || verification.expires_at <= now()) {
    emailVerifications.remove.run(req.user.id);
    throw badRequest('Код недействителен или истёк. Запросите новый код.');
  }
  if (verification.attempts >= EMAIL_VERIFICATION.maxAttempts) {
    emailVerifications.remove.run(req.user.id);
    throw badRequest('Превышено число попыток. Запросите новый код.');
  }
  const expectedHash = Buffer.from(verification.code_hash, 'hex');
  const suppliedHash = Buffer.from(hashEmailVerificationCode(req.user.id, code), 'hex');
  if (expectedHash.length !== suppliedHash.length || !timingSafeEqual(expectedHash, suppliedHash)) {
    emailVerifications.incrementAttempts.run(req.user.id);
    throw badRequest('Неверный код');
  }
  const confirm = tx(() => {
    users.verifyEmail.run(now(), req.user.id);
    emailVerifications.remove.run(req.user.id);
  });
  confirm();
  const user = users.byId.get(req.user.id);
  res.json({ ok: true, user: userDTO(user, user.id) });
}));

authRouter.patch('/email', requireEmailVerificationAuth, limit('auth'), limitByIp('authIp'), wrap(async (req, res) => {
  const email = validate.email(req.body?.email);
  if (email.error) throw badRequest(email.error, { field: 'email' });
  const changingVerifiedEmail = Boolean(req.user.email_verified && email.value !== req.user.email);
  if (changingVerifiedEmail) {
    const currentPassword = String(req.body?.currentPassword || '');
    if (!currentPassword || !verifyPassword(currentPassword, req.user.password_hash)) {
      throw forbidden('Для смены подтверждённой почты введите текущий пароль');
    }
    if (twoFactor.byUser.get(req.user.id)?.enabled
      && !validSecondFactor(req.user, req.body?.twoFactorCode)) {
      throw forbidden('Для смены подтверждённой почты введите действующий код двухфакторной аутентификации');
    }
  }
  const existing = users.byEmail.get(email.value);
  if (existing && existing.id !== req.user.id) throw conflict(EMAIL_TAKEN, { field: 'email' });
  if (existing?.id === req.user.id && req.user.email_verified) {
    return res.json({ ok: true, user: userDTO(req.user, req.user.id), emailVerification: { sent: false, alreadyVerified: true } });
  }
  if (existing?.id === req.user.id) {
    const current = emailVerifications.byUser.get(req.user.id);
    if (current && current.expires_at > now() && current.last_sent_at + EMAIL_VERIFICATION.resendCooldownMs > now()) {
      return res.json({
        ok: true,
        user: userDTO(req.user, req.user.id),
        emailVerification: {
          sent: true,
          requestedAt: current.last_sent_at,
          retryAfter: Math.max(0, Math.ceil((current.last_sent_at + EMAIL_VERIFICATION.resendCooldownMs - now()) / 1000)),
          email: maskEmail(req.user.email),
        },
      });
    }
    if (current && current.expires_at <= now()) emailVerifications.remove.run(req.user.id);
  } else {
    const ts = now();
    const previousEmail = req.user.email;
    const updateEmail = tx(() => {
      users.changeEmail.run(email.value, ts + EMAIL_VERIFICATION.accountDeadlineMs, ts, req.user.id);
      emailVerifications.remove.run(req.user.id);
      resets.invalidateForUser.run(req.user.id);
    });
    updateEmail();
    if (changingVerifiedEmail) {
      sendEmailChangeNotice(previousEmail, email.value).catch((error) => {
        console.error('[email] Email change notice delivery failed:', error.diagnosticCode || error.code || 'unknown');
      });
    }
  }
  const user = users.byId.get(req.user.id);
  let emailVerification;
  try {
    emailVerification = await issueVerificationCode(user);
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    console.error('[email] Email change verification delivery failed:', error.diagnosticCode);
    emailVerification = { sent: false, message: error.message, email: maskEmail(user.email) };
  }
  res.json({ ok: true, user: userDTO(users.byId.get(user.id), user.id), emailVerification });
}));

/** Живая проверка занятости username/e-mail (валидация формы без перезагрузки). */
authRouter.get('/check', limit('auth'), wrap((req, res) => {
  const username = req.query.username ? validate.username(req.query.username) : null;
  const email = req.query.email ? validate.email(req.query.email) : null;
  res.json({
    username: username ? { valid: !username.error, error: username.error || null } : null,
    email: email ? { valid: !email.error, error: email.error || null } : null,
  });
}));

authRouter.post('/login', limit('auth'), limitByIp('authIp'), limitByAccount('authAccount'), wrap((req, res) => {
  const email = validate.email(req.body?.email);
  if (email.error) throw badRequest('Введите корректный e-mail', { field: 'email' });
  const password = String(req.body?.password || '');
  if (!password) throw badRequest('Введите пароль', { field: 'password' });

  const user = users.byEmail.get(email.value);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(req, email.value, user?.id || null);
    throw Object.assign(new Error('Неверный e-mail или пароль'), { status: 401, details: { field: 'password' } });
  }
  if (user.is_blocked) throw forbidden('Аккаунт заблокирован');
  if (user.is_frozen) throw forbidden('Аккаунт временно заморожен');
  if (getSecurityStore().isRestricted('account', String(user.id))) {
    throw forbidden('Вход временно ограничен системой безопасности');
  }
  let secondFactorCode = null;
  if (twoFactor.byUser.get(user.id)?.enabled) {
    secondFactorCode = req.body?.code || req.body?.twoFactorCode || req.body?.otp || req.body?.oneTimeCode;
    if (!secondFactorCode || !validSecondFactor(user, secondFactorCode, false)) {
      return res.json({ stepRequired: 'two_factor', invalid: !!secondFactorCode });
    }
  }
  if (user.protective_password_required && !user.protective_password_hash) {
    if (secondFactorCode && !validSecondFactor(user, secondFactorCode)) {
      return res.json({ stepRequired: 'two_factor', invalid: true });
    }
    const setupToken = randomBytes(32).toString('base64url');
    loginChallenges.removeForUser.run(user.id);
    loginChallenges.create.run({
      token_hash: hashOneTimeCode(setupToken),
      user_id: user.id,
      expires_at: now() + 10 * 60 * 1000,
      created_at: now(),
    });
    return res.json({ stepRequired: 'protective_password_setup', setupToken });
  }
  if (user.protective_password_hash) {
    const protectivePassword = String(req.body?.protectivePassword || '');
    if (!protectivePassword || !verifyPassword(protectivePassword, user.protective_password_hash)) {
      return res.json({ stepRequired: 'protective_password', invalid: !!protectivePassword });
    }
  }
  if (secondFactorCode && !validSecondFactor(user, secondFactorCode)) {
    return res.json({ stepRequired: 'two_factor', invalid: true });
  }
  const payload = sessionPayload(user, req);
  recordSecurityEvent({
    type: 'auth.login_success',
    req,
    actorId: user.id,
    sessionId: verifyToken(payload.token)?.jti || null,
    subject: `user:${user.id}`,
    details: { source: 'login' },
  });
  ensureSupportChat(user, req);
  setAuthCookie(res, payload.token);
  res.json(payload);
}));

authRouter.post('/protective-password/setup-after-login', limit('auth'), wrap((req, res) => {
  const token = String(req.body?.setupToken || '');
  const password = String(req.body?.protectivePassword || '');
  if (password.length < 6 || password.length > 128) throw badRequest('Защитный пароль должен содержать от 6 до 128 символов', { field: 'protectivePassword' });
  const tokenHash = hashOneTimeCode(token);
  const challenge = loginChallenges.byHash.get(tokenHash);
  if (!challenge || challenge.expires_at <= now()) {
    loginChallenges.remove.run(tokenHash);
    throw badRequest('Настройка входа истекла. Войдите ещё раз.');
  }
  const user = users.byId.get(challenge.user_id);
  if (!user) throw badRequest('Настройка входа истекла. Войдите ещё раз.');
  if (user.is_blocked) throw forbidden('Аккаунт заблокирован');
  if (user.is_frozen) throw forbidden('Аккаунт временно заморожен');
  const setPassword = tx(() => {
    users.setProtectivePassword.run(hashPassword(password), now(), challenge.user_id);
    loginChallenges.remove.run(tokenHash);
  });
  setPassword();
  const payload = sessionPayload(user, req);
  ensureSupportChat(user, req);
  setAuthCookie(res, payload.token);
  res.json(payload);
}));

authRouter.get('/protective-password/status', requireAuth, wrap((req, res) => {
  res.json({
    enabled: !!req.user.protective_password_hash,
    setupRequired: !!req.user.protective_password_required,
  });
}));

authRouter.post('/protective-password', requireAuth, limit('auth'), wrap((req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const password = String(req.body?.protectivePassword || '');
  if (!verifyPassword(currentPassword, req.user.password_hash)) throw forbidden('Пароль аккаунта указан неверно');
  if (password.length < 6 || password.length > 128) throw badRequest('Защитный пароль должен содержать от 6 до 128 символов');
  users.setProtectivePassword.run(hashPassword(password), now(), req.user.id);
  res.json({ enabled: true });
}));

authRouter.post('/protective-password/disable', requireAuth, limit('auth'), wrap((req, res) => {
  if (!verifyPassword(String(req.body?.currentPassword || ''), req.user.password_hash)) throw forbidden('Пароль аккаунта указан неверно');
  if (!req.user.protective_password_hash || !verifyPassword(String(req.body?.protectivePassword || ''), req.user.protective_password_hash)) {
    throw forbidden('Защитный пароль указан неверно');
  }
  users.clearProtectivePassword.run(0, now(), req.user.id);
  res.json({ enabled: false });
}));

/** Автоматический вход при повторном запуске: проверка сохранённой сессии. */
authRouter.get('/security-sso/launch', limit('auth'), (req, res, next) => {
  if (req.user) return requireAuth(req, res, next);
  const destination = securitySsoDestination(res);
  if (destination) renderSecuritySsoBootstrap(res, destination);
}, wrap((req, res) => {
  requireSecurityAdmin(req.user);
  const destination = securitySsoDestination(res);
  if (!destination) return;
  const code = securitySsoCode(req.user);
  const nonce = randomBytes(18).toString('base64url');
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${destination.origin}; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в Aurora Security</title>
    <body><p>Проверяем вход в Aurora Security…</p>
    <form method="post" action="${escapeHtml(destination.href)}"><input type="hidden" name="code" value="${escapeHtml(code)}">
    <button type="submit">Продолжить</button></form>
    <script nonce="${nonce}">document.forms[0].submit()</script></body></html>`);
}));

authRouter.post('/security-sso/launch', requireAuth, limit('auth'), wrap((req, res) => {
  requireSecurityAdmin(req.user);
  const destination = securitySsoDestination(res);
  if (!destination) return;
  res.set('Cache-Control', 'no-store').json({
    destination: destination.href,
    code: securitySsoCode(req.user),
  });
}));

authRouter.post('/security-sso/redeem', limitByIp('authIp'), wrap((req, res) => {
  if (!trustedSecurityServiceRequest(req)) return res.status(401).json({ error: 'Запрос сервиса безопасности не подтверждён' });
  const code = String(req.body?.code || '');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(code)) return res.status(401).json({ error: 'Код входа недействителен' });

  const timestamp = now();
  const hash = hashSecuritySsoCode(code);
  const identity = securitySsoCodes.active.get(hash, timestamp);
  if (!identity || !identity.is_admin || !identity.email_verified
    || identity.is_blocked || identity.is_frozen) {
    return res.status(401).json({ error: 'Код входа недействителен или истёк' });
  }
  if (!securitySsoCodes.redeem.run(timestamp, hash, timestamp).changes) {
    return res.status(401).json({ error: 'Код входа уже использован' });
  }
  res.json({ id: identity.user_id, email: identity.email, name: identity.name, isAdmin: Boolean(identity.is_admin) });
}));

authRouter.get('/me', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Сессия не найдена', code: 'unauthorized' });
  ensureSupportChat(req.user, req, { alert: false });
  const st = settings.byUser.get(req.user.id);
  const security = await getSecurityVerification(req.user.id);
  const user = userDTO(req.user, req.user.id, st);
  user.securityVerification = security?.verifications || null;
  res.json({
    user,
    settings: settingsDTO(st),
    token: issueToken(req.user, req.sessionId),
    securityVerification: security?.verification || null,
  });
}));

authRouter.get('/sessions', requireAuth, wrap((req, res) => {
  res.json({ sessions: sessions.byUser.all(req.user.id, now()).map((s) => ({
    ...s,
    deviceName: deviceName(s.user_agent),
    current: s.id === req.sessionId,
  })) });
}));

authRouter.delete('/sessions/:id', requireAuth, wrap((req, res) => {
  const id = String(req.params.id);
  if (!sessions.revoke.run(now(), id, req.user.id).changes) return res.status(404).json({ error: 'Сессия не найдена' });
  recordSessionRevoked(req, { actorId: req.user.id, sessionId: id });
  pushSubscriptions.removeForSession.run(id);
  nativePushTokens.removeForSession.run(id);
  const set = hub.sockets.get(req.user.id);
  if (set) {
    for (const ws of set) {
      if (ws.sessionId === id) {
        try { ws.close(4001, 'Session revoked'); } catch { /* noop */ }
      }
    }
  }
  res.json({ ok: true });
}));

authRouter.post('/logout', wrap((req, res) => {
  if (req.user && req.sessionId) {
    sessions.revoke.run(now(), req.sessionId, req.user.id);
    recordSessionRevoked(req, { actorId: req.user.id, sessionId: req.sessionId, reason: 'logout' });
    pushSubscriptions.removeForSession.run(req.sessionId);
    nativePushTokens.removeForSession.run(req.sessionId);
  }
  if (req.user) {
    const set = hub.sockets.get(req.user.id);
    if (set) for (const ws of set) { try { ws.close(); } catch { /* noop */ } }
  }
  clearAuthCookie(res);
  res.json({ ok: true });
}));

/** Выход со всех устройств, кроме текущего: инвалидируем токены и перевыпускаем текущий. */
authRouter.post('/logout-devices', requireAuth, wrap((req, res) => {
  pushSubscriptions.removeForUser.run(req.user.id);
  nativePushTokens.removeForUser.run(req.user.id);
  users.bumpTokenVersion.run(now(), req.user.id);
  sessions.revokeAll.run(now(), req.user.id);
  recordSessionRevoked(req, { actorId: req.user.id, reason: 'password_change' });
  const fresh = users.byId.get(req.user.id);
  const payload = sessionPayload(fresh, req);
  setAuthCookie(res, payload.token);
  const set = hub.sockets.get(req.user.id);
  if (set) for (const ws of set) { try { ws.close(); } catch { /* noop */ } }
  res.json({ ok: true, token: payload.token });
}));

/** Выход со всех устройств: token_version инвалидирует все ранее выданные токены. */
authRouter.post('/logout-all', requireAuth, wrap((req, res) => {
  pushSubscriptions.removeForUser.run(req.user.id);
  nativePushTokens.removeForUser.run(req.user.id);
  users.bumpTokenVersion.run(now(), req.user.id);
  sessions.revokeAll.run(now(), req.user.id);
  recordSessionRevoked(req, { actorId: req.user.id, reason: 'password_change' });
  const set = hub.sockets.get(req.user.id);
  if (set) for (const ws of set) { try { ws.close(); } catch { /* noop */ } }
  clearAuthCookie(res);
  res.json({ ok: true });
}));

authRouter.post('/2fa/setup', requireAuth, limit('auth'), wrap((req, res) => {
  if (twoFactor.byUser.get(req.user.id)?.enabled) throw conflict('Двухфакторная аутентификация уже включена');
  const secret = createTotpSecret();
  const ts = now();
  twoFactor.save.run({ user_id: req.user.id, secret, enabled: 0, recovery_codes: '[]', created_at: ts, updated_at: ts });
  const label = encodeURIComponent(`${req.user.email}`);
  res.json({ secret, otpauth: `otpauth://totp/Aurora:${label}?secret=${secret}&issuer=Aurora`, enabled: false });
}));

authRouter.post('/2fa/enable', requireAuth, limit('auth'), wrap((req, res) => {
  const config = twoFactor.byUser.get(req.user.id);
  if (config?.enabled) return res.json({ enabled: true });
  if (!config) {
    const secret = createTotpSecret();
    const ts = now();
    twoFactor.save.run({ user_id: req.user.id, secret, enabled: 0, recovery_codes: '[]', created_at: ts, updated_at: ts });
    return res.json({ enabled: false, secret, otpauth: `otpauth://totp/Aurora:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=Aurora` });
  }
  res.json({ enabled: false, secret: config.secret, otpauth: `otpauth://totp/Aurora:${encodeURIComponent(req.user.email)}?secret=${config.secret}&issuer=Aurora` });
}));

authRouter.get('/2fa/status', requireAuth, wrap((req, res) => {
  res.json({ enabled: !!twoFactor.byUser.get(req.user.id)?.enabled });
}));

authRouter.post('/2fa/verify', requireAuth, limit('auth'), wrap((req, res) => {
  const config = twoFactor.byUser.get(req.user.id);
  if (!config) throw badRequest('Сначала запросите настройку 2FA');
  if (!verifyTotp(config.secret, req.body?.code || req.body?.otp)) throw badRequest('Неверный код');
  const recoveryCodes = Array.from({ length: 8 }, () => uid().slice(0, 10).toUpperCase());
  twoFactor.save.run({ user_id: req.user.id, secret: config.secret, enabled: 1, recovery_codes: JSON.stringify(recoveryCodes.map(hashOneTimeCode)), created_at: config.created_at, updated_at: now() });
  res.json({ enabled: true, recoveryCodes });
}));

authRouter.post('/2fa/disable', requireAuth, limit('auth'), wrap((req, res) => {
  const config = twoFactor.byUser.get(req.user.id);
  if (!config?.enabled || !validSecondFactor(req.user, req.body?.code || req.body?.twoFactorCode)) throw forbidden('Неверный код двухфакторной аутентификации');
  twoFactor.remove.run(req.user.id);
  res.json({ enabled: false });
}));

const passwordResetAnswer = {
  ok: true,
  message: 'Запрос принят. Для защиты аккаунта мы не сообщаем, существует ли такой адрес. Если аккаунт найден и доставка доступна, инструкция появится в почте.',
};

authRouter.post('/forgot', limit('auth'), limitByIp('authIp'), wrap(async (req, res) => {
  const email = validate.email(req.body?.email);
  if (email.error) throw badRequest('Введите корректный e-mail', { field: 'email' });
  const user = users.byEmail.get(email.value);
  if (!user || user.is_bot) return res.status(202).json(passwordResetAnswer);

  const ts = now();
  const latest = resets.latestForUser.get(user.id);
  if (latest && latest.created_at + PASSWORD_RESET.resendCooldownMs > ts) {
    return res.status(202).json(passwordResetAnswer);
  }

  const token = randomBytes(32).toString('base64url');
  resets.invalidateForUser.run(user.id);
  resets.create.run(hashOneTimeCode(token), user.id, ts + PASSWORD_RESET.tokenTtlMs, ts);
  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (error) {
    resets.invalidateForUser.run(user.id);
    if (!(error instanceof EmailDeliveryError)) throw error;
    console.error('[email] Password reset delivery failed:', error.diagnosticCode);
    return res.status(202).json(passwordResetAnswer);
  }
  res.status(202).json({
    ...passwordResetAnswer,
    ...testEmailSecret('devResetToken', token),
  });
}));

authRouter.post('/reset', limit('auth'), limitByIp('authIp'), wrap((req, res) => {
  const token = String(req.body?.token || '');
  const password = validate.password(req.body?.password);
  if (password.error) throw badRequest(password.error, { field: 'password' });
  const row = resets.byToken.get(hashOneTimeCode(token));
  if (!row || row.used || row.expires_at <= now()) throw badRequest('Ссылка недействительна или истекла');
  const completeReset = tx(() => {
    if (!resets.use.run(row.token, now()).changes) throw badRequest('Ссылка недействительна или истекла');
    users.setPassword.run(hashPassword(password.value), now(), row.user_id);
    users.clearProtectivePassword.run(1, now(), row.user_id);
    twoFactor.remove.run(row.user_id);
    sessions.revokeAll.run(now(), row.user_id);
    pushSubscriptions.removeForUser.run(row.user_id);
    nativePushTokens.removeForUser.run(row.user_id);
    passwordResetRequests.completeForUser.run(now(), row.user_id);
  });
  completeReset();
  closeUserSockets(row.user_id);
  res.json({ ok: true });
}));

authRouter.post('/change-password', requireAuth, limit('auth'), wrap((req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = validate.password(req.body?.password);
  if (next.error) throw badRequest(next.error, { field: 'password' });
  if (!verifyPassword(current, req.user.password_hash)) throw forbidden('Текущий пароль указан неверно');
  if (verifyPassword(next.value, req.user.password_hash)) throw badRequest('Новый пароль совпадает с текущим');
  users.setPassword.run(hashPassword(next.value), now(), req.user.id);
  sessions.revokeAll.run(now(), req.user.id);
  closeUserSockets(req.user.id);
  pushSubscriptions.removeForUser.run(req.user.id);
  nativePushTokens.removeForUser.run(req.user.id);
  const fresh = users.byId.get(req.user.id);
  const payload = sessionPayload(fresh); // текущая сессия перевыпускается, остальные — нет
  setAuthCookie(res, payload.token);
  res.json({ ok: true, token: payload.token });
}));

/** Редактирование профиля: имя, username, описание, статус, аватар, цвет, фон. */
authRouter.patch('/profile', requireAuth, limit('write'), wrap((req, res) => {
  const fields = {};
  if (req.body?.name !== undefined) {
    const r = validate.name(req.body.name);
    if (r.error) throw badRequest(r.error, { field: 'name' });
    fields.name = r.value;
  }
  if (req.body?.username !== undefined) {
    const r = validate.username(req.body.username);
    if (r.error) throw badRequest(r.error, { field: 'username' });
    if (isReservedAdminUsername(r.value) && !req.user.is_admin) throw conflict(USERNAME_TAKEN, { field: 'username' });
    const existing = users.byUsername.get(r.value);
    if (existing && existing.id !== req.user.id) throw conflict(USERNAME_TAKEN, { field: 'username' });
    fields.username = r.value;
  }
  if (req.body?.bio !== undefined) {
    const r = validate.bio(req.body.bio);
    if (r.error) throw badRequest(r.error, { field: 'bio' });
    fields.bio = r.value;
  }
  if (req.body?.statusText !== undefined) {
    const r = validate.bio(req.body.statusText, 80);
    if (r.error) throw badRequest(r.error, { field: 'statusText' });
    fields.status_text = r.value;
  }
  if (req.body?.avatarColor !== undefined) {
    if (!AVATAR_COLORS.includes(req.body.avatarColor)) throw badRequest('Неизвестный цвет аватара');
    fields.avatar_color = req.body.avatarColor;
  }
  const ownedImage = (value, label) => {
    const id = validate.id(value);
    if (id.error) throw badRequest(`Некорректный ${label}`);
    const m = media.byId.get(id.value);
    if (!m || m.owner_id !== req.user.id || m.kind !== 'image') throw forbidden('Можно использовать только своё изображение');
    return String(id.value);
  };
  let avatar = undefined;
  let profileBg = undefined;
  let profileBanner = undefined;
  let profileBannerVideo = undefined;
  let premiumBadge = undefined;
  let premiumEmoji = undefined;
  let profileEffects = undefined;
  if (req.body?.avatarMediaId !== undefined) avatar = req.body.avatarMediaId === null ? null : ownedImage(req.body.avatarMediaId, 'аватар');
  if (req.body?.profileBgMediaId !== undefined) profileBg = req.body.profileBgMediaId === null ? null : ownedImage(req.body.profileBgMediaId, 'фон');
  if (req.body?.profileBannerMediaId !== undefined) profileBanner = req.body.profileBannerMediaId === null ? null : ownedImage(req.body.profileBannerMediaId, 'баннер');
  if (req.body?.premiumBadge !== undefined) {
    const badge = req.body.premiumBadge;
    if (badge !== null && !['aurora', 'diamond', 'crown', 'spark', 'seal'].includes(badge)) throw badRequest('Неизвестный значок Premium');
    if (badge !== null && !commerce.premium.get(req.user.id, now())) throw forbidden('Значки доступны только с Premium');
    premiumBadge = badge;
  }
  if (req.body?.premiumEmoji !== undefined) {
    const emoji = req.body.premiumEmoji;
    if (emoji !== null && !PREMIUM_EMOJI_IDS.includes(emoji)) throw badRequest('Неизвестный Premium-эмодзи');
    if (emoji !== null && !commerce.premium.get(req.user.id, now())) throw forbidden('Эмодзи рядом с именем доступны только с Premium');
    premiumEmoji = emoji;
  }
  if (req.body?.profileBannerVideoMediaId !== undefined) {
    const value = req.body.profileBannerVideoMediaId;
    if (value === null) {
      profileBannerVideo = null;
    } else {
      if (!commerce.premium.get(req.user.id, now())) throw forbidden('Видео-баннер доступен только с Premium');
      const id = validate.id(value);
      if (id.error) throw badRequest('Некорректный видео-баннер');
      const video = media.byId.get(id.value);
      if (!video || video.owner_id !== req.user.id || video.kind !== 'video') throw forbidden('Можно использовать только своё видео');
      if (!['video/mp4', 'video/webm'].includes(video.mime)) throw badRequest('Для видео-баннера поддерживаются MP4 и WebM');
      if (video.size > PREMIUM_LIMITS.bannerVideoBytes) throw badRequest('Видео-баннер не должен превышать 50 МБ');
      profileBannerVideo = id.value;
    }
  }
  if (req.body?.profileEffects !== undefined) {
    const effects = req.body.profileEffects;
    if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw badRequest('Некорректное оформление профиля');
    if (!PROFILE_EFFECT_THEMES.includes(effects.theme)) throw badRequest('Неизвестная тема оформления');
    if (!PROFILE_RINGS.includes(effects.ring)) throw badRequest('Неизвестное кольцо аватара');
    if (!PROFILE_NAME_EFFECTS.includes(effects.nameFx)) throw badRequest('Неизвестный эффект имени');
    if (!Number.isInteger(effects.dim) || effects.dim < 0 || effects.dim > 6) throw badRequest('Некорректное затемнение баннера');
    profileEffects = JSON.stringify({
      theme: effects.theme,
      ring: effects.ring,
      nameFx: effects.nameFx,
      dim: effects.dim,
    });
  }
  if (req.body?.profileTheme !== undefined && !PROFILE_THEMES.includes(req.body.profileTheme)) throw badRequest('Неизвестная тема профиля');
  const profileEmoji = req.body?.profileEmoji === undefined ? null : String(req.body.profileEmoji).trim().slice(0, 8);
  let profileText = null;
  if (req.body?.profileText !== undefined) {
    const textResult = validate.bio(req.body.profileText, 180);
    if (textResult.error) throw badRequest(textResult.error, { field: 'profileText' });
    profileText = textResult.value;
  }
  let personalChannelId = null;
  if (req.body?.personalChannelId !== undefined) {
    const id = req.body.personalChannelId === null ? null : validate.id(req.body.personalChannelId);
    if (id && id.error) throw badRequest(id.error);
    if (id) {
      const channel = chats.byId.get(id.value);
      if (!channel || channel.type !== 'channel' || channel.owner_id !== req.user.id) throw forbidden('Можно выбрать только свой канал');
      personalChannelId = id.value;
    }
  }

  users.update.run({
    id: req.user.id,
    name: fields.name ?? null,
    username: fields.username ?? null,
    bio: fields.bio ?? null,
    status_text: fields.status_text ?? null,
    avatar_color: fields.avatar_color ?? null,
    updated_at: now(),
  });
  if (avatar !== undefined) users.setAvatar.run(avatar, now(), req.user.id);
  if (profileBg !== undefined) users.setProfileBg.run(profileBg, now(), req.user.id);
  if (premiumBadge !== undefined) users.setPremiumBadge.run(premiumBadge, now(), req.user.id);
  if (premiumEmoji !== undefined) users.setPremiumEmoji.run(premiumEmoji, now(), req.user.id);
  if (profileEffects !== undefined) users.setProfileEffects.run(profileEffects, now(), req.user.id);
  if (profileBannerVideo !== undefined) users.setProfileBannerVideo.run(profileBannerVideo, now(), req.user.id);
  if (profileBanner !== undefined) users.setProfileStyle.run({ id: req.user.id, profile_banner: profileBanner, profile_banner_set: 1, profile_theme: req.body.profileTheme ?? null, profile_emoji: profileEmoji, profile_text: profileText, profile_stickers: req.body.profileStickers ? JSON.stringify(Array.isArray(req.body.profileStickers) ? req.body.profileStickers.slice(0, 12) : []) : null, personal_channel_id: personalChannelId, updated_at: now() });
  else if (req.body.profileTheme !== undefined || profileEmoji !== null || profileText !== null || req.body.profileStickers !== undefined || req.body.personalChannelId !== undefined) users.setProfileStyle.run({ id: req.user.id, profile_banner: null, profile_banner_set: 0, profile_theme: req.body.profileTheme ?? null, profile_emoji: profileEmoji, profile_text: profileText, profile_stickers: req.body.profileStickers !== undefined ? JSON.stringify(Array.isArray(req.body.profileStickers) ? req.body.profileStickers.slice(0, 12) : []) : null, personal_channel_id: personalChannelId, updated_at: now() });
  if (req.body?.personalChannelId === null) users.clearPersonalChannel.run(now(), req.user.id);

  const fresh = users.byId.get(req.user.id);
  const dto = userDTO(fresh, req.user.id);
  broadcastToContacts(req.user.id, { type: 'user.update', userId: req.user.id, payload: { user: userDTO(fresh, null) }, ts: now() });
  res.json({ user: dto, settings: settingsDTO(settings.byUser.get(req.user.id)) });
}));

export default authRouter;
