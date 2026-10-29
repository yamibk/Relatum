'use strict';
// Pure production metadata/template checks; no browser, library or user preferences.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const definitions = [];
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/note-extensions/catalog.js'), 'utf8'),
  { window: { RelatumNoteExtensions: { register: item => definitions.push(item) } } });
const d = definitions.find(item => item.id === 'latex-input'), plain = value => JSON.parse(JSON.stringify(value));
assert.equal(d.version, '1.2.0');
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
console.log('PASS LaTeX 1.2 templates, metadata, upgrade collisions and preferences (' + d.snippets.length + ' snippets)');
