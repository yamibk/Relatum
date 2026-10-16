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
    assert(!requests.some(value => /review-import|sheetjs/.test(value)), 'no importer resources before opening');
    async function open() { await trigger.click(); await page.locator('.review-import-paste').waitFor(); }
    const next = () => page.locator('[data-import-next]');
    const dialog = page.locator('.review-import-card');
    const cards = async () => (await (await fetch(url + '/api/review-cards')).json()).cards;
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

    const text = '单词\t释义\t例句\t卡组\t标签\n001\t第一\t"one\nsecond"\tCore\tcore\n001\t第一\t"one\nsecond"\tCore\tcore\n\t缺少问题\t\tCore\t\n\t\t\t\t';
    await fill(text);
    assert.equal(await page.locator('.review-import-sample h4').textContent(), '001');
    assert(!requests.some(value => value.includes('sheetjs')), 'pasted data does not load XLSX library');
    await page.screenshot({ path: path.join(root, 'mapping-light.png') });
    await next().click();
    await page.locator('.review-import-counts').waitFor();
    assert.deepEqual(await page.locator('.review-import-counts strong').allTextContents(), ['1', '1', '1', '1']);
    assert.equal((await cards()).length, 0, 'preview writes no cards');
    assert((await page.locator('.review-import-table .is-invalid').textContent()).includes('问题不能为空'));
    await page.screenshot({ path: path.join(root, 'confirm-light.png') });
    await next().click(); await page.locator('.review-import-complete').waitFor();
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
    await answerMapping.getByRole('combobox', { name: '答案：添加列', exact: true }).selectOption('1');
    await answerMapping.getByRole('button', { name: '向前移动', exact: true }).click();
    await answerMapping.getByLabel('显示列名', { exact: true }).check();
    assert((await page.locator('.review-import-sample').innerText()).includes('音标: wɜːd\n释义: 单词'));
    await page.locator('.review-import-organize summary').click();
    await page.getByLabel('统一卡组', { exact: true }).fill('Custom deck');
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
    assert.equal(await page.getByRole('combobox', { name: '工作表', exact: true }).inputValue(), 'Visible');
    assert.equal(await page.locator('.review-import-sample h4').textContent(), 'xlsx-word');
    assert(requests.some(value => value.includes('sheetjs/xlsx.full.min.js')));
    await close(); report.checks.push('XLSX, local vendor, first visible sheet');

    const csvPath = path.join(root, 'legacy.csv');
    fs.writeFileSync(csvPath, Buffer.from([0x77,0x6f,0x72,0x64,0x2c,0x6d,0x65,0x61,0x6e,0x69,0x6e,0x67,0x0a,0x67,0x62,0x6b,0x2c,0xd6,0xd0,0xce,0xc4]));
    await open(); await page.locator('.review-import-formats summary').click();
    await page.getByRole('combobox', { name: '文件编码', exact: true }).selectOption('utf-8');
    await page.locator('.review-import-card input[type="file"]').setInputFiles(csvPath);
    await page.locator('.review-import-error:not([hidden])').waitFor();
    await page.getByRole('combobox', { name: '文件编码', exact: true }).selectOption('gb18030');
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

    for (const count of [1000, 10000]) {
      const started = Date.now();
      await fill('word\tmeaning\n' + Array.from({ length: count }, (_, i) => 'large-' + count + '-' + i + '\t释义 ' + i).join('\n'));
      assert.equal(await page.locator('.review-import-table tbody tr').count(), 50);
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
