/**
 * Безопасность: хеширование паролей, JWT, валидация, rate limiting, подписанные URL.
 */
import crypto from 'node:crypto';
import { SECRET, SESSION_DAYS, RATE } from './config.js';
import { getActiveSecurityLevel } from './security-store.js';

/* ───────────────────────── Пароли (scrypt) ───────────────────────── */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const dk = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${dk.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const dk = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: +N, r: +r, p: +p });
    const known = Buffer.from(hash, 'base64url');
    return dk.length === known.length && crypto.timingSafeEqual(dk, known);
  } catch { return false; }
}

/* ───────────────────────── JWT (HS256) ───────────────────────── */
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken(user, sessionId = crypto.randomBytes(32).toString('base64url')) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({
    sub: user.id, tv: user.token_version,
    jti: sessionId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
  }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function createTotpSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(20);
  let out = ''; let bits = 0; let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(value) {
  const clean = String(value).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function verifyTotp(secret, code, timestamp = Date.now()) {
  const normalized = String(code || '').replace(/\s|-/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter + offset));
    const digest = crypto.createHmac('sha1', key).update(msg).digest();
    const pos = digest[digest.length - 1] & 15;
    const value = (digest[pos] & 127) * 0x1000000 + (digest[pos + 1] & 255) * 0x10000 + (digest[pos + 2] & 255) * 0x100 + (digest[pos + 3] & 255);
    if (String(value % 1000000).padStart(6, '0') === normalized) return true;
  }
  return false;
}

export function hashOneTimeCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function hashEmailVerificationCode(userId, code) {
  return crypto.createHmac('sha256', SECRET).update(`${userId}:${code}`).digest('hex');
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = sign(`${h}.${p}`);
  const a = Buffer.from(s), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

/* ───────────────────────── Подписанные URL для медиа ─────────────────────────
   Файлы не отдаются по «угадываемому» пути: ссылка содержит HMAC и срок жизни. */
export function signMedia(mediaId, ttlMs = 7 * 24 * 3600 * 1000, variant = '') {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', SECRET).update(`${mediaId}:${variant}:${exp}`).digest('base64url').slice(0, 32);
  return `/media/${mediaId}${variant ? '/' + variant : ''}?e=${exp}&s=${sig}`;
}
export function checkMediaSig(mediaId, variant, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', SECRET).update(`${mediaId}:${variant}:${exp}`).digest('base64url').slice(0, 32);
  const a = Buffer.from(String(sig)), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ───────────────────────── Rate limiting (token bucket per key) ───────────────────────── */
const buckets = new Map();

export function rateLimit(kind, key) {
  const [configuredMax, windowMs] = RATE[kind] || RATE.read;
  const level = getActiveSecurityLevel();
  const multiplier = level >= 2 ? 0.25 : level >= 1 ? 0.5 : 1;
  const max = Math.max(1, Math.floor(configuredMax * multiplier));
  const id = `${kind}:${key}`;
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || now - b.start >= windowMs) { b = { start: now, count: 0 }; buckets.set(id, b); }
  b.count++;
  if (buckets.size > 20000) { // защита от неограниченного роста памяти
    for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  }
  return { ok: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: Math.ceil((b.start + windowMs - now) / 1000) };
}

/* ───────────────────────── Валидация ───────────────────────── */
const USERNAME_RE = /^[a-z0-9_]{4,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export const validate = {
  email(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return { error: 'Укажите e-mail' };
    if (s.length > 190) return { error: 'E-mail слишком длинный' };
    if (!EMAIL_RE.test(s)) return { error: 'Некорректный e-mail' };
    return { value: s };
  },
  username(v) {
    const s = String(v || '').trim().replace(/^@/, '').toLowerCase();
    if (!s) return { error: 'Укажите username' };
    if (s.length < 4) return { error: 'Username короче 4 символов' };
    if (s.length > 24) return { error: 'Username длиннее 24 символов' };
    if (!USERNAME_RE.test(s)) return { error: 'Только латиница, цифры и _' };
    return { value: s };
  },
  password(v) {
    const s = String(v || '');
    if (s.length < 8) return { error: 'Пароль короче 8 символов' };
    if (s.length > 200) return { error: 'Слишком длинный пароль' };
    if (!/[a-zA-Zа-яА-Я]/.test(s) || !/\d/.test(s)) return { error: 'Пароль должен содержать буквы и цифры' };
    return { value: s };
  },
  name(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (s.length < 2) return { error: 'Имя короче 2 символов' };
    if (s.length > 64) return { error: 'Имя длиннее 64 символов' };
    return { value: s };
  },
  bio(v, max = 400) {
    const s = String(v ?? '').trim();
    if (s.length > max) return { error: `Описание длиннее ${max} символов` };
    return { value: s };
  },
  text(v) {
    const s = String(v ?? '');
    if (!s.trim()) return { error: 'Пустое сообщение' };
    if (s.length > 4096) return { error: 'Сообщение длиннее 4096 символов' };
    return { value: s };
  },
  id(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: 'Некорректный идентификатор' };
    return { value: n };
  },
  int(v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'Ожидалось целое число' };
    return { value: Math.min(max, Math.max(min, n)) };
  },
};

/** Убираем управляющие символы и нормализуем переводы строк (защита от инъекций в UI). */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 4096);
}

export const sanitize = { cleanText };

/* ───────────────────────── Загрузка файлов: sniffing ───────────────────────── */
const SIGNATURES = [
  { kind: 'image', mime: 'image/jpeg', ext: 'jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { kind: 'image', mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { kind: 'image', mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: 'image', mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: (b) => b.slice(8, 12).toString() === 'WEBP' },
  { kind: 'video', mime: 'video/mp4', ext: 'mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { kind: 'video', mime: 'video/webm', ext: 'webm', bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  { kind: 'audio', mime: 'audio/ogg', ext: 'ogg', bytes: [0x4F, 0x67, 0x67, 0x53] },
  { kind: 'audio', mime: 'audio/aac', ext: 'aac', bytes: [0xFF, 0xF1] },
  { kind: 'audio', mime: 'audio/aac', ext: 'aac', bytes: [0xFF, 0xF9] },
  { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3', bytes: [0x49, 0x44, 0x33] },
  { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3', bytes: [0xFF, 0xFB] },
  { kind: 'audio', mime: 'audio/wav', ext: 'wav', bytes: [0x52, 0x49, 0x46, 0x46], extra: (b) => b.slice(8, 12).toString() === 'WAVE' },
  { kind: 'audio', mime: 'audio/mp4', ext: 'm4a', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { kind: 'file', mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { kind: 'file', mime: 'application/zip', ext: 'zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
];

export function sniff(buffer, declaredMime = '', filename = '') {
  for (const s of SIGNATURES) {
    const slice = buffer.slice(s.offset || 0, (s.offset || 0) + s.bytes.length);
    if (slice.length < s.bytes.length) continue;
    if (!s.bytes.every((b, i) => slice[i] === b)) continue;
    if (s.extra && !s.extra(buffer)) continue;
    return { kind: s.kind, mime: s.mime, ext: s.ext };
  }
  // Текстовые файлы: безопасно, если реально текст и не похоже на скрипт с исполнением
  const head = buffer.slice(0, 512).toString('utf8');
  const looksText = !/[\u0000-\u0008\u000E-\u001F]/.test(head);
  if (looksText && /^text\//.test(declaredMime)) {
    return { kind: 'file', mime: declaredMime.split(';')[0], ext: (filename.split('.').pop() || 'txt').slice(0, 8).replace(/[^a-z0-9]/gi, '') || 'txt' };
  }
  return { kind: 'file', mime: 'application/octet-stream', ext: 'bin' };
}

/** Опасные расширения блокируем, даже если внутри «безобидный» контейнер. */
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'sh', 'bash', 'ps1', 'scr', 'vbs', 'js', 'mjs', 'jar', 'dll', 'php', 'py', 'rb', 'html', 'htm', 'svg', 'hta', 'cpl', 'gadget']);
export function extBlocked(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return BLOCKED_EXT.has(ext);
}
