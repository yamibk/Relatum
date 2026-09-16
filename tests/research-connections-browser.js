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
    // Alt-drag is a cancellable connection gesture, never a node move.
    const position = locator => locator.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
    const altDrag = async (cancel = false) => {
      const from = await a.boundingBox(), to = await b.boundingBox();
      await page.keyboard.down('Alt'); await page.mouse.move(from.x + 30, from.y + 30); await page.mouse.down();
      await page.mouse.move(to.x + 30, to.y + 30, { steps: 5 });
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up(); await page.keyboard.up('Alt');
    };
    const startPosition = await position(a);
    await altDrag(true); assert.equal(await edge.count(), 1);
    await altDrag(); assert.equal(await edge.count(), 2); assert.deepEqual(await position(a), startPosition);
    await action('undo').click(); assert.equal(await edge.count(), 1);
    // Typed creation does not create an object until the blank canvas is double-clicked.
    const cards = host.locator('.research-card'), countBefore = await cards.count();
    await host.locator('[data-create-type="formula"]').click(); assert.equal(await cards.count(), countBefore);
    const surface = host.locator('.research-canvas'), surfaceBox = await surface.boundingBox();
    await page.mouse.dblclick(surfaceBox.x + 20, surfaceBox.y + surfaceBox.height - 20);
    assert.equal(await cards.count(), countBefore + 1);
    assert.equal(await cards.last().locator('.research-card-type').textContent(), 'FORMULA');
    await action('undo').click(); assert.equal(await cards.count(), countBefore);
    // Child/sibling shortcuts only belong to the canvas, not text inputs.
    await a.click(); await page.keyboard.press('Tab');
    assert.equal(await cards.count(), countBefore + 1);
    const childId = await cards.last().getAttribute('data-representation');
    const child = host.locator(`[data-representation="${childId}"]`);
    await host.locator('[name="label"]').fill('子分支');
    await surface.focus(); await page.keyboard.press('Enter');
    assert.equal(await cards.count(), countBefore + 2);
    await host.locator('[name="label"]').fill('同级分支');
    await action('fit').click(); await child.click(); await page.keyboard.press('Tab');
    await host.locator('[name="label"]').fill('孙分支');
    const grandId = await cards.last().getAttribute('data-representation');
    const grand = host.locator(`[data-representation="${grandId}"]`);
    await action('fit').click(); await a.click(); await action('layout').click(); await action('fit').click();
    assert.equal(await host.locator('.research-link.is-branch').count(), 3);
    const beforeMove = await position(grand), beforeRoot = await position(a), unrelated = await position(b);
    let box = await a.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 25); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 60);
    assert.notDeepEqual(await position(grand), beforeMove);
    await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await position(grand), beforeMove);
    await page.mouse.move(box.x + 30, box.y + 25); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 60); await page.mouse.up();
    const movedRoot = await position(a), movedGrand = await position(grand);
    assert(Math.abs(movedGrand.x - beforeMove.x - (movedRoot.x - beforeRoot.x)) < .01);
    assert.deepEqual(await position(b), unrelated);
    await action('undo').click(); assert.deepEqual(await position(grand), beforeMove);
    await action('collapse').click(); assert(await child.isHidden()); assert(await grand.isHidden());
    assert.equal(await host.locator('.research-link:not(.is-branch)').count(), 1);
    await page.evaluate(() => window.RelatumResearchWorkspace.flush());
    await page.reload(); await a.waitFor(); assert(await child.isHidden());
    await host.locator('.research-object-list button').filter({ hasText: '孙分支' }).click(); await action('locate').click();
    assert(await child.isVisible()); assert(await grand.isVisible());
    await action('fit').click(); await child.click(); await action('remove').click();
    assert(await grand.isVisible()); assert.equal(await host.locator('.research-link.is-branch').count(), 1);
    await action('undo').click(); assert.equal(await host.locator('.research-link.is-branch').count(), 3);
    await child.click(); await action('detach').click(); assert.equal(await host.locator('.research-link.is-branch').count(), 2);
    await action('undo').click(); assert.equal(await host.locator('.research-link.is-branch').count(), 3);
    await page.evaluate(() => window.RelatumResearchWorkspace.flush());
    const savedTree = JSON.parse(fs.readFileSync(path.join(root, 'research/project-main/project.json'), 'utf8'));
    assert.equal(savedTree.relations.length, 1);
    assert.equal(savedTree.views[0].representations.filter(rep => rep.parentId).length, 3);
    const treeReader = await context.newPage(); await treeReader.goto(base);
    await treeReader.locator('.research-object-list button').first().click(); await treeReader.locator('[data-action="locate"]').click();
    for (const name of ['child', 'sibling', 'collapse', 'layout', 'detach']) assert(await treeReader.locator(`[data-action="${name}"]`).isDisabled());
    assert(await treeReader.locator('[data-create-type="note"]').isDisabled()); await treeReader.close();
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
    // Permanent deletion: both entry points, no dialog, no undo, response-loss retry.
    await page.setViewportSize({ width: 1280, height: 800 });
    let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
    await action('table').click();
    await page.screenshot({ path: path.join(root, 'object-table-delete.png') });
    const grandObject = savedTree.views[0].representations.find(rep => rep.id === grandId).objectId;
    await host.locator(`[data-delete-object="${grandObject}"]`).click();
    await page.waitForFunction(id => !document.querySelector(`[data-delete-object="${id}"]`), grandObject);
    assert(await action('undo').isDisabled()); assert(await action('redo').isDisabled());
    await action('canvas').click(); await action('fit').click(); await a.click();
    const recoveryPath = path.join(root, 'research/project-main/recovery-browser.json');
    fs.writeFileSync(recoveryPath, fs.readFileSync(path.join(root, 'research/project-main/project.json')));
    await page.route('**/api/research/delete-object', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await action('delete-object').click(); await action('retry').waitFor();
    await action('retry').click();
    await page.waitForFunction(() => !document.querySelector('[data-representation="rep-a"]'));
    assert(await action('undo').isDisabled()); assert(await action('redo').isDisabled());
    assert.equal(await host.locator('.research-link:not(.is-branch)').count(), 0);
    assert(await child.isVisible());
    assert(!JSON.parse(fs.readFileSync(recoveryPath, 'utf8')).objects.some(obj => obj.id === 'a'));
    await page.reload(); await b.waitFor();
    assert.equal(await host.locator('[data-delete-object="a"]').count(), 0);
    assert.equal(await host.locator(`[data-delete-object="${grandObject}"]`).count(), 0);
    const finalReader = await context.newPage(); await finalReader.goto(base);
    await finalReader.locator('.research-object-list button').first().click();
    assert(await finalReader.locator('[data-action="delete-object"]').isDisabled());
    await finalReader.locator('[data-action="table"]').click();
    for (const button of await finalReader.locator('[data-delete-object]').all()) assert(await button.isDisabled());
    await finalReader.close(); assert.equal(dialogs, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', root, checks: 'Q03 associations, Alt-drag/cancel, typed double-click, child/sibling shortcuts, layout, subtree move/cancel/undo, collapse/reopen/reveal, detach/removal, read-only, monochrome themes/narrow/reduced motion' }, null, 2));
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
