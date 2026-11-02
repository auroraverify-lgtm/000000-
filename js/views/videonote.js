/**
 * Запись видеокружков (круглых видеосообщений): камера + микрофон, квадратный кадр 480×480.
 * Самодостаточный модуль — не зависит от остального приложения.
 * Файл называется circle-<время>.<ext>: по этому префиксу чат узнаёт, что видео нужно показать кружком.
 */
export const CIRCLE_PREFIX = 'circle-';
export const CIRCLE_MAX_SECONDS = 60;

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export class VideoNoteRecorder {
  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
  }

  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.timer = null;
    this.mime = '';
    this.cancelled = false;
  }

  /** Открывает камеру и показывает превью (без записи). */
  async openCamera(facingMode = 'user') {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 640 }, aspectRatio: { ideal: 1 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return this.stream;
  }

  /** Начинает запись. onTick(секунды) вызывается каждые 100 мс. */
  start({ onTick, onLimit } = {}) {
    if (!this.stream) throw new Error('Камера не открыта');
    this.mime = pickMime();
    const options = { videoBitsPerSecond: 900_000, audioBitsPerSecond: 64_000 };
    if (this.mime) options.mimeType = this.mime;
    this.recorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.timer = setInterval(() => {
      const elapsed = (performance.now() - this.startedAt) / 1000;
      onTick?.(elapsed);
      if (elapsed >= CIRCLE_MAX_SECONDS) onLimit?.();
    }, 100);
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  /** Останавливает запись и возвращает { file, duration, width, height }. */
  stop() {
    return new Promise((resolve, reject) => {
      clearInterval(this.timer);
      const recorder = this.recorder;
      if (!recorder || recorder.state === 'inactive') { this.release(); return reject(new Error('Запись не идёт')); }
      const duration = this.elapsed;
      recorder.onstop = () => {
        const type = (this.mime || recorder.mimeType || 'video/webm').split(';')[0];
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type });
        const settings = this.stream?.getVideoTracks()[0]?.getSettings?.() || {};
        const size = Math.min(settings.width || 480, settings.height || 480);
        this.release();
        if (this.cancelled) return reject(new Error('cancelled'));
        resolve({
          file: new File([blob], `${CIRCLE_PREFIX}${Date.now()}.${ext}`, { type }),
          duration, width: size, height: size,
        });
      };
      recorder.stop();
    });
  }

  cancel() {
    this.cancelled = true;
    clearInterval(this.timer);
    try { if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); } catch { /* ignore */ }
    this.release();
  }

  release() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Определяет, что видео-сообщение — кружок. */
export function isCircleMedia(media) {
  if (!media) return false;
  return String(media.filename || '').startsWith(CIRCLE_PREFIX);
}
