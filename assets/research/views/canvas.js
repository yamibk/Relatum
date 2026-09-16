/** A DOM scene with one camera. Gestures only preview until pointer-up. */
import { createContentRenderer } from './content.js';
import { branchIds, hiddenBranches } from '../core/tree.js';

export function createCanvas(host, { select, selectRelation, connect, connecting, cancelConnect, move, remove, active, visible, create, edit, branch }) {
  const scene = host.querySelector('.research-scene');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const cards = new Map();
  const sizes = new Map(), edges = new Map();
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('research-links'); scene.append(svg);
  let links = [], representations = [];
  const preview = document.createElementNS(svgNS, 'path'); preview.classList.add('research-link-preview'); svg.append(preview);
  const camera = { x: 40, y: 40, scale: 1 };
  let gesture = null;
  const content = createContentRenderer(() => visible() && !host.hidden);
  const transform = () => { scene.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`; };
  const world = (x, y) => {
    const box = host.getBoundingClientRect();
    return { x: (x - box.left - camera.x) / camera.scale, y: (y - box.top - camera.y) / camera.scale };
  };
  function drawLinks() {
    for (const link of links) {
      const group = edges.get(link.id), a = cards.get(link.sourceId), b = cards.get(link.targetId);
      if (!group || !a || !b) continue;
      const sa = sizes.get(link.sourceId) || { width: 180, height: 140 };
      const sb = sizes.get(link.targetId) || { width: 180, height: 140 };
      const ax = parseFloat(a.style.left) + sa.width / 2, ay = parseFloat(a.style.top) + sa.height / 2;
      const bx = parseFloat(b.style.left) + sb.width / 2, by = parseFloat(b.style.top) + sb.height / 2;
      const dx = bx - ax, dy = by - ay;
      const boundary = (w, h) => Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity, .5);
      const start = boundary(sa.width, sa.height), end = boundary(sb.width, sb.height);
      const d = `M ${ax + dx * start} ${ay + dy * start} L ${bx - dx * end} ${by - dy * end}`;
      for (const path of group.querySelectorAll('path')) path.setAttribute('d', d);
      const text = group.querySelector('text'); text.setAttribute('x', (ax + bx) / 2); text.setAttribute('y', (ay + by) / 2 - 8);
    }
  }
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) if (entry.target.offsetWidth && entry.target.offsetHeight) sizes.set(entry.target.dataset.representation, { width: entry.target.offsetWidth, height: entry.target.offsetHeight });
    if (visible() && !host.hidden) drawLinks();
  });
  function cancel() {
    if (!gesture) return;
    if (gesture.members) {
      for (const item of gesture.members) { item.card.style.left = `${item.x}px`; item.card.style.top = `${item.y}px`; }
      drawLinks();
    } else if (!gesture.connection) { camera.x = gesture.x; camera.y = gesture.y; transform(); }
    preview.removeAttribute('d');
    const pointerId = gesture.pointerId; gesture = null;
    if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId);
  }
  host.addEventListener('pointerdown', event => {
    if (!active() || ![0, 1].includes(event.button) || gesture) return;
    const card = event.button === 0 ? event.target.closest('[data-representation]') : null;
    if (event.target.closest('button')) return;
    event.preventDefault(); host.focus({ preventScroll: true });
    if (connecting()) { if (card) connect(card.dataset.representation); else cancelConnect(); return; }
    const edge = event.button === 0 ? event.target.closest('[data-relation]') : null;
    if (edge) { selectRelation(edge.dataset.relation); return; }
    if (card) select(card.dataset.object, card.dataset.representation);
    else select(null, null);
    if (card && event.altKey) {
      gesture = { pointerId: event.pointerId, connection: card.dataset.representation,
        startX: event.clientX, startY: event.clientY };
      host.setPointerCapture(event.pointerId); return;
    }
    gesture = { pointerId: event.pointerId, card, startX: event.clientX, startY: event.clientY,
      x: card ? parseFloat(card.style.left) : camera.x, y: card ? parseFloat(card.style.top) : camera.y };
    if (card) gesture.members = branchIds(representations, card.dataset.representation).map(id => cards.get(id)).filter(Boolean)
      .map(item => ({ card: item, x: parseFloat(item.style.left), y: parseFloat(item.style.top) }));
    host.setPointerCapture(event.pointerId);
  }, options);
  host.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.connection) {
      const a = world(gesture.startX, gesture.startY), b = world(event.clientX, event.clientY);
      preview.setAttribute('d', `M ${a.x} ${a.y} L ${b.x} ${b.y}`); return;
    }
    if (gesture.card) {
      for (const item of gesture.members) {
        item.card.style.left = `${item.x + dx / camera.scale}px`;
        item.card.style.top = `${item.y + dy / camera.scale}px`;
      }
      drawLinks();
    } else { camera.x = gesture.x + dx; camera.y = gesture.y + dy; transform(); }
  }, options);
  host.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const ended = gesture; gesture = null;
    preview.removeAttribute('d');
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (ended.connection) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-representation]');
      if (target && host.contains(target) && Math.hypot(event.clientX - ended.startX, event.clientY - ended.startY) > 4) connect(target.dataset.representation, ended.connection);
      return;
    }
    if (ended.card) move(ended.card.dataset.representation, parseFloat(ended.card.style.left), parseFloat(ended.card.style.top));
  }, options);
  host.addEventListener('lostpointercapture', cancel, options);
  host.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', cancel, options);
  host.addEventListener('dblclick', event => {
    if (!active() || event.button !== 0) return;
    cancel();
    if (event.altKey || connecting() || event.target.closest('[data-relation]')) return;
    const card = event.target.closest('[data-representation]');
    if (card) { select(card.dataset.object, card.dataset.representation); edit(); }
    else create(world(event.clientX, event.clientY));
  }, options);
  host.addEventListener('keydown', event => {
    if (!active()) return;
    if (event.key === 'Escape') { cancel(); cancelConnect(); return; }
    if (gesture || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Tab' && !event.shiftKey && branch('child', true)) { event.preventDefault(); branch('child'); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (!event.shiftKey && branch('sibling', true)) branch('sibling'); else edit(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
  }, options);
  host.addEventListener('wheel', event => {
    if (!active()) return;
    event.preventDefault(); if (gesture) return;
    if (event.ctrlKey || event.metaKey) {
      const anchor = world(event.clientX, event.clientY);
      const next = Math.min(3, Math.max(.01, camera.scale * Math.exp(-event.deltaY * .002)));
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
    sizes() { return Object.fromEntries(sizes); },
    fit(representationId = null) {
      cancel();
      const targets = (representationId ? [cards.get(representationId)].filter(Boolean) : [...cards.values()]).filter(card => !card.hidden);
      if (!targets.length) return;
      const bounds = targets.map(card => ({ x: parseFloat(card.style.left), y: parseFloat(card.style.top), width: card.offsetWidth, height: card.offsetHeight }));
      const left = Math.min(...bounds.map(b => b.x)), top = Math.min(...bounds.map(b => b.y));
      const right = Math.max(...bounds.map(b => b.x + b.width)), bottom = Math.max(...bounds.map(b => b.y + b.height));
      camera.scale = Math.max(.01, Math.min(1, (host.clientWidth - 60) / Math.max(1, right - left), (host.clientHeight - 60) / Math.max(1, bottom - top)));
      camera.x = host.clientWidth / 2 - (left + right) / 2 * camera.scale;
      camera.y = host.clientHeight / 2 - (top + bottom) / 2 * camera.scale; transform();
    },
    cancel,
    pause() { cancel(); content.cancel(); },
    render(project, selectedId, selectedRep, selectedRelation) {
      const objects = new Map(project.objects.map(obj => [obj.id, obj]));
      const reps = project.views.find(view => view.id === 'view-main')?.representations || [];
      representations = reps;
      const hidden = hiddenBranches(reps);
      const live = new Set(reps.map(rep => rep.id));
      for (const [id, card] of cards) if (!live.has(id)) { observer.unobserve(card); card.remove(); cards.delete(id); sizes.delete(id); }
      for (const rep of reps) {
        const obj = objects.get(rep.objectId); if (!obj) continue;
        let card = cards.get(rep.id);
        if (!card) {
          card = document.createElement('div'); card.className = 'research-card';
          card.dataset.representation = rep.id; card.dataset.object = obj.id;
          card.innerHTML = '<span class="research-card-type"></span><strong></strong><span class="research-card-label"></span><small></small><div class="research-card-content"></div>';
          scene.append(card); cards.set(rep.id, card); observer.observe(card);
        }
        card.style.left = `${rep.x}px`; card.style.top = `${rep.y}px`;
        card.hidden = hidden.has(rep.id);
        card.classList.toggle('is-collapsed', !!rep.collapsed);
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
      const relations = new Map(project.relations.map(relation => [relation.id, relation]));
      links = (project.views.find(view => view.id === 'view-main')?.links || []).filter(link => {
        const relation = relations.get(link.relationId);
        return relation?.type === 'core.association' && relation.typeVersion === 1 && !hidden.has(link.sourceId) && !hidden.has(link.targetId);
      });
      links = [...links, ...reps.filter(rep => rep.parentId && !hidden.has(rep.id)).map(rep => ({
        id: `branch:${rep.id}`, sourceId: rep.parentId, targetId: rep.id, branch: true,
      }))];
      const liveLinks = new Set(links.map(link => link.id));
      for (const [id, edge] of edges) if (!liveLinks.has(id)) { edge.remove(); edges.delete(id); }
      for (const link of links) {
        let group = edges.get(link.id);
        if (!group) {
          group = document.createElementNS(svgNS, 'g'); group.classList.add('research-link');
          if (!link.branch) group.dataset.relation = link.relationId;
          group.classList.toggle('is-branch', !!link.branch);
          const path = document.createElementNS(svgNS, 'path');
          const hit = document.createElementNS(svgNS, 'path'); hit.classList.add('research-link-hit');
          group.append(path, hit, document.createElementNS(svgNS, 'text')); svg.append(group); edges.set(link.id, group);
        }
        group.classList.toggle('is-selected', selectedRelation === link.relationId);
        group.querySelector('text').textContent = (relations.get(link.relationId)?.label || '').slice(0, 80);
      }
      drawLinks();
      host.querySelector('.research-canvas-empty').hidden = reps.length > 0;
    },
    dispose() { cancel(); content.cancel(); observer.disconnect(); controller.abort(); cards.clear(); edges.clear(); },
  };
}
