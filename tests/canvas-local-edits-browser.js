'use strict';

// Real editor, with disposable canvases and a source probe for deterministic work counts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { makePage, openCanvas } = require('./canvas-browser-performance.js');

const repo = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sampleCount = 25;

function instrument(source) {
  const counters = ['bindings', 'edges', 'groups', 'folds', 'minimap', 'dots'];
  for (const [name, key] of [
    ['rebuildTextBindingIndex()', 'bindings'],
    ['rebuildEdgeIndex()', 'edges'],
    ['refreshGroupContainers(groupedNodeIds)', 'groups'],
    ['refreshMindmapFolding()', 'folds'],
    ['redrawMinimap(changes, reuseBounds)', 'minimap'],
  ]) {
    const marker = '    function ' + name + ' {';
    assert(source.includes(marker), 'probe entry ' + name);
    source = source.replace(marker, marker + '\n      window.__localEditWork.' + key + '++;');
  }
  const dot = "        dot.style.left = (ox + (sz.x - minX) * s) + 'px';";
  const start = source.indexOf('    function redrawMinimap(');
  const offset = source.indexOf(dot, start);
  assert(offset > start && offset < source.indexOf('    function updateMinimapDraggedNodes(', start));
  source = source.slice(0, offset) + '        window.__localEditWork.dots++;\n' + source.slice(offset);
  const selection = '    function selectNodes(ids, additive) {';
  assert(source.includes(selection));
  source = source.replace(selection, '    window.__selectForLocalEdit = selectNodes;\n' + selection);
  return 'window.__localEditWork = ' + JSON.stringify(Object.fromEntries(counters.map((key) => [key, 0])))
    + ';\n' + source;
}

function makeFixture(root, count, label) {
  const name = 'local-edits-' + count + '-' + label;
  const file = path.join(root, 'canvases', name + '.canvas');
  const nodes = Array.from({ length: count - 2 }, (_, i) => ({
    id: 'node-' + i, kind: 'card', text: 'Node ' + i,
    x: (i % 30) * 200, y: 480 + Math.floor(i / 30) * 120,
  }));
  nodes.push({ id: 'code', kind: 'code', text: 'Seed', body: 'Seed', language: 'text', x: 235, y: 530 });
  nodes.push({ id: 'rich', kind: 'card', text: 'Rich', body: 'Before', x: 450, y: 560 });
  const edges = nodes.slice(1).map((node, i) => ({
    id: 'link-' + i, from: nodes[i].id, to: node.id, arrow: 'end',
  }));
  fs.writeFileSync(file, JSON.stringify({ version: 2, nodes, edges }));
  return { name, file };
}

async function selectNode(page, id) {
  await page.evaluate((id) => __selectForLocalEdit([id], false), id);
  await page.waitForFunction((id) => document.querySelector('.node.selected[data-id="' + id + '"]'), id);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measureInput(page, role, values, textInput = false) {
  return page.locator('[data-role="' + role + '"]').evaluate((input, { values, textInput }) => {
    if (textInput && input.getBoundingClientRect().width) input.focus();
    const before = { ...__localEditWork };
    const samples = values.map((value) => {
      input.value = value;
      const start = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - start;
    });
    const work = Object.fromEntries(Object.entries(__localEditWork).map(([key, value]) => [key, value - before[key]]));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    samples.sort((a, b) => a - b);
    return { ...work, p95: samples[Math.ceil(samples.length * .95) - 1] };
  }, { values, textInput });
}

async function checkRichBodyAndSave(page, file, codeBody) {
  await selectNode(page, 'rich');
  const toggle = page.locator('[data-role="pro-content-toggle"]');
  if (await page.locator('[data-role="pro-content-head"]').getAttribute('aria-expanded') !== 'true') {
    await toggle.click();
  }
  const input = page.locator('[data-role="pro-body-rich"]');
  await input.waitFor({ state: 'visible' });
  await input.evaluate((input) => {
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    RelatumRichText.renderEditable(input, '中文正文', [{ start: 0, end: 2, bold: true }]);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    input.blur();
  });
  const rich = () => page.evaluate(() => {
    const { body, bodyMarks } = CanvasModule.findNode('rich');
    return { body, bold: !!bodyMarks?.some((mark) => mark.start === 0 && mark.end === 2 && mark.bold) };
  });
  assert.deepEqual(await rich(), { body: '中文正文', bold: true });
  await page.keyboard.press('Control+z');
  assert.deepEqual(await rich(), { body: 'Before', bold: false });
  await page.keyboard.press('Control+y');
  assert.deepEqual(await rich(), { body: '中文正文', bold: true });
  assert(await page.evaluate(() => EditorShell.saveNow()), 'isolated canvas saves');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).nodes;
  assert.equal(saved.find((node) => node.id === 'code').body, codeBody);
  assert.equal(saved.find((node) => node.id === 'rich').body, '中文正文');
  assert.equal(saved.find((node) => node.id === 'rich').bodyMarks[0].bold, true);
}

async function run(browser, config, source, count, label) {
  const { name, file } = makeFixture(config.root, count, label);
  const page = await makePage(browser, { reduced: true });
  try {
    await page.route('**/canvas.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: source }));
    await openCanvas(page, config, name);
    await page.evaluate(() => EditorShell.setModeSubmode('full'));
    await selectNode(page, 'code');
    const body = () => page.evaluate(() => CanvasModule.findNode('code').body);
    const bodies = {};
    for (const [role, prefix] of [['en-body', 'Edit A '], ['pro-body', 'Edit B ']]) {
      if (role === 'pro-body') {
        await selectNode(page, 'rich');
        await selectNode(page, 'code');
      }
      const before = await body();
      const values = Array.from({ length: sampleCount }, (_, i) => prefix + String(i).padStart(2, '0'));
      bodies[role] = await measureInput(page, role, values, true);
      assert.equal(await body(), values.at(-1), role + ' applies body');
      await page.keyboard.press('Control+z');
      assert.equal(await body(), before, role + ' undo');
      await page.keyboard.press('Control+y');
      assert.equal(await body(), values.at(-1), role + ' redo');
    }
    await selectNode(page, 'rich');
    await selectNode(page, 'code');
    const visual = {};
    visual.opacity = await measureInput(page, 'en-opacity', Array.from({ length: 60 }, (_, i) => i + 20));
    visual.border = await measureInput(page, 'en-border', ['#465152']);
    visual.background = await measureInput(page, 'en-bg', ['#eedddd']);
    visual.scale = await measureInput(page, 'en-scale', [120, 130, 140]);
    assert.deepEqual(await page.evaluate(() => {
      const { opacity, borderColor, bgColor, scale } = CanvasModule.findNode('code');
      return { opacity, borderColor, bgColor, scale };
    }), { opacity: .79, borderColor: '#465152', bgColor: '#eedddd', scale: 1.4 });

    if (label === 'current') {
      for (const work of Object.values(bodies)) {
        for (const key of ['bindings', 'edges', 'groups', 'folds']) assert.equal(work[key], 0, key);
        assert.equal(work.minimap, sampleCount);
        assert.equal(work.dots, sampleCount, 'fixed geometry updates only the edited node');
      }
      for (const key of ['opacity', 'border', 'background']) {
        assert.equal(visual[key].minimap, 0, key);
        assert.equal(visual[key].dots, 0, key);
      }
      assert.equal(visual.scale.minimap, 3, 'one synchronous minimap refresh per scale input');
      if (count === 600) await checkRichBodyAndSave(page, file, await body());
    }
    assert.deepEqual(page.testErrors, []);
    return { count, label, bodies, visual };
  } finally {
    await page.context().close();
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-local-edits-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const current = instrument(fs.readFileSync(path.join(repo, 'assets/canvas.js'), 'utf8'));
  const baseline = process.argv.includes('--compare') ? instrument(execFileSync('git',
    ['show', (process.env.RELATUM_CANVAS_BASELINE_REF || 'HEAD') + ':assets/canvas.js'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) : null;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const stopped = new Promise((resolve) => server.once('close', resolve));
  let launchError;
  server.once('error', (error) => { launchError = error; });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      if (server.exitCode !== null) break;
      try { if ((await fetch(url + '/api/runtime')).ok) { ready = true; break; } } catch (_) {}
      await pause(100);
    }
    assert(ready, 'isolated editor server starts');
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    for (const count of [600, 3000]) {
      if (baseline) console.log(JSON.stringify(await run(browser, { url, root }, baseline, count, 'baseline')));
      console.log(JSON.stringify(await run(browser, { url, root }, current, count, 'current')));
    }
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await stopped;
    const target = fs.realpathSync(root);
    assert(path.dirname(target) === fs.realpathSync(os.tmpdir()) && path.basename(target).startsWith('relatum-canvas-local-edits-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
