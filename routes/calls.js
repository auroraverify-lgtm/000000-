import express from 'express';
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { db, chats, users, settings, blocks, now } from '../db.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound, conflict } from '../middleware.js';
import { sendTo } from '../realtime.js';
import { sharesContact } from '../helpers.js';
import { sendCallEndedPush, sendCallPush } from '../push.js';

export const callsRouter = express.Router();
callsRouter.use(requireAuth, limit('write'));

const MAX_PARTICIPANTS = 16;
const activeCall = db.prepare("SELECT * FROM calls WHERE chat_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1");
const callById = db.prepare("SELECT * FROM calls WHERE id = ? AND status = 'active'");
const participantByUser = db.prepare('SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?');
const participantsByCall = db.prepare('SELECT * FROM call_participants WHERE call_id = ?');
const membersByChat = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?');
const insertCall = db.prepare(`INSERT INTO calls (id, chat_id, room_name, started_by, media_mode, status, started_at)
  VALUES (@id, @chat_id, @room_name, @started_by, @media_mode, 'active', @started_at)`);
const insertParticipant = db.prepare(`INSERT INTO call_participants
  (call_id, user_id, identity, status, invited_at, joined_at) VALUES (?, ?, ?, ?, ?, ?)`);

function liveKit() {
  const { LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
  if (!key || !secret) return null;
  const url = process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880';
  return { key, secret, rooms: new RoomServiceClient(url, key, secret) };
}

function requireLiveKit() {
  const service = liveKit();
  if (!service) throw Object.assign(new Error('Звонки временно не настроены на сервере'), { status: 503, expose: true, code: 'calls_unavailable' });
  return service;
}

function callChat(req, rawId, { requireUnfrozen = false } = {}) {
  const chatId = Number(rawId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw badRequest('Некорректный идентификатор чата');
  const chat = chats.byId.get(chatId);
  if (!chat) throw notFound('Чат не найден');
  if (!chats.memberOf.get(chatId, req.user.id)) throw forbidden('Нет доступа к этому чату');
  if (requireUnfrozen && chat.is_frozen) throw forbidden('Чат временно заморожен администратором');
  if (chat.type !== 'dm' && chat.type !== 'group') throw badRequest('Звонки доступны только в личных чатах и группах');
  if (chat.type === 'dm') {
    const peerMember = chats.members.all(chatId).find((member) => member.user_id !== req.user.id);
    const peer = peerMember ? users.byId.get(peerMember.user_id) : null;
    if (!peer || peer.is_bot) throw forbidden('Вызов этого аккаунта недоступен');
    const peerSettings = settings.byUser.get(peer.id);
    const audience = peerSettings?.privacy_messages || 'everyone';
    if (blocks.isBlocked.get(peer.id, req.user.id)
      || blocks.isBlocked.get(req.user.id, peer.id)
      || audience === 'nobody'
      || (audience === 'contacts' && !sharesContact(peer.id, req.user.id))) {
      throw forbidden('Пользователь ограничил звонки и сообщения');
    }
  }
  return chat;
}

function notifyChat(chatId, event, except = null) {
  for (const { user_id: userId } of membersByChat.all(chatId)) {
    if (userId !== except) sendTo(userId, event);
  }
}

function publicCall(row, chat, caller = null) {
  return {
    id: row.id,
    chatId: row.chat_id,
    chatTitle: chat?.title || caller?.name || 'Звонок',
    mediaMode: row.media_mode,
    startedBy: row.started_by,
    callerName: caller?.name || null,
    startedAt: row.started_at,
  };
}

async function issueJoin(call, user, { allowUninvited = false } = {}) {
  const service = requireLiveKit();
  let participant = participantByUser.get(call.id, user.id);
  if (!participant && allowUninvited) {
    const identity = `${user.id}-${randomUUID()}`;
    insertParticipant.run(call.id, user.id, identity, 'invited', now(), null);
    participant = participantByUser.get(call.id, user.id);
  }
  if (!participant || ['declined', 'missed', 'left'].includes(participant.status)) {
    throw forbidden('Вы не приглашены в этот звонок');
  }
  const identity = participant.identity || `${user.id}-${randomUUID()}`;
  const liveParticipants = await service.rooms.listParticipants(call.room_name);
  if (!liveParticipants.some((item) => item.identity === identity) && liveParticipants.length >= MAX_PARTICIPANTS) {
    throw conflict(`В звонке уже максимальное количество участников: ${MAX_PARTICIPANTS}`);
  }
  const ts = now();
  db.prepare(`UPDATE call_participants SET identity = ?, status = 'joined',
    joined_at = COALESCE(joined_at, ?), ended_at = NULL WHERE call_id = ? AND user_id = ?`)
    .run(identity, ts, call.id, user.id);
  sendTo(user.id, { type: 'call.accepted', callId: call.id, chatId: call.chat_id, ts });
  const token = new AccessToken(service.key, service.secret, {
    identity,
    name: user.name,
    ttl: '1h',
  });
  token.addGrant({
    roomJoin: true,
    room: call.room_name,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return {
    call: publicCall(call, chats.byId.get(call.chat_id), users.byId.get(call.started_by)),
    token: await token.toJwt(),
    serverUrl: process.env.LIVEKIT_PUBLIC_URL || null,
  };
}

function finishCall(callId, reason = 'ended') {
  const call = callById.get(callId);
  if (!call) return;
  void sendCallEndedPush({ callId: call.id, callerId: call.started_by }).catch((error) => {
    console.error('Unable to cancel incoming call notifications:', error.message);
  });
  const ts = now();
  const update = db.transaction(() => {
    db.prepare(`UPDATE call_participants SET
      status = CASE WHEN status = 'invited' THEN 'missed' WHEN status = 'joined' THEN 'left' ELSE status END,
      ended_at = CASE WHEN status IN ('invited','joined') THEN ? ELSE ended_at END
      WHERE call_id = ?`).run(ts, callId);
    db.prepare("UPDATE calls SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'").run(ts, callId);
  });
  update();
  notifyChat(call.chat_id, { type: 'call.ended', callId, chatId: call.chat_id, reason, ts });
}

callsRouter.post('/chats/:chatId/calls', wrap(async (req, res) => {
  const chat = callChat(req, req.params.chatId, { requireUnfrozen: true });
  const mediaMode = req.body?.mediaMode === 'video' ? 'video' : req.body?.mediaMode === 'audio' ? 'audio' : null;
  if (!mediaMode) throw badRequest('Выберите аудио- или видеозвонок');
  const service = requireLiveKit();
  let call = activeCall.get(chat.id);
  if (!call) {
    const id = randomUUID();
    const roomName = `aurora-${id}`;
    const startedAt = now();
    const memberIds = membersByChat.all(chat.id).map((row) => row.user_id);
    const inviteeIds = memberIds.filter((userId) => userId !== req.user.id).slice(0, MAX_PARTICIPANTS - 1);
    try {
      await service.rooms.createRoom({
        name: roomName,
        emptyTimeout: 60,
        departureTimeout: 30,
        maxParticipants: MAX_PARTICIPANTS,
      });
    } catch (error) {
      console.error('Unable to create LiveKit room:', error.message);
      throw Object.assign(new Error('Не удалось создать комнату звонка'), { status: 503, expose: true, code: 'calls_unavailable' });
    }
    try {
      const create = db.transaction(() => {
        insertCall.run({ id, chat_id: chat.id, room_name: roomName, started_by: req.user.id, media_mode: mediaMode, started_at: startedAt });
        insertParticipant.run(id, req.user.id, `${req.user.id}-${randomUUID()}`, 'joined', startedAt, startedAt);
        for (const userId of inviteeIds) {
          insertParticipant.run(id, userId, `${userId}-${randomUUID()}`, 'invited', startedAt, null);
        }
      });
      create();
    } catch (error) {
      await service.rooms.deleteRoom(roomName);
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        call = activeCall.get(chat.id);
        if (call) return res.json(await issueJoin(call, req.user, { allowUninvited: true }));
      }
      throw error;
    }
    call = callById.get(id);
    const caller = users.byId.get(req.user.id);
    const event = {
      type: 'call.incoming',
      call: publicCall(call, chat, caller),
      ts: startedAt,
    };
    for (const userId of inviteeIds) sendTo(userId, event);
    void sendCallPush({ call, chat, caller }).catch((error) => {
      console.error('Unable to send incoming call notifications:', error.message);
    });
  }
  res.json(await issueJoin(call, req.user, { allowUninvited: true }));
}));

callsRouter.get('/chats/:chatId/calls/active', wrap((req, res) => {
  const chat = callChat(req, req.params.chatId);
  const call = activeCall.get(chat.id);
  if (!call) return res.json({ call: null });
  const caller = users.byId.get(call.started_by);
  res.json({ call: publicCall(call, chat, caller) });
}));

callsRouter.get('/calls/incoming', wrap((req, res) => {
  const incoming = db.prepare(`SELECT c.*, ch.title AS chat_title, u.name AS caller_name
    FROM call_participants p
    JOIN calls c ON c.id = p.call_id AND c.status = 'active'
    JOIN chats ch ON ch.id = c.chat_id
    JOIN users u ON u.id = c.started_by
    WHERE p.user_id = ? AND p.status = 'invited'
    ORDER BY c.started_at DESC LIMIT 10`).all(req.user.id);
  res.json({ calls: incoming.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    chatTitle: row.chat_title || row.caller_name,
    mediaMode: row.media_mode,
    startedBy: row.started_by,
    callerName: row.caller_name,
    startedAt: row.started_at,
  })) });
}));

let maintenanceRunning = false;
export function startCallMaintenance() {
  const timer = setInterval(async () => {
    const service = liveKit();
    if (!service || maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const active = db.prepare("SELECT id, room_name FROM calls WHERE status = 'active'").all();
      const rooms = new Set((await service.rooms.listRooms()).map((room) => room.name));
      for (const call of active) {
        if (!rooms.has(call.room_name)) finishCall(call.id, 'expired');
      }
    } catch (error) {
      console.error('Unable to reconcile active calls with LiveKit:', error.message);
    } finally {
      maintenanceRunning = false;
    }
  }, 30000);
  timer.unref?.();
  return timer;
}

callsRouter.post('/calls/:callId/join', wrap(async (req, res) => {
  const call = callById.get(req.params.callId);
  if (!call) throw notFound('Звонок уже завершён');
  callChat(req, call.chat_id, { requireUnfrozen: true });
  res.json(await issueJoin(call, req.user, { allowUninvited: true }));
}));

callsRouter.post('/calls/:callId/decline', wrap((req, res) => {
  const call = callById.get(req.params.callId);
  if (!call) throw notFound('Звонок уже завершён');
  callChat(req, call.chat_id);
  const participant = participantByUser.get(call.id, req.user.id);
  if (!participant || participant.status !== 'invited') throw forbidden('Нет активного приглашения в этот звонок');
  db.prepare("UPDATE call_participants SET status = 'declined', ended_at = ? WHERE call_id = ? AND user_id = ?")
    .run(now(), call.id, req.user.id);
  const event = { type: 'call.declined', callId: call.id, chatId: call.chat_id, userId: req.user.id, ts: now() };
  sendTo(call.started_by, event);
  sendTo(req.user.id, event);
  res.json({ ok: true });
}));

callsRouter.post('/calls/:callId/leave', wrap(async (req, res) => {
  const call = callById.get(req.params.callId);
  if (!call) return res.json({ ok: true });
  callChat(req, call.chat_id);
  const participant = participantByUser.get(call.id, req.user.id);
  if (!participant || participant.status !== 'joined') throw forbidden('Вы не участвуете в этом звонке');
  const service = requireLiveKit();
  const endForAll = req.body?.endForAll === true;
  if (endForAll && call.started_by !== req.user.id) throw forbidden('Завершить звонок для всех может только создатель');
  if (endForAll) {
    await service.rooms.deleteRoom(call.room_name);
    finishCall(call.id, 'ended_by_host');
  } else {
    await service.rooms.removeParticipant(call.room_name, participant.identity);
    db.prepare("UPDATE call_participants SET status = 'left', ended_at = ? WHERE call_id = ? AND user_id = ?")
      .run(now(), call.id, req.user.id);
    const participants = await service.rooms.listParticipants(call.room_name);
    notifyChat(call.chat_id, {
      type: 'call.participant-left', callId: call.id, chatId: call.chat_id, userId: req.user.id, ts: now(),
    }, req.user.id);
    if (!participants.length) {
      await service.rooms.deleteRoom(call.room_name);
      finishCall(call.id, 'empty');
    }
  }
  res.json({ ok: true });
}));

callsRouter.get('/calls/history', wrap((req, res) => {
  const params = [req.user.id];
  let chatFilter = '';
  if (req.query.chatId !== undefined) {
    const chat = callChat(req, req.query.chatId);
    chatFilter = ' AND c.chat_id = ?';
    params.push(chat.id);
  }
  const rows = db.prepare(`SELECT c.id, c.chat_id, ch.title AS chat_title, c.started_by, u.name AS caller_name,
      (SELECT peer.name FROM chat_members peer_member JOIN users peer ON peer.id = peer_member.user_id
        WHERE peer_member.chat_id = c.chat_id AND peer_member.user_id <> p.user_id LIMIT 1) AS peer_name,
      c.media_mode, c.started_at, c.ended_at, p.status
    FROM call_participants p
    JOIN calls c ON c.id = p.call_id
    JOIN chats ch ON ch.id = c.chat_id
    JOIN users u ON u.id = c.started_by
    WHERE p.user_id = ?${chatFilter}
    ORDER BY c.started_at DESC LIMIT 50`).all(...params);
  res.json({ calls: rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    chatTitle: row.chat_title || row.peer_name || row.caller_name,
    callerName: row.caller_name,
    startedBy: row.started_by,
    mediaMode: row.media_mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    missed: row.status === 'missed',
  })) });
}));
