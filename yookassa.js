import { randomUUID } from 'node:crypto';

const DEFAULT_API_URL = 'https://api.yookassa.ru/v3';
const API_TIMEOUT_MS = 10_000;

export class YooKassaError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'YooKassaError';
    this.status = status;
  }
}

function getConfig(mode = process.env.YOOKASSA_MODE) {
  const isLive = mode === 'live';
  const liveEnabled = process.env.NODE_ENV === 'production' && process.env.YOOKASSA_LIVE_ENABLED === '1';
  const shopId = String(isLive
    ? process.env.YOOKASSA_LIVE_SHOP_ID || ''
    : process.env.YOOKASSA_SHOP_ID || '').trim();
  const secretKey = String(isLive
    ? process.env.YOOKASSA_LIVE_SECRET_KEY || ''
    : process.env.YOOKASSA_SECRET_KEY || '');
  const publicOriginValue = String(process.env.PUBLIC_ORIGIN || '');
  const apiUrlValue = String(process.env.YOOKASSA_API_URL || DEFAULT_API_URL);

  if (!['test', 'live'].includes(mode) || (isLive && !liveEnabled)
    || !/^\d+$/.test(shopId) || !secretKey || !publicOriginValue) {
    throw new YooKassaError('Оплата YooKassa не настроена или отключена.', 503);
  }

  let publicOrigin;
  let apiUrl;
  try {
    publicOrigin = new URL(publicOriginValue);
    apiUrl = new URL(apiUrlValue);
  } catch {
    throw new YooKassaError('Некорректная конфигурация YooKassa.', 503);
  }

  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password
    || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
    throw new YooKassaError('PUBLIC_ORIGIN должен быть точным HTTPS-origin.', 503);
  }
  const localTestApi = process.env.NODE_ENV === 'test'
    && apiUrl.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname);
  if ((!localTestApi && apiUrl.protocol !== 'https:') || apiUrl.username || apiUrl.password
    || apiUrl.pathname.replace(/\/+$/, '') !== '/v3' || apiUrl.search || apiUrl.hash) {
    throw new YooKassaError('Некорректный адрес API YooKassa.', 503);
  }
  if (isLive && (apiUrl.origin !== 'https://api.yookassa.ru' || localTestApi)) {
    throw new YooKassaError('Live-оплата разрешена только через официальный API YooKassa.', 503);
  }

  return {
    mode,
    shopId,
    secretKey,
    publicOrigin: publicOrigin.origin,
    apiUrl: apiUrl.origin + apiUrl.pathname.replace(/\/+$/, ''),
  };
}

export function isYooKassaConfigured() {
  try {
    getConfig();
    return true;
  } catch (error) {
    if (error instanceof YooKassaError) return false;
    throw error;
  }
}

export function getYooKassaMode() {
  try {
    return getConfig().mode;
  } catch (error) {
    if (error instanceof YooKassaError) return null;
    throw error;
  }
}

async function request(path, { mode = process.env.YOOKASSA_MODE, method = 'GET', body, idempotencyKey } = {}) {
  const config = getConfig(mode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.shopId}:${config.secretKey}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotence-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result !== 'object') {
      throw new YooKassaError('Платёжный провайдер не смог обработать запрос.', 502);
    }
    return result;
  } catch (error) {
    if (error instanceof YooKassaError) throw error;
    throw new YooKassaError('Не удалось связаться с платёжным провайдером.', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function createYooKassaPayment({ orderId, amount, description, returnPath }) {
  if (!/^[\da-f-]{36}$/i.test(orderId) || !Number.isSafeInteger(amount) || amount < 1
    || typeof description !== 'string' || description.length < 1 || description.length > 128
    || typeof returnPath !== 'string' || !returnPath.startsWith('/#/commerce?paymentOrder=')) {
    throw new YooKassaError('Некорректные параметры платежа.', 400);
  }
  const { publicOrigin } = getConfig();
  return request('/payments', {
    method: 'POST',
    idempotencyKey: orderId,
    body: {
      amount: { value: `${(amount / 100).toFixed(2)}`, currency: 'RUB' },
      payment_method_data: { type: 'sbp' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: `${publicOrigin}${returnPath}`,
      },
      description,
      metadata: { order_id: orderId },
    },
  });
}

export function isYooKassaConfirmationUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username && !url.password
      && ['yookassa.ru', 'yoomoney.ru'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function getYooKassaPayment(paymentId, mode = process.env.YOOKASSA_MODE) {
  if (typeof paymentId !== 'string' || !/^[\da-f-]{36}$/i.test(paymentId)) {
    throw new YooKassaError('Некорректный идентификатор платежа.', 400);
  }
  return request(`/payments/${encodeURIComponent(paymentId)}`, { mode });
}

export function newPaymentOrderId() {
  return randomUUID();
}
