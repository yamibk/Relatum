'use strict';
// Pure production metadata/template checks; no browser, library or user preferences.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const definitions = [];
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/note-extensions/catalog.js'), 'utf8'),
  { window: { RelatumNoteExtensions: { register: item => definitions.push(item) } } });
const d = definitions.find(item => item.id === 'latex-input'), plain = value => JSON.parse(JSON.stringify(value));
assert.equal(d.version, '1.3.0');
assert.equal(d.displayVersion, '1.3');
assert.equal(d.snippets.length, 122);
assert.equal(d.snippets.filter(item => !item.added).length, 61);
assert.equal(new Set(d.snippets.map(item => item.id)).size, d.snippets.length);
for (const snippet of d.snippets) assert.equal(d.snippetProblem(snippet), '', snippet.id);
const parse = (text, start = 0) => plain(d.parseTemplate(text, start));
assert.deepEqual(parse('a$1b$2$0', 10), { text: 'ab', stops: [{ number: 1, from: 11, to: 11, order: 0 },
  { number: 2, from: 12, to: 12, order: 1 }], exit: 12, preview: 'a…b…' });
assert.deepEqual(parse('$1=${1:\\frac{x}{2}}$0'), { text: '\\frac{x}{2}=\\frac{x}{2}',
  stops: [{ number: 1, from: 0, to: 11, order: 0 }, { number: 1, from: 12, to: 23, order: 1 }], exit: 23,
  preview: '\\frac{x}{2}=\\frac{x}{2}' });
for (const value of ['$10', '$', '$0$0', '${0:x}', '${1:x}${1:y}', '${1:x', '${1:${2:x}}', 'a'.repeat(4097)]) {
  assert.equal(d.parseTemplate(value), null, value.slice(0, 80));
}
assert.equal(parse('${1:\\{x\\}}$1').text, '\\{x\\}\\{x\\}');
const custom = { id: 'custom-existing', trigger: 'pmat', replacement: '\\old{$1}$0', boundary: 'start', enabled: false };
const old = { id: 'sq', trigger: 'text', replacement: '\\root{$1}$0', boundary: 'start', enabled: true };
const normalized = d.normalizeOptions({ automatic: false, custom: [custom], overrides: [old] });
assert.equal(normalized.automatic, false);
assert.equal(normalized.visualSnippets, true);
assert.equal(normalized.autoEnlargeBrackets, true);
assert.deepEqual(plain(normalized.custom), [custom]);
assert.deepEqual(plain(normalized.overrides), [old]);
const entries = d.effectiveSnippets(normalized);
assert.equal(entries.find(item => item.id === 'pmat').conflict, true);
assert.equal(entries.find(item => item.id === 'text').conflict, true);
assert.equal(entries.find(item => item.id === 'sq').trigger, 'text');
assert.equal(d.effectiveSnippets({}).find(item => item.id === 'pmat').conflict, false);
assert.equal(d.normalizeOptions({ custom: [{ ...custom, trigger: 'sq' }] }).custom.length, 0, 'legacy collision policy remains');
assert.equal(d.effectiveSnippets({}).filter(item => item.conflict).length, 0);
assert.equal(d.settingsSearch({}, 'zh').some(item => item.key === 'option:visualSnippets'), true);
assert.equal(d.snippetInfo(d.snippets.find(item => item.id === 'pmat'), 'zh').group, 'environments');
assert.equal(d.snippetInfo(d.snippets.find(item => item.id === 'RR'), 'en').group, 'symbols');
assert.deepEqual(plain(d.normalizeOptions(normalized)), plain(normalized), 'normalization is idempotent');
const modes = d.effectiveSnippets({});
assert.equal(modes.find(item => item.id === 'par').triggerMode, 'tab');
assert.equal(modes.find(item => item.id === 'beg').triggerMode, 'tab');
assert.equal(modes.find(item => item.id === 'sq').triggerMode, 'auto');
for (const triggerMode of ['auto', 'tab']) {
  const value = { ...old, triggerMode }, config = { overrides: [value], custom: [{ ...custom, trigger: 'zz', triggerMode }] };
  const result = d.normalizeOptions(config);
  assert.deepEqual(plain(result.overrides), [value]);
  assert.equal(d.effectiveSnippets(result).find(item => item.id === 'sq').triggerMode, triggerMode);
  assert.equal(result.custom[0].triggerMode, triggerMode);
  assert.deepEqual(plain(d.normalizeOptions(result)), plain(result));
}
assert.equal(d.snippetProblem({ ...old, triggerMode: 'invalid' }), 'triggerMode');
assert.equal(d.normalizeOptions({ custom: [{ ...custom, triggerMode: 'invalid' }] }).custom.length, 0);
const additions = ['det', 'trace', 'nabl', 'ddt', 'oint', 'iint', 'iiint', 'avg', 'norm', 'Norm', 'ceil', 'floor', 'arcsin', 'arccos', 'arctan', 'csc', 'sec', 'cot'];
for (const trigger of additions) {
  const item = modes.find(item => item.id === trigger);
  assert.equal(item.boundary, 'start', trigger);
  assert.equal(item.triggerMode, 'auto', trigger);
  for (const language of ['zh', 'en']) assert.notEqual(d.snippetInfo(item, language).group, 'greek', trigger);
  const collision = d.effectiveSnippets({ custom: [{ ...custom, trigger }] });
  assert.equal(collision.find(item => item.id === trigger).conflict, true, trigger);
  assert.equal(collision.find(item => item.id === custom.id).enabled, false, 'disabled old snippets still reserve their trigger');
}
assert.equal(d.snippetInfo(modes.find(item => item.id === 'det'), 'zh').group, 'functions');
assert.equal(d.effectiveSnippets({ overrides: [{ ...old, trigger: 'trace' }] }).find(item => item.id === 'trace').conflict, true, 'old built-in override wins over a 1.3 trigger');
assert.equal(d.settingsSearch({}, 'zh').some(item => item.key === 'snippet:trace'), true);
console.log('PASS LaTeX 1.3 templates, metadata, trigger modes, upgrade collisions and preferences (' + d.snippets.length + ' snippets)');
