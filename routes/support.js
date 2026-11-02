import express from 'express';
import { db, chats, users, now } from '../db.js';
import { validate } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound } from '../middleware.js';
import { createMessage } from '../services/messages.js';
import { assertOutgoingContent } from '../outgoing-content.js';

export const supportRouter = express.Router();
supportRouter.use(requireAuth, limit('write'));
const CATEGORIES = ['security', 'login', 'report', 'media', 'channel', 'idea', 'other'];

function supportChatForUser(chatId, userId) {
  const chat = chats.byId.get(chatId);
  const members = chat?.type === 'dm' ? chats.members.all(chatId) : [];
  const support = members.find((member) => member.is_bot && member.username === 'aurora_support');
  if (members.length !== 2 || !members.some((member) => member.user_id === userId) || !support) {
    throw forbidden('Обращение можно связать только с официальным чатом поддержки');
  }
  return chat;
}

supportRouter.get('/requests', wrap((req, res) => {
  const requests = db.prepare('SELECT * FROM support_requests WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50').all(req.user.id);
  res.json({ requests });
}));

supportRouter.post('/requests', wrap((req, res) => {
  const category = String(req.body?.category || 'other');
  if (!CATEGORIES.includes(category)) throw badRequest('Неизвестная категория обращения');
  const chatId = req.body?.chatId ? validate.id(req.body.chatId) : { value: null };
  if (chatId.error) throw badRequest(chatId.error);
  if (chatId.value) supportChatForUser(chatId.value, req.user.id);
  const existing = chatId.value
    ? db.prepare("SELECT id FROM support_requests WHERE user_id = ? AND chat_id = ? AND category = ? AND status IN ('open','in_progress') LIMIT 1").get(req.user.id, chatId.value, category)
    : null;
  if (existing) return res.json({ request: existing, duplicate: true });
  const ts = now();
  const result = db.prepare(`INSERT INTO support_requests (user_id, chat_id, category, subject, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)`).run(req.user.id, chatId.value, category, String(req.body?.subject || '').slice(0, 200), ts, ts);
  res.status(201).json({ request: db.prepare('SELECT * FROM support_requests WHERE id = ?').get(result.lastInsertRowid) });
}));

supportRouter.post('/requests/:id/message', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare('SELECT * FROM support_requests WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!request) throw notFound('Обращение не найдено');
  if (!request.chat_id) throw badRequest('У обращения нет чата');
  const chat = supportChatForUser(request.chat_id, req.user.id);
  const text = String(req.body?.text || '').trim();
  if (!text) throw badRequest('Введите сообщение');
  await assertOutgoingContent({ chat, userId: req.user.id, text });
  const sender = users.byId.get(req.user.id);
  const message = createMessage({ chat, sender, type: 'text', text });
  db.prepare('UPDATE support_requests SET updated_at = ? WHERE id = ?').run(now(), id);
  res.status(201).json({ message });
}));

export default supportRouter;
