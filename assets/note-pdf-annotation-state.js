const endpoint = '/api/note-pdf/annotations';
const maximumUndo = 60;
const expandedNotesKey = 'canvas:notePdfOpenSticky:v1';

function stickyPreferences() {
  let expanded = {};
  try {
    const data = JSON.parse(localStorage.getItem(expandedNotesKey));
    if (data && typeof data === 'object' && !Array.isArray(data)) expanded = data;
  } catch {}
  return {
    read(id) { return new Set(Array.isArray(expanded[id]) ? expanded[id] : []); },
    write(id, notes) {
      if (notes.size) expanded[id] = [...notes];
      else delete expanded[id];
      try { localStorage.setItem(expandedNotesKey, JSON.stringify(expanded)); } catch {}
    },
  };
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { code: data.code, status: response.status });
  return data;
}

function createSession(path, id, assetRevision, onDirty, sticky) {
  const records = new Map(), pages = new Map(), pending = new Map(), subscribers = new Set();
  const undo = [], redo = [];
  let pdfHash, revision, loading, saving, timer, firstEdit = 0, loaded = false, error = '';
  let lastRead = 0, replacementVersion = '', inFlight;
  const notify = affected => {
    subscribers.forEach(listener => listener(affected));
    onDirty();
  };
  const query = () => new URLSearchParams({ note: path, id, assetRevision });

  function load({ edit = false, reload = false } = {}) {
    if (loading) return loading.then(ok => ok && edit && !pdfHash ? load({ edit, reload }) : ok);
    if (pending.size && !reload) return Promise.resolve(!!pdfHash && !error);
    if (!reload && loaded && (edit ? !!pdfHash : Date.now() - lastRead < 500)) return Promise.resolve(!error);
    const params = query();
    if (edit || reload) params.set('edit', '1');
    loading = request(endpoint + '?' + params).then(result => {
      if (pending.size && !reload) return !error;
      if ((loaded && result.revision !== revision) || reload) { undo.length = 0; redo.length = 0; }
      records.clear(); pages.clear(); pending.clear();
      inFlight = null;
      result.annotations.forEach(record => put(record.id, record));
      const expanded = sticky.read(id);
      const count = expanded.size;
      for (const key of expanded) if (records.get(key)?.kind !== 'note') expanded.delete(key);
      if (expanded.size !== count) sticky.write(id, expanded);
      pdfHash = result.pdfHash;
      revision = result.revision;
      lastRead = Date.now();
      loaded = true; error = '';
      return true;
    }).catch(reason => {
      error = reason.code || 'annotation_io';
      return false;
    }).finally(() => {
      loading = null;
      notify();
    });
    notify();
    return loading;
  }

  function put(key, value) {
    const previous = records.get(key);
    if (previous) {
      const page = pages.get(previous.page);
      page.delete(key);
      if (!page.size) pages.delete(previous.page);
    }
    if (!value) { records.delete(key); return; }
    records.set(key, value);
    if (!pages.has(value.page)) pages.set(value.page, new Map());
    pages.get(value.page).set(key, value);
  }

  function apply(changes) {
    const affected = new Set();
    let expanded, expansionChanged = false;
    for (const [key, value] of changes) {
      const previous = records.get(key);
      if (previous) affected.add(previous.page);
      if (value) affected.add(value.page);
      if (!value && previous?.kind === 'note') {
        expanded ??= sticky.read(id);
        if (expanded.delete(key)) expansionChanged = true;
      }
      put(key, value);
      // Distinct queue entries prevent a late acknowledgement clearing a newer edit.
      pending.set(key, { value });
    }
    if (expansionChanged) sticky.write(id, expanded);
    if (!firstEdit) firstEdit = Date.now();
    clearTimeout(timer);
    if (!error && !saving) timer = setTimeout(() => void flush(), Math.max(0, Math.min(600, 3000 - (Date.now() - firstEdit))));
    notify(affected);
  }

  function commit(changes, group) {
    if (!pdfHash || error === 'pdf_changed' || !changes.size) return false;
    const latest = undo.at(-1);
    if (group && latest?.group === group) {
      latest.after = changes;
    } else {
      const before = new Map();
      for (const [key] of changes) before.set(key, records.get(key) || null);
      undo.push({ before, after: changes, group });
      if (undo.length > maximumUndo) undo.shift();
    }
    redo.length = 0;
    apply(changes);
    return true;
  }

  function moveHistory(from, to, field) {
    const action = from.pop();
    if (!action) return;
    to.push(action);
    apply(action[field]);
  }

  async function flush({ retry = false, keepalive = false } = {}) {
    clearTimeout(timer);
    if (saving) return saving;
    if (!pending.size) return true;
    if (error && (!retry || error === 'pdf_changed' || error === 'annotation_conflict')) return false;
    error = '';
    saving = drain(keepalive).catch(reason => {
      if (reason.status >= 400 && reason.status < 500) inFlight = null;
      error = replacementVersion ? 'pdf_changed' : reason.code || 'annotation_io';
      return false;
    }).finally(() => {
      saving = null;
      notify(new Set());
    });
    notify(new Set());
    return saving;
  }

  async function drain(keepalive) {
    while (pending.size && !error) {
      if (!inFlight) {
        const batch = new Map(pending), upsert = [], remove = [];
        for (const [key, entry] of batch) {
          if (entry.value) upsert.push(entry.value);
          else remove.push(key);
        }
        inFlight = { batch, body: JSON.stringify({ note: path, id, assetRevision, pdfHash, revision, upsert, remove }) };
      }
      // Retry the exact same write if transport failed after the server committed it.
      const { batch, body } = inFlight;
      firstEdit = 0;
      const result = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        keepalive: keepalive && new TextEncoder().encode(body).length < 60_000,
      });
      revision = result.revision;
      for (const [key, entry] of batch) if (pending.get(key) === entry) pending.delete(key);
      inFlight = null;
    }
    return !pending.size;
  }

  return {
    path, id, load, flush, commit,
    get assetRevision() { return assetRevision; },
    replaced(version) {
      replacementVersion = version;
      error = 'pdf_changed';
      clearTimeout(timer);
      notify();
    },
    async discardChangedDraft() {
      if (saving) await saving;
      clearTimeout(timer);
      pending.clear(); records.clear(); pages.clear(); undo.length = redo.length = 0;
      inFlight = null;
      firstEdit = 0; revision = pdfHash = null; loaded = false;
      assetRevision = replacementVersion || assetRevision; replacementVersion = '';
      notify();
      return load({ reload: true });
    },
    get error() { return error; },
    get ready() { return !!pdfHash; },
    get loading() { return !!loading; },
    get saving() { return !!saving; },
    get dirty() { return !!pending.size; },
    get canUndo() { return !!undo.length; },
    get canRedo() { return !!redo.length; },
    get: key => records.get(key),
    expandedNotes: () => sticky.read(id),
    setNoteExpanded(key, open) {
      const record = records.get(key);
      if (record?.kind !== 'note') return;
      const expanded = sticky.read(id);
      if (expanded.has(key) === open) return;
      if (open) expanded.add(key); else expanded.delete(key);
      sticky.write(id, expanded);
      notify(new Set([record.page]));
    },
    onPage: number => (replacementVersion ? null : pages.get(number))?.values() || [],
    undo: () => moveHistory(undo, redo, 'before'),
    redo: () => moveHistory(redo, undo, 'after'),
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
}

export function createAnnotationStore(onDirty) {
  const sessions = new Map();
  const sticky = stickyPreferences();
  const dirty = () => Array.from(sessions.values()).some(session => session.dirty);
  let lastDirty = false;
  const notify = () => {
    const value = dirty();
    if (lastDirty !== value) { lastDirty = value; onDirty?.(value); }
  };
  return {
    open(path, id, version) {
      const key = JSON.stringify([path, id]);
      let session = sessions.get(key);
      if (session && session.assetRevision !== version && session.dirty) session.replaced(version);
      else if (!session || session.assetRevision !== version) {
        session = createSession(path, id, version, notify, sticky);
      }
      sessions.delete(key);
      sessions.set(key, session);
      for (const [older, state] of sessions) {
        if (sessions.size <= 32) break;
        if (state !== session && !state.dirty && !state.loading && !state.saving) sessions.delete(older);
      }
      void session.load();
      return session;
    },
    dirty,
    async flush({ path, id, keepalive, retry } = {}) {
      const matching = Array.from(sessions.values()).filter(session => session.dirty && (!path
        || (id ? session.path === path && session.id === id : session.path === path || session.path.startsWith(path + '/'))));
      const results = await Promise.all(matching.map(session => session.flush({ keepalive, retry })));
      return results.every(Boolean);
    },
  };
}
