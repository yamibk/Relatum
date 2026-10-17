'use strict';

// Real rename controls and wheel navigation; all API writes and user files are isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-navigation-edit-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Keep the failure oracle on the pre-refactor source after these tests are committed.
const baselineRef = execFileSync('git', ['rev-parse', process.env.RELATUM_NAV_BASELINE_REF || '95e6e523'],
  { cwd: repo, encoding: 'utf8' }).trim();
const report = { baselineRef, checks: [], artifacts: root };

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

async function fixture(browser, url, baseline) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const names = ['原始名称', '另一张画布'];
  const groups = [{ id: 'g0', name: '分组零' }, { id: 'g1', name: '分组一' }];
  const files = names.map((title, index) => ({ path: path.join(root, 'canvases', `fixture-${index}.canvas`),
    title, exists: true, groupId: 'g' + index, favorite: false, lastOpenedAt: '2026-10-17T00:00:00Z' }));
  const renames = [], groupRenames = [], errors = [];
  await context.addInitScript(() => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
    localStorage.setItem('canvas:startTheme', 'light');
    localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
    localStorage.setItem('canvas:activeGroup', 'g0');
    localStorage.setItem('canvas:hideSpecialPages', '0');
    localStorage.setItem('canvas:startTurnMs', '260');
    localStorage.setItem('canvas:noteGraphPreload:v1', '0');
  });
  if (baseline) {
    for (const name of ['start.js', 'styles.css']) {
      const body = execFileSync('git', ['show', `${baselineRef}:assets/${name}`], { cwd: repo, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
      await context.route(new RegExp('/' + name.replace('.', '\\.') + '(?:\\?.*)?$'), route =>
        route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body }));
    }
  }
  await context.route('**/api/recent', route => route.fulfill({ json: { files, groups, recentLimit: 30 } }));
  await context.route('**/api/file-stats', route => route.fulfill({ json: { files: [] } }));
  await context.route('**/api/rename', async route => {
    const body = route.request().postDataJSON(); renames.push(body);
    const file = files.find(file => file.path === body.path); if (file) file.title = body.newName;
    // The late metadata refresh must preserve whichever group navigation finally submitted.
    await pause(180);
    await route.fulfill({ json: { ok: true, path: body.path, title: body.newName } });
  });
  await context.route('**/api/group-rename', route => {
    const body = route.request().postDataJSON(); groupRenames.push(body);
    const group = groups.find(group => group.id === body.id); if (group) group.name = body.name;
    return route.fulfill({ json: { ok: true } });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + '/index.html');
  await page.waitForSelector('.page-dot[data-group-id="g0"].active');
  await page.waitForSelector('.recent-item');
  return { context, page, renames, groupRenames, errors };
}

async function renameFile(page, value) {
  await page.locator('.recent-item').first().click({ button: 'right' });
  await page.locator('[data-role="context-menu"]').getByRole('button', { name: /^(重命名|Rename)$/ }).click();
  const input = page.locator('.recent-rename-input');
  await input.fill(value);
  return input;
}

async function wheelNext(page) {
  await page.mouse.move(90, 350); await page.mouse.wheel(0, 80);
}

async function finalGroup(page) {
  await page.waitForSelector('.page-dot[data-group-id="g1"].active');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.page-dot.active').getAttribute('data-group-id'), 'g1');
}

async function candidateKey(input) {
  await input.evaluate(element => {
    for (const key of ['Enter', 'Escape']) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, keyCode: 229, bubbles: true }));
    }
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
  });
}

async function endComposition(input, value) {
  await input.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, value);
}

async function waitForGroupExit(page) {
  await page.waitForFunction(() => {
    const element = document.querySelector('.book-page');
    return element.classList.contains('flip-out-l') || element.classList.contains('flip-out-r')
      || element.getAnimations().some(animation => {
        const frames = animation.effect?.getKeyframes();
        return frames?.length && Number(frames[frames.length - 1].opacity) === 0;
      });
  });
}

async function runChecks(browser, url) {
  // Calibrate the failure oracle against the actual pre-refactor source, not an artificial mock.
  if (!process.argv.includes('--current-only')) {
    const f = await fixture(browser, url, true);
    try {
      const input = await renameFile(f.page, '候选尚未完成的名称');
      await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      await candidateKey(input); await f.page.waitForTimeout(250);
      assert.equal(await input.count(), 0, 'HEAD baseline closes the real input before the candidate is committed');
      assert.equal(f.renames.length, 1);
      assert.equal(f.renames[0].newName, '候选尚未完成的名称', 'baseline submits the pre-composition value');
      assert.deepEqual(f.errors, []);
      report.checks.push({ baseline: true, scenario: 'candidate-enter-premature-save', saveCount: f.renames.length });
    } finally { await f.context.close(); }
  }
  {
    const f = await fixture(browser, url, false);
    try {
      await f.page.locator('.page-dot[data-group-id="g1"]').evaluate(element => element.click());
      await f.page.waitForSelector('.page-dot[data-group-id="g1"].active');
      const continuity = await f.page.evaluate(() => {
        const element = document.querySelector('.book-page');
        const entrance = element.getAnimations().find(animation => {
          const frames = animation.effect?.getKeyframes();
          return !animation.animationName && !animation.transitionProperty && frames?.length
            && Number(frames[0].opacity) === 0 && Number(frames[frames.length - 1].opacity) === 1;
        });
        if (!entrance) throw new Error('A real committed group entrance is available for interruption');
        entrance.pause();
        entrance.currentTime = Number(entrance.effect.getTiming().duration) * .2;
        const before = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
        const originalAnimate = element.animate;
        window.libraryExitStart = null;
        element.animate = function (frames, options) {
          if (Array.isArray(frames) && Number(frames[frames.length - 1].opacity) === 0) {
            window.libraryExitStart = { opacity: Number(frames[0].opacity), transform: frames[0].transform };
          }
          return originalAnimate.call(this, frames, options);
        };
        document.querySelector('.page-dot[data-group-id="g0"]').click();
        const after = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
        // Sampling stays in the input task; the next target is still in its quiet period.
        return { before, after };
      });
      assert(continuity.before.opacity > .1 && continuity.before.opacity < .95, 'the interrupted entrance is genuinely intermediate');
      assert(Math.abs(continuity.before.opacity - continuity.after.opacity) < .001,
        'a new target does not cancel the currently displayed entrance before preparation');
      assert.equal(continuity.before.transform, continuity.after.transform,
        'the committed group retains its current transform during the input task');
      await f.page.waitForSelector('.page-dot[data-group-id="g0"].active');
      const exitStart = await f.page.evaluate(() => window.libraryExitStart);
      assert(exitStart, 'the next preparation owns a finite exit animation');
      assert(Math.abs(exitStart.opacity - continuity.before.opacity) < .001,
        'preparation continues the interrupted entrance opacity instead of restarting from one');
      assert.equal(exitStart.transform, continuity.before.transform,
        'preparation continues the exact interrupted transform');
      await f.page.waitForTimeout(330);
      assert(await f.page.locator('.book-page').evaluate(element => Number(getComputedStyle(element).opacity) > .99));
      assert.deepEqual(f.errors, []);
      report.checks.push({ scenario: 'committed-entrance-survives-new-request', continuity, exitStart });
    } finally { await f.context.close(); }
  }
  {
    const f = await fixture(browser, url, false);
    try {
      await f.page.locator('.page-dot[data-group-id="g1"]').evaluate(element => element.click());
      await f.page.waitForSelector('.page-dot[data-group-id="g1"].active');
      const continuity = await f.page.evaluate(() => {
        const element = document.querySelector('.book-page');
        const entrance = element.getAnimations().find(animation => {
          const frames = animation.effect?.getKeyframes();
          return !animation.animationName && !animation.transitionProperty && frames?.length
            && Number(frames[0].opacity) === 0 && Number(frames[frames.length - 1].opacity) === 1;
        });
        if (!entrance) throw new Error('A real group entrance is available before leaving the library');
        entrance.pause();
        entrance.currentTime = Number(entrance.effect.getTiming().duration) * .2;
        const before = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
        document.querySelector('.calendar-spine-tab').click();
        const afterInput = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
        return { before, afterInput };
      });
      assert(continuity.before.opacity > .1 && continuity.before.opacity < .95);
      assert(Math.abs(continuity.before.opacity - continuity.afterInput.opacity) < .001);
      assert.equal(continuity.before.transform, continuity.afterInput.transform);
      await f.page.waitForSelector('.calendar-spine-tab.active');
      const submitted = await f.page.evaluate(() => {
        const element = document.querySelector('.book-page'), stage = document.querySelector('[data-role="book-stage"]');
        return { view: document.querySelector('.book-view').dataset.viewName, leaving: stage.classList.contains('view-leaving'),
          retired: stage.getAttribute('aria-hidden') === 'true' && getComputedStyle(stage).visibility === 'hidden',
          opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
      });
      assert.equal(submitted.view, 'calendar');
      assert(submitted.leaving || submitted.retired, 'the library stage is exiting or has completed its early fade');
      assert(Math.abs(continuity.before.opacity - submitted.opacity) < .001,
        'committing a special page retains the old library entrance opacity beneath the outer exit');
      assert.equal(continuity.before.transform, submitted.transform,
        'committing a special page does not cancel the old library entrance transform');
      assert.deepEqual(f.errors, []);
      report.checks.push({ scenario: 'group-entrance-survives-special-commit', continuity, submitted });
    } finally { await f.context.close(); }
  }
  {
    const f = await fixture(browser, url, false);
    try {
      await renameFile(f.page, '滚轮前提交的名称'); await wheelNext(f.page); await finalGroup(f.page);
      assert.equal(f.renames.length, 1);
      assert.equal(f.renames[0].newName, '滚轮前提交的名称');
      assert.deepEqual(f.errors, []);
      report.checks.push({ scenario: 'wheel-saves-rename', saveCount: f.renames.length });
    } finally { await f.context.close(); }
  }
  for (const duringPreparation of [false, true]) {
    const f = await fixture(browser, url, false);
    try {
      const input = await renameFile(f.page, '候选中的名称');
      if (duringPreparation) {
        await wheelNext(f.page);
        await waitForGroupExit(f.page);
      }
      await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      await candidateKey(input);
      if (!duringPreparation) await wheelNext(f.page);
      await f.page.waitForTimeout(230);
      assert.equal(await input.count(), 1, 'candidate Enter/Escape does not replace the real rename input');
      assert.equal(await f.page.locator('.page-dot.active').getAttribute('data-group-id'), 'g0');
      assert.equal(f.renames.length, 0);
      assert(await f.page.locator('.book-page').evaluate(element => Number(getComputedStyle(element).opacity) > .98),
        'composition restores an outgoing page instead of leaving the editor faded out');
      await endComposition(input, '输入法完成后的最终名称'); await finalGroup(f.page);
      assert.equal(f.renames.length, 1);
      assert.equal(f.renames[0].newName, '输入法完成后的最终名称');
      assert.deepEqual(f.errors, []);
      report.checks.push({ scenario: duringPreparation ? 'composition-during-prepare' : 'composition-before-navigation', saveCount: f.renames.length });
    } finally { await f.context.close(); }
  }
  {
    const f = await fixture(browser, url, false);
    try {
      await f.page.locator('.page-dot[data-group-id="g0"]').click({ button: 'right' });
      await f.page.locator('[data-role="context-menu"]').getByRole('button', { name: /^(重命名分组|Rename group)$/i }).click();
      const input = f.page.locator('.spine-float-input'); await input.fill('候选分组');
      await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      await candidateKey(input);
      assert.equal(await input.count(), 1); assert.equal(f.groupRenames.length, 0);
      await endComposition(input, '最终分组名称'); await input.press('Enter');
      await f.page.waitForFunction(() => !document.querySelector('.spine-float-input'));
      await f.page.waitForTimeout(150);
      assert.equal(f.groupRenames.length, 1); assert.equal(f.groupRenames[0].name, '最终分组名称');
      assert.deepEqual(f.errors, []);
      report.checks.push({ scenario: 'group-rename-candidate', saveCount: f.groupRenames.length });
    } finally { await f.context.close(); }
  }
}

(async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch {} if (ready) break; await pause(100); }
    assert(ready, 'isolated local service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    await runChecks(browser, url);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('navigation edit browser passed: ' + path.join(root, 'report.json'));
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill();
  }
})().catch(error => { console.error(error); console.error('artifacts: ' + root); process.exitCode = 1; });
