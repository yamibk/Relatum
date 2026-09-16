import { newId } from './model.js';

export async function researchRequest(path, body) {
  const response = await fetch(`/api/research/${path}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Research request failed'), { code: result.code });
  return result;
}

/** One in-flight request. Uncertain retries reuse the identical request ID/body. */
export function createSaveQueue(model, loaded, onStatus, request = researchRequest) {
  let revision = loaded.project.revision, fingerprint = loaded.fingerprint;
  let timer = 0, running = null, pending = null, conflict = false, deletion = null;
  const dirty = () => model.revision !== revision;
  async function flush() {
    clearTimeout(timer);
    if (running) return running;
    if (conflict) return false;
    if (!dirty() && !pending && !deletion) return true;
    running = (async () => {
      try {
        if (deletion) {
          onStatus('saving');
          const loaded = await request('delete-object', deletion);
          revision = loaded.project.revision; fingerprint = loaded.fingerprint;
          deletion = null; model.replaceAfterDeletion(loaded.project);
        }
        while (dirty() || pending) {
          if (!pending) {
            const project = model.snapshot();
            pending = { projectId: project.projectId, requestId: newId('save'),
              expectedRevision: revision, expectedFingerprint: fingerprint, project };
          }
          onStatus('saving');
          const saved = await request('save', pending);
          revision = saved.revision; fingerprint = saved.fingerprint; pending = null;
        }
        onStatus('saved'); return true;
      } catch (error) {
        conflict = error.code === 'conflict';
        onStatus(conflict ? 'conflict' : 'error', error); return false;
      } finally { running = null; }
    })();
    return running;
  }
  return {
    get dirty() { return dirty() || !!deletion; },
    get deleting() { return !!deletion; },
    async deleteObject(objectId) {
      if (deletion) return flush();
      if (!(await flush())) return false;
      deletion = { projectId: model.snapshot().projectId, objectId, expectedRevision: revision, expectedFingerprint: fingerprint };
      return flush();
    },
    get conflict() { return conflict; },
    schedule() {
      clearTimeout(timer);
      if (conflict) { onStatus('conflict'); return; }
      onStatus('dirty'); timer = setTimeout(flush, 500);
    },
    flush,
    dispose() { clearTimeout(timer); },
  };
}
