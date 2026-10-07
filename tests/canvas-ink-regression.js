'use strict';

// Optional browser checks use the test host's RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH:
// node tests/canvas-ink-regression.js --browser [--benchmark] [--baseline-ref <commit>] [--report <temporary JSON>]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/canvas.js'), 'utf8');

function functionSource(name, indent = '    ') {
  const start = source.indexOf(indent + 'function ' + name + '(');
  assert(start >= 0, 'missing actual source function: ' + name);
  const end = source.indexOf('\n' + indent + '}', start);
  assert(end > start, 'missing function end: ' + name);
  return source.slice(start, end + indent.length + 2);
}

function fixture() {
  return {
    version: 2, nodes: [], edges: [],
    ink: {
      strokes: [
        { id: 'pressure', color: '#111111', width: 3, pressure: true, pressureVersion: 2,
          points: [{ x: 100, y: 100, p: 0.2, tilt: 0.25 }, { x: 160, y: 100, p: 0.8, tilt: 0.5 }] },
        { id: 'legacy', color: '#111111', width: 3, points: [[700, 400], [760, 400]] },
        { id: 'area', color: '#111111', width: 3, pressure: true, pressureVersion: 2,
          points: Array.from({ length: 11 }, (_, i) => ({ x: 100 + i * 10, y: 300, p: 0.6, tilt: 0.4 })) },
      ],
      arrows: [
        { id: 'poly', kind: 'poly', arrowhead: 'none', color: '#111111', width: 3,
          start: [400, 200], end: [600, 200], waypoints: [{ x: 500, y: 260 }] },
        { id: 'free', color: '#111111', width: 3,
          start: { x: 700, y: 150 }, end: { x: 900, y: 150 }, control: { x: 800, y: 190 } },
      ],
    },
  };
}

function unitRegression() {
  // Run the production accessor and snapshot functions; no test-only production export.
  const helpers = source.slice(source.indexOf('  function clonePoint(p)'), source.indexOf('  // ── 几何'));
  const create = new Function('data', 'global', helpers + '\n'
    + functionSource('ensureInkData') + '\n' + functionSource('snapshotCanvasState')
    + '\nfunction snapshotTimers() { return []; }\n'
    + 'data.ink = cloneInk(data.ink);\n'
    + 'return { read: ensureInkData, snapshot: snapshotCanvasState, clone: cloneInk };');
  const data = fixture();
  const original = data.ink;
  const originalJson = JSON.stringify(original);
  const api = create(data, {});
  const ink = api.read(), stroke = ink.strokes[0], point = stroke.points[0], arrow = ink.arrows[0];
  assert.notEqual(ink, original, 'initial normalization must detach caller-owned ink');
  assert.deepEqual(ink.strokes[1].points[0], { x: 700, y: 400 });
  for (let i = 0; i < 20; i++) {
    assert.equal(api.read(), ink, 'ordinary access must retain live ink identity');
    assert.equal(api.read().strokes[0], stroke);
    assert.equal(api.read().strokes[0].points[0], point);
    assert.equal(api.read().arrows[0], arrow);
  }
  const snapshot = api.snapshot();
  point.x = 999; point.p = 0.9; point.tilt = 0.8;
  arrow.start.x = 999; arrow.end.y = 999; arrow.waypoints[0].x = 999;
  ink.arrows[1].control.x = 999;
  assert.deepEqual(snapshot.ink.strokes[0].points[0], { x: 100, y: 100, p: 0.2, tilt: 0.25 });
  assert.deepEqual(snapshot.ink.arrows[0].start, { x: 400, y: 200 });
  assert.deepEqual(snapshot.ink.arrows[0].end, { x: 600, y: 200 });
  assert.deepEqual(snapshot.ink.arrows[0].waypoints, [{ x: 500, y: 260 }]);
  assert.deepEqual(snapshot.ink.arrows[1].control, { x: 800, y: 190 });
  assert.equal(JSON.stringify(original), originalJson, 'live changes must not mutate input');
  data.ink = api.clone(snapshot.ink);
  data.ink.arrows[0].waypoints[0].x = 123;
  assert.equal(snapshot.ink.arrows[0].waypoints[0].x, 500, 'restored ink must not alias history');

  for (const invalid of [null, undefined, 3, {}, { version: 1, strokes: null, arrows: [] }]) {
    data.ink = invalid;
    const recovered = api.read();
    assert.deepEqual(recovered, { version: 1, strokes: [], arrows: [] });
    assert.equal(api.read(), recovered, 'malformed containers must normalize only once');
  }
  data.ink = { version: 0, strokes: [{ points: [['3', '4']] }], arrows: [] };
  assert.deepEqual(api.read().strokes[0].points[0], { x: 3, y: 4 });
  return { liveIdentity: true, inputIndependent: true, snapshotIndependent: true, malformedRecovery: true };
}

const html = `<!doctype html><div id="viewport" class="canvas-viewport"><div id="surface" class="canvas-surface"><svg id="edges" class="canvas-edges-layer"></svg><svg id="ink" class="canvas-ink-layer"></svg></div></div><div id="empty"></div><div id="tools"><button data-canvas-tool="select">select</button><button data-canvas-tool="eraser">eraser</button></div>`;

async function makePage(browser, script, data, renderInk = true, pointCount = 0) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  // Every request is answered in memory; there is no HTTP server or persistent data root.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/canvas-import-source') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: fixture(), revision: 'test' }) });
    }
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (url.pathname.startsWith('/fonts/')) {
      const font = path.join(root, 'assets/fonts', path.basename(url.pathname));
      if (fs.existsSync(font)) return route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(font) });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://127.0.0.1/canvas-ink-test');
  await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'assets/styles.css'), 'utf8')
    + '\n#viewport{position:fixed;inset:0;width:1200px;height:800px}#tools{position:fixed;bottom:0;z-index:10}' });
  for (const filename of ['canvas-changes.js', 'canvas-import.js', 'ruler.js', 'canvas-timer.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'assets', filename), 'utf8') });
  }
  await page.addScriptTag({ content: script });
  await page.evaluate(({ data, renderInk, pointCount }) => {
    localStorage.setItem('canvas:mode', 'normal');
    localStorage.setItem('canvas:eraserMode', 'stroke');
    if (pointCount) {
      data.ink.strokes = Array.from({ length: pointCount / 500 }, (_, s) => ({ id: 's' + s, width: 3,
        points: Array.from({ length: 500 }, (_, p) => ({ x: p, y: s * 12 + p % 7, p: 0.5 })) }));
    }
    window.testData = data;
    window.testApi = CanvasModule.init({
      viewport: document.getElementById('viewport'), surface: document.getElementById('surface'),
      edgesLayer: document.getElementById('edges'), inkLayer: renderInk ? document.getElementById('ink') : null,
      emptyHint: document.getElementById('empty'), drawToolbar: document.getElementById('tools'),
      initialViewport: { scale: 1, centerX: 600, centerY: 400 }, data, onChange() {},
    });
  }, { data, renderInk, pointCount });
  return page;
}

async function browserRegression(browser) {
  const page = await makePage(browser, source, fixture());
  try {
    const result = await page.evaluate(async () => {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const data = testApi.getData();
      const initial = JSON.stringify(data.ink);
      const live = data.ink, point = live.strokes[0].points[0], arrow = live.arrows[0];
      for (let i = 0; i < 20; i++) CanvasModule.notify();
      check(data.ink === live && live.strokes[0].points[0] === point && live.arrows[0] === arrow, 'notify replaced live ink');
      point.x = 110; point.p = 0.7; arrow.waypoints[0].x = 510;
      CanvasModule.pushHistory(); CanvasModule.notify();
      testApi.undo();
      check(JSON.stringify(data.ink) === initial, 'undo failed to restore initial ink');
      data.ink.strokes[0].points[0].x = 999; data.ink.arrows[0].waypoints[0].x = 999;
      testApi.redo();
      check(data.ink.strokes[0].points[0].x === 110 && data.ink.arrows[0].waypoints[0].x === 510, 'redo aliased live edits');
      testApi.undo();
      check(JSON.stringify(data.ink) === initial, 'live restored edits polluted initial history');

      await CanvasModule.importManagedCanvas('synthetic');
      check(data.ink.strokes.length === 6 && data.ink.arrows.length === 4, 'ink import did not merge');
      check(data.ink.strokes[3].points[0].p === 0.2 && data.ink.strokes[3].points[0].tilt === 0.25, 'import lost pressure or tilt');
      const imported = data.ink; CanvasModule.notify();
      check(data.ink === imported, 'post-import access replaced ink');
      testApi.undo(); check(JSON.stringify(data.ink) === initial, 'import undo failed');
      testApi.redo(); check(data.ink.strokes.length === 6, 'import redo failed');
      testApi.undo();

      const surface = document.getElementById('surface'), append = surface.appendChild;
      let failedOnce = false, rejected = false;
      surface.appendChild = function (element) {
        if (!failedOnce) { failedOnce = true; throw new Error('synthetic render failure'); }
        return append.call(this, element);
      };
      try { await CanvasModule.importManagedCanvas('synthetic'); } catch (_) { rejected = true; }
      finally { surface.appendChild = append; }
      check(rejected && JSON.stringify(data.ink) === initial, 'failed import did not roll back');

      const tool = (name) => document.querySelector('[data-canvas-tool="' + name + '"]').click();
      const erase = (x, y) => {
        const viewport = document.getElementById('viewport');
        for (const type of ['pointerdown', 'pointerup']) viewport.dispatchEvent(new PointerEvent(type,
          { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
      };
      tool('eraser'); erase(130, 100);
      check(!data.ink.strokes.some((stroke) => stroke.id === 'pressure'), 'whole-stroke erase failed');
      testApi.undo(); check(JSON.stringify(data.ink) === initial, 'whole-stroke erase undo failed');
      tool('eraser'); erase(150, 300);
      const fragments = data.ink.strokes.filter((stroke) => !['pressure', 'legacy'].includes(stroke.id));
      check(fragments.length === 2 && fragments.every((stroke) => stroke.points.every((p) => p.p === 0.6 && p.tilt === 0.4)), 'area erase fragments lost geometry/attributes');
      testApi.undo(); check(JSON.stringify(data.ink) === initial, 'area erase undo failed');

      tool('select');
      const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type,
        { bubbles: true, clientX: x, clientY: y, button: 0 }));
      const hit = document.querySelector('.canvas-free-arrow-hit[data-id="poly"]');
      mouse(hit, 'mousedown', 450, 230); mouse(window, 'mouseup', 450, 230);
      CanvasModule.notify();
      document.querySelector('#ink .edge-waypoint').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      check(data.ink.arrows[0].waypoints.length === 0, 'arrow waypoint delete targeted a stale object');
      testApi.undo();
      const startHandle = document.querySelector('#ink .arrow-endpoint');
      mouse(startHandle, 'mousedown', 400, 200); mouse(window, 'mousemove', 420, 210); mouse(window, 'mouseup', 420, 210);
      check(data.ink.arrows[0].start.x === 420 && data.ink.arrows[0].start.y === 210, 'arrow endpoint drag failed after undo');
      testApi.undo(); check(JSON.stringify(data.ink) === initial, 'arrow geometry undo failed');
      testApi.redo(); check(data.ink.arrows[0].start.x === 420, 'arrow endpoint redo failed');
      return { notifyIdentity: true, undoRedo: true, importUndoRedo: true, importRollback: true,
        strokeErase: true, areaErase: true, arrowWaypointDelete: true, arrowEndpointDrag: true };
    });
    assert.deepEqual(page.errors, []);
    return result;
  } finally { await page.close(); }
}

async function benchmark(browser) {
  const refIndex = process.argv.indexOf('--baseline-ref');
  const ref = refIndex >= 0 ? process.argv[refIndex + 1] : 'HEAD';
  assert(ref, '--baseline-ref requires a Git revision');
  const baseline = execFileSync('git', ['show', ref + ':assets/canvas.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const results = [];
  for (const totalPoints of [50000, 200000, 500000]) {
    const data = { version: 2, nodes: [], edges: [], ink: { version: 1, arrows: [], strokes: [] } };
    const result = { totalPoints };
    for (const [name, script] of [['before', baseline], ['after', source]]) {
      const page = await makePage(browser, script, data, false, totalPoints);
      try {
        result[name] = await page.evaluate(() => {
          for (let i = 0; i < 3; i++) CanvasModule.notify();
          const ink = testData.ink, samples = [];
          for (let i = 0; i < 11; i++) { const t = performance.now(); CanvasModule.notify(); samples.push(performance.now() - t); }
          samples.sort((a, b) => a - b);
          return { medianMs: samples[5], p90Ms: samples[9], maxMs: samples[10], liveIdentity: testData.ink === ink };
        });
        assert.deepEqual(page.errors, []);
      } finally { await page.close(); }
    }
    assert.equal(result.after.liveIdentity, true);
    results.push(result);
  }
  return results;
}

async function main() {
  const report = { unit: unitRegression() };
  if (process.argv.includes('--browser')) {
    const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
    const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    try {
      report.browser = browser.version();
      report.functional = await browserRegression(browser);
      if (process.argv.includes('--benchmark')) report.notifyBenchmark = await benchmark(browser);
    } finally { await browser.close(); }
  }
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex >= 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
