'use strict';
// Real page, synthetic cards and temporary data only. Baseline assets come from Git.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-review-library-'));
const baseline = process.env.RELATUM_REVIEW_LIBRARY_BASELINE || 'd4fc986';
const rounds = process.argv.includes('--quick') ? 1 : 3;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = name => fs.readFileSync(path.join(repo, 'assets', name), 'utf8');
const old = name => execFileSync('git', ['show', baseline + ':assets/' + name], { cwd: repo, encoding: 'utf8' });
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fixture = count => Array.from({ length: count }, (_, i) => ({
  id: 'audit-' + i, prompt: 'Card ' + String(i).padStart(5, '0'), answer: 'Answer ' + i,
  notes: 'A short explanation. '.repeat(12), status: 'active', deckId: '', deckName: '', tags: ['tag'],
  due: '2026-11-02', reviewCount: 0, maturity: '生',
}));
function instrument(source) {
  assert(source.includes('  window.CanvasReview = {'));
  return source.replaceAll('libraryCards.filter(', '(window.__reviewProbe.scans++, libraryCards).filter(')
    .replace('  window.CanvasReview = {', `  window.__reviewTest = {
      renderLibrary, nextFreeCard, showMode, loadLibrary,
      currentId: () => current?.id,
      scope: (mode, id = '') => { reviewSettings.scopeMode = mode; reviewSettings.scopeDeckId = id; resetFreeSession(); },
    };
  window.CanvasReview = {`);
}

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const bootstrap = 'import app\napp.CanvasServer.request_queue_size=64\napp.main()';
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', bootstrap, '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { baseline, rounds, checks: [], samples: [], artifacts: root };
  const sources = { baseline: { review: instrument(old('review.js')), list: old('windowed-list.js') },
    current: { review: instrument(read('review.js')), list: read('windowed-list.js') } };
  async function open(kind, count, reducedMotion = 'reduce') {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion, timezoneId: 'Asia/Shanghai' });
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas'); localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN'); localStorage.setItem('canvas:reviewMode:v1', 'scheduled');
      localStorage.setItem('canvas:reviewPreferences:v1', JSON.stringify({ hideTextTips: true, autoRevealAnswer: false }));
      window.__reviewProbe = { scans: 0, created: 0, geometry: 0 };
      const create = document.createElement.bind(document);
      document.createElement = (name, ...args) => { if (name === 'article') __reviewProbe.created++; return create(name, ...args); };
    });
    const page = await context.newPage(), errors = [];
    let cards = fixture(count), release;
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/review.js', route => route.fulfill({ contentType: 'text/javascript', body: sources[kind].review }));
    await page.route('**/windowed-list.js', route => route.fulfill({ contentType: 'text/javascript', body: sources[kind].list }));
    await page.route('**/api/review-cards', async route => {
      if (release) await new Promise(resolve => { release.resolve = resolve; });
      await route.fulfill({ json: { cards, count: cards.length, decks: [], tags: [], uncategorizedCount: cards.length } });
    });
    await page.route('**/api/review-card-update', async route => {
      const body = route.request().postDataJSON();
      cards = cards.map(card => card.id === body.id ? { ...card, ...body } : card);
      await route.fulfill({ json: { card: cards.find(card => card.id === body.id) } });
    });
    await page.goto(url + '/index.html?view=review');
    await page.locator('[data-action="review-show-library"]').click();
    await page.locator('.review-library-item').first().waitFor(); await pause(150);
    await page.evaluate(() => {
      const list = document.querySelector('[data-role="review-library-list"]'), rect = list.getBoundingClientRect.bind(list);
      list.getBoundingClientRect = () => { __reviewProbe.geometry++; return rect(); };
    });
    return { page, context, errors, setCards(next) { cards = next; },
      hold() { release = {}; return release; }, unhold() { release.resolve(); release = null; } };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    report.environment = { browser: browser.version(), node: process.version, viewport: '1360x900 CSS px', cpuRates: [1, 4] };
    for (let round = 0; round < rounds; round++) for (const count of [20, 200, 1000, 10000]) {
      for (const kind of (round % 2 ? ['current', 'baseline'] : ['baseline', 'current'])) {
        const { page, context, errors } = await open(kind, count);
        const cdp = await context.newCDPSession(page);
        for (const rate of [1, 4]) {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          const library = await page.evaluate(() => {
            const list = document.querySelector('[data-role="review-library-list"]');
            const refs = Array.from(list.querySelectorAll('.review-library-item'));
            const observer = new MutationObserver(() => {}); observer.observe(list, { childList: true });
            const before = __reviewProbe.created, ms = [];
            for (const query of ['Ca', 'Car', 'Card', 'Card ']) {
              document.querySelector('[data-role="review-search"]').value = query;
              const start = performance.now(); __reviewTest.renderLibrary(false); ms.push(performance.now() - start);
            }
            const removed = observer.takeRecords().flatMap(record => [...record.removedNodes]).filter(node => node.matches?.('.review-library-item')).length;
            observer.disconnect();
            return { ms, created: __reviewProbe.created - before, removed, retained: refs.filter(row => row.isConnected).length, initialRows: refs.length };
          });
          if (kind === 'current') { assert.equal(library.created, 0); assert.equal(library.removed, 0); assert.equal(library.retained, library.initialRows); }
          await page.locator('[data-action="review-show-free"]').click();
          await page.waitForFunction(() => !document.querySelector('[data-role="review-content"]').hidden);
          const free = await page.evaluate(() => {
            for (let i = 0; i < 8; i++) __reviewTest.nextFreeCard();
            __reviewProbe.scans = 0;
            const ms = [];
            for (let i = 0; i < 12; i++) { const start = performance.now(); __reviewTest.nextFreeCard(); ms.push(performance.now() - start); }
            return { ms, scans: __reviewProbe.scans };
          });
          if (kind === 'current') assert.equal(free.scans, 0, 'stable free review does not scan the library');
          await page.locator('[data-action="review-show-library"]').click(); await pause(100);
          report.samples.push({ round, count, kind, rate, library, free });
        }
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await page.locator('[data-action="review-show-scheduled"]').click(); await pause(100);
        const hidden = await page.evaluate(async () => {
          const before = { ...__reviewProbe };
          for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'));
          await new Promise(resolve => setTimeout(resolve, 100));
          return { geometry: __reviewProbe.geometry - before.geometry, created: __reviewProbe.created - before.created };
        });
        if (kind === 'current') assert.deepEqual(hidden, { geometry: 0, created: 0 });
        report.samples[report.samples.length - 1].hidden = hidden;
        assert.deepEqual(errors, []); await context.close();
      }
    }
    report.checks.push(rounds + ' alternating rounds, four library sizes, 1x/4x CPU, same-result row identity, no per-card library scan and no hidden list work');

    const test = await open('current', 1000, 'no-preference'), { page } = test;
    // Preserve focus on both native moveBefore and old WebView2 insertBefore paths.
    for (const fallback of [false, true]) {
      await page.evaluate(fallback => {
        const list = document.querySelector('[data-role="review-library-list"]');
        if (fallback) Object.defineProperty(list, 'moveBefore', { configurable: true, value: undefined });
        const row = list.querySelector('.review-library-item'); window.savedRow = row;
        window.savedButton = row.querySelector('button'); savedButton.focus({ preventScroll: true });
        __reviewTest.renderLibrary(false);
      }, fallback);
      assert(await page.evaluate(() => savedRow.isConnected && document.activeElement === savedButton));
    }
    await page.locator('[data-action="review-batch-mode"]').click();
    await page.locator('[data-role="review-select-all"]').check();
    assert.equal(await page.locator('[data-role="review-selected-count"]').textContent(), '1000');
    await page.locator('[data-role="review-library-list"]').evaluate(list => { list.scrollTop = list.scrollHeight * .65; });
    await pause(150);
    assert(await page.locator('.review-library-item input').evaluateAll(inputs => inputs.every(input => input.checked)));
    const position = await page.locator('[data-role="review-library-list"]').evaluate(list => list.scrollTop);
    await page.locator('[data-action="review-show-scheduled"]').click();
    await page.setViewportSize({ width: 1100, height: 820 });
    await page.locator('[data-action="review-show-library"]').click(); await pause(500);
    assert(Math.abs(await page.locator('[data-role="review-library-list"]').evaluate(list => list.scrollTop) - position) < 200, 'resume retains the reading region');

    // Cross the 200-row threshold, then edit a retained row through the real dialog.
    await page.locator('[data-role="review-search"]').fill('Card 001'); await pause(150);
    assert.equal(await page.locator('.review-library-item').count(), 100);
    await page.locator('[data-role="review-search"]').fill('Card'); await pause(150);
    assert(await page.locator('.review-library-item').count() < 40);
    await page.locator('[data-role="review-library-list"]').evaluate(list => { list.scrollTop = 0; }); await pause(100);
    await page.evaluate(() => { window.editedRow = document.querySelector('.review-library-item'); window.editedId = editedRow.dataset.cardId; });
    await page.locator('.review-library-item button').first().click();
    await page.locator('[data-role="review-card-form"] textarea[name="prompt"]').fill('Card edited');
    await page.locator('[data-role="review-card-save"]').click();
    await page.waitForFunction(() => editedRow.querySelector('strong').textContent === 'Card edited');
    assert(await page.evaluate(() => editedRow.isConnected && document.querySelector('[data-card-id="' + editedId + '"]') === editedRow));

    // A response arriving while hidden updates only the model; restore renders once.
    const held = test.hold();
    await page.evaluate(() => { window.pendingReload = __reviewTest.loadLibrary(true, false); });
    for (let i = 0; !held.resolve && i < 50; i++) await pause(20);
    assert(held.resolve); await page.locator('[data-action="review-show-scheduled"]').click();
    test.setCards(fixture(300));
    const createdBefore = await page.evaluate(() => __reviewProbe.created);
    test.unhold(); await page.evaluate(() => pendingReload);
    assert.equal(await page.evaluate(() => __reviewProbe.created), createdBefore);
    await page.locator('[data-action="review-show-library"]').click();
    assert.equal(await page.locator('[data-role="review-library-count"]').textContent(), '300');
    await page.locator('[data-role="review-search"]').fill('Card 00001');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await pause(150);
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => document.querySelectorAll('.review-library-item').length === 1);
    await page.locator('[data-role="review-search"]').fill('Card'); await pause(150);
    assert(await page.locator('[data-role="review-library-list"]').evaluate(list => list.classList.contains('is-windowed-list')));
    for (const event of ['visibilitychange', 'pagehide', 'workspace']) {
      const before = await page.evaluate(() => ({ ...__reviewProbe }));
      await page.evaluate(event => {
        if (event === 'visibilitychange') Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        if (event === 'workspace') {
          document.body.dataset.startWorkspace = 'notes';
          document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'notes' } }));
        } else (event === 'pagehide' ? window : document).dispatchEvent(new Event(event));
        window.dispatchEvent(new Event('resize'));
      }, event);
      await pause(100);
      assert.equal(await page.evaluate(() => __reviewProbe.geometry), before.geometry);
      await page.evaluate(event => {
        if (event === 'visibilitychange') { delete document.hidden; document.dispatchEvent(new Event(event)); }
        else if (event === 'workspace') {
          document.body.dataset.startWorkspace = 'canvas';
          document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'canvas' } }));
        }
        else window.dispatchEvent(new Event('pageshow'));
      }, event);
    }
    await page.locator('.left-spine [data-action="notes-view"]').click();
    await page.waitForFunction(() => document.querySelector('[data-role="review-view"]').getAttribute('aria-hidden') === 'true');
    const beforeLeave = await page.evaluate(() => ({ ...__reviewProbe }));
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await pause(100);
    assert.equal(await page.evaluate(() => __reviewProbe.geometry), beforeLeave.geometry);
    await page.locator('.left-spine [data-action="review-view"]').click();
    await page.waitForFunction(() => document.querySelector('[data-role="review-view"]').getAttribute('aria-hidden') === 'false');
    await pause(150);
    assert(await page.locator('.review-library-item').count() > 0);
    await page.evaluate(() => {
      document.querySelector('.left-spine [data-action="notes-view"]').click();
      document.querySelector('.left-spine [data-action="review-view"]').click();
    });
    await pause(150);
    assert(await page.locator('.review-library-item').count() > 0);
    await page.locator('[data-role="review-search"]').fill('Card'); await pause(150);
    await page.locator('[data-action="review-show-free"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="review-content"]').hidden);
    const cycle = await page.evaluate(() => {
      __reviewTest.scope('all'); const ids = [];
      for (let i = 0; i < 301; i++) { __reviewTest.nextFreeCard(); ids.push(__reviewTest.currentId()); }
      return ids;
    });
    assert.equal(new Set(cycle.slice(0, 300)).size, 300); assert.notEqual(cycle[299], cycle[300]);
    const scoped = fixture(3); scoped[0].deckId = 'one'; scoped[1].status = 'suspended';
    test.setCards(scoped); await page.evaluate(() => __reviewTest.loadLibrary(true, false));
    assert.equal(await page.evaluate(() => { __reviewTest.scope('deck', 'one'); __reviewTest.nextFreeCard(); return __reviewTest.currentId(); }), 'audit-0');
    assert.equal(await page.evaluate(() => { __reviewTest.scope('unfiled'); __reviewTest.nextFreeCard(); return __reviewTest.currentId(); }), 'audit-2');
    assert.deepEqual(test.errors, []);
    await page.screenshot({ path: path.join(root, 'review-library.png') }); await test.context.close();
    report.checks.push('focus including older WebView2, selection across unmounted rows, deep scroll/resize, 200-row threshold, dialog edit, late hidden response, pending filter/minimize/visibility/workspace/pagehide, leave/rapid return, shuffle cycles, source/status/scope invalidation');

    // Shared list: focused input, selection, height remeasurement and suspended updates.
    const shared = await browser.newPage();
    await shared.setContent('<div id="list" style="height:240px;overflow:auto;display:grid;align-content:start"></div>');
    await shared.addScriptTag({ content: read('windowed-list.js') });
    const sharedResult = await shared.evaluate(async () => {
      const host = document.querySelector('#list'), items = Array.from({ length: 500 }, (_, id) => ({ id }));
      let geometry = 0, builds = 0;
      const rect = host.getBoundingClientRect.bind(host); host.getBoundingClientRect = () => { geometry++; return rect(); };
      const list = RelatumWindowedList.create({ host, key: item => item.id, estimate: 40, reuseRows: true,
        render(item) { builds++; const row = document.createElement('div'); row.style.height = '40px'; const input = document.createElement('input'); input.value = String(item.id); row.append(input); return row; } });
      list.setItems(items); await new Promise(resolve => setTimeout(resolve, 80));
      const input = host.querySelector('input'); input.focus(); input.setSelectionRange(0, 1);
      host.scrollTop = 1200; await new Promise(resolve => setTimeout(resolve, 80));
      const pinned = input.isConnected && input === document.activeElement;
      list.suspend(); const before = { geometry, builds };
      for (const row of host.children) if (row.querySelector('input')) row.style.height = '60px';
      list.setItems(items); window.dispatchEvent(new Event('resize')); await new Promise(resolve => setTimeout(resolve, 80));
      const hidden = { geometry: geometry - before.geometry, builds: builds - before.builds };
      list.resume(); await new Promise(resolve => setTimeout(resolve, 120));
      const resumed = geometry > before.geometry && input === document.activeElement && input.selectionEnd === 1;
      list.dispose(); list.resume(); return { pinned, hidden, resumed };
    });
    assert.deepEqual(sharedResult, { pinned: true, hidden: { geometry: 0, builds: 0 }, resumed: true });
    await shared.close(); report.checks.push('shared list focused input/selection, suspended ResizeObserver and setItems, fresh height measurements and disposed resume');
    report.summary = [];
    for (const count of [20, 200, 1000, 10000]) for (const kind of ['baseline', 'current']) for (const rate of [1, 4]) {
      const samples = report.samples.filter(sample => sample.count === count && sample.kind === kind && sample.rate === rate);
      report.summary.push({ count, kind, rate, libraryMs: median(samples.flatMap(sample => sample.library.ms)),
        created: samples[0].library.created, removed: samples[0].library.removed,
        freeMs: median(samples.flatMap(sample => sample.free.ms)), scans: samples[0].free.scans, hidden: samples.at(-1).hidden });
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: report.checks, summary: report.summary, report: path.join(root, 'report.json') }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'partial-report.json'), JSON.stringify(report, null, 2));
    for (const [i, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) await page.screenshot({ path: path.join(root, 'failure-' + i + '.png') }).catch(() => {});
    console.error('artifacts:', root); throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
