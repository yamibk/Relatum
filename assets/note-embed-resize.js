const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));

function boxSizeOnDrag(event, entry, initial) {
  const { host, stage, controls } = entry;
  const startWidth = host.offsetWidth, startHeight = stage.offsetHeight;
  const { minWidth, maxWidth, minHeight, maxHeight } = controls.limits;
  const column = host.parentElement, style = getComputedStyle(column);
  const available = Math.floor(column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const widthLimit = Math.min(maxWidth, available);
  return position => {
    const dx = position.clientX - event.clientX, dy = position.clientY - event.clientY;
    const width = clamp(startWidth + dx, minWidth, widthLimit);
    return {
      ...initial,
      width: widthLimit >= minWidth && Math.abs(dx) >= 3 && width !== startWidth ? width : initial.width,
      height: Math.abs(dy) >= 3 ? clamp(startHeight + dy, minHeight, maxHeight) : initial.height,
    };
  };
}

export function startEmbedResize(event, entry, present, zooming = false) {
  if (event.button !== 0 || !event.isPrimary || !present(entry) || entry.cancelResize) return;
  const { host, controls } = entry;
  const commit = controls.resize();
  if (!commit) return;
  const grip = event.currentTarget;
  event.preventDefault();
  event.stopPropagation();
  if (zooming) grip.focus({ preventScroll: true });
  const initial = controls.getSize();
  const { minZoom, maxZoom } = controls.limits;
  const dragClass = zooming ? 'is-zooming' : 'is-resizing';
  const sizeAt = zooming
    ? position => ({ ...initial, zoom: clamp(initial.zoom + (position.clientX - event.clientX) / 3, minZoom, maxZoom) })
    : boxSizeOnDrag(event, entry, initial);
  const pointer = event.pointerId;
  const listeners = new AbortController(), { signal } = listeners;
  let size = initial, frameId = 0;

  const paint = value => {
    if (zooming) {
      host.style.setProperty('--note-html-scale', String(value.zoom / 100));
      grip.setAttribute('aria-valuenow', String(value.zoom));
      return;
    }
    host.style.setProperty('--note-html-width', value.width === null ? '100%' : value.width + 'px');
    host.style.setProperty('--note-html-height', value.height + 'px');
    entry.onLayout?.();
  };
  const finish = accept => {
    if (!entry.cancelResize) return;
    entry.cancelResize = null;
    listeners.abort();
    if (frameId) cancelAnimationFrame(frameId);
    if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
    host.classList.remove(dragClass);
    if (accept && present(entry) && commit(size)) paint(size);
    else paint(controls.getSize());
  };
  entry.cancelResize = () => finish(false);
  host.classList.add(dragClass);
  grip.addEventListener('pointermove', position => {
    if (position.pointerId !== pointer) return;
    size = sizeAt(position);
    if (!frameId) frameId = requestAnimationFrame(() => { frameId = 0; paint(size); });
  }, { signal });
  grip.addEventListener('pointerup', position => {
    if (position.pointerId !== pointer) return;
    size = sizeAt(position);
    finish(true);
  }, { signal });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    grip.addEventListener(type, position => { if (position.pointerId === pointer) finish(false); }, { signal });
  }
  for (const type of ['blur', 'resize']) window.addEventListener(type, entry.cancelResize, { signal });
  if (zooming) grip.addEventListener('blur', entry.cancelResize, { signal });
  window.addEventListener('keydown', key => {
    if (key.key !== 'Escape') return;
    key.preventDefault(); key.stopPropagation(); finish(false);
  }, { signal, capture: true });
  try { grip.setPointerCapture(pointer); } catch (_error) { finish(false); }
}
