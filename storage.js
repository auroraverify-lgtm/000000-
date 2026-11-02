/**
 * Медиа-хранилище. Файлы ложатся на диск (не в БД), отдаются только по подписанной ссылке.
 * Абстракция: чтобы перейти на S3/подобное хранилище, достаточно заменить saveFile/streamFile.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { UPLOAD_DIR, UPLOAD_TEMP_DIR, LIMITS } from './config.js';
import { media, now } from './db.js';
import { sniff, extBlocked, signMedia } from './security.js';

const MAX_UPLOAD = Math.max(...Object.values(LIMITS));

/** Загрузка идёт во временный файл, чтобы большие вложения не занимали RAM целиком. */
export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_TEMP_DIR),
    filename: (_req, _file, callback) => callback(null, `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}.upload`),
  }),
  limits: { fileSize: MAX_UPLOAD, files: 2, fields: 20 },
});

function detectDimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
    if (mime === 'image/webp' && buf.length > 30 && buf.slice(12, 16).toString() === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* ignore */ }
  return {};
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

function storedPath(ext) {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const relative = path.join(String(d.getFullYear()), month, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  const absolute = path.join(UPLOAD_DIR, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return { relative, absolute };
}

function mediaKind(sniffed, hint, declaredMime) {
  let kind = sniffed.kind;
  if (hint === 'voice' && (kind === 'audio' || kind === 'file' ||
      (kind === 'video' && ['audio/mp4', 'audio/webm'].includes(declaredMime)))) {
    kind = 'voice';
    if (declaredMime === 'audio/mp4' || declaredMime === 'audio/webm') sniffed.mime = declaredMime;
  }
  return kind;
}

function insertMedia({ buffer, filePath, size, opts, filename, sniffed, kind, dims }) {
  const target = storedPath(sniffed.ext);
  if (filePath) fs.renameSync(filePath, target.absolute);
  else fs.writeFileSync(target.absolute, buffer);
  try {
    const info = media.create.run({
      owner_id: opts.ownerId,
      kind,
      filename,
      mime: sniffed.mime,
      size,
      width: opts.width || dims.width || null,
      height: opts.height || dims.height || null,
      duration: opts.duration ?? null,
      peaks: opts.peaks ? JSON.stringify(opts.peaks).slice(0, 6000) : null,
      path: target.relative,
      thumb_path: null,
      created_at: now(),
    });
    return media.byId.get(Number(info.lastInsertRowid));
  } catch (error) {
    fs.rmSync(target.absolute, { force: true });
    throw error;
  }
}

function readPrefix(filePath, maxBytes = 1024 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Проверяет и сохраняет файл. Возвращает запись media.
 * @param {Buffer} buffer
 * @param {object} opts { ownerId, declaredMime, filename, kindHint, duration, peaks, width, height }
 */
export function saveMedia(buffer, opts) {
  const filename = safeName(opts.filename);
  if (extBlocked(filename)) throw Object.assign(new Error('Файлы такого типа запрещены'), { status: 415 });

  const sniffed = sniff(buffer, opts.declaredMime || '', filename);
  const hint = opts.kindHint;
  const declaredMime = String(opts.declaredMime || '').split(';', 1)[0].trim().toLowerCase();
  const kind = mediaKind(sniffed, hint, declaredMime);
  const sizeLimitKind = hint === 'avatar' && kind === 'image' ? 'avatar' : kind;

  const limit = LIMITS[sizeLimitKind] || LIMITS.file;
  if (buffer.length > limit) throw Object.assign(new Error(`Превышен лимит размера для типа "${kind}" (${Math.round(limit / 1048576)} МБ)`), { status: 413 });

  const dims = kind === 'image' ? detectDimensions(buffer, sniffed.mime) : {};
  return insertMedia({ buffer, size: buffer.length, opts, filename, sniffed, kind, dims });
}

export function saveMediaFile(file, opts) {
  const filename = safeName(opts.filename);
  if (extBlocked(filename)) throw Object.assign(new Error('Файлы такого типа запрещены'), { status: 415 });
  const size = fs.statSync(file.path).size;
  const prefix = readPrefix(file.path);
  const sniffed = sniff(prefix, opts.declaredMime || '', filename);
  if (filename.toLowerCase().endsWith('.apk') && !(prefix[0] === 0x50 && prefix[1] === 0x4b)) {
    throw Object.assign(new Error('APK должен быть Android-пакетом в формате ZIP'), { status: 415 });
  }
  if (sniffed.kind === 'file' && filename.toLowerCase().endsWith('.apk')) {
    sniffed.mime = 'application/vnd.android.package-archive';
    sniffed.ext = 'apk';
  }
  const hint = opts.kindHint;
  const declaredMime = String(opts.declaredMime || '').split(';', 1)[0].trim().toLowerCase();
  const kind = mediaKind(sniffed, hint, declaredMime);
  const sizeLimitKind = hint === 'avatar' && kind === 'image' ? 'avatar' : kind;
  const limit = LIMITS[sizeLimitKind] || LIMITS.file;
  if (size > limit) throw Object.assign(new Error(`Превышен лимит размера для типа "${kind}" (${Math.round(limit / 1048576)} МБ)`), { status: 413 });
  const dims = kind === 'image' ? detectDimensions(prefix, sniffed.mime) : {};
  return insertMedia({ filePath: file.path, size, opts, filename, sniffed, kind, dims });
}

export function cleanupUploadedFiles(files) {
  for (const file of Object.values(files || {}).flat()) {
    if (!file.path) continue;
    try { fs.unlinkSync(file.path); } catch (error) {
      if (error.code !== 'ENOENT') console.error('Unable to remove staged upload:', file.path, error);
    }
  }
}

const ORIGINAL_NAME = new Map();

/** Публичное представление медиа: наружу отдаём только подписанные ссылки. */
export function mediaDTO(row) {
  if (!row) return null;
  let peaks = null;
  try { peaks = row.peaks ? JSON.parse(row.peaks) : null; } catch { peaks = null; }
  ORIGINAL_NAME.set(row.id, row.filename);
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    peaks,
    url: signMedia(row.id),
    thumbUrl: signMedia(row.id),
  };
}

export function mediaPath(row) {
  return path.join(UPLOAD_DIR, row.path);
}

/** Отдача файла с поддержкой Range (нужно для перемотки видео) и корректными заголовками. */
export function streamFile(req, res, row, { cacheControl = 'private, max-age=604800, immutable' } = {}) {
  const file = mediaPath(row);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Файл не найден' });
  const stat = fs.statSync(file);
  const inline = req.query.download !== '1'
    && (row.kind === 'image' || row.kind === 'video' || row.kind === 'audio' || row.kind === 'voice');
  const headers = {
    'Content-Type': row.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
      if (start >= stat.size) { res.status(416).set('Content-Range', `bytes */${stat.size}`).end(); return; }
      res.status(206).set({ ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.status(200).set({ ...headers, 'Content-Length': String(stat.size) });
  return fs.createReadStream(file).pipe(res);
}

export function removeMedia(row) {
  for (const file of [mediaPath(row), row.thumb_path ? path.join(UPLOAD_DIR, row.thumb_path) : null].filter(Boolean)) {
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
