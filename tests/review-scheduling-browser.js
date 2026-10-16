'use strict';
// Real UI/API. The controllable clock exists only in this isolated test process.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-review-scheduling-browser-'));
const clock = path.join(root, 'clock.txt');
fs.writeFileSync(clock, '2026-10-16T09:00:00');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  // Repeated cold browser contexts fetch every asset concurrently. Keep the
  // test service's accept backlog from rejecting scripts before UI execution.
  const bootstrap = 'import os, pathlib, sys\nimport app\nclock = pathlib.Path(os.environ["RELATUM_REVIEW_TEST_CLOCK"])\napp._study_now = lambda: clock.read_text(encoding="utf-8").strip()\napp.CanvasServer.request_queue_size = 64\nsys.exit(app.main())';
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', bootstrap, '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root, RELATUM_REVIEW_TEST_CLOCK: clock }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { checks: [], artifacts: root }, errors = [];
  async function api(route, body, expected = 200) {
    const response = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const allCards = async () => (await api('/api/review-cards')).cards;
  async function deck(name, count) {
    await api('/api/review-import', { batchId: 'scheduling-' + name + '-fixture', duplicateMode: 'skip', skipInvalid: false,
      rows: Array.from({ length: count }, (_, index) => ({ sourceRow: index + 1, prompt: name + ' ' + index, answer: 'Answer ' + index, deckName: name, tags: [] })) });
    return (await api('/api/review-cards')).decks.find(deck => deck.name === name).id;
  }
  async function scope(id) { await api('/api/review-settings', { scopeMode: 'deck', scopeDeckId: id, sessionLimit: 10, orderMode: 'due' }); }
  async function open() {
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, timezoneId: 'Asia/Shanghai' });
    await context.addInitScript(stamp => {
      window.reviewTestNow = sessionStorage.getItem('review-test-clock') || stamp + '+08:00';
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.reviewTestNow])); }
        static now() { return NativeDate.now(); }
      };
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas'); localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN'); localStorage.setItem('canvas:hideSpecialPages', '0');
      localStorage.setItem('canvas:reviewMode:v1', 'scheduled');
    }, fs.readFileSync(clock, 'utf8'));
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => { errors.push(error.message); console.error('page error:', error.stack); });
    page.on('requestfailed', request => {
      if (!request.url().endsWith('/api/review-mark')) console.error('request failed:', request.url(), request.failure()?.errorText);
    });
    await page.goto(url + '/index.html?view=review');
    await page.waitForFunction(() => { const button = document.querySelector('[data-action="review-remembered"]'); return button && !button.disabled && button.getAttribute('aria-disabled') === 'false'; });
    await pause(480); return page;
  }
  const prompt = page => page.locator('[data-role="review-prompt"]');
  const seen = async page => Number(await page.locator('[data-role="review-seen"]').textContent());
  const remaining = async page => Number(await page.locator('[data-role="review-total"]').textContent());
  async function grade(page, rating = 'remembered', advance = true) {
    const before = await prompt(page).textContent();
    const response = page.waitForResponse(response => response.url().endsWith('/api/review-mark'));
    await page.locator('[data-action="review-' + rating + '"]').click();
    const result = await (await response).json();
    await page.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    if (result.ok) {
      assert.equal(await prompt(page).textContent(), before, 'saved rating stays on its original card');
      assert(await page.locator('[data-role="review-answer-reveal"]').isVisible());
      assert.equal(await page.locator('[data-role="review-next-label"]').textContent(), '继续');
      if (advance) await page.locator('[data-action="review-next"]').click();
    }
    return result;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated server starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const mainDeck = await deck('Queue', 6); await scope(mainDeck);
    const page = await open(), original = (await api('/api/review-pool')).cards.map(card => card.prompt);
    await page.evaluate(() => { window.originalReviewButtons = Array.from(document.querySelectorAll('.review-actions button')); });
    assert.equal(await prompt(page).textContent(), original[0]);
    const first = await grade(page, 'forgot');
    assert.equal(await prompt(page).textContent(), original[1]);
    assert.deepEqual([await remaining(page), await seen(page)], [6, 0]);
    assert.equal(await page.locator('[data-role="review-session-progress"]').textContent(), '本轮完成 0 / 6');
    await page.locator('[data-action="review-next"]').click();
    assert.equal(await prompt(page).textContent(), original[1], 'skip first reveals the original answer');
    await page.keyboard.press('Enter'); assert.equal(await prompt(page).textContent(), original[2]);
    assert.equal((await api('/api/review-pool')).reviewedToday, 1, 'skip does not score');
    await grade(page); await grade(page);
    assert.equal(await prompt(page).textContent(), original[0], 'missed card returns after three other cards');
    assert.equal(await page.locator('[data-role="review-relearning"]').textContent(), '补练 · 连续记得 0/2');
    await grade(page);
    assert.deepEqual([await remaining(page), await seen(page)], [4, 2], 'first successful relearning attempt does not finish');
    for (let i = 0; i < 3; i++) await grade(page);
    assert.equal(await prompt(page).textContent(), original[0]);
    assert.equal(await page.locator('[data-role="review-relearning"]').textContent(), '补练 · 连续记得 1/2');
    await grade(page);
    assert.deepEqual([await remaining(page), await seen(page)], [0, 6]);
    assert((await page.locator('[data-role="review-empty"]').textContent()).includes('今天完成了 6 张卡片'));
    const graduated = (await allCards()).find(card => card.id === first.card.id);
    assert.equal(graduated.level, 0); assert.equal(graduated.due, '2026-10-17'); assert.equal(graduated.reviewCount, 3);
    assert(await page.evaluate(() => originalReviewButtons.every(button => button.isConnected)));
    const beforeFree = await api('/api/review-pool');
    await page.locator('[data-action="review-show-free"]').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-role="review-content"]').hidden);
    await page.keyboard.press('d'); await page.keyboard.press('n');
    assert.equal((await api('/api/review-pool')).reviewedToday, beforeFree.reviewedToday);
    assert.equal((await api('/api/review-pool')).completedToday, 6);
    report.checks.push('three-card spacing, skip, fixed distinct-card batch, completion counters, no same-day level inflation, stable buttons and free review');
    await page.context().close();

    const soloDeck = await deck('Solo', 1); await scope(soloDeck);
    const solo = await open(), baseCompleted = await seen(solo);
    await solo.keyboard.press('Space'); assert(await solo.locator('[data-role="review-answer-reveal"]').isVisible());
    await grade(solo, 'vague'); assert(await solo.locator('[data-role="review-answer-reveal"]').isHidden());
    await grade(solo); assert.equal(await seen(solo), baseCompleted);
    await solo.reload();
    await solo.waitForFunction(() => document.querySelector('[data-role="review-relearning"]').textContent.includes('1/2'));
    await solo.waitForFunction(() => {
      const root = document.querySelector('.review-embedded');
      return root.getAttribute('aria-hidden') !== 'true' && !root.classList.contains('view-entering') && getComputedStyle(root).opacity === '1';
    });
    await solo.screenshot({ path: path.join(root, 'relearning-progress.png') });
    await grade(solo); assert.equal(await seen(solo), baseCompleted + 1);
    await solo.context().close();
    report.checks.push('one-card fallback, answer reset, reload keeps consecutive progress');

    const carryDeck = await deck('Carry', 1); await scope(carryDeck);
    const carry = await open(); await grade(carry, 'forgot'); await grade(carry);
    fs.writeFileSync(clock, '2026-10-17T00:00:00');
    await carry.evaluate(() => { window.reviewTestNow = '2026-10-17T00:00:00+08:00'; sessionStorage.setItem('review-test-clock', window.reviewTestNow); });
    let carryPosts = 0; carry.on('request', request => { if (request.url().endsWith('/api/review-mark')) carryPosts++; });
    await carry.locator('[data-action="review-remembered"]').click();
    await carry.waitForFunction(() => document.querySelector('[data-role="review-relearning"]').textContent.includes('0/2'));
    assert.equal(carryPosts, 0, 'first action after midnight refreshes before scoring');
    assert.equal(await seen(carry), 0);
    await grade(carry); assert.equal(await seen(carry), 0);
    const carried = await grade(carry); assert.equal(carried.card.due, '2026-10-18'); assert.equal(await seen(carry), 1);
    await carry.context().close(); report.checks.push('midnight refresh, unfinished work persists but streak resets, new-day completion counter');

    const retryDeck = await deck('Retry', 1); await scope(retryDeck);
    const retry = await open(); await grade(retry, 'forgot');
    let lost = true; const requests = [];
    await retry.route('**/api/review-mark', async route => {
      requests.push(route.request().postDataJSON());
      if (lost) { lost = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await retry.locator('[data-role="review-draft"]').fill('preserved draft');
    await retry.locator('[data-action="review-remembered"]').click();
    await retry.locator('[data-role="review-save-retry"]').waitFor();
    assert.equal(await retry.locator('[data-role="review-draft"]').inputValue(), 'preserved draft');
    assert.equal((await allCards()).find(card => card.deckId === retryDeck).dailyReview.streak, 1);
    await retry.locator('[data-action="review-remembered"]').evaluate(button => button.click());
    await retry.locator('[data-action="review-next"]').evaluate(button => button.click());
    assert.equal(requests.length, 1, 'uncertain save blocks new grades and skips');
    await retry.locator('[data-action="review-mark-retry"]').focus(); await retry.keyboard.press('Enter');
    await retry.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.deepEqual(requests[1], requests[0], 'retry uses identical ID, rating, date and version');
    assert.equal((await allCards()).find(card => card.deckId === retryDeck).reviewCount, 2, 'response loss cannot supply a second Remembered');
    assert.equal(await retry.locator('[data-role="review-relearning"]').textContent(), '补练 · 连续记得 1/2');
    await retry.locator('[data-action="review-next"]').click();
    await retry.unroute('**/api/review-mark'); await grade(retry);
    await retry.context().close(); report.checks.push('lost committed response, explicit retry, pending lock and exactly-once scoring');

    const staleDeck = await deck('Stale', 1); await scope(staleDeck);
    const stale = await open(), staleCard = (await api('/api/review-pool')).cards[0];
    await api('/api/review-mark', { cardId: staleCard.id, rating: 'vague', requestId: 'external-stale-rating-request', expectedReviewCount: 0, reviewDay: '2026-10-17' });
    await stale.locator('[data-role="review-draft"]').fill('conflict draft');
    const conflict = await grade(stale);
    assert.equal(conflict.code, 'stale-card');
    assert.equal(await stale.locator('[data-role="review-draft"]').inputValue(), 'conflict draft');
    assert.equal((await allCards()).find(card => card.id === staleCard.id).reviewCount, 1);
    assert.equal(await stale.locator('[data-role="review-relearning"]').textContent(), '补练 · 连续记得 0/2');
    await stale.context().close(); report.checks.push('stale version refresh preserves draft and does not count as a recall');

    const raceDeck = await deck('Race', 2), targetDeck = await deck('Target', 2); await scope(raceDeck);
    const race = await open(); let release;
    await race.route('**/api/review-mark', async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await race.locator('[data-action="review-remembered"]').click();
    for (let i = 0; !release && i < 100; i++) await pause(20); assert(release);
    await race.locator('[data-action="review-show-free"]').first().click(); await pause(420);
    const freePrompt = await prompt(race).textContent(); release(); release = null;
    await race.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.equal(await prompt(race).textContent(), freePrompt, 'late scheduled score does not advance free review');
    await race.locator('[data-action="review-show-scheduled"]').click();
    await race.waitForFunction(() => document.querySelector('[data-action="review-remembered"]').getAttribute('aria-disabled') === 'false');
    await race.locator('[data-action="review-remembered"]').click();
    for (let i = 0; !release && i < 100; i++) await pause(20); assert(release);
    await race.getByRole('combobox', { name: '选择复习范围', exact: true }).click();
    await race.getByRole('option', { name: 'Target · 2', exact: true }).click();
    await race.waitForFunction(value => document.querySelector('[data-role="review-scope-select"]').value === 'deck:' + value && document.querySelector('[data-role="review-prompt"]').textContent.startsWith('Target '), targetDeck);
    const scopedPrompt = await prompt(race).textContent(); release(); release = null;
    await race.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.equal(await prompt(race).textContent(), scopedPrompt, 'late response does not advance another scope');
    assert((await allCards()).filter(card => card.deckId === targetDeck).every(card => card.reviewCount === 0));
    await race.unroute('**/api/review-mark');
    await grade(race, 'vague'); await race.screenshot({ path: path.join(root, 'relearning.png') });
    report.checks.push('late responses across free/scheduled modes and scope changes cannot advance a new session');

    const completedBeforeLibrary = await seen(race);
    await race.route('**/api/review-mark', async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await race.locator('[data-action="review-remembered"]').click();
    for (let i = 0; !release && i < 100; i++) await pause(20); assert(release);
    await race.locator('[data-action="review-show-library"]').click();
    await race.locator('.review-library-item').first().waitFor();
    release(); release = null;
    await race.waitForFunction(() => document.querySelector('.review-actions').getAttribute('aria-busy') === 'false');
    assert.equal(await seen(race), completedBeforeLibrary + 1, 'late rating refreshes library counters without advancing a session');
    await race.unroute('**/api/review-mark');
    await race.locator('[data-action="review-library-help-open"]').click();
    const help = race.locator('[data-role="review-library-help-dialog"]'); await pause(260);
    assert.equal(await help.locator('h2').textContent(), '复习规则');
    assert.equal(await help.locator('details').getAttribute('open'), null);
    assert(!(await help.innerText()).includes('本轮先移出'));
    assert(!(await help.innerText()).includes('卡片管理'), 'secondary instructions start collapsed');
    await race.screenshot({ path: path.join(root, 'help-light.png') });
    await help.locator('summary').click(); assert((await help.innerText()).includes('卡片管理'));
    await race.keyboard.press('Escape'); await race.locator('[data-action="review-library-help-open"]').click();
    assert.equal(await help.locator('details').getAttribute('open'), null, 'reopening starts compact');
    await race.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = 'dark'; });
    await race.setViewportSize({ width: 520, height: 780 }); await race.emulateMedia({ reducedMotion: 'reduce' });
    await pause(100);
    assert.equal(await help.locator('h2').textContent(), 'Review rules');
    assert(!/首次|补练|卡片管理/.test(await help.innerText()));
    await help.locator('summary').focus(); await race.keyboard.press('Enter');
    assert((await help.innerText()).includes('Card management'));
    report.helpLayout = await help.locator('.study-dialog-card').evaluate(element => {
      const r = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { top: r.top, bottom: r.bottom, height: r.height, viewport: innerHeight, background: css.backgroundColor, opacity: css.opacity };
    });
    assert(report.helpLayout.top >= 12 && report.helpLayout.bottom <= report.helpLayout.viewport - 12, 'help and footer stay within the viewport');
    assert.equal(report.helpLayout.background, 'rgb(36, 43, 38)');
    assert(await help.locator('.review-guide-ratings p').evaluateAll(rows => rows.every(row => {
      const badge = row.querySelector('b').getBoundingClientRect(), text = row.querySelector('span').getBoundingClientRect();
      return badge.right <= text.left && badge.width >= row.querySelector('b').scrollWidth;
    })), 'English rating labels do not overlap their descriptions');
    assert(await help.locator('h2').evaluate(element => {
      const r = element.getBoundingClientRect();
      return element === document.elementFromPoint(r.left + 2, r.top + 2);
    }), 'navigation rail does not cover the narrow help');
    await race.screenshot({ path: path.join(root, 'help-dark-english-narrow.png') });
    await race.keyboard.press('Escape');
    await race.context().close(); report.checks.push('compact help, collapsed details, keyboard toggle, English, light/dark, narrow window and reduced motion');

    const checkDeck = await deck('Check', 8); await scope(checkDeck);
    const check = await open(), checkPrompt = () => prompt(check).textContent();
    const phase = () => check.locator('.review-embedded').getAttribute('data-review-phase');
    const next = check.locator('[data-action="review-next"]'), answer = check.locator('[data-role="review-answer-reveal"]');
    const firstCheck = await checkPrompt();
    await check.keyboard.press('Space');
    await answer.evaluate(element => { window.checkedAnswerChild = element.firstChild; });
    await check.locator('[data-role="review-draft"]').fill('keep while checking');
    await grade(check, 'remembered', false);
    assert.equal(await checkPrompt(), firstCheck);
    assert.equal(await check.locator('[data-role="review-draft"]').inputValue(), 'keep while checking');
    assert(await answer.evaluate(element => element.firstChild === window.checkedAnswerChild), 'already revealed answer is reused');
    assert.equal(await check.locator('[data-action="review-remembered"]').getAttribute('aria-disabled'), 'true');
    const scored = (await api('/api/review-pool')).reviewedToday;
    await check.locator('[data-action="review-remembered"]').evaluate(button => button.click());
    assert.equal((await api('/api/review-pool')).reviewedToday, scored);
    await check.keyboard.press('1');
    assert.notEqual(await checkPrompt(), firstCheck);
    assert.equal(await phase(), 'question');
    assert.equal(await check.locator('[data-role="review-draft"]').inputValue(), '');
    assert(await answer.isHidden());
    assert.equal((await api('/api/review-pool')).reviewedToday, scored, 'continuation never rates the following card');

    for (const key of ['2', '3', 'n', 'D', 'Space', 'Enter']) {
      const before = await checkPrompt(); await next.click();
      assert.equal(await phase(), 'feedback'); assert.equal(await checkPrompt(), before);
      await check.keyboard.press(key); assert.equal(await phase(), 'question');
      assert.notEqual(await checkPrompt(), before);
    }
    assert.equal((await api('/api/review-pool')).reviewedToday, scored, 'all seven continuation keys preserve ratings');

    let before = await checkPrompt();
    await check.keyboard.down('n');
    await check.keyboard.down('n'); assert.equal(await checkPrompt(), before, 'held trigger cannot continue');
    await check.keyboard.up('n');
    await check.keyboard.down('n');
    const afterContinue = await checkPrompt(); assert.notEqual(afterContinue, before);
    await check.keyboard.down('n'); assert.equal(await phase(), 'question', 'held continue cannot act on the next card');
    await check.keyboard.up('n');
    await next.dblclick(); assert.equal(await phase(), 'feedback', 'double-click only reveals once');
    assert.equal(await checkPrompt(), afterContinue);
    await check.locator('[data-role="review-draft"]').focus(); await check.keyboard.press('Enter');
    assert.equal(await phase(), 'feedback', 'editing a draft cannot continue');
    await check.locator('[data-role="review-prompt"]').click();
    await next.focus(); await check.keyboard.press('Control+Enter'); assert.equal(await phase(), 'feedback');
    await check.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', isComposing: true, keyCode: 229, bubbles: true }));
    });
    assert.equal(await phase(), 'feedback');
    await check.locator('[data-action="review-help-open"]').click();
    await check.keyboard.press('Enter'); assert.equal(await phase(), 'feedback', 'help isolates continuation');
    await check.keyboard.press('Escape');
    await check.locator('[data-action="review-help-open"]').focus(); await check.keyboard.press('Enter');
    assert(await check.locator('[data-role="review-help-dialog"]').isVisible(), 'Enter activates a focused help button instead of continuing');
    assert.equal(await phase(), 'feedback'); await check.keyboard.press('Escape');
    await check.getByRole('combobox', { name: '选择复习范围', exact: true }).click();
    await check.keyboard.press('Escape'); assert.equal(await phase(), 'feedback', 'dropdown Escape only closes the dropdown');
    await check.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    });
    assert.equal(await phase(), 'feedback');
    await check.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await check.evaluate(() => {
      document.querySelector('.review-embedded').setAttribute('aria-hidden', 'true');
      document.dispatchEvent(new CustomEvent('start:viewchange', { detail: { previous: 'review', current: 'recent' } }));
      document.querySelector('.review-embedded').setAttribute('aria-hidden', 'false');
    });
    await check.evaluate(() => CanvasReview.activate());
    assert.equal(await phase(), 'feedback', 'temporary page leave preserves the checked card');
    await check.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await check.locator('[data-role="review-next-label"]').textContent(), 'Continue');
    assert.equal(await check.locator('[data-role="review-continue-hint"]').textContent(), 'Press a key to continue');
    assert(await answer.isVisible());
    await check.evaluate(() => document.body.dataset.startTheme = 'dark');
    await check.setViewportSize({ width: 640, height: 880 }); await check.emulateMedia({ reducedMotion: 'reduce' });
    assert(await check.locator('.review-rating-group').evaluate(group => {
      const colors = Array.from(group.querySelectorAll('button'), button => getComputedStyle(button).backgroundColor);
      return new Set(colors).size === 1;
    }), 'all ratings share the subdued background in dark mode');
    await next.scrollIntoViewIfNeeded();
    await check.screenshot({ path: path.join(root, 'checking-dark-en.png') });
    await next.click(); assert.equal(await phase(), 'question');
    await check.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await check.locator('[data-action="review-show-free"]').first().click();
    await check.waitForFunction(() => document.querySelector('.review-embedded').dataset.reviewMode === 'free' && !document.querySelector('[data-role="review-content"]').hidden);
    const freeBefore = await checkPrompt(), freeSeen = await seen(check);
    await check.keyboard.press('d');
    assert.equal(await phase(), 'feedback'); assert.equal(await checkPrompt(), freeBefore);
    assert.equal(await seen(check), freeSeen, 'revealing the answer does not count as browsing another card');
    await next.click();
    assert.equal(await seen(check), freeSeen + 1); assert.notEqual(await checkPrompt(), freeBefore);
    assert.equal((await api('/api/review-pool')).reviewedToday, scored);
    await next.click();
    await check.locator('[data-action="review-show-scheduled"]').click();
    await check.waitForFunction(() => document.querySelector('.review-embedded').dataset.reviewMode === 'scheduled' && document.querySelector('.review-embedded').dataset.reviewPhase === 'question');
    await next.click();
    await check.getByRole('combobox', { name: '选择复习范围', exact: true }).click();
    await check.getByRole('option', { name: /^Target ·/ }).click();
    await check.waitForFunction(id => document.querySelector('[data-role="review-scope-select"]').value === 'deck:' + id && document.querySelector('.review-embedded').dataset.reviewPhase === 'question' && document.querySelector('[data-role="review-prompt"]').textContent.startsWith('Target '), targetDeck);
    await next.click();
    const scoresBeforeDay = (await allCards()).reduce((sum, card) => sum + card.reviewCount, 0);
    fs.writeFileSync(clock, '2026-10-18T00:00:00');
    await check.evaluate(() => { window.reviewTestNow = '2026-10-18T00:00:00+08:00'; sessionStorage.setItem('review-test-clock', window.reviewTestNow); });
    await check.keyboard.press('Enter');
    await check.waitForFunction(() => document.querySelector('.review-embedded').dataset.reviewPhase === 'question' && document.querySelector('[data-action="review-remembered"]').getAttribute('aria-disabled') === 'false');
    assert.equal((await allCards()).reduce((sum, card) => sum + card.reviewCount, 0), scoresBeforeDay, 'midnight continuation refreshes without rating');
    await next.click(); await check.reload();
    await check.waitForFunction(() => document.querySelector('[data-action="review-remembered"]').getAttribute('aria-disabled') === 'false');
    assert.equal(await phase(), 'question', 'answer checking is not persisted across a full reload');
    await check.context().close();

    const emptyDeck = await deck('Empty', 1);
    const emptyCard = (await allCards()).find(card => card.deckId === emptyDeck);
    await api('/api/review-card-update', { ...emptyCard, answer: '' }); await scope(emptyDeck);
    const empty = await open();
    await grade(empty, 'remembered', false);
    assert.equal(await empty.locator('[data-role="review-answer-reveal"]').textContent(), '未填写答案');
    assert(await empty.locator('[data-role="review-empty"]').isHidden(), 'last card stays available for checking');
    await empty.keyboard.press('Enter'); assert(await empty.locator('[data-role="review-empty"]').isVisible());
    await empty.context().close();
    report.checks.push('answer reuse, retained draft, seven continuation keys, held keys/double-click guards, input/IME/modal/dropdown isolation, temporary leave, minimized state, translations, free review, scope/mode/day changes, reload, empty answer and last-card checking');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('artifacts:', root);
    for (const [i, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
      console.error(await page.evaluate(() => ({ prompt: document.querySelector('[data-role="review-prompt"]')?.textContent,
        progress: document.querySelector('[data-role="review-session-progress"]')?.textContent,
        toast: document.querySelector('[data-role="study-toast"]')?.textContent || document.querySelector('[data-role="toast"]')?.textContent,
        retry: document.querySelector('[data-role="review-save-retry"]')?.hidden })));
      await page.screenshot({ path: path.join(root, 'failure-' + i + '.png') }).catch(() => {});
    }
    throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
