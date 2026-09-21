'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const clone = (value) => JSON.parse(JSON.stringify(value));
const node = (id, type, x, y, config = {}) => ({
  id, type, label: id, x, y, width: 176, height: 80, config, statePolicy: 'reset',
});
const wire = (id, fromNodeId, fromPortId, toNodeId, toPortId) => ({
  id, kind: 'wire', from: { nodeId: fromNodeId, portId: fromPortId }, to: { nodeId: toNodeId, portId: toPortId },
});

function fixture() {
  const nodes = [];
  const edges = [];
  [0, 1].forEach((index) => {
    const suffix = String(index + 1); const y = 120 + index * 260;
    nodes.push(
      node('a' + suffix, 'constant', 80, y, { value: { type: 'number', value: 2 } }),
      node('b' + suffix, 'constant', 80, y + 110, { value: { type: 'number', value: 3 } }),
      node('op' + suffix, 'math', 380, y + 55, { operation: 'add' }),
      node('monitor' + suffix, 'monitor', 700, y + 55),
    );
    edges.push(
      wire('a-op-' + suffix, 'a' + suffix, 'out', 'op' + suffix, 'a'),
      wire('b-op-' + suffix, 'b' + suffix, 'out', 'op' + suffix, 'b'),
      wire('op-monitor-' + suffix, 'op' + suffix, 'out', 'monitor' + suffix, 'in'),
    );
  });
  return {
    researchVersion: 3, subcircuits: [],
    pages: [{ id: 'page', title: '', nodes, edges, view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 } }],
    activePageId: 'page',
  };
}

async function waitForSave(page, saves, count) {
  await page.waitForFunction((previous) => window.__subcircuitSaves > previous, count);
  return saves.at(-1);
}

async function run(playwright, url, options = {}) {
  const browser = await playwright.chromium.launch({ headless: true, executablePath: options.edgePath || undefined });
  const report = { browser: browser.version(), create: false, pin: false, upgrade: false, reuse: false, reload: false, errors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    let current = fixture(); let revision = 0; const saves = [];
    await page.exposeFunction('__savedCount', () => saves.length);
    await page.route('**/api/research/workspace', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: clone(current), revision: 'sub-' + revision }) });
        return;
      }
      const payload = request.postDataJSON(); current = clone(payload.document); saves.push(current); revision += 1;
      await page.evaluate((count) => { window.__subcircuitSaves = count; }, saves.length).catch(() => {});
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: current, revision: 'sub-' + revision }) });
    });
    await page.addInitScript(() => { window.__subcircuitSaves = 0; });
    await page.goto(url.replace(/\/$/, '') + '/research.html');
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-node-id="op1"]').waitFor({ state: 'visible' });

    await page.locator('[data-node-id="op1"]').click();
    await page.locator('[data-research-subcircuit-create]').click();
    await page.locator('[data-research-subcircuit-name]').fill('Reusable adder');
    assert.equal(await page.locator('[data-port-id]').count(), 3);
    const beforeCreate = saves.length;
    await page.locator('[data-research-subcircuit-confirm]').click();
    let saved = await waitForSave(page, saves, beforeCreate);
    assert.equal(saved.subcircuits.length, 1);
    const definitionId = saved.subcircuits[0].id;
    const first = saved.pages[0].nodes.find((item) => item.type === 'subcircuit' && item.config.revision === 1);
    assert(first && !saved.pages[0].nodes.some((item) => item.id === 'op1'));
    assert.deepEqual(saved.pages[0].edges.filter((edge) => edge.id.endsWith('-1')).map((edge) => edge.id).sort(),
      ['a-op-1', 'b-op-1', 'op-monitor-1']);
    report.create = true;

    await page.locator('[data-node-id="op2"]').click();
    await page.locator('[data-research-subcircuit-create]').click();
    await page.locator('[data-research-subcircuit-target]').selectOption(definitionId);
    const beforeRevision = saves.length;
    await page.locator('[data-research-subcircuit-confirm]').click();
    saved = await waitForSave(page, saves, beforeRevision);
    assert.equal(saved.subcircuits[0].latestRevision, 2);
    const instances = saved.pages[0].nodes.filter((item) => item.type === 'subcircuit');
    assert(instances.some((item) => item.config.revision === 1) && instances.some((item) => item.config.revision === 2));
    report.pin = true;

    await page.locator('[data-node-id="' + first.id + '"]').click();
    const upgrade = page.locator('[data-research-inspector-fields] button', { hasText: '升级到 r2' });
    await upgrade.waitFor({ state: 'visible' });
    const beforeUpgrade = saves.length; await upgrade.click();
    saved = await waitForSave(page, saves, beforeUpgrade);
    assert.equal(saved.pages[0].nodes.find((item) => item.id === first.id).config.revision, 2);
    report.upgrade = true;

    await page.locator('[data-research-add]').click();
    const reusable = page.locator('[data-research-subcircuit-id="' + definitionId + '"]');
    await reusable.waitFor({ state: 'visible' });
    const beforeReuse = saves.length; await reusable.click();
    saved = await waitForSave(page, saves, beforeReuse);
    assert.equal(saved.pages[0].nodes.filter((item) => item.type === 'subcircuit').length, 3);
    report.reuse = true;

    // Release the old runtime before navigation so its pagehide keepalive save
    // remains inside this fixture's intercepted persistence channel.
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await page.waitForTimeout(50);
    await page.reload();
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.waitForFunction(() => document.querySelectorAll('[data-node-type="subcircuit"]').length === 3);
    report.reload = true;
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await page.waitForTimeout(50);
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [url] = process.argv.slice(2);
  if (!url) { console.log('Optional browser test: node tests/research-subcircuits-browser.js <local URL>'); return; }
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const report = await run(playwright, url, { edgePath: process.env.RELATUM_EDGE_PATH });
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  console.log(JSON.stringify(report));
}

module.exports = { run };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
