import crypto from 'node:crypto';
import { SECURITY_SSO_SECRET } from './config.js';

const nonces = new Map();
const MAX_NONCES = 20000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 600;
let requestWindow = { startedAt: Date.now(), count: 0 };

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function requireSecurityService(req, res, next) {
  const now = Date.now();
  const timestamp = String(req.get('x-aurora-timestamp') || '');
  const nonce = String(req.get('x-aurora-nonce') || '');
  const signature = String(req.get('x-aurora-signature') || '');
  if (!SECURITY_SSO_SECRET || Buffer.byteLength(SECURITY_SSO_SECRET) < 32
    || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000
    || !/^[a-f0-9]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: 'Подпись Aurora Security не подтверждена' });
  }

  const body = JSON.stringify(req.body ?? {});
  const expected = crypto.createHmac('sha256', SECURITY_SSO_SECRET)
    .update(`${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
  if (!safeEqualHex(signature, expected)) {
    return res.status(401).json({ error: 'Подпись Aurora Security не подтверждена' });
  }

  if (now - requestWindow.startedAt >= RATE_WINDOW_MS) requestWindow = { startedAt: now, count: 0 };
  if (++requestWindow.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ error: 'Слишком много запросов Aurora Security' });
  }

  for (const [usedNonce, expiresAt] of nonces) {
    if (expiresAt <= now) nonces.delete(usedNonce);
  }
  if (nonces.has(nonce)) return res.status(401).json({ error: 'Повторный запрос Aurora Security' });
  if (nonces.size >= MAX_NONCES) return res.status(503).json({ error: 'Временно исчерпан лимит запросов Aurora Security' });
  nonces.set(nonce, now + 60_000);
  next();
}
