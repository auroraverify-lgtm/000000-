/**
 * Загрузка и отдача медиа. Файлы: на диске + запись в БД; ссылки — подписанные и временные.
 * Проверка типа по «магическим байтам», а не по имени/заголовку клиента.
 */
import express from 'express';
import fs from 'node:fs';
import { db, media } from '../db.js';
import { validate, signMedia } from '../security.js';
import { requireAuth, limit, wrap, badRequest, forbidden, notFound } from '../middleware.js';
import { upload, saveMedia, saveMediaFile, cleanupUploadedFiles } from '../storage.js';
import { LIMITS } from '../config.js';

export const mediaRouter = express.Router();

/** Загрузка файла (и опционального превью) — multipart, с прогрессом на стороне клиента. */
const receiveUploads = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]);
const receiveStagedUploads = (req, res, next) => receiveUploads(req, res, (error) => {
  if (error) {
    cleanupUploadedFiles(req.files);
    return next(error);
  }
  next();
});

mediaRouter.post('/', requireAuth, limit('upload'), receiveStagedUploads, async (req, res, next) => {
  try {
    const file = req.files?.file?.[0];
    if (!file) throw badRequest('Файл не получен');
    const thumbFile = req.files?.thumb?.[0];
    if (thumbFile && thumbFile.size > 10 * 1024 * 1024) throw Object.assign(new Error('Превью изображения больше 10 МБ'), { status: 413 });
    const hint = String(req.body?.kind || '').slice(0, 16) || undefined;
    const duration = req.body?.duration ? Number(req.body.duration) : null;
    let peaks = null;
    if (req.body?.peaks) {
      try { peaks = JSON.parse(req.body.peaks); } catch { peaks = null; }
      if (Array.isArray(peaks)) peaks = peaks.slice(0, 200).map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
    }
    const row = saveMediaFile(file, {
      ownerId: req.user.id,
      declaredMime: file.mimetype,
      filename: file.originalname,
      kindHint: hint,
      duration: Number.isFinite(duration) ? duration : null,
      peaks,
      width: req.body?.width ? Number(req.body.width) : null,
      height: req.body?.height ? Number(req.body.height) : null,
    });

    if (thumbFile && row.kind === 'image') {
      const thumb = saveMedia(fs.readFileSync(thumbFile.path), {
        ownerId: req.user.id, declaredMime: thumbFile.mimetype,
        filename: `thumb-${thumbFile.originalname}`, kindHint: 'image',
      });
      if (thumb.kind === 'image') {
        db.prepare('UPDATE media SET thumb_path = ? WHERE id = ?').run(thumb.path, row.id);
        db.prepare('UPDATE media SET kind = ? WHERE id = ?').run('image', row.id);
      }
    }
    const fresh = media.byId.get(row.id);
    res.status(201).json({ media: dtoWithThumb(fresh) });
  } catch (error) {
    next(error);
  } finally {
    cleanupUploadedFiles(req.files);
  }
});

function dtoWithThumb(row) {
  let peaks = null;
  try { peaks = row.peaks ? JSON.parse(row.peaks) : null; } catch { peaks = null; }
  return {
    id: row.id, kind: row.kind, filename: row.filename, mime: row.mime, size: row.size,
    width: row.width, height: row.height, duration: row.duration, peaks,
    url: signMedia(row.id),
    thumbUrl: row.thumb_path ? signMedia(row.id, 7 * 24 * 3600 * 1000, 'thumb') : null,
    createdAt: row.created_at,
  };
}

/** Мои загрузки (файлы, которые ещё можно отправить повторно). */
mediaRouter.get('/mine', requireAuth, wrap((req, res) => {
  const rows = media.byOwner.all(req.user.id);
  res.json({ media: rows.map(dtoWithThumb) });
}));

/** Ограничения и допустимые типы — клиент использует их для валидации до отправки. */
mediaRouter.get('/limits', wrap((req, res) => {
  res.json({
    limits: LIMITS,
    accepted: {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      video: ['video/mp4', 'video/webm'],
      voice: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav'],
      file: ['*'],
    },
    blockedExtensions: ['exe', 'bat', 'cmd', 'sh', 'js', 'html', 'svg', 'msi', 'ps1'],
  });
}));

/** Метаданные одного медиа. */
mediaRouter.get('/:id', requireAuth, wrap((req, res) => {
  const id = validate.id(req.params.id);
  if (id.error) throw badRequest(id.error);
  const row = media.byId.get(id.value);
  if (!row || row.owner_id !== req.user.id) throw notFound('Файл не найден');
  res.json({ media: dtoWithThumb(row) });
}));

export default mediaRouter;
