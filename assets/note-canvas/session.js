// Shared file model/history, isolated from both CodeMirror and CanvasModule.
(function () {
  'use strict';
  const sessions = new Map(), inflight = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Canvas request failed'); error.code = result.code; throw error; }
    return result;
  }
  function target(note, src) {
    if (window.MarkdownMini) return window.MarkdownMini.canvasTarget(note, src);
    try {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(src)) return '';
      const path = new URL(src, 'http://relatum.invalid/' + note).pathname.slice(1);
      const parts = decodeURIComponent(path).split('/');
      return parts.length === 2 && parts[0].toLowerCase() === 'canvases' && /\.canvas$/i.test(parts[1]) ? 'canvases/' + parts[1] : '';
    } catch (_) { return ''; }
  }
  class Session {
    constructor(result) {
      this.path = result.path; this.revision = result.revision; this.data = result.data;
      this.nodes = new Map(); this.edges = new Map(); this.adjacent = new Map(); this.listeners = new Set();
      this.notes = new Set();
      this.past = []; this.future = []; this.generation = 0; this.saved = 0; this.timer = 0; this.pins = 0;
      this.chain = Promise.resolve(true); this.error = ''; this.owner = null; this.reindex();
    }
    reindex() {
      this.nodes.clear(); this.edges.clear(); this.adjacent.clear();
      this.data.nodes.forEach(node => { this.nodes.set(node.id, node); this.adjacent.set(node.id, new Set()); });
      this.data.edges.forEach((edge, order) => {
        this.edges.set(edge.id, { edge, order });
        this.adjacent.get(edge.from)?.add(edge.id); this.adjacent.get(edge.to)?.add(edge.id);
      });
    }
    emit(change) { this.listeners.forEach(listener => listener(change)); }
    begin(owner) {
      if (this.owner && this.owner !== owner) return false;
      if (this.owner === owner) return true;
      this.owner = owner; this.before = clone(this.data); this.emit({ lock: true }); window.dispatchEvent(new Event('relatum:note-canvas-dirty')); return true;
    }
    commit(owner, changed, info) {
      if (this.owner !== owner) return;
      let update = info || { all: true };
      this.owner = null;
      if (changed) {
        this.past.push(this.before); if (this.past.length > 50) this.past.shift(); this.future = [];
        this.generation++; if (update.all || update.structure) this.reindex(); clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 350);
      } else if (update.unchanged) update = {};
      else if (update.restore) {
        const restore = (records, index, keys, edge) => {
          const selected = new Set(keys || []);
          records.forEach(record => { if (!selected.has(record.id)) return;
            const target = edge ? index.get(record.id)?.edge : index.get(record.id);
            if (target) { Object.keys(target).forEach(key => delete target[key]); Object.assign(target, clone(record)); }
          });
        };
        restore(this.before.nodes, this.nodes, update.nodes, false);
        restore(this.before.edges, this.edges, update.edges, true);
      }
      else if (update.positionOnly) {
        const ids = new Set(update.nodes);
        this.before.nodes.forEach(node => { if (ids.has(node.id)) { const current = this.nodes.get(node.id); if (current) { current.x = node.x; current.y = node.y; } } });
      } else { this.data = this.before; this.reindex(); update = { all: true }; }
      this.before = null;
      this.emit(Object.assign({ lock: true, committed: changed }, update));
      window.dispatchEvent(new Event('relatum:note-canvas-dirty'));
    }
    change(owner, callback, info) { if (!this.begin(owner)) return false; callback(this.data); this.commit(owner, true, info || { all: true }); return true; }
    travel(redo) {
      if (this.owner) return false;
      const from = redo ? this.future : this.past, to = redo ? this.past : this.future;
      if (!from.length) return false;
      to.push(clone(this.data)); this.data = from.pop(); this.reindex(); this.generation++;
      this.emit({ all: true, committed: true }); clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 350);
      window.dispatchEvent(new Event('relatum:note-canvas-dirty')); return true;
    }
    async flush() {
      clearTimeout(this.timer); this.timer = 0;
      this.chain = this.chain.catch(() => false).then(async () => {
        if (this.saved === this.generation) return true;
        if (this.owner) return false;
        const generation = this.generation, payload = clone(this.data);
        try {
          const result = await request('/api/notes-canvas/save', { path: this.path, revision: this.revision, data: payload });
          this.revision = result.revision; this.saved = generation; this.error = '';
          window.dispatchEvent(new Event('relatum:note-canvas-dirty')); return true;
        } catch (error) {
          this.error = error.message; this.emit({ error: true });
          window.dispatchEvent(new CustomEvent('relatum:note-canvas-error', { detail: error.message })); return false;
        }
      });
      const ok = await this.chain;
      return ok && this.saved !== this.generation ? this.flush() : ok;
    }
  }
  async function acquire(note, src) {
    const canonical = target(note, src);
    if (!canonical) throw new Error(document.documentElement.lang === 'en' ? 'Invalid canvas reference' : '画布引用超出资源目录');
    const key = canonical.toLowerCase();
    if (sessions.has(key)) return sessions.get(key);
    if (!inflight.has(key)) {
      inflight.set(key, request('/api/notes-canvas/read?note=' + encodeURIComponent(note) + '&src=' + encodeURIComponent(src))
        .then(result => { const session = new Session(result); sessions.set(result.path.toLowerCase(), session); return session; })
        .finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }
  function releaseUnused() {
    sessions.forEach((session, key) => { if (!session.notes.size && !session.pins && !session.listeners.size && session.saved === session.generation && !session.owner) { clearTimeout(session.timer); sessions.delete(key); } });
  }
  window.RelatumNoteCanvasSessions = Object.freeze({ acquire, request, target, sessions, releaseUnused,
    retainNote(session, note) { session.notes.add(note); },
    releaseNote(note) { sessions.forEach(s => s.notes.delete(note)); releaseUnused(); },
    remapNotes(source, destination) { sessions.forEach(s => { [...s.notes].forEach(note => { if (note === source || note.startsWith(source + '/')) { s.notes.delete(note); s.notes.add(destination + note.slice(source.length)); } }); }); },
    dirty: () => Array.from(sessions.values()).some(s => s.saved !== s.generation || s.owner),
    async flushAll(skipOwned) { return (await Promise.all(Array.from(sessions.values(), s => skipOwned && s.owner ? true : s.flush()))).every(Boolean); },
    rename(oldPath, result) { const key = oldPath.toLowerCase(), s = sessions.get(key); if (s) { sessions.delete(key); s.path = result.path; s.revision = result.revision; sessions.set(s.path.toLowerCase(), s); s.emit({ renamed: true }); } },
  });
})();
