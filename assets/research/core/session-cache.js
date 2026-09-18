/** Inactive, already-saved sessions only. Current/dirty sessions never enter this cache. */
export function createSessionCache({ maxEntries = 6, maxBytes = 64 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function take(id) {
    const entry = entries.get(id);
    if (!entry) return undefined;
    entries.delete(id); bytes -= entry.bytes;
    return entry.session;
  }
  return {
    take,
    set(id, session) {
      take(id);
      const size = session.model.estimatedBytes;
      if (!Number.isFinite(size) || size > maxBytes) return;
      entries.set(id, { session, bytes: size }); bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) take(entries.keys().next().value);
    },
    clear() { entries.clear(); bytes = 0; },
    get size() { return entries.size; },
    get estimatedBytes() { return bytes; },
  };
}
