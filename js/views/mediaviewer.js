/**
 * Полноэкранный просмотр медиа: плавное «раскрытие» из миниатюры, зум (в т.ч. колесом и жестами),
 * пролистывание, видео-плеер, скачивание, переход к сообщению.
 */
import { $, el, esc, html, raw, formatRichText, clamp, fmtTime, haptic } from '../util.js';
import { icons } from '../icons.js';
import { state, bus } from '../store.js';
import { avatarHTML } from '../ui.js?v=20261029-no-toasts-1';
import { mediaDownloadUrl } from '../media.js?v=20261028-ux-1';

let viewer = null; // { root, items, index, scale, offset, zoomed }

export function openMediaViewer(messageId, mediaIndex = 0) {
  const mediaItems = state.messages.flatMap((message) => {
    const attachments = message.mediaItems?.length ? message.mediaItems : message.media ? [message.media] : [];
    return attachments.flatMap((media, index) => (
      ['image', 'video'].includes(media.kind) || ['photo', 'video'].includes(message.type)
        ? [{
          id: message.id,
          chatId: message.chatId,
          senderId: message.senderId,
          createdAt: message.createdAt,
          text: message.text || '',
          mediaIndex: index,
          type: media.kind === 'video' || message.type === 'video' ? 'video' : 'photo',
          media,
        }]
        : []
    ));
  });
  const index = mediaItems.findIndex((item) => item.id === messageId && item.mediaIndex === mediaIndex);
  if (index === -1) return;
  show(mediaItems, index);
}

export function openMediaList(items, index = 0) {
  const mapped = items.map((it) => ({
    id: it.messageId || it.id,
    type: it.kind === 'video' ? 'video' : 'photo',
    media: { url: it.url, thumbUrl: it.thumbUrl || it.url, width: it.width, height: it.height, duration: it.duration, filename: it.filename },
    text: it.caption || '',
    createdAt: it.createdAt,
    senderId: it.senderId,
    chatId: it.chatId,
    mediaIndex: it.mediaIndex || 0,
  }));
  if (!mapped.length) return;
  show(mapped, index);
}

function show(items, index) {
  closeViewer();
  const startRect = currentThumbRect(items[index]?.id, items[index]?.mediaIndex || 0);
  const root = el('div', {
    class: 'viewer',
    style: `position:fixed;inset:0;z-index:150;background:color-mix(in srgb, #05060c 92%, transparent);backdrop-filter:blur(18px);display:flex;flex-direction:column;animation:fade-in .2s`,
  });
  document.getElementById('overlays').append(root);
  viewer = { root, items, index, scale: 1, tx: 0, ty: 0, zoomed: false, startRect };
  renderViewer();
  document.body.style.overflow = 'hidden';
  bindViewerKeys();
}

export function closeViewer() {
  if (!viewer) return;
  const { root } = viewer;
  viewer = null;
  root.style.animation = 'fade-out .16s forwards';
  setTimeout(() => root.remove(), 170);
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKeydown, true);
}

function currentThumbRect(id, mediaIndex = 0) {
  const node = document.querySelector(
    `[data-photo="${id}"][data-media-index="${mediaIndex}"] img, [data-video="${id}"][data-media-index="${mediaIndex}"] video, [data-photo="${id}"] img, [data-video="${id}"] video`,
  );
  return node?.getBoundingClientRect() || null;
}

function renderViewer() {
  const { items, index } = viewer;
  const item = items[index];
  const media = item.media;
  const sender = (state.membersByChat[item.chatId] || state.membersByChat[state.chat?.chat.id] || []).find((m) => m.id === item.senderId);
  const isVideo = item.type === 'video';
  const protectedContent = !!state.chat?.chat?.protectedContent;

  viewer.root.innerHTML = html`
    <header class="row-between" style="padding:calc(12px + var(--safe-t)) 14px 8px;gap:12px;color:#fff">
      <div class="row gap-3" style="min-width:0">
        ${sender ? raw(avatarHTML({ name: sender.name, avatarUrl: sender.avatarUrl, color: sender.avatarColor, size: 'sm' })) : ''}
        <div class="col" style="min-width:0">
          <span class="bold truncate">${sender ? sender.name : 'Медиа'}</span>
          <span class="tiny" style="opacity:.7">${fmtTime(item.createdAt)}${media.width ? ` · ${media.width}×${media.height}` : ''}</span>
        </div>
      </div>
      <div class="row gap-1">
        <button class="icon-btn" data-zoom-out style="color:#fff" aria-label="Уменьшить">${raw(icons.zoomOut)}</button>
        <button class="icon-btn" data-zoom-in style="color:#fff" aria-label="Увеличить">${raw(icons.zoomIn)}</button>
        ${protectedContent ? '' : html`<a class="icon-btn" href="${esc(mediaDownloadUrl(media.url))}" download="${esc(media.filename || 'aurora-media')}" style="color:#fff" aria-label="Скачать">${raw(icons.download)}</a>`}
        <button class="icon-btn" data-close style="color:#fff" aria-label="Закрыть">${raw(icons.close)}</button>
      </div>
    </header>

    <div class="viewer-stage" style="flex:1;min-height:0;position:relative;display:grid;place-items:center;overflow:hidden;touch-action:pan-y">
      ${isVideo ? html`<video class="viewer-media" src="${esc(media.url)}" poster="${esc(media.thumbUrl || '')}" controls autoplay playsinline
          style="max-width:min(96vw,1400px);max-height:78vh;border-radius:14px;background:#000;box-shadow:0 30px 80px rgba(0,0,0,.6)"></video>`
    : html`<img class="viewer-media" src="${esc(media.url)}" alt="${esc(media.filename || 'Фото')}" style="max-width:96vw;max-height:min(78vh,100%);object-fit:contain;border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.55);transition:transform .18s var(--ease-out)">`}
      ${items.length > 1 ? html`
        <button class="icon-btn" data-prev style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#fff;background:rgba(255,255,255,.12);width:46px;height:46px" aria-label="Предыдущее">${raw(icons.back)}</button>
        <button class="icon-btn" data-next style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#fff;background:rgba(255,255,255,.12);width:46px;height:46px" aria-label="Следующее">${raw(icons.chevronRight)}</button>` : ''}
    </div>

    <footer style="padding:10px 16px calc(16px + var(--safe-b));color:#fff">
      ${item.text ? html`<p style="max-width:900px;margin:0 auto 10px;text-align:center;opacity:.92">${raw(formatRichText(item.text))}</p>` : ''}
      <div class="row center gap-3">
        <span class="tiny" style="opacity:.7">${index + 1} из ${items.length}</span>
        <button class="btn btn-sm" data-goto style="background:rgba(255,255,255,.14);color:#fff">К сообщению</button>
        ${protectedContent ? html`<span class="tiny" style="opacity:.65">Скачивание запрещено владельцем</span>` : ''}
      </div>
    </footer>`;

  // Плавное «раскрытие» из миниатюры (FLIP-анимация)
  const media_el = $('.viewer-media', viewer.root);
  if (viewer.startRect && media_el && !isVideo) {
    const rect = media_el.getBoundingClientRect();
    const sx = viewer.startRect.width / rect.width;
    const sy = viewer.startRect.height / rect.height;
    const dx = viewer.startRect.left + viewer.startRect.width / 2 - (rect.left + rect.width / 2);
    const dy = viewer.startRect.top + viewer.startRect.height / 2 - (rect.top + rect.height / 2);
    media_el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    media_el.style.transition = 'none';
    requestAnimationFrame(() => {
      media_el.style.transition = 'transform .34s var(--ease-out)';
      media_el.style.transform = '';
    });
  }

  bindViewerControls();
}

function bindViewerControls() {
  const root = viewer.root;
  root.querySelector('[data-close]').addEventListener('click', closeViewer);
  root.querySelector('[data-prev]')?.addEventListener('click', () => step(-1));
  root.querySelector('[data-next]')?.addEventListener('click', () => step(1));
  root.querySelector('[data-goto]')?.addEventListener('click', () => {
    const id = viewer.items[viewer.index].id;
    closeViewer();
    bus.emit('message:focus', id);
    import('./conversation.js').then((m) => m.scrollToMessage(id)).catch(() => {});
  });
  root.querySelector('[data-zoom-in]')?.addEventListener('click', () => zoom(1.25));
  root.querySelector('[data-zoom-out]')?.addEventListener('click', () => zoom(0.8));

  const media_el = $('.viewer-media', root);
  if (media_el && media_el.tagName === 'IMG') {
    // Зум колесом + перетаскивание при увеличении
    let dragging = false; let start = null;
    media_el.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });

    media_el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (viewer.zoomed) resetZoom(); else zoom(2, e.clientX, e.clientY);
    });

    media_el.addEventListener('pointerdown', (e) => {
      if (!viewer.zoomed) return;
      dragging = true;
      start = { x: e.clientX - viewer.tx, y: e.clientY - viewer.ty };
      media_el.setPointerCapture(e.pointerId);
      media_el.style.cursor = 'grabbing';
    });
    media_el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      viewer.tx = e.clientX - start.x;
      viewer.ty = e.clientY - start.y;
      applyTransform(media_el);
    });
    ['pointerup', 'pointercancel'].forEach((ev) => media_el.addEventListener(ev, () => {
      dragging = false;
      media_el.style.cursor = viewer.zoomed ? 'grab' : 'zoom-in';
    }));
    media_el.style.cursor = 'zoom-in';
  }

  // Свайпы по сцене: листание и закрытие
  const stage = $('.viewer-stage', root);
  let touch = null;
  stage.addEventListener('pointerdown', (e) => { if (e.target === stage || e.target.classList.contains('viewer-media')) touch = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false }; });
  stage.addEventListener('pointermove', (e) => {
    if (!touch) return;
    if (Math.abs(e.clientX - touch.x) > 8 || Math.abs(e.clientY - touch.y) > 8) touch.moved = true;
  });
  stage.addEventListener('pointerup', (e) => {
    if (!touch) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    const dt = Date.now() - touch.t;
    if (!viewer.zoomed && Math.abs(dx) > 70 && Math.abs(dy) < 90) { step(dx < 0 ? 1 : -1); haptic(8); }
    else if (dy > 120 && Math.abs(dx) < 80) { closeViewer(); haptic(8); }
    else if (!touch.moved && dt < 260 && e.target === stage) closeViewer();
    touch = null;
  });
}

function zoom(factor, cx = null, cy = null) {
  const media_el = $('.viewer-media', viewer.root);
  if (!media_el) return;
  const rect = media_el.getBoundingClientRect();
  const px = cx ?? rect.left + rect.width / 2;
  const py = cy ?? rect.top + rect.height / 2;
  const next = clamp(viewer.scale * factor, 1, 6);
  if (next === viewer.scale) return;
  // Сохраняем точку под курсором неподвижной
  const k = next / viewer.scale;
  viewer.tx = (viewer.tx + (rect.left + rect.width / 2 - px)) * 1 - (rect.left + rect.width / 2 - px) * k + viewer.tx * (k - 1);
  viewer.ty = (viewer.ty + (rect.top + rect.height / 2 - py)) * 1 - (rect.top + rect.height / 2 - py) * k + viewer.ty * (k - 1);
  viewer.scale = next;
  viewer.zoomed = next > 1.02;
  applyTransform(media_el);
}

function resetZoom() {
  const media_el = $('.viewer-media', viewer.root);
  viewer.scale = 1; viewer.tx = 0; viewer.ty = 0; viewer.zoomed = false;
  applyTransform(media_el);
}

function applyTransform(media_el) {
  media_el.style.transition = 'transform .12s var(--ease-out)';
  media_el.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.scale})`;
}

function step(delta) {
  const next = viewer.index + delta;
  if (next < 0 || next >= viewer.items.length) return;
  const media_el = $('.viewer-media', viewer.root);
  const dir = delta > 0 ? 1 : -1;
  if (media_el) {
    media_el.style.transition = 'transform .18s var(--ease-in-out), opacity .18s';
    media_el.style.transform = `translateX(${-dir * 60}px)`;
    media_el.style.opacity = '0';
  }
  setTimeout(() => { viewer.index = next; viewer.scale = 1; viewer.tx = 0; viewer.ty = 0; viewer.zoomed = false; renderViewer(); }, 170);
}

function onKeydown(e) {
  if (!viewer) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); }
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === '+' || e.key === '=') zoom(1.25);
  if (e.key === '-') zoom(0.8);
  if (e.key === '0') resetZoom();
}

function bindViewerKeys() {
  document.addEventListener('keydown', onKeydown, true);
}
