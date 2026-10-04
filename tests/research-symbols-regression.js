'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, 'assets/research', name)).href);
async function main() {
  const [symbols, geometry, presets, { createResearchModel }, { createResearchRegistry }] = await Promise.all([
    moduleAt('research-symbols.js'), moduleAt('research-orthogonal.js'), moduleAt('research-decoration-presets.js'),
    moduleAt('research-model.js'), moduleAt('research-registry.js')]);
  const at = (type, patch = {}) => ({ ...symbols.defaultSymbol(type), id: type, kind: 'symbol', x: 100, y: 100, ...patch });
  assert.equal(symbols.SYMBOL_TYPES.length, 15);
  for (const type of symbols.SYMBOL_TYPES) {
    const d = at(type), g = symbols.symbolGeometry(d);
    assert(g.paths.length && g.mask); assert(geometry.normalizeDecorations([d]).length);
    const svg = symbols.symbolSvgMarkup(d); assert(svg.includes('<path')); assert(!svg.includes('NaN'));
  }
  const old = { id: 'old', kind: 'symbol', type: 'rectangle', x: 100, y: 100, width: 32, height: 14, rotation: 2, label: '' };
  assert.equal(symbols.symbolAngle(old), Math.PI / 2);
  assert.deepEqual(geometry.normalizeDecorations([old]), [old], 'missing style fields must stay optional');
  assert.equal(presets.normalizeSymbolTemplate(old).rotationDegrees, 90, 'preset creation must preserve legacy rotation');
  const rotated = at('rectangle', { rotationDegrees: 22.5 });
  assert.equal(symbols.symbolAngle(rotated), Math.PI / 8);
  const rb = symbols.symbolShapeBounds(rotated); assert(rb.right - rb.left > 32);
  assert(geometry.hitDecoration(rotated, { x: 112, y: 105 }, 0));
  assert(!geometry.hitDecoration(rotated, { x: 100, y: 117 }, 0));
  symbols.setSymbolTextMeasurer((text, size) => ({ width: text.length * size / 2, ascent: size * .75, descent: size * .25 }));
  const labeled = at('lamp', { label: 'ABC', labelOffsetX: -50, labelOffsetY: 80, labelFontSize: 20, color: '#123456', labelColor: '#ff0000', rotationDegrees: 37.5 });
  assert.deepEqual(symbols.symbolLabelBounds(labeled), { left: 35, right: 65, top: 10, bottom: 30 });
  assert(geometry.hitDecoration(labeled, { x: 50, y: 20 }, 0));
  assert.equal(geometry.decorationBounds(labeled).top, 10);
  assert(symbols.symbolSvgMarkup(labeled).includes('rotate(37.5)'));
  assert(symbols.symbolSvgMarkup(labeled).includes('fill="#ff0000"'));
  assert(symbols.symbolSvgMarkup(at('rectangle', { label: '<script>"&' })).includes('&lt;script&gt;&quot;&amp;'));
  assert.equal(symbols.defaultSymbol('dot').width, 8);
  for (const patch of [{ width: 5 }, { color: 'url(x)' }, { strokeWidth: 7 }, { rotationDegrees: 360 },
    { labelColor: '#fff' }, { labelFontSize: 7 }, { labelOffsetX: Infinity }]) {
    assert.equal(geometry.normalizeDecorations([at('dot', patch)]).length, 0);
  }
  const memory = new Map(), storage = { getItem: (key) => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const store = presets.createDecorationPresetStore(storage), p = store.save('My lamp', labeled);
  assert(!('id' in p.template) && !('x' in p.template));
  assert.equal(p.template.rotationDegrees, 37.5);
  const reopened = presets.createDecorationPresetStore(storage); assert.deepEqual(reopened.list(), store.list());
  store.save('Edited', { ...p.template, width: 64 }, p.id); assert.equal(store.find(p.id).template.width, 64);
  assert.throws(() => store.save('Bad', { ...p.template, color: 'url(x)' }));
  const registry = createResearchRegistry(JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8')));
  const model = createResearchModel({}, registry), d = model.createDecoration({ ...p.template, kind: 'symbol', x: 100, y: 100 });
  const before = model.historyIndex;
  model.updateDecorations({ [d.id]: { labelOffsetX: -20, rotationDegrees: 13.5, rotation: 0 } }); assert.equal(model.historyIndex, before + 1);
  assert(model.undo()); assert.equal(model.decoration(d.id).rotationDegrees, 37.5); assert(model.redo());
  const ids = model.duplicateDecorations([d.id], 28, 28); assert.equal(ids.length, 1);
  assert.equal(model.decoration(ids[0]).labelColor, '#ff0000');
  assert.equal(model.decoration(ids[0]).rotationDegrees, 13.5);
  store.remove(p.id); assert.equal(store.list().length, 0); assert.equal(model.decorations().length, 2);
  const failing = presets.createDecorationPresetStore({ getItem: storage.getItem, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => failing.save('Draft', labeled)); assert.equal(failing.list().length, 0);
  memory.set(presets.PRESETS_KEY, '{broken'); assert.equal(presets.createDecorationPresetStore(storage).list().length, 0);
  console.log('research symbols/presets regression passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
