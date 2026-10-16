'use strict';
// Real import UI and API, with temporary data and browser profiles only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const XLSX = require('../assets/vendor/sheetjs/xlsx.full.min.js');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-review-import-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { checks: [], screenshots: root };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated server starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
      localStorage.setItem('canvas:hideSpecialPages', '0');
      window.importWorkers = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.importTracked = String(args[0]).includes('review-import-worker'); if (this.importTracked) window.importWorkers++; }
        terminate() { if (this.importTracked) { window.importWorkers--; this.importTracked = false; } super.terminate(); }
      };
    });
    const page = await context.newPage(), errors = [], requests = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => { errors.push(error.message); console.error('page error:', error.stack); }); page.on('request', request => requests.push(request.url()));
    await page.goto(url + '/index.html?view=review');
    await page.locator('[data-action="review-show-library"]').click();
    const trigger = page.locator('[data-action="review-import-open"]');
    await trigger.waitFor();
    assert(await page.locator('[data-role="review-view"] select').evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none')), 'all review selects use custom controls');
    assert(await page.locator('[data-role="review-search"]').evaluate(element => { const r = element.getBoundingClientRect(), host = element.closest('.review-library-head').getBoundingClientRect(); return r.height >= 38 && r.left >= host.left && r.right <= host.right; }));
    assert(!requests.some(value => /review-import|sheetjs/.test(value)), 'no importer resources before opening');
    async function open() { await trigger.click(); await page.locator('.review-import-paste').waitFor(); }
    const next = () => page.locator('[data-import-next]');
    const dialog = page.locator('.review-import-card');
    const cards = async () => (await (await fetch(url + '/api/review-cards')).json()).cards;
    async function choose(control, value) {
      const label = await control.locator('xpath=..').locator('select option').evaluateAll((options, value) => options.find(option => option.value === value)?.textContent, value);
      assert(label, 'option exists: ' + value);
      await control.click();
      await page.getByRole('option', { name: label, exact: true }).click();
    }
    async function createGroup(name) {
      await page.getByRole('combobox', { name: '分组（可选）', exact: true }).click();
      await page.getByRole('combobox', { name: '搜索或输入新卡组', exact: true }).fill(name);
      const existing = page.getByRole('option', { name, exact: true });
      if (await existing.count()) await existing.click();
      else await page.getByRole('option').filter({ hasText: '新建卡组 “' + name + '”' }).click();
    }
    const panelSize = () => dialog.evaluate(element => { const r = element.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    async function fill(text) {
      await open();
      const input = page.locator('.review-import-paste');
      if (text.length > 30000) {
        assert(await input.isEditable(), 'large input remains editable');
        await input.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, text);
      } else await input.fill(text);
      await next().click(); await page.locator('.review-import-mappings').waitFor();
    }
    async function close() { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); }
    await open();
    const fixedSize = await panelSize();
    assert.deepEqual(fixedSize, [1120, 860]);
    assert(await page.locator('.review-import-paste').evaluate(element => element === document.activeElement));
    await page.locator('.review-import-paste').evaluate(element => {
      for (const key of ['Escape', 'Enter']) element.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: 229, isComposing: true, bubbles: true }));
    });
    assert.equal(await dialog.count(), 1, 'IME keys do not close or submit');
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(() => !!document.activeElement.closest('.review-import-card')), 'Tab stays within dialog');
    await close();
    assert(await trigger.evaluate(element => element === document.activeElement), 'close restores focus');
    report.checks.push('focus loop, IME and focus restoration');

    const opening = await page.evaluate(async () => {
      document.querySelector('[data-action="review-import-open"]').click(); await Promise.resolve();
      const shell = document.querySelector('.review-import-dialog');
      return { opacity: Number(getComputedStyle(shell).opacity), moving: shell.getAnimations({ subtree: true }).length };
    });
    assert(opening.opacity < 1 && opening.moving > 0, 'opening fades in without blocking focus');
    await page.keyboard.press('Escape');
    assert(await page.locator('.review-import-dialog').evaluate(element => element.inert && element.classList.contains('is-closing')), 'closing stops interaction immediately');
    await trigger.evaluate(element => element.click());
    await page.locator('.review-import-paste').waitFor();
    assert.equal(await page.locator('.review-import-dialog').count(), 1, 'reopening removes the old closing shell');
    await pause(270); assert.equal(await dialog.count(), 1, 'old completion cannot remove the new dialog');
    assert.equal(await page.locator('.review-import-dialog').evaluate(element => element.getAnimations({ subtree: true }).length), 0, 'entry releases animation effects');
    assert(await page.evaluate(() => !!document.activeElement.closest('.review-import-card')));
    const dragging = await page.locator('.review-import-drop').evaluate(element => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['word\tmeaning'], 'words.tsv'));
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      const active = element.classList.contains('is-dragging');
      element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }));
      return [active, element.classList.contains('is-dragging')];
    });
    assert.deepEqual(dragging, [true, false]);
    await close();
    await fill('word\tmeaning\nmotion\t过渡');
    const backMotion = await page.getByRole('button', { name: '上一步', exact: true }).evaluate(element => {
      element.click(); const body = document.querySelector('.review-import-body');
      return Number(getComputedStyle(body).opacity) < 1 && body.getAnimations().length > 0;
    });
    assert(backMotion, 'Back changes contents immediately and adds a finite transition');
    await next().click(); await page.locator('.review-import-mappings').waitFor();
    const disclosure = page.locator('.review-import-disclosure');
    await disclosure.evaluate(element => element.click()); await pause(45);
    await disclosure.evaluate(element => { element.click(); element.click(); });
    await pause(240);
    assert(await page.locator('.review-import-organize-body').evaluate(element => !element.hidden && !element.inert && element.clientHeight > 0 && !element.classList.contains('is-folding')), 'rapid reversal settles expanded');
    await disclosure.click(); await pause(240);
    assert(await page.locator('.review-import-organize-body').evaluate(element => element.hidden && element.inert), 'collapse settles and removes tab stops');
    assert.deepEqual(await panelSize(), fixedSize);
    assert.equal(await page.locator('.review-import-dialog').evaluate(element => element.getAnimations({ subtree: true }).length), 0, 'idle importer has no running animations');
    await close(); report.checks.push('modal fade, rapid close/reopen, immediate focus, step transition, reversible disclosure, drag feedback and idle cleanup');
    await open(); await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.review-import-dialog').evaluate(element => element.getAnimations({ subtree: true }).length), 0, 'changing motion preference settles entry');
    assert(await page.locator('.review-import-card > header .study-icon-button').evaluate(element => { element.click(); return !document.querySelector('.review-import-dialog'); }), 'reduced-motion close is immediate');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(); await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await page.locator('.review-import-dialog').count(), 0, 'pagehide releases an unfinished exit');
    if (process.argv.includes('--motion-only')) {
      assert.deepEqual(errors, []); await context.close(); console.log(JSON.stringify(report, null, 2)); return;
    }

    const text = '单词\t释义\t例句\t卡组\t标签\n001\t第一\t"one\nsecond"\tCore\tcore\n001\t第一\t"one\nsecond"\tCore\tcore\n\t缺少问题\t\tCore\t\n\t\t\t\t';
    await fill(text);
    assert.deepEqual(await panelSize(), fixedSize);
    assert.equal(await page.getByRole('spinbutton', { name: '表头所在行', exact: true }).evaluate(element => getComputedStyle(element).appearance), 'textfield');
    assert.equal(await page.locator('.review-import-sample h4').textContent(), '001');
    await page.locator('.review-import-table tbody tr').nth(1).locator('td').nth(1).click();
    assert.equal(await page.locator('.review-import-table tbody tr.is-selected').count(), 1, 'preview row has a single visible selection');
    assert.equal(await page.locator('.review-import-table tbody tr').nth(1).getByRole('button').getAttribute('aria-pressed'), 'true');
    assert(!requests.some(value => value.includes('sheetjs')), 'pasted data does not load XLSX library');
    await page.screenshot({ path: path.join(root, 'mapping-light.png') });
    await next().click();
    await page.locator('.review-import-counts').waitFor();
    assert.deepEqual(await panelSize(), fixedSize);
    assert.deepEqual(await page.locator('.review-import-counts strong').allTextContents(), ['1', '1', '1', '1']);
    assert.equal((await cards()).length, 0, 'preview writes no cards');
    assert((await page.locator('.review-import-table .is-invalid').textContent()).includes('问题不能为空'));
    await page.screenshot({ path: path.join(root, 'confirm-light.png') });
    await next().click(); await page.locator('.review-import-complete').waitFor();
    assert.deepEqual(await panelSize(), fixedSize);
    assert.equal((await cards()).length, 1);
    assert.equal((await cards())[0].notes, 'one\nsecond');
    assert.equal((await cards())[0].prompt, '001');
    await close();
    assert.equal(await page.evaluate(() => importWorkers), 0);
    report.checks.push('paste, leading zero, multiline cells, blank rows, invalid rows, internal duplicates, commit');

    await fill(text); await next().click(); await page.locator('.review-import-counts').waitFor();
    assert.deepEqual(await page.locator('.review-import-counts strong').allTextContents(), ['0', '2', '1', '1']);
    assert(await next().isDisabled()); await close();
    report.checks.push('duplicates against existing cards');

    await fill('单词\t音标\t释义\t例句\nword\twɜːd\t单词\tan example');
    const answerMapping = page.locator('[data-import-field="answer"]');
    await choose(answerMapping.getByRole('combobox', { name: '答案：添加列', exact: true }), '1');
    await answerMapping.getByRole('button', { name: '向前移动', exact: true }).click();
    await answerMapping.getByLabel('显示列名', { exact: true }).check();
    assert((await page.locator('.review-import-sample').innerText()).includes('音标: wɜːd\n释义: 单词'));
    await createGroup('Custom deck');
    await page.locator('.review-import-disclosure').click();
    await page.getByRole('textbox', { name: '公共标签', exact: true }).fill('custom, vocabulary');
    await next().click(); await page.locator('.review-import-counts').waitFor();
    assert((await page.locator('.review-import-sample').innerText()).includes('Custom deck · custom, vocabulary'));
    await close(); report.checks.push('column combinations, order, names, default deck and common tags');

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['word', 'meaning'], ['hidden', 'not selected']]), 'Hidden');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['word', 'meaning'], ['xlsx-word', '表格导入']]), 'Visible');
    book.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }] };
    const workbookPath = path.join(root, 'words.xlsx');
    fs.writeFileSync(workbookPath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    await open();
    await page.locator('.review-import-card input[type="file"]').setInputFiles(workbookPath);
    await page.locator('.review-import-mappings').waitFor();
    assert.equal(await page.getByRole('combobox', { name: '工作表', exact: true }).textContent(), 'Visible');
    assert.equal(await page.locator('.review-import-sample h4').textContent(), 'xlsx-word');
    assert(requests.some(value => value.includes('sheetjs/xlsx.full.min.js')));
    await close(); report.checks.push('XLSX, local vendor, first visible sheet');

    const csvPath = path.join(root, 'legacy.csv');
    fs.writeFileSync(csvPath, Buffer.from([0x77,0x6f,0x72,0x64,0x2c,0x6d,0x65,0x61,0x6e,0x69,0x6e,0x67,0x0a,0x67,0x62,0x6b,0x2c,0xd6,0xd0,0xce,0xc4]));
    await open(); await page.locator('.review-import-formats summary').click();
    await choose(page.getByRole('combobox', { name: '文件编码', exact: true }), 'utf-8');
    await page.locator('.review-import-card input[type="file"]').setInputFiles(csvPath);
    await page.locator('.review-import-error:not([hidden])').waitFor();
    await choose(page.getByRole('combobox', { name: '文件编码', exact: true }), 'gb18030');
    await next().click(); await page.locator('.review-import-mappings').waitFor();
    assert((await page.locator('.review-import-sample').innerText()).includes('中文'));
    await close(); report.checks.push('GB18030 CSV and retry with another encoding');

    await page.locator('[data-role="review-search"]').fill('will-hide-new-card');
    await fill('word\tmeaning\nretry\t安全重试'); await next().click(); await page.locator('.review-import-counts').waitFor();
    let dropped = false;
    await page.route('**/api/review-import', async route => {
      if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await next().click(); await page.locator('.review-import-error:not([hidden])').waitFor();
    assert.equal((await cards()).length, 2, 'server committed before simulated response loss');
    await next().click(); await page.locator('.review-import-complete').waitFor();
    assert.equal((await cards()).length, 2, 'retry did not duplicate');
    await page.getByRole('button', { name: '清除筛选并查看', exact: true }).click();
    assert.equal(await page.locator('[data-role="review-search"]').inputValue(), '');
    await page.unroute('**/api/review-import'); report.checks.push('response loss, idempotent retry, preserve and clear filters');

    const organizers = await (await fetch(url + '/api/review-cards')).json();
    const coreDeck = organizers.decks.find(deck => deck.name === 'Core');
    const filter = page.locator('[data-role="review-deck-filter-select"]').locator('..').getByRole('combobox');
    await choose(filter, coreDeck.id);
    await fill('word\tmeaning\t卡组\ngroup-default\t默认卡组\t\ngroup-row\t逐行卡组\tCore');
    const groupPicker = page.getByRole('combobox', { name: '分组（可选）', exact: true });
    assert.equal(await groupPicker.textContent(), '未分组（默认）', 'does not inherit library filter');
    await groupPicker.click();
    assert.equal(await page.getByRole('option').first().textContent(), '未分组（默认）');
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1, 'Escape closes only the picker');
    assert(await groupPicker.evaluate(element => element === document.activeElement));
    await createGroup('Imported group');
    assert((await page.locator('.review-import-sample').innerText()).includes('Imported group'));
    assert(!(await (await fetch(url + '/api/review-cards')).json()).decks.some(deck => deck.name === 'Imported group'), 'preview creates no deck');
    await page.locator('.review-import-table tbody tr').nth(1).getByRole('button').click();
    assert((await page.locator('.review-import-sample').innerText()).includes('Core'), 'nonempty deck column overrides group');
    await page.getByRole('button', { name: '上一步', exact: true }).click();
    await next().click(); await page.locator('.review-import-mappings').waitFor();
    assert.equal(await groupPicker.textContent(), 'Imported group', 'group survives reparsing after Back');
    await next().click(); await page.locator('.review-import-counts').waitFor();
    await page.getByRole('button', { name: '上一步', exact: true }).click();
    await groupPicker.click(); await page.getByRole('option', { name: 'Core', exact: true }).click();
    assert((await page.locator('.review-import-sample').innerText()).includes('Core'));
    await createGroup('Imported group');
    await next().click(); await page.locator('.review-import-counts').waitFor();
    await next().click(); await page.locator('.review-import-complete').waitFor();
    const grouped = await cards();
    assert.equal(grouped.find(card => card.prompt === 'group-default').deckName, 'Imported group');
    assert.equal(grouped.find(card => card.prompt === 'group-row').deckName, 'Core');
    await close(); await choose(filter, 'all');
    report.checks.push('default ungrouped, existing/create group, no preview writes, row override, Back retention and changed preview');

    await page.locator('[data-action="review-card-new"]').first().click();
    const cardDialog = page.locator('[data-role="review-card-dialog"]');
    await cardDialog.locator('input[name="deckName"]').fill('Core');
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-role="review-card-dialog"] input[name="deckName"]'), popup = document.querySelector('.review-choice-popup');
      return popup && Math.abs(popup.getBoundingClientRect().top - input.getBoundingClientRect().bottom - 6) < 2;
    });
    await page.getByRole('option', { name: 'Core', exact: true }).click();
    assert.equal(await cardDialog.locator('input[name="deckName"]').inputValue(), 'Core');
    await cardDialog.locator('summary').click();
    await choose(cardDialog.getByRole('combobox', { name: '状态', exact: true }), 'archived');
    assert.equal(await cardDialog.locator('select[name="status"]').inputValue(), 'archived');
    await page.keyboard.press('Escape'); await cardDialog.waitFor({ state: 'hidden' });
    await page.locator('[data-action="review-show-scheduled"]').click();
    const scope = page.locator('[data-role="review-scope-select"]').locator('..').getByRole('combobox');
    await scope.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[data-role="review-scope-select"]').disabled);
    await page.locator('[data-action="review-settings-open"]').click();
    const settingsDialog = page.locator('[data-role="review-settings-dialog"]');
    await choose(settingsDialog.getByRole('combobox', { name: '每轮卡片', exact: true }), '50');
    await choose(settingsDialog.getByRole('combobox', { name: '出题顺序', exact: true }), 'weak');
    await page.locator('[data-role="review-settings-save"]').click();
    await settingsDialog.waitFor({ state: 'hidden' });
    await page.locator('[data-action="review-show-library"]').click();
    await page.locator('[data-action="review-batch-mode"]').click();
    await page.locator('[data-role="review-card-select"]').first().check();
    await choose(page.locator('[data-role="review-batch-status"]').locator('..').getByRole('combobox'), 'suspended');
    await page.waitForFunction(() => document.querySelector('[data-role="review-selected-count"]').textContent === '0');
    await page.locator('[data-role="review-card-select"]').first().check();
    await choose(page.locator('[data-role="review-batch-deck"]').locator('..').getByRole('combobox'), coreDeck.id);
    await page.waitForFunction(() => document.querySelector('[data-role="review-selected-count"]').textContent === '0');
    await page.locator('[data-action="review-batch-mode"]').click();
    report.checks.push('custom scope/filter/card editor/settings controls preserve native form values');

    await page.evaluate(() => {
      const owner = document.createElement('div'); owner.id = 'choice-fixture'; document.body.append(owner);
      const input = document.createElement('select'); input.setAttribute('aria-label', 'Many choices');
      for (let i = 0; i < 1000; i++) input.add(new Option('Choice ' + String(i).padStart(4, '0'), String(i)));
      owner.append(input); const manager = RelatumReviewControls.createManager(owner);
      const control = manager.enhance(input); control.element.style.cssText = 'position:fixed;right:12px;bottom:12px;width:190px;z-index:900';
      window.choiceFixture = { manager, owner };
    });
    const many = page.getByRole('combobox', { name: 'Many choices', exact: true });
    await many.click();
    assert(await page.locator('.review-choice-popup').evaluate(menu => { const r = menu.getBoundingClientRect(); return r.top >= 10 && r.right <= innerWidth - 9 && menu.classList.contains('opens-up'); }));
    assert(await page.getByRole('option').count() < 100, 'thousand options are windowed');
    const menuList = page.locator('.review-choice-list'); await menuList.hover(); await page.mouse.wheel(0, 520);
    await page.waitForFunction(() => document.querySelector('.review-choice-list').scrollTop > 0);
    assert.equal(await menuList.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    await many.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#choice-fixture select').inputValue(), '999');
    await many.click(); await page.getByRole('combobox', { name: '搜索选项', exact: true }).fill('0123');
    assert.equal(await page.getByRole('option').count(), 1); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#choice-fixture select').inputValue(), '123');
    await many.click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    assert.equal(await page.locator('.review-choice-popup').count(), 0);
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); choiceFixture.manager.dispose(); choiceFixture.owner.remove(); delete window.choiceFixture; });
    report.checks.push('custom picker edge placement, thousand-option windowing, wheel, search, Home/End and lifecycle release');

    for (const count of [1000, 10000]) {
      const started = Date.now();
      await fill('word\tmeaning\n' + Array.from({ length: count }, (_, i) => 'large-' + count + '-' + i + '\t释义 ' + i).join('\n'));
      assert.equal(await page.locator('.review-import-table tbody tr').count(), 50);
      const tableScroller = page.locator('.review-import-table-wrap');
      await tableScroller.hover(); await page.mouse.wheel(0, 350);
      await page.waitForFunction(() => document.querySelector('.review-import-table-wrap').scrollTop > 0);
      assert.equal(await tableScroller.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
      assert.deepEqual(await panelSize(), fixedSize);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      assert((await page.locator('.review-import-table tbody tr').first().textContent()).includes('large-' + count + '-50'));
      await next().click(); await page.locator('.review-import-counts').waitFor();
      assert.equal(await page.locator('.review-import-counts strong').first().textContent(), String(count));
      assert.equal(await page.evaluate(() => importWorkers), 0, 'worker released after mapping');
      report.checks.push({ rows: count, previewMs: Date.now() - started, previewDOMRows: await page.locator('.review-import-table tbody tr').count() });
      if (count === 1000) { await next().click(); await page.locator('.review-import-complete').waitFor(); }
      await close();
      if (count === 1000) assert(await page.locator('.review-library-item').count() < 100, 'imported card library remains windowed');
    }

    // Closing while the worker script is loading cannot revive the dialog.
    await page.route('**/review-import-worker.js', async route => { await pause(250); await route.continue().catch(() => {}); });
    await open(); await page.locator('.review-import-paste').fill('word\tmeaning\ncancel\t取消'); await next().click();
    await page.keyboard.press('Escape'); await pause(450);
    assert.equal(await dialog.count(), 0); assert.equal(await page.evaluate(() => importWorkers), 0);
    await open(); await page.locator('.review-import-paste').fill('word\tmeaning\nminimize\t最小化'); await next().click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await pause(350); assert.equal(await page.evaluate(() => importWorkers), 0);
    assert.equal(await page.locator('.review-import-mappings').count(), 0, 'minimized parser cannot advance the dialog');
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await next().click(); await page.locator('.review-import-mappings').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await dialog.count(), 0);
    await page.unroute('**/review-import-worker.js'); report.checks.push('cancel parser and reject late results');
    report.checks.push('native minimize, retry on restore, pagehide release');

    await page.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = 'dark'; });
    await fill('word\tmeaning\nnight\t夜晚');
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(30, 36, 33)', 'dark importer is opaque');
    assert.equal(await page.locator('.review-import-dialog .study-dialog-backdrop').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
    assert(await dialog.evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
    await page.screenshot({ path: path.join(root, 'mapping-dark-en.png') });
    await page.setViewportSize({ width: 430, height: 780 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(root, 'mapping-narrow-en.png') });
    assert(await dialog.evaluate(element => element.getBoundingClientRect().right <= innerWidth && element.scrollWidth <= element.clientWidth + 1));
    await page.locator('.review-import-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const englishGroup = page.getByRole('combobox', { name: 'Group (optional)', exact: true });
    await englishGroup.click();
    const groupSearch = page.getByRole('combobox', { name: 'Search or enter a new deck', exact: true });
    assert(await groupSearch.evaluate(element => { const r = element.getBoundingClientRect(), popup = element.closest('.review-choice-popup').getBoundingClientRect(); return r.height >= 36 && r.left >= popup.left && r.right <= popup.right && popup.right <= innerWidth; }));
    await groupSearch.fill('English deck');
    await groupSearch.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true })));
    assert.equal(await page.locator('.review-choice-popup').count(), 1, 'IME does not dismiss the picker');
    await page.screenshot({ path: path.join(root, 'picker-narrow-dark-en.png') });
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
    await englishGroup.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.review-choice-popup').count(), 1, 'capture-phase dialog supports opening with arrows');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.review-choice-popup').count(), 0);
    assert(await page.evaluate(() => !!document.activeElement.closest('.review-import-card')), 'Tab remains in importer after closing picker');
    await englishGroup.click();
    await page.locator('.review-import-body').evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => !document.querySelector('.review-choice-popup'));
    assert.equal(await dialog.count(), 1, 'scrolling the anchor out of view only closes the picker');
    assert.equal(await page.locator('.review-import-dialog').evaluate(element => element.getAnimations({ subtree: true }).length), 0, 'reduced motion skips importer animation');
    await close(); report.checks.push('English, dark theme, narrow window, reduced motion');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    for (const view of ['review', 'calendar', 'cadence']) {
      await page.locator('.left-spine [data-action="' + view + '-view"]').evaluate(element => { if (!element.classList.contains('active')) element.click(); });
      await page.waitForFunction(() => !document.querySelector('.book-view').classList.contains('view-switching'));
      for (const key of ['Delete', 'Backspace']) {
        const point = await page.evaluate(view => {
          const role = view === 'cadence' ? 'cadence-view' : view + '-view';
          const host = document.querySelector('[data-role="' + role + '"]');
          for (let y = 130; y < innerHeight - 50; y += 60) for (let x = 130; x < innerWidth - 50; x += 70) {
            const target = document.elementFromPoint(x, y);
            if (target && host.contains(target) && !target.closest('button,a,input,textarea,select,label,svg,canvas,[data-action],[tabindex],.study-dialog,.start-page-note')) return { x, y };
          }
          throw Error('no blank note point for ' + view);
        }, view);
        await page.mouse.dblclick(point.x, point.y);
        const body = page.locator('.start-page-note-body[contenteditable]'); await body.waitFor();
        await body.fill('abc'); await page.keyboard.press('Home'); await page.keyboard.press('Delete');
        assert.equal(await body.textContent(), 'bc', 'Delete edits text while editing');
        await page.keyboard.press('End'); await page.keyboard.press('Backspace'); assert.equal(await body.textContent(), 'b');
        await page.keyboard.press('Escape');
        const note = page.locator('.start-page-note');
        await note.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 229, isComposing: true, bubbles: true })));
        assert.equal(await note.count(), 1, 'composing Delete does not delete the note');
        await page.mouse.click(point.x + 220, point.y); await page.keyboard.press('Delete');
        assert.equal(await note.count(), 1, 'unselected note remains');
        await note.click(); await page.keyboard.press(key); await note.waitFor({ state: 'detached' });
      }
    }
    report.checks.push('Delete and Backspace notes in review, calendar, cadence; editing, selection, IME');
    await page.reload(); await page.waitForTimeout(500);
    const sticky = await (await fetch(url + '/api/start-sticky-notes')).json();
    assert.equal(sticky.notes.length, 0, 'note deletions persisted');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('test artifacts:', root);
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      console.error(await page.evaluate(() => ({ error: document.querySelector('.review-import-error')?.textContent,
        status: document.querySelector('.review-import-status')?.textContent, workers: window.importWorkers,
        body: document.querySelector('.review-import-card')?.innerText })));
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(String(error.stack || error).slice(0, 2500)); process.exitCode = 1; });
