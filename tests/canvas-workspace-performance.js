'use strict';

// Optional acceptance against a disposable server. Browser libraries are test-host only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePage, openCanvas } = require('./canvas-browser-performance.js');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

async function canvasChecks(browser, config) {
  const report = [];
  for (const [fixture, count] of [['perf-edges', 1200], ['perf-3000', 3000]]) {
    const page = await makePage(browser, { protectFixtures: true });
    await page.context().addInitScript(() => localStorage.setItem('canvas:panInertia', '0'));
    try {
      await openCanvas(page, config, fixture);
      await page.waitForTimeout(300);
      report.push(await page.evaluate(async count => {
        const frame = () => new Promise(requestAnimationFrame);
        const viewport = document.querySelector('.canvas-viewport');
        const surface = document.querySelector('.canvas-surface');
        const initialPan = new DOMMatrix(surface.style.transform).e;
        const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
        let paints = 0;
        let viewportReads = 0;
        const measure = viewport.getBoundingClientRect;
        viewport.getBoundingClientRect = function () { viewportReads++; return measure.call(this); };
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
          if (this.canvas.matches('.canvas-edges-canvas')) paints++;
          return clear.apply(this, args);
        };
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        mouse(viewport, 'mousedown', 720, 400);
        const started = performance.now();
        for (let i = 1; i <= 120; i++) mouse(window, 'mousemove', 720 + i, 400);
        const panJs = performance.now() - started, synchronousPaints = paints;
        await frame();
        const framedPaints = paints;
        mouse(window, 'mouseup', 850, 400); // Up has a new final coordinate.
        const finalTransform = surface.style.transform;
        if (Math.abs(new DOMMatrix(finalTransform).e - initialPan - 130) > .01) throw Error('pan up must submit its final coordinate');
        window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
        const panViewportReads = viewportReads;
        viewport.getBoundingClientRect = measure;
        CanvasRenderingContext2D.prototype.clearRect = clear;
        let toggles = 0, events = 0;
        const toggle = DOMTokenList.prototype.toggle;
        DOMTokenList.prototype.toggle = function (name, ...rest) { if (name === 'selected') toggles++; return toggle.call(this, name, ...rest); };
        const changed = () => events++;
        document.addEventListener('editor:selectionchange', changed);
        mouse(viewport, 'mousedown', 1100, 700);
        mouse(window, 'mousemove', 1250, 760); await frame();
        const firstEvents = events;
        for (let i = 0; i < 12; i++) { mouse(window, 'mousemove', 1250, 760); await frame(); }
        const repeatedEvents = events - firstEvents;
        mouse(window, 'mouseup', 1250, 760);
        document.removeEventListener('editor:selectionchange', changed);
        DOMTokenList.prototype.toggle = toggle;
        const nodeEl = document.querySelector('.node'), nodeRect = nodeEl.getBoundingClientRect(), originalPosition = nodeEl.style.transform;
        mouse(nodeEl, 'mousedown', nodeRect.x + 10, nodeRect.y + 10);
        mouse(window, 'mousemove', nodeRect.x + 60, nodeRect.y + 20);
        window.dispatchEvent(new Event('blur'));
        await frame(); await frame();
        if (nodeEl.style.transform !== originalPosition || nodeEl.classList.contains('dragging')) throw Error('blur must cancel pending node paint');
        const histories = [];
        for (const points of [50000, 200000, 500000]) {
          __testData.ink = { version: 1, strokes: Array.from({ length: points / 500 }, (_, s) => ({ id: 'ink-' + s,
            points: Array.from({ length: 500 }, (_, p) => ({ x: p, y: s * 8 + p % 3, p: .6, tilt: .2 })) })), arrows: [] };
          CanvasModule.pushHistory(); // Deliberate compatibility snapshot: establish this fixture.
          let inkReads = 0;
          __testData.ink.strokes.forEach(stroke => {
            const original = stroke.points;
            Object.defineProperty(stroke, 'points', { configurable: true, get() { inkReads++; return original; } });
          });
          const values = [];
          for (let i = 0; i < 5; i++) {
            __testData.nodes[0].x++;
            const start = performance.now();
            CanvasModule.pushHistory({ nodes: true, edges: true });
            values.push(performance.now() - start);
          }
          const beforeUndo = inkReads;
          __testApi.undo(); __testApi.redo();
          histories.push({ points, values, inkReads, beforeUndo });
        }
        return { count, pan: { events: 120, synchronousPaints, framedPaints, viewportReads: panViewportReads, jsMs: panJs, finalTransform },
          selection: { moves: 12, toggles, repeatedEvents }, histories };
      }, count));
      const last = report.at(-1);
      assert.equal(last.pan.synchronousPaints, 0);
      assert.equal(last.pan.framedPaints, 1);
      assert(last.pan.viewportReads <= 2, 'pan must reuse viewport measurements after gesture start');
      assert.equal(last.selection.repeatedEvents, 0);
      assert(last.selection.toggles < count * 2);
      last.histories.forEach(item => assert.equal(item.inkReads, 0, 'ordinary history/undo must not visit unrelated ink'));
      assert.deepEqual(page.testErrors, []);
    } finally { await page.context().close(); }
  }
  return report;
}

async function listChecks(browser, config) {
  const reports = [];
  for (const count of [2000, 10000]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: count === 10000 ? 2 : 1,
      reducedMotion: count === 10000 ? 'reduce' : 'no-preference' });
    await context.addInitScript(count => {
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN'); localStorage.setItem('canvas:librarySearchEnabled', '1');
      localStorage.setItem('canvas:startBackgroundStyle', 'scenic');
      localStorage.setItem('canvas:startTheme', count === 10000 ? 'dark' : 'light');
    }, count);
    const files = Array.from({ length: count }, (_, i) => ({ path: config.root + '/canvases/synthetic-' + i + '.canvas',
      title: '测试画布 ' + i, exists: true, lastOpenedAt: new Date(Date.now() - i * 1000).toISOString(), groupId: '', favorite: false }));
    const cards = Array.from({ length: count }, (_, i) => ({ id: String(i), prompt: '测试卡片 ' + i, answer: '答案 '.repeat(i % 30 + 1),
      notes: '', status: 'active', deckId: null, level: 0, dueDate: '2026-10-09', tags: [] }));
    await context.route('**/api/recent', route => route.fulfill({ json: { files, groups: [], recentLimit: count } }));
    await context.route('**/api/file-stats', route => route.fulfill({ json: { files: [] } }));
    await context.route('**/api/review-cards*', route => route.fulfill({ json: { cards, decks: [], uncategorizedCount: count } }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(config.url + '/index.html');
      await page.waitForSelector('.recent-list.is-windowed-list .recent-item').catch(async error => {
        console.error(JSON.stringify({ errors, state: await page.evaluate(() => ({ state: document.body.dataset.startState, workspace: document.body.dataset.startWorkspace,
          lists: [...document.querySelectorAll('.recent-list')].map(el => ({ cls: el.className, html: el.innerHTML.slice(0, 500) })) })) }));
        throw error;
      });
      await page.waitForTimeout(600); // Finish the initial book/page reveal before pointer checks.
      const decoration = await page.evaluate(() => {
        const orb = document.querySelector('.spine-active-orb'); orb.classList.add('orb-breathing');
        const result = { theme: document.body.dataset.startTheme, dpr: devicePixelRatio,
          ambient: getComputedStyle(document.body, '::before').animationName,
          topBlur: getComputedStyle(document.querySelector('.top-bar'), '::before').backdropFilter,
          orbIterations: getComputedStyle(orb).animationIterationCount };
        orb.classList.remove('orb-breathing'); return result;
      });
      assert.equal(decoration.ambient, 'none'); assert.equal(decoration.topBlur, 'none'); assert.equal(decoration.orbIterations, '1');
      const fileRows = await page.locator('.recent-item').count();
      assert(fileRows < 100);
      await page.locator('.book-stage').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(count => [...document.querySelectorAll('.recent-item')].some(el => el.dataset.path.includes('synthetic-' + (count - 1))), count);
      assert(await page.locator('.recent-item').count() < 100);
      const lastFile = page.locator('.recent-item').last();
      await lastFile.click({ button: 'right' });
      await page.locator('[data-role="context-menu"] button').filter({ hasText: /^重命名$/ }).click();
      assert.equal(await page.locator('.recent-rename-input').count(), 1);
      {
        const input = page.locator('.recent-rename-input');
        if (count === 2000) await page.locator('.recent-list').evaluate(host => { host.moveBefore = undefined; });
        await input.fill('中文候选测试');
        await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })));
        await page.locator('.book-stage').evaluate(el => { el.scrollTop = 0; });
        await page.waitForTimeout(100);
        assert.equal(await input.count(), 1);
        assert.equal(await input.inputValue(), '中文候选测试');
        assert(await input.evaluate(el => el === document.activeElement), 'scrolling must preserve the rename editor focus');
        await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
        await page.keyboard.press('Escape');
      }
      await page.locator('.left-spine [data-action="review-view"]').click();
      await page.locator('[data-action="review-show-library"]').click();
      await page.waitForSelector('.review-library-item');
      assert(await page.locator('.review-library-item').count() < 100);
      await page.locator('[data-role="review-search"]').fill('测试');
      await page.waitForTimeout(350);
      const reviewRows = await page.locator('.review-library-item').count();
      assert(reviewRows < 100);
      await page.locator('[data-role="review-library-list"]').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(count => !!document.querySelector('.review-library-item[data-card-id="' + (count - 1) + '"]'), count);
      await page.locator('[data-role="review-batch-mode"]').click();
      await page.locator('[data-role="review-select-visible"]').click();
      const selected = await page.locator('[data-role="review-selected-count"]').textContent();
      assert(selected.includes(String(count)), 'batch selection must include unmounted matching cards');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      reports.push({ count, fileRows, reviewRows, selected, decoration, domNodes: await page.locator('*').count(), heapBytes: metrics.JSHeapUsedSize });
      await page.setViewportSize({ width: 680, height: 650 });
      await page.waitForTimeout(150);
      assert(await page.locator('.review-library-item').count() < 100, 'narrow viewport must remain windowed');
      await page.evaluate(async () => {
        const host = document.createElement('div'); host.style.cssText = 'position:fixed;top:100px;left:100px;width:250px;height:246px;overflow:auto;z-index:2000';
        document.body.append(host);
        const list = RelatumWindowedList.create({ host, key: item => item.id, estimate: 60,
          render: item => { const row = document.createElement('div'); row.dataset.index = item.id; row.style.height = (40 + item.id % 5 * 10) + 'px'; return row; } });
        list.setItems(Array.from({ length: 1000 }, (_, id) => ({ id })));
        const settle = () => new Promise(resolve => setTimeout(resolve, 80));
        await settle(); host.scrollTop = 400; await settle();
        const row = list.row(5), before = host.scrollTop;
        if (!row) throw Error('expected overscan height probe');
        row.style.height = (parseFloat(row.style.height) + 40) + 'px';
        await settle();
        if (Math.abs(host.scrollTop - before - 40) > 1) throw Error('variable row measurement must preserve the visible scroll anchor');
        list.dispose(); host.remove();
      });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  return reports;
}

async function noteChecks(browser, config) {
  const reports = [];
  for (const count of [96, 500]) {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('canvas:notesInertia', '0'));
    const notes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, x: 32 + i % 12 * 246, y: 32 + Math.floor(i / 12) * 210,
      text: '记录 ' + i, color: 'yellow', rotate: 0 }));
    const edges = Array.from({ length: count * 2 }, (_, i) => ({ id: 'e' + i, from: 'n' + (i % count), to: 'n' + ((i + 1) % count) }));
    await context.route('**/api/notes', route => route.fulfill({ json: { notes, edges, arrows: [] } }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(config.url + '/index.html');
      await page.locator('.left-spine [data-action="notes-view"]').click();
      await page.waitForFunction(count => document.querySelectorAll('.sticky-note').length === count, count);
      await page.waitForTimeout(800);
      reports.push(await page.evaluate(async count => {
        const el = document.querySelector('.sticky-note'), rect = el.getBoundingClientRect();
        const get = Element.prototype.getBoundingClientRect;
        let reads = 0;
        Element.prototype.getBoundingClientRect = function () { if (this.matches('.sticky-note')) reads++; return get.call(this); };
        const pointer = (type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: rect.y + 30, pointerId: 1, button: 0 }));
        pointer('pointerdown', rect.x + 30);
        const started = performance.now();
        for (let i = 1; i <= 60; i++) pointer('pointermove', rect.x + 30 + i);
        const jsMs = performance.now() - started;
        await new Promise(requestAnimationFrame);
        const dragReads = reads;
        pointer('pointerup', rect.x + 94);
        Element.prototype.getBoundingClientRect = get;
        return { count, events: 60, noteRects: dragReads, jsMs };
      }, count));
      assert(reports.at(-1).noteRects < 10, 'drag must measure its affected note only');
      await page.evaluate(async () => {
        const frame = () => new Promise(requestAnimationFrame);
        let note = document.querySelector('.sticky-note');
        const id = note.dataset.id, before = [note.style.left, note.style.top], rect = note.getBoundingClientRect();
        const event = (target, type, x, y, button = 0) => target.dispatchEvent(new PointerEvent(type, { bubbles: true,
          clientX: x, clientY: y, pointerId: 7, button }));
        event(note, 'pointerdown', rect.x + 30, rect.y + 30);
        event(note, 'pointermove', rect.x + 130, rect.y + 40);
        window.dispatchEvent(new Event('blur'));
        await frame(); await frame();
        note = document.querySelector('.sticky-note[data-id="' + id + '"]');
        if (note.style.left !== before[0] || note.style.top !== before[1]) throw Error('blur must cancel a pending note drag');
        const surface = document.querySelector('.notes-surface'), path = document.querySelector('.notes-arrow-temp');
        let writes = 0;
        const set = path.setAttribute;
        path.setAttribute = function (key, value) { if (key === 'd') writes++; return set.call(this, key, value); };
        event(surface, 'pointerdown', 1100, 620, 2); writes = 0;
        for (let i = 0; i < 80; i++) event(window, 'pointermove', 1100 + i, 620 + i / 4, 2);
        if (writes) throw Error('arrow preview painted before its display frame');
        await frame();
        if (writes !== 1) throw Error('arrow preview must merge latest position');
        event(window, 'pointermove', 1170, 650, 2); CanvasNotes.deactivate();
        const settled = writes; await frame(); await frame();
        if (writes !== settled || surface.classList.contains('arrowing')) throw Error('leaving must discard a pending arrow frame');
        path.setAttribute = set;
      });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  return reports;
}

async function starChecks(browser, config) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(config.url + '/index.html');
    const results = await page.evaluate(async () => {
      const results = [];
      for (const leaves of [100, 300, 600]) {
        const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:100px;z-index:1000'; document.body.append(host);
        const started = performance.now();
        const graph = StudyGraph.mount(host, { months: [{ month: '2026-10', total: leaves, named: Array.from({ length: leaves }, (_, i) => ({ title: '任务 ' + i })) }] });
        const mountMs = performance.now() - started;
        let heartbeats = 0;
        const timer = setInterval(() => heartbeats++, 10);
        await new Promise(resolve => setTimeout(resolve, 450));
        graph.setActive(false);
        graph.setActive(true);
        graph.destroy(); host.remove(); clearInterval(timer);
        results.push({ leaves, mountMs, heartbeats });
      }
      return results;
    });
    assert.deepEqual(errors, []);
    return results;
  } finally { await page.close(); }
}

async function saveFailureChecks(browser, config) {
  const page = await makePage(browser, { protectFixtures: true });
  let fail = true;
  const requests = [];
  await page.route('**/api/save', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: '保存失败' } : { ok: true } });
  });
  try {
    await openCanvas(page, config, 'perf-interactions');
    const expected = await page.evaluate(() => {
      const node = CanvasModule.findNode('a'); node.x += 7;
      CanvasModule.pushHistory(); __testApi.undo(); __testApi.redo();
      return node.x;
    });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('[data-role="save-state"]').textContent.includes('保存失败'));
    assert.equal(await page.evaluate(() => CanvasModule.findNode('a').x), expected);
    await page.evaluate(() => { __testApi.undo(); __testApi.redo(); });
    fail = false;
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('[data-role="save-state"]').textContent.includes('已保存'));
    assert.equal(requests.at(-1).data.nodes.find(n => n.id === 'a').x, expected);
    assert.deepEqual(page.testErrors, []);
    return { failedWriteRetained: true, undoRedoAfterFailure: true, retrySavedLatest: true };
  } finally { await page.context().close(); }
}

async function main() {
  const [url, root, output] = process.argv.slice(2);
  assert(url && root && output, 'usage: <isolated server URL> <data root> <report.json>');
  const realRoot = fs.realpathSync(root), repo = fs.realpathSync(path.resolve(__dirname, '..'));
  assert(realRoot !== repo && !realRoot.startsWith(repo + path.sep));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
  try {
    const config = { url, root: realRoot };
    const report = { browser: browser.version(), canvas: await canvasChecks(browser, config), lists: await listChecks(browser, config),
      notes: await noteChecks(browser, config), star: await starChecks(browser, config), save: await saveFailureChecks(browser, config) };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Canvas workspace report: ' + output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
