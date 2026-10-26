// Quiz syntax and ephemeral answers. No DOM, editor, storage or network dependencies.
(function (global) {
  'use strict';
  const MAX_SOURCE = 256 * 1024, MAX_LINE = 64 * 1024;
  function fingerprint(value) {
    const text = String(value || ''); let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b, 33) ^ c; }
    return text.length + ':' + (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
  }
  function parse(source) {
    const value = String(source || '').replace(/\r\n?/g, '\n');
    const fail = error => ({ valid: false, error, model: null });
    if (value.length > MAX_SOURCE) return fail('size');
    const lines = value.split('\n');
    if (lines.some(line => line.length > MAX_LINE)) return fail('size');
    const question = [], choices = [], explanation = []; let phase = 'question';
    for (const line of lines) {
      if (phase === 'explanation') { explanation.push(line); continue; }
      const option = /^ {0,3}- \[([ xX])\][ \t]+(.*)$/.exec(line);
      if (option) {
        if (!option[2].trim()) return fail('empty-option');
        phase = 'options'; choices.push({ text: option[2].trim(), correct: option[1].toLowerCase() === 'x' }); continue;
      }
      if (phase === 'question') { question.push(line); continue; }
      if (/^\s*---\s*$/.test(line)) { phase = 'explanation'; continue; }
      if (line.trim()) return fail('option-line');
    }
    if (!question.join('\n').trim()) return fail('question');
    if (choices.length < 2) return fail('options');
    if (choices.filter(choice => choice.correct).length !== 1) return fail('answer');
    return { valid: true, error: '', model: { question: question.join('\n').trim(), choices: choices.map(choice => choice.text),
      answer: choices.findIndex(choice => choice.correct), explanation: explanation.join('\n').trim(), fingerprint: fingerprint(value) } };
  }
  function evaluate(model, selectedIndex) {
    const answered = !!model && Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < model.choices.length;
    return { answered, correct: answered && selectedIndex === model.answer };
  }
  function createSession() {
    const records = new Map(), documents = new Map(); let serial = 0;
    const pathKey = path => String(path || '');
    const key = (path, range) => pathKey(path) + '\u0000' + range.from;
    function trim(map) { while (map.size > 2048) map.delete(map.keys().next().value); }
    function clearNote(path) { for (const [id, record] of records) if (record.path === pathKey(path)) records.delete(id); }
    return {
      get(path, range, signature) {
        const id = key(path, range), record = records.get(id);
        if (!record) return null;
        if (record.signature !== signature || record.to !== range.to) { records.delete(id); return null; }
        records.delete(id); records.set(id, record); return record.selected;
      },
      set(path, range, signature, selected) {
        const id = key(path, range); records.delete(id);
        if (selected !== null) records.set(id, { path: pathKey(path), from: range.from, to: range.to, signature, selected, serial: ++serial });
        trim(records);
      },
      // The host supplies a position mapper and old-document changed ranges.
      map(path, mapPosition, changes) {
        const moving = [];
        for (const [id, record] of records) {
          if (record.path !== pathKey(path)) continue;
          records.delete(id);
          if (changes.some(change => change.from < record.to && change.to > record.from
              || change.from === change.to && change.from > record.from && change.from < record.to)) continue;
          record.from = mapPosition(record.from, 1); record.to = mapPosition(record.to, -1); moving.push(record);
        }
        moving.forEach(record => records.set(key(path, record), record));
      },
      enterDocument(path, source) {
        const id = pathKey(path), signature = fingerprint(source);
        if (documents.has(id) && documents.get(id) !== signature) clearNote(id);
        documents.delete(id); documents.set(id, signature); trim(documents);
      },
      rememberDocument(path, source) { const id = pathKey(path); documents.delete(id); documents.set(id, fingerprint(source)); trim(documents); },
      remap(source, destination) {
        const move = path => path === source || path.startsWith(source + '/') ? destination + path.slice(source.length) : path;
        const changed = [];
        for (const [id, record] of records) if (move(record.path) !== record.path) { records.delete(id); record.path = move(record.path); changed.push(record); }
        changed.forEach(record => records.set(key(record.path, record), record));
        for (const [path, signature] of Array.from(documents)) if (move(path) !== path) { documents.delete(path); documents.set(move(path), signature); }
      },
      clearNote,
      clear() { records.clear(); documents.clear(); },
      get size() { return records.size; },
    };
  }
  global.RelatumNoteQuizCore = Object.freeze({ parse, evaluate, createSession, fingerprint, MAX_SOURCE, MAX_LINE });
})(typeof window === 'undefined' ? globalThis : window);
