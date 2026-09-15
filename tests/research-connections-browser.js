'use strict';
// Isolated real service, deterministic graph fixture, actual pointer/keyboard gestures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-research-links-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/runtime`)).ok) break; } catch {}
      await sleep(100);
    }
    const post = async (name, body) => {
      const result = await fetch(`${base}/api/research/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
      assert(result.ok, await result.text().then(text => { if (!result.ok) return text; return ''; }));
    };
    await post('create', {});
    const loaded = await (await fetch(`${base}/api/research/project?id=project-main`)).json();
    const project = loaded.project; project.revision++;
    project.objects = ['a', 'b'].map((id, index) => ({ id, type: 'core.note', typeVersion: 1,
      payload: { label: index ? '实验观察' : '研究假设', source: index ? '比较不同参数下的结果。' : '记录需要检验的想法。' } }));
    project.views[0].representations = [{ id: 'rep-a', objectId: 'a', x: 0, y: 0 }, { id: 'rep-b', objectId: 'b', x: 440, y: 150 }];
    await post('save', { projectId: project.projectId, requestId: 'fixture', expectedRevision: 0, expectedFingerprint: loaded.fingerprint, project });
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.locator('button[data-start-workspace="research"]').click();
    const host = page.locator('#start-research-workspace'), action = name => host.locator(`[data-action="${name}"]`);
    const a = host.locator('[data-representation="rep-a"]'), b = host.locator('[data-representation="rep-b"]');
    await a.waitFor(); await action('fit').click();
    await a.click(); await action('connect').click(); await page.keyboard.press('Escape');
    assert.equal(await action('connect').getAttribute('aria-pressed'), 'false');
    await action('connect').click(); await b.click();
    const name = host.locator('[name="relationLabel"]'); await name.fill('提供依据');
    const edge = host.locator('.research-link'); assert.equal(await edge.count(), 1);
    assert.equal(await edge.locator('text').textContent(), '提供依据');
    await action('undo').click(); assert.equal(await edge.locator('text').textContent(), '');
    await action('undo').click(); assert.equal(await edge.count(), 0);
    await action('redo').click(); await action('redo').click();
    // Path remains attached to the moving card; pointer cancellation restores it.
    const original = await edge.locator('path').first().getAttribute('d');
    const rect = await b.boundingBox();
    await page.mouse.move(rect.x + 30, rect.y + 30); await page.mouse.down();
    await page.mouse.move(rect.x + 55, rect.y + 65);
    assert.notEqual(await edge.locator('path').first().getAttribute('d'), original);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await edge.locator('path').first().getAttribute('d'), original);
    await page.mouse.move(rect.x + 30, rect.y + 30); await page.mouse.down();
    await page.mouse.move(rect.x + 55, rect.y + 65); await page.mouse.up();
    assert.notEqual(await edge.locator('path').first().getAttribute('d'), original);
    await action('undo').click(); assert.equal(await edge.locator('path').first().getAttribute('d'), original);
    await b.click(); await action('remove').click(); assert.equal(await edge.count(), 0);
    assert.equal(await host.locator('.research-relation-list button').count(), 1);
    await action('undo').click(); assert.equal(await edge.count(), 1);
    // Actual geometry hit, not a synthetic click on the inspector.
    await edge.locator('text').click(); assert.equal(await name.inputValue(), '提供依据');
    await host.locator('.research-canvas').focus(); await page.keyboard.press('Delete');
    assert.equal(await edge.count(), 0); await action('undo').click();
    assert.equal(await edge.count(), 1);
    await page.evaluate(() => window.RelatumResearchWorkspace.flush());
    await page.reload(); await a.waitFor(); await action('fit').click();
    assert.equal(await edge.locator('text').textContent(), '提供依据');
    await edge.locator('text').click();
    await name.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = '提供依据zhong'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await sleep(600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'research/project-main/project.json'), 'utf8')).relations[0].label, '提供依据');
    await name.evaluate(el => {
      el.value = '提供依据中'; el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    });
    await name.fill('提供依据'); await page.evaluate(() => window.RelatumResearchWorkspace.flush());
    const reader = await context.newPage(); await reader.goto(base);
    await reader.locator('.research-relation-list button').click();
    assert(await reader.locator('[name="relationLabel"]').isDisabled());
    assert(await reader.locator('[data-action="delete-relation"]').isDisabled()); await reader.close();
    await host.locator('.research-object-list button').first().click(); await action('locate').click();
    const located = await a.boundingBox(), canvas = await host.locator('.research-canvas').boundingBox();
    assert(Math.abs(located.x + located.width / 2 - canvas.x - canvas.width / 2) < 2);
    await action('fit').click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      const background = await host.evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 17)');
      await page.screenshot({ path: path.join(root, `connections-${theme}.png`) });
    }
    await page.setViewportSize({ width: 620, height: 600 }); await action('fit').click();
    await page.screenshot({ path: path.join(root, 'connections-narrow.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ reducedMotion: 'reduce' }); await action('fit').click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', root, checks: 'Q03 associations, naming, history, path hit, drag cancellation, reference removal, save/reopen, locate/fit, monochrome themes/narrow/reduced motion' }, null, 2));
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
