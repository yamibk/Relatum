'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');

function fixture(count, piled, highestPage = 1) {
  const notes = Array.from({ length: count }, (_, i) => {
    const group = piled ? Math.floor(i / 8) : i;
    return { id: 'n' + i, x: 60 + group % 10 * 105, y: 60 + Math.floor(group / 10) * 132,
      color: ['sage', 'pink', 'sky'][i % 3], rotate: i % 5 - 2, text: '性能 ' + i,
      ...(piled ? { stack: 's' + group } : {}) };
  });
  return { notes, edges: notes.map((note, i) => ({ id: 'e' + i, from: note.id, to: notes[(i + 1) % count].id })), arrows: [], highestPage };
}

function probe() {
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  const nativeFrame = requestAnimationFrame.bind(window), nativeCancel = cancelAnimationFrame.bind(window);
  const pending = new Map();
  window.requestAnimationFrame = callback => {
    const id = nativeFrame(time => { pending.delete(id); callback(time); }); pending.set(id, callback.name || 'anonymous'); return id;
  };
  window.cancelAnimationFrame = id => { pending.delete(id); nativeCancel(id); };
  window.__hotSample = async (kind, piled) => {
    const surface = document.querySelector('.notes-surface');
    const target = kind === 'drag' ? surface.querySelector(`[data-id="n${piled ? 7 : 0}"]`) : surface;
    const rect = target.getBoundingClientRect();
    const x = kind === 'drag' ? rect.left + rect.width / 2 : 1310;
    const y = kind === 'drag' ? rect.top + rect.height / 2 : 720;
    const metrics = { writes: 0, edgeWrites: 0, slashWrites: 0, reads: 0, frames: [], inputEvents: 0 };
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.target.matches?.('.sticky-note') && record.attributeName === 'style') metrics.writes++;
      if (record.target.closest?.('.notes-edges')) metrics.edgeWrites++;
      if (record.target.closest?.('.notes-slash')) metrics.slashWrites++;
    }));
    observer.observe(surface, { attributes: true, subtree: true });
    const nativeRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('.sticky-note') || this === surface) metrics.reads++;
      return nativeRect.call(this);
    };
    const event = (type, px, py) => target.dispatchEvent(new PointerEvent(type,
      { pointerId: 77, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: px, clientY: py, bubbles: true, cancelable: true }));
    let lastX = x, lastY = y, previous = 0;
    const start = performance.now();
    event('pointerdown', x, y);
    for (let frame = 0; frame < 16; frame++) {
      const time = await new Promise(resolve => nativeFrame(resolve));
      if (previous) metrics.frames.push(time - previous); previous = time;
      for (let move = 0; move < 40; move++) {
        const step = frame * 40 + move;
        lastX = x + Math.sin(step / 60) * (kind === 'drag' ? 24 : 18);
        lastY = y + Math.cos(step / 60) * (kind === 'drag' ? 18 : 65);
        event('pointermove', lastX, lastY); metrics.inputEvents++;
      }
    }
    event('pointerup', lastX, lastY);
    await new Promise(resolve => nativeFrame(resolve));
    Element.prototype.getBoundingClientRect = nativeRect;
    observer.disconnect();
    metrics.elapsed = performance.now() - start;
    metrics.frames.sort((a, b) => a - b);
    metrics.p95 = metrics.frames[Math.ceil(metrics.frames.length * .95) - 1];
    metrics.max = metrics.frames.at(-1);
    return metrics;
  };
  window.__hotPending = () => [...pending.values()];
}

function layoutComparison(before, after) {
  function run(source, count, piled, expanded) {
    const notes = fixture(count, piled).notes;
    const elements = new Map(notes.map(note => {
      const values = new Map();
      return [note.id, { style: { left: '', top: '', zIndex: '', getPropertyValue: key => values.get(key) || '',
        setProperty: (key, value) => values.set(key, value), values } }];
    }));
    let scans = 0;
    notes.filter = function (fn) { return Array.prototype.filter.call(this, (value, index) => { scans++; return fn(value, index); }); };
    notes.indexOf = function (value) { const index = Array.prototype.indexOf.call(this, value); scans += index < 0 ? this.length : index + 1; return index; };
    const context = { notes, expandedStack: expanded ? 's0' : null, elById: id => elements.get(id), renderEdges() {}, refreshKeyboardCurrent() {},
      FAN_STEP: 118, FAN_RISE: 10, FAN_ROT: 3, PILE_DX: 4, PILE_DY: 6 };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('  function groupMembers('), source.indexOf('  function isMultiPile('))
      + source.slice(source.indexOf('  function relayout('), source.indexOf('  // ── 便签拖动松手惯性')), context);
    context.relayout(false);
    const comparisons = scans;
    const states = [...elements.values()].map(el => [el.style.left, el.style.top, el.style.zIndex, [...el.style.values]]);
    const durations = [];
    for (let round = 0; round < 3; round++) {
      const start = performance.now(); for (let i = 0; i < 100; i++) context.relayout(false);
      durations.push((performance.now() - start) / 100);
    }
    return { comparisons, durations, states };
  }
  const result = [];
  for (const count of [96, 400]) for (const piled of [false, true]) for (const expanded of piled ? [false, true] : [false]) {
    const baseline = run(before, count, piled, expanded), current = run(after, count, piled, expanded);
    assert.deepEqual(current.states, baseline.states, 'layout and stacking must match');
    delete baseline.states; delete current.states;
    assert.equal(current.comparisons, 0, 'layout must not rescan note arrays for each note');
    result.push({ count, piled, expanded, baseline, current });
  }
  return result;
}

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notes-hotpaths-'));
  const baseline = execFileSync('git', ['show', `${process.env.RELATUM_NOTES_BASE_REF || 'HEAD'}:assets/notes.js`], { cwd: root, encoding: 'utf8' });
  const current = fs.readFileSync(path.join(root, 'assets/notes.js'), 'utf8');
  const layout = layoutComparison(baseline, current);
  const port = await new Promise(resolve => {
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1', () => { const port = reserve.address().port; reserve.close(() => resolve(port)); });
  });
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser;
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  const runs = [];
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try { const runtime = await (await fetch(url + '/api/runtime')).json(); assert.equal(path.resolve(runtime.root), dataRoot); break; }
      catch { if (i > 100 || server.exitCode != null) throw Error(logs); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    for (let round = 0; round < 3; round++) for (const count of [96, 400]) for (const piled of [false, true]) {
      // Alternate versions each round to reduce warm-up/order bias.
      for (const version of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(probe);
        await context.route('**/api/notes', route => route.fulfill({ json: fixture(count, piled) }));
        await context.route('**/api/notes-save', route => route.fulfill({ json: { ok: true } }));
        await context.route('**/notes.js', route => route.fulfill({ body: version === 'baseline' ? baseline : current, contentType: 'application/javascript' }));
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url + '/?view=notes');
        await page.waitForFunction(count => window.CanvasNotes && CanvasNotes.count() === count, count);
        await page.waitForTimeout(700);
        await page.evaluate(() => { CanvasNotes.resetView(); CanvasNotes.setInertia(0); CanvasNotes.setStackHoverDelay(1200); });
        const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
        for (const kind of ['drag', 'slash']) {
          const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
          const sample = await page.evaluate(({ kind, piled }) => __hotSample(kind, piled), { kind, piled });
          const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
          sample.work = Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutCount', 'LayoutDuration', 'RecalcStyleCount'].map(key => [key, after[key] - before[key]]));
          runs.push({ round, count, piled, version, kind, ...sample });
          if (version === 'current' && kind === 'drag') assert(sample.writes < sample.inputEvents * (piled ? 8 : 1), 'drag style writes must be coalesced');
        }
        await page.waitForTimeout(1000);
        assert.deepEqual(await page.evaluate(() => __hotPending()), [], 'idle must have no pending frames');
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log(JSON.stringify({ round, count, piled, complete: true }));
    }
    const report = { dataRoot, layout, runs };
    const output = process.argv[2] || path.join(dataRoot, 'report.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(output);
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => server.exitCode != null ? resolve() : server.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
