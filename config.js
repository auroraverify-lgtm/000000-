/**
 * Aurora Messenger — конфигурация сервера.
 * Все секреты/лимиты в одном месте, значения можно переопределить переменными окружения.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const UPLOAD_TEMP_DIR = path.join(DATA_DIR, '.upload-tmp');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DB_FILE = path.join(DATA_DIR, 'aurora.db');
export const SECURITY_STORE_FILE = process.env.SECURITY_STORE_FILE || path.join(DATA_DIR, 'security-events.db');

for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true, mode: 0o700 });

/** Постоянный секрет: генерируется один раз и переживает перезапуски (иначе ломались бы сессии). */
const secretFile = path.join(DATA_DIR, 'instance.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
export const SECRET = process.env.APP_SECRET || fs.readFileSync(secretFile, 'utf8').trim();

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';
export const SECURITY_PUBLIC_URL = String(process.env.SECURITY_PUBLIC_URL || '').replace(/\/+$/, '');
export const SECURITY_SSO_SECRET = String(process.env.AURORA_SECURITY_SSO_SECRET || '');
export const SECURITY_INTERNAL_URL = String(process.env.SECURITY_INTERNAL_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const securityInternal = new URL(SECURITY_INTERNAL_URL);
const securityInternalHost = securityInternal.hostname.replace(/^\[|\]$/g, '');
if (!['http:', 'https:'].includes(securityInternal.protocol)
  || securityInternal.username || securityInternal.password
  || securityInternal.pathname !== '/' || securityInternal.search || securityInternal.hash
  || (process.env.NODE_ENV === 'production' && securityInternal.protocol !== 'https:'
    && !['127.0.0.1', 'localhost', '::1'].includes(securityInternalHost))) {
  throw new Error('SECURITY_INTERNAL_URL must use HTTPS except for a loopback address.');
}

export const SESSION_DAYS = 30;

export const EMAIL_VERIFICATION = {
  codeTtlMs: 10 * 60 * 1000,
  resendCooldownMs: 60 * 1000,
  maxAttempts: 5,
  accountDeadlineMs: 48 * 60 * 60 * 1000,
};

export const PASSWORD_RESET = {
  tokenTtlMs: 60 * 60 * 1000,
  resendCooldownMs: 60 * 1000,
};

/** Лимиты загрузок по типам контента (байты). */
export const LIMITS = {
  image: 100 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  voice: 50 * 1024 * 1024,
  file: 500 * 1024 * 1024,
  avatar: 20 * 1024 * 1024,
};

export const PREMIUM_LIMITS = {
  free: { channels: 10, groups: 10 },
  premium: { channels: 40, groups: 50 },
  bannerVideoBytes: 50 * 1024 * 1024,
};
export const PREMIUM_WALLPAPER_IDS = ['p-nebula', 'p-gold', 'p-emerald', 'p-rose', 'p-ice'];

/** Лимиты частоты: [максимум запросов, окно в мс] на ключ (обычно IP + маршрут).
 *  RATE_MULT используется тестами/нагрузочными прогонами и не влияет на продовые значения по умолчанию. */
const rateMult = Math.max(1, Number(process.env.RATE_MULT || 1));
export const RATE = {
  auth: [Math.round(12 * rateMult), 10 * 60 * 1000],
  authIp: [Math.round(30 * rateMult), 10 * 60 * 1000],
  authAccount: [Math.round(12 * rateMult), 10 * 60 * 1000],
  write: [Math.round(240 * rateMult), 60 * 1000],
  read: [Math.round(1200 * rateMult), 60 * 1000],
  upload: [Math.round(90 * rateMult), 60 * 1000],
  search: [Math.round(180 * rateMult), 60 * 1000],
};

export const MESSAGES_PAGE = 40; // размер страницы пагинации сообщений
export const CHATS_PAGE = 60;
export const MAX_TEXT = 4096;
export const MAX_BIO = 400;

export const COMMERCE = {
  currency: 'Аврора',
  symbol: '✦',
  balancePackages: [
    { id: 'aurora-100', auroras: 100, price: 10, currency: 'RUB' },
    { id: 'aurora-500', auroras: 500, price: 279, currency: 'RUB' },
    { id: 'aurora-1000', auroras: 1000, price: 589, currency: 'RUB' },
    { id: 'aurora-2500', auroras: 2500, price: 1399, currency: 'RUB' },
  ],
  premiumPlans: [
    { id: 'premium-1m', months: 1, price: 99, currency: 'RUB' },
    { id: 'premium-3m', months: 3, price: 289, currency: 'RUB' },
    { id: 'premium-6m', months: 6, price: 589, currency: 'RUB' },
    { id: 'premium-12m', months: 12, price: 1099, currency: 'RUB' },
  ],
  gifts: [
    { id: 'rose', emoji: '🌹', name: 'Роза', description: 'Тёплый знак внимания', price: 100, animation: 'bloom' },
    { id: 'star', emoji: '⭐', name: 'Звезда', description: 'Для тех, кто сияет', price: 250, animation: 'sparkle' },
    { id: 'diamond', emoji: '💎', name: 'Алмаз', description: 'Редкий и яркий подарок', price: 500, animation: 'diamond' },
    { id: 'crown', emoji: '👑', name: 'Корона', description: 'Для настоящего главного героя', price: 1000, animation: 'crown' },
    { id: 'rocket', emoji: '🚀', name: 'Ракета', description: 'Пусть всё взлетит', price: 2500, animation: 'rocket' },
    { id: 'galaxy', emoji: '🌌', name: 'Галактика', description: 'Целая вселенная в одном подарке', price: 5000, animation: 'galaxy' },
    { id: 'aurora', emoji: '✨', name: 'Аврора', description: 'Фирменное сияние Aurora', price: 10000, animation: 'aurora' },
  ],
};
