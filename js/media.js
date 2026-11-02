/**
 * Клиентская работа с медиа:
 *  · сжатие изображений перед отправкой (экономия трафика);
 *  · генерация превью (в т.ч. кадра видео) для мгновенного отображения;
 *  · запись голосовых сообщений с живой визуализацией и пиками waveform;
 *  · единый проигрыватель голосовых (пауза, скорость, перемотка по дорожке).
 */
import { clamp, el, raw } from './util.js';
import { bus } from './store.js';
import { modal } from './ui.js?v=20261029-no-toasts-1';

export function mediaDownloadUrl(url) {
  const parsed = new URL(url, location.origin);
  parsed.searchParams.set('download', '1');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/* ── Изображения ─────────────────────────────────────────────────────────── */

export function cropImage(file, { aspectRatio = 1, title = 'Обрезать фото', subtitle = '' } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const sourceUrl = URL.createObjectURL(file);
    let cropModal;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(sourceUrl);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error('Не удалось открыть это изображение'));
    };
    image.onload = () => {
      const width = aspectRatio >= 1 ? 480 : Math.round(480 * aspectRatio);
      const height = Math.round(width / aspectRatio);
      const canvas = el('canvas', {
        class: 'image-crop-canvas',
        width,
        height,
        style: `--crop-ratio:${aspectRatio}`,
        'aria-label': 'Область обрезки изображения',
      });
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(sourceUrl);
        reject(new Error('Браузер не смог подготовить область обрезки'));
        return;
      }

      const zoom = el('input', {
        class: 'pf-crop-zoom',
        type: 'range',
        min: '1',
        max: '3',
        step: '0.01',
        value: '1',
        'aria-label': 'Масштаб изображения',
      });
      const body = el('div', { class: 'image-crop' },
        canvas,
        el('label', { class: 'field pf-crop-control' },
          el('span', { class: 'field-label' }, 'Масштаб'),
          zoom),
        el('p', { class: 'muted small pf-crop-hint' },
          'Перетащите изображение, чтобы выбрать область. Масштаб меняется ползунком.'));
      const baseScale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      let scale = baseScale;
      let offsetX = 0;
      let offsetY = 0;
      let drag = null;

      const clampOffset = () => {
        const imageWidth = image.naturalWidth * scale;
        const imageHeight = image.naturalHeight * scale;
        offsetX = Math.max((width - imageWidth) / 2, Math.min((imageWidth - width) / 2, offsetX));
        offsetY = Math.max((height - imageHeight) / 2, Math.min((imageHeight - height) / 2, offsetY));
      };
      const draw = () => {
        const imageWidth = image.naturalWidth * scale;
        const imageHeight = image.naturalHeight * scale;
        context.clearRect(0, 0, width, height);
        context.drawImage(image, (width - imageWidth) / 2 + offsetX,
          (height - imageHeight) / 2 + offsetY, imageWidth, imageHeight);
      };
      zoom.addEventListener('input', () => {
        const nextScale = baseScale * Number(zoom.value);
        const zoomFactor = nextScale / scale;
        offsetX *= zoomFactor;
        offsetY *= zoomFactor;
        scale = nextScale;
        clampOffset();
        draw();
      });
      canvas.addEventListener('pointerdown', (event) => {
        drag = { x: event.clientX, y: event.clientY, offsetX, offsetY };
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const bounds = canvas.getBoundingClientRect();
        offsetX = drag.offsetX + (event.clientX - drag.x) * (width / bounds.width);
        offsetY = drag.offsetY + (event.clientY - drag.y) * (height / bounds.height);
        clampOffset();
        draw();
      });
      canvas.addEventListener('pointerup', () => { drag = null; });
      canvas.addEventListener('pointercancel', () => { drag = null; });
      draw();

      const cancel = el('button', {
        class: 'btn',
        type: 'button',
        onClick: () => cropModal.close(null),
      }, 'Отмена');
      const apply = el('button', {
        class: 'btn btn-primary',
        type: 'button',
        onClick: () => {
          apply.disabled = true;
          const output = document.createElement('canvas');
          output.width = aspectRatio >= 1 ? 1600 : 512;
          output.height = Math.round(output.width / aspectRatio);
          const outputContext = output.getContext('2d');
          if (!outputContext) {
            apply.disabled = false;
            reject(new Error('Браузер не смог обработать изображение'));
            cropModal.close(null);
            return;
          }
          const left = (width - image.naturalWidth * scale) / 2 + offsetX;
          const top = (height - image.naturalHeight * scale) / 2 + offsetY;
          outputContext.drawImage(image, -left / scale, -top / scale,
            width / scale, height / scale, 0, 0, output.width, output.height);
          output.toBlob((blob) => {
            if (!blob) {
              apply.disabled = false;
              reject(new Error('Не удалось обработать изображение'));
              cropModal.close(null);
              return;
            }
            const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
            cropModal.close(new File([blob], `${baseName}.webp`, { type: blob.type || 'image/webp' }));
          }, 'image/webp', 0.9);
        },
      }, 'Использовать фото');
      cropModal = modal({
        title,
        subtitle,
        body,
        footer: [cancel, apply],
        onClose: finish,
      });
    };
    image.src = sourceUrl;
  });
}

export async function compressImage(file, { maxDim = 2560, quality = 0.86 } = {}) {
  if (!file.type.startsWith('image/')) return { file, width: null, height: null };
  if (file.type === 'image/gif') return { file, width: null, height: null }; // анимацию не пережимаем
  try {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return { file, width: null, height: null };
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', quality));
    if (!blob || blob.size >= file.size * 1.05) return { file, width: bitmap.width, height: bitmap.height };
    return {
      file: new File([blob], renameExt(file.name, 'webp'), { type: 'image/webp' }),
      width, height,
    };
  } catch {
    return { file, width: null, height: null };
  }
}

export async function makeThumb(blob, { maxDim = 480, quality = 0.72 } = {}) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  } catch { return null; }
}

const renameExt = (name, ext) => String(name || 'image').replace(/\.[^.]+$/, '') + '.' + ext;

/** Метаданные видео + постер (первый кадр), чтобы в ленте сразу был превью-кадр. */
export function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const done = async (extra = {}) => {
      URL.revokeObjectURL(url);
      resolve({ duration: video.duration || 0, width: video.videoWidth, height: video.videoHeight, ...extra });
    };
    video.onloadeddata = async () => {
      try {
        video.currentTime = Math.min(0.2, (video.duration || 1) / 3);
        await new Promise((r) => { video.onseeked = r; setTimeout(r, 900); });
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth || 1, 1));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const poster = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.7));
        done({ poster });
      } catch { done(); }
    };
    video.onerror = () => done();
    setTimeout(() => done(), 8000);
    video.src = url;
  });
}

/* ── Запись голосовых ────────────────────────────────────────────────────── */

const pickMime = () => {
  const variants = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac'];
  for (const v of variants) if (window.MediaRecorder?.isTypeSupported?.(v)) return v;
  return '';
};

export class VoiceRecorder {
  constructor() {
    this.chunks = [];
    this.levels = [];
    this.startedAt = 0;
    this.timer = null;
    this.analyser = null;
    this.audioCtx = null;
    this.raf = null;
  }

  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  async start({ onLevel, onTick } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.stream = stream;
    this.chunks = [];
    this.levels = [];
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.recorder.start(250);
    this.startedAt = Date.now();
    this.pausedMs = 0;

    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this.buffer = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        this.analyser.getByteTimeDomainData(this.buffer);
        let sum = 0;
        for (let i = 0; i < this.buffer.length; i++) { const v = (this.buffer[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / this.buffer.length);
        const level = clamp(rms * 3.4, 0, 1);
        this.levels.push(level);
        onLevel?.(level);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* живые уровни недоступны — запись продолжается */ }

    this.timer = setInterval(() => onTick?.(this.elapsed()), 200);
  }

  elapsed() { return Math.max(0, (Date.now() - this.startedAt - (this.pausedMs || 0)) / 1000); }

  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pauseStarted = Date.now();
    }
  }

  resume() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.pausedMs += Date.now() - (this.pauseStarted || Date.now());
    }
  }

  get paused() { return this.recorder?.state === 'paused'; }

  /** Завершение записи → файл, длительность и «пики» для дорожки. */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') return resolve(null);
      const duration = this.elapsed();
      this.recorder.onstop = async () => {
        const type = this.recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        if (!blob.size) return resolve(null);
        const peaks = reducePeaks(this.levels, 56);
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        resolve({
          file: new File([blob], `voice-${Date.now()}.${ext}`, { type }),
          duration,
          peaks,
        });
      };
      try { this.recorder.stop(); } catch { resolve(null); }
    });
  }

  cancel() {
    try { if (this.recorder && this.recorder.state !== 'inactive') { this.recorder.onstop = null; this.recorder.stop(); } } catch { /* noop */ }
    this.cleanup();
  }

  cleanup() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    try { this.audioCtx?.close(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}

export function reducePeaks(levels, count = 48) {
  if (!levels?.length) return Array.from({ length: count }, (_, i) => 0.25 + 0.25 * Math.sin(i / 2));
  const step = levels.length / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const slice = levels.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    out.push(clamp(Number(avg.toFixed(3)), 0.08, 1));
  }
  return out;
}

/* ── Проигрыватель голосовых (один активный трек) ────────────────────────── */

export class VoicePlayer {
  static instance = null;
  static rates = [1, 1.5, 2];

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.currentId = null;
    this.rateIdx = 0;
    this.audio.addEventListener('timeupdate', () => bus.emit('voice:progress', this.snapshot()));
    this.audio.addEventListener('ended', () => { this.playing = false; bus.emit('voice:ended', { id: this.currentId }); });
    this.audio.addEventListener('pause', () => { this.playing = false; bus.emit('voice:progress', this.snapshot()); });
    this.audio.addEventListener('play', () => { this.playing = true; bus.emit('voice:progress', this.snapshot()); });
  }

  static get() {
    if (!VoicePlayer.instance) VoicePlayer.instance = new VoicePlayer();
    return VoicePlayer.instance;
  }

  snapshot() {
    return {
      id: this.currentId,
      playing: this.playing,
      current: this.audio.currentTime || 0,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : null,
      rate: this.audio.playbackRate || 1,
    };
  }

  async toggle(id, url) {
    if (this.currentId === id) {
      if (this.playing) this.audio.pause(); else await this.audio.play().catch(() => {});
      return this.snapshot();
    }
    this.audio.pause();
    this.currentId = id;
    this.audio.src = url;
    this.audio.playbackRate = VoicePlayer.rates[this.rateIdx];
    try { await this.audio.play(); } catch { /* автозапуск запрещён — пользователь нажмёт ещё раз */ }
    return this.snapshot();
  }

  seek(ratio) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = clamp(ratio, 0, 1) * this.audio.duration;
    bus.emit('voice:progress', this.snapshot());
  }

  cycleRate() {
    this.rateIdx = (this.rateIdx + 1) % VoicePlayer.rates.length;
    this.audio.playbackRate = VoicePlayer.rates[this.rateIdx];
    bus.emit('voice:progress', this.snapshot());
    return VoicePlayer.rates[this.rateIdx];
  }

  stop() { this.audio.pause(); this.currentId = null; this.playing = false; }
}

/* ── Рендер waveform ─────────────────────────────────────────────────────── */

export function waveformHTML(peaks, seed = 1) {
  const bars = peaks?.length ? peaks : Array.from({ length: 48 }, (_, i) => 0.3 + 0.4 * Math.abs(Math.sin((i + seed) / 3)));
  return raw(bars.map((p, i) => {
    const h = Math.round(6 + clamp(p, 0, 1) * 22);
    return `<i data-i="${i}" style="height:${h}px"></i>`;
  }).join(''));
}

/** Определение вида файла по MIME/расширению — для корректной отправки и иконки. */
export function classifyFile(file) {
  const type = file.type || '';
  const name = file.name || '';
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'file';
  const ext = name.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic'].includes(ext)) return 'photo';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
  return 'file';
}

export const fileIconName = (mime = '', name = '') => {
  const ext = name.split('.').pop()?.toLowerCase();
  if (mime.startsWith('image/') || ['jpg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return 'volume';
  if (ext === 'pdf') return 'file';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return 'archive';
  return 'file';
};
