/** View-only hierarchy. Ordinary object relationships never determine membership. */
export function treeIndex(representations) {
  const byId = new Map(representations.map(rep => [rep.id, rep]));
  const children = new Map(representations.map(rep => [rep.id, []]));
  for (const rep of representations) {
    if (rep.collapsed !== undefined && typeof rep.collapsed !== 'boolean') throw new Error('Invalid branch collapse state');
    if (rep.parentId != null) {
      if (!byId.has(rep.parentId)) throw new Error('Unknown branch parent');
      children.get(rep.parentId).push(rep.id);
    }
  }
  const done = new Set();
  for (const rep of representations) {
    const path = new Set(); let current = rep;
    while (current && !done.has(current.id)) {
      if (path.has(current.id)) throw new Error('Cyclic branch hierarchy');
      path.add(current.id); current = byId.get(current.parentId);
    }
    for (const id of path) done.add(id);
  }
  return { byId, children };
}

export function branchIds(representations, rootId) {
  const { byId, children } = treeIndex(representations);
  if (!byId.has(rootId)) throw new Error('Unknown branch');
  const result = [], stack = [rootId];
  while (stack.length) { const id = stack.pop(); result.push(id); stack.push(...children.get(id)); }
  return result;
}

export function hiddenBranches(representations) {
  const { children } = treeIndex(representations), hidden = new Set();
  const stack = representations.filter(rep => rep.collapsed).flatMap(rep => children.get(rep.id));
  while (stack.length) {
    const id = stack.pop(); if (hidden.has(id)) continue;
    hidden.add(id); stack.push(...children.get(id));
  }
  return hidden;
}

/** Explicit rightward layout; measured cards are passed in, never read from DOM here. */
export function layoutBranch(representations, rootId, sizes = {}) {
  const { byId, children } = treeIndex(representations);
  const order = branchIds(representations, rootId), spans = new Map();
  const size = id => {
    const value = sizes[id] || { width: 280, height: 160 };
    if (![value.width, value.height].every(n => Number.isFinite(n) && n > 0 && n <= 10000)) throw new Error('Invalid card size');
    return value;
  };
  for (const id of [...order].reverse()) {
    const kids = children.get(id);
    spans.set(id, Math.max(size(id).height, kids.reduce((sum, child) => sum + spans.get(child), 0) + Math.max(0, kids.length - 1) * 32));
  }
  const root = byId.get(rootId), positions = new Map();
  const stack = [{ id: rootId, x: root.x, top: root.y + size(rootId).height / 2 - spans.get(rootId) / 2 }];
  while (stack.length) {
    const { id, x, top } = stack.pop();
    positions.set(id, { x, y: top + (spans.get(id) - size(id).height) / 2 });
    const kids = children.get(id), total = kids.reduce((sum, child) => sum + spans.get(child), 0) + Math.max(0, kids.length - 1) * 32;
    let y = top + (spans.get(id) - total) / 2;
    for (const child of kids) { stack.push({ id: child, x: x + size(id).width + 80, top: y }); y += spans.get(child) + 32; }
  }
  return positions;
}
