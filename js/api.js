/**
 * REST-клиент. Токен сессии хранится в localStorage (с деградацией в память)
 * и передаётся в заголовке Authorization — это работает и внутри изолированных фреймов,
 * где cookies могут быть недоступны.
 */
import { store9 } from './util.js';
import { bus } from './store.js';

const TOKEN_KEY = 'aurora.token';
export const newOperationKey = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let token = store9.get(TOKEN_KEY, '');

export const setToken = (value) => {
  token = value || '';
  if (value) store9.set(TOKEN_KEY, value); else store9.remove(TOKEN_KEY);
};
export const getToken = () => token;

export class ApiError extends Error {
  constructor(message, status, details, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
    this.field = details?.field;
  }
}

async function request(method, path, { body, raw, signal, silent, timeoutMs } = {}) {
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : null;
  let timedOut = false;
  let timeoutId = null;
  const abort = () => controller?.abort();
  if (controller) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  let res;
  try {
    res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller?.signal || signal,
    });
  } catch (error) {
    if (timedOut) throw new ApiError('Сервер не ответил вовремя. Обновите список подарков перед повторной попыткой.', 408);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }

  if (res.status === 204) return {};

  let data = {};
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; } }

  if (!res.ok) {
    const err = new ApiError(data.error || `Ошибка ${res.status}`, res.status, data.details, data.code);
    if (res.status === 401 && !silent) bus.emit('auth:expired', err);
    throw err;
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),

  /** Загрузка файла с прогрессом. Поддерживает превью, длительность и «пики» для голосовых. */
  upload(file, { kind, thumb = null, duration = null, peaks = null, width = null, height = null, onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, file.name || 'file');
      if (thumb) form.append('thumb', thumb, 'thumb.jpg');
      if (kind) form.append('kind', kind);
      if (duration) form.append('duration', String(duration));
      if (peaks) form.append('peaks', JSON.stringify(peaks));
      if (width) form.append('width', String(width));
      if (height) form.append('height', String(height));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media', true);
      xhr.timeout = 300000;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abortUpload);
        callback(value);
      };
      const abortUpload = () => xhr.abort();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) return finish(resolve, data);
        const err = new ApiError(data.error || `Ошибка загрузки (${xhr.status})`, xhr.status);
        if (xhr.status === 401) bus.emit('auth:expired', err);
        finish(reject, err);
      };
      xhr.onerror = () => finish(reject, new ApiError('Сеть недоступна — загрузка не удалась', 0));
      xhr.ontimeout = () => finish(reject, new ApiError('Загрузка не завершилась за 5 минут. Проверьте соединение и попробуйте ещё раз.', 408));
      xhr.onabort = () => finish(reject, new ApiError('Загрузка отменена', 0, { aborted: true }));
      if (signal) {
        if (signal.aborted) return finish(reject, new ApiError('Загрузка отменена', 0, { aborted: true }));
        signal.addEventListener('abort', abortUpload, { once: true });
      }
      xhr.send(form);
    });
  },
};

/* ── Частые вызовы одним интерфейсом (тонкий слой над REST) ─────────────── */
export const Api = {
  register: (payload) => api.post('/api/auth/register', payload),
  login: (payload) => api.post('/api/auth/login', payload),
  requestEmailVerificationCode: () => api.post('/api/auth/email-verification/request'),
  verifyEmailCode: (code) => api.post('/api/auth/email-verification/verify', { code }),
  changeEmail: (email, credentials = {}) => api.patch('/api/auth/email', { email, ...credentials }),
  me: () => api.get('/api/auth/me', { silent: true }),
  requestSecurityVerification: (kind) => api.post('/api/security/verification/request', { kind }),
  logout: () => api.post('/api/auth/logout'),
  logoutAll: () => api.post('/api/auth/logout-all'),
  logoutDevices: () => api.post('/api/auth/logout-devices'),
  sessions: () => api.get('/api/auth/sessions'),
  revokeSession: (id) => api.del(`/api/auth/sessions/${encodeURIComponent(id)}`),
  twoFactorStatus: () => api.get('/api/auth/2fa/status'),
  twoFactorSetup: () => api.post('/api/auth/2fa/setup'),
  twoFactorEnable: (code) => api.post('/api/auth/2fa/verify', { code }),
  twoFactorDisable: (code) => api.post('/api/auth/2fa/disable', { code }),
  protectivePasswordStatus: () => api.get('/api/auth/protective-password/status'),
  pushVapidKey: () => api.get('/api/push/vapid-public-key'),
  pushSubscriptionStatus: () => api.get('/api/push/subscription'),
  testPush: () => api.post('/api/push/test'),
  savePushSubscription: (subscription) => api.post('/api/push/subscription', { subscription }),
  removePushSubscription: (subscription) => api.del('/api/push/subscription', { body: subscription }),
  setProtectivePassword: (currentPassword, protectivePassword) => api.post('/api/auth/protective-password', { currentPassword, protectivePassword }),
  disableProtectivePassword: (currentPassword, protectivePassword) => api.post('/api/auth/protective-password/disable', { currentPassword, protectivePassword }),
  setupProtectivePasswordAfterLogin: (setupToken, protectivePassword) => api.post('/api/auth/protective-password/setup-after-login', { setupToken, protectivePassword }),
  forgot: (email) => api.post('/api/auth/forgot', { email }),
  reset: (payload) => api.post('/api/auth/reset', payload),
  changePassword: (payload) => api.post('/api/auth/change-password', payload),
  checkAvailability: (params) => api.get(`/api/auth/check?${new URLSearchParams(params)}`),
  updateProfile: (payload) => api.patch('/api/auth/profile', payload),
  addProfileGallery: (mediaId) => api.post('/api/profile/gallery', { mediaId }),
  removeProfileGallery: (mediaId) => api.del(`/api/profile/gallery/${mediaId}`),

  chats: () => api.get('/api/chats'),
  openDm: (userId) => api.post('/api/chats/dm', { userId }),
  stories: () => api.get('/api/stories'),
  createStory: (payload) => api.post('/api/stories', payload),
  viewStory: (id) => api.post(`/api/stories/${encodeURIComponent(id)}/views`),
  likeStory: (id) => api.post(`/api/stories/${encodeURIComponent(id)}/likes`),
  deleteStory: (id) => api.del(`/api/stories/${encodeURIComponent(id)}`),
  createGroup: (payload) => api.post('/api/chats/group', payload),
  createChannel: (payload) => api.post('/api/chats/channel', payload),
  joinChat: (username) => api.post('/api/chats/join', { username }),
  joinChatInvite: (token) => api.post('/api/chats/join-invite', { token }),
  chat: (id) => api.get(`/api/chats/${id}`),
  startCall: (chatId, mediaMode) => api.post(`/api/chats/${chatId}/calls`, { mediaMode }),
  activeCall: (chatId) => api.get(`/api/chats/${chatId}/calls/active`),
  incomingCalls: () => api.get('/api/calls/incoming'),
  joinCall: (callId) => api.post(`/api/calls/${encodeURIComponent(callId)}/join`),
  declineCall: (callId) => api.post(`/api/calls/${encodeURIComponent(callId)}/decline`),
  leaveCall: (callId, endForAll = false) => api.post(`/api/calls/${encodeURIComponent(callId)}/leave`, { endForAll }),
  callHistory: (chatId = null) => api.get(`/api/calls/history${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
  updateChat: (id, payload) => api.patch(`/api/chats/${id}`, payload),
  chatInvites: (id) => api.get(`/api/chats/${id}/invites`),
  createChatInvite: (id, payload) => api.post(`/api/chats/${id}/invites`, payload),
  revokeChatInvite: (id, inviteId) => api.del(`/api/chats/${id}/invites/${inviteId}`),
  chatJoinRequests: (id) => api.get(`/api/chats/${id}/join-requests`),
  decideChatJoinRequest: (id, requestId, action) => api.post(`/api/chats/${id}/join-requests/${requestId}`, { action }),
  chatStats: (id) => api.get(`/api/chats/${id}/stats`),
  chatTopics: (id) => api.get(`/api/chats/${id}/topics`),
  createChatTopic: (id, title) => api.post(`/api/chats/${id}/topics`, { title }),
  setChatTopicClosed: (id, topicId, isClosed) => api.patch(`/api/chats/${id}/topics/${topicId}`, { isClosed }),
  chatReports: (id) => api.get(`/api/chats/${id}/reports`),
  decideChatReport: (id, reportId, action) => api.post(`/api/chats/${id}/reports/${reportId}`, { action }),
  scheduledPosts: (id) => api.get(`/api/chats/${id}/scheduled-posts`),
  createScheduledPost: (id, payload) => api.post(`/api/chats/${id}/scheduled-posts`, payload),
  cancelScheduledPost: (id, postId) => api.del(`/api/chats/${id}/scheduled-posts/${postId}`),
  chatPrefs: (id, payload) => api.patch(`/api/chats/${id}/prefs`, payload),
  requestSupport: (id) => api.post(`/api/chats/${id}/support-request`),
  supportRequests: () => api.get('/api/support/requests'),
  createSupportRequest: (payload) => api.post('/api/support/requests', payload),
  adminUnlock: (password) => api.post('/api/admin/unlock', { password }),
  adminOverview: () => api.get('/api/admin/overview'),
  adminUsers: (q = '') => api.get(`/api/admin/users?q=${encodeURIComponent(q)}`),
  adminEmailVerifications: () => api.get('/api/admin/email-verifications'),
  adminPasswordResetRequests: () => api.get('/api/admin/password-reset-requests'),
  adminIssuePasswordReset: (id) => api.post(`/api/admin/password-reset-requests/${encodeURIComponent(id)}/issue`),
  adminUserAction: (id, payload) => api.patch(`/api/admin/users/${id}`, payload),
  adminChats: () => api.get('/api/admin/chats'),
  adminChatAction: (id, payload) => api.patch(`/api/admin/chats/${id}`, payload),
  adminSupport: (status = 'all') => api.get(`/api/admin/support?status=${status}`),
  adminSupportAction: (id, status) => api.patch(`/api/admin/support/${id}`, { status }),
  adminSupportOpen: (id) => api.post(`/api/admin/support/${id}/open`),
  adminCommerce: () => api.get('/api/admin/commerce'),
  adminPremiumAction: (id, status) => api.patch(`/api/admin/commerce/premium/${id}`, { status }),
  adminCommerceConfig: (payload) => api.patch('/api/admin/commerce/config', payload),
  adminGiftCreate: (payload) => api.post('/api/admin/commerce/gifts', payload, { timeoutMs: 45000 }),
  adminGiftUpdate: (id, payload) => api.patch(`/api/admin/commerce/gifts/${encodeURIComponent(id)}`, payload, { timeoutMs: 45000 }),
  adminGiftDelete: (id) => api.del(`/api/admin/commerce/gifts/${encodeURIComponent(id)}`),
  commerceCatalog: (giftOffset = 0) => api.get(`/api/commerce/catalog?giftLimit=24&giftOffset=${Math.max(0, Number(giftOffset) || 0)}`),
  commerceWallet: () => api.get('/api/commerce/wallet'),
  commercePurchase: (packageId, receiptEmail, idempotencyKey = newOperationKey()) => api.post(
    '/api/commerce/wallet/purchase',
    { packageId, receiptEmail, idempotencyKey },
  ),
  commercePremium: (planId, receiptEmail, idempotencyKey = newOperationKey()) => api.post(
    '/api/commerce/premium/subscribe',
    { planId, receiptEmail, idempotencyKey },
  ),
  commercePaymentStatus: (orderId, refresh = false) => api.get(
    `/api/commerce/payments/${encodeURIComponent(orderId)}${refresh ? '?refresh=1' : ''}`,
  ),
  commerceSendGift: (recipientId, giftId, note = '', idempotencyKey = newOperationKey()) => api.post(
    '/api/commerce/gifts/send',
    { recipientId, giftId, note, idempotencyKey },
    { timeoutMs: 45000 },
  ),
  userGifts: (id) => api.get(`/api/commerce/users/${id}/gifts`),
  giftCollection: () => api.get('/api/commerce/gifts/collection'),
  giftHistory: () => api.get('/api/commerce/gifts/history'),
  giftInstanceHistory: (id) => api.get(`/api/commerce/gifts/collection/${encodeURIComponent(id)}/history`),
  giftCollectionUpdate: (id, payload) => api.patch(`/api/commerce/gifts/collection/${encodeURIComponent(id)}`, payload),
  giftSell: (id, idempotencyKey = newOperationKey()) => api.post(`/api/commerce/gifts/collection/${encodeURIComponent(id)}/sell`, { idempotencyKey }),
  addMembers: (id, userIds) => api.post(`/api/chats/${id}/members`, { userIds }),
  removeMember: (id, userId) => api.del(`/api/chats/${id}/members/${userId}`),
  setRole: (id, userId, role, permissions) => api.patch(`/api/chats/${id}/members/${userId}/role`, {
    role, ...(permissions ? { permissions } : {}),
  }),
  markRead: (id, seq) => api.post(`/api/chats/${id}/read`, { seq }),
  markDelivered: (id, seq) => api.post(`/api/chats/${id}/delivered`, { seq }),
  typing: (id, isTyping) => api.post(`/api/chats/${id}/typing`, { isTyping }),
  messages: (id, { before, limit, topicId } = {}) => api.get(`/api/chats/${id}/messages?${new URLSearchParams({
    ...(before ? { before } : {}), ...(limit ? { limit } : {}), ...(topicId ? { topicId } : {}),
  })}`),
  messagesAfter: (id, seq, topicId) => api.get(`/api/chats/${id}/messages/after?${new URLSearchParams({
    seq, ...(topicId ? { topicId } : {}),
  })}`),
  chatMedia: (id, offset = 0) => api.get(`/api/chats/${id}/media?offset=${offset}&limit=24`),
  chatFiles: (id, offset = 0) => api.get(`/api/chats/${id}/files?offset=${offset}&limit=24`),
  sendMessage: (chatId, payload) => api.post(`/api/chats/${chatId}/messages`, payload),
  votePoll: (messageId, optionIds) => api.post(`/api/messages/${messageId}/poll-votes`, { optionIds }),
  editMessage: (id, text) => api.patch(`/api/messages/${id}`, { text }),
  deleteMessage: (id, forAll) => api.del(`/api/messages/${id}${forAll ? '?forAll=1' : ''}`),
  messageComments: (id) => api.get(`/api/messages/${id}/comments`),
  sendComment: (id, text, parentId = null) => api.post(`/api/messages/${id}/comments`, { text, parentId }),
  editComment: (messageId, commentId, text) => api.patch(`/api/messages/${messageId}/comments/${commentId}`, { text }),
  deleteComment: (messageId, commentId) => api.del(`/api/messages/${messageId}/comments/${commentId}`),
  likeComment: (messageId, commentId) => api.post(`/api/messages/${messageId}/comments/${commentId}/likes`),
  reportMessage: (id, reason, details = '') => api.post(`/api/messages/${id}/report`, { reason, details }),
  react: (id, emoji) => api.post(`/api/messages/${id}/reactions`, { emoji }),
  reactionUsers: (id) => api.get(`/api/messages/${id}/reactions`),
  pinMessage: (id, pinned) => api.post(`/api/messages/${id}/pin`, { pinned }),
  viewMessage: (id) => api.post(`/api/messages/${id}/view`),
  messageInfo: (id) => api.get(`/api/messages/${id}`),
  forward: (messageIds, chatIds) => api.post('/api/messages/forward', { messageIds, chatIds }),
  deleteChat: (id, hard) => api.del(`/api/chats/${id}${hard ? '?hard=1' : ''}`),

  search: (q, type = 'all') => api.get(`/api/search?${new URLSearchParams({ q, type })}`),
  userProfile: (id) => api.get(`/api/users/${id}`),
  blockUser: (id, blocked) => api.post(`/api/users/${id}/block`, { blocked }),
  reportUser: (id, reason, details = '') => api.post(`/api/users/${id}/report`, { reason, details }),
  blocks: () => api.get('/api/blocks'),

  getSettings: () => api.get('/api/settings'),
  saveSettings: (payload) => api.patch('/api/settings', payload),
  state: () => api.get('/api/state'),
  updates: (since) => api.get(`/api/updates?since=${since}`),
  mediaLimits: () => api.get('/api/media/limits'),
  myMedia: () => api.get('/api/media/mine'),
};
