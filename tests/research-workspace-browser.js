'use strict';
// Real page + real API, isolated from every existing user-data directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-research-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/runtime`)).ok) break; } catch {}
      await sleep(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      window.__closeCalls = 0;
      window.pywebview = { api: { set_dirty() {}, set_note_workspace_active() {}, set_research_workspace_active() {},
        get_window_state: async () => ({ maximized: false }), close_window: async () => { window.__closeCalls++; } } };
    });
    const page = await context.newPage(); const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.goto(`${base}/?desktop=1`);
    assert(!requests.some(url => url.includes('/research/')), 'research assets/API must remain lazy');
    await page.locator('[data-start-workspace="research"]').click();
    const host = page.locator('#start-research-workspace');
    const action = name => host.locator(`[data-action="${name}"]`);
    await action('create').waitFor({ state: 'visible' });
    assert(!fs.existsSync(path.join(root, 'research')), 'opening empty workspace must not create data');
    await action('create').click(); await action('add').waitFor({ state: 'visible' });
    await action('add').click();
    await host.locator('.research-card').waitFor();
    const label = host.locator('input[name="label"]');
    await label.fill('发电商出力');
    await host.locator('input[name="unit"]').fill('MW');
    await action('table').click();
    assert.match(await host.locator('tbody').innerText(), /发电商出力/);
    await label.fill('学习'); // Must never be translated as UI content.
    await page.evaluate(() => window.RelatumI18n.setLanguage('en'));
    assert.match(await host.locator('tbody').innerText(), /学习/);
    await page.evaluate(() => window.RelatumI18n.setLanguage('zh'));
    await label.fill('发电商出力');
    await action('canvas').click();
    const card = host.locator('.research-card').first();
    const box = await card.boundingBox();
    await page.mouse.move(box.x + 60, box.y + 45); await page.mouse.down();
    await page.mouse.move(box.x + 135, box.y + 85, { steps: 5 }); await page.mouse.up();
    const moved = await card.evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
    await action('undo').click();
    assert.equal(await card.evaluate(element => parseFloat(element.style.left)), moved.x - 75);
    await action('redo').click();
    assert.equal(await card.evaluate(element => parseFloat(element.style.left)), moved.x);
    await action('remove').click(); assert.equal(await host.locator('.research-card').count(), 0);
    await action('table').click(); assert.equal(await host.locator('tbody tr').count(), 1);
    await action('undo').click(); await action('canvas').click(); assert.equal(await host.locator('.research-card').count(), 1);
    await action('reference').click(); assert.equal(await host.locator('.research-card').count(), 2);
    assert.equal(await page.evaluate(() => window.RelatumResearchWorkspace.flush()), true);
    const saved = await (await fetch(`${base}/api/research/project?id=project-main`)).json();
    assert.equal(saved.project.objects.length, 1);
    assert.equal(saved.project.views[0].representations.length, 2);
    assert.equal(saved.project.objects[0].payload.label, '发电商出力');
    await page.screenshot({ path: path.join(root, 'research-light.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(root, 'research-dark.png') });
    await page.setViewportSize({ width: 620, height: 600 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(root, 'research-narrow.png') });
    assert(await host.locator('input[name="label"]').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });

    // Web Lock makes a second page in the same profile read-only.
    const second = await context.newPage(); await second.goto(`${base}/?desktop=1`);
    await second.locator('#start-research-workspace [data-action="add"]').waitFor({ state: 'visible' });
    assert(await second.locator('#start-research-workspace [data-action="add"]').isDisabled());
    await second.close();

    // Rapid switching returns to the latest requested workspace; Notes keeps its own save flow.
    await page.evaluate(async () => {
      await Promise.all(['notes', 'canvas', 'career', 'research'].map(name => window.RelatumStartWorkspace.set(name)));
    });
    assert.equal(await page.evaluate(() => document.body.dataset.startWorkspace), 'research');
    await page.reload(); await host.locator('.research-card').first().waitFor();
    assert.equal(await host.locator('.research-card').count(), 2);
    await host.locator('.research-object-list button').click();
    assert.equal(await label.inputValue(), '发电商出力');

    // A synthetic composition draft must not reach autosave; committed text must.
    await label.focus();
    await label.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.value = 'zhong'; element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await sleep(650);
    let disk = JSON.parse(fs.readFileSync(path.join(root, 'research/project-main/project.json'), 'utf8'));
    assert.equal(disk.objects[0].payload.label, '发电商出力');
    await label.evaluate(element => {
      element.value = '中文变量'; element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文变量' }));
    });
    await page.locator('[data-window-action="close"]').first().click();
    await page.waitForFunction(() => window.__closeCalls === 1);
    disk = JSON.parse(fs.readFileSync(path.join(root, 'research/project-main/project.json'), 'utf8'));
    assert.equal(disk.objects[0].payload.label, '中文变量');

    // A failed save blocks switching, preserves input, and can be retried.
    await page.route('**/api/research/save', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) }));
    await label.fill('保留失败草稿');
    assert.equal(await page.evaluate(() => window.RelatumStartWorkspace.set('canvas')), false);
    assert.equal(await label.inputValue(), '保留失败草稿');
    await page.unroute('**/api/research/save'); await action('retry').click();
    await page.waitForFunction(() => !window.RelatumResearchWorkspace.dirty);

    // External rewrite with unchanged revision is detected by byte fingerprint.
    const file = path.join(root, 'research/project-main/project.json');
    disk = JSON.parse(fs.readFileSync(file, 'utf8')); disk.title = '外部版本';
    fs.writeFileSync(file, JSON.stringify(disk));
    await label.fill('冲突草稿');
    assert.equal(await page.evaluate(() => window.RelatumResearchWorkspace.flush()), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, '外部版本');
    assert(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('recovery-')));
    assert.equal(await label.inputValue(), '冲突草稿');
    assert.equal(await action('export').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', root, checks: 'lazy load, create, shared identity, rename, drag, undo/redo, remove/reference, save/reopen, read-only window, four-workspace switching, themes, narrow, reduced motion, synthetic IME, desktop close, failed save retry, external conflict' }, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
