/**
 * Сообщения: история с курсорной пагинацией, отправка, правка, удаление, реакции, закрепление,
 * пересылка, просмотры. Реальный real-time: каждое изменение публикуется в hub.
 */
import express from 'express';
import { db, chats, messages, media, reactions, comments, chatReports, chatTopics, users, polls, settings, blocks, commerce, now } from '../db.js';
import { validate, cleanText, signMedia } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { buildMessages, createMessage, editMessage, deleteMessage, replyPreview } from '../services/messages.js';
import { publishChat, publishUser } from '../realtime.js';
import { canPost, hasChatPermission, sharesContact } from '../helpers.js';
import { MESSAGES_PAGE } from '../config.js';
import { PREMIUM_REACTION_IDS, sanitizePremiumEmojiText } from '../premium.js';
import { moderateGroupMessage } from '../security-client.js';
import { assertOutgoingContent } from '../outgoing-content.js';

export const messagesRouter = express.Router();
messagesRouter.use(requireAuth);

const ALLOWED_REACTIONS = ['❤️', '😂', '👍', '🔥', '😢', '😮', '👎', '🎉', '🙏', '😍', '🤝', '💯'];
const PREMIUM_REACTIONS = [
  '💎', '👑', '🚀', '🪐', '✨', '🌈', '🫶', '🦄', '🔮', '🥂',
  ...PREMIUM_REACTION_IDS,
];
const STICKERS = new Set([
  'blob-hi', 'blob-love', 'blob-lol', 'blob-sad', 'blob-wow', 'blob-think', 'blob-party', 'blob-sleep',
  'aurora-heart', 'aurora-star', 'coffee', 'rocket',
  'aurora-hi', 'aurora-news', 'aurora-new', 'aurora-love', 'aurora-lol', 'aurora-wow',
  'aurora-thanks', 'aurora-coffee', 'aurora-rocket',
]);

function messageContentForPolicy(text, poll) {
  return poll ? [poll.question, ...poll.options.map((option) => option.text)].join('\n') : text;
}

/** Тип сообщения ↔ допустимые типы медиа. */
const MEDIA_FOR_TYPE = {
  photo: ['image'],
  video: ['video'],
  voice: ['voice', 'audio'],
  file: ['file', 'audio', 'video', 'image'],
  sticker: [],
};

/** Получить чат с проверкой членства (общая точка для всех операций с сообщениями). */
function chatAccess(req, chatId, { needPost = false } = {}) {
  const chat = chats.byId.get(chatId);
  if (!chat) throw notFound('Чат не найден');
  const member = chats.memberOf.get(chatId, req.user.id);
  if (!member) throw forbidden('Нет доступа к этому чату');
  if (needPost && chat.type === 'dm') {
    const peer = chats.members.all(chatId).find((candidate) => candidate.user_id !== req.user.id);
    if (peer) {
      const peerSettings = settings.byUser.get(peer.user_id);
      const audience = peerSettings?.privacy_messages || 'everyone';
      if (blocks.isBlocked.get(peer.user_id, req.user.id)
        || audience === 'nobody'
        || (audience === 'contacts' && !sharesContact(peer.user_id, req.user.id))) {
        throw forbidden('Пользователь ограничил переписку');
      }
    }
  }
  if (needPost && chat.is_frozen) throw forbidden('Чат временно заморожен администратором');
  if (needPost && !canPost(chat, member, req.user.id)) {
    throw forbidden('Недостаточно прав для публикации');
  }
  return { chat, member };
}

/* ─────────────────────────── История ─────────────────────────── */

/** Страница истории: курсор `before` (seq) — не выгружаем тысячи сообщений сразу. */
messagesRouter.get('/chats/:id/messages', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const { chat } = chatAccess(req, id.value);
  const limit = Math.min(80, Math.max(1, Number(req.query.limit) || MESSAGES_PAGE));
  const maxSeq = messages.maxSeq.get(id.value).s;
  const before = req.query.before ? Number(req.query.before) : maxSeq + 1;
  let topicId = null;
  if (req.query.topicId !== undefined) {
    if (chat.type !== 'group') throw badRequest('Темы доступны только в группах');
    const parsedTopicId = validate.id(req.query.topicId);
    if (parsedTopicId.error || !chatTopics.byId.get(parsedTopicId.value, chat.id)) throw badRequest('Тема не найдена');
    topicId = parsedTopicId.value;
  }
  const rows = topicId
    ? messages.pageInTopic.all({ chat_id: id.value, topic_id: topicId, before, limit, uid: req.user.id })
    : messages.page.all({ chat_id: id.value, before, limit, uid: req.user.id });
  const ordered = rows.reverse();
  const dtos = buildMessages(ordered, req.user.id);
  const replyIds = [...new Set(ordered.map((r) => r.reply_to).filter(Boolean))];
  const replyMap = {};
  for (const rid of replyIds) {
    const src = messages.byId.get(rid);
    if (src) replyMap[rid] = replyPreview(rid, req.user.id);
  }
  const members = chats.members.all(id.value).map((m) => ({
    id: m.user_id, name: m.name, username: m.username, lastReadSeq: m.last_read_seq, lastDeliveredSeq: m.last_delivered_seq,
  }));
  res.json({
    messages: dtos,
    replies: replyMap,
    members,
    firstSeq: ordered[0]?.seq ?? null,
    lastSeq: ordered[ordered.length - 1]?.seq ?? null,
    hasMore: rows.length === limit && (ordered[0]?.seq || 0) > 1,
  });
}));

/** Свежие сообщения после seq — используется при переподключении/возврате во вкладку. */
messagesRouter.get('/chats/:id/messages/after', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const { chat } = chatAccess(req, id.value);
  const seq = Math.max(0, Number(req.query.seq) || 0);
  let topicId = null;
  if (req.query.topicId !== undefined) {
    if (chat.type !== 'group') throw badRequest('Темы доступны только в группах');
    const parsedTopicId = validate.id(req.query.topicId);
    if (parsedTopicId.error || !chatTopics.byId.get(parsedTopicId.value, chat.id)) throw badRequest('Тема не найдена');
    topicId = parsedTopicId.value;
  }
  const rows = topicId
    ? messages.afterInTopic.all({ chat_id: id.value, topic_id: topicId, seq, limit: 120, uid: req.user.id })
    : messages.after.all({ chat_id: id.value, seq, limit: 120, uid: req.user.id });
  res.json({ messages: buildMessages(rows, req.user.id) });
}));

/* ─────────────────────────── Отправка ─────────────────────────── */

/** Отправка сообщения: текст или медиа (файл уже загружен в /api/media). */
messagesRouter.post('/chats/:id/messages', limit('write'), wrap(async (req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const { chat, member } = chatAccess(req, id.value, { needPost: true });

  let topicId = null;
  if (req.body?.topicId !== undefined && req.body.topicId !== null) {
    if (chat.type !== 'group') throw badRequest('Темы доступны только в группах');
    const parsedTopicId = validate.id(req.body.topicId);
    if (parsedTopicId.error) throw badRequest('Некорректная тема');
    const topic = chatTopics.byId.get(parsedTopicId.value, chat.id);
    if (!topic) throw badRequest('Тема не найдена');
    if (topic.is_closed && !hasChatPermission(member, 'manage_info')) throw forbidden('Тема закрыта для новых сообщений');
    topicId = topic.id;
  }

  const type = String(req.body?.type || 'text');
  if (!['text', 'photo', 'video', 'file', 'voice', 'sticker', 'poll'].includes(type)) throw badRequest('Неизвестный тип сообщения');

  let poll = null;
  if (type === 'poll') {
    const question = cleanText(req.body?.poll?.question || req.body?.question || '').trim();
    const source = Array.isArray(req.body?.poll?.options) ? req.body.poll.options : req.body?.options;
    const options = (Array.isArray(source) ? source : []).map((value, index) => ({
      id: String(index + 1), text: cleanText(typeof value === 'string' ? value : value?.text || '').trim(),
    })).filter((option) => option.text).slice(0, 10);
    if (question.length < 1 || question.length > 300) throw badRequest('Вопрос должен содержать от 1 до 300 символов');
    if (options.length < 2) throw badRequest('Опрос должен содержать минимум два варианта');
    if (options.some((option) => option.text.length > 120) || new Set(options.map((o) => o.text.toLowerCase())).size !== options.length) {
      throw badRequest('Варианты опроса должны быть уникальными и не длиннее 120 символов');
    }
    poll = { question, options, allowMultiple: !!(req.body?.poll?.allowMultiple ?? req.body?.allowMultiple) };
  }

  let mediaRow = null;
  let mediaRows = [];
  if (type !== 'text' && type !== 'sticker' && type !== 'poll') {
    const rawIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [req.body?.mediaId];
    const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || ids.length > 5) throw badRequest('Можно прикрепить от 1 до 5 файлов');
    mediaRows = ids.map((mid) => media.byId.get(mid));
    if (mediaRows.some((item) => !item)) throw badRequest('Вложение не найдено');
    if (mediaRows.some((item) => item.owner_id !== req.user.id)) throw forbidden('Можно отправлять только собственные загрузки');
    const allowedKinds = type === 'photo' ? ['image', 'photo', 'video'] : (MEDIA_FOR_TYPE[type] || []);
    if (mediaRows.some((item) => !allowedKinds.includes(item.kind))) throw badRequest(`Тип вложения не подходит для сообщения типа "${type}"`);
    mediaRow = mediaRows[0];
  }

  const rawText = type === 'text' || req.body?.text ? cleanText(req.body?.text || '') : '';
  const text = sanitizePremiumEmojiText(rawText, !!commerce.premium.get(req.user.id, now()));
  if (type === 'text' && !text.trim()) throw badRequest('Пустое сообщение');
  if (type === 'sticker' && !STICKERS.has(String(req.body?.sticker || ''))) throw badRequest('Неизвестный стикер');
  await assertOutgoingContent({ chat, userId: req.user.id, text: messageContentForPolicy(text, poll) });

  let replyTo = null;
  if (req.body?.replyToId) {
    const rid = validate.id(req.body.replyToId);
    if (rid.error) throw badRequest('Некорректный ответ');
    const target = messages.byId.get(rid.value);
    if (!target || target.chat_id !== chat.id) throw badRequest('Сообщение для ответа не найдено');
    replyTo = target.id;
  }

  const { dto } = createMessage({
    chat,
    sender: req.user,
    type,
    text,
    mediaId: mediaRow?.id || null,
    mediaIds: mediaRows.map((item) => item.id),
    sticker: type === 'sticker' ? String(req.body.sticker).slice(0, 32) : null,
    replyTo,
    poll,
    topicId,
  });
  const replyDto = replyTo ? messages.byId.get(replyTo) : null;
  res.status(201).json({ message: dto, reply: replyDto ? replyPreview(replyDto.id, req.user.id) : null, chatId: chat.id });
}));

messagesRouter.post(['/messages/:id/poll-votes', '/messages/:id/poll-vote'], limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  chatAccess(req, row.chat_id);
  if (row.type !== 'poll' || row.deleted_for_all) throw badRequest('Это неактивный опрос');
  const poll = polls.byMessage.get(row.id);
  let options; try { options = JSON.parse(poll.options_json); } catch { options = []; }
  const ids = [...new Set((Array.isArray(req.body?.optionIds) ? req.body.optionIds : [req.body?.optionId]).map(String))].filter((x) => options.some((o) => o.id === x));
  if (!ids.length) throw badRequest('Выберите вариант');
  if (!poll.allow_multiple && ids.length > 1) throw badRequest('Можно выбрать только один вариант');
  polls.clearUserVotes.run(row.id, req.user.id);
  for (const optionId of ids) polls.addVote.run(row.id, req.user.id, optionId, now());
  const dto = buildMessages([messages.byId.get(row.id)], req.user.id)[0];
  publishChat(row.chat_id, 'poll.update', { message: dto });
  res.json({ message: dto });
}));

/* ─────────────────────────── Правка и удаление ─────────────────────────── */

messagesRouter.patch('/messages/:id', limit('write'), wrap(async (req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const { chat, member } = chatAccess(req, row.chat_id);
  if (row.sender_id !== req.user.id) throw forbidden('Редактировать можно только свои сообщения');
  if (row.deleted_for_all) throw badRequest('Сообщение удалено');
  if (row.type !== 'text' && !row.text) throw badRequest('Это сообщение нельзя редактировать');

  const text = validate.text(req.body?.text);
  if (text.error) throw badRequest(text.error, { field: 'text' });
  const sanitizedText = sanitizePremiumEmojiText(text.value, !!commerce.premium.get(req.user.id, now()));
  if (!sanitizedText.trim()) throw badRequest('Пустое сообщение', { field: 'text' });
  await assertOutgoingContent({ chat, userId: req.user.id, text: sanitizedText });
  const dto = editMessage({ row, user: req.user, text: sanitizedText });
  if (chat.type !== 'dm') {
    moderateGroupMessage({
      chatId: chat.id,
      messageId: row.id,
      userId: req.user.id,
      context: chat.type,
      text: sanitizedText,
    }).catch((error) => console.error('Aurora Security moderation request failed:', error.message));
  }
  res.json({ message: dto });
}));

messagesRouter.delete('/messages/:id', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const { chat, member } = chatAccess(req, row.chat_id);
  const forAll = req.query.forAll === '1' || req.body?.forAll === true;
  const isMine = row.sender_id === req.user.id;
  const isModerator = chat.type !== 'dm' && hasChatPermission(member, 'moderate');
  if (forAll && !isMine && !isModerator) throw forbidden('Удалить у всех может автор или администратор');
  deleteMessage({ row, user: req.user, forAll });
  res.json({ ok: true, forAll, id: row.id, chatId: row.chat_id });
}));

/* ─────────────────────────── Комментарии ─────────────────────────── */

function commentDTO(row) {
  return {
    id: row.id,
    text: row.deleted_at ? '' : row.text,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: !!row.deleted_at,
    parentId: row.parent_comment_id,
    likesCount: Number(row.likes_count) || 0,
    likedByMe: !!row.liked_by_me,
    author: {
      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_avatar_url ? signMedia(row.author_avatar_url) : null,
      avatarColor: row.author_avatar_color,
    },
  };
}

function commentTarget(req) {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const message = messages.byId.get(id.value);
  if (!message) throw notFound('Публикация не найдена');
  const { chat, member } = chatAccess(req, message.chat_id);
  if (chat.type !== 'channel') throw badRequest('Комментарии доступны только у публикаций каналов');
  if (message.deleted_for_all || messages.isHidden.get(message.id, req.user.id)) {
    throw notFound('Публикация не найдена');
  }
  return { message, chat, member };
}

messagesRouter.get('/messages/:id/comments', limit('read'), wrap((req, res) => {
  const { message, chat } = commentTarget(req);
  if (chat.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  res.json({
    comments: comments.forMessage.all({ messageId: message.id, userId: req.user.id }).map(commentDTO),
    commentsCount: comments.count.get(message.id).c,
  });
}));

messagesRouter.post('/messages/:id/comments', limit('write'), wrap(async (req, res) => {
  const { message, chat } = commentTarget(req);
  if (chat.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  if (chat.is_frozen) throw forbidden('Чат временно заморожен администратором');
  if (typeof req.body?.text !== 'string') throw badRequest('Комментарий должен быть текстом');
  const text = cleanText(req.body.text).trim();
  if (!text) throw badRequest('Комментарий не может быть пустым');
  if (text.length > 1000) throw badRequest('Комментарий не может быть длиннее 1000 символов');
  await assertOutgoingContent({ chat, userId: req.user.id, text });

  let parentId = null;
  if (req.body.parentId !== undefined && req.body.parentId !== null) {
    const parsedParentId = validate.id(req.body.parentId);
    if (parsedParentId.error) throw badRequest('Некорректный комментарий для ответа');
    const parent = comments.parent.get(parsedParentId.value);
    if (!parent || parent.message_id !== message.id || parent.parent_comment_id !== null || parent.deleted_at) {
      throw badRequest('Ответить можно только на существующий основной комментарий этой публикации');
    }
    parentId = parent.id;
  }

  const createdAt = now();
  const currentChat = chats.byId.get(chat.id);
  if (!chats.memberOf.get(chat.id, req.user.id)) throw forbidden('Нет доступа к этому каналу');
  if (currentChat?.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  if (!currentChat || currentChat.is_frozen) throw forbidden('Канал временно заморожен администратором');
  if (messages.byId.get(message.id)?.deleted_for_all) throw notFound('Публикация не найдена');
  const create = db.transaction(() => {
    const result = comments.create.run(message.id, req.user.id, text, createdAt, parentId);
    return {
      comment: comments.forMessage.all({ messageId: message.id, userId: req.user.id })
        .find((item) => item.id === Number(result.lastInsertRowid)),
      commentsCount: comments.count.get(message.id).c,
    };
  });
  const result = create();
  const comment = commentDTO(result.comment);
  publishChat(chat.id, 'comment.new', {
    chatId: chat.id,
    messageId: message.id,
    comment,
    commentsCount: result.commentsCount,
  });
  res.status(201).json({ comment, commentsCount: result.commentsCount });
}));

messagesRouter.patch('/messages/:id/comments/:commentId', limit('write'), wrap(async (req, res) => {
  const { message, chat, member } = commentTarget(req);
  if (chat.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  if (chat.is_frozen) throw forbidden('Канал временно заморожен администратором');
  const commentId = validate.id(req.params.commentId);
  if (commentId.error) throw badRequest(commentId.error);
  const row = comments.parent.get(commentId.value);
  if (!row || row.message_id !== message.id || row.deleted_at) throw notFound('Комментарий не найден');
  if (row.author_id !== req.user.id) throw forbidden('Редактировать можно только свой комментарий');
  const text = cleanText(req.body?.text).trim();
  if (!text) throw badRequest('Комментарий не может быть пустым');
  if (text.length > 1000) throw badRequest('Комментарий не может быть длиннее 1000 символов');
  await assertOutgoingContent({ chat, userId: req.user.id, text });
  const editedAt = now();
  const currentChat = chats.byId.get(chat.id);
  if (!chats.memberOf.get(chat.id, req.user.id)) throw forbidden('Нет доступа к этому каналу');
  if (currentChat?.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  if (!currentChat || currentChat.is_frozen) throw forbidden('Канал временно заморожен администратором');
  if (!comments.updateText.run(text, editedAt, commentId.value).changes) throw notFound('Комментарий не найден');
  const updated = comments.forMessage.all({ messageId: message.id, userId: req.user.id })
    .find((item) => item.id === commentId.value);
  const comment = commentDTO(updated);
  publishChat(chat.id, 'comment.update', { chatId: chat.id, messageId: message.id, comment });
  res.json({ comment });
}));

messagesRouter.delete('/messages/:id/comments/:commentId', limit('write'), wrap((req, res) => {
  const { message, chat, member } = commentTarget(req);
  const commentId = validate.id(req.params.commentId);
  if (commentId.error) throw badRequest(commentId.error);
  const row = comments.parent.get(commentId.value);
  if (!row || row.message_id !== message.id || row.deleted_at) throw notFound('Комментарий не найден');
  const isAuthor = row.author_id === req.user.id;
  if (!isAuthor && !hasChatPermission(member, 'moderate')) throw forbidden('Удалить комментарий может автор или модератор канала');
  const deletedAt = now();
  const remove = db.transaction(() => {
    comments.softDelete.run(deletedAt, commentId.value);
    comments.removeAllLikes.run(commentId.value);
    return comments.count.get(message.id).c;
  });
  const commentsCount = remove();
  publishChat(chat.id, 'comment.delete', {
    chatId: chat.id, messageId: message.id, commentId: commentId.value, commentsCount,
  });
  res.json({ ok: true, commentId: commentId.value, commentsCount });
}));

messagesRouter.post('/messages/:id/comments/:commentId/likes', limit('write'), wrap((req, res) => {
  const { message, chat } = commentTarget(req);
  if (chat.comments_enabled === 0) throw forbidden('Комментарии отключены владельцем канала');
  if (chat.is_frozen) throw forbidden('Канал временно заморожен администратором');
  const commentId = validate.id(req.params.commentId);
  if (commentId.error) throw badRequest(commentId.error);
  const row = comments.parent.get(commentId.value);
  if (!row || row.message_id !== message.id || row.deleted_at) throw notFound('Комментарий не найден');
  const createdAt = now();
  const toggle = db.transaction(() => {
    const existing = comments.likeExists.get(commentId.value, req.user.id);
    if (existing) comments.removeLike.run(commentId.value, req.user.id);
    else comments.addLike.run(commentId.value, req.user.id, createdAt);
    return {
      likedByMe: !existing,
      likesCount: comments.likeCount.get(commentId.value).c,
    };
  });
  const result = toggle();
  const payload = {
    chatId: chat.id, messageId: message.id, commentId: commentId.value,
    userId: req.user.id, ...result,
  };
  publishChat(chat.id, 'comment.like', payload);
  res.json(result);
}));

messagesRouter.post('/messages/:id/report', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const { chat } = chatAccess(req, row.chat_id);
  if (chat.type === 'dm') throw badRequest('Жалобы на личные сообщения пока недоступны');
  if (row.deleted_for_all) throw badRequest('Нельзя пожаловаться на удалённое сообщение');
  const reason = req.body?.reason;
  if (!['spam', 'abuse', 'scam', 'other'].includes(reason)) throw badRequest('Выберите причину жалобы');
  const details = cleanText(String(req.body?.details || '')).trim();
  if (details.length > 500) throw badRequest('Пояснение не должно превышать 500 символов');
  try {
    const result = chatReports.create.run({
      chat_id: chat.id, message_id: row.id, reporter_id: req.user.id, reason, details, created_at: now(),
    });
    const reportId = Number(result.lastInsertRowid);
    for (const member of chats.members.all(chat.id)) {
      if (hasChatPermission(member, 'moderate')) {
        publishUser(member.user_id, 'chat.report.new', { chatId: chat.id, reportId, messageId: row.id });
      }
    }
    res.status(201).json({ reportId });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Вы уже отправили жалобу на это сообщение');
    throw error;
  }
}));

/* ─────────────────────────── Реакции ─────────────────────────── */

messagesRouter.post('/messages/:id/reactions', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  chatAccess(req, row.chat_id);
  if (row.deleted_for_all) throw badRequest('Сообщение удалено');
  const chat = chats.byId.get(row.chat_id);
  const emoji = String(req.body?.emoji || '');
  const allowed = PREMIUM_REACTIONS.includes(emoji) || ALLOWED_REACTIONS.includes(emoji)
    || (/^\p{Extended_Pictographic}/u.test(emoji) && emoji.length <= 8);
  if (!allowed) throw badRequest('Недопустимая реакция');
  const current = reactions.forMessageUser.get(row.id, req.user.id, emoji);
  let action;
  if (current) { reactions.remove.run(row.id, req.user.id, emoji); action = 'removed'; }
  else {
    if (chat.type === 'channel' && chat.reactions_enabled === 0) throw forbidden('Реакции отключены владельцем канала');
    if (chat.type === 'channel' && chat.allowed_reactions) {
      const allowedReactions = JSON.parse(chat.allowed_reactions);
      if (!allowedReactions.includes(emoji)) throw forbidden('Эта реакция отключена в канале');
    }
    if (PREMIUM_REACTIONS.includes(emoji) && !commerce.premium.get(req.user.id, now())) {
      throw forbidden('Эта реакция доступна только с Premium');
    }
    reactions.set.run(row.id, req.user.id, emoji, now());
    action = 'added';
  }

  const summary = buildMessages([messages.byId.get(row.id)], req.user.id)[0];
  publishChat(row.chat_id, 'reaction.update', { messageId: row.id, chatId: row.chat_id, emoji, userId: req.user.id, action, reactions: summary.reactions });
  res.json({ ok: true, action, reactions: summary.reactions, myReaction: summary.myReaction });
}));

/** Кто именно поставил реакцию (информация о сообщении). */
messagesRouter.get('/messages/:id/reactions', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  chatAccess(req, row.chat_id);
  res.json({ reactions: reactions.all.all(row.id).map((r) => ({
    emoji: r.emoji, userId: r.user_id, name: r.name, username: r.username,
    avatarUrl: r.avatar_url ? signMedia(r.avatar_url, 30 * 24 * 3600 * 1000) : null,
  })) });
}));

/* ─────────────────────────── Закрепление и просмотры ─────────────────────────── */

messagesRouter.post('/messages/:id/pin', limit('write'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const { chat, member } = chatAccess(req, row.chat_id);
  if (chat.type !== 'dm' && !hasChatPermission(member, 'pin_messages')) throw forbidden('Закреплять сообщения может администратор с соответствующим правом');
  if (row.deleted_for_all) throw badRequest('Сообщение удалено');
  const pinned = req.body?.pinned === false ? 0 : 1;
  messages.pin.run(pinned, row.id);
  publishChat(row.chat_id, 'message.pin', { messageId: row.id, chatId: row.chat_id, pinned: !!pinned, by: req.user.id });
  res.json({ ok: true, pinned: !!pinned });
}));

/** Просмотры публикаций канала (по одному разу на пользователя за сессию контролирует клиент). */
messagesRouter.post('/messages/:id/view', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const chat = chats.byId.get(row.chat_id);
  chatAccess(req, row.chat_id);
  if (chat.type === 'channel' && row.sender_id !== req.user.id) {
    messages.bumpViews.run(row.id);
    publishChat(row.chat_id, 'message.views', { messageId: row.id, chatId: row.chat_id, views: messages.byId.get(row.id).views });
  }
  res.json({ ok: true, views: messages.byId.get(row.id).views });
}));

/* ─────────────────────────── Информация о сообщении ─────────────────────────── */

messagesRouter.get('/messages/:id', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  const { chat } = chatAccess(req, row.chat_id);
  const [dto] = buildMessages([row], req.user.id);
  const members = chats.members.all(row.chat_id).map((m) => ({
    id: m.user_id, name: m.name, username: m.username,
    avatarUrl: m.avatar_url ? signMedia(m.avatar_url, 30 * 24 * 3600 * 1000) : null,
    read: m.last_read_seq >= row.seq, delivered: m.last_delivered_seq >= row.seq, role: m.role,
  }));
  const reply = row.reply_to ? replyPreview(row.reply_to, req.user.id) : null;
  const forwardSource = row.fwd_from_chat ? chats.byId.get(row.fwd_from_chat) : null;
  res.json({
    message: dto,
    chat: { id: chat.id, type: chat.type, title: chat.title },
    reply,
    forwardedFrom: forwardSource ? { chatId: forwardSource.id, title: forwardSource.title, username: forwardSource.username } : null,
    readers: members,
  });
}));

/* ─────────────────────────── Пересылка ─────────────────────────── */

messagesRouter.post('/messages/forward', limit('write'), wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.messageIds) ? req.body.messageIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const targetIds = (Array.isArray(req.body?.chatIds) ? req.body.chatIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30);
  if (!ids.length) throw badRequest('Не выбраны сообщения');
  if (!targetIds.length) throw badRequest('Не выбран чат назначения');

  const sources = ids.map((i) => messages.byId.get(i)).filter(Boolean);
  if (!sources.length) throw notFound('Сообщения не найдены');
  // Проверяем, что у пользователя есть доступ к источникам: иначе получилась бы «пересылка вслепую».
  for (const s of sources) {
    if (!chats.memberOf.get(s.chat_id, req.user.id)) throw forbidden('Нет доступа к исходному сообщению');
    const sourceChat = chats.byId.get(s.chat_id);
    if (sourceChat?.type === 'channel' && sourceChat.protected_content) throw forbidden('В этом канале запрещено копирование и пересылка');
  }

  const targets = targetIds.map((targetId) => chats.byId.get(targetId)).filter(Boolean);
  const eligibleTargets = targets.filter((target) => {
    const member = chats.memberOf.get(target.id, req.user.id);
    return member && !(target.type === 'channel' && !hasChatPermission(member, 'publish'));
  });
  const policyTexts = sources.filter((source) => !source.deleted_for_all).map((source) => {
    if (source.type !== 'poll') return source.text || '';
    const poll = polls.byMessage.get(source.id);
    let options = [];
    try { options = JSON.parse(poll?.options_json || '[]'); } catch { options = []; }
    return [poll?.question || '', ...options.map((option) => option.text)].join('\n');
  });
  const targetContexts = [...new Set(eligibleTargets.map((target) => target.type))];
  for (const context of targetContexts) {
    const target = eligibleTargets.find((candidate) => candidate.type === context);
    for (const text of policyTexts) {
      await assertOutgoingContent({ chat: target, userId: req.user.id, text });
    }
  }

  const results = [];
  for (const targetId of targetIds) {
    const target = chats.byId.get(targetId);
    if (!target) continue;
    const member = chats.memberOf.get(targetId, req.user.id);
    if (!member) continue;
    if (target.type === 'channel' && !hasChatPermission(member, 'publish')) continue;
    let count = 0;
    for (const s of sources) {
      if (s.deleted_for_all) continue;
      createMessage({
        chat: target,
        sender: req.user,
        type: s.type,
        text: s.text,
        mediaId: s.media_id,
        sticker: s.sticker,
        fwdFromUser: s.sender_id,
        fwdFromChat: s.chat_id,
      });
      count++;
    }
    results.push({ chatId: targetId, count });
  }
  if (!results.length) throw forbidden('Нет чата, куда можно переслать');
  res.json({ ok: true, results, total: results.reduce((a, r) => a + r.count, 0) });
}));

/** Контекст для ответа/правки: сообщение + превью. */
messagesRouter.get('/messages/:id/context', limit('read'), wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = messages.byId.get(id.value);
  if (!row) throw notFound('Сообщение не найдено');
  chatAccess(req, row.chat_id);
  const rows = messages.page.all({ chat_id: row.chat_id, before: row.seq + 11, limit: 21, uid: req.user.id });
  res.json({ messages: buildMessages(rows.reverse(), req.user.id), focus: row.id });
}));

export default messagesRouter;
