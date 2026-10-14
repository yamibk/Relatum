'use strict';

// Real workspace transitions with disposable Markdown and browser preferences.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-scroll-'));
fs.mkdirSync(path.join(root, 'notes'));
const table = '| Alpha | Beta |\n| --- | --- |\n| apple | 苹果 |\n| ddd |  |\n|  |  |';
const prose = Array.from({ length: 60 }, (_, i) => '正文 ' + i + (i % 7 === 0 ? ' a'.repeat(30) : '')).join('\n');
const content = '前文\n\n' + table + '\n\n' + prose + '\n\n' + table + '\n\n' + prose;
fs.writeFileSync(path.join(root, 'notes/Tables.md'), content);
fs.writeFileSync(path.join(root, 'notes/Prose.md'), prose + '\n\n' + prose + '\n\n' + prose);

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, reducedMotion: 'no-preference' });
    const page = await context.newPage(), errors = [], results = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    if (process.argv.includes('--baseline')) {
      const css = execFileSync('git', ['show', (process.env.RELATUM_NOTE_SCROLL_BASELINE || 'acf9484') + ':assets/styles.css'], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      await page.route('**/styles.css*', route => route.fulfill({ contentType: 'text/css', body: css }));
    }
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Tables.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Tables.md');
      localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    });
    const scroller = () => page.evaluate(() => T.state.viewMode === 'reading' ? document.querySelector('[data-role="note-reading-view"]').scrollTop : T.editor.view.scrollDOM.scrollTop);
    await page.goto(url); await page.waitForFunction(() => window.T?.state.current?.path === 'Tables.md' && T.state.active);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.trace = [];
      window.phase = '';
      window.record = (kind, extra = {}) => {
        if (!phase) return;
        const view = T.editor.view, scroller = view.scrollDOM, v = view.viewState;
        trace.push({ kind, phase, t: Math.round(performance.now()), top: scroller.scrollTop, height: scroller.scrollHeight,
          y: view.contentDOM.getBoundingClientRect().top, scale: v.scaleY, anchor: v.scrollAnchorPos, anchorHeight: v.scrollAnchorHeight, ...extra });
      };
      let prototype = Element.prototype;
      while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'scrollTop')) prototype = Object.getPrototypeOf(prototype);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop');
      Object.defineProperty(prototype, 'scrollTop', { ...descriptor, set(value) {
        if (this === T.editor.view.scrollDOM) record('write', { target: value, stack: new Error().stack.split('\n').slice(2, 5).join('\n') });
        descriptor.set.call(this, value);
      } });
      T.editor.view.scrollDOM.addEventListener('scroll', () => record('scroll'), { passive: true });
      const view = T.editor.view, measure = view.measure;
      view.measure = function (...args) { record('measure-before'); const result = measure.apply(this, args); record('measure-after'); return result; };
      view.dom.addEventListener('focusin', () => record('focus'));
    });
    for (const note of process.argv.includes('--extended-only') ? [] : ['Tables.md', 'Prose.md']) {
      await page.evaluate(note => T.openNote(note), note); await page.waitForTimeout(1200);
      for (let round = 0; round < 3; round++) {
        await page.evaluate(() => { T.editor.view.scrollDOM.scrollTop = 500; }); await page.waitForTimeout(300);
        const before = await page.evaluate(() => T.editor.view.scrollDOM.scrollTop);
        await page.evaluate(() => { trace = []; phase = 'leave'; record('start'); });
        await page.locator('button[data-start-workspace="canvas"]').click();
        await page.waitForFunction(() => RelatumStartWorkspace.current === 'canvas' && !T.state.active);
        await page.waitForTimeout(850);
        await page.evaluate(() => { phase = 'return'; record('return-start'); });
        await page.locator('button[data-start-workspace="notes"]').click();
        await page.waitForFunction(() => RelatumStartWorkspace.current === 'notes' && T.state.active);
        await page.waitForTimeout(4500);
        // A quiet editor may keep animation-time geometry until a later legitimate
        // measurement. Trigger that public path to expose the delayed correction.
        await page.evaluate(() => { phase = 'delayed-measure'; T.editor.view.requestMeasure(); });
        await page.waitForTimeout(400);
        const result = await page.evaluate(({ note, round, before }) => { record('final'); phase = ''; return { note, round, before, after: T.editor.view.scrollDOM.scrollTop, trace }; }, { note, round, before });
        results.push(result); fs.writeFileSync(path.join(root, 'scroll-report.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ note, round, before, after: result.after,
          scrolls: result.trace.filter(item => item.kind === 'scroll').map(item => [item.t - result.trace[0].t, item.top]) }));
        if (!process.argv.includes('--diagnose')) {
          assert(Math.abs(result.after - before) <= 1, 'return keeps the prose viewport');
          assert(result.trace.filter(item => item.kind === 'scroll').every(item => Math.abs(item.top - before) <= 1), 'no transient scroll jump');
          assert(result.trace.filter(item => item.phase === 'return' && item.height).every(item => Math.abs(item.scale - 1) < .002), 'animation never changes the editor measurement scale');
        }
      }
    }
    // Cover an actual drag-selected grid, alternate rendering modes, fractional
    // pixels and a fast reversal; none of these need a scroll lock in production.
    for (const scenario of ['selected-grid', 'source', 'reading', 'fractional', 'rapid-return', 'reduced-motion']) {
      await page.emulateMedia({ reducedMotion: scenario === 'reduced-motion' ? 'reduce' : 'no-preference' });
      await page.setViewportSize(scenario === 'fractional' ? { width: 1103, height: 827 } : { width: 1280, height: 850 });
      await page.evaluate(mode => T.setViewMode(mode), ['source', 'reading'].includes(scenario) ? scenario : 'live');
      await page.evaluate(() => T.openNote('Tables.md')); await page.waitForTimeout(900);
      await page.evaluate(() => {
        const area = T.state.viewMode === 'reading' ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
        area.scrollTop = 500;
      });
      if (scenario === 'selected-grid') {
        await page.evaluate(() => { T.editor.view.scrollDOM.scrollTop = 1700; }); await page.waitForTimeout(400);
        await page.locator('.note-table').last().scrollIntoViewIfNeeded();
        const grid = page.locator('.note-table').last(), first = await grid.locator('[data-table-row="0"][data-table-col="0"]').boundingBox();
        const last = await grid.locator('[data-table-row="2"][data-table-col="0"]').boundingBox();
        await page.mouse.move(first.x + 20, first.y + first.height / 2); await page.mouse.down();
        await page.mouse.move(last.x + 20, last.y + last.height / 2, { steps: 5 }); await page.mouse.up();
        assert.equal(await grid.locator('td[aria-selected="true"]').count(), 3, 'fixture uses a real grid selection');
      }
      await page.waitForTimeout(600);
      const before = await scroller(), original = await page.evaluate(() => T.editor.snapshot().value);
      await page.evaluate(() => { trace = []; phase = 'leave'; record('start'); window.retainedView = T.editor.view; });
      await page.locator('button[data-start-workspace="canvas"]').click();
      await page.waitForFunction(() => RelatumStartWorkspace.current === 'canvas' && !T.state.active);
      if (scenario !== 'rapid-return') await page.waitForTimeout(700);
      await page.evaluate(() => { phase = 'return'; });
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => RelatumStartWorkspace.current === 'notes' && T.state.active);
      await page.waitForTimeout(2400);
      await page.evaluate(() => { phase = 'delayed-measure'; T.editor.view.requestMeasure(); }); await page.waitForTimeout(300);
      const after = await scroller();
      const result = await page.evaluate(({ scenario, before, after }) => { record('final'); phase = ''; return { scenario, before, after, trace }; }, { scenario, before, after });
      results.push(result); fs.writeFileSync(path.join(root, 'scroll-report.json'), JSON.stringify(results, null, 2));
      if (!process.argv.includes('--diagnose')) assert(Math.abs(after - before) <= 1, scenario + ' preserves the viewport');
      assert(await page.evaluate(() => T.editor.view === retainedView), 'workspace handoff keeps the native editor');
      assert.equal(await page.evaluate(() => T.editor.snapshot().value), original, 'workspace handoff does not alter Markdown');
      const areaBox = await page.locator(scenario === 'reading' ? '[data-role="note-reading-view"]' : '.note-live-editor-host .cm-scroller').boundingBox();
      await page.mouse.move(areaBox.x + 8, areaBox.y + areaBox.height / 2); await page.mouse.wheel(0, after > 160 ? -150 : 150);
      await page.waitForTimeout(200);
      const moved = await scroller();
      assert(Math.abs(moved - after) > 50, 'normal scrolling is not locked: ' + JSON.stringify({ scenario, after, moved }));
      console.log(JSON.stringify({ scenario, before, after }));
    }
    assert.deepEqual(errors, [], 'no browser errors');
    const report = path.join(root, 'scroll-report.json'); fs.writeFileSync(report, JSON.stringify(results, null, 2));
    console.log('note scroll browser: ok; report: ' + report);
    await context.close();
  } finally { await browser?.close(); service.kill(); console.log('Isolated fixtures: ' + root); }
})().catch(error => { console.error(error); process.exitCode = 1; });
