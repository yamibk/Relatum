'use strict';
// Actual UI and HTTP with an isolated data root; no production preferences or cards.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-review-preferences-'));
const key = 'canvas:reviewPreferences:v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const bootstrap = 'import sys\nimport app\napp.CanvasServer.request_queue_size = 64\nsys.exit(app.main())';
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', bootstrap, '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const errors = [], report = { checks: [], artifacts: root };
  async function api(route, body) {
    const response = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  async function fixture(name, count) {
    await api('/api/review-import', { batchId: 'preferences-' + name, duplicateMode: 'skip', skipInvalid: false,
      rows: Array.from({ length: count }, (_, index) => ({ sourceRow: index + 1, prompt: name + ' ' + index, answer: 'Answer ' + index, deckName: name, tags: [] })) });
    const deck = (await api('/api/review-cards')).decks.find(deck => deck.name === name);
    await api('/api/review-settings', { scopeMode: 'deck', scopeDeckId: deck.id, sessionLimit: 10, orderMode: 'due' });
  }
  async function open(initial, blocked = false) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    await context.addInitScript(({ initial, blocked, key }) => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas'); localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN'); localStorage.setItem('canvas:hideSpecialPages', '0');
      localStorage.setItem('canvas:reviewMode:v1', 'scheduled');
      if (!sessionStorage.getItem('preferences-test-seeded')) {
        if (initial !== undefined) localStorage.setItem(key, typeof initial === 'string' ? initial : JSON.stringify(initial));
        sessionStorage.setItem('preferences-test-seeded', '1');
      }
      if (blocked) {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (name) { if (name === key) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, name); };
        Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Blocked', 'QuotaExceededError'); return set.call(this, name, value); };
      }
    }, { initial, blocked, key });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '/index.html?view=review'); await ready(page); return page;
  }
  const ready = page => page.waitForFunction(() => document.querySelector('[data-action="review-remembered"]')?.getAttribute('aria-disabled') === 'false');
  const dialog = page => page.locator('[data-role="review-settings-dialog"]');
  const option = (page, name) => dialog(page).locator('input[name="' + name + '"]');
  const prompt = page => page.locator('[data-role="review-prompt"]').textContent();
  const phase = page => page.locator('.review-embedded').getAttribute('data-review-phase');
  const answer = page => page.locator('[data-role="review-answer-reveal"]');
  const draft = page => page.locator('[data-role="review-draft"]');
  const next = page => page.locator('[data-action="review-next"]');
  const toast = page => page.locator('[data-role="study-toast"]');
  const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  async function options(page, changes, save = true) {
    await page.locator('[data-action="review-settings-open"]').click();
    for (const [name, checked] of Object.entries(changes)) await option(page, name).setChecked(checked);
    if (save) await page.locator('[data-role="review-settings-save"]').click();
    else await dialog(page).locator('.study-dialog-actions [data-action="review-settings-close"]').click();
    await dialog(page).waitFor({ state: 'hidden' });
  }
  async function grade(page, rating = 'remembered') {
    const response = page.waitForResponse(response => response.url().endsWith('/api/review-mark'));
    await page.locator('[data-action="review-' + rating + '"]').click();
    const result = await (await response).json();
    await page.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    return result;
  }
  async function free(page) {
    await page.locator('[data-action="review-show-free"]').first().click();
    await page.waitForFunction(() => document.querySelector('.review-embedded').dataset.reviewMode === 'free' && !document.querySelector('[data-role="review-content"]').hidden);
  }
  try {
    let started = false;
    for (let i = 0; i < 100; i++) { try { started = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (started) break; await pause(100); }
    assert(started, 'isolated server starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    await fixture('Preferences', 12);
    const page = await open();
    const requests = { pool: 0, settings: 0 };
    page.on('request', request => { if (request.url().endsWith('/api/review-pool')) requests.pool++; if (request.url().endsWith('/api/review-settings')) requests.settings++; });
    for (const action of ['review-settings-open', 'review-help-open']) {
      await page.evaluate(action => {
        document.querySelector('[data-action="' + action + '"]').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }, action);
      await page.locator('[data-role="' + (action === 'review-settings-open' ? 'review-settings-dialog' : 'review-help-dialog') + '"]').waitFor({ state: 'hidden' });
    }
    await page.locator('[data-action="review-settings-open"]').click();
    assert(await option(page, 'hideTextTips').isChecked()); assert(await option(page, 'autoRevealAnswer').isChecked());
    assert.equal(await dialog(page).locator('[data-review-scheduled-setting]:visible').count(), 2);
    await option(page, 'hideTextTips').uncheck(); await option(page, 'autoRevealAnswer').uncheck();
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'hidden' });
    assert.equal(await stored(page), null, 'closing does not persist edited values');
    await options(page, { hideTextTips: false, autoRevealAnswer: false }, false);
    assert.equal(await stored(page), null, 'Cancel does not persist');
    await draft(page).fill('preserve draft');
    const originalPrompt = await prompt(page), progress = await page.locator('[data-role="review-session-progress"]').textContent();
    await page.evaluate(() => { window.buttons = Array.from(document.querySelectorAll('.review-actions button')); });
    await options(page, { hideTextTips: false, autoRevealAnswer: false });
    assert.equal(await prompt(page), originalPrompt); assert.equal(await draft(page).inputValue(), 'preserve draft');
    assert.equal(await page.locator('[data-role="review-session-progress"]').textContent(), progress);
    assert.deepEqual(requests, { pool: 0, settings: 0 }, 'local-only changes do not post settings or reload the pool');
    assert(await toast(page).evaluate(element => element.classList.contains('show')));
    await options(page, { hideTextTips: true });
    assert(!(await toast(page).evaluate(element => element.classList.contains('show'))), 'muting dismisses the current ordinary review notice');
    assert.deepEqual(await stored(page), { hideTextTips: true, autoRevealAnswer: false });
    await page.reload(); await ready(page);
    await page.evaluate(() => { window.buttons = Array.from(document.querySelectorAll('.review-actions button')); });
    await page.locator('[data-action="review-settings-open"]').click();
    assert(await option(page, 'hideTextTips').isChecked()); assert(!(await option(page, 'autoRevealAnswer').isChecked()));
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'hidden' });
    report.checks.push('defaults, Cancel/close, local-only save retains draft/round/card, reload persistence, current ordinary notice dismissal');

    for (const autoRevealAnswer of [true, false]) {
      for (const hideTextTips of [false, true]) {
        await options(page, { hideTextTips, autoRevealAnswer });
        const before = await prompt(page), result = await grade(page);
        assert(result.ok); assert.equal(await phase(page), autoRevealAnswer ? 'feedback' : 'question');
        assert.equal(await toast(page).evaluate(element => element.classList.contains('show')), !hideTextTips);
        if (autoRevealAnswer) {
          assert.equal(await prompt(page), before); assert(await answer(page).isVisible());
          assert(await page.locator('[data-role="review-continue-hint"]').isVisible(), 'bottom hint is never muted');
          await next(page).click();
        }
        assert.notEqual(await prompt(page), before); assert(await answer(page).isHidden());
        assert.equal(await draft(page).inputValue(), '');
        assert(await page.evaluate(() => buttons.every(button => button.isConnected)), 'button nodes are reused');
        assert.equal(await page.locator('[data-action="review-remembered"]').evaluate(button => getComputedStyle(button).opacity), '1');
      }
    }
    await draft(page).fill('skip draft');
    const beforeSkip = await prompt(page), scoreCount = (await api('/api/review-pool')).reviewedToday;
    await next(page).dblclick();
    assert.notEqual(await prompt(page), beforeSkip); assert.equal(await phase(page), 'question'); assert(await answer(page).isHidden());
    assert.equal((await api('/api/review-pool')).reviewedToday, scoreCount, 'direct skip never rates');
    await free(page);
    const seen = await page.locator('[data-role="review-seen"]').textContent();
    const freePrompt = await prompt(page), beforeRequests = { ...requests };
    await draft(page).fill('free draft'); await options(page, { hideTextTips: false });
    assert.equal(await draft(page).inputValue(), 'free draft'); assert.equal(await prompt(page), freePrompt);
    assert.equal(await page.locator('[data-role="review-seen"]').textContent(), seen);
    assert.deepEqual(requests, beforeRequests);
    await page.locator('[data-action="review-settings-open"]').click();
    assert.equal(await dialog(page).getByRole('combobox').count(), 0, 'free settings only expose the two checkboxes');
    assert(!(await option(page, 'autoRevealAnswer').isChecked()));
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'hidden' });
    await page.locator('[data-role="review-prompt"]').click(); await page.keyboard.press('1'); assert(await answer(page).isVisible());
    await page.keyboard.press('d');
    assert.notEqual(await prompt(page), freePrompt); assert(await answer(page).isHidden());
    assert.equal(Number(await page.locator('[data-role="review-seen"]').textContent()), Number(seen) + 1);
    assert.equal(await toast(page).textContent(), '下一张 √');
    await options(page, { autoRevealAnswer: true });
    await next(page).click(); const heldFree = await prompt(page);
    await options(page, { autoRevealAnswer: false, hideTextTips: true });
    assert.equal(await phase(page), 'feedback'); assert.equal(await prompt(page), heldFree); assert(await answer(page).isVisible());
    await next(page).click(); assert.notEqual(await prompt(page), heldFree);
    report.checks.push('four combinations, stable buttons, direct skip/free next, unchanged free count on save, shared settings, held feedback retained');

    await page.locator('[data-action="review-show-scheduled"]').click(); await ready(page);
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    await options(page, { autoRevealAnswer: true });
    await draft(page).fill('in-flight draft'); const inFlightPrompt = await prompt(page);
    await page.route('**/api/review-mark', async route => { await blocked; await route.continue(); });
    await page.locator('[data-action="review-vague"]').click();
    assert(await answer(page).isVisible());
    await options(page, { autoRevealAnswer: false });
    assert.equal(await phase(page), 'saving'); assert.equal(await draft(page).inputValue(), 'in-flight draft');
    await next(page).evaluate(button => button.click()); assert.equal(await prompt(page), inFlightPrompt, 'no continuation can be queued during save');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/review-mark'));
    release(); await saved; await page.waitForFunction(() => document.querySelector('.review-embedded').dataset.reviewPhase === 'feedback');
    await page.unroute('**/api/review-mark');
    assert.equal(await prompt(page), inFlightPrompt); assert.equal(await draft(page).inputValue(), 'in-flight draft');
    await next(page).click(); assert.notEqual(await prompt(page), inFlightPrompt);

    const retried = []; let lost = true;
    await page.route('**/api/review-mark', async route => {
      retried.push(route.request().postDataJSON());
      if (lost) { lost = false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await draft(page).fill('retry draft'); const lostPrompt = await prompt(page);
    await page.locator('[data-action="review-forgot"]').click();
    await page.locator('[data-role="review-save-retry"]').waitFor({ state: 'visible' });
    assert.equal(await prompt(page), lostPrompt); assert.equal(await draft(page).inputValue(), 'retry draft');
    assert(await answer(page).isHidden()); assert(await toast(page).evaluate(element => element.classList.contains('show')), 'uncertain-save warning is not muted');
    const recordedCount = (await api('/api/review-pool')).reviewedToday;
    await options(page, { autoRevealAnswer: true });
    const retryResponse = page.waitForResponse(response => response.url().endsWith('/api/review-mark'));
    await page.locator('[data-action="review-mark-retry"]').click(); await retryResponse;
    await ready(page); await page.unroute('**/api/review-mark');
    assert.deepEqual(retried[0], retried[1]); assert.equal((await api('/api/review-pool')).reviewedToday, recordedCount);
    assert.notEqual(await prompt(page), lostPrompt, 'retry keeps the original direct-advance preference despite later changes');
    assert.equal(await phase(page), 'question'); assert(await answer(page).isHidden());
    report.checks.push('in-flight preference snapshot, no queued continuation, lost response/idempotent retry retains original direct behavior and draft');

    // A server-setting error must not partially apply the local preference edits.
    const previousPreferences = await stored(page), beforeFailure = await prompt(page);
    await draft(page).fill('failed settings draft');
    await page.route('**/api/review-settings', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存复习设置失败' }) }));
    await page.locator('[data-action="review-settings-open"]').click();
    await option(page, 'hideTextTips').uncheck(); await option(page, 'autoRevealAnswer').uncheck();
    await dialog(page).getByRole('combobox', { name: '每轮卡片', exact: true }).click();
    await page.getByRole('option', { name: '20 张', exact: true }).click();
    await page.locator('[data-role="review-settings-save"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="review-settings-save"]').disabled);
    assert(await dialog(page).isVisible()); assert(!(await option(page, 'autoRevealAnswer').isChecked()));
    assert.deepEqual(await stored(page), previousPreferences); assert.equal(await prompt(page), beforeFailure);
    assert.equal(await draft(page).inputValue(), 'failed settings draft'); assert.equal(await toast(page).textContent(), '保存复习设置失败');
    await page.unroute('**/api/review-settings');
    await page.locator('[data-role="review-settings-save"]').click(); await dialog(page).waitFor({ state: 'hidden' }); await ready(page);
    assert.deepEqual(await stored(page), { hideTextTips: false, autoRevealAnswer: false });
    assert.equal((await api('/api/review-pool')).settings.sessionLimit, 20);
    assert.equal(await draft(page).inputValue(), '', 'changing the server settings reopens the batch as before');

    await page.evaluate(() => { const toast = document.querySelector('[data-role="study-toast"]'); toast.textContent = 'Other workspace'; toast.classList.add('show'); });
    await options(page, { hideTextTips: true });
    assert.equal(await toast(page).textContent(), 'Other workspace'); assert(await toast(page).evaluate(element => element.classList.contains('show')));
    await page.locator('[data-action="review-show-library"]').click();
    await page.locator('[data-action="review-card-edit"]').first().click();
    await page.locator('[data-action="review-card-delete"]').click();
    assert.equal(await toast(page).textContent(), '删除后无法恢复，再点击一次确认');
    await page.keyboard.press('Escape');
    report.checks.push('server-setting failure preserves effective preferences/form/draft, successful retry applies both, shared-toast ownership and deletion confirmations');
    await page.context().close();

    await fixture('Solo', 1);
    const solo = await open({ hideTextTips: true, autoRevealAnswer: false });
    await grade(solo, 'forgot'); assert.equal(await phase(solo), 'question'); assert(await answer(solo).isHidden());
    await grade(solo); assert.equal(await solo.locator('[data-role="review-relearning"]').textContent(), '补练 · 连续记得 1/2');
    await grade(solo); assert(await solo.locator('[data-role="review-empty"]').isVisible(), 'last card completes directly');
    await solo.context().close();
    await fixture('Defaults', 2);
    for (const [initial, expected] of [
      ['broken JSON', { hideTextTips: true, autoRevealAnswer: true }],
      [{ hideTextTips: false, autoRevealAnswer: 'false' }, { hideTextTips: false, autoRevealAnswer: true }],
      [{ hideTextTips: 0, autoRevealAnswer: false }, { hideTextTips: true, autoRevealAnswer: false }],
    ]) {
      const invalid = await open(initial); await invalid.locator('[data-action="review-settings-open"]').click();
      for (const [name, checked] of Object.entries(expected)) assert.equal(await option(invalid, name).isChecked(), checked);
      await invalid.context().close();
    }
    const unavailable = await open(undefined, true);
    await options(unavailable, { hideTextTips: false, autoRevealAnswer: false });
    await unavailable.locator('[data-action="review-settings-open"]').click();
    assert(!(await option(unavailable, 'hideTextTips').isChecked())); assert(!(await option(unavailable, 'autoRevealAnswer').isChecked()));
    await unavailable.keyboard.press('Escape'); await dialog(unavailable).waitFor({ state: 'hidden' });
    await free(unavailable); const blockedBefore = await prompt(unavailable); await next(unavailable).click();
    assert.notEqual(await prompt(unavailable), blockedBefore); assert.equal(await phase(unavailable), 'question');
    await unavailable.context().close();
    report.checks.push('direct solo relearning/last card, per-field invalid defaults, unavailable storage keeps session preferences');

    const visual = await open();
    await visual.evaluate(() => RelatumI18n.setLanguage('en'));
    await visual.locator('[data-action="review-settings-open"]').click();
    assert(await dialog(visual).getByText('Hide text tips', { exact: true }).isVisible());
    assert(await dialog(visual).getByText('Auto-reveal answer', { exact: true }).isVisible());
    await option(visual, 'autoRevealAnswer').focus(); await visual.keyboard.press('Space');
    assert(!(await option(visual, 'autoRevealAnswer').isChecked()), 'checkbox keyboard operation does not rate');
    await visual.screenshot({ path: path.join(root, 'settings-light-en.png') });
    await visual.setViewportSize({ width: 640, height: 760 }); await visual.evaluate(() => document.body.dataset.startTheme = 'dark');
    assert(await dialog(visual).evaluate(element => { const rect = element.querySelector('form').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }));
    assert.equal(await dialog(visual).locator('form').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(36, 43, 38)', 'dark settings have an opaque paper surface');
    await visual.screenshot({ path: path.join(root, 'settings-dark-en-narrow.png') });
    await visual.keyboard.press('Escape'); await dialog(visual).waitFor({ state: 'hidden' }); await free(visual);
    await visual.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await visual.emulateMedia({ reducedMotion: 'no-preference' });
    await visual.locator('[data-action="review-settings-open"]').click();
    await dialog(visual).waitFor({ state: 'visible' });
    await visual.screenshot({ path: path.join(root, 'settings-free-zh.png'), animations: 'disabled' });
    await visual.keyboard.press('Escape'); await visual.context().close();
    report.checks.push('Chinese/English, light/dark, narrow window, reduced motion and native checkbox keyboard behavior');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('artifacts:', root);
    for (const [i, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
      await page.screenshot({ path: path.join(root, 'failure-' + i + '.png') }).catch(() => {});
    }
    throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
