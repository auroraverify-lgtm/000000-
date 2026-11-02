/**
 * Поведение экрана звонка:
 *  · своё видео (квадратик) можно перетаскивать — отпускаешь, и он «примагничивается» к ближайшему углу
 *  · нажатие на экран скрывает все кнопки и подписи, остаётся только видео; ещё раз — возвращает
 * Работает поверх разметки calls.js, ничего в ней не меняя.
 */
(() => {
  const M = 14; // отступ от краёв
  let corner = 'br';
  let drag = null;
  let suppressClick = false;

  const live = () => document.querySelector('.call-root:not(.call-minimized) .call-live');
  const isDuo = (grid) => grid && grid.querySelectorAll('.call-tile').length === 2;
  const pipOf = (card) => {
    const grid = card?.querySelector('.call-grid');
    return isDuo(grid) ? grid.querySelector('.call-tile.is-local') : null;
  };
  const safe = (side) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side},0px)`;
    document.body.append(probe);
    const v = parseFloat(getComputedStyle(probe)[`padding${side[0].toUpperCase()}${side.slice(1)}`]) || 0;
    probe.remove();
    return v;
  };

  /** Ставит окошко в выбранный угол с учётом верхней панели и кнопок. */
  function place(tile, animate) {
    const card = tile.closest('.call-live');
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = tile.offsetWidth;
    const h = tile.offsetHeight;
    const hidden = card.classList.contains('ui-hidden');
    const controls = card.querySelector('.call-controls');
    const topLimit = hidden ? Math.max(M, safe('top') + M) : Math.max(safe('top') + 78, 90);
    const bottomLimit = hidden || !controls ? H - Math.max(M, safe('bottom') + M) : controls.getBoundingClientRect().top - 14;
    const left = corner.includes('l') ? M : W - M - w;
    const top = corner.includes('t') ? topLimit : bottomLimit - h;
    tile.classList.toggle('pip-settle', !!animate);
    tile.style.right = 'auto';
    tile.style.bottom = 'auto';
    tile.style.left = `${left}px`;
    tile.style.top = `${Math.max(topLimit, top)}px`;
  }

  function toggleUi() {
    const card = live();
    if (!card) return;
    card.classList.toggle('ui-hidden');
    const tile = pipOf(card);
    if (tile) place(tile, true);
  }

  document.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest?.('.call-live .call-tile.is-local');
    if (!tile || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const card = tile.closest('.call-live');
    if (pipOf(card) !== tile) return; // в групповом звонке не двигаем
    const r = tile.getBoundingClientRect();
    drag = { tile, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    tile.classList.remove('pip-settle');
    tile.setPointerCapture?.(e.pointerId);
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.tile.classList.add('pip-dragging');
    const w = drag.tile.offsetWidth;
    const h = drag.tile.offsetHeight;
    drag.tile.style.right = 'auto';
    drag.tile.style.bottom = 'auto';
    drag.tile.style.left = `${Math.min(Math.max(drag.ox + dx, 6), window.innerWidth - w - 6)}px`;
    drag.tile.style.top = `${Math.min(Math.max(drag.oy + dy, 6), window.innerHeight - h - 6)}px`;
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { tile, moved } = drag;
    drag = null;
    tile.classList.remove('pip-dragging');
    if (!moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    const r = tile.getBoundingClientRect();
    corner = `${r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b'}${r.left + r.width / 2 < window.innerWidth / 2 ? 'l' : 'r'}`;
    place(tile, true); // плавно «примагничиваем» к углу
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // нажатие на пустое место экрана — скрыть/показать интерфейс
  document.addEventListener('click', (e) => {
    if (suppressClick) return;
    const card = e.target.closest?.('.call-root:not(.call-minimized) .call-live');
    if (!card) return;
    if (e.target.closest('button, a, input, .call-controls, .call-top > div')) return;
    toggleUi();
  });

  // после пересборки экрана звонка возвращаем окошко на своё место
  window.addEventListener('resize', () => {
    const tile = pipOf(live());
    if (tile && tile.style.left) place(tile, false);
  });
})();
