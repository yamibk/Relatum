'use strict';
// Multi-project lifecycle with a real isolated service. Never uses the user's data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-research-projects-'));
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
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('canvas:researchEntryDisabled', '0'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/research/projects', async route => { await sleep(300); await route.continue(); });
    await page.goto(base); await page.locator('button[data-start-workspace="research"]').click();
    const host = page.locator('#start-research-workspace');
    const action = name => host.locator(`[data-action="${name}"]`);
    const nameInput = host.locator('[data-role="project-name"]');
    const title = host.locator('[data-role="project-title"]');
    const rail = host.locator('.research-project-rail');
    const current = () => host.locator('[data-project-id][aria-current="true"]').getAttribute('data-project-id');
    const flush = () => page.evaluate(() => window.RelatumResearchWorkspace.flush());
    const select = async id => {
      await rail.hover(); await host.locator(`[data-project-id="${id}"]`).click();
      await page.waitForFunction(id => document.querySelector(`[data-project-id="${id}"][aria-current="true"]`), id);
      await flush();
    };
    const rename = async value => {
      await action('rename-project').click(); await nameInput.fill(value); await nameInput.press('Enter');
    };
    const read = id => JSON.parse(fs.readFileSync(path.join(root, 'research', id, 'project.json'), 'utf8'));
    await action('create').waitFor();
    await page.waitForFunction(() => !document.querySelector('#start-research-workspace [data-action="create"]').disabled);
    await page.unroute('**/api/research/projects');
    assert(!fs.existsSync(path.join(root, 'research')));
    await action('create').click(); await action('add').waitFor(); await flush();
    const first = await current();
    await rename('研究甲');
    await action('note').click(); await host.locator('[name="source"]').fill('甲项目的记录');
    await action('table').click(); await flush();
    await rail.hover(); await action('new-project').click(); await flush();
    const second = await current(); assert.notEqual(first, second);
    assert.equal(await title.textContent(), '研究项目 2');
    assert.equal(await host.locator('.research-card').count(), 0);
    await rename('研究乙');
    await action('formula').click(); await host.locator('[name="source"]').fill('x^2');
    await flush();
    // Rapid duplicate clicks and a lost successful creation response must produce one project.
    let lose = true;
    await page.route('**/api/research/create', async route => {
      if (lose) { lose = false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await rail.hover();
    await action('new-project').evaluate(button => { button.click(); button.click(); });
    assert.equal(await flush(), false);
    assert.equal(await current(), second);
    assert.equal((await (await fetch(`${base}/api/research/projects`)).json()).projects.length, 3);
    await action('new-project').click(); assert.equal(await flush(), true);
    const third = await current(); assert.notEqual(third, second);
    assert.equal((await (await fetch(`${base}/api/research/projects`)).json()).projects.length, 3);
    await page.unroute('**/api/research/create');
    await rename('研究丙'); await flush();
    await select(first);
    assert.equal(await action('table').getAttribute('aria-pressed'), 'true');
    assert.equal(await title.textContent(), '研究甲');
    assert.equal(read(first).objects[0].payload.source, '甲项目的记录');
    await action('undo').click(); // First project's content history, never the third project's title.
    assert.equal(await title.textContent(), '研究甲');
    await action('redo').click();
    await action('canvas').click(); await action('fit').click();
    const camera = await host.locator('.research-scene').evaluate(element => element.style.transform);
    await select(second); await select(first);
    assert.equal(await host.locator('.research-scene').evaluate(element => element.style.transform), camera);
    // Project name edit: cancellation, empty input, IME completion before switching.
    await action('rename-project').click(); await nameInput.fill('取消'); await nameInput.press('Escape');
    assert.equal(await title.textContent(), '研究甲');
    await rename('  '); assert.equal(await title.textContent(), '研究甲');
    await action('rename-project').click();
    await nameInput.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = 'yan';
    });
    await host.locator(`[data-project-id="${second}"]`).evaluate(button => button.click());
    assert.equal(await current(), first);
    await nameInput.evaluate(input => {
      input.value = '研究甲最终'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '研究甲最终' }));
    });
    await flush(); assert.equal(await current(), second); assert.equal(read(first).title, '研究甲最终');
    // A failed save blocks the switch, keeping the current editable draft intact.
    await page.route('**/api/research/save', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated failure"}' }));
    await rename('研究乙待保存'); await rail.hover(); await host.locator(`[data-project-id="${third}"]`).click();
    assert.equal(await flush(), false); assert.equal(await current(), second);
    assert.equal(await title.textContent(), '研究乙待保存');
    await page.unroute('**/api/research/save'); await action('retry').click(); await flush();
    await select(third);
    // Target load failure preserves current project and its history.
    await page.route(`**/api/research/project?id=${first}`, route => route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"corrupt fixture","code":"corrupt_project"}' }));
    await host.locator(`[data-project-id="${first}"]`).click(); await flush();
    assert.equal(await current(), third); assert.equal(await title.textContent(), '研究丙');
    await page.unroute(`**/api/research/project?id=${first}`);
    // Reacquiring after another editor changed the file invalidates stale session undo.
    const external = read(first); external.title = '外部修改';
    fs.writeFileSync(path.join(root, 'research', first, 'project.json'), JSON.stringify(external));
    await select(first); assert.equal(await title.textContent(), '外部修改'); assert(await action('undo').isDisabled());
    // Same-project locks, release on switch, and independent projects across windows.
    const other = await context.newPage(); await other.goto(base);
    const otherHost = other.locator('#start-research-workspace');
    await otherHost.locator('[data-action="add"]').waitFor();
    assert(await otherHost.locator('[data-action="add"]').isDisabled());
    await select(second);
    await otherHost.locator('.research-project-rail').hover();
    await otherHost.locator(`[data-project-id="${third}"]`).click();
    await other.evaluate(() => window.RelatumResearchWorkspace.flush());
    await otherHost.locator(`[data-project-id="${first}"]`).click();
    await other.evaluate(() => window.RelatumResearchWorkspace.flush());
    assert(!(await otherHost.locator('[data-action="add"]').isDisabled()));
    assert(!(await action('add').isDisabled())); await other.close();
    await select(third); await page.reload(); await action('add').waitFor();
    assert.equal(await current(), third); assert.equal(await title.textContent(), '研究丙');
    assert.deepEqual((await (await fetch(`${base}/api/research/projects`)).json()).projects.map(item => item.id), [first, second, third]);
    // Keyboard reveal/navigation and touch-style explicit toggle.
    await action('toggle-projects').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.projectId), first);
    await page.keyboard.press('Escape'); await page.mouse.move(10, 10);
    await action('toggle-projects').dispatchEvent('click');
    assert(await rail.evaluate(element => element.classList.contains('is-open')));
    await page.evaluate(() => window.RelatumI18n.setLanguage('en'));
    assert.equal(await title.textContent(), '研究丙');
    await page.evaluate(() => window.RelatumI18n.setLanguage('zh'));
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['dark', 620]]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await page.emulateMedia({ reducedMotion: 'reduce' }); await rail.hover();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `projects-${theme}-${width}.png`) });
    }
    // Long lists stay within the reserved gutter; the add button remains reachable.
    for (let i = 0; i < 24; i++) {
      const result = await fetch(`${base}/api/research/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ projectId: `overflow-${i}`, title: `列表项目 ${i}` }) });
      assert(result.ok);
    }
    await page.evaluate(() => window.RelatumResearchWorkspace.activate()); await rail.hover();
    const geometry = await rail.evaluate(element => {
      const list = element.querySelector('.research-project-list');
      const add = element.querySelector('[data-action="new-project"]').getBoundingClientRect();
      return { scrollable: list.scrollHeight > list.clientHeight, addBottom: add.bottom, viewport: innerHeight, height: element.getBoundingClientRect().height };
    });
    assert(geometry.scrollable); assert(geometry.addBottom < geometry.viewport - 40); assert(geometry.height < geometry.viewport * .7);
    await host.locator('[data-project-id="overflow-23"]').focus();
    assert(await action('new-project').isVisible());
    await page.screenshot({ path: path.join(root, 'projects-overflow.png') });
    // Missing remembered project falls back to the first readable project without creating anything.
    await page.evaluate(() => localStorage.setItem('relatum:research:lastProject:v1', 'missing-project'));
    await page.reload(); await action('add').waitFor(); assert.equal(await current(), first);
    // Repeated switching over more projects than the cache can hold: heap/DOM/listeners must plateau.
    const stressIds = [];
    for (let i = 0; i < 12; i++) {
      const id = `stress-${i}`; stressIds.push(id);
      const created = await (await fetch(`${base}/api/research/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ projectId: id, title: `Stress ${i}` }) })).json();
      const project = created.project; project.revision++;
      project.objects = Array.from({ length: 24 }, (_, n) => ({ id: `object-${i}-${n}`, type: 'core.note', typeVersion: 1,
        payload: { label: `Note ${n}`, source: `Project ${i}, note ${n}\n${'bounded preview '.repeat(120)}` } }));
      project.views[0].representations = project.objects.map((object, n) => ({ id: `rep-${i}-${n}`, objectId: object.id, x: n % 6 * 300, y: Math.floor(n / 6) * 220 }));
      const saved = await fetch(`${base}/api/research/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ projectId: id, requestId: `fixture-${i}`, expectedRevision: 0, expectedFingerprint: created.fingerprint, project }) });
      assert(saved.ok);
    }
    await page.evaluate(() => window.RelatumResearchWorkspace.activate());
    const cdp = await context.newCDPSession(page);
    const measure = async () => {
      await sleep(250); await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage'), dom = await cdp.send('Memory.getDOMCounters');
      return { heap: heap.usedSize, ...dom };
    };
    const cycle = () => page.evaluate(async ids => {
      const start = performance.now();
      for (let round = 0; round < 3; round++) for (const id of ids) {
        document.querySelector(`[data-project-id="${id}"]`).click();
        if (!(await window.RelatumResearchWorkspace.flush())) throw new Error('Stress switch failed');
        if (!document.querySelector(`[data-project-id="${id}"][aria-current="true"]`)) throw new Error('Wrong active project');
        document.querySelector('[data-action="rename-project"]').click();
        await Promise.resolve();
        const input = document.querySelector('[data-role="project-name"]'); input.value = `${id}-${round}`;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await window.RelatumResearchWorkspace.flush();
      }
      return performance.now() - start;
    }, stressIds);
    const warmMs = await cycle(), baseline = await measure();
    await cycle(); const lastMs = await cycle(), after = await measure();
    assert(after.heap - baseline.heap < 4 * 1024 * 1024, JSON.stringify({ baseline, after }));
    assert(after.nodes - baseline.nodes < 200, JSON.stringify({ baseline, after }));
    assert(after.jsEventListeners - baseline.jsEventListeners < 30, JSON.stringify({ baseline, after }));
    assert(lastMs < warmMs * 3 + 1000, JSON.stringify({ warmMs, lastMs }));
    const locks = await page.evaluate(async () => (await navigator.locks.query()).held.filter(lock => lock.name.startsWith('relatum-research:')).length);
    assert.equal(locks, 1);
    await select(stressIds[0]);
    assert(await action('undo').isDisabled(), 'evicted project reloads saved data without old session history');
    assert.equal(await host.locator('.research-card').count(), 24);
    assert.equal(await page.evaluate(() => window.RelatumResearchWorkspace.dispose()), true);
    assert.equal(await host.locator('.research-card').count(), 0);
    await sleep(30);
    assert.equal(await page.evaluate(async () => (await navigator.locks.query()).held.filter(lock => lock.name.startsWith('relatum-research:')).length), 0);
    console.log(JSON.stringify({ stress: { switches: 108, baseline, after, warmMs, lastMs } }, null, 2));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', root, checks: 'multi-project creation/retry, rename/IME, histories/cameras, safe switching, external change, locks, reopen, keyboard and themes' }, null, 2));
  } finally {
    await browser?.close(); server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
