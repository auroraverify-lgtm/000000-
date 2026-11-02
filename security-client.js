import crypto from 'node:crypto';
import { SECURITY_INTERNAL_URL, SECURITY_SSO_SECRET } from './config.js';
let warnedUnavailable = false;

async function postSecurity(path, payload) {
  if (Buffer.byteLength(SECURITY_SSO_SECRET) < 32) {
    if (!warnedUnavailable) {
      console.warn('Aurora Security integration is disabled: AURORA_SECURITY_SSO_SECRET is not configured.');
      warnedUnavailable = true;
    }
    return null;
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString('hex');
  const signature = crypto.createHmac('sha256', SECURITY_SSO_SECRET)
    .update(`POST\n${path}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
  try {
    const response = await fetch(`${SECURITY_INTERNAL_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurora-Timestamp': timestamp,
        'X-Aurora-Nonce': nonce,
        'X-Aurora-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      console.error(`Aurora Security request ${path} failed with HTTP ${response.status}.`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Aurora Security request ${path} failed:`, error.message);
    return null;
  }
}

export async function checkOutgoingContent({ chatId, userId, context, text }) {
  const result = await postSecurity('/internal/content/check', { chatId, userId, context, text });
  if (!result || typeof result.blocked !== 'boolean'
    || !Array.isArray(result.blockedDomains) || !Array.isArray(result.blockedRules)) {
    throw Object.assign(new Error('Не удалось проверить сообщение в Aurora Security. Попробуйте позже.'), {
      status: 503,
      code: 'security_unavailable',
      expose: true,
    });
  }
  return result;
}

export function moderateGroupMessage({ chatId, messageId, userId, context, text }) {
  return postSecurity('/internal/moderation/message', { chatId, messageId, userId, context, text });
}

export function requestSecurityVerification({ userId, kind }) {
  return postSecurity('/internal/verification/request', { userId, kind });
}

export function getSecurityVerification(userId) {
  return postSecurity('/internal/verification/status', { userId });
}
