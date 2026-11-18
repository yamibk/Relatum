'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { features } = require('../assets/feature-catalog.json');

const native = process.argv.includes('--webview2');
const notesOnly = process.argv.includes('--notes-only');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-html-'));
const notes = path.join(root, 'notes');
const identity = '10b83e0a-c0d7-4f41-92a1-39a278952ee1';
const marker = id => '```html-embed ' + id + '\n```';
const companion = path.join(notes, 'Schedule.assets', 'html', identity);
const unusedId = '20b83e0a-c0d7-4f41-92a1-39a278952ee1';
const protectedId = '30b83e0a-c0d7-4f41-92a1-39a278952ee1';
const unused = path.join(notes, 'Schedule.assets', 'html', unusedId);
const protectedFile = path.join(notes, 'Schedule.assets', 'html', protectedId, 'Protected.htm');
const foreignDirectory = path.join(notes, 'Schedule.assets', 'html', '40b83e0a-c0d7-4f41-92a1-39a278952ee1');
const recycled = path.join(root, 'recycled');
const fixture = '<!doctype html><html lang="en"><head data-value="a > b"><style>body{margin:12px;height:950px}.week-band{display:flex;overflow:auto;width:min(90vw,650px)} .week-band span{flex:none;width:1400px}</style></head>'
  + '<body><button>Week 12</button><output></output><div class="week-band"><span></span><b>Selected week</b></div><div style="width:1300px;margin-top:680px">Wide report</div>'
  + '<script>document.querySelector("output").textContent = "Ready"; document.querySelector("button").onclick = event => event.target.textContent = "Week 13";</script>';
const filename = '我的课表.html';
const picker = path.join(root, filename);
fs.mkdirSync(companion, { recursive: true });
fs.mkdirSync(unused, { recursive: true });
fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
fs.mkdirSync(foreignDirectory, { recursive: true });
fs.mkdirSync(recycled);
fs.writeFileSync(path.join(companion, filename), fixture);
fs.writeFileSync(path.join(unused, 'Unused.html'), fixture);
fs.writeFileSync(protectedFile, fixture);
fs.writeFileSync(path.join(foreignDirectory, 'Extra.html'), fixture);
fs.writeFileSync(path.join(foreignDirectory, 'Keep.txt'), 'Preserve additional files');
fs.writeFileSync(picker, fixture);
fs.writeFileSync(path.join(notes, 'Schedule.md'), 'Before embed\n\n' + marker(identity) + '\n\n'
  + Array.from({ length: 300 }, (_, index) => `Paragraph ${index + 1}\n\n`).join('') + marker(identity) + '\n\nAfter embed: ' + protectedId.toUpperCase() + '\n');
fs.writeFileSync(path.join(notes, 'Import.md'), 'Insert here\n');
fs.writeFileSync(path.join(notes, 'Missing.md'), 'Missing file\n\n' + marker(identity)
  + '\n\n```html-embed invalid\n```\n\n```html-embed ' + identity + ' 9999x480\n```\n\n> ```html-embed ' + identity + '\n> ```\n');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  assert.fail(description);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

(async () => {
  const port = await freePort();
  const endpoint = 'http://127.0.0.1:' + port;
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const code = native ? 'import os, sys, app, desktop, webview; from pathlib import Path; '
    + 'app._move_paths_to_recycle_bin = lambda paths: [target.rename(Path(os.environ["RELATUM_DATA_ROOT"]) / "recycled" / target.name) for target in paths]; '
    + 'webview.window.Window.create_file_dialog = lambda *a, **kw: [os.environ["RELATUM_TEST_HTML_PICKER"]] '
    + 'if not Path(os.environ["RELATUM_TEST_HTML_PICKER"] + ".cancel").exists() else None; '
    + 'sys.argv[0] = "desktop.py"; sys.exit(desktop.main())' : 'import app, sys; sys.exit(app.main())';
  const args = ['-B', '-c', code];
  if (!native) args.push('--no-browser', '--port', String(port));
  if (notesOnly) args.push('--launch-profile', JSON.stringify({ version: 1,
    features: Object.fromEntries(features.map(({ id }) => [id, id === 'notes'])) }));
  let logs = '', child, browser, page;
  const writes = [];
  async function launch({ instrument = true } = {}) {
    child = spawn(python, args, { cwd: path.join(__dirname, '..'), windowsHide: true,
      env: { ...process.env, RELATUM_DATA_ROOT: root, RELATUM_TEST_HTML_PICKER: picker,
        ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } : {}) } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs = (logs + value).slice(-15000); });
    await waitFor(async () => {
      try { return (await fetch(endpoint + (native ? '/json/version' : '/api/runtime'))).ok; } catch { return false; }
    }, 'service did not start');
    browser = native ? await chromium.connectOverCDP(endpoint)
      : await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    page = native ? await waitFor(() => browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1')), 'desktop page did not start')
      : await browser.newPage({ viewport: { width: 1270, height: 880 }, reducedMotion: 'reduce' });
    page.on('console', msg => {
      if (msg.type() === 'error') logs = (logs + '\nBrowser: ' + msg.text()).slice(-15000);
    });
    page.on('pageerror', error => { logs = (logs + '\nBrowser: ' + error.stack).slice(-15000); });
    page.on('response', response => {
      if (response.url().endsWith('/api/note-save')) writes.push([response.status(), response.request().postData()?.slice(0, 190)]);
    });
    page.setDefaultTimeout(10000);
    if (!instrument) return;
    await page.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('canvas:toolbarLanguage', 'en');
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteView:v1', 'live');
    });
    const source = fs.readFileSync(path.join(__dirname, '../assets/note-workspace.js'), 'utf8');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source.replace(
      '  window.CanvasNoteWorkspace = {', '  window.__htmlTest = { state, openNote, setViewMode, flushSave, movePath, get editor() { return liveEditor; } };\n  window.CanvasNoteWorkspace = {') }));
    await page.goto(native ? page.url() : endpoint);
    await page.waitForFunction(native => window.__htmlTest?.state.initialized && __htmlTest.state.active && !__htmlTest.state.openingPath
      && (!native || typeof window.pywebview?.api?.note_html === 'function'), native);
  }
  async function restartDesktop() {
    const exited = new Promise(resolve => child.once('exit', resolve));
    await page.evaluate(() => { void window.pywebview.api.close_window(); }).catch(() => {});
    await Promise.race([exited, delay(10000)]);
    assert.notEqual(child.exitCode, null, 'the desktop instance exited');
    await browser.close().catch(() => {});
    await launch({ instrument: false });
  }
  try {
    await launch();
    const open = name => page.evaluate(name => __htmlTest.openNote(name, { reuseActiveTab: false }), name);
    const mode = name => page.evaluate(name => __htmlTest.setViewMode(name), name);
    const visibleBlock = () => page.locator('.note-html-embed:visible').first();
    const frames = page.locator('.note-html-embed:visible iframe');
    const getDocument = () => page.evaluate(() => __htmlTest.editor.snapshot().value);
    const shellPosition = () => page.evaluate(() => {
      const workspace = document.querySelector('.note-workspace');
      return [workspace.scrollLeft, workspace.querySelector('.note-tree-pane').getBoundingClientRect().x];
    });
    const drag = async (source, target, cancel = false) => {
      await source.hover();
      const box = await source.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 9 });
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
    };
    await open('Import.md');
    assert.equal(await page.locator('script[src$="note-html-embed.js"]').count(), 0);

    if (native) {
      const menu = page.locator('[data-role="note-context-menu"]');
      const selectImport = async () => {
        await page.locator('[data-role="note-editor"] .cm-line').filter({ hasText: 'Insert here' }).click({ button: 'right' });
        await menu.locator('[data-note-submenu="insert"]').hover();
        await menu.locator('[data-note-command="insert:html-embed"]').click();
        await menu.waitFor({ state: 'hidden' });
      };
      fs.writeFileSync(picker + '.cancel', '');
      await selectImport();
      assert.equal(await getDocument(), 'Insert here\n');
      assert.equal(fs.existsSync(path.join(notes, 'Import.assets')), false);
      fs.unlinkSync(picker + '.cancel');
      await selectImport();
      const source = await getDocument();
      const id = /```html-embed ([a-f0-9-]+)\n```/.exec(source)?.[1];
      assert(id, source);
      assert.equal(fs.readFileSync(path.join(notes, 'Import.assets', 'html', id, filename), 'utf8'), fixture);
      await waitFor(() => fs.readFileSync(path.join(notes, 'Import.md'), 'utf8').includes(marker(id)), 'import fence not saved');
      await page.keyboard.press('Control+z');
      assert.equal(await getDocument(), 'Insert here\n');
      await page.keyboard.press('Control+y');
      assert((await getDocument()).includes(marker(id)));
    }

    if (native) await page.evaluate(() => {
      window.savedHtmlBridge = window.pywebview.api.note_html;
      delete window.pywebview.api.note_html;
    });
    await open('Schedule.md');
    const block = visibleBlock();
    await block.waitFor();
    if (native) {
      await block.getByText('View in the Windows desktop app').waitFor();
      await page.evaluate(() => {
        window.pywebview.api.note_html = window.savedHtmlBridge;
        delete window.savedHtmlBridge;
        window.dispatchEvent(new Event('pywebviewready'));
      });
      const frame = block.frameLocator('iframe');
      await frame.getByRole('button', { name: 'Week 12' }).waitFor();
      assert.equal(await frames.count(), 1, 'only the visible HTML frame is loaded');
      assert.equal(await frame.locator('output').textContent(), '', 'static preview must not run script');
      assert.equal(await block.locator('iframe').evaluate(element => element.offsetHeight), 480);
      const scrollbarStyles = await frame.locator('html').evaluate(html => {
        return {
          mode: html.ownerDocument.compatMode, head: html.ownerDocument.head.dataset.value,
          sizes: [html, html.querySelector('.week-band')].map(element => [
            getComputedStyle(element, '::-webkit-scrollbar').width,
            getComputedStyle(element, '::-webkit-scrollbar').height,
            getComputedStyle(element, '::-webkit-scrollbar-button').display,
          ]),
        };
      });
      assert.deepEqual(scrollbarStyles, { mode: 'CSS1Compat', head: 'a > b', sizes: [['8px', '8px', 'none'], ['8px', '8px', 'none']] });
      await page.evaluate(() => window.pywebview.api.set_restored_size(1450, 860));
      await page.mouse.move(1, 1);
      const remove = block.getByRole('button', { name: 'Remove HTML block' });
      assert.deepEqual(await remove.evaluate(button => ({
        hoverOrFocus: button.closest('.note-html-embed').matches(':hover, :focus-within'),
        opacity: getComputedStyle(button).opacity,
      })), { hoverOrFocus: false, opacity: '1' });
      const before = await shellPosition();
      await block.getByRole('button', { name: 'Interact' }).click();
      await frame.getByText('Ready').waitFor();
      const innerOffset = await frame.locator('.week-band').evaluate(band => {
        band.lastElementChild.scrollIntoView({ block: 'nearest', inline: 'center' });
        return band.scrollLeft;
      });
      assert(innerOffset > 0, 'the nested week strip remains scrollable');
      assert.deepEqual(await shellPosition(), before, 'scrollIntoView must leave the file tree in place');
      assert(await frame.locator('html').evaluate(html => {
        const viewport = html.ownerDocument.scrollingElement;
        viewport.scrollLeft = 60;
        viewport.scrollTop = 80;
        const bothAxes = viewport.scrollLeft > 0 && viewport.scrollTop > 0;
        viewport.scrollTo(0, 0);
        return bothAxes;
      }), 'the framed document can scroll on both axes');
      await block.getByRole('button', { name: 'Exit interaction' }).click();
      assert.deepEqual(await shellPosition(), before);

      const original = await getDocument();
      const sizeHandle = block.locator('.note-html-resize');
      await sizeHandle.scrollIntoViewIfNeeded();
      let point = await sizeHandle.boundingBox();
      await drag(sizeHandle, { x: point.x - 100, y: point.y - 80 }, true);
      assert.equal(await getDocument(), original);
      assert.equal(await block.locator('iframe').evaluate(element => element.offsetHeight), 480);
      await block.getByRole('button', { name: 'Interact' }).click();
      await frame.getByText('Ready').waitFor();
      const address = await block.locator('iframe').getAttribute('src');
      await sizeHandle.scrollIntoViewIfNeeded();
      point = await sizeHandle.boundingBox();
      await drag(sizeHandle, { x: point.x - 100, y: point.y - 80 });
      const resized = await getDocument();
      assert.match(resized, new RegExp(identity + ' \\d+x39\\d'));
      assert.equal(await block.locator('iframe').getAttribute('src'), address, 'resizing retains the active webpage');
      assert((await block.locator('iframe').evaluate(element => element.offsetHeight)) < 480);
      await page.keyboard.press('Control+z');
      assert.equal(await getDocument(), original);
      await page.keyboard.press('Control+y');
      assert.equal(await getDocument(), resized);
      await waitFor(() => fs.readFileSync(path.join(notes, 'Schedule.md'), 'utf8') === resized, 'resized fence was not saved');
      await mode('reading');
      const sizedReading = page.locator('.note-reading-content .note-html-embed').first();
      await sizedReading.locator('iframe').waitFor();
      assert((await sizedReading.locator('iframe').evaluate(element => element.offsetHeight)) < 480);
      assert.equal(await sizedReading.getByRole('button', { name: 'Remove HTML block' }).count(), 0);
      await mode('live');
      await page.evaluate(() => { __htmlTest.editor.view.scrollDOM.scrollTop = 0; });
      const beforeText = page.locator('.cm-line').filter({ hasText: /^Before embed$/ });
      const bounds = await beforeText.boundingBox();
      await drag(block.getByRole('button', { name: 'Move HTML block', exact: true }), { x: bounds.x + 30, y: bounds.y + 2 });
      assert((await getDocument()).startsWith('```html-embed ' + identity + ' '));
      await page.keyboard.press('Control+z');
      assert.equal(await getDocument(), resized);
      await block.getByRole('button', { name: 'Remove HTML block' }).click();
      assert.equal((await getDocument()).split('```html-embed ' + identity).length - 1, 1);
      assert(fs.existsSync(path.join(companion, filename)));
      await page.keyboard.press('Control+z');
      assert.equal(await getDocument(), resized);
      await page.keyboard.press('Control+z');
      assert.equal(await getDocument(), original);

      const cleanupMenu = page.locator('[data-role="note-context-menu"] [data-note-action="cleanup-unused-html"]');
      const scheduleRow = page.locator('[data-role="note-tree"] [data-path="Schedule.md"] > .note-tree-row');
      async function openCleanup() {
        await scheduleRow.click({ button: 'right' });
        await cleanupMenu.click();
        const dialog = page.getByRole('dialog', { name: 'Clean up unused HTML' });
        await dialog.getByText('Unused.html', { exact: true }).waitFor();
        assert.deepEqual(await dialog.locator('li').allTextContents(), ['Unused.html']);
        return dialog;
      }
      let cleanup = await openCleanup();
      const capsuleStyle = () => cleanup.locator('footer > button').evaluateAll(buttons => buttons.map(button => {
        const { borderRadius, backgroundColor, color } = getComputedStyle(button);
        return [borderRadius, backgroundColor, color];
      }));
      await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
      const white = 'rgb(255, 255, 255)', black = 'rgb(0, 0, 0)';
      assert.deepEqual(await capsuleStyle(), [['999px', white, black], ['999px', black, white]]);
      await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
      assert.deepEqual(await capsuleStyle(), [['999px', black, white], ['999px', white, black]]);
      await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
      await cleanup.getByRole('button', { name: 'Cancel' }).click();
      assert(fs.existsSync(unused));
      cleanup = await openCleanup();
      fs.appendFileSync(path.join(unused, 'Unused.html'), '<!-- changed after confirmation opened -->');
      await cleanup.getByRole('button', { name: 'Move to Recycle Bin' }).click();
      await page.getByText('The note or attachments changed. Reopen cleanup to review the files.', { exact: true }).waitFor();
      assert(fs.existsSync(unused));
      cleanup = await openCleanup();
      await cleanup.getByRole('button', { name: 'Move to Recycle Bin' }).click();
      await waitFor(() => fs.existsSync(path.join(recycled, unusedId, 'Unused.html')), 'unused attachment was not recycled');
      assert(fs.existsSync(protectedFile) && fs.existsSync(foreignDirectory)
        && fs.readFileSync(path.join(companion, filename), 'utf8') === fixture);
      await page.evaluate(() => {
        window.RelatumNoteTheme.apply('apple');
        document.body.dataset.startTheme = 'dark';
        return window.pywebview.api.set_restored_size(720, 680);
      });
      assert(await block.evaluate(element => element.getBoundingClientRect().width <= element.parentElement.getBoundingClientRect().width + 1),
        'the preview follows the dark narrow note column');
      await block.getByRole('button', { name: 'Interact' }).click();
      await frame.getByText('Ready').waitFor();
      await frame.getByRole('button', { name: 'Week 12' }).click();
      await frame.getByRole('button', { name: 'Week 13' }).waitFor();
      await block.getByRole('button', { name: 'Exit interaction' }).click();
      await frame.getByRole('button', { name: 'Week 12' }).waitFor();
      await block.getByRole('button', { name: 'Interact' }).click();
      await frame.getByText('Ready').waitFor();
      await page.evaluate(() => { __htmlTest.editor.view.scrollDOM.scrollTop = 3200; });
      await frames.first().waitFor({ state: 'detached' });
      await page.evaluate(() => { __htmlTest.editor.view.scrollDOM.scrollTop = 0; });
      await frame.getByRole('button', { name: 'Week 12' }).waitFor();
      assert.equal(await frame.locator('output').textContent(), '');
    } else {
      await block.getByText('View in the Windows desktop app').waitFor();
      assert.equal(await frames.count(), 0);
      assert.equal(await block.getByRole('button', { name: 'Open in new tab' }).count(), 0);
    }

    await mode('source');
    assert.equal(await frames.count(), 0);
    assert((await getDocument()).includes(marker(identity)));
    await mode('reading');
    const readingBlock = page.locator('.note-reading-content .note-html-embed').first();
    await readingBlock.waitFor();
    if (native) {
      await readingBlock.getByRole('button', { name: 'Interact' }).click();
      await readingBlock.frameLocator('iframe').getByText('Ready').waitFor();
      await page.evaluate(() => window.pywebview.api.minimize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
      await frames.first().waitFor({ state: 'detached' });
      await page.evaluate(() => window.pywebview.api.toggle_maximize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
      await page.evaluate(() => window.pywebview.api.toggle_maximize());
      await readingBlock.frameLocator('iframe').getByRole('button', { name: 'Week 12' }).waitFor();
    }
    await open('Missing.md');
    await visibleBlock().getByText(native ? 'HTML file is missing' : 'View in the Windows desktop app').waitFor();
    assert.equal(await page.locator('.note-reading-content .note-html-embed').count(), 1, 'invalid and nested fences do not project');
    assert.equal(await frames.count(), 0);
    const output = await page.evaluate(source => {
      const host = document.createElement('div');
      window.RelatumNoteLiveEditor.renderMarkdown(host, source, 'Schedule.md', { print: true });
      return { iframe: host.querySelectorAll('iframe').length, label: host.querySelector('.note-html-embed-print')?.textContent };
    }, marker(identity));
    assert.deepEqual(output, { iframe: 0, label: 'Embedded HTML file' });
    if (native) {
      await open('Schedule.md');
      await mode('live');
      await page.evaluate(() => {
        __htmlTest.editor.view.scrollDOM.scrollTop = 0;
        return window.pywebview.api.set_restored_size(1450, 860);
      });
      const block = visibleBlock();
      const openInTab = block.getByRole('button', { name: 'Open in new tab' });
      assert.equal(await openInTab.evaluate(el => el.previousElementSibling.getAttribute('aria-label')), 'Remove HTML block');
      await openInTab.click();
      const tab = () => page.getByRole('tab', { name: filename, exact: true });
      const panel = () => page.locator('#note-html-tab-panel');
      const tabFrame = () => panel().frameLocator('iframe');
      await tabFrame().getByText('Ready').waitFor();
      assert.equal(await panel().locator('button').count(), 0);
      await tabFrame().getByRole('button', { name: 'Week 12' }).click();
      await tabFrame().getByRole('button', { name: 'Week 13' }).waitFor();
      const firstUrl = await panel().locator('iframe').getAttribute('src');
      await tab().click();
      assert.equal(await panel().locator('iframe').getAttribute('src'), firstUrl, 'reselecting a running tab keeps the page');

      if (!notesOnly) {
        await page.locator('[data-note-action="toggle-graph"]').click();
        await page.locator('#note-graph-panel').waitFor();
        assert.equal(await panel().locator('iframe').count(), 0);
        await tab().click();
        await tabFrame().getByText('Ready').waitFor();
      }
      await page.locator('[data-note-tab-path="Schedule.md"]').click();
      await mode('reading');
      await panel().locator('iframe').waitFor({ state: 'detached' });
      await readingBlock.getByRole('button', { name: 'Open in new tab' }).click();
      await tabFrame().getByText('Ready').waitFor();
      assert.equal(await tab().count(), 1, 'the same attachment selects its existing tab');
      await page.evaluate(() => window.pywebview.api.set_restored_size(720, 680));
      await page.waitForFunction(() => matchMedia('(max-width: 760px)').matches);
      const treeButton = page.locator('.note-tab-actions [data-note-action="toggle-tree"]');
      await treeButton.click();
      await page.locator('.note-workspace.tree-overlay-open').waitFor();
      await treeButton.click();
      await page.locator('.note-workspace.tree-overlay-open').waitFor({ state: 'detached' });
      await page.evaluate(() => window.pywebview.api.set_restored_size(1450, 860));
      assert(await page.evaluate(() => __htmlTest.movePath('Schedule.md', 'Renamed.md')));
      await tabFrame().getByText('Ready').waitFor();
      const order = await page.locator('[data-role="note-tabs"] [role="tab"]').allTextContents();
      const savedTab = await page.evaluate(() => {
        const records = JSON.parse(localStorage.getItem('canvas:noteOpenTabs:v1'));
        return records.find(item => item.kind === 'html');
      });
      assert.deepEqual(savedTab, { kind: 'html', path: 'Renamed.md', id: identity, name: filename });

      const additionalTabs = [identity, unusedId, protectedId].map((id, index) => {
        const name = 'Restored ' + (index + 1) + '.html';
        const directory = path.join(notes, 'Import.assets', 'html', id);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, name), fixture);
        return { kind: 'html', path: 'Import.md', id, name };
      });
      const appendRestoredTabs = records => page.evaluate(records => {
        const key = 'canvas:noteOpenTabs:v1', tabs = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify([...tabs, ...records]));
      }, records);

      await appendRestoredTabs(additionalTabs.slice(0, 2));
      await restartDesktop();
      await panel().waitFor();
      assert.deepEqual(await page.locator('[data-role="note-tabs"] [role="tab"]').allTextContents(),
        [...order, ...additionalTabs.slice(0, 2).map(tab => tab.name)]);
      assert.equal(await tab().getAttribute('aria-selected'), 'true');
      await tabFrame().getByText('Ready').waitFor();
      assert.equal(await page.locator('iframe[src^="https://relatum-html.invalid/"]').count(), 1, 'only the foreground HTML tab starts');
      await page.evaluate(() => window.pywebview.api.minimize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
      await panel().locator('iframe').waitFor({ state: 'detached' });
      await page.evaluate(() => window.pywebview.api.toggle_maximize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
      await tabFrame().getByText('Ready').waitFor();

      await appendRestoredTabs(additionalTabs.slice(2));
      await restartDesktop();
      await panel().waitFor();
      assert.equal(await tab().getAttribute('aria-selected'), 'true');
      await tabFrame().getByRole('button', { name: 'Week 12' }).waitFor();
      assert.equal(await tabFrame().locator('output').textContent(), '', 'four restored HTML tabs require explicit activation');
      await tab().press('Enter');
      await tabFrame().getByText('Ready').waitFor();

      fs.writeFileSync(path.join(notes, 'Renamed.md'), 'The HTML blocks were removed.\n');
      await page.locator('[data-role="note-tree"] [data-path="Renamed.md"] > .note-tree-row').click({ button: 'right' });
      await page.locator('[data-role="note-context-menu"] [data-note-action="cleanup-unused-html"]').click();
      const recycleHtml = page.getByRole('dialog', { name: 'Clean up unused HTML' });
      await recycleHtml.getByText(filename, { exact: true }).waitFor();
      await recycleHtml.getByRole('button', { name: 'Move to Recycle Bin' }).click();
      await panel().getByText('HTML file is missing').waitFor();
      assert(fs.existsSync(path.join(recycled, identity, filename)));
      await tab().locator('.note-tab-close').click();
      await tab().waitFor({ state: 'detached' });
      await page.locator('[data-note-tab-path="Renamed.md"]').click();
      await panel().waitFor({ state: 'hidden' });
    }
    console.log(`HTML embed verified (${native ? 'WebView2' : 'browser'}${notesOnly ? ', notes only' : ''})`);
  } catch (error) {
    console.error(error, logs.split('\n').filter(line => /Browser:|POST \/api\/note-save|Note HTML operation/.test(line)).slice(-15).join('\n'));
    console.error('Writes', writes, 'disk', JSON.stringify(fs.readFileSync(path.join(notes, 'Import.md'), 'utf8').slice(0, 150)));
    if (page) console.error(await page.evaluate(() => {
      const current = window.__htmlTest?.state.current;
      const panel = document.querySelector('#note-html-tab-panel');
      if (!current) return { panel: panel?.outerHTML, hidden: document.hidden,
        minimized: document.documentElement.dataset.desktopMinimized,
        nativeBridge: typeof window.pywebview?.api?.note_html, width: innerWidth, height: innerHeight };
      return current && { path: current.path, edit: current.editGeneration, saved: current.persistedGeneration,
        content: current.content.slice(0, 150), viewMode: __htmlTest.state.viewMode,
        scrollTop: document.querySelector('.cm-scroller')?.scrollTop,
        blocks: [...document.querySelectorAll('.note-html-embed')].map(el => ({
          text: el.textContent, top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height,
          hasFrame: !!el.querySelector('iframe'),
        })) };
    }).catch(() => null));
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    child?.kill();
    await delay(350);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-html-'));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* WebView2 can release its scratch profile late. */ }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
