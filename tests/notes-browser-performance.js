'use strict';

// Optional browser acceptance tool. Playwright belongs to the test host only.
// The server and all writes use a disposable data root; Quick Notes is a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

function fixture(count) {
  return {
    notes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, x: 32 + i % 12 * 246,
      y: 32 + Math.floor(i / 12) * 210, text: `记录 ${i}\n速记墙性能验收`,
      color: ['yellow', 'sage', 'pink', 'blue'][i % 4], rotate: i % 7 - 3 })),
    edges: Array.from({ length: count * 2 }, (_, i) => ({ id: `e${i}`,
      from: `n${i % count}`, to: `n${(i + (i < count ? 1 : 12)) % count}` })),
    arrows: Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`,
      ...(i % 2 ? { fromNote: `n${i}` } : { x1: 20 + i * 170, y1: 200 }), x2: 110 + i * 170, y2: 290 })),
  };
}

function installProbe() {
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  localStorage.setItem('canvas:notesCreateBrowseShortcutsDisabled:v1', '0');
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  const probe = window.__notesProbe = { active: false, reads: 0, added: 0, removed: 0, callbacks: {} };
  window.requestAnimationFrame = callback => {
    const id = nativeFrame(now => {
      pending.delete(id);
      if (probe.active) {
        const name = callback.name || '(anonymous)';
        probe.callbacks[name] = (probe.callbacks[name] || 0) + 1;
      }
      callback(now);
    });
    pending.set(id, callback.name || '(anonymous)');
    return id;
  };
  window.cancelAnimationFrame = id => { pending.delete(id); nativeCancel(id); };
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (probe.active && (this.matches('.sticky-note') || this.matches('[data-role="notes-surface"]'))) probe.reads++;
    return rect.call(this);
  };
  window.__sampleNotes = async (motion, duration) => {
    const surface = document.querySelector('[data-role="notes-surface"]');
    const box = surface.getBoundingClientRect();
    Object.assign(probe, { active: true, reads: 0, added: 0, removed: 0, callbacks: {} });
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.target.closest?.('.notes-edges')) {
        probe.added += record.addedNodes.length;
        probe.removed += record.removedNodes.length;
      }
    }));
    observer.observe(surface, { childList: true, subtree: true });
    const frames = [];
    const start = performance.now();
    let last = 0, inputAt = 0;
    await new Promise(resolve => nativeFrame(function sample(now) {
      if (last) frames.push(now - last);
      last = now;
      if (motion && now - inputAt >= 100) {
        surface.dispatchEvent(new WheelEvent('wheel', { clientX: box.left + 450, clientY: box.top + 320,
          deltaY: Math.floor((now - start) / 600) % 2 ? 120 : -120, bubbles: true, cancelable: true }));
        inputAt = now;
      }
      if (now - start < duration) nativeFrame(sample);
      else resolve();
    }));
    probe.active = false;
    observer.disconnect();
    frames.sort((a, b) => a - b);
    return { reads: probe.reads, added: probe.added, removed: probe.removed,
      callbacks: probe.callbacks, pending: Array.from(pending.values()), frames: frames.length,
      p95: frames[Math.ceil(frames.length * .95) - 1], max: frames.at(-1) };
  };
}

async function regression(page, context, dataRoot) {
  const data = {
    notes: [
      { id: 'n0', x: 60, y: 80, text: '第一条笔记', color: 'yellow', rotate: -3 },
      { id: 'n1', x: 400, y: 80, text: '第二条笔记\n用于检查连线', color: 'sage', rotate: 4 },
      { id: 'n2', x: 700, y: 280, text: '叠摞底层', color: 'pink', rotate: -4, stack: 'pile' },
      { id: 'n3', x: 700, y: 280, text: '叠摞顶层', color: 'blue', rotate: 4, stack: 'pile' },
    ],
    edges: [{ id: 'e0', from: 'n0', to: 'n1' }, { id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n0', to: 'n3' }],
    arrows: [{ id: 'a0', fromNote: 'n1', x2: 900, y2: 100 }, { id: 'a1', x1: 60, y1: 500, toNote: 'n0' }],
  };
  let saved = null;
  await context.route('**/api/notes', route => route.fulfill({ json: data }));
  await context.route('**/api/notes-save', route => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(new URL('/?view=study', page.url()).href);
  await page.locator('.left-spine [data-action="notes-view"]').click();
  await page.waitForTimeout(850);
  await page.evaluate(() => { CanvasNotes.resetView(); CanvasNotes.setInertia(0); });
  const checks = [];
  const geometry = async (name, model = data) => {
    const error = await page.evaluate(data => {
      let max = 0;
      for (const edge of data.edges) {
        const line = document.querySelector(`.notes-edge[data-id="${edge.id}"]`);
        if (!line) throw Error('Missing line ' + edge.id);
        for (const [id, end] of [[edge.from, 0], [edge.to, 1]]) {
          const rect = document.querySelector(`.sticky-note[data-id="${id}"]`).getBoundingClientRect();
          const actual = line.getPointAtLength(end ? line.getTotalLength() : 0).matrixTransform(line.getScreenCTM());
          max = Math.max(max, Math.hypot(actual.x - rect.left - rect.width / 2, actual.y - rect.top - rect.height / 2));
        }
      }
      for (const arrow of data.arrows) {
        const path = document.querySelector(`.notes-arrow[data-id="${arrow.id}"]`);
        for (const [id, end] of [[arrow.fromNote, 0], [arrow.toNote, 1]]) {
          if (!id) continue;
          const rect = document.querySelector(`.sticky-note[data-id="${id}"]`).getBoundingClientRect();
          const actual = path.getPointAtLength(end ? path.getTotalLength() : 0).matrixTransform(path.getScreenCTM());
          max = Math.max(max, Math.hypot(actual.x - rect.left - rect.width / 2, actual.y - rect.top - rect.height / 2));
        }
      }
      return max;
    }, model);
    assert(error < .8, `${name}: endpoint drift ${error}px`);
    checks.push({ name, maxError: error });
  };
  await geometry('initial geometry');
  await page.evaluate(() => { window.__savedEdges = Array.from(document.querySelectorAll('.notes-edges [data-id]')); });
  await page.locator('[data-role="notes-surface"]').hover({ position: { x: 480, y: 330 } });
  await page.mouse.wheel(0, -360);
  await page.waitForTimeout(700);
  await geometry('zoomed attached endpoints');
  assert(await page.evaluate(() => __savedEdges.every(el => el.isConnected)), 'camera preserves SVG identity');
  checks.push({ name: 'camera preserves SVG identity' });
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(180); await page.keyboard.up('ArrowRight');
  await geometry('keyboard pan');
  await page.evaluate(() => CanvasNotes.resetView());
  const top = page.locator('.sticky-note[data-id="n3"]');
  await top.hover();
  await page.waitForTimeout(450);
  await geometry('stack opening');
  await page.waitForTimeout(350);
  await geometry('stack expanded');
  await page.mouse.move(1300, 780);
  await page.waitForTimeout(500);
  await geometry('stack collapsed');
  const body = page.locator('.sticky-note[data-id="n1"] .sticky-note-body');
  await body.dblclick();
  await body.fill('编辑中的长笔记\n'.repeat(9));
  await page.waitForTimeout(100);
  await geometry('live editing resize');
  await body.press('Escape');
  await page.waitForTimeout(400);
  await geometry('typography after editing');
  // Restore a short note so drag and slash targets stay unobstructed.
  await body.dblclick(); await body.fill('第二条笔记'); await body.press('Escape');
  await page.waitForTimeout(400);
  const note = page.locator('.sticky-note[data-id="n0"]');
  const box = await note.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 80, { steps: 12 });
  await geometry('dragging note');
  await page.mouse.up();
  await page.waitForTimeout(400);
  await geometry('drag settled');
  await page.screenshot({ path: path.join(dataRoot, 'interaction.png') });
  const movedBox = await note.boundingBox();
  await page.mouse.move(movedBox.x - 30, movedBox.y + movedBox.height / 2); await page.mouse.down();
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2, { steps: 8 });
  await page.mouse.up(); await page.waitForTimeout(350);
  assert.equal(await page.locator('.notes-edge[data-id]').count(), 1, 'deletion prunes incident edges');
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  await geometry('undo deletion');
  await page.keyboard.press('Control+y'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.notes-edge[data-id]').count(), 1, 'redo deletion');
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  checks.push({ name: 'delete/undo/redo' });
  await page.keyboard.press('/'); await page.keyboard.insertText('第一条');
  assert.equal(await page.locator('.notes-edge.search-dim').count(), 3, 'search dims unmatched edges');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.notes-edge.search-dim').count(), 0, 'clearing search restores edges');
  checks.push({ name: 'search styling' });
  await note.hover(); await page.keyboard.press('Tab'); await page.waitForTimeout(650);
  await page.locator('.sticky-note.editing .sticky-note-body').press('Escape'); await page.waitForTimeout(400);
  assert.equal(await page.locator('.notes-edge[data-id]').count(), 4, 'linked note creation');
  await geometry('new linked note', saved);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(350);
  assert.equal(await page.locator('.notes-edge[data-id]').count(), 3, 'undo linked note creation');
  await geometry('undo linked note creation');
  const surface = await page.locator('[data-role="notes-surface"]').boundingBox();
  await page.mouse.move(surface.x + 260, surface.y + 500); await page.mouse.down({ button: 'right' });
  await page.mouse.move(surface.x + 480, surface.y + 500, { steps: 8 }); await page.mouse.up({ button: 'right' });
  assert.equal(await page.locator('.notes-arrow[data-id]').count(), 3, 'free arrow creation');
  await page.mouse.move(surface.x + 360, surface.y + 450); await page.mouse.down();
  await page.mouse.move(surface.x + 360, surface.y + 550, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.locator('.notes-arrow[data-id]').count(), 2, 'slash still hits free arrows');
  checks.push({ name: 'arrow creation and slash deletion' });
  await page.waitForTimeout(650);
  assert(saved && saved.notes.length === 4 && saved.edges.length === 3 && saved.arrows.length === 2, 'saving keeps the data format');
  assert(!JSON.stringify(saved).includes('Geometry'), 'render caches are not persisted');
  await page.evaluate(() => document.body.dataset.startTheme = 'dark');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dataRoot, 'dark.png') });
  await page.setViewportSize({ width: 560, height: 820 });
  await page.evaluate(() => CanvasNotes.fitAll()); await page.waitForTimeout(700);
  await geometry('narrow viewport and fit');
  await page.screenshot({ path: path.join(dataRoot, 'narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('button[data-start-workspace="notes"]').click();
  await page.waitForTimeout(500);
  let inactive = await page.evaluate(() => __sampleNotes(false, 300));
  assert.equal(inactive.reads, 0, 'notes workspace does not measure the hidden Quick Notes wall');
  assert(!inactive.pending.includes('refreshEdgeGeometry'), 'workspace departure stops geometry frames');
  await page.locator('button[data-start-workspace="career"]').click();
  await page.waitForTimeout(500);
  inactive = await page.evaluate(() => __sampleNotes(false, 300));
  assert.equal(inactive.reads, 0, 'career workspace does not measure the hidden Quick Notes wall');
  await page.locator('button[data-start-workspace="canvas"]').click();
  await page.waitForTimeout(500);
  await geometry('return from top-level workspaces');
  checks.push({ name: 'notes/career workspace cleanup' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(new URL('/?view=study', page.url()).href);
  await page.locator('.left-spine [data-action="notes-view"]').click(); await page.waitForTimeout(300);
  await page.evaluate(() => CanvasNotes.resetView());
  await top.hover(); await page.waitForTimeout(500);
  await geometry('reduced motion stack');
  assert.equal((await page.evaluate(() => __sampleNotes(false, 250))).pending.length, 0, 'idle has no pending frames');
  await page.locator('.left-spine [data-action="study-view"]').click(); await page.waitForTimeout(400);
  const idle = await page.evaluate(() => __sampleNotes(false, 250));
  assert.equal(idle.reads, 0, 'hidden Quick Notes does not read geometry');
  assert.equal(idle.added + idle.removed, 0, 'hidden Quick Notes does not rebuild SVG');
  checks.push({ name: 'reduced motion and hidden runtime cleanup' });
  return checks;
}

async function main() {
  const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const root = path.resolve(__dirname, '..');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notes-perf-'));
  const output = path.resolve(process.argv[2] || path.join(dataRoot, 'report.json'));
  const baseline = process.env.RELATUM_NOTES_BASELINE === '1';
  const baselineRef = process.env.RELATUM_NOTES_BASE_REF || 'HEAD';
  const count = Number(process.env.RELATUM_NOTES_COUNT || 96);
  const port = await new Promise(resolve => {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1', () => {
      const port = reservation.address().port;
      reservation.close(() => resolve(port));
    });
  });
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '', browser;
  server.stdout.on('data', c => { serverOutput += c; });
  server.stderr.on('data', c => { serverOutput += c; });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode != null) throw Error(serverOutput);
      let runtime;
      try { runtime = await (await fetch(url + '/api/runtime')).json(); } catch {}
      if (runtime) {
        assert.equal(path.resolve(runtime.root).toLowerCase(), dataRoot.toLowerCase());
        break;
      }
      if (i === 99) throw Error('Server timeout: ' + serverOutput);
      await new Promise(r => setTimeout(r, 100));
    }
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const results = { baseline, baselineRef: baseline ? baselineRef : null,
      dataRoot, browser: browser.version(), viewport: '1440x900', count, runs: [] };
    for (let round = 0; round < Number(process.env.RELATUM_NOTES_ROUNDS || 3); round++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(installProbe);
      await context.route('**/api/notes', route => route.fulfill({ json: route.request().method() === 'GET' ? fixture(count) : { ok: true } }));
      if (baseline) {
        const body = execFileSync('git', ['show', `${baselineRef}:assets/notes.js`], { cwd: root, encoding: 'utf8' });
        await context.route('**/notes.js', route => route.fulfill({ body, contentType: 'application/javascript' }));
      }
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(url + '/?view=study');
      await page.locator('[data-action="notes-view"]').click();
      await page.waitForFunction(count => document.querySelectorAll('.notes-world .sticky-note').length === count, count);
      await page.waitForTimeout(1100);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      const sample = await page.evaluate(() => __sampleNotes(true, 2400));
      const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      sample.work = Object.fromEntries(['LayoutCount', 'LayoutDuration', 'RecalcStyleCount', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(k => [k, after[k] - before[k]]));
      results.runs.push(sample);
      if (!baseline) {
        assert.equal(sample.added + sample.removed, 0, 'camera must reuse all SVG elements');
        assert(sample.reads < 100, 'camera must not repeatedly measure attached notes');
      }
      console.log(JSON.stringify({ round, ...sample }));
      await page.waitForTimeout(900);
      if (round === 0) {
        await page.screenshot({ path: path.join(dataRoot, 'notes.png') });
        results.idle = {};
        for (const name of ['notes', 'tree-page', 'study', 'focus', 'calendar', 'review', 'cadence']) {
          if (name !== 'notes') await page.locator(`.left-spine [data-action="${name}-view"]`).click();
          await page.waitForTimeout(1200);
          results.idle[name] = await page.evaluate(() => __sampleNotes(false, 600));
        }
        if (!baseline && process.argv[3] === 'regression') results.checks = await regression(page, context, dataRoot);
      }
      assert.deepEqual(errors, [], 'no browser errors');
      await context.close();
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log(output);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode != null ? resolve() : server.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
