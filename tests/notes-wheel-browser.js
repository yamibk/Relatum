'use strict';

// Real native wheel input against Study and Quick Notes; all user data is disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');

function installProbe() {
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  localStorage.setItem('canvas:notesView', JSON.stringify({ x: 0, y: 0, scale: 1 }));
  if (!localStorage.getItem('canvas:notesPage:v1')) localStorage.setItem('canvas:notesPage:v1', '1');
  localStorage.setItem('canvas:notesPageColors:v1', JSON.stringify({ version: 1, colors: { 2: '#e2ece4' } }));
  const nativeFrame = requestAnimationFrame.bind(window), nativeCancel = cancelAnimationFrame.bind(window);
  const pending = new Set();
  window.requestAnimationFrame = callback => {
    const id = nativeFrame(time => { pending.delete(id); callback(time); }); pending.add(id); return id;
  };
  window.cancelAnimationFrame = id => { pending.delete(id); nativeCancel(id); };
  const probe = window.__wheelProbe = { inputs: [], fades: [], mounts: [], pending: () => pending.size };
  const nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (type !== 'wheel' || !this.matches?.('.study-task-page-rail')) return nativeAdd.call(this, type, handler, options);
    const rail = this;
    return nativeAdd.call(this, type, function (event) {
      const sample = { trusted: event.isTrusted, delta: event.deltaY, at: performance.now() };
      probe.inputs.push(sample);
      handler.call(this, event);
      const active = rail.querySelector('.is-active');
      sample.active = Number(active?.dataset.notePage || active?.dataset.taskPage);
      sample.mounted = window.CanvasNotes?.getPage();
      sample.saved = localStorage.getItem('canvas:notesPage:v1');
      sample.feedbackMs = performance.now() - sample.at;
      requestAnimationFrame(() => {
        const button = rail.querySelector('.is-active'), orb = rail.querySelector('.study-task-page-orb');
        sample.framePage = Number(button?.dataset.notePage || button?.dataset.taskPage);
        sample.target = new DOMMatrix(orb.style.transform).m42;
        sample.expected = button.getBoundingClientRect().top - rail.getBoundingClientRect().top;
        sample.color = orb.dataset.taskPageColor || '';
        sample.duration = getComputedStyle(orb).transitionDuration;
        sample.easing = getComputedStyle(orb).transitionTimingFunction;
      });
    }, options);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const surface = document.querySelector('.notes-surface');
    if (!surface) return;
    new MutationObserver(records => {
      const changes = records.filter(record => record.type === 'attributes' && record.attributeName === 'class' && record.target === surface);
      changes.forEach((record, index) => {
        const was = (record.oldValue || '').split(/\s+/).includes('notes-page-switching');
        const next = index + 1 < changes.length ? changes[index + 1].oldValue : surface.className;
        const now = (next || '').split(/\s+/).includes('notes-page-switching');
        if (was !== now) probe.fades.push(now);
      });
      records.forEach(record => record.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        const notes = node.matches('.sticky-note') ? [node] : node.querySelectorAll('.sticky-note');
        notes.forEach(note => probe.mounts.push(note.dataset.id));
      }));
    }).observe(surface, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
}

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notes-wheel-'));
  fs.mkdirSync(path.join(dataRoot, 'data'));
  const notesFile = path.join(dataRoot, 'data/notes.json');
  fs.writeFileSync(notesFile, JSON.stringify({ version: 2, notes: Array.from({ length: 8 }, (_, i) => ({
    id: 'p' + (i + 1), notePage: i + 1, x: 240, y: 180, text: '页面 ' + (i + 1), color: 'sage', rotate: 0,
  })), edges: [], arrows: [] }));
  const port = await new Promise(resolve => {
    const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, notes;
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  const checks = [], comparison = {};
  try {
    const url = 'http://127.0.0.1:' + port;
    for (let i = 0; ; i++) {
      try { const runtime = await (await fetch(url + '/api/runtime')).json(); assert.equal(path.resolve(runtime.root), dataRoot); break; }
      catch (error) { if (i > 100 || server.exitCode != null) throw Error(logs || error.message); await delay(100); }
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    await context.addInitScript(installProbe);
    if (process.env.RELATUM_NOTES_WHEEL_BASE_REF) {
      const source = execFileSync('git', ['show', process.env.RELATUM_NOTES_WHEEL_BASE_REF + ':assets/notes.js'], { cwd: root, encoding: 'utf8' });
      await context.route('**/notes.js', route => route.fulfill({ body: source, contentType: 'application/javascript' }));
    }
    const responseDelays = new Map([[2, 550]]), failures = new Set();
    await context.route('**/api/notes?notePage=*', async route => {
      const number = Number(new URL(route.request().url()).searchParams.get('notePage'));
      await delay(responseDelays.get(number) || 0);
      if (failures.has(number)) await route.fulfill({ status: 503, json: { error: '测试目标读取失败' } }).catch(() => {});
      else await route.continue().catch(() => {});
    });
    const errors = [];
    notes = await context.newPage(); notes.on('pageerror', error => errors.push(error.message));
    notes.setDefaultTimeout(8000);
    await notes.goto(url + '/?view=notes');
    await notes.waitForFunction(() => window.CanvasNotes?.count() === 1);
    await notes.waitForTimeout(900);
    const railSelector = page => page === notes ? '[data-role="notes-page-rail"]' : '[data-role="study-task-page-rail"]';
    const active = page => page.locator(railSelector(page) + ' .is-active').evaluate(el => Number(el.dataset.notePage || el.dataset.taskPage));
    const settled = async number => {
      await notes.waitForFunction(number => CanvasNotes.getPage() === number && !document.querySelector('.notes-surface').inert, number);
      await notes.waitForTimeout(220);
      assert.equal(await active(notes), number);
    };
    const turn = async number => { assert.equal(await notes.evaluate(number => CanvasNotes.changePage(number), number), true); await settled(number); };
    const resetProbe = page => page.evaluate(() => { __wheelProbe.inputs = []; __wheelProbe.fades = []; __wheelProbe.mounts = []; });
    const hoverRail = async page => {
      await page.bringToFront();
      await page.mouse.move(1425, 150); await page.waitForTimeout(240);
      const bounds = await page.locator(railSelector(page)).boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60);
    };
    const burst = async (page, deltas, expected, interval = 20) => {
      await hoverRail(page); await resetProbe(page);
      for (let i = 0; i < deltas.length; i++) {
        await page.mouse.wheel(0, deltas[i]);
        await page.waitForFunction(count => __wheelProbe.inputs.length === count && __wheelProbe.inputs[count - 1].framePage != null, i + 1);
        assert.equal(await active(page), expected[i], 'rail follows each native wheel event');
        if (interval) await page.waitForTimeout(interval);
      }
      const samples = await page.evaluate(() => __wheelProbe.inputs);
      samples.forEach((sample, index) => {
        assert(sample.trusted, 'wheel input must be native');
        assert.equal(sample.active, expected[index], 'selection updates before the next frame');
        assert.equal(sample.framePage, expected[index]);
        assert(Math.abs(sample.target - sample.expected) < .6, 'orb target updates on the next frame');
      });
      return samples;
    };

    // The delayed target must not delay selection, color, or the orb, nor change save identity.
    comparison.delayed = await burst(notes, [120], [2]);
    assert.equal(comparison.delayed[0].mounted, 1);
    assert.equal(comparison.delayed[0].saved, '1');
    assert.equal(comparison.delayed[0].color, '#e2ece4');
    assert.equal(await notes.evaluate(() => CanvasNotes.getPage()), 1);
    await settled(2); responseDelays.delete(2);
    checks.push('delayed read: immediate selection/color/orb and unchanged mounted/save page');

    for (const number of [3, 4, 5, 6, 7, 8, 1]) await turn(number);
    const study = await context.newPage(); study.on('pageerror', error => errors.push(error.message));
    await study.goto(url + '/?view=study');
    await study.waitForSelector('[data-task-page="1"].is-active'); await study.waitForTimeout(900);
    const deltas = [120, 120, 120, -120], expected = [2, 3, 4, 3];
    comparison.study = await burst(study, deltas, expected);
    comparison.notes = await burst(notes, deltas, expected);
    await settled(3);
    assert.deepEqual(comparison.notes.map(sample => sample.active), comparison.study.map(sample => sample.active));
    assert.equal(comparison.notes[0].duration, comparison.study[0].duration);
    assert.equal(comparison.notes[0].easing, comparison.study[0].easing);
    const burstMotion = await notes.evaluate(() => ({ fades: __wheelProbe.fades, mounts: __wheelProbe.mounts }));
    assert.deepEqual(burstMotion.fades, [true, false], 'one uninterrupted fade during rapid retargeting');
    assert.deepEqual(burstMotion.mounts, ['p3'], 'only the final target mounts');
    comparison.burstMotion = burstMotion;
    comparison.slowStudy = await burst(study, [-120, 120], [2, 3], 230);
    comparison.slowNotes = await burst(notes, [-120, 120], [2, 3], 230);
    await settled(3);
    checks.push('Study/native wheel comparison: slow, fast, reverse, shared easing and one final mount');

    for (const ms of [180, 480]) {
      for (const page of [study, notes]) await page.evaluate(ms => document.documentElement.style.setProperty('--start-orb-ms', ms + 'ms'), ms);
      const studySample = await burst(study, [-120], [2]);
      const noteSample = await burst(notes, [-120], [2]); await settled(2);
      assert.equal(noteSample[0].duration, studySample[0].duration);
      assert.equal(parseFloat(noteSample[0].duration), ms / 1000);
      await burst(study, [120], [3]); await burst(notes, [120], [3]); await settled(3);
    }
    checks.push('two flip-speed values use the same Study orb timing');

    // Fine wheel input uses the same accumulation/reset window as Study.
    for (const page of [study, notes]) {
      await burst(page, [8, 8, 8], [3, 3, 4]); await page.waitForTimeout(230);
      await burst(page, [-8, -16], [4, 3]); await page.waitForTimeout(230);
      await burst(page, [8], [3]); await page.waitForTimeout(230);
      await burst(page, [16, 8], [3, 4]); await page.waitForTimeout(230);
    }
    await settled(4);
    checks.push('fine wheel threshold and 200ms reset match Study');

    await turn(1); await resetProbe(notes);
    assert.equal(await notes.evaluate(() => {
      window.__firstTurn = CanvasNotes.changePage(2); window.__sameTurn = CanvasNotes.changePage(2);
      return __firstTurn === __sameTurn;
    }), true, 'reselecting a pending target reuses its operation');
    await notes.waitForTimeout(45);
    await turn(1);
    assert.equal(await notes.evaluate(() => __firstTurn), false);
    assert.deepEqual(await notes.evaluate(() => __wheelProbe.mounts), [], 'reversing to the mounted page preserves DOM');
    assert.equal(await notes.evaluate(() => CanvasNotes.changePage(1)), true);
    checks.push('same-target deduplication and return to the mounted page');

    // Reload to discard page caches so these exercise real late/failing requests.
    await notes.reload(); await notes.waitForFunction(() => window.CanvasNotes?.count() === 1); await notes.waitForTimeout(850);
    responseDelays.set(5, 450); failures.add(7); responseDelays.set(7, 80);
    await resetProbe(notes);
    await notes.evaluate(() => { window.__lateTurn = CanvasNotes.changePage(5); });
    assert.equal(await active(notes), 5);
    await notes.waitForTimeout(35); await turn(6); await notes.waitForTimeout(460);
    assert.equal(await notes.evaluate(() => __lateTurn), false);
    assert.deepEqual(await notes.evaluate(() => __wheelProbe.mounts), ['p6']);
    await notes.evaluate(() => { window.__failedTurn = CanvasNotes.changePage(7); });
    assert.equal(await active(notes), 7);
    assert.equal(await notes.evaluate(() => __failedTurn), false);
    assert.equal(await active(notes), 6);
    assert.equal(await notes.locator('.sticky-note').getAttribute('data-id'), 'p6');
    assert.equal(await notes.evaluate(() => localStorage.getItem('canvas:notesPage:v1')), '6');
    failures.delete(7); responseDelays.clear();
    checks.push('late request rejected and failed final target restores old selection/content');

    await notes.evaluate(() => {
      window.__reverseFirst = CanvasNotes.changePage(5);
      // Let the first request start, then reverse twice in the same task so its
      // aborted entry is still in the request map when page 5 is requested again.
      window.__reverseFinal = Promise.resolve().then(() => {
        CanvasNotes.changePage(7); return CanvasNotes.changePage(5);
      });
    });
    assert.equal(await notes.evaluate(() => __reverseFinal), true); await settled(5);
    await turn(6);
    checks.push('rapid uncached reversal starts a fresh request after an abort');

    const body = notes.locator('.sticky-note-body'); await body.dblclick();
    await body.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.textContent = '输入法最终正文';
      window.__imeTurn = CanvasNotes.changePage(2);
    });
    assert.equal(await active(notes), 2);
    assert.equal(await notes.evaluate(() => CanvasNotes.getPage()), 6);
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only');
    await body.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(await notes.evaluate(() => __imeTurn), true); await settled(2);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes.find(note => note.id === 'p6').text === '输入法最终正文') break;
      await delay(50);
    }
    assert.equal(JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes.find(note => note.id === 'p6').text, '输入法最终正文');
    assert.equal(JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes.find(note => note.id === 'p2').text, '页面 2');
    checks.push('IME keeps the editor mounted and saves under the source page identity');

    for (const lifecycle of ['minimized', 'hidden', 'departure']) {
      responseDelays.set(9, 300);
      await notes.evaluate(() => { window.__cancelledTurn = CanvasNotes.changePage(9); });
      assert.equal(await active(notes), 9);
      await notes.evaluate(lifecycle => {
        if (lifecycle === 'minimized') { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); }
        else if (lifecycle === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
        else CanvasNotes.deactivate();
      }, lifecycle);
      assert.equal(await notes.evaluate(() => __cancelledTurn), false);
      await notes.waitForTimeout(330);
      assert.equal(await notes.evaluate(() => CanvasNotes.getPage()), 2);
      await notes.evaluate(lifecycle => {
        if (lifecycle === 'minimized') { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); }
        else if (lifecycle === 'hidden') { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }
        else return CanvasNotes.activate();
      }, lifecycle);
      await notes.waitForTimeout(280); assert.equal(await active(notes), 2);
    }
    responseDelays.clear();
    checks.push('minimize, document hide and departure cancel pending targets');

    responseDelays.set(9, 300);
    await context.route('**/api/notes-archive', route => route.fulfill({ status: 500, json: { error: '测试归档失败' } }));
    await notes.evaluate(() => {
      window.__beforeArchiveTurn = CanvasNotes.changePage(9);
      window.__failedArchive = CanvasNotes.archive().then(() => true, () => false);
    });
    assert.equal(await active(notes), 2, 'archive cancellation immediately restores the mounted page selection');
    assert.equal(await notes.evaluate(() => __beforeArchiveTurn), false);
    assert.equal(await notes.evaluate(() => __failedArchive), false);
    assert.equal(await notes.locator('.sticky-note').getAttribute('data-id'), 'p2');
    await context.unroute('**/api/notes-archive'); responseDelays.clear();
    checks.push('archive cancels the target and restores the mounted selection even when archiving fails');

    await turn(3); await turn(2);
    await notes.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await notes.evaluate(async () => {
      let complete = false; CanvasNotes.changePage(3).then(() => { complete = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      return complete && CanvasNotes.getPage() === 3 && !document.querySelector('.notes-surface').inert;
    }), true, 'cached reduced-motion switch has no animation wait');
    await notes.emulateMedia({ reducedMotion: 'no-preference' });
    await notes.evaluate(() => { window.__reduceTurn = CanvasNotes.changePage(2); });
    await notes.waitForTimeout(35); await notes.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await notes.evaluate(() => __reduceTurn), true); await settled(2);
    checks.push('reduced motion skips waits, including an in-progress fade');

    // Introduce a high content page to overflow both stacks, then use actual list scrolling.
    await notes.evaluate(async () => {
      const response = await fetch('/api/notes-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        notePage: 99, notes: [{ id: 'p99', x: 0, y: 0, text: '最后一页', color: 'sage' }], edges: [], arrows: [],
      }) }); if (!response.ok) throw Error('Fixture save failed');
    });
    await notes.reload(); await notes.waitForFunction(() => window.CanvasNotes?.getPage() === 2 && CanvasNotes.count() === 1);
    await notes.waitForTimeout(850); await turn(99); await hoverRail(notes);
    const top = notes.locator('[data-role="notes-page-top"]'), bottom = notes.locator('[data-role="notes-page-bottom"]');
    await top.evaluate(el => { el.scrollTop = 0; });
    const bounds = await top.boundingBox(); await notes.mouse.move(bounds.x + bounds.width / 2, bounds.y + 70);
    await notes.mouse.wheel(0, 160); await notes.waitForTimeout(230);
    assert((await top.evaluate(el => el.scrollTop)) > 0);
    assert.equal(await active(notes), 99, 'scrolling an overflowing list does not turn pages');
    await bottom.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = await bottom.boundingBox(); await notes.mouse.move(last.x + last.width / 2, last.y + last.height - 20);
    await notes.mouse.wheel(0, 120); await notes.waitForTimeout(50); assert.equal(await active(notes), 99);
    await turn(1); await top.evaluate(el => { el.scrollTop = 0; });
    await notes.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30); await notes.mouse.wheel(0, -120);
    assert.equal(await active(notes), 1);
    checks.push('overflow uses native list scrolling; page 1/99 do not wrap');
    await notes.waitForTimeout(1100);
    assert.equal(await notes.evaluate(() => __wheelProbe.pending()), 0, 'Quick Notes has zero idle RAF');
    assert.deepEqual(errors, []);
    const report = { dataRoot, checks, comparison, errors };
    fs.writeFileSync(path.join(dataRoot, 'report.json'), JSON.stringify(report, null, 2));
    await notes.screenshot({ path: path.join(dataRoot, 'rail.png') });
    console.log(JSON.stringify(report));
  } catch (error) {
    if (notes) {
      console.error(await notes.evaluate(() => ({ inputs: __wheelProbe.inputs, fades: __wheelProbe.fades, mounts: __wheelProbe.mounts,
        page: window.CanvasNotes?.getPage(), active: document.querySelector('.notes-page-rail .is-active')?.dataset.notePage })).catch(() => null));
      await notes.screenshot({ path: path.join(dataRoot, 'failure.png') }).catch(() => {});
    }
    console.error('Disposable test data:', dataRoot, JSON.stringify({ checks })); throw error;
  } finally {
    if (browser) await browser.close();
    server.kill(); await new Promise(resolve => server.exitCode != null ? resolve() : server.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
