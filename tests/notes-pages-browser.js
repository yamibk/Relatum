'use strict';

// Real server + disposable user data. Playwright/Edge belong to the test host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');

function installProbe() {
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  localStorage.setItem('canvas:notesCreateBrowseShortcutsDisabled:v1', '0');
  if (!localStorage.getItem('canvas:notesView')) localStorage.setItem('canvas:notesView', JSON.stringify({ x: 18, y: 22, scale: 1 }));
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap();
  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (type === 'keydown' && this.matches?.('.sticky-note-body')) {
      let set = listeners.get(this); if (!set) listeners.set(this, set = new Set()); set.add(handler);
    }
    return nativeAdd.call(this, type, handler, options);
  };
  EventTarget.prototype.removeEventListener = function (type, handler, options) {
    if (type === 'keydown') listeners.get(this)?.delete(handler);
    return nativeRemove.call(this, type, handler, options);
  };
  const nativeFrame = requestAnimationFrame.bind(window), nativeCancel = cancelAnimationFrame.bind(window), pending = new Map();
  window.requestAnimationFrame = callback => {
    const id = nativeFrame(time => { pending.delete(id); callback(time); });
    pending.set(id, callback.name || '(anonymous)'); return id;
  };
  window.cancelAnimationFrame = id => { pending.delete(id); nativeCancel(id); };
  window.__quickProbe = { pending: () => [...pending.values()], listeners: element => listeners.get(element)?.size || 0 };
}

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notes-pages-'));
  fs.mkdirSync(path.join(dataRoot, 'data'));
  const notesFile = path.join(dataRoot, 'data', 'notes.json');
  const legacy = { version: 1, notes: [
    { id: 'old-a', x: 100, y: 120, text: '第一页甲', color: 'sage', rotate: -2 },
    { id: 'old-b', x: 420, y: 120, text: '第一页乙', color: 'pink', rotate: 3 },
  ], edges: [{ id: 'old-edge', from: 'old-a', to: 'old-b' }], arrows: [] };
  const original = JSON.stringify(legacy);
  fs.writeFileSync(notesFile, original);
  const port = await new Promise(resolve => {
    const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, page;
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  const checks = [];
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try { const runtime = await (await fetch(url + '/api/runtime')).json(); assert.equal(path.resolve(runtime.root), dataRoot); break; }
      catch (error) { if (i > 100 || server.exitCode != null) throw Error(logs || error.message); await delay(100); }
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    await context.addInitScript(installProbe);
    await context.route('**/notes.js', route => {
      const source = fs.readFileSync(path.join(root, 'assets/notes.js'), 'utf8').replace('  schedulePreload();',
        '  window.__quickState = () => ({currentPage, loaded, touched, archiving, saveTimer, editing: !!editSession, modelText: notes[0]?.text, state: pageStates.get(currentPage) && {dirty: pageStates.get(currentPage).dirty, revision: pageStates.get(currentPage).revision}});\n  schedulePreload();');
      return route.fulfill({ body: source, contentType: 'application/javascript' });
    });
    page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const disk = () => JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    const pageData = number => {
      const all = disk(); return Object.fromEntries(['notes', 'edges', 'arrows'].map(key => [key, all[key].filter(item => (item.notePage || 1) === number)]));
    };
    const eventually = async (predicate, attempts = 100) => {
      for (let i = 0; i < attempts; i++) { if (predicate()) return; await delay(50); }
      assert(predicate(), 'expected saved page data');
    };
    const turn = async number => {
      assert.equal(await page.evaluate(number => CanvasNotes.changePage(number), number), true);
      await page.waitForFunction(number => CanvasNotes.getPage() === number && !document.querySelector('.notes-surface').inert, number);
      await page.waitForTimeout(210);
    };
    const body = id => page.locator(`.sticky-note[data-id="${id}"] .sticky-note-body`);
    const edit = async (id, text) => { await body(id).dblclick(); await body(id).fill(text); await body(id).press('Escape'); };
    const create = async (x, y, text) => {
      const before = await page.locator('.sticky-note').count();
      const bounds = await page.locator('.notes-surface').boundingBox();
      await page.mouse.dblclick(bounds.x + x, bounds.y + y);
      await page.waitForFunction(count => document.querySelectorAll('.sticky-note').length === count, before + 1);
      const id = await page.locator('.sticky-note').last().getAttribute('data-id');
      if (text) await edit(id, text);
      return id;
    };
    await page.goto(url + '/?view=notes');
    if (!process.argv.includes('--large-only')) {
    await page.waitForFunction(() => window.CanvasNotes && CanvasNotes.count() === 2);
    await page.waitForTimeout(850);
    assert.equal(fs.readFileSync(notesFile, 'utf8'), original, 'reading legacy data never rewrites the file');
    assert.match(await page.locator('.notes-world').getAttribute('style'), /18px,\s*22px/);
    checks.push('legacy data and first-page camera');
    await page.evaluate(() => { CanvasNotes.resetView(); CanvasNotes.setInertia(0); });

    await page.mouse.move(1437, 170); await page.waitForTimeout(250);
    assert(await page.locator('.notes-page-rail').evaluate(el => el.classList.contains('revealed')));
    await page.screenshot({ path: path.join(dataRoot, 'pages-wide-light.png') });
    await page.evaluate(() => {
      window.__fadeSample = new Promise(resolve => {
        const surface = document.querySelector('.notes-surface');
        const observer = new MutationObserver(() => {
          if (!surface.classList.contains('notes-page-switching')) return;
          observer.disconnect();
          getComputedStyle(surface).opacity;
          setTimeout(() => resolve({ page: CanvasNotes.getPage(), oldMounted: !!surface.querySelector('[data-id="old-a"]'),
            opacity: Number(getComputedStyle(surface).opacity), inline: surface.getAttribute('style'),
            animations: surface.getAnimations().map(animation => ({ time: animation.currentTime, frames: animation.effect.getKeyframes() })) }), 55);
        });
        observer.observe(surface, { attributes: true, attributeFilter: ['class'] });
      });
    });
    await page.locator('[data-note-page="2"]').click();
    const fade = await page.evaluate(() => __fadeSample);
    assert.equal(fade.page, 1, 'old page remains mounted during fade-out');
    assert(fade.oldMounted && (fade.opacity < .98 || fade.animations.some(animation => animation.frames.at(-1).opacity === '0')), JSON.stringify(fade));
    await page.waitForFunction(() => CanvasNotes.getPage() === 2 && !document.querySelector('.notes-surface').inert);
    assert.equal(await page.locator('.sticky-note').count(), 0);
    const second = await create(380, 230, '第二页内容');
    await eventually(() => pageData(2).notes.some(note => note.text === '第二页内容'));
    const firstPage = pageData(1);
    assert.equal(firstPage.notes.length, 2);
    assert.equal(disk().version, 2);
    checks.push('rail hover, fade, scoped creation and real saves');

    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(110); await page.keyboard.up('ArrowRight');
    const camera = () => page.locator('.notes-world').evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform); return { x: matrix.m41, y: matrix.m42, scale: matrix.a };
    });
    const secondCamera = await camera();
    await turn(1);
    assert.equal(await body('old-a').textContent(), '第一页甲');
    assert.equal(await page.locator(`.sticky-note[data-id="${second}"]`).count(), 0);
    await edit('old-a', '第一页改动');
    await turn(2);
    const restoredCamera = await camera();
    assert(Math.abs(restoredCamera.x - secondCamera.x) <= .051 && Math.abs(restoredCamera.y - secondCamera.y) <= .051
      && Math.abs(restoredCamera.scale - secondCamera.scale) <= .00051, 'page camera survives switching at the established save precision');
    await page.mouse.move(900, 650); await page.mouse.click(900, 650);
    await page.keyboard.press('Control+z');
    assert.equal(await body(second).textContent(), '', 'undo belongs to the second page');
    await page.keyboard.press('Control+y');
    assert.equal(await body(second).textContent(), '第二页内容');
    await turn(1);
    assert.equal(await body('old-a').textContent(), '第一页改动');
    checks.push('page DOM, camera and undo isolation');

    for (let i = 0; i < 6; i++) { await body('old-a').dblclick(); await body('old-a').press('Escape'); }
    assert.equal(await body('old-a').evaluate(el => __quickProbe.listeners(el)), 0, 'finished editing releases keyboard listeners');
    await page.mouse.click(900, 650); await page.keyboard.press('/'); await page.keyboard.insertText('改动');
    assert.equal(await page.locator('.sticky-note.search-match').count(), 1);
    await turn(2);
    assert.equal(await page.locator('.notes-search-capture').count(), 0, 'search closes before a page switch');
    checks.push('editing listener cleanup and local search');

    await body(second).dblclick(); await body(second).fill('归档前最后输入');
    const archive = await page.evaluate(() => CanvasNotes.archive());
    assert.equal(archive.count, 1);
    const archived = JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', '学习归档', archive.folder, 'notes.json'), 'utf8'));
    assert.equal(archived.notes[0].text, '归档前最后输入', 'archive waits for editor/save handoff');
    assert.deepEqual(pageData(2), { notes: [], edges: [], arrows: [] });
    assert.equal(pageData(1).notes.find(note => note.id === 'old-a').text, '第一页改动');
    await turn(1); await page.mouse.click(900, 650); await page.keyboard.press('Control+z');
    assert.equal(await body('old-a').textContent(), '第一页甲', 'archiving another page retains history');
    checks.push('current-page archive and draft handoff');

    await context.route('**/api/notes?notePage=3', async route => {
      await delay(220);
      await route.fulfill({ json: { notePage: 3, notes: [{ id: 'late', x: 100, y: 100, color: 'sage', text: '迟到' }], edges: [], arrows: [] } }).catch(() => {});
    });
    await page.evaluate(() => { window.__oldTurn = CanvasNotes.changePage(3); });
    await page.waitForTimeout(35); await turn(4); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 4);
    assert.equal(await page.locator('.sticky-note[data-id="late"]').count(), 0);
    await context.route('**/api/notes?notePage=5', route => route.fulfill({ status: 503, json: { error: '测试读取失败' } }));
    assert.equal(await page.evaluate(() => CanvasNotes.changePage(5)), false);
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 4);
    const fourth = await create(390, 250, '第四页');
    checks.push('last requested page wins and failed load keeps the old page');

    await eventually(() => pageData(4).notes.some(note => note.text === '第四页'));
    let failingSaves = 0;
    await context.route('**/api/notes-save', route => {
      if (route.request().postDataJSON().notePage === 4 && failingSaves++ === 0) return route.fulfill({ status: 500, json: { error: '测试保存失败' } });
      return route.continue();
    });
    await edit(fourth, '失败后仍保留的输入');
    await page.waitForTimeout(650);
    assert.equal(pageData(4).notes[0].text, '第四页', 'failed save does not replace data');
    await turn(1);
    await eventually(() => pageData(4).notes[0].text === '失败后仍保留的输入');
    await context.unroute('**/api/notes-save');
    checks.push('failed save stays dirty and retries with original page identity');

    await body('old-a').dblclick();
    await body('old-a').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.textContent = '输入法确认文字';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true }));
      window.__compositionTurn = CanvasNotes.changePage(2);
    });
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 1);
    assert.equal(await page.locator('.sticky-note.editing').count(), 1);
    await body('old-a').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: '输入法确认文字', bubbles: true })));
    assert.equal(await page.evaluate(() => __compositionTurn), true);
    await page.waitForTimeout(250);
    await eventually(() => pageData(1).notes.some(note => note.text === '输入法确认文字'));
    checks.push('IME candidate protection and delayed switch');

    await page.mouse.move(1438, 170); await page.waitForTimeout(230);
    await page.locator('[data-note-page="1"]').click({ button: 'right' });
    await page.locator('.study-color-popover [data-color="#e2ece4"]').click();
    assert.equal(await page.locator('[data-note-page="1"]').getAttribute('data-task-page-color'), '#e2ece4');
    const consoleBounds = await page.locator('[data-role="notes-view"]').boundingBox();
    await page.mouse.move(consoleBounds.x + consoleBounds.width - 22, consoleBounds.y + consoleBounds.height / 2);
    await page.waitForTimeout(230);
    await page.locator('[data-role="notes-console-trigger"]').click();
    assert.equal(await page.locator('.notes-page-rail').evaluate(el => el.inert && !el.classList.contains('revealed')), true);
    await page.locator('[data-role="notes-console-trigger"]').click();
    await turn(99);
    await page.locator('[data-role="notes-page-bottom"]').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator('[data-note-page="99"]').dispatchEvent('wheel', { deltaY: 120, deltaX: 0 });
    await page.waitForTimeout(240);
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 99, 'page 99 never wraps');
    const topScroller = page.locator('[data-role="notes-page-top"]');
    await topScroller.evaluate(el => { el.scrollTop = 0; });
    const topBounds = await topScroller.boundingBox();
    await page.mouse.move(topBounds.x + topBounds.width / 2, topBounds.y + topBounds.height / 2);
    await page.mouse.wheel(0, 160);
    await page.waitForTimeout(260);
    assert((await topScroller.evaluate(el => el.scrollTop)) > 0, 'native wheel scrolls the page list');
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 99, 'scrollable rail does not change the page');
    await turn(1);
    await page.locator('[data-note-page="2"]').focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.notePage), '1');
    await page.keyboard.press('Enter');
    await page.locator('[data-role="notes-page-top"]').evaluate(el => { el.scrollTop = 0; });
    await page.locator('[data-note-page="1"]').dispatchEvent('wheel', { deltaY: -120, deltaX: 0 });
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 1, 'page 1 never wraps');
    checks.push('page color, control gap and page boundaries');

    await context.route('**/api/notes?notePage=8', async route => {
      await delay(300); await route.fulfill({ json: { notes: [{ id: 'hidden-late', x: 0, y: 0, text: '隐藏响应' }], edges: [], arrows: [] } }).catch(() => {});
    });
    await page.evaluate(() => { window.__hiddenTurn = CanvasNotes.changePage(8); });
    await page.waitForTimeout(40);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await page.waitForTimeout(380);
    assert.equal(await page.evaluate(() => CanvasNotes.getPage()), 1);
    assert.equal(await page.locator('.sticky-note[data-id="hidden-late"]').count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await page.waitForTimeout(650);
    assert.equal(await page.locator('.sticky-note.editing').count(), 0);
    checks.push('native minimize cancels late page work and restores the current page');

    await page.setViewportSize({ width: 560, height: 820 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await turn(4); await page.waitForTimeout(600);
    assert.equal(await page.locator('[data-note-page="4"]').getAttribute('aria-label'), 'Quick Notes page 4');
    await page.screenshot({ path: path.join(dataRoot, 'pages-narrow-dark.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload(); await page.waitForFunction(() => window.CanvasNotes && CanvasNotes.getPage() === 4 && CanvasNotes.count() === 1);
    assert.equal(await body(fourth).textContent(), '失败后仍保留的输入');
    await page.waitForTimeout(1100);
    assert.deepEqual(await page.evaluate(() => __quickProbe.pending()), [], 'idle has no pending animation frames');
    checks.push('narrow/dark/English/reduced motion, restart and idle frames');
    }
    await page.evaluate(async () => {
      const notes = Array.from({ length: 96 }, (_, i) => ({ id: 'large-' + i, x: i ? 10000 : 160, y: i ? 10000 : 130,
        text: i ? '长'.repeat(1200) : '大数据', color: 'sage', rotate: 0 }));
      const response = await fetch('/api/notes-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notePage: 98, notes, edges: [], arrows: [] }) });
      if (!response.ok) throw Error('Large fixture failed');
      localStorage.setItem('canvas:notesPage:v1', '98');
    });
    await page.reload();
    await page.waitForFunction(() => window.CanvasNotes && CanvasNotes.getPage() === 98 && CanvasNotes.count() === 96);
    await page.waitForTimeout(450);
    await edit('large-0', '大数据正文保存');
    await eventually(() => pageData(98).notes.find(note => note.id === 'large-0')?.text === '大数据正文保存', 240);
    assert.equal(pageData(98).notes.length, 96, 'large UTF-8 payload saves the complete current page');
    assert.equal(await page.locator('.notes-world .sticky-note').count(), 96, 'only the active page owns DOM');
    checks.push('large UTF-8 page save and active-page DOM only');
    assert.deepEqual(errors, [], 'no browser errors');
    const report = { dataRoot, checks, errors };
    fs.writeFileSync(path.join(dataRoot, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(dataRoot, 'failure.png') }).catch(() => {});
    if (page) console.error(await page.evaluate(() => window.__quickState?.()).catch(() => null));
    console.error('Disposable test data:', dataRoot, JSON.stringify({ checks })); throw error;
  } finally {
    if (browser) await browser.close();
    server.kill(); await new Promise(resolve => server.exitCode != null ? resolve() : server.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
