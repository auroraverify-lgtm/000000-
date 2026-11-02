/**
 * Чаты: список, личные диалоги, группы, каналы, участники, права, прочтения, предпочтения.
 * Все проверки прав — здесь; клиент не может «попросить» то, что ему не разрешено.
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { db, chats, chatInvites, chatJoinRequests, chatReports, scheduledPosts, chatTopics, messages, users, settings, blocks, media, commerce, now } from '../db.js';
import { validate, signMedia, hashOneTimeCode, cleanText } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { canAddToGroup, canViewStatus, CHAT_ADMIN_PERMISSIONS, chatDTO, hasChatPermission, membersOf, messageDTO, sharesContact, userDTO } from '../helpers.js';
import { indexChat, unindexChat, publishChat, publishUser, publishTyping, hub } from '../realtime.js';
import { buildMessages, deleteMessage } from '../services/messages.js';
import { createMessage } from '../services/messages.js';
import { assertOutgoingContent } from '../outgoing-content.js';
import { MESSAGES_PAGE, CHATS_PAGE, PREMIUM_LIMITS } from '../config.js';
import { PREMIUM_REACTION_IDS } from '../premium.js';

export const chatsRouter = express.Router();
chatsRouter.use(requireAuth, limit('read'));
const ownedChatCount = db.prepare('SELECT COUNT(*) AS count FROM chats WHERE owner_id = ? AND type = ?');
const CHANNEL_REACTION_OPTIONS = [
  '❤️', '😂', '👍', '🔥', '😢', '😮', '👎', '🎉', '🙏', '😍', '🤝', '💯',
  '💎', '👑', '🚀', '🪐', '✨', '🌈', '🫶', '🦄', '🔮', '🥂',
  ...PREMIUM_REACTION_IDS,
];
const channelStats = {
  summary: db.prepare(`SELECT
    (SELECT COUNT(*) FROM chat_members WHERE chat_id = @chatId) AS subscribers,
    COUNT(*) AS posts, COALESCE(SUM(m.views), 0) AS views,
    (SELECT COUNT(*) FROM message_comments mc JOIN messages cm ON cm.id = mc.message_id
      WHERE cm.chat_id = @chatId AND cm.deleted_for_all = 0 AND mc.deleted_at IS NULL) AS comments,
    (SELECT COUNT(*) FROM reactions r JOIN messages rm ON rm.id = r.message_id
      WHERE rm.chat_id = @chatId AND rm.deleted_for_all = 0) AS reactions
    FROM messages m WHERE m.chat_id = @chatId AND m.deleted_for_all = 0`),
  postsByDay: db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
    COUNT(*) AS posts, COALESCE(SUM(views), 0) AS views
    FROM messages WHERE chat_id = @chatId AND deleted_for_all = 0 AND created_at >= @since
    GROUP BY day`),
  commentsByDay: db.prepare(`SELECT strftime('%Y-%m-%d', mc.created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
    FROM message_comments mc JOIN messages m ON m.id = mc.message_id
    WHERE m.chat_id = @chatId AND m.deleted_for_all = 0 AND mc.deleted_at IS NULL
      AND mc.created_at >= @since GROUP BY day`),
  reactionsByDay: db.prepare(`SELECT strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
    FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.chat_id = @chatId AND m.deleted_for_all = 0 AND r.created_at >= @since GROUP BY day`),
};

function requestChatJoin(chat, userId, inviteId = null) {
  const existing = chatJoinRequests.get.get(chat.id, userId);
  if (existing?.status === 'pending') return false;
  const requestedAt = now();
  chatJoinRequests.upsert.run({ chat_id: chat.id, user_id: userId, invite_id: inviteId, now: requestedAt });
  const requester = users.byId.get(userId);
  for (const member of membersOf(chat.id)) {
    if (hasChatPermission(member, 'manage_members')) {
      publishUser(member.user_id, 'chat.join_request', {
        chatId: chat.id, request: {
          userId, name: requester.name, username: requester.username, createdAt: requestedAt,
        },
      });
    }
  }
  publishUser(userId, 'chat.join_request.update', { chatId: chat.id, status: 'pending' });
  return true;
}

function admitChatMember(chat, user, { broadcast = true } = {}) {
  chats.addMember.run(chat.id, user.id, 'member', now(), chat.type === 'channel' ? messages.maxSeq.get(chat.id).s : 0);
  if (!broadcast) return;
  indexChat(chat.id);
  const members = membersOf(chat.id);
  publishChat(chat.id, 'chat.member.join', { chatId: chat.id, user: userDTO(user, null), memberCount: members.length });
  for (const member of members) {
    publishUser(member.user_id, 'chat.new', {
      chat: listItem(chats.listForUser.all({ uid: member.user_id, limit: CHATS_PAGE }).find((row) => row.id === chat.id), member.user_id),
    });
  }
}

function assertChatCreationLimit(userId, type) {
  const premium = !!commerce.premium.get(userId, now());
  const limitCount = PREMIUM_LIMITS[premium ? 'premium' : 'free'][type === 'channel' ? 'channels' : 'groups'];
  const owned = ownedChatCount.get(userId, type).count;
  if (owned >= limitCount) {
    const label = type === 'channel' ? 'каналов' : 'групп';
    throw forbidden(`Достигнут лимит ${label}: ${owned}/${limitCount}${premium ? '' : '. Откройте Premium для увеличения лимита'}`);
  }
}

/** Аккуратный DTO элемента списка чатов: превью, непрочитанные, флаги участника. */
function listItem(row, viewerId) {
  const members = membersOf(row.id);
  const chat = chatDTO(row, { viewerId, members });
  const sender = row.last_sender_id ? users.byId.get(row.last_sender_id) : null;
  return {
    ...chat,
    role: row.role,
    unread: row.unread,
    pinned: !!row.pinned,
    muted: !!row.muted,
    archived: !!row.archived,
    lastReadSeq: row.last_read_seq,
    lastSeq: row.last_seq || 0,
    msgCount: row.member_count,
    pinnedCount: row.pinned_count,
    lastMessage: row.last_id ? {
      id: row.last_id,
      senderId: row.last_sender_id,
      senderName: sender?.name || null,
      fromMe: row.last_sender_id === viewerId,
      type: row.last_type,
      text: row.last_text || '',
      sticker: row.last_sticker,
      hasMedia: !!row.last_media_id,
      createdAt: row.last_at,
    } : null,
  };
}

/** Список чатов пользователя (порядок: закреплённые → последняя активность). */
chatsRouter.get('/', wrap((req, res) => {
  const rows = chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE });
  res.json({ chats: rows.map((r) => listItem(r, req.user.id)) });
}));

/** Запрос живого специалиста в официальном чате поддержки. */
chatsRouter.post('/:id/support-request', limit('write'), wrap((req, res) => {
  const chatId = validate.id(req.params.id);
  if (chatId.error) throw badRequest(chatId.error);
  const chat = chats.byId.get(chatId.value);
  if (!chat) throw notFound('Чат не найден');
  const membership = chats.memberOf.get(chat.id, req.user.id);
  if (!membership) throw forbidden('Нет доступа к чату');
  const botMember = chats.members.all(chat.id).find((m) => m.username === 'aurora_support');
  if (!botMember) throw badRequest('Это не чат Aurora Support');
  const existing = db.prepare("SELECT id FROM support_requests WHERE user_id = ? AND chat_id = ? AND status IN ('open','in_progress') LIMIT 1").get(req.user.id, chat.id);
  if (existing) return res.json({ ok: true, requestId: existing.id, duplicate: true });
  const bot = users.byId.get(botMember.user_id);
  const text = '👤 Запрос специалиста принят. Мы подключим сотрудника поддержки в этом чате. Пока можете описать проблему и приложить скриншот.';
  createMessage({ chat, sender: bot, type: 'text', text });
  const ts = now();
  db.prepare(`INSERT INTO support_requests (user_id, chat_id, category, subject, status, created_at, updated_at)
    VALUES (?, ?, 'other', '', 'open', ?, ?)`).run(req.user.id, chat.id, ts, ts);
  res.status(201).json({ ok: true });
}));

/** Создание личного диалога (идемпотентно: повторный вызов возвращает тот же чат). */
chatsRouter.post('/dm', limit('write'), wrap((req, res) => {
  const target = validate.id(req.body?.userId);
  if (target.error) throw badRequest('Выберите пользователя');
  if (target.value === req.user.id) throw badRequest('Нельзя начать диалог с самим собой');
  const peer = users.byId.get(target.value);
  if (!peer) throw notFound('Пользователь не найден');

  const peerSettings = settings.byUser.get(peer.id);
  const privacy = peerSettings?.privacy_messages || 'everyone';
  if (blocks.isBlocked.get(peer.id, req.user.id)) throw forbidden('Пользователь ограничил переписку');
  if (privacy === 'nobody') throw forbidden('Пользователь ограничил переписку');
  if (privacy === 'contacts' && !sharesContact(req.user.id, peer.id)) throw forbidden('Пользователь принимает сообщения только от общих контактов');

  const key = `dm:${Math.min(req.user.id, peer.id)}:${Math.max(req.user.id, peer.id)}`;
  let chat = chats.byDmKey.get(key);
  if (!chat) {
    const create = db.transaction(() => {
      const info = chats.create.run({
        type: 'dm', title: null, username: null, description: '', avatar_url: null,
        owner_id: null, is_public: 0, dm_key: key, created_at: now(),
      });
      const id = Number(info.lastInsertRowid);
      chats.addMember.run(id, req.user.id, 'member', now(), 0);
      chats.addMember.run(id, peer.id, 'member', now(), 0);
      return chats.byId.get(id);
    });
    chat = create();
    indexChat(chat.id);
  }
  const members = membersOf(chat.id);
  for (const m of members) {
    publishUser(m.user_id, 'chat.new', { chat: listItem(chats.listForUser.all({ uid: m.user_id, limit: CHATS_PAGE }).find((c) => c.id === chat.id), m.user_id) });
  }
  res.json({ chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((c) => c.id === chat.id), req.user.id) });
}));

/** Создание группы: название, описание, фото, участники. */
chatsRouter.post('/group', limit('write'), wrap((req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 2) throw badRequest('Название минимум 2 символа', { field: 'title' });
  if (title.length > 64) throw badRequest('Название слишком длинное', { field: 'title' });
  const description = String(req.body?.description || '').trim().slice(0, 400);
  const rawIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.slice(0, 200) : [];
  const memberIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== req.user.id))];
  for (const id of memberIds) if (!users.byId.get(id)) throw badRequest(`Пользователь #${id} не найден`);
  for (const id of memberIds) {
    if (!canAddToGroup(id, req.user.id)) throw forbidden(`Пользователь @${users.byId.get(id).username} принимает приглашения только от общих контактов`);
  }

  let avatar = null;
  if (req.body?.avatarMediaId) {
    const m = media.byId.get(Number(req.body.avatarMediaId));
    if (!m || m.owner_id !== req.user.id || m.kind !== 'image') throw forbidden('Некорректная фотография группы');
    avatar = String(m.id);
  }

  const create = db.transaction(() => {
    assertChatCreationLimit(req.user.id, 'group');
    const info = chats.create.run({
      type: 'group', title, username: null, description, avatar_url: avatar,
      owner_id: req.user.id, is_public: 0, dm_key: null, created_at: now(),
    });
    const id = Number(info.lastInsertRowid);
    chats.createDefaultTopic.run(id, req.user.id, now());
    chats.addMember.run(id, req.user.id, 'owner', now(), 0);
    for (const uid of memberIds) chats.addMember.run(id, uid, 'member', now(), 0);
    return id;
  });
  const chatId = create();
  indexChat(chatId);
  const chat = chats.byId.get(chatId);
  const memberList = membersOf(chatId);
  for (const m of memberList) {
    publishUser(m.user_id, 'chat.new', { chat: listItem(chats.listForUser.all({ uid: m.user_id, limit: CHATS_PAGE }).find((c) => c.id === chatId), m.user_id) });
  }
  // системная запись о создании — реальное сообщение в чате, а не «имитация»
  res.status(201).json({ chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((c) => c.id === chatId), req.user.id) });
}));

/** Создание канала: название, username, описание, аватар, публичность. */
chatsRouter.post('/channel', limit('write'), wrap((req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 2) throw badRequest('Название минимум 2 символа', { field: 'title' });
  const description = String(req.body?.description || '').trim().slice(0, 400);
  const isPublic = req.body?.isPublic === false ? 0 : 1;
  let username = null;
  if (isPublic) {
    const u = validate.username(req.body?.username);
    if (u.error) throw badRequest(u.error, { field: 'username' });
    if (chats.byUsername.get(u.value)) throw conflict('Этот username канала занят', { field: 'username' });
    username = u.value;
  }
  let avatar = null;
  if (req.body?.avatarMediaId) {
    const m = media.byId.get(Number(req.body.avatarMediaId));
    if (!m || m.owner_id !== req.user.id || m.kind !== 'image') throw forbidden('Некорректная фотография канала');
    avatar = String(m.id);
  }
  const create = db.transaction(() => {
    assertChatCreationLimit(req.user.id, 'channel');
    const info = chats.create.run({
      type: 'channel', title, username, description, avatar_url: avatar,
      owner_id: req.user.id, is_public: isPublic, dm_key: null, created_at: now(),
    });
    const id = Number(info.lastInsertRowid);
    chats.addMember.run(id, req.user.id, 'owner', now(), 0);
    return id;
  });
  const chatId = create();
  indexChat(chatId);
  publishUser(req.user.id, 'chat.new', { chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((c) => c.id === chatId), req.user.id) });
  res.status(201).json({ chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((c) => c.id === chatId), req.user.id) });
}));

/** Вход в публичный чат/канал по username. */
chatsRouter.post('/join', limit('write'), wrap((req, res) => {
  const u = validate.username(req.body?.username);
  if (u.error) throw badRequest(u.error, { field: 'username' });
  const chat = chats.byUsername.get(u.value);
  if (!chat) throw notFound('Канал или группа не найдены');
  if (!chat.is_public) throw forbidden('Это приватный чат');
  const existing = chats.memberOf.get(chat.id, req.user.id);
  if (!existing) {
    if (chat.join_approval_required) {
      requestChatJoin(chat, req.user.id);
      return res.status(202).json({ requestPending: true, chat: { id: chat.id, title: chat.title, type: chat.type } });
    }
    admitChatMember(chat, req.user);
  }
  res.json({ chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((c) => c.id === chat.id), req.user.id) });
}));

/** Вступление по одноразовой/ограниченной ссылке-приглашению. */
chatsRouter.post('/join-invite', limit('write'), wrap((req, res) => {
  const token = String(req.body?.token || '');
  if (!/^aur_[A-Za-z0-9_-]{32}$/.test(token)) throw badRequest('Ссылка-приглашение недействительна');
  const invite = chatInvites.byToken.get(hashOneTimeCode(token));
  if (!invite || invite.revoked_at || (invite.expires_at && invite.expires_at <= now())
    || (invite.max_uses !== null && invite.use_count >= invite.max_uses)) {
    throw notFound('Ссылка-приглашение недействительна или истекла');
  }
  const chat = chats.byId.get(invite.chat_id);
  if (!chat) throw notFound('Чат не найден');
  const existing = chats.memberOf.get(chat.id, req.user.id);
  if (!existing && !canAddToGroup(req.user.id, invite.created_by)) {
    throw forbidden('Настройки приватности не позволяют вступить по этой ссылке');
  }
  if (!existing && chat.join_approval_required) {
    if (!canAddToGroup(req.user.id, invite.created_by)) {
      throw forbidden('Настройки приватности не позволяют запросить вступление по этой ссылке');
    }
    requestChatJoin(chat, req.user.id, invite.id);
    return res.status(202).json({ requestPending: true, chat: { id: chat.id, title: chat.title, type: chat.type } });
  }
  if (!existing) {
    const join = db.transaction(() => {
      if (!chatInvites.consume.run({ id: invite.id, now: now() }).changes) {
        throw notFound('Ссылка-приглашение уже использована или истекла');
      }
      admitChatMember(chat, req.user, { broadcast: false });
    });
    join();
    const members = membersOf(chat.id);
    publishChat(chat.id, 'chat.member.join', { chatId: chat.id, user: userDTO(req.user, null), memberCount: members.length });
    for (const member of members) publishUser(member.user_id, 'chat.new', {
      chat: listItem(chats.listForUser.all({ uid: member.user_id, limit: CHATS_PAGE }).find((row) => row.id === chat.id), member.user_id),
    });
  }
  res.json({ chat: listItem(chats.listForUser.all({ uid: req.user.id, limit: CHATS_PAGE }).find((row) => row.id === chat.id), req.user.id) });
}));

/** Полная информация о чате: участники, закреплённые сообщения, мои права. */
chatsRouter.get('/:id', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!me) throw forbidden('Нет доступа к этому чату');
  const members = membersOf(chat.id).map((m) => ({
    user_id: m.user_id,
    id: m.user_id, role: m.role, name: m.name, username: m.username,
    avatarUrl: m.avatar_url ? signMedia(m.avatar_url, 30 * 24 * 3600 * 1000) : null,
    avatarColor: m.avatar_color,
    presence: canViewStatus(m.user_id, req.user.id) ? m.presence : null,
    lastSeen: canViewStatus(m.user_id, req.user.id) ? m.last_seen : null,
    isBot: !!m.is_bot, isPremium: !!m.is_premium,
    premiumBadge: m.is_premium ? (m.premium_badge || 'aurora') : null,
    premiumEmoji: m.is_premium ? (m.premium_emoji || null) : null,
    muted: !!m.muted, lastReadSeq: m.last_read_seq, lastDeliveredSeq: m.last_delivered_seq,
    ...(me.role === 'owner' && m.permissions ? { permissions: JSON.parse(m.permissions) } : {}),
  }));
  const pinned = buildMessages(messages.pinnedFor.all(chat.id), req.user.id);
  res.json({
    chat: { ...chatDTO(chat, { viewerId: req.user.id, members }), isPublic: !!chat.is_public },
    role: me.role,
    myFlags: { muted: !!me.muted, pinned: !!me.pinned, archived: !!me.archived, lastReadSeq: me.last_read_seq, lastDeliveredSeq: me.last_delivered_seq },
    members,
    pinnedMessages: pinned,
    permissions: {
      canPost: chat.type === 'channel' ? hasChatPermission(me, 'publish') : true,
      canEditInfo: hasChatPermission(me, 'manage_info'),
      canAddMembers: chat.type === 'channel' ? hasChatPermission(me, 'manage_members') : true,
      canManageMembers: hasChatPermission(me, 'manage_members'),
      canManageRoles: me.role === 'owner',
      isOwner: me.role === 'owner',
      canManageInvites: hasChatPermission(me, 'manage_invites'),
      canModerate: hasChatPermission(me, 'moderate'),
      canViewStats: hasChatPermission(me, 'view_stats'),
    },
  });
}));

/** Изменение информации группы/канала (только админы). */
chatsRouter.patch('/:id', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  if (chat.type === 'dm') throw forbidden('У личного диалога нельзя менять информацию');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(me, 'manage_info')) throw forbidden('Изменять информацию может только администратор с соответствующим правом');

  const fields = {
    id: chat.id, title: null, description: null, username: null, avatar_url: undefined,
    banner_url: undefined, is_public: null, protected_content: null,
    comments_enabled: null, reactions_enabled: null, allowed_reactions: null, join_approval_required: null,
  };
  if (req.body?.title !== undefined) {
    const t = String(req.body.title).trim();
    if (t.length < 2 || t.length > 64) throw badRequest('Название от 2 до 64 символов', { field: 'title' });
    fields.title = t;
  }
  if (req.body?.description !== undefined) fields.description = String(req.body.description).slice(0, 400);
  if (req.body?.isPublic !== undefined) fields.is_public = req.body.isPublic ? 1 : 0;
  if (req.body?.protectedContent !== undefined) {
    if (chat.type !== 'channel' || me.role !== 'owner') throw forbidden('Эту настройку может менять только владелец канала');
    fields.protected_content = req.body.protectedContent ? 1 : 0;
  }
  if (req.body?.joinApprovalRequired !== undefined) {
    if (typeof req.body.joinApprovalRequired !== 'boolean') throw badRequest('Поле joinApprovalRequired должно быть логическим');
    fields.join_approval_required = req.body.joinApprovalRequired ? 1 : 0;
  }
  for (const [bodyKey, fieldKey] of [['commentsEnabled', 'comments_enabled'], ['reactionsEnabled', 'reactions_enabled']]) {
    if (req.body?.[bodyKey] !== undefined) {
      if (chat.type !== 'channel') throw badRequest('Настройка доступна только для каналов');
      if (typeof req.body[bodyKey] !== 'boolean') throw badRequest(`Поле ${bodyKey} должно быть логическим`);
      fields[fieldKey] = req.body[bodyKey] ? 1 : 0;
    }
  }
  if (req.body?.allowedReactions !== undefined) {
    if (chat.type !== 'channel') throw badRequest('Настройка доступна только для каналов');
    if (req.body.allowedReactions === null) {
      fields.allowed_reactions = '';
    } else if (!Array.isArray(req.body.allowedReactions) || req.body.allowedReactions.length > CHANNEL_REACTION_OPTIONS.length) {
      throw badRequest('Передан некорректный список реакций');
    } else {
      const reactions = [...new Set(req.body.allowedReactions)];
      if (reactions.some((emoji) => typeof emoji !== 'string' || !CHANNEL_REACTION_OPTIONS.includes(emoji))) {
        throw badRequest('Список содержит неподдерживаемую реакцию');
      }
      fields.allowed_reactions = JSON.stringify(reactions);
    }
  }
  if (req.body?.username !== undefined && chat.type === 'channel') {
    if (req.body.username === null || req.body.username === '') fields.username = null;
    else {
      const u = validate.username(req.body.username);
      if (u.error) throw badRequest(u.error, { field: 'username' });
      const taken = chats.byUsername.get(u.value);
      if (taken && taken.id !== chat.id) throw conflict('Этот username уже занят', { field: 'username' });
      fields.username = u.value;
    }
  }
  if (req.body?.avatarMediaId !== undefined) {
    if (req.body.avatarMediaId === null) fields.avatar_url = null;
    else {
      const m = media.byId.get(Number(req.body.avatarMediaId));
      if (!m || m.owner_id !== req.user.id || m.kind !== 'image') throw forbidden('Некорректная фотография');
      fields.avatar_url = String(m.id);
    }
  }
  if (req.body?.bannerMediaId !== undefined) {
    if (chat.type !== 'channel') throw badRequest('Баннер доступен только для каналов');
    if (req.body.bannerMediaId === null) fields.banner_url = null;
    else {
      const m = media.byId.get(Number(req.body.bannerMediaId));
      if (!m || m.owner_id !== req.user.id || m.kind !== 'image') throw forbidden('Некорректный баннер');
      fields.banner_url = String(m.id);
    }
  }
  chats.update.run({
    id: fields.id, title: fields.title, description: fields.description,
    username: fields.username, avatar_url: fields.avatar_url, banner_url: fields.banner_url,
    is_public: fields.is_public, protected_content: fields.protected_content,
    comments_enabled: fields.comments_enabled, reactions_enabled: fields.reactions_enabled,
    allowed_reactions: fields.allowed_reactions, join_approval_required: fields.join_approval_required,
  });
  const fresh = chats.byId.get(chat.id);
  const members = membersOf(chat.id);
  publishChat(chat.id, 'chat.update', { chat: chatDTO(fresh, { viewerId: null, members }), isPublic: !!fresh.is_public, username: fresh.username });
  res.json({ chat: chatDTO(fresh, { viewerId: req.user.id, members }) });
}));

/** Управление ссылками-приглашениями доступно только администраторам чата. */
chatsRouter.get('/:id/invites', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type === 'dm') throw notFound('Чат не найден');
  const member = chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'manage_invites')) throw forbidden('Управлять приглашениями может только администратор с соответствующим правом');
  res.json({ invites: chatInvites.list.all(chat.id) });
}));

chatsRouter.post('/:id/invites', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type === 'dm') throw notFound('Чат не найден');
  const member = chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'manage_invites')) throw forbidden('Создавать приглашения может только администратор с соответствующим правом');

  const maxUses = req.body?.maxUses === undefined || req.body?.maxUses === null || req.body?.maxUses === ''
    ? null : Number(req.body.maxUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000)) {
    throw badRequest('Лимит использований должен быть от 1 до 10000');
  }
  const expiresInHours = req.body?.expiresInHours === undefined || req.body?.expiresInHours === null || req.body?.expiresInHours === ''
    ? null : Number(req.body.expiresInHours);
  if (expiresInHours !== null && (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 8760)) {
    throw badRequest('Срок действия должен быть от 1 часа до 1 года');
  }

  const token = `aur_${randomBytes(24).toString('base64url')}`;
  const createdAt = now();
  const expiresAt = expiresInHours === null ? null : createdAt + expiresInHours * 60 * 60 * 1000;
  const result = chatInvites.create.run({
    chat_id: chat.id, token_hash: hashOneTimeCode(token), created_by: req.user.id,
    max_uses: maxUses, expires_at: expiresAt, created_at: createdAt,
  });
  res.status(201).json({
    invite: { ...chatInvites.list.all(chat.id).find((invite) => invite.id === Number(result.lastInsertRowid)), token },
  });
}));

chatsRouter.delete('/:id/invites/:inviteId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const inviteId = validate.id(req.params.inviteId);
  if (id.error || inviteId.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type === 'dm') throw notFound('Чат не найден');
  const member = chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'manage_invites')) throw forbidden('Отзывать приглашения может только администратор с соответствующим правом');
  if (!chatInvites.revoke.run(now(), inviteId.value, chat.id).changes) throw notFound('Приглашение не найдено');
  res.json({ ok: true });
}));

chatsRouter.get('/:id/join-requests', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'manage_members')) throw forbidden('Просматривать заявки может только администратор с соответствующим правом');
  res.json({ requests: chatJoinRequests.listPending.all(chat.id).map((request) => ({
    id: request.id, userId: request.user_id, name: request.name, username: request.username,
    avatarUrl: request.avatar_url ? signMedia(request.avatar_url, 30 * 24 * 3600 * 1000) : null,
    avatarColor: request.avatar_color, bio: request.bio, createdAt: request.created_at,
  })) });
}));

chatsRouter.post('/:id/join-requests/:requestId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const requestId = validate.id(req.params.requestId);
  if (id.error || requestId.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'manage_members')) throw forbidden('Рассматривать заявки может только администратор с соответствующим правом');
  const request = chatJoinRequests.byId.get(requestId.value, chat.id);
  if (!request || request.status !== 'pending') throw notFound('Заявка не найдена или уже рассмотрена');
  const action = req.body?.action;
  if (!['approve', 'decline'].includes(action)) throw badRequest('Действие должно быть approve или decline');
  const applicant = users.byId.get(request.user_id);
  if (!applicant) throw notFound('Пользователь не найден');
  const existing = chats.memberOf.get(chat.id, applicant.id);

  const decide = db.transaction(() => {
    if (action === 'approve' && !existing && request.invite_id) {
      const invite = chatInvites.byId.get(request.invite_id, chat.id);
      if (!invite || invite.revoked_at || (invite.expires_at && invite.expires_at <= now())
        || (invite.max_uses !== null && invite.use_count >= invite.max_uses)
        || !chatInvites.consume.run({ id: invite.id, now: now() }).changes) {
        throw conflict('Приглашение истекло, отозвано или исчерпало лимит');
      }
    }
    if (!chatJoinRequests.decide.run({
      id: request.id, chat_id: chat.id, status: action === 'approve' ? 'approved' : 'declined', now: now(),
    }).changes) throw conflict('Заявка уже рассмотрена');
    if (action === 'approve' && !existing) admitChatMember(chat, applicant, { broadcast: false });
  });
  decide();

  publishUser(applicant.id, 'chat.join_request.update', { chatId: chat.id, status: action === 'approve' ? 'approved' : 'declined' });
  if (action === 'approve' && !existing) {
    indexChat(chat.id);
    const members = membersOf(chat.id);
    publishChat(chat.id, 'chat.member.join', { chatId: chat.id, user: userDTO(applicant, null), memberCount: members.length });
    for (const chatMember of members) publishUser(chatMember.user_id, 'chat.new', {
      chat: listItem(chats.listForUser.all({ uid: chatMember.user_id, limit: CHATS_PAGE }).find((row) => row.id === chat.id), chatMember.user_id),
    });
  }
  res.json({ ok: true, status: action === 'approve' ? 'approved' : 'declined' });
}));

chatsRouter.get('/:id/stats', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type !== 'channel') throw notFound('Канал не найден');
  const member = chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'view_stats')) throw forbidden('Статистика доступна только администраторам с соответствующим правом');
  const currentTime = now();
  const since = currentTime - 30 * 24 * 60 * 60 * 1000;
  const stats = channelStats.summary.get({ chatId: chat.id });
  const activity = new Map();
  for (const row of channelStats.postsByDay.all({ chatId: chat.id, since })) {
    activity.set(row.day, { posts: row.posts, views: row.views, comments: 0, reactions: 0 });
  }
  for (const row of channelStats.commentsByDay.all({ chatId: chat.id, since })) {
    const day = activity.get(row.day) || { posts: 0, views: 0, comments: 0, reactions: 0 };
    day.comments = row.count;
    activity.set(row.day, day);
  }
  for (const row of channelStats.reactionsByDay.all({ chatId: chat.id, since })) {
    const day = activity.get(row.day) || { posts: 0, views: 0, comments: 0, reactions: 0 };
    day.reactions = row.count;
    activity.set(row.day, day);
  }
  res.json({
    summary: stats,
    activity: [...activity.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({ day, ...counts })),
  });
}));

chatsRouter.get('/:id/reports', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'moderate')) throw forbidden('Просматривать жалобы может только администратор с соответствующим правом');
  res.json({ reports: chatReports.listPending.all(chat.id).map((report) => ({
    id: report.id, messageId: report.message_id, reporterId: report.reporter_id,
    reporterName: report.reporter_name, reporterUsername: report.reporter_username,
    authorId: report.author_id, authorName: report.author_name, authorUsername: report.author_username,
    reason: report.reason, details: report.details, createdAt: report.created_at,
    messageText: report.message_text, messageType: report.message_type,
  })) });
}));

chatsRouter.get('/:id/topics', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type !== 'group') throw notFound('Темы доступны только в группах');
  if (!chats.memberOf.get(chat.id, req.user.id)) throw forbidden('Нет доступа к группе');
  res.json({ topics: chatTopics.list.all(chat.id).map((topic) => ({
    id: topic.id, title: topic.title, isDefault: !!topic.is_default,
    isClosed: !!topic.is_closed, createdAt: topic.created_at,
  })) });
}));

chatsRouter.post('/:id/topics', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!chat || chat.type !== 'group') throw notFound('Темы доступны только в группах');
  if (!hasChatPermission(member, 'manage_info')) throw forbidden('Создавать темы может только владелец или администратор с соответствующим правом');
  const title = cleanText(String(req.body?.title || '')).trim();
  if (!title || title.length > 50) throw badRequest('Название темы должно содержать от 1 до 50 символов');
  if (chatTopics.count.get(chat.id).count >= 100) throw badRequest('В группе уже создано максимальное число тем');
  try {
    const result = chatTopics.create.run({ chat_id: chat.id, title, created_by: req.user.id, created_at: now() });
    const topic = chatTopics.byId.get(Number(result.lastInsertRowid), chat.id);
    publishChat(chat.id, 'chat.topic.update', { chatId: chat.id, topic: { id: topic.id, title: topic.title, isDefault: false, isClosed: false, createdAt: topic.created_at } });
    res.status(201).json({ topic: { id: topic.id, title: topic.title, isDefault: false, isClosed: false, createdAt: topic.created_at } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Тема с таким названием уже существует');
    throw error;
  }
}));

chatsRouter.patch('/:id/topics/:topicId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const topicId = validate.id(req.params.topicId);
  if (id.error || topicId.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!chat || chat.type !== 'group') throw notFound('Группа не найдена');
  if (!hasChatPermission(member, 'manage_info')) throw forbidden('Управлять темами может только администратор с соответствующим правом');
  const topic = chatTopics.byId.get(topicId.value, chat.id);
  if (!topic || topic.is_default) throw notFound('Тему нельзя изменить или она не найдена');
  if (typeof req.body?.isClosed !== 'boolean') throw badRequest('Поле isClosed должно быть логическим');
  chatTopics.setClosed.run(req.body.isClosed ? 1 : 0, topic.id, chat.id);
  publishChat(chat.id, 'chat.topic.update', { chatId: chat.id, topic: {
    id: topic.id, title: topic.title, isDefault: false, isClosed: req.body.isClosed,
  } });
  res.json({ topic: { id: topic.id, title: topic.title, isDefault: false, isClosed: req.body.isClosed } });
}));

chatsRouter.post('/:id/reports/:reportId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const reportId = validate.id(req.params.reportId);
  if (id.error || reportId.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!hasChatPermission(member, 'moderate')) throw forbidden('Рассматривать жалобы может только администратор с соответствующим правом');
  const report = chatReports.byId.get(reportId.value, chat.id);
  if (!report || report.status !== 'pending') throw notFound('Жалоба не найдена или уже рассмотрена');
  const action = req.body?.action;
  const status = { dismiss: 'dismissed', removeMessage: 'message_removed', removeMember: 'member_removed' }[action];
  if (!status) throw badRequest('Недопустимое действие');
  if (action === 'removeMember') {
    const target = report.author_id && chats.memberOf.get(chat.id, report.author_id);
    if (!target || target.role !== 'member') throw forbidden('Нельзя удалить этого автора из сообщества');
  }
  const reviewedAt = now();
  const reportMessage = action === 'removeMessage' ? messages.byId.get(report.message_id) : null;
  const decide = db.transaction(() => {
    if (!chatReports.decide.run({
      id: report.id, chat_id: chat.id, status, reviewed_by: req.user.id, reviewed_at: reviewedAt,
    }).changes) throw conflict('Жалоба уже рассмотрена');
    if (action === 'removeMember') chats.removeMember.run(chat.id, report.author_id);
  });
  decide();

  if (action === 'removeMessage') deleteMessage({ row: reportMessage, user: req.user, forAll: true });
  if (action === 'removeMember') {
    indexChat(chat.id);
    const members = membersOf(chat.id);
    publishChat(chat.id, 'chat.member.remove', {
      chatId: chat.id, userId: report.author_id, left: false, by: req.user.id, memberCount: members.length,
    });
    publishUser(report.author_id, 'chat.removed', { chatId: chat.id });
  }
  publishUser(report.reporter_id, 'chat.report.update', { chatId: chat.id, reportId: report.id, status });
  res.json({ ok: true, status });
}));

chatsRouter.get('/:id/scheduled-posts', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!chat || chat.type !== 'channel' || !hasChatPermission(member, 'publish')) {
    throw forbidden('Управлять отложенными публикациями может только администратор с правом публикации');
  }
  res.json({ posts: scheduledPosts.list.all(chat.id).map((post) => ({
    id: post.id, text: post.text, scheduledAt: post.scheduled_at,
    status: post.status, failureReason: post.failure_reason, createdAt: post.created_at,
  })) });
}));

chatsRouter.post('/:id/scheduled-posts', limit('write'), wrap(async (req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!chat || chat.type !== 'channel' || !hasChatPermission(member, 'publish')) {
    throw forbidden('Планировать публикации может только администратор с правом публикации');
  }
  const text = cleanText(String(req.body?.text || '')).trim();
  if (!text || text.length > 10000) throw badRequest('Текст публикации должен содержать от 1 до 10000 символов');
  await assertOutgoingContent({ chat, userId: req.user.id, text });
  const scheduledAt = Number(req.body?.scheduledAt);
  const currentTime = now();
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt < currentTime + 60 * 1000
    || scheduledAt > currentTime + 365 * 24 * 60 * 60 * 1000) {
    throw badRequest('Время публикации должно быть минимум через минуту и не более чем через год');
  }
  const result = scheduledPosts.create.run({
    chat_id: chat.id, sender_id: req.user.id, text, scheduled_at: scheduledAt,
    created_at: currentTime, updated_at: currentTime,
  });
  const post = scheduledPosts.get.get(Number(result.lastInsertRowid), chat.id);
  res.status(201).json({ post: {
    id: post.id, text: post.text, scheduledAt: post.scheduled_at,
    status: post.status, createdAt: post.created_at,
  } });
}));

chatsRouter.delete('/:id/scheduled-posts/:postId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const postId = validate.id(req.params.postId);
  if (id.error || postId.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  const member = chat && chats.memberOf.get(chat.id, req.user.id);
  if (!chat || chat.type !== 'channel' || !hasChatPermission(member, 'publish')) {
    throw forbidden('Управлять отложенными публикациями может только администратор с правом публикации');
  }
  if (!scheduledPosts.cancel.run(now(), postId.value, chat.id).changes) {
    throw notFound('Публикация не найдена или уже обработана');
  }
  res.json({ ok: true });
}));

/** Предпочтения участника: закрепить, отключить уведомления, архив. */
chatsRouter.patch('/:id/prefs', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const me = chats.memberOf.get(id.value, req.user.id);
  if (!me) throw forbidden('Нет доступа к этому чату');
  const toFlag = (v) => (v === undefined ? null : v ? 1 : 0);
  chats.setFlags.run({
    chat_id: id.value, user_id: req.user.id,
    muted: toFlag(req.body?.muted), pinned: toFlag(req.body?.pinned), archived: toFlag(req.body?.archived),
  });
  const fresh = chats.memberOf.get(id.value, req.user.id);
  const flags = { muted: !!fresh.muted, pinned: !!fresh.pinned, archived: !!fresh.archived };
  publishUser(req.user.id, 'chat.prefs', { chatId: id.value, ...flags });
  res.json(flags);
}));

/** Добавление участников. */
chatsRouter.post('/:id/members', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  if (chat.type === 'dm') throw forbidden('В личный диалог нельзя добавлять участников');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!me) throw forbidden('Нет доступа');
  if (chat.type === 'channel' && !hasChatPermission(me, 'manage_members')) throw forbidden('Добавлять подписчиков может только администратор с соответствующим правом');

  const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId];
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== req.user.id))];
  const added = [];
  for (const uid of ids) {
    const user = users.byId.get(uid);
    if (!user) continue;
    if (!canAddToGroup(uid, req.user.id)) continue;
    if (chats.memberOf.get(chat.id, uid)) continue;
    chats.addMember.run(chat.id, uid, 'member', now(), chat.type === 'channel' ? messages.maxSeq.get(chat.id).s : 0);
    added.push(uid);
  }
  if (!added.length) throw badRequest('Никого не удалось добавить');
  indexChat(chat.id);
  const members = membersOf(chat.id);
  publishChat(chat.id, 'chat.member.add', { chatId: chat.id, userIds: added, memberCount: members.length });
  for (const uid of added) publishUser(uid, 'chat.new', { chat: listItem(chats.listForUser.all({ uid, limit: CHATS_PAGE }).find((c) => c.id === chat.id), uid) });
  res.json({ added, memberCount: members.length });
}));

/** Удаление участника: администратором — любого (кроме владельца), участником — себя (выход). */
chatsRouter.delete('/:id/members/:userId', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const uid = validate.id(req.params.userId);
  if (id.error || uid.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!me) throw forbidden('Нет доступа');
  const target = chats.memberOf.get(chat.id, uid.value);
  if (!target) throw notFound('Участник не найден');
  const isSelf = uid.value === req.user.id;
  if (!isSelf && !hasChatPermission(me, 'manage_members')) throw forbidden('Удалять участников может только администратор с соответствующим правом');
  if (target.role === 'owner') throw forbidden('Владельца нельзя удалить');
  if (!isSelf && target.role === 'admin' && me.role !== 'owner') throw forbidden('Удалить администратора может только владелец');

  chats.removeMember.run(chat.id, uid.value);
  indexChat(chat.id);
  const members = membersOf(chat.id);
  publishChat(chat.id, 'chat.member.remove', { chatId: chat.id, userId: uid.value, left: isSelf, by: req.user.id, memberCount: members.length });
  publishUser(uid.value, 'chat.removed', { chatId: chat.id });
  res.json({ ok: true, memberCount: members.length });
}));

/** Назначение/снятие администратора (только владелец). */
chatsRouter.patch('/:id/members/:userId/role', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  const uid = validate.id(req.params.userId);
  if (id.error || uid.error) throw badRequest('Некорректные параметры');
  const chat = chats.byId.get(id.value);
  if (!chat || chat.type === 'dm') throw notFound('Чат не найден');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!me || me.role !== 'owner') throw forbidden('Управлять ролями может только владелец');
  if (uid.value === req.user.id) throw badRequest('Нельзя изменить собственную роль');
  const target = chats.memberOf.get(chat.id, uid.value);
  if (!target) throw notFound('Участник не найден');
  const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'member' ? 'member' : null;
  if (!role) throw badRequest('Роль должна быть admin или member');
  let permissions = null;
  if (role === 'admin' && req.body?.permissions !== undefined) {
    if (!Array.isArray(req.body.permissions)
      || req.body.permissions.some((permission) => !CHAT_ADMIN_PERMISSIONS.includes(permission))) {
      throw badRequest('Передан некорректный список прав администратора');
    }
    permissions = JSON.stringify([...new Set(req.body.permissions)]);
  }
  chats.setRole.run(role, permissions, chat.id, uid.value);
  const permissionsList = permissions ? JSON.parse(permissions) : null;
  publishChat(chat.id, 'chat.member.role', { chatId: chat.id, userId: uid.value, role, permissions: permissionsList });
  res.json({ ok: true, role, permissions: permissionsList });
}));

/** Отметка прочтения: влияет на непрочитанные и на галочки у отправителя. */
chatsRouter.post('/:id/read', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const me = chats.memberOf.get(id.value, req.user.id);
  if (!me) throw forbidden('Нет доступа');
  const max = messages.maxSeq.get(id.value).s;
  const seq = req.body?.seq === undefined ? max : Math.min(Number(req.body.seq) || 0, max);
  chats.setReadSeq.run(seq, id.value, req.user.id);
  chats.setDeliveredSeq.run(seq, id.value, req.user.id);
  publishChat(id.value, 'read.update', { chatId: id.value, userId: req.user.id, seq }, { skip: req.user.id });
  res.json({ ok: true, seq });
}));

/** Подтверждение доставки (сообщение получено, но не открыто). */
chatsRouter.post('/:id/delivered', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const me = chats.memberOf.get(id.value, req.user.id);
  if (!me) throw forbidden('Нет доступа');
  const seq = Math.min(Number(req.body?.seq) || 0, messages.maxSeq.get(id.value).s);
  chats.setDeliveredSeq.run(seq, id.value, req.user.id);
  publishChat(id.value, 'delivered.update', { chatId: id.value, userId: req.user.id, seq }, { skip: req.user.id });
  res.json({ ok: true, seq });
}));

/** Индикатор набора текста: эфемерное событие, в журнал не пишется. */
chatsRouter.post('/:id/typing', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  if (!chats.memberOf.get(id.value, req.user.id)) throw forbidden('Нет доступа');
  publishTyping(id.value, req.user.id, req.body?.isTyping !== false);
  res.json({ ok: true });
}));

/** Медиа чата: страницами (lazy loading), только фото/видео. */
chatsRouter.get('/:id/media', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  if (!chats.memberOf.get(id.value, req.user.id)) throw forbidden('Нет доступа');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const rows = messages.mediaInChat.all({ chat_id: id.value, limit, offset });
  const items = rows.map((r) => ({
    messageId: r.id, mediaId: r.media_id, kind: r.m_kind, width: r.width, height: r.height,
    duration: r.duration, size: r.size, createdAt: r.created_at, senderId: r.sender_id,
    url: signMedia(r.media_id), caption: r.text || '',
  }));
  const total = messages.mediaInChatCount.get({ chat_id: id.value }).c;
  res.json({ items, total, nextOffset: offset + items.length, hasMore: offset + items.length < total });
}));

/** Файлы, аудио и голосовые — отдельные списки (как в реальных мессенджерах). */
chatsRouter.get('/:id/files', wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  if (!chats.memberOf.get(id.value, req.user.id)) throw forbidden('Нет доступа');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const rows = messages.filesInChat.all({ chat_id: id.value, limit, offset });
  res.json({
    items: rows.map((r) => ({
      messageId: r.id, mediaId: r.media_id, kind: r.m_kind, filename: r.filename, size: r.size,
      mime: r.mime, duration: r.duration, createdAt: r.created_at, senderId: r.sender_id,
      url: signMedia(r.media_id),
    })),
    hasMore: rows.length === limit,
  });
}));

/** Удаление чата: владелец удаляет группу/канал, участник — «выходит» из чата у себя. */
chatsRouter.delete('/:id', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const chat = chats.byId.get(id.value);
  if (!chat) throw notFound('Чат не найден');
  const me = chats.memberOf.get(chat.id, req.user.id);
  if (!me) throw forbidden('Нет доступа');
  const members = membersOf(chat.id);
  if (me.role === 'owner' && req.query.hard === '1' && chat.type !== 'dm') {
    chats.delete.run(chat.id);
    unindexChat(chat.id);
    for (const m of members) publishUser(m.user_id, 'chat.removed', { chatId: chat.id, deleted: true });
    return res.json({ ok: true, deleted: true });
  }
  chats.removeMember.run(chat.id, req.user.id);
  unindexChat(chat.id);
  if (chat.type !== 'dm') {
    publishChat(chat.id, 'chat.member.remove', { chatId: chat.id, userId: req.user.id, left: true, memberCount: members.length - 1 });
  }
  publishUser(req.user.id, 'chat.removed', { chatId: chat.id });
  res.json({ ok: true, left: true });
}));

export default chatsRouter;
