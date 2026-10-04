import { normalizeDecorations } from './research-orthogonal.js';
import { symbolTemplateDefaults } from './research-symbols.js';

export const PRESETS_KEY = 'research:decorationPresets:v1';
export function normalizeSymbolTemplate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('预设数据无效');
  const issues = [], d = normalizeDecorations([{ ...symbolTemplateDefaults(raw),
    id: 'template', kind: 'symbol', x: 0, y: 0 }], issues)[0];
  if (!d || issues.length) throw new Error('预设数据无效');
  const { id, kind, x, y, ...template } = d;
  return template;
}
export function createDecorationPresetStore(storage = globalThis.localStorage) {
  let entries = [];
  try {
    const saved = JSON.parse(storage.getItem(PRESETS_KEY) || 'null');
    if (saved && saved.version === 1 && Array.isArray(saved.presets)) {
      const seen = new Set();
      for (const p of saved.presets.slice(0, 1000)) {
        try {
          if (typeof p.id !== 'string' || !p.id || p.id.length > 256 || seen.has(p.id)
            || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) continue;
          entries.push({ id: p.id, name: p.name, template: normalizeSymbolTemplate(p.template) }); seen.add(p.id);
        } catch (_error) { /* Ignore a damaged local entry without rewriting its library. */ }
      }
    }
  } catch (_error) {}
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function persist(next) {
    // Publish in memory only after storage succeeds: quota errors keep drafts and
    // the previously saved library intact.
    storage.setItem(PRESETS_KEY, JSON.stringify({ version: 1, presets: next })); entries = next;
  }
  return {
    list: () => copy(entries), find: (id) => { const p = entries.find((e) => e.id === id); return p ? copy(p) : null; },
    save(name, raw, id = '') {
      name = String(name).trim();
      if (!name || name.length > 120 || (!id && entries.length >= 1000)) throw new Error('预设名称或数量无效');
      if (id && !entries.some((p) => p.id === id)) throw new Error('预设不存在');
      const preset = { id: id || globalThis.crypto.randomUUID(), name, template: normalizeSymbolTemplate(raw) };
      persist(id ? entries.map((p) => p.id === id ? preset : p) : [...entries, preset]); return copy(preset);
    },
    remove(id) { persist(entries.filter((p) => p.id !== id)); },
  };
}
