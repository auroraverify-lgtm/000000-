import express from 'express';
import { db, media, stories, now, tx } from '../db.js';
import { cleanText, signMedia, validate } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound } from '../middleware.js';
import { isBlockedPair, sharesContact } from '../helpers.js';
import { removeMedia } from '../storage.js';

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_STORIES = 20;
const MAX_STORY_TEXT = 500;

export const storiesRouter = express.Router();
storiesRouter.use(requireAuth);

function storyAccess(story, viewerId, timestamp = now()) {
  if (!story || story.expires_at <= timestamp) throw notFound('История не найдена или уже истекла');
  if (story.owner_id !== viewerId
    && (!sharesContact(story.owner_id, viewerId) || isBlockedPair(story.owner_id, viewerId))) {
    throw notFound('История не найдена или уже истекла');
  }
}

function storyDTO(row, timestamp) {
  const mediaRow = row.media_id ? media.byId.get(row.media_id) : null;
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    mediaUrl: mediaRow ? signMedia(mediaRow.id, Math.max(1000, row.expires_at - timestamp)) : null,
    mediaMime: mediaRow?.mime || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewCount: Number(row.view_count || 0),
    likeCount: Number(row.like_count || 0),
    viewedByMe: !!row.viewed_by_me,
    likedByMe: !!row.liked_by_me,
    author: {
      id: row.owner_id,
      name: row.name,
      username: row.username,
      avatarUrl: row.avatar_url,
      avatarColor: row.avatar_color,
    },
  };
}

function removeUnusedMedia(mediaId) {
  if (!mediaId) return;
  const row = media.deleteIfUnreferenced.get(mediaId, mediaId, mediaId, mediaId, mediaId, mediaId, mediaId);
  if (row) removeMedia(row);
}

export function cleanupExpiredStories() {
  const timestamp = now();
  const expiredMediaIds = stories.expiredMediaIds.all(timestamp).map((row) => row.media_id);
  const cleanup = tx(() => {
    stories.deleteExpired.run(timestamp);
    return expiredMediaIds.map((id) => media.deleteIfUnreferenced.get(id, id, id, id, id, id, id)).filter(Boolean);
  })();
  for (const row of cleanup) {
    try {
      removeMedia(row);
    } catch (error) {
      console.error('Unable to remove expired story media:', error.message);
    }
  }
  return cleanup.length;
}

export function startStoryMaintenance() {
  const cleanup = () => {
    try {
      cleanupExpiredStories();
    } catch (error) {
      console.error('Unable to clean expired stories:', error.message);
    }
  };
  cleanup();
  const timer = setInterval(cleanup, 15 * 60 * 1000);
  timer.unref();
}

storiesRouter.get('/', limit('read'), wrap((req, res) => {
  const timestamp = now();
  const rows = stories.feed.all({ viewer_id: req.user.id, now: timestamp });
  res.json({ stories: rows.map((row) => storyDTO(row, timestamp)) });
}));

storiesRouter.post('/', limit('write'), wrap((req, res) => {
  const type = String(req.body?.type || '');
  if (!['text', 'image', 'video'].includes(type)) throw badRequest('Выберите текстовую историю, фото или видео');
  const text = cleanText(String(req.body?.text || '')).trim().slice(0, MAX_STORY_TEXT);
  let mediaId = null;
  if (type === 'text') {
    if (!text) throw badRequest('Напишите текст истории');
  } else {
    const parsedMediaId = validate.id(req.body?.mediaId);
    if (parsedMediaId.error) throw badRequest('Загрузите фото или видео для истории');
    const row = media.byId.get(parsedMediaId.value);
    const expectedKind = type === 'image' ? 'image' : 'video';
    if (!row || row.owner_id !== req.user.id || row.kind !== expectedKind) {
      throw forbidden('Для истории можно использовать только собственное загруженное медиа подходящего типа');
    }
    mediaId = row.id;
  }

  const timestamp = now();
  if (stories.ownActiveCount.get(req.user.id, timestamp).count >= MAX_ACTIVE_STORIES) {
    throw forbidden('Можно опубликовать не более 20 активных историй одновременно');
  }
  const info = stories.create.run({
    owner_id: req.user.id,
    type,
    text,
    media_id: mediaId,
    created_at: timestamp,
    expires_at: timestamp + STORY_TTL_MS,
  });
  const created = stories.feed.all({ viewer_id: req.user.id, now: timestamp })
    .find((story) => story.id === Number(info.lastInsertRowid));
  if (!created) throw new Error('Story was not available after creation');
  res.status(201).json({ story: storyDTO(created, timestamp) });
}));

storiesRouter.post('/:id/views', limit('write'), wrap((req, res) => {
  const parsedId = validate.id(req.params.id);
  if (parsedId.error) throw badRequest(parsedId.error);
  const timestamp = now();
  const story = stories.byId.get(parsedId.value);
  storyAccess(story, req.user.id, timestamp);
  if (story.owner_id !== req.user.id) stories.insertView.run(story.id, req.user.id, timestamp);
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM story_views WHERE story_id = ?) AS views,
    (SELECT COUNT(*) FROM story_likes WHERE story_id = ?) AS likes`).get(story.id, story.id);
  res.json({ viewed: story.owner_id !== req.user.id, viewCount: counts.views, likeCount: counts.likes });
}));

storiesRouter.post('/:id/likes', limit('write'), wrap((req, res) => {
  const parsedId = validate.id(req.params.id);
  if (parsedId.error) throw badRequest(parsedId.error);
  const timestamp = now();
  const story = stories.byId.get(parsedId.value);
  storyAccess(story, req.user.id, timestamp);
  if (story.owner_id === req.user.id) throw badRequest('Нельзя поставить отметку нравится своей истории');
  const toggleLike = db.transaction(() => {
    if (stories.likeExists.get(story.id, req.user.id)) {
      stories.removeLike.run(story.id, req.user.id);
      return false;
    }
    stories.addLike.run(story.id, req.user.id, timestamp);
    return true;
  });
  const liked = toggleLike();
  const likeCount = db.prepare('SELECT COUNT(*) AS count FROM story_likes WHERE story_id = ?').get(story.id).count;
  res.json({ liked, likeCount });
}));

storiesRouter.delete('/:id', limit('write'), wrap((req, res) => {
  const parsedId = validate.id(req.params.id);
  if (parsedId.error) throw badRequest(parsedId.error);
  const result = stories.deleteOwned.get(parsedId.value, req.user.id);
  if (!result) throw notFound('История не найдена');
  removeUnusedMedia(result.media_id);
  res.json({ ok: true });
}));
