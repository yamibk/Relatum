'use strict';

// Exercise the real Quick Notes page using a disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const dockSelector = '[data-role="notes-dock"]';
const rowSelector = '#notes-dock-row';
const toggleSelector = '[data-role="notes-slash-toggle"]';
const collapseSelector = '[data-role="notes-dock-collapse"]';
const surfaceSelector = '[data-role="notes-surface"]';
const notesCollapsedKey = 'canvas:notesDockCollapsed:v1';
const protectionKey = 'canvas:notesSlashDeletionDisabled:v1';
const fixedColorKey = 'canvas:notesFixedColor:v1';
const fixedColors = ['yellow', 'orange', 'coral', 'purple', 'blue', 'teal', 'green', 'stone', 'paper'];
const editorCollapsedKey = 'canvas:textToolbarCollapsed';
const desktopBridge = path.join(root, 'assets', 'desktop-preferences.js');

const fixture = {
  version: 2,
  notes: [
    { id: 'first', x: 300, y: 100, text: '第一张卡片', color: 'sage', rotate: 0, notePage: 1 },
    { id: 'second', x: 650, y: 100, text: '第二张卡片', color: 'pink', rotate: 0, notePage: 1 },
    { id: 'other-page', x: 300, y: 100, text: '另一页', color: 'pink', rotate: 0, notePage: 2 },
  ],
  edges: [{ id: 'line', from: 'first', to: 'second', notePage: 1 }],
  arrows: [{ id: 'arrow', x1: 320, y1: 310, x2: 520, y2: 310, notePage: 1 }],
};

async function verifyCreation(page, surface, row, toggle) {
  await page.evaluate(() => {
    CanvasNotes.setCreateBrowseShortcutsDisabled(false);
    CanvasNotes.resetView();
    RelatumStickyPalette.setEnabledKeys(['pink']);
  });
  const box = await surface.boundingBox();
  const empty = { x: box.x + 1090, y: box.y + 300 };
  const notes = surface.locator('.sticky-note');
  const editor = surface.locator('.sticky-note.editing .sticky-note-body');
  const selected = key => row.locator('[data-fixed-color="' + key + '"]').getAttribute('aria-pressed');
  const create = async (action, color, linked = false) => {
    const ids = await notes.evaluateAll(elements => elements.map(el => el.dataset.id));
    const edgeCount = await surface.locator('.notes-edge[data-id]').count();
    await action();
    await page.waitForFunction(count => CanvasNotes.count() === count, ids.length + 1);
    const added = await notes.evaluateAll((elements, ids) => elements.filter(el => !ids.includes(el.dataset.id))
      .map(el => ({ id: el.dataset.id, color: el.dataset.color })), ids);
    assert.equal(added.length, 1);
    assert.equal(added[0].color, color);
    assert.equal(await surface.locator('.notes-edge[data-id]').count(), edgeCount + Number(linked));
    return surface.locator('.sticky-note[data-id="' + added[0].id + '"]');
  };
  const stopEditing = async () => {
    await editor.waitFor();
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
  };

  // The main and numeric keypads both use the resulting digit, regardless of physical key.
  await page.keyboard.press('2');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {
    key: '4', code: 'Numpad4', location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD, bubbles: true, cancelable: true,
  })));
  assert.equal(await selected('purple'), 'true');
  await create(() => page.mouse.dblclick(empty.x, empty.y), 'purple');
  await page.mouse.move(box.x + 1180, box.y + 455);
  await create(() => page.keyboard.press('n'), 'purple');
  await editor.waitFor();
  const protection = await toggle.getAttribute('aria-pressed');
  await page.keyboard.type('10');
  assert.equal(await editor.textContent(), '10');
  assert.equal(await selected('purple'), 'true');
  assert.equal(await toggle.getAttribute('aria-pressed'), protection);
  await stopEditing();
  for (const key of ['Enter', 'Shift+Enter', 'Tab', 'Shift+Tab']) {
    await create(() => page.keyboard.press(key), 'purple', key.includes('Tab'));
    await stopEditing();
  }

  const original = surface.locator('.sticky-note[data-id="other-page"]');
  await original.hover();
  await create(() => page.keyboard.press('d'), 'pink');
  const existing = surface.locator('.sticky-note[data-color="purple"]').first();
  await existing.hover();
  await page.keyboard.press('c');
  await page.waitForFunction(() => document.querySelectorAll('.notes-surface .sticky-note[data-color="pink"]').length === 3);

  await page.keyboard.press('/');
  const search = page.locator('.notes-search-capture');
  await search.waitFor({ state: 'attached' });
  await page.keyboard.type('10');
  assert.equal(await search.inputValue(), '10');
  await page.keyboard.press('Escape');
  assert.equal(await selected('purple'), 'true');
  assert.equal(await toggle.getAttribute('aria-pressed'), protection);
  await page.evaluate(() => {
    for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }]) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, ...options }));
    }
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.showModal();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    dialog.close();
    dialog.remove();
  });
  assert.equal(await selected('purple'), 'true');

  const consoleTrigger = page.locator('[data-role="notes-console-trigger"]');
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await consoleTrigger.click();
  const fit = page.locator('[data-action="notes-fit-all"]');
  await fit.focus();
  await page.keyboard.press('1');
  assert.equal(await selected('purple'), 'true');
  const world = surface.locator('.notes-world');
  const camera = await world.getAttribute('style');
  await fit.click();
  await page.waitForFunction(style => document.querySelector('.notes-world').getAttribute('style') !== style, camera);
  await consoleTrigger.click();
  await page.evaluate(() => { CanvasNotes.resetView(); document.activeElement.blur(); });

  await page.keyboard.press('4');
  assert.equal(await selected('purple'), 'false');
  await create(() => page.mouse.dblclick(box.x + 300, box.y + 430), 'pink');
  await page.evaluate(() => CanvasNotes.beforeLeave());
}

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notes-dock-'));
  fs.mkdirSync(path.join(dataRoot, 'data'));
  fs.mkdirSync(path.join(dataRoot, 'canvases'));
  const notesFile = path.join(dataRoot, 'data', 'notes.json');
  const canvasFile = path.join(dataRoot, 'canvases', 'dock.canvas');
  const original = JSON.stringify(fixture);
  fs.writeFileSync(notesFile, original);
  fs.writeFileSync(canvasFile, JSON.stringify({ nodes: [], edges: [] }));

  const port = await new Promise(resolve => {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1', () => {
      const port = reservation.address().port;
      reservation.close(() => resolve(port));
    });
  });
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', browser, page;
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url + '/api/runtime');
        assert.equal(path.resolve((await response.json()).root), dataRoot);
        break;
      } catch (error) {
        if (attempt >= 100 || server.exitCode != null) throw Error(logs || error.message);
        await delay(100);
      }
    }
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    });
    const viewport = { width: 1440, height: 900 };
    const context = await browser.newContext({ viewport });
    await context.addInitScript({ content: `
      window.RelatumDesktopPreferencesSeed = { initialized: false, sessionKey: 'full', launchId: 'first', values: {} };
      window.__savedDesktopPreferences = {};
      window.pywebview = { api: {
        async update_window_preferences(delta) { Object.assign(window.__savedDesktopPreferences, delta); },
        async flush_window_preferences() {},
      } };
    ` + fs.readFileSync(desktopBridge, 'utf8') });
    const errors = [];
    const watch = testPage => {
      testPage.setDefaultTimeout(8000);
      testPage.on('pageerror', error => errors.push(error.message));
      return testPage;
    };
    page = watch(await context.newPage());
    let saves = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes-save') saves++;
    });
    const ready = testPage => testPage.waitForFunction(() =>
      document.body.dataset.startWorkspace === 'canvas'
        && document.querySelector('.book-view').dataset.viewName === 'notes'
        && document.querySelector('.notes-embedded').getAttribute('aria-hidden') === 'false'
        && window.CanvasNotes?.count() > 0);
    await page.goto(url + '/?view=notes');
    await ready(page);
    const dock = page.locator(dockSelector);
    const row = page.locator(rowSelector);
    const toggle = page.locator(toggleSelector);
    const swatches = row.locator('[data-fixed-color]');
    const selectedColors = () => row.locator('[data-fixed-color][aria-pressed="true"]')
      .evaluateAll(buttons => buttons.map(button => button.dataset.fixedColor));
    const collapse = page.locator(collapseSelector);
    const surface = page.locator(surfaceSelector);
    const slash = page.locator('.notes-slash');
    const counts = () => page.evaluate(() => ['.sticky-note', '.notes-edge[data-id]', '.notes-arrow[data-id]']
      .map(selector => document.querySelector('.notes-surface').querySelectorAll(selector).length));
    const waitCounts = expected => page.waitForFunction(expected =>
      ['.sticky-note', '.notes-edge[data-id]', '.notes-arrow[data-id]'].every((selector, index) =>
        document.querySelector('.notes-surface').querySelectorAll(selector).length === expected[index]), expected);
    const box = await surface.boundingBox();
    const swipeX = box.x + 410;
    const swipe = async (expectBlade, afterDrawing, scale = 1, steps = 14) => {
      const x = box.x + 410 * scale;
      await page.mouse.move(x, box.y + 35 * scale);
      await page.mouse.down();
      await page.mouse.move(x, box.y + 370 * scale, { steps });
      assert.equal(await slash.count(), expectBlade ? 1 : 0);
      if (afterDrawing) await afterDrawing();
      await page.mouse.up();
    };

    assert.equal(await row.locator('button').count(), 10);
    assert.deepEqual(await swatches.evaluateAll(buttons => buttons.map(button => ({
      color: button.dataset.fixedColor, shortcut: button.getAttribute('aria-keyshortcuts'),
      hex: button.style.getPropertyValue('--notes-swatch'), label: button.getAttribute('aria-label'),
      text: button.textContent,
    }))), await page.evaluate(keys => keys.map((key, index) => {
      const color = RelatumStickyPalette.byKey(key);
      return { color: key, shortcut: String(index + 1), hex: color.hex, label: color.zh + ' · ' + (index + 1), text: '' };
    }), fixedColors));
    assert.deepEqual(await selectedColors(), []);
    assert.equal(await toggle.textContent().then(text => text.trim()), '');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    assert.equal(await toggle.getAttribute('data-ui-tooltip'), '开启划线保护');
    assert.equal(await page.evaluate(keys => keys.every(key => localStorage.getItem(key) === null),
      [notesCollapsedKey, protectionKey, fixedColorKey]), true, 'first visit does not write defaults');
    await waitCounts([2, 1, 1]);

    await swatches.nth(0).click();
    assert.deepEqual(await selectedColors(), ['yellow']);
    await page.keyboard.press('3');
    assert.deepEqual(await selectedColors(), ['coral']);
    await page.keyboard.press('3');
    assert.deepEqual(await selectedColors(), []);
    await page.keyboard.down('9');
    await page.keyboard.down('9');
    await page.keyboard.up('9');
    assert.deepEqual(await selectedColors(), ['paper'], 'holding a digit does not clear the color it just selected');
    await swatches.nth(8).click();
    assert.deepEqual(await selectedColors(), []);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), fixedColorKey), null);

    await swipe(true, async () => {
      const captured = await surface.evaluate(el => {
        for (let pointerId = 1; pointerId <= 4; pointerId++) {
          if (!el.hasPointerCapture(pointerId)) continue;
          el.releasePointerCapture(pointerId);
          return true;
        }
        return false;
      });
      assert(captured, 'the swipe holds native pointer capture');
      await page.mouse.move(swipeX, box.y + 390);
      assert.equal(await slash.count(), 0, 'losing pointer capture clears the blade immediately');
    });
    assert.deepEqual(await counts(), [2, 1, 1]);

    await swipe(true, async () => {
      await page.keyboard.press('0');
      assert.equal(await slash.count(), 0, 'enabling protection cancels the active swipe immediately');
    });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await toggle.locator('.notes-slash-icon').evaluate(el => getComputedStyle(el).display), 'none');
    assert.notEqual(await toggle.locator('.notes-slash-icon-off').evaluate(el => getComputedStyle(el).display), 'none');
    await swipe(false);
    await page.keyboard.press('Control+z');
    await page.evaluate(() => CanvasNotes.beforeLeave());
    assert.deepEqual(await counts(), [2, 1, 1]);
    assert.equal(saves, 0, 'protected and canceled swipes create no history or saves');
    assert.equal(fs.readFileSync(notesFile, 'utf8'), original);

    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await toggle.evaluate(button => button.blur());
    await surface.evaluate(el => {
      el.style.transformOrigin = 'top left';
      el.style.transition = 'none';
      el.style.transform = 'scale(.8)';
    });
    await swipe(true, null, 0.8, 1); // Both samples are outside the card.
    await waitCounts([1, 0, 0]);
    await surface.evaluate(el => {
      el.style.transformOrigin = '';
      el.style.transform = '';
      el.style.transition = '';
    });
    await page.evaluate(() => CanvasNotes.beforeLeave());
    assert.equal(saves, 1);
    await page.keyboard.press('Control+z');
    await waitCounts([2, 1, 1]);
    await page.evaluate(() => CanvasNotes.beforeLeave());
    await slash.waitFor({ state: 'detached' });

    await toggle.click();
    await page.evaluate(() => CanvasNotes.setInertia(0));
    const world = surface.locator('.notes-world');
    const camera = await world.getAttribute('style');
    const dockBox = await dock.boundingBox();
    await page.mouse.move(box.x + 230, box.y + 370);
    await page.keyboard.down('Space');
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 400, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    assert.notEqual(await world.getAttribute('style'), camera, 'Space-drag still pans');
    assert.deepEqual(await dock.boundingBox(), dockBox, 'the dock does not move with the wall');
    await page.evaluate(() => CanvasNotes.resetView());

    const note = surface.locator('.sticky-note[data-id="first"]');
    const beforeDrag = await note.boundingBox();
    await page.mouse.move(beforeDrag.x + 80, beforeDrag.y + 40);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x + 135, beforeDrag.y + 45, { steps: 6 });
    await page.mouse.up();
    assert((await note.boundingBox()).x > beforeDrag.x + 35, 'protection preserves card dragging');
    await page.mouse.move(box.x + 310, box.y + 430);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + 560, box.y + 430, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await waitCounts([2, 1, 2]);

    await collapse.focus();
    await page.keyboard.press('Enter');
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    assert(await row.evaluate(el => el.inert));
    await row.waitFor({ state: 'hidden' });
    await page.keyboard.press('Shift+Tab');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), false);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('0');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('0');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('6');
    assert.deepEqual(await selectedColors(), ['teal']);
    await swipe(false);
    assert.deepEqual(await counts(), [2, 1, 2]);

    const pageTwo = page.locator('[data-role="notes-page-rail"] [data-note-page="2"]');
    await pageTwo.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => CanvasNotes.getPage() === 2 && CanvasNotes.count() === 1);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await selectedColors(), ['teal']);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => document.body.dataset.startWorkspace === 'notes');
    assert(await dock.evaluate(el => !!el.closest('[inert]')));
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('1');
    assert.deepEqual(await selectedColors(), ['teal']);
    await page.locator('button[data-start-workspace="canvas"]').click();
    await ready(page);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    await page.locator('.left-spine [data-action="study-view"]').click();
    await page.waitForFunction(() => document.querySelector('.notes-embedded').inert);
    await collapse.waitFor({ state: 'hidden' });
    await page.locator('.left-spine [data-action="notes-view"]').click();
    await ready(page);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await selectedColors(), ['teal']);

    const saved = await page.evaluate(async keys => {
      if (!await RelatumDesktopPreferences.flush()) throw Error('Could not flush the preference snapshot');
      return Object.fromEntries(keys.map(key => [key, window.__savedDesktopPreferences[key]]));
    }, [notesCollapsedKey, protectionKey, fixedColorKey]);
    assert.deepEqual(saved, { [notesCollapsedKey]: '1', [protectionKey]: '1', [fixedColorKey]: 'teal' });
    await page.goto(url + '/?view=notes');
    await ready(page);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await selectedColors(), ['teal']);

    await collapse.click();
    await page.evaluate(() => document.activeElement.blur());
    await verifyCreation(page, surface, row, toggle);

    const reopened = await browser.newContext({ viewport: { width: 420, height: 580 }, reducedMotion: 'reduce' });
    const seed = { initialized: true, sessionKey: 'full', launchId: 'reopened',
      values: { ...saved, 'canvas:startTheme': 'dark', 'canvas:toolbarLanguage': 'en' } };
    await reopened.addInitScript({ content: 'window.RelatumDesktopPreferencesSeed = ' + JSON.stringify(seed) + ';\n'
      + fs.readFileSync(desktopBridge, 'utf8') });
    const narrow = watch(await reopened.newPage());
    await narrow.goto(url + '/?view=notes');
    await ready(narrow);
    assert.equal(await narrow.locator(collapseSelector).getAttribute('aria-expanded'), 'false');
    assert.equal(await narrow.locator(collapseSelector).getAttribute('aria-label'), 'Expand toolbar');
    await narrow.locator(collapseSelector).click();
    const narrowRow = narrow.locator(rowSelector);
    const narrowButton = narrow.locator(toggleSelector);
    const narrowSelected = narrowRow.locator('[data-fixed-color][aria-pressed="true"]');
    assert.equal(await narrowSelected.getAttribute('data-fixed-color'), 'teal');
    assert.equal(await narrowSelected.getAttribute('data-ui-tooltip'), 'Teal · 6');
    assert(await narrowSelected.evaluate(el => getComputedStyle(el).boxShadow !== 'none'));
    assert.equal(await narrowButton.getAttribute('data-ui-tooltip'), 'Turn off swipe deletion protection');
    assert.equal(await narrowRow.getAttribute('aria-label'), 'Quick Notes toolbar');
    const styles = await narrowRow.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      const { backgroundColor, transitionDuration, backdropFilter } = getComputedStyle(el);
      return { x, y, width, height, backgroundColor, transitionDuration, backdropFilter };
    });
    assert.equal(styles.backgroundColor, 'rgba(20, 29, 28, 0.98)');
    assert.equal(styles.transitionDuration, '0s');
    assert.equal(styles.backdropFilter, 'none');
    assert(Math.abs(styles.x + styles.width / 2 - 210) <= 1);
    assert(Math.abs(styles.y + styles.height - (580 - 12)) <= 1);
    await narrowButton.click();
    await narrow.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    assert.equal(await narrowButton.getAttribute('data-ui-tooltip'), '开启划线保护');
    assert.equal(await narrow.locator(collapseSelector).getAttribute('aria-label'), '收起工具栏');
    assert.equal(await narrowSelected.getAttribute('data-ui-tooltip'), '青绿 · 6');
    await narrow.setViewportSize({ width: 320, height: 580 });
    assert(await narrowRow.evaluate(el => el.scrollWidth > el.clientWidth));
    assert.equal((await narrowButton.boundingBox()).width, 34);
    await narrowRow.locator('[data-fixed-color="paper"]').focus();
    assert(await narrowRow.evaluate(el => el.scrollLeft > 0));
    await narrowRow.evaluate(el => { el.scrollLeft = 0; });
    await narrow.locator(collapseSelector).click();
    await narrowRow.waitFor({ state: 'hidden' });
    await narrow.keyboard.press('9');
    assert.equal(await narrowSelected.getAttribute('data-fixed-color'), 'paper');
    await narrow.locator(collapseSelector).click();
    assert(await narrowRow.evaluate(el => {
      const selection = el.querySelector('[aria-pressed="true"]');
      return selection.getBoundingClientRect().right < el.getBoundingClientRect().right;
    }));
    await narrow.evaluate(key => localStorage.setItem(key, 'sage'), fixedColorKey);
    await narrow.goto(url + '/?view=notes');
    await ready(narrow);
    assert.equal(await narrowSelected.count(), 0, 'a color outside the nine swatches falls back to random');
    assert.equal(await narrow.evaluate(key => localStorage.getItem(key), fixedColorKey), 'sage', 'startup does not rewrite invalid preferences');
    assert.equal(await row.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(253, 253, 251, 0.97)');

    const editor = watch(await context.newPage());
    await editor.goto(url + '/editor.html?file=' + encodeURIComponent(canvasFile));
    const editorCollapse = editor.locator('[data-role="text-dock-collapse"]');
    await editorCollapse.waitFor({ state: 'visible' });
    assert.equal(await editorCollapse.getAttribute('aria-expanded'), 'false');
    await editorCollapse.click();
    assert.equal(await editorCollapse.getAttribute('aria-expanded'), 'true');
    const editorRow = editor.locator('#text-format-row');
    assert((await editorRow.locator('button').count()) > 1);
    assert.equal(await editor.evaluate(key => localStorage.getItem(key), editorCollapsedKey), '0');
    assert.equal(await editor.evaluate(key => localStorage.getItem(key), notesCollapsedKey), '0');
    await editorCollapse.click();
    await editorRow.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('Quick Notes toolbar browser regression: ok');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(dataRoot, 'failure.png') }).catch(() => {});
    console.error('Disposable test data:', dataRoot);
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill();
    if (server.exitCode == null) await new Promise(resolve => server.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
