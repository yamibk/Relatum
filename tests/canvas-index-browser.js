'use strict';

// Exercise the actual editor and persistence endpoint with a disposable canvas root.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { edgePoint, installProbe, openCanvas } = require('./canvas-browser-performance.js');

const repo = path.resolve(__dirname, '..');
const reader = '[data-role="text-reader"]';
const item = '[data-role="index-reader-nav"] [data-index-node-id]';
const accent = '#e41383';
const primaryOrder = ['incoming', 'legacy', 'reverse', 'four', 'outgoing', 'both'];

function card(id, x, y) {
  return { id, kind: 'card', text: id, x, y };
}

function edge(id, from, to, arrow) {
  return { id, from, to, arrow, curve: 'straight', color: '#315786' };
}

function writeFixtures(root) {
  const nodes = [
    { id: 'index', kind: 'index', text: '目录测试', x: 5, y: 140 },
    card('incoming', 260, 0), card('legacy', 500, 0), card('blocked', 5, 0),
    card('outgoing', 300, 150), card('both', 300, 325),
    card('reverse', 510, 170), card('four', 500, 260), card('five', 500, 360),
    { id: 'shape', kind: 'shape', shapeType: 'diamond', x: 30, y: 330, width: 48, height: 48 },
    { id: 'empty', kind: 'index', text: '独立索引', x: 0, y: 440 },
  ];
  const edges = [
    edge('root-in', 'incoming', 'index', 'end'),
    edge('root-in-parallel', 'index', 'incoming', 'start'),
    edge('root-out', 'index', 'outgoing', 'one'),
    edge('root-both', 'index', 'both', 'both'),
    edge('root-shape', 'index', 'shape', 'none'),
    edge('legacy-link', 'incoming', 'legacy', 'one'),
    edge('reverse-link', 'reverse', 'legacy', 'start'),
    edge('four-link', 'reverse', 'four', 'none'),
    edge('five-link', 'four', 'five', 'both'),
    edge('blocked-link', 'blocked', 'incoming', 'end'),
    edge('cycle', 'outgoing', 'incoming', 'end'),
    edge('entry-cross-link', 'incoming', 'outgoing', 'end'),
  ];
  const write = (name, nodes, edges) => fs.writeFileSync(path.join(root, 'canvases', name + '.canvas'),
    JSON.stringify({ version: 2, nodes, edges }));
  write('index-tree', nodes, edges);
  write('index-svg', nodes, edges);
  write('index-selection', [card('left', 200, 160), card('right', 400, 160)],
    [edge('existing', 'left', 'right', 'end')]);
}

function installIndexProbe(svgOnly, color) {
  localStorage.setItem('canvas:normalSubmode', svgOnly ? 'clean' : 'full');
  localStorage.setItem('canvas:indexHoverEnabled', '1');
  localStorage.setItem('canvas:indexHoverDelay', '0');
  localStorage.setItem('canvas:genIndexEnabled', '1');
  localStorage.setItem('canvas:proEdgeDefaults', JSON.stringify({ arrow: 'one' }));
  localStorage.setItem('canvas:cleanEdgeDefaults', JSON.stringify({ arrow: 'one' }));
  document.addEventListener('DOMContentLoaded', () => {
    document.body.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent', color);
  });
  if (svgOnly) window.Path2D = undefined;
  const proto = CanvasRenderingContext2D.prototype;
  const { clearRect, stroke } = proto;
  window.__indexEdgePaint = { draws: 0, accentStrokes: 0 };
  proto.clearRect = function (...args) {
    if (this.canvas.dataset.role === 'canvas-edges-canvas') {
      __indexEdgePaint.draws++;
      __indexEdgePaint.accentStrokes = 0;
    }
    return clearRect.apply(this, args);
  };
  proto.stroke = function (...args) {
    if (this.canvas.dataset.role === 'canvas-edges-canvas' && this.strokeStyle === color) {
      __indexEdgePaint.accentStrokes++;
    }
    return stroke.apply(this, args);
  };
}

function node(page, id) {
  return page.locator('.node[data-id="' + id + '"]');
}

function badge(page, id) {
  return node(page, id).locator('.text-node-meta');
}

async function until(check, message, child) {
  for (let i = 0; i < 150; i++) {
    if (child && child.exitCode !== null) break;
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function setupPage(page, svgOnly) {
  page.setDefaultTimeout(12000);
  page.testErrors = [];
  page.on('pageerror', error => page.testErrors.push(error.message));
  await page.addInitScript(`(${installProbe.toString()})({});
    (${installIndexProbe.toString()})(${svgOnly}, ${JSON.stringify(accent)});`);
}

async function openReader(page, id) {
  await node(page, id).locator('.node-text').click();
  await page.keyboard.press('f');
  await page.locator(reader).waitFor({ state: 'visible' });
}

async function closeReader(page) {
  await page.keyboard.press('Escape');
  await page.locator(reader).waitFor({ state: 'hidden' });
}

async function directory(page) {
  return page.locator(item).evaluateAll(items => items.map(button => [
    button.dataset.indexNodeId, button.dataset.indexPath,
  ]));
}

async function assertDirectory(page, expected) {
  const entries = await directory(page);
  assert.deepEqual(entries.map(entry => entry[0]), expected);
  for (const id of ['incoming', 'outgoing', 'both']) {
    assert.equal(entries.find(entry => entry[0] === id)?.[1], 'index,' + id,
      'a direct connection belongs at the top level');
  }
}

async function verifyHighlight(page, svgOnly) {
  const target = page.locator(item + '[data-index-node-id="reverse"]');
  const highlightedNodes = page.locator('.node.index-reader-target');
  const litEdges = page.locator('.canvas-edge.edge-path-lit');
  const expectedNodes = ['incoming', 'index', 'legacy', 'reverse'];
  await target.hover();
  assert.deepEqual(await highlightedNodes.evaluateAll(nodes => nodes.map(node => node.dataset.id).sort()), expectedNodes);
  if (svgOnly) {
    assert.deepEqual(await litEdges.evaluateAll(edges => edges.map(edge => edge.dataset.id).sort()),
      ['legacy-link', 'reverse-link', 'root-in', 'root-in-parallel']);
  } else {
    await page.waitForFunction(() => __indexEdgePaint.accentStrokes >= 3);
    assert.equal(await page.locator('.canvas-edge').count(), 0,
      'highlighting must not mount static SVG paths in Canvas mode');
  }
  assert(await target.evaluate(row => {
    CanvasModule.notify();
    return row === document.querySelector('.index-reader-nav-item[data-index-node-id="reverse"]');
  }), 'an unchanged directory keeps its active row mounted');
  assert.equal(await highlightedNodes.count(), expectedNodes.length,
    'an unrelated refresh preserves the active path');

  await page.locator('.index-reader-nav-label').hover();
  assert.equal(await highlightedNodes.count(), 0);
  if (svgOnly) assert.equal(await litEdges.count(), 0);
  else await page.waitForFunction(() => __indexEdgePaint.accentStrokes === 0);

  await target.hover();
  if (!svgOnly) await page.waitForFunction(() => __indexEdgePaint.accentStrokes >= 3);
  await closeReader(page);
  assert.equal(await highlightedNodes.count(), 0);
  if (svgOnly) assert.equal(await litEdges.count(), 0);
  else await page.waitForFunction(() => __indexEdgePaint.accentStrokes === 0);
}

async function verifyDirectory(page, svgOnly, checkDepth) {
  assert.equal(await badge(page, 'index').textContent(), '6 项 · 4 层');
  assert.equal(await badge(page, 'empty').textContent(), '尚未连接');
  await node(page, 'index').locator('.node-text').hover();
  const preview = page.locator('.index-hover-preview.show .index-hover-title');
  await preview.first().waitFor();
  assert.deepEqual(await preview.allTextContents(), primaryOrder,
    'hover preview uses the default reader depth and ordering');
  await openReader(page, 'index');
  await assertDirectory(page, primaryOrder);
  assert.equal((await directory(page)).find(entry => entry[0] === 'four')[1],
    'index,incoming,legacy,reverse,four');
  await verifyHighlight(page, svgOnly);
  if (checkDepth) {
    await openReader(page, 'index');
    const depthOption = depth => page.locator('[data-role="index-depth-switch"] [data-depth="' + depth + '"]');
    await page.locator(item + '[data-index-node-id="four"]').click();
    assert.equal(await page.locator('[data-role="index-pane-title"]').textContent(), 'four');
    await depthOption('2').click();
    await assertDirectory(page, ['incoming', 'legacy', 'outgoing', 'both']);
    assert.equal(await badge(page, 'index').textContent(), '4 项 · 2 层');
    assert.equal(await page.locator(item + '.active').count(), 0);
    assert(await page.locator('[data-role="index-pane-head"]').isHidden(),
      'a selected item removed by the depth control returns the pane to the overview');
    await depthOption('6').click();
    await assertDirectory(page, ['incoming', 'legacy', 'reverse', 'four', 'five', 'outgoing', 'both']);
    await depthOption('4').click();
    await closeReader(page);
  }
}

async function verifyDefaultArrows(page, clean) {
  const style = clean ? 'clean' : 'pro';
  const button = arrow => page.locator('[data-role="' + style + '-arrow"] [data-arrow="' + arrow + '"]');
  const key = 'canvas:' + style + 'EdgeDefaults';
  const readPref = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).arrow, key);
  if (clean) await page.locator('[data-action="open-clean-style"]').click();
  assert.equal(await readPref(), 'one', 'displaying an old preference does not rewrite it');
  assert.match(await button('end').getAttribute('class'), /\bactive\b/);
  await button('both').click();
  await button('end').click();
  assert.equal(await readPref(), 'end');
  if (clean) await page.locator('[data-action="close-clean-style"]').click();
}

async function verifyInspector(page, config) {
  const readArrow = id => page.evaluate(id => __testData.edges.find(edge => edge.id === id)?.arrow, id);
  const arrow = name => page.locator('[data-role="ee-arrow"] [data-arrow="' + name + '"]');
  const badgeText = () => badge(page, 'index').textContent();
  const selectPair = async (from, to) => {
    const { x, y } = await edgePoint(page, from, to);
    await page.mouse.click(x, y);
    await page.waitForFunction(() => __testSelection?.edges === 1);
  };
  assert.equal(await readArrow('legacy-link'), 'one', 'opening must preserve legacy canvas data');
  await selectPair('incoming', 'legacy');
  assert.match(await arrow('end').getAttribute('class'), /\bactive\b/,
    'legacy one is displayed as the single-arrow setting');

  await selectPair('blocked', 'incoming');
  await arrow('both').click();
  assert.equal(await readArrow('blocked-link'), 'both');
  assert.equal(await badgeText(), '7 项 · 4 层');
  await arrow('end').click();
  assert.equal(await readArrow('blocked-link'), 'end');
  assert.equal(await badgeText(), '6 项 · 4 层');
  await page.locator('[data-role="ee-reset-appearance"]').click();
  assert.equal(await readArrow('blocked-link'), undefined);
  assert.equal(await badgeText(), '7 项 · 4 层');
  await page.keyboard.press('Control+z');
  assert.equal(await readArrow('blocked-link'), 'end');
  assert.equal(await badgeText(), '6 项 · 4 层');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await readArrow('blocked-link'), undefined);
  assert.equal(await badgeText(), '7 项 · 4 层');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  const filename = path.join(config.root, 'canvases', 'index-tree.canvas');
  await until(() => {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return saved.nodes.find(node => node.id === 'index').indexDepth === 4
      && saved.edges.find(edge => edge.id === 'blocked-link').arrow === 'end';
  }, 'the edited canvas is saved');
  await openCanvas(page, config, 'index-tree');
  assert.equal(await readArrow('legacy-link'), 'one');
  assert.equal(await readArrow('blocked-link'), 'end');
  assert.equal(await badgeText(), '6 项 · 4 层');
}

async function verifyManualConnection(page) {
  const from = await node(page, 'outgoing').locator('.node-text').boundingBox();
  const to = await node(page, 'empty').locator('.node-text').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const newArrow = await page.evaluate(() => __testData.edges.find(edge =>
    edge.from === 'outgoing' && edge.to === 'empty')?.arrow);
  assert.equal(newArrow, 'end', 'a new edge uses the canonical default even when the old preference is stored');
  assert.match(await badge(page, 'empty').textContent(), /^\d+ 项/);
  await openReader(page, 'empty');
  assert.deepEqual((await directory(page))[0], ['outgoing', 'empty,outgoing']);
  await closeReader(page);
  await page.keyboard.press('Control+z');
  assert.equal(await badge(page, 'empty').textContent(), '尚未连接');
}

async function verifyGenerated(page, config) {
  await openCanvas(page, config, 'index-selection');
  const left = await node(page, 'left').boundingBox();
  const right = await node(page, 'right').boundingBox();
  await page.mouse.move(left.x - 20, left.y - 20);
  await page.mouse.down();
  await page.mouse.move(right.x + right.width + 20, right.y + right.height + 20, { steps: 10 });
  await page.mouse.up();
  await page.locator('.frame-index-btn.visible').click();
  const generated = await page.evaluate(() => {
    const root = __testData.nodes.find(node => node.kind === 'index');
    return { id: root.id, children: __testData.edges.filter(edge => edge.from === root.id)
      .map(edge => [edge.to, edge.arrow]).sort() };
  });
  assert.deepEqual(generated.children, [['left', 'end'], ['right', 'end']]);
  assert.equal(await badge(page, generated.id).textContent(), '2 项 · 1 层');
  await page.keyboard.press('f');
  await page.locator(reader).waitFor({ state: 'visible' });
  assert.deepEqual(await directory(page), [['left', generated.id + ',left'], ['right', generated.id + ',right']]);
  await page.locator(item + '[data-index-node-id="left"]').dblclick();
  await page.locator(reader).waitFor({ state: 'hidden' });
  assert.match(await node(page, 'left').getAttribute('class'), /\bselected\b/);
  await page.keyboard.press('Control+z');
  assert.equal(await node(page, generated.id).count(), 0);
}

async function main() {
  const native = process.argv.includes('--webview2');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-index-'));
  // Keep the native browser profile separate so its shutdown does not lock fixtures.
  const profile = native && fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-index-profile-'));
  fs.mkdirSync(path.join(root, 'canvases'));
  writeFixtures(root);
  const port = await freePort();
  const host = 'http://127.0.0.1:' + port;
  const args = native ? ['-B', 'desktop.py', path.join(root, 'canvases', 'index-tree.canvas')]
    : ['-B', 'app.py', '--no-browser', '--port', String(port)];
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const child = spawn(python, args, { cwd: repo, windowsHide: true,
    env: { ...process.env, RELATUM_DATA_ROOT: root, ...(native && {
      LOCALAPPDATA: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    }) } });
  let logs = '', browser, nativePage;
  child.stdout.on('data', data => { logs = (logs + data).slice(-5000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-5000); });
  try {
    await until(async () => {
      try { return (await fetch(host + (native ? '/json/version' : '/api/runtime'))).ok; }
      catch (_) { return false; }
    }, 'isolated canvas test server starts', child);
    if (native) {
      browser = await chromium.connectOverCDP(host);
      nativePage = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/editor.html')),
        'WebView2 opened the isolated canvas', child);
      const config = { root, url: new URL(nativePage.url()).origin };
      await setupPage(nativePage, false);
      await openCanvas(nativePage, config, 'index-tree');
      await verifyDirectory(nativePage, false, false);
      assert.deepEqual(nativePage.testErrors, []);
    } else {
      browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
      const config = { root, url: host };
      for (const svgOnly of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
        try {
          await setupPage(page, svgOnly);
          await openCanvas(page, config, svgOnly ? 'index-svg' : 'index-tree');
          await verifyDefaultArrows(page, svgOnly);
          await verifyDirectory(page, svgOnly, !svgOnly);
          if (!svgOnly) {
            await verifyInspector(page, config);
            await verifyManualConnection(page);
            await verifyGenerated(page, config);
          }
          assert.deepEqual(page.testErrors, []);
        } finally { await page.context().close(); }
      }
    }
  } catch (error) {
    if (child.exitCode !== null) console.error(logs);
    throw error;
  } finally {
    if (nativePage) {
      await nativePage.evaluate(() => {
        setTimeout(() => window.pywebview?.api?.close_window(), 100);
      }).catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(4000, undefined, { ref: false })]);
      }
    }
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await stopped;
    }
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert(path.basename(target).startsWith('relatum-canvas-index-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
  console.log('Canvas index browser regression passed in ' + (native ? 'WebView2' : 'Edge with Canvas and SVG') + '.');
  if (profile) console.log('Disposable WebView2 profile: ' + profile);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
