/** A DOM scene with one camera. Gestures only preview until pointer-up. */
import { createContentRenderer } from './content.js';

export function createCanvas(host, { select, move, remove, active, visible, create, edit }) {
  const scene = host.querySelector('.research-scene');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const cards = new Map();
  const camera = { x: 40, y: 40, scale: 1 };
  let gesture = null;
  const content = createContentRenderer(() => visible() && !host.hidden);
  const transform = () => { scene.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`; };
  const world = (x, y) => {
    const box = host.getBoundingClientRect();
    return { x: (x - box.left - camera.x) / camera.scale, y: (y - box.top - camera.y) / camera.scale };
  };
  function cancel() {
    if (!gesture) return;
    if (gesture.card) {
      gesture.card.style.left = `${gesture.x}px`; gesture.card.style.top = `${gesture.y}px`;
    } else { camera.x = gesture.x; camera.y = gesture.y; transform(); }
    const pointerId = gesture.pointerId; gesture = null;
    if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId);
  }
  host.addEventListener('pointerdown', event => {
    if (!active() || ![0, 1].includes(event.button) || gesture) return;
    const card = event.button === 0 ? event.target.closest('[data-representation]') : null;
    if (event.target.closest('button')) return;
    event.preventDefault(); host.focus({ preventScroll: true });
    if (card) select(card.dataset.object, card.dataset.representation);
    else select(null, null);
    gesture = { pointerId: event.pointerId, card, startX: event.clientX, startY: event.clientY,
      x: card ? parseFloat(card.style.left) : camera.x, y: card ? parseFloat(card.style.top) : camera.y };
    host.setPointerCapture(event.pointerId);
  }, options);
  host.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.card) {
      gesture.card.style.left = `${gesture.x + dx / camera.scale}px`;
      gesture.card.style.top = `${gesture.y + dy / camera.scale}px`;
    } else { camera.x = gesture.x + dx; camera.y = gesture.y + dy; transform(); }
  }, options);
  host.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const ended = gesture; gesture = null;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (ended.card) move(ended.card.dataset.representation, parseFloat(ended.card.style.left), parseFloat(ended.card.style.top));
  }, options);
  host.addEventListener('lostpointercapture', cancel, options);
  host.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', cancel, options);
  host.addEventListener('dblclick', event => {
    if (!active() || event.button !== 0) return;
    cancel();
    const card = event.target.closest('[data-representation]');
    if (card) { select(card.dataset.object, card.dataset.representation); edit(); }
    else create(world(event.clientX, event.clientY));
  }, options);
  host.addEventListener('keydown', event => {
    if (!active()) return;
    if (event.key === 'Escape') { cancel(); return; }
    if (event.key === 'Enter') { event.preventDefault(); edit(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
  }, options);
  host.addEventListener('wheel', event => {
    if (!active()) return;
    event.preventDefault(); if (gesture) return;
    if (event.ctrlKey || event.metaKey) {
      const anchor = world(event.clientX, event.clientY);
      const next = Math.min(3, Math.max(.25, camera.scale * Math.exp(-event.deltaY * .002)));
      camera.x += anchor.x * (camera.scale - next); camera.y += anchor.y * (camera.scale - next); camera.scale = next;
    } else { camera.x -= event.deltaX; camera.y -= event.deltaY; }
    transform();
  }, { ...options, passive: false });
  transform();
  return {
    center() {
      const box = host.getBoundingClientRect();
      const point = world(box.left + box.width / 2 - 140, box.top + box.height / 2 - 70);
      // Prefer an empty visible slot. Measure only when creating a representation, never on pan.
      const occupied = [...cards.values()].map(card => ({ x: parseFloat(card.style.left), y: parseFloat(card.style.top),
        width: card.offsetWidth, height: card.offsetHeight }));
      const topLeft = world(box.left + 20, box.top + 20);
      const width = box.width / camera.scale, height = box.height / camera.scale;
      const candidates = [point];
      for (let y = topLeft.y; y + 160 < topLeft.y + height; y += 210) {
        for (let x = topLeft.x; x + 280 < topLeft.x + width; x += 300) candidates.push({ x, y });
      }
      const free = candidates.find(pos => occupied.every(rect => pos.x + 290 < rect.x || pos.x > rect.x + rect.width + 10
        || pos.y + 170 < rect.y || pos.y > rect.y + rect.height + 10));
      if (free) return free;
      for (let n = 0; n <= occupied.length; n++) {
        const candidate = { x: point.x + n * 28, y: point.y + n * 28 };
        if (occupied.every(rect => Math.abs(rect.x - candidate.x) > 20 || Math.abs(rect.y - candidate.y) > 20)) return candidate;
      }
      return point;
    },
    home() { cancel(); Object.assign(camera, { x: 40, y: 40, scale: 1 }); transform(); },
    cancel,
    pause() { cancel(); content.cancel(); },
    render(project, selectedId, selectedRep) {
      const objects = new Map(project.objects.map(obj => [obj.id, obj]));
      const reps = project.views.find(view => view.id === 'view-main')?.representations || [];
      const live = new Set(reps.map(rep => rep.id));
      for (const [id, card] of cards) if (!live.has(id)) { card.remove(); cards.delete(id); }
      for (const rep of reps) {
        const obj = objects.get(rep.objectId); if (!obj) continue;
        let card = cards.get(rep.id);
        if (!card) {
          card = document.createElement('div'); card.className = 'research-card';
          card.dataset.representation = rep.id; card.dataset.object = obj.id;
          card.innerHTML = '<span class="research-card-type"></span><strong></strong><span class="research-card-label"></span><small></small><div class="research-card-content"></div>';
          scene.append(card); cards.set(rep.id, card);
        }
        card.style.left = `${rep.x}px`; card.style.top = `${rep.y}px`;
        card.classList.toggle('is-selected', selectedRep ? selectedRep === rep.id : selectedId === obj.id);
        card.style.zIndex = card.classList.contains('is-selected') ? '1' : '0';
        const draft = ['core.note', 'core.formula'].includes(obj.type) && obj.typeVersion === 1;
        card.classList.toggle('is-draft', draft);
        card.children[0].textContent = ({ 'core.variable': 'VARIABLE', 'core.note': 'NOTE', 'core.formula': 'FORMULA' })[obj.type] || obj.type;
        card.children[1].textContent = draft ? obj.payload.label : obj.payload.symbol || '—';
        card.children[2].textContent = draft ? '' : obj.payload.label || obj.id;
        card.children[3].textContent = draft ? '' : obj.payload.unit || '—';
        card.children[4].hidden = !draft;
        if (draft) content.render(card.children[4], obj);
      }
      host.querySelector('.research-canvas-empty').hidden = reps.length > 0;
    },
    dispose() { cancel(); content.cancel(); controller.abort(); cards.clear(); },
  };
}
