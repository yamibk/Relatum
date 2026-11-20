let serial = 0;

export function wrapPdfScroll(view, copy, horizontal = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'note-pdf-scroll-shell';
  view.id ||= 'note-pdf-scroll-' + ++serial;
  wrapper.append(view);
  const lifetime = new AbortController(), { signal } = lifetime;
  let content, frame = 0;
  const axes = (horizontal ? ['y', 'x'] : ['y']).map(axis => {
    const vertical = axis === 'y';
    const offset = vertical ? 'scrollTop' : 'scrollLeft';
    const size = vertical ? 'Height' : 'Width';
    const rail = document.createElement('div'), thumb = document.createElement('span');
    rail.className = 'note-pdf-scroll-rail';
    rail.dataset.axis = axis;
    rail.hidden = true; rail.tabIndex = 0;
    rail.setAttribute('role', 'scrollbar');
    rail.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
    rail.setAttribute('aria-label', vertical ? copy('垂直滚动', 'Scroll vertically') : copy('水平滚动', 'Scroll horizontally'));
    rail.setAttribute('aria-controls', view.id);
    rail.setAttribute('aria-valuemin', '0'); rail.setAttribute('aria-valuemax', '100');
    rail.append(thumb); wrapper.append(rail);
    let drag, travel = 0, maximum = 0;
    const coordinate = event => vertical ? event.clientY : event.clientX;
    const begin = rect => vertical ? rect.top : rect.left;

    function paint() {
      const viewport = view['client' + size], total = view['scroll' + size];
      maximum = total - viewport;
      rail.hidden = viewport <= 0 || maximum < 1;
      if (rail.hidden) { cancel(); return; }
      const length = rail['client' + size];
      const thumbSize = Math.min(length, Math.max(28, length * viewport / total));
      travel = length - thumbSize;
      const fraction = Math.max(0, Math.min(1, view[offset] / maximum));
      thumb.style[vertical ? 'height' : 'width'] = thumbSize + 'px';
      thumb.style.transform = vertical ? 'translateY(' + (travel * fraction) + 'px)' : 'translateX(' + (travel * fraction) + 'px)';
      rail.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
    function move(event) {
      if (drag && drag.id === event.pointerId && travel > 0) {
        const position = coordinate(event) - begin(rail.getBoundingClientRect()) - drag.inset;
        view[offset] = position / travel * maximum;
      }
    }
    function cancel() {
      if (!drag) return;
      const { id } = drag;
      drag = null;
      rail.classList.remove('is-dragging');
      if (rail.hasPointerCapture(id)) rail.releasePointerCapture(id);
    }
    rail.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      paint();
      if (rail.hidden) return;
      event.preventDefault(); rail.focus({ preventScroll: true });
      const rect = thumb.getBoundingClientRect();
      const onThumb = event.target === thumb;
      drag = { id: event.pointerId, inset: onThumb ? coordinate(event) - begin(rect) : rect[size.toLowerCase()] / 2 };
      rail.classList.add('is-dragging');
      rail.setPointerCapture(event.pointerId);
      if (!onThumb) move(event);
    }, { signal });
    rail.addEventListener('pointermove', move, { signal });
    rail.addEventListener('pointerup', event => { move(event); cancel(); }, { signal });
    for (const name of ['pointercancel', 'lostpointercapture', 'blur']) rail.addEventListener(name, cancel, { signal });
    rail.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const actions = {
        Home: 0, End: maximum,
        PageUp: view[offset] - view['client' + size] * .9, PageDown: view[offset] + view['client' + size] * .9,
        [vertical ? 'ArrowUp' : 'ArrowLeft']: view[offset] - 40,
        [vertical ? 'ArrowDown' : 'ArrowRight']: view[offset] + 40,
      };
      if (!Object.hasOwn(actions, event.key)) return;
      event.preventDefault(); event.stopPropagation();
      view[offset] = actions[event.key];
    }, { signal });
    return { rail, paint, cancel };
  });
  function refresh() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; axes.forEach(axis => axis.paint()); });
  }
  const resize = new ResizeObserver(refresh);
  resize.observe(view);
  view.addEventListener('scroll', refresh, { signal, passive: true });
  return {
    wrapper, refresh,
    content(node) {
      if (content) resize.unobserve(content);
      content = node;
      if (content) resize.observe(content);
      refresh();
    },
    dispose() {
      axes.forEach(axis => axis.cancel());
      cancelAnimationFrame(frame); resize.disconnect(); lifetime.abort();
    },
  };
}
