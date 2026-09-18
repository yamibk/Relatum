/** Research format v1. Object identity is independent of view representations. */
import { branchIds, treeIndex, layoutBranch } from './tree.js';
const clone = value => structuredClone(value);
export const newId = prefix => `${prefix}-${crypto.randomUUID()}`;

export function createTypeRegistry() {
  const types = new Map();
  return Object.freeze({
    register(type, descriptor) {
      if (types.has(type)) throw new Error(`Duplicate research type: ${type}`);
      types.set(type, Object.freeze({ ...descriptor }));
    },
    get: type => types.get(type),
  });
}

export function coreTypes() {
  const registry = createTypeRegistry();
  registry.register('core.variable', {
    version: 1,
    defaults: () => ({ label: '变量', symbol: 'q', domain: 'real', shape: [], unit: '' }),
    validate(changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (!['label', 'symbol', 'domain', 'unit'].includes(key) || typeof value !== 'string' || value.length > 2000) {
          throw new Error('Invalid variable field');
        }
      }
    },
  });
  for (const type of ['core.note', 'core.formula']) {
    registry.register(type, {
      version: 1,
      defaults: () => ({ label: '', source: '' }),
      validate(changes) {
        for (const [key, value] of Object.entries(changes)) {
          if (!['label', 'source'].includes(key) || typeof value !== 'string'
            || value.length > (key === 'source' ? 100000 : 2000)) throw new Error('Invalid draft field');
        }
      },
    });
  }
  return registry;
}

/** Record differences, not whole-document history. Unknown data stays intact. */
export class ResearchModel {
  #doc; #registry; #undo = []; #redo = []; #listeners = new Set(); #bytes = 0;
  constructor(project, registry = coreTypes()) {
    if (project.format !== 'relatum-research' || project.formatVersion !== 1) throw new Error('Unsupported research format');
    this.#doc = clone(project);
    for (const view of this.#doc.views) if (view.type === 'core.canvas') treeIndex(view.representations);
    this.#registry = registry;
  }
  get revision() { return this.#doc.revision; }
  get projectId() { return this.#doc.projectId; }
  get title() { return this.#doc.title; }
  // Serialized-size estimate, not an exact JavaScript heap measurement.
  get estimatedBytes() {
    return JSON.stringify(this.#doc).length * 2
      + [...this.#undo, ...this.#redo].reduce((total, entry) => total + entry.bytes * 2, 0);
  }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  snapshot() { return clone(this.#doc); }
  replaceAfterDeletion(project) {
    this.#doc = clone(project); this.#undo = []; this.#redo = []; this.#bytes = 0;
    for (const listener of this.#listeners) listener({ revision: this.revision });
  }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #publish(patches) {
    this.#doc.revision += 1;
    const change = { revision: this.revision,
      changedObjectIds: patches.filter(p => p.collection === 'objects').map(p => p.id),
      changedRelationIds: patches.filter(p => p.collection === 'relations').map(p => p.id),
      changedViewIds: patches.filter(p => p.collection === 'views').map(p => p.id) };
    for (const listener of this.#listeners) listener(change);
  }
  #apply(patches, forward) {
    for (const patch of patches) {
      if (patch.collection === 'project') {
        this.#doc[patch.id] = clone(forward ? patch.after : patch.before);
        continue;
      }
      const records = this.#doc[patch.collection];
      const index = records.findIndex(item => item.id === patch.id);
      const value = forward ? patch.after : patch.before;
      if (value == null) { if (index >= 0) records.splice(index, 1); }
      else if (index >= 0) records[index] = clone(value);
      else records.splice(patch.index, 0, clone(value));
    }
    this.#publish(patches);
  }
  dispatch(command, group = null) {
    const patches = [];
    const patch = (collection, id, after) => {
      const index = this.#doc[collection].findIndex(item => item.id === id);
      const before = index < 0 ? null : this.#doc[collection][index];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        patches.push({ collection, id, index: index < 0 ? this.#doc[collection].length : index, before: clone(before), after: clone(after) });
      }
    };
    const object = id => {
      const obj = this.#doc.objects.find(item => item.id === id);
      if (!obj) throw new Error('Unknown research object');
      return obj;
    };
    const view = id => {
      const item = this.#doc.views.find(value => value.id === id);
      if (!item || item.type !== 'core.canvas') throw new Error('Unknown canvas view');
      return clone(item);
    };
    const position = () => {
      if (![command.x, command.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1e9)) throw new Error('Invalid position');
      return { x: command.x, y: command.y };
    };
    if (command.type === 'renameProject') {
      if (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 500) throw new Error('Invalid project title');
      const title = command.title.trim();
      if (title !== this.#doc.title) patches.push({ collection: 'project', id: 'title', before: this.#doc.title, after: title });
    } else if (command.type === 'createObject' || command.type === 'createBranch') {
      const descriptor = this.#registry.get(command.objectType);
      if (!descriptor) throw new Error('Unavailable object type');
      if (this.#doc.objects.some(item => item.id === command.objectId)) throw new Error('Duplicate object ID');
      const payload = { ...descriptor.defaults(), ...command.payload };
      descriptor.validate(command.payload || {});
      const target = view(command.viewId);
      let parent = null;
      if (command.type === 'createBranch') {
        parent = target.representations.find(rep => rep.id === command.parentId);
        if (!parent) throw new Error('Unknown branch parent');
        parent.collapsed = false;
      }
      target.representations.push({ id: newId('rep'), objectId: command.objectId, ...position(), presentation: 'compact',
        ...(parent ? { parentId: parent.id } : {}) });
      patch('objects', command.objectId, { id: command.objectId, type: command.objectType, typeVersion: descriptor.version, payload });
      patch('views', target.id, target);
    } else if (command.type === 'updateObject') {
      const current = object(command.objectId);
      const descriptor = this.#registry.get(current.type);
      if (!descriptor || descriptor.version !== current.typeVersion) throw new Error('Unavailable object type');
      descriptor.validate(command.changes);
      patch('objects', current.id, { ...current, payload: { ...current.payload, ...command.changes } });
    } else if (command.type === 'addRepresentation') {
      object(command.objectId);
      const target = view(command.viewId);
      target.representations.push({ id: newId('rep'), objectId: command.objectId, ...position(), presentation: 'compact' });
      patch('views', target.id, target);
    } else if (['setBranchParent', 'toggleBranch', 'layoutBranch', 'revealRepresentation'].includes(command.type)) {
      const target = view(command.viewId);
      const rep = target.representations.find(item => item.id === command.representationId);
      if (!rep) throw new Error('Unknown representation');
      if (command.type === 'setBranchParent') {
        if (command.parentId == null) delete rep.parentId;
        else rep.parentId = command.parentId;
        treeIndex(target.representations);
      } else if (command.type === 'toggleBranch') rep.collapsed = !rep.collapsed;
      else if (command.type === 'revealRepresentation') {
        const { byId } = treeIndex(target.representations);
        let parent = byId.get(rep.parentId);
        while (parent) { parent.collapsed = false; parent = byId.get(parent.parentId); }
      } else {
        const positions = layoutBranch(target.representations, rep.id, command.sizes);
        for (const item of target.representations) if (positions.has(item.id)) Object.assign(item, positions.get(item.id));
      }
      for (const item of target.representations) if (![item.x, item.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new Error('Invalid position');
      patch('views', target.id, target);
    } else if (['moveRepresentation', 'removeRepresentation'].includes(command.type)) {
      const target = view(command.viewId);
      const index = target.representations.findIndex(item => item.id === command.representationId);
      if (index < 0) throw new Error('Unknown representation');
      if (command.type === 'removeRepresentation') {
        target.representations.splice(index, 1);
        for (const rep of target.representations) if (rep.parentId === command.representationId) delete rep.parentId;
        // Removing a visual reference never deletes an object-level relationship.
        if (target.links) target.links = target.links.filter(link => link.sourceId !== command.representationId && link.targetId !== command.representationId);
      }
      else {
        const origin = target.representations[index], next = position();
        const dx = next.x - origin.x, dy = next.y - origin.y;
        const ids = new Set(branchIds(target.representations, origin.id));
        for (const rep of target.representations) if (ids.has(rep.id)) {
          rep.x += dx; rep.y += dy;
          if (![rep.x, rep.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new Error('Invalid position');
        }
      }
      patch('views', target.id, target);
    } else if (command.type === 'createRelation') {
      const target = view(command.viewId);
      const source = target.representations.find(rep => rep.id === command.sourceId);
      const dest = target.representations.find(rep => rep.id === command.targetId);
      if (!source || !dest || source.objectId === dest.objectId) throw new Error('Choose two different objects');
      if (this.#doc.relations.some(rel => rel.id === command.relationId)) throw new Error('Duplicate relation ID');
      const label = command.label ?? '';
      if (typeof label !== 'string' || label.length > 2000) throw new Error('Invalid relation label');
      patch('relations', command.relationId, { id: command.relationId, type: 'core.association', typeVersion: 1,
        label, ends: [{ objectId: source.objectId }, { objectId: dest.objectId }] });
      target.links = [...(target.links || []), { id: newId('link'), relationId: command.relationId, sourceId: source.id, targetId: dest.id }];
      patch('views', target.id, target);
    } else if (['renameRelation', 'removeRelation'].includes(command.type)) {
      const relation = this.#doc.relations.find(rel => rel.id === command.relationId);
      if (!relation || relation.type !== 'core.association' || relation.typeVersion !== 1) throw new Error('Unavailable relation');
      if (command.type === 'renameRelation') {
        if (typeof command.label !== 'string' || command.label.length > 2000) throw new Error('Invalid relation label');
        patch('relations', relation.id, { ...relation, label: command.label });
      } else {
        patch('relations', relation.id, null);
        for (const current of this.#doc.views) {
          if (current.type === 'core.canvas' && current.links?.some(link => link.relationId === relation.id)) {
            patch('views', current.id, { ...current, links: current.links.filter(link => link.relationId !== relation.id) });
          }
        }
      }
    } else throw new Error('Unknown research command');
    if (!patches.length) return false;
    const last = this.#undo.at(-1);
    if (group && last?.group === group && patches.length === 1 && last.patches.length === 1
      && patches[0].id === last.patches[0].id && patches[0].collection === last.patches[0].collection) {
      this.#bytes -= last.bytes;
      last.patches[0].after = clone(patches[0].after);
      last.bytes = new TextEncoder().encode(JSON.stringify(last.patches)).byteLength;
      this.#bytes += last.bytes;
    } else {
      const bytes = new TextEncoder().encode(JSON.stringify(patches)).byteLength;
      this.#undo.push({ patches, group, bytes }); this.#bytes += bytes;
    }
    this.#redo = [];
    while (this.#bytes > 64 * 1024 * 1024 && this.#undo.length > 1) this.#bytes -= this.#undo.shift().bytes;
    this.#apply(patches, true);
    return true;
  }
  undo() {
    const entry = this.#undo.pop(); if (!entry) return;
    this.#bytes -= entry.bytes; this.#redo.push(entry); this.#apply(entry.patches, false);
  }
  redo() {
    const entry = this.#redo.pop(); if (!entry) return;
    this.#undo.push(entry); this.#bytes += entry.bytes; this.#apply(entry.patches, true);
  }
}
