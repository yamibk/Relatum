'use strict';
// Isolated real-page rating regression and identical old/new dropdown benchmarks.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-review-performance-'));
const baseline = process.env.RELATUM_REVIEW_BASELINE_REF || 'ef3ae35';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = name => fs.readFileSync(path.join(repo, 'assets', name), 'utf8');
const old = name => execFileSync('git', ['show', baseline + ':assets/' + name], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { baseline, checks: [], menu: [], artifacts: root };
  async function api(route, body) {
    const response = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    await api('/api/review-import', { batchId: 'performance-fixture-0001', duplicateMode: 'skip', skipInvalid: false,
      rows: Array.from({ length: 22 }, (_, i) => ({ sourceRow: i + 1, prompt: 'Performance word ' + i, answer: 'Answer ' + i, notes: '', tags: [] })) });
    await api('/api/review-settings', { scopeMode: 'all', scopeDeckId: '', sessionLimit: 10, orderMode: 'due' });
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    report.environment = { browser: browser.version(), node: process.version, viewport: '1280x900 CSS px, DPR 1', rounds: 3 };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas'); localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN'); localStorage.setItem('canvas:hideSpecialPages', '0');
      localStorage.setItem('canvas:reviewMode:v1', 'scheduled');
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
    const baselinePage = await context.newPage();
    await baselinePage.route('**/review.js', route => route.fulfill({ contentType: 'text/javascript', body: old('review.js') }));
    await baselinePage.route('**/review-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: old('review-controls.js') }));
    await baselinePage.route('**/api/review-mark', async route => { await pause(650); await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"baseline delay"}' }); });
    await baselinePage.goto(url + '/index.html?view=review');
    const baselineRating = baselinePage.locator('[data-action="review-remembered"]');
    await baselinePage.waitForFunction(() => !document.querySelector('[data-action="review-remembered"]').disabled);
    await pause(600); await baselineRating.click(); await pause(260);
    report.ratingBaseline = await baselineRating.evaluate(button => ({ disabled: button.disabled, opacity: getComputedStyle(button).opacity, focused: document.activeElement === button }));
    assert.equal(report.ratingBaseline.disabled, true); assert.equal(report.ratingBaseline.opacity, '0.38');
    await baselinePage.waitForFunction(() => !document.querySelector('[data-action="review-remembered"]').disabled); await baselinePage.close();
    await page.goto(url + '/index.html?view=review');
    const remember = page.locator('[data-action="review-remembered"]'), prompt = page.locator('[data-role="review-prompt"]');
    await remember.waitFor(); await page.waitForFunction(() => !document.querySelector('[data-action="review-remembered"]').disabled);
    await pause(600);
    const first = await prompt.textContent();
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('.review-actions button'));
      const toolbar = Array.from(document.querySelectorAll('[data-action="review-show-free"], [data-action="review-show-scheduled"], [data-action="review-show-library"], [data-role="review-scope-select"]'));
      window.ratingProbe = { root: document.querySelector('[data-role="review-view"]'), buttons, toolbar, removed: 0, offsets: 0 };
      new MutationObserver(records => records.forEach(record => record.removedNodes.forEach(node => {
        if (buttons.some(button => node === button || node.contains?.(button))) ratingProbe.removed++;
      }))).observe(ratingProbe.root, { childList: true, subtree: true });
      const seen = document.querySelector('[data-role="review-seen"]'), getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth').get;
      Object.defineProperty(seen, 'offsetWidth', { get() { ratingProbe.offsets++; return getter.call(this); } });
    });
    let requestCount = 0, release, fail = true;
    await page.route('**/api/review-mark', async route => {
      requestCount++; await new Promise(resolve => { release = resolve; });
      if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'delayed rating failure' }) });
      else await route.continue();
    });
    await page.locator('[data-role="review-draft"]').fill('keep this draft');
    await remember.focus(); await remember.click();
    for (let i = 0; !release && i < 50; i++) await pause(20);
    assert(release, 'rating request intercepted');
    await pause(260);
    report.ratingPending = await remember.evaluate(button => ({ disabled: button.disabled, opacity: getComputedStyle(button).opacity,
      ariaDisabled: button.getAttribute('aria-disabled'), focused: document.activeElement === button,
      sameButtons: ratingProbe.buttons.every(element => element.isConnected), sameRoot: ratingProbe.root === document.querySelector('[data-role="review-view"]') }));
    assert.deepEqual(report.ratingPending, { disabled: false, opacity: '1', ariaDisabled: 'true', focused: true, sameButtons: true, sameRoot: true });
    await page.evaluate(() => {
      for (const action of ['review-remembered', 'review-vague', 'review-forgot', 'review-next']) document.querySelector('[data-action="' + action + '"]').click();
      for (const key of ['1', '2', '3', 'n']) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    assert.equal(requestCount, 1); assert.equal(await prompt.textContent(), first, 'save pending does not advance');
    release(); release = null;
    await page.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.equal(await prompt.textContent(), first); assert.equal(await page.locator('[data-role="review-draft"]').inputValue(), 'keep this draft');
    assert.equal(await page.locator('[data-role="review-seen"]').textContent(), '0');
    fail = false;
    await page.locator('[data-action="review-mark-retry"]').click(); for (let i = 0; !release && i < 50; i++) await pause(20);
    assert(release); release(); release = null;
    await page.waitForFunction(value => document.querySelector('[data-role="review-prompt"]').textContent !== value, first);
    await page.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('[data-role="review-seen"]').textContent(), '1');
    const second = await prompt.textContent();
    await remember.evaluate(button => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      for (const key of ['1', '2', '3']) button.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: '1', isComposing: true, keyCode: 229, bubbles: true }));
    });
    await pause(80); assert.equal(requestCount, 2); assert.equal(await prompt.textContent(), second);
    assert.equal(await page.evaluate(() => ratingProbe.offsets), 0, 'statistic feedback never forces offsetWidth');
    assert.equal(await page.evaluate(() => ratingProbe.removed), 0);
    await page.unroute('**/api/review-mark');
    await page.keyboard.press('Space'); assert(await page.locator('[data-role="review-answer-reveal"]').isVisible());
    await page.keyboard.press('Space'); assert(await page.locator('[data-role="review-answer-reveal"]').isHidden());
    await page.keyboard.press('n'); assert.notEqual(await prompt.textContent(), second);
    for (let i = 0; i < 9; i++) {
      const before = Number(await page.locator('[data-role="review-seen"]').textContent());
      await page.keyboard.press('1');
      await page.waitForFunction(value => Number(document.querySelector('[data-role="review-seen"]').textContent) === value, before + 1);
    }
    assert((await page.locator('[data-role="review-empty"]').textContent()).includes('这一轮完成了'));
    assert(await remember.isDisabled(), 'no remaining card is truly disabled');
    await page.locator('[data-action="review-session-again"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="review-remembered"]').disabled);
    for (let round = 0; round < 2; round++) {
      const count = round === 0 ? 10 : 2;
      for (let i = 0; i < count; i++) {
        const before = Number(await page.locator('[data-role="review-seen"]').textContent()); await remember.click();
        await page.waitForFunction(value => Number(document.querySelector('[data-role="review-seen"]').textContent) === value, before + 1);
      }
      if (round === 0) { await page.locator('[data-action="review-session-again"]').click(); await page.waitForFunction(() => !document.querySelector('[data-action="review-remembered"]').disabled); }
    }
    assert((await page.locator('[data-role="review-empty"]').textContent()).includes('今天的复习做完了'));
    const beforeFree = (await api('/api/review-pool')).reviewedToday;
    await page.locator('[data-action="review-show-free"]').first().click();
    await page.waitForFunction(() => document.querySelector('[data-role="review-content"]').hidden === false);
    const freePrompt = await prompt.textContent(); await page.keyboard.press('1');
    assert(await page.locator('[data-role="review-answer-reveal"]').isVisible());
    await page.keyboard.press('d'); assert.notEqual(await prompt.textContent(), freePrompt);
    assert.equal((await api('/api/review-pool')).reviewedToday, beforeFree, 'free mode writes no rating');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.keyboard.press('d');
    assert.equal(await page.locator('[data-role="review-seen"]').evaluate(element => element.getAnimations().length), 0);
    assert.equal(await page.locator('.review-plus-one').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.keyboard.press('d');
    assert.equal(await page.locator('[data-role="review-seen"]').evaluate(element => element.getAnimations().length), 1);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(await page.locator('[data-role="review-seen"]').evaluate(element => element.getAnimations().length), 0);
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await pause(500);
    assert.equal(await page.evaluate(() => ratingProbe.removed), 0, 'rating and next nodes survive all session states');
    assert(await page.evaluate(() => ratingProbe.toolbar.every(element => element.isConnected)));
    assert(await page.evaluate(() => ratingProbe.toolbar.length >= 4));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, 'review.png') });
    report.checks.push('delayed and failed rating, stable opacity/focus/DOM, duplicate/IME/repeat guards, answer/skip, session limit, last card and free mode');
    await context.close();

    const sources = { baseline: { js: old('review-controls.js'), css: old('review-controls.css') }, current: { js: read('review-controls.js'), css: read('review-controls.css') } };
    async function menuPage(kind, count, viewport = { width: 1280, height: 900 }) {
      const page = await browser.newPage({ viewport });
      await page.setContent('<!doctype html><html><body><div id="owner" style="position:fixed;left:240px;top:120px;width:250px"><select aria-label="Deck"></select></div></body></html>');
      await page.addStyleTag({ content: ':root{--surface:#fff;--text:#202320;--text-secondary:#555;--border:#ddd;--border-strong:#aaa;--font-ui:Arial;--easing-soft:cubic-bezier(.22,1,.36,1)}body{margin:0}' + sources[kind].css });
      await page.addScriptTag({ content: read('windowed-list.js') });
      await page.addScriptTag({ content: sources[kind].js });
      await page.evaluate(count => {
        const select = document.querySelector('select');
        select.append(...Array.from({ length: count }, (_, i) => new Option('Deck ' + String(i).padStart(5, '0'), String(i))));
        window.manager = RelatumReviewControls.createManager(document.querySelector('#owner'));
        const start = performance.now(); window.control = manager.enhance(select);
        window.probe = { prepareMs: performance.now() - start, geometry: 0, computed: 0, frames: 0, peak: 0, live: 0, creates: 0, disposes: 0 };
        const rect = Element.prototype.getBoundingClientRect, computed = window.getComputedStyle, raf = window.requestAnimationFrame, create = RelatumWindowedList.create;
        Element.prototype.getBoundingClientRect = function (...args) { probe.geometry++; return rect.apply(this, args); };
        window.getComputedStyle = (...args) => { probe.computed++; return computed(...args); };
        window.requestAnimationFrame = callback => { probe.frames++; return raf(callback); };
        RelatumWindowedList.create = options => { probe.creates++; const list = create(options), dispose = list.dispose; list.dispose = () => { probe.disposes++; dispose(); }; return list; };
        window.peakObserver = new MutationObserver(records => records.forEach(record => {
          for (const node of record.removedNodes) if (node.nodeType === 1 && node.matches('[role="option"]')) probe.live--;
          for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches('[role="option"]')) probe.live++;
          probe.peak = Math.max(probe.peak, probe.live);
        }));
        peakObserver.observe(document.body, { childList: true, subtree: true });
      }, count);
      return page;
    }
    for (const kind of ['baseline', 'current']) for (const count of [20, 200, 1000, 10000]) {
      const runs = [];
      for (let round = 0; round < 3; round++) {
        const page = await menuPage(kind, count), cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
        const before = await metrics();
        const timing = await page.evaluate(async () => {
          const start = performance.now(); control.open(); const synchronousMs = performance.now() - start;
          const synchronousRows = document.querySelectorAll('[role="option"]').length;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { prepareMs: probe.prepareMs, synchronousMs, synchronousRows, twoFramesMs: performance.now() - start };
        });
        await pause(180); const after = await metrics();
        const opened = await page.evaluate(() => ({ peak: probe.peak, rows: document.querySelectorAll('[role="option"]').length, geometry: probe.geometry, computed: probe.computed }));
        const hover = await page.evaluate(async () => {
          const row = document.querySelectorAll('[role="option"]')[1];
          const move = () => row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, movementX: 1 }));
          move(); await new Promise(requestAnimationFrame);
          const records = [], observer = new MutationObserver(next => records.push(...next));
          observer.observe(document.querySelector('.review-choice-popup'), { attributes: true, subtree: true });
          const start = performance.now(), frames = probe.frames;
          for (let i = 0; i < 200; i++) move();
          const synchronousMs = performance.now() - start;
          await new Promise(resolve => setTimeout(resolve, 40)); observer.disconnect();
          return { synchronousMs, writes: records.length, frames: probe.frames - frames };
        });
        const frames = await page.evaluate(() => probe.frames); await pause(180);
        const idleFrames = await page.evaluate(value => probe.frames - value, frames);
        if (kind === 'current') {
          if (count > 200) assert(opened.peak <= 20, 'first mount uses the constrained viewport: ' + JSON.stringify(opened));
          assert.equal(hover.writes, 0, 'repeated hover on same row does not write attributes'); assert.equal(hover.frames, 0); assert.equal(idleFrames, 0);
        }
        runs.push({ ...timing, ...opened, hover, idleFrames, layoutCount: after.LayoutCount - before.LayoutCount,
          layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 });
        if (kind === 'current' && round === 0) {
          await page.locator('.review-choice-search').fill('Deck ' + String(count - 1).padStart(5, '0'));
          assert.equal(await page.getByRole('option').count(), 1); await page.keyboard.press('Enter');
          assert.equal(await page.locator('select').inputValue(), String(count - 1));
          await page.getByRole('combobox', { name: 'Deck', exact: true }).click();
          await page.getByRole('combobox', { name: 'Deck', exact: true }).focus(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
          assert.equal(await page.locator('select').inputValue(), '0');
          await page.getByRole('combobox', { name: 'Deck', exact: true }).click();
          const area = await page.locator('.review-choice-list').boundingBox();
          await page.mouse.move(area.x + 80, area.y + 80); await page.mouse.wheel(0, 380);
          await page.waitForFunction(() => document.querySelector('.review-choice-list').scrollTop > 50);
          assert((await page.getByRole('option').count()) <= (count > 200 ? 40 : count));
        }
        await page.close();
      }
      report.menu.push({ kind, count, runs });
    }

    const menu = await menuPage('current', 1000);
    await menu.getByRole('combobox', { name: 'Deck', exact: true }).click(); await pause(180);
    const search = menu.locator('.review-choice-search');
    await search.fill('00009'); assert.equal(await menu.getByRole('option').count(), 1);
    assert.deepEqual(await menu.evaluate(() => [probe.creates, probe.disposes]), [1, 0]);
    await search.fill(''); await pause(100); assert((await menu.getByRole('option').count()) < 40);
    const reuse = await menu.evaluate(() => {
      const row = document.querySelector('[role="option"]'), records = [], observer = new MutationObserver(next => records.push(...next));
      observer.observe(document.querySelector('.review-choice-popup'), { attributes: true, childList: true, subtree: true });
      for (let i = 0; i < 20; i++) manager.sync();
      records.push(...observer.takeRecords()); observer.disconnect();
      return { same: row === document.querySelector('[role="option"]'), writes: records.length, creates: probe.creates };
    });
    assert.deepEqual(reuse, { same: true, writes: 0, creates: 1 });
    const refreshed = await menu.evaluate(() => {
      const input = document.querySelector('.review-choice-search'), active = input.getAttribute('aria-activedescendant');
      manager.setOptions(document.querySelector('select'), Array.from({ length: 1000 }, (_, i) => ({ value: String(i), label: 'Deck ' + String(i).padStart(5, '0') + (i === 9 ? ' renamed' : '') })), '0');
      return { sameActive: input.getAttribute('aria-activedescendant') === active, focused: document.activeElement === input, creates: probe.creates };
    });
    assert.deepEqual(refreshed, { sameActive: true, focused: true, creates: 1 });
    const hoverBatch = await menu.evaluate(async () => {
      const rows = document.querySelectorAll('[role="option"]'), records = [], observer = new MutationObserver(next => records.push(...next));
      observer.observe(document.querySelector('.review-choice-popup'), { attributes: true, subtree: true });
      const frames = probe.frames;
      for (let i = 0; i < 200; i++) rows[2 + i % 3].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, movementX: 1 }));
      await new Promise(resolve => setTimeout(resolve, 40)); observer.disconnect();
      return { frames: probe.frames - frames, writes: records.length, active: document.querySelector('.is-highlighted')?.id, expected: rows[3].id };
    });
    assert.equal(hoverBatch.frames, 1); assert(hoverBatch.writes <= 3); assert.equal(hoverBatch.active, hoverBatch.expected);
    report.hoverBatch = hoverBatch;
    await search.evaluate(input => {
      input.value = '00008'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true }));
    });
    assert.equal(await menu.locator('.review-choice-popup').count(), 1); assert((await menu.getByRole('option').count()) > 1);
    await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(await menu.getByRole('option').count(), 1); await menu.keyboard.press('Enter');
    assert.equal(await menu.locator('select').inputValue(), '8');
    await menu.getByRole('combobox', { name: 'Deck', exact: true }).click();
    await menu.keyboard.press('Escape'); assert(await menu.getByRole('combobox', { name: 'Deck', exact: true }).evaluate(element => element === document.activeElement));
    await menu.getByRole('combobox', { name: 'Deck', exact: true }).click();
    await search.fill(''); await search.press('ArrowDown'); await search.press('Enter'); assert.equal(await menu.locator('select').inputValue(), '9');
    await menu.getByRole('combobox', { name: 'Deck', exact: true }).click();
    const list = menu.locator('.review-choice-list'), box = await list.boundingBox();
    await menu.mouse.move(box.x + 80, box.y + 80); await menu.mouse.wheel(0, 720);
    await menu.waitForFunction(() => document.querySelector('.review-choice-list').scrollTop > 400);
    assert((await menu.getByRole('option').count()) < 40, 'real wheel remains windowed');
    await menu.evaluate(() => {
      const rows = document.querySelectorAll('[role="option"]');
      for (const row of rows) row.dispatchEvent(new PointerEvent('pointermove', { movementX: 1, bubbles: true }));
      rows[2].click(); window.clickedValue = rows[2].__choiceKey.slice(6);
    });
    assert.equal(await menu.locator('select').inputValue(), await menu.evaluate(() => clickedValue), 'click wins over queued hover');
    await menu.evaluate(() => {
      const owner = document.querySelector('#owner'); owner.style.top = 'auto'; owner.style.bottom = '10px';
      window.RelatumI18n = { language: 'en' }; document.body.dataset.startTheme = 'dark';
      manager.setOptions(document.querySelector('select'), Array.from({ length: 1000 }, (_, i) => ({ value: String(i), label: '中文 Long deck name ' + i })), '999');
    });
    await menu.setViewportSize({ width: 390, height: 680 });
    await menu.evaluate(() => { document.querySelector('#owner').style.left = '20px'; document.querySelector('#owner').style.width = '350px'; });
    await menu.emulateMedia({ reducedMotion: 'reduce' });
    await menu.getByRole('combobox', { name: 'Deck', exact: true }).click();
    assert(await menu.locator('.review-choice-popup').evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 10 && r.right <= innerWidth - 9 && r.top >= 10 && r.bottom <= innerHeight - 9 && element.classList.contains('opens-up') && element.dataset.startTheme === 'dark' && element.getAnimations().length === 0; }));
    await menu.screenshot({ path: path.join(root, 'dropdown-dark-narrow.png') });
    await menu.keyboard.press('Escape');
    await menu.evaluate(() => { window.extra = document.createElement('div'); extra.style.cssText = 'height:40px;overflow:auto'; extra.innerHTML = '<div style="height:400px"></div>'; document.body.append(extra); control.open(); });
    await pause(180);
    const geometry = await menu.evaluate(() => probe.geometry);
    await menu.evaluate(() => extra.dispatchEvent(new Event('scroll', { bubbles: true }))); await pause(50);
    assert.equal(await menu.evaluate(() => probe.geometry), geometry, 'unrelated scrolling causes no positioning work');
    await menu.evaluate(() => { control.anchor.style.width = '280px'; });
    await menu.waitForFunction(() => document.querySelector('.review-choice-popup').style.width === '280px');
    await menu.evaluate(() => { document.querySelector('select').disabled = true; manager.sync(document.querySelector('select')); });
    assert.equal(await menu.locator('.review-choice-popup').count(), 0, 'targeted disabled sync closes the active control');
    await menu.evaluate(() => { document.querySelector('select').disabled = false; manager.sync(document.querySelector('select')); control.open(); });
    await menu.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(await menu.locator('.review-choice-popup').count(), 0);
    await menu.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; control.open(); window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    assert.equal(await menu.locator('.review-choice-popup').count(), 0);
    await pause(150); const endFrames = await menu.evaluate(() => probe.frames); await pause(180);
    assert.equal(await menu.evaluate(value => probe.frames - value, endFrames), 0);
    await menu.evaluate(() => manager.dispose()); await menu.close();
    const creation = await menuPage('current', 20);
    await creation.evaluate(() => {
      manager.dispose(); const select = document.createElement('select'); select.setAttribute('aria-label', 'Group');
      select.append(new Option('未分组（默认）', ''), new Option('Known group', 'Known group'));
      document.querySelector('#owner').replaceChildren(select); window.manager = RelatumReviewControls.createManager(document.querySelector('#owner'));
      window.control = manager.enhance(select, { searchable: true, allowCreate: true });
    });
    await creation.getByRole('combobox', { name: 'Group', exact: true }).click();
    await creation.locator('.review-choice-search').fill('New group'); await creation.keyboard.press('Enter');
    assert.equal(await creation.locator('select').inputValue(), 'New group', 'default ungrouped does not override typed new deck');
    await creation.close();
    report.checks.push('20/200/1000/10000 options, initial peak, search/list reuse, unchanged sync, IME, keyboard, real wheel, click/hover race, viewport edges, English/Chinese, dark/narrow/reduced motion, unrelated scroll and lifecycle cleanup');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ checks: report.checks, report: path.join(root, 'report.json'), ratingBaseline: report.ratingBaseline, ratingPending: report.ratingPending,
      menu: report.menu.map(item => ({ kind: item.kind, count: item.count, openMs: median(item.runs.map(run => run.synchronousMs)), peak: Math.max(...item.runs.map(run => run.peak)), hoverWrites: item.runs[0].hover.writes })) }, null, 2));
  } catch (error) {
    console.error('artifacts:', root);
    fs.writeFileSync(path.join(root, 'partial-report.json'), JSON.stringify(report, null, 2));
    for (const [i, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) await page.screenshot({ path: path.join(root, 'failure-' + i + '.png') }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
