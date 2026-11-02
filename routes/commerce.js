import express from 'express';
import { COMMERCE } from '../config.js';
import { db, commerce, chats, users, settings, blocks, now, tx } from '../db.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { cleanText } from '../security.js';
import { createMessage, publishCreatedMessage } from '../services/messages.js';
import { canViewProfile, publicUser, sharesContact } from '../helpers.js';
import { assertOutgoingContent } from '../outgoing-content.js';
import { indexChat } from '../realtime.js';
import { giftImageUrl } from '../helpers.js';
import {
  createYooKassaPayment, getYooKassaPayment, isYooKassaConfigured, isYooKassaConfirmationUrl,
  getYooKassaMode, newPaymentOrderId, YooKassaError,
} from '../yookassa.js';

function commerceConfig() {
  const read = (key, fallback) => {
    const row = commerce.config.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  };
  return {
    ...COMMERCE,
    balancePackages: read('balancePackages', COMMERCE.balancePackages),
    premiumPlans: read('premiumPlans', COMMERCE.premiumPlans),
  };
}

export const commerceRouter = express.Router();

function minorUnits(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

function verifiedOrderForPayment(payment) {
  if (!payment || typeof payment.id !== 'string' || typeof payment.metadata?.order_id !== 'string') return null;
  const order = commerce.paymentOrder.byId.get(payment.metadata.order_id)
    || commerce.paymentOrder.byProviderId.get(payment.id);
  if (!order || payment.metadata.order_id !== order.id
    || (order.provider_payment_id && order.provider_payment_id !== payment.id)
    || minorUnits(payment.amount?.value) !== order.amount_minor
    || payment.amount?.currency !== order.currency) return null;
  return order;
}

function applyPaymentStatus(payment) {
  const order = verifiedOrderForPayment(payment);
  if (!order) return false;
  const ts = now();
  return tx(() => {
    const current = commerce.paymentOrder.byId.get(order.id);
    if (!current || (current.provider_payment_id && current.provider_payment_id !== payment.id)) return false;
    if (current.status === 'succeeded' || current.status === 'canceled') return true;

    commerce.paymentOrder.attachProvider.run(
      payment.id,
      payment.confirmation?.confirmation_url || current.confirmation_url,
      payment.status,
      ts,
      current.id,
      payment.id,
    );

    if (payment.status === 'succeeded' && payment.paid === true) {
      const changed = commerce.paymentOrder.markSucceeded.run(ts, ts, current.id).changes;
      if (!changed) return commerce.paymentOrder.byId.get(current.id)?.status === 'succeeded';
      if (current.kind === 'auroras') {
        commerce.ensureWallet.run(current.user_id, ts);
        const walletRow = commerce.wallet.get(current.user_id);
        const balance = walletRow.balance + current.units;
        commerce.updateWallet.run(balance, ts, current.user_id);
        commerce.transaction.run(
          current.user_id,
          'purchase',
          current.units,
          balance,
          'yookassa_payment',
          current.id,
          JSON.stringify({ amountMinor: current.amount_minor, currency: current.currency }),
          ts,
        );
        commerce.addPurchase.run(current.user_id, current.product_id, current.units, current.amount_minor / 100, 'yookassa', ts);
      } else {
        const active = commerce.premium.get(current.user_id, ts);
        const startsAt = active ? active.expires_at : ts;
        const expiresAt = startsAt + current.units * 30 * 24 * 60 * 60 * 1000;
        commerce.addPremium.run(current.user_id, current.product_id, startsAt, expiresAt, 'active', 'yookassa', ts);
      }
    } else if (payment.status === 'canceled') {
      commerce.paymentOrder.markCanceled.run(payment.status, ts, current.id);
    } else {
      commerce.paymentOrder.updateProviderStatus.run(String(payment.status || ''), ts, current.id);
    }
    return true;
  })();
}

commerceRouter.post('/yookassa/webhook', limit('write'), wrap(async (req, res) => {
  const notification = req.body;
  const paymentId = notification?.object?.id;
  if (typeof paymentId !== 'string' || !/^[\da-f-]{36}$/i.test(paymentId)
    || typeof notification?.event !== 'string') {
    return res.status(400).json({ error: 'Некорректное уведомление YooKassa' });
  }
  if (!['payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture'].includes(notification.event)) {
    return res.sendStatus(200);
  }
  const orderId = notification.object?.metadata?.order_id;
  const order = (typeof orderId === 'string' && commerce.paymentOrder.byId.get(orderId))
    || commerce.paymentOrder.byProviderId.get(paymentId);
  if (!order) return res.sendStatus(200);
  if ((order.provider_payment_id && order.provider_payment_id !== paymentId)
    || (!order.provider_payment_id && order.status !== 'creating')) return res.sendStatus(200);

  const payment = await getYooKassaPayment(paymentId, order.provider_mode);
  if (payment.id !== paymentId) return res.status(502).json({ error: 'Не удалось подтвердить уведомление YooKassa' });
  if (!verifiedOrderForPayment(payment)) return res.status(400).json({ error: 'Платёж не соответствует заказу' });
  applyPaymentStatus(payment);
  return res.sendStatus(200);
}));

commerceRouter.use(requireAuth);

function paymentOperationKey(req) {
  const value = String(req.body?.idempotencyKey || req.get('Idempotency-Key') || '').trim();
  if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(value)) throw badRequest('Некорректный ключ операции');
  return value;
}

function receiptEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest('Укажите корректную почту для чека');
  }
  return email;
}

async function createCheckout(req, res, kind, product) {
  const currentMode = getYooKassaMode();
  if (!currentMode || !isYooKassaConfigured()) {
    return res.status(503).json({
      error: 'Оплата YooKassa не настроена или отключена',
      code: 'payments_unavailable',
    });
  }
  const idempotencyKey = paymentOperationKey(req);
  const email = receiptEmail(req.body?.receiptEmail);
  const existing = commerce.paymentOrder.byUserKey.get(req.user.id, idempotencyKey);
  if (existing && (existing.kind !== kind || existing.product_id !== product.id
    || existing.provider_mode !== currentMode || existing.receipt_email !== email)) {
    throw conflict('Ключ операции уже использован для другой покупки');
  }

  const ts = now();
  const orderId = existing?.id || newPaymentOrderId();
  if (!existing) {
    const units = kind === 'auroras' ? product.auroras : product.months;
    const amountMinor = minorUnits(product.price);
    if (!Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(amountMinor) || amountMinor < 1
      || product.currency !== 'RUB') {
      throw badRequest('Цена товара настроена некорректно');
    }
    commerce.paymentOrder.create.run(
      orderId,
      req.user.id,
      kind,
      product.id,
      units,
      amountMinor,
      idempotencyKey,
      email,
      ts,
      ts,
      currentMode,
    );
  }
  const order = commerce.paymentOrder.byUserKey.get(req.user.id, idempotencyKey);
  if (!order) throw new Error('Payment order was not persisted');
  if (order.kind !== kind || order.product_id !== product.id) {
    throw conflict('Ключ операции уже использован для другой покупки');
  }
  if (order.receipt_email !== email) {
    throw conflict('Для этого заказа уже указана другая почта');
  }
  if (!Number.isSafeInteger(order.amount_minor) || order.amount_minor < 1) {
    throw badRequest('Цена товара настроена некорректно');
  }
  if (order.status === 'succeeded') {
    return res.json({ orderId: order.id, status: order.status });
  }
  if (order.status === 'canceled') throw conflict('Этот платёж отменён. Создайте новый заказ.');
  if (order.status === 'pending' && order.confirmation_url) {
    return res.json({ orderId: order.id, status: order.status, confirmationUrl: order.confirmation_url });
  }

  const returnPath = `/#/commerce?paymentOrder=${encodeURIComponent(order.id)}`;
  let payment;
  try {
    payment = await createYooKassaPayment({
      orderId: order.id,
      amount: order.amount_minor,
      description: kind === 'auroras'
        ? `Покупка ${order.units} Аврор`
        : `Aurora Premium на ${order.units} мес.`,
      returnPath,
    });
  } catch (error) {
    if (error instanceof YooKassaError) {
      return res.status(error.status).json({ error: error.message, code: 'payments_unavailable' });
    }
    throw error;
  }

  const confirmationUrl = payment.confirmation?.confirmation_url;
  if (typeof payment.id !== 'string' || !/^[\da-f-]{36}$/i.test(payment.id)
    || !isYooKassaConfirmationUrl(confirmationUrl)) {
    return res.status(502).json({ error: 'Провайдер вернул некорректные данные платежа', code: 'payment_provider_error' });
  }
  commerce.paymentOrder.attachProvider.run(
    payment.id,
    confirmationUrl,
    String(payment.status || 'pending'),
    now(),
    order.id,
    payment.id,
  );
  applyPaymentStatus(payment);
  const saved = commerce.paymentOrder.byId.get(order.id);
  if (saved.status === 'succeeded') return res.json({ orderId: saved.id, status: saved.status });
  return res.status(201).json({
    orderId: saved.id,
    status: saved.status,
    confirmationUrl: saved.confirmation_url,
  });
}

commerceRouter.get('/payments/:id', limit('read'), wrap(async (req, res) => {
  if (!/^[\da-f-]{36}$/i.test(req.params.id)) throw badRequest('Некорректный идентификатор платежа');
  let order = commerce.paymentOrder.byUserId.get(req.params.id, req.user.id);
  if (!order) throw notFound('Платёж не найден');
  if (req.query.refresh === '1' && order.provider_payment_id && order.status === 'pending') {
    const payment = await getYooKassaPayment(order.provider_payment_id, order.provider_mode);
    if (payment.id !== order.provider_payment_id || !verifiedOrderForPayment(payment)) {
      return res.status(502).json({ error: 'Не удалось подтвердить статус платежа' });
    }
    applyPaymentStatus(payment);
    order = commerce.paymentOrder.byUserId.get(req.params.id, req.user.id);
  }
  res.json({
    id: order.id,
    kind: order.kind,
    productId: order.product_id,
    units: order.units,
    amount: order.amount_minor / 100,
    currency: order.currency,
    status: order.status,
    paidAt: order.paid_at,
  });
}));

function wallet(userId) {
  commerce.ensureWallet.run(userId, now());
  return commerce.wallet.get(userId);
}

function giftDTO(row) {
  return row ? {
    id: row.gift_id ?? row.id, emoji: row.emoji, name: row.name, description: row.description,
    price: row.price,     animation: row.animation, rarity: row.rarity || 'обычный',
    imageUrl: giftImageUrl({ id: row.gift_id ?? row.id, image_media_id: row.image_media_id }),
    sender: row.sender_username ? { username: row.sender_username, name: row.sender_name } : undefined,
    note: row.note, createdAt: row.created_at, instanceId: row.instance_id ?? (row.gift_id ? row.id : null),
    status: row.status || 'owned', hidden: !!row.is_hidden, pinned: row.pinned_order != null,
    stockTotal: row.stock_total ?? null, stockRemaining: row.stock_remaining ?? null,
    sellbackPercent: row.sellback_percent ?? 50,
  } : null;
}

function giftOperationKey(req) {
  const value = String(req.body?.idempotencyKey || req.get('Idempotency-Key') || '').trim();
  if (!value) return null;
  if (value.length > 100 || !/^[a-zA-Z0-9:_-]{8,100}$/.test(value)) throw badRequest('Некорректный ключ операции');
  return value;
}

function replayGiftOperation(userId, key, operation) {
  if (!key) return null;
  const saved = commerce.giftByIdempotency.get(userId, key);
  if (!saved) return null;
  if (saved.operation !== operation) throw conflict('Ключ операции уже использован для другого действия');
  return JSON.parse(saved.result_json);
}

commerceRouter.get('/catalog', wrap((req, res) => {
  const config = commerceConfig();
  const active = commerce.premium.get(req.user.id, now());
  const pending = db.prepare("SELECT id, plan_id, created_at FROM premium_subscriptions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(req.user.id);
  const isPaged = req.query.giftLimit !== undefined || req.query.giftOffset !== undefined;
  const giftLimit = req.query.giftLimit === undefined ? 24 : Number(req.query.giftLimit);
  const giftOffset = req.query.giftOffset === undefined ? 0 : Number(req.query.giftOffset);
  if (isPaged && (!Number.isSafeInteger(giftLimit) || giftLimit < 1 || giftLimit > 50
    || !Number.isSafeInteger(giftOffset) || giftOffset < 0 || giftOffset > 1000000)) {
    throw badRequest('Некорректные параметры каталога подарков');
  }
  const giftRows = isPaged ? commerce.giftPage.all(giftLimit, giftOffset) : commerce.gifts.all();
  const giftCount = isPaged ? commerce.giftCount.get().count : giftRows.length;
  res.json({
    currency: COMMERCE.currency, symbol: COMMERCE.symbol,
    paymentsEnabled: isYooKassaConfigured(),
    paymentMode: getYooKassaMode(),
    balancePackages: config.balancePackages,
    premiumPlans: config.premiumPlans,
    gifts: giftRows.map((g) => giftDTO(g)),
    giftsTotal: giftCount,
    giftsOffset: isPaged ? giftOffset : 0,
    giftsHasMore: isPaged && giftOffset + giftRows.length < giftCount,
    premium: active ? { planId: active.plan_id, expiresAt: active.expires_at } : null,
    premiumRequest: pending?.provider === 'demo' ? null : pending || null,
  });
}));

commerceRouter.get('/wallet', wrap((req, res) => {
  const w = wallet(req.user.id);
  res.json({
    balance: w.balance, currency: COMMERCE.currency, symbol: COMMERCE.symbol,
    transactions: commerce.transactions.all(req.user.id),
    purchases: commerce.purchases.all(req.user.id),
    sentGifts: db.prepare(`SELECT rg.*, g.emoji, g.name, g.animation, g.rarity, g.image_media_id, u.username AS recipient_username
      FROM received_gifts rg JOIN gifts g ON g.id = rg.gift_id JOIN users u ON u.id = rg.recipient_id
      WHERE rg.sender_id = ? ORDER BY rg.created_at DESC LIMIT 100`).all(req.user.id).map(giftDTO),
    receivedGifts: commerce.myGiftCollection.all(req.user.id).map((g) => giftDTO({ ...g, instance_id: g.id })),
  });
}));

commerceRouter.post('/wallet/purchase', limit('write'), wrap(async (req, res) => {
  const pack = commerceConfig().balancePackages.find((p) => p.id === String(req.body?.packageId));
  if (!pack) throw badRequest('Пакет Аврор не найден');
  return createCheckout(req, res, 'auroras', pack);
}));

commerceRouter.post('/premium/subscribe', limit('write'), wrap(async (req, res) => {
  const plan = commerceConfig().premiumPlans.find((p) => p.id === String(req.body?.planId));
  if (!plan) throw badRequest('Тариф Premium не найден');
  return createCheckout(req, res, 'premium', plan);
}));

commerceRouter.post('/gifts/send', limit('write'), wrap(async (req, res) => {
  const recipientId = Number(req.body?.recipientId);
  const note = cleanText(String(req.body?.note || '')).slice(0, 300);
  const operationKey = giftOperationKey(req);
  const replay = replayGiftOperation(req.user.id, operationKey, 'send');
  if (replay) {
    if (replay.recipientId !== recipientId || replay.giftId !== String(req.body?.giftId) || replay.note !== note) {
      throw conflict('Ключ операции уже использован с другими параметрами');
    }
    return res.status(200).json(replay);
  }
  const gift = commerce.gift.get(String(req.body?.giftId));
  if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId === req.user.id) throw badRequest('Некорректный получатель');
  if (!gift) throw notFound('Подарок не найден');
  const recipient = users.byId.get(recipientId);
  if (!recipient) throw notFound('Получатель не найден');
  const recipientSettings = settings.byUser.get(recipientId);
  const audience = recipientSettings?.privacy_messages || 'everyone';
  if (blocks.isBlocked.get(recipientId, req.user.id) || blocks.isBlocked.get(req.user.id, recipientId)
    || audience === 'nobody'
    || (audience === 'contacts' && !sharesContact(req.user.id, recipientId))) {
    throw forbidden('Пользователь ограничил переписку');
  }
  if (gift.stock_remaining !== null && gift.stock_remaining <= 0) throw conflict('Этот подарок уже закончился');
  if (wallet(req.user.id).balance < gift.price) throw forbidden(`Недостаточно Аврор. Нужно ${gift.price} ✦`);
  const key = `dm:${Math.min(req.user.id, recipientId)}:${Math.max(req.user.id, recipientId)}`;
  let chat = chats.byDmKey.get(key);
  if (!chat) {
    const info = tx(() => {
      const created = chats.create.run({
        type: 'dm', title: null, username: null, description: '', avatar_url: null, owner_id: null,
        is_public: 0, dm_key: key, created_at: now(),
      });
      const chatId = Number(created.lastInsertRowid);
      chats.addMember.run(chatId, req.user.id, 'member', now(), 0);
      chats.addMember.run(chatId, recipientId, 'member', now(), 0);
      return chatId;
    })();
    indexChat(info);
    chat = chats.byId.get(info);
  }
  if (!chat || chat.type !== 'dm' || chat.is_frozen
    || !chats.memberOf.get(chat.id, req.user.id) || !chats.memberOf.get(chat.id, recipientId)) {
    throw forbidden(chat?.is_frozen ? 'Чат временно заморожен администратором' : 'Нет доступа к личному чату');
  }
  await assertOutgoingContent({ chat, userId: req.user.id, text: note });
  const result = tx(() => {
    const savedOperation = operationKey ? commerce.giftByIdempotency.get(req.user.id, operationKey) : null;
    if (savedOperation) {
      if (savedOperation.operation !== 'send') throw conflict('Ключ операции уже использован для другого действия');
      const saved = JSON.parse(savedOperation.result_json);
      if (saved.recipientId !== recipientId || saved.giftId !== gift.id || saved.note !== note) throw conflict('Ключ операции уже использован с другими параметрами');
      return { replay: saved };
    }
    const stock = commerce.giftStock.run(gift.id);
    if (stock.changes !== 1) throw conflict('Этот подарок уже закончился');
    const w = wallet(req.user.id);
    if (w.balance < gift.price) throw forbidden(`Недостаточно Аврор. Нужно ${gift.price} ✦`);
    const ts = now();
    const balance = w.balance - gift.price;
    commerce.updateWallet.run(balance, ts, req.user.id);
    commerce.transaction.run(req.user.id, 'gift_sent', -gift.price, balance, 'gift', gift.id, JSON.stringify({ recipientId }), ts);
    const { row } = createMessage({ chat, sender: req.user, type: 'gift', text: note, createdAt: ts, deferPublish: true });
    const received = commerce.addReceived.run(gift.id, req.user.id, recipientId, row.id, note, gift.price, ts, operationKey);
    const instanceId = Number(received.lastInsertRowid);
    commerce.giftHistoryAdd.run(req.user.id, instanceId, gift.id, 'sent', recipientId, -gift.price, ts);
    commerce.giftHistoryAdd.run(recipientId, instanceId, gift.id, 'received', req.user.id, gift.price, ts);
    commerce.giftHistoryAdd.run(recipientId, instanceId, gift.id, 'added', req.user.id, 0, ts);
    const response = { balance, messageId: row.id, chatId: chat.id, giftId: gift.id, recipientId, instanceId, note };
    if (operationKey) commerce.giftOperationAdd.run(req.user.id, operationKey, 'send', JSON.stringify(response), ts);
    return { row, response };
  })();
  if (result.replay) return res.status(200).json(result.replay);
  const published = publishCreatedMessage({ row: result.row, chat, sender: req.user });
  res.status(201).json({
    ...result.response, message: published.dto, gift: giftDTO(gift),
    recipient: publicUser(recipient, req.user.id),
  });
}));

commerceRouter.get('/gifts/collection', wrap((req, res) => {
  res.json({ gifts: commerce.myGiftCollection.all(req.user.id).map((row) => giftDTO({ ...row, instance_id: row.id })) });
}));

commerceRouter.get('/gifts/history', wrap((req, res) => {
  res.json({ history: commerce.giftHistory.all(req.user.id) });
}));

commerceRouter.get('/gifts/collection/:id/history', wrap((req, res) => {
  const instanceId = Number(req.params.id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) throw badRequest('Некорректный подарок');
  if (!commerce.giftOwned.get(instanceId, req.user.id)
    && !db.prepare("SELECT 1 FROM received_gifts WHERE id = ? AND recipient_id = ? AND status = 'sold'").get(instanceId, req.user.id)) {
    throw notFound('Подарок не найден');
  }
  res.json({ history: commerce.giftHistoryForInstance.all(instanceId, req.user.id) });
}));

commerceRouter.patch('/gifts/collection/:id', limit('write'), wrap((req, res) => {
  const instanceId = Number(req.params.id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) throw badRequest('Некорректный подарок');
  const gift = commerce.giftOwned.get(instanceId, req.user.id);
  if (!gift) throw notFound('Подарок не найден');
  const ts = now();
  if (req.body?.hidden !== undefined) {
    if (typeof req.body.hidden !== 'boolean') throw badRequest('Некорректный статус видимости');
    commerce.giftSetHidden.run(req.body.hidden ? 1 : 0, instanceId, req.user.id);
    commerce.giftHistoryAdd.run(req.user.id, instanceId, gift.gift_id, req.body.hidden ? 'hidden' : 'shown', null, 0, ts);
  }
  if (req.body?.pinned !== undefined) {
    if (typeof req.body.pinned !== 'boolean') throw badRequest('Некорректный статус закрепления');
    if (req.body.pinned) {
      const count = db.prepare('SELECT COUNT(*) AS count FROM received_gifts WHERE recipient_id = ? AND status = \'owned\' AND pinned_order IS NOT NULL').get(req.user.id).count;
      if (count >= 5 && gift.pinned_order === null) throw badRequest('Можно закрепить не более пяти подарков');
      commerce.giftSetPinned.run(count + 1, instanceId, req.user.id);
    } else {
      commerce.giftSetPinned.run(null, instanceId, req.user.id);
    }
  }
  res.json({ ok: true, gift: commerce.giftCollection.all(req.user.id).find((row) => row.id === instanceId) || null });
}));

commerceRouter.post('/gifts/collection/:id/sell', limit('write'), wrap((req, res) => {
  const instanceId = Number(req.params.id);
  const operationKey = giftOperationKey(req);
  const replay = replayGiftOperation(req.user.id, operationKey, 'sell');
  if (replay) {
    if (replay.instanceId !== instanceId) throw conflict('Ключ операции уже использован с другими параметрами');
    return res.json(replay);
  }
  if (!Number.isInteger(instanceId) || instanceId <= 0) throw badRequest('Некорректный подарок');
  const result = tx(() => {
    const savedOperation = operationKey ? commerce.giftByIdempotency.get(req.user.id, operationKey) : null;
    if (savedOperation) {
      if (savedOperation.operation !== 'sell') throw conflict('Ключ операции уже использован для другого действия');
      const saved = JSON.parse(savedOperation.result_json);
      if (saved.instanceId !== instanceId) throw conflict('Ключ операции уже использован с другими параметрами');
      return saved;
    }
    const item = commerce.giftOwned.get(instanceId, req.user.id);
    if (!item) throw conflict('Подарок больше нельзя продать');
    const gift = commerce.giftById.get(item.gift_id);
    if (!gift) throw notFound('Подарок не найден');
    const refund = Math.floor(item.price * gift.sellback_percent / 100);
    if (commerce.giftMarkSold.run(instanceId, req.user.id).changes !== 1) throw conflict('Подарок уже продан');
    const w = wallet(req.user.id);
    const balance = w.balance + refund;
    const ts = now();
    commerce.updateWallet.run(balance, ts, req.user.id);
    commerce.transaction.run(req.user.id, 'gift_sale', refund, balance, 'gift_instance', String(instanceId), JSON.stringify({ giftId: item.gift_id }), ts);
    commerce.giftHistoryAdd.run(req.user.id, instanceId, item.gift_id, 'sold', null, refund, ts);
    const response = { instanceId, giftId: item.gift_id, refund, balance };
    if (operationKey) commerce.giftOperationAdd.run(req.user.id, operationKey, 'sell', JSON.stringify(response), ts);
    return response;
  })();
  res.json(result);
}));

commerceRouter.get('/users/:id/gifts', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Некорректный пользователь');
  if (!canViewProfile(id, req.user.id)) throw forbidden('Пользователь скрыл профиль');
  res.json({ gifts: commerce.giftCollection.all(id).map((row) => giftDTO({ ...row, instance_id: row.id })) });
}));
