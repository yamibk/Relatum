'use strict';

// Optional real-browser acceptance harness. Playwright is supplied by the test
// host and remains outside the application's dependency/runtime chain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EXPECTED, buildResearchCircuitFixture } = require('./research-circuit-fixtures.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function installFixtureRoute(page, document) {
  let revision = 0;
  const saves = [];
  await page.route('**/api/research/workspace', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ document: clone(document), revision: 'browser-fixture-0' }),
      });
      return;
    }
    const payload = request.postDataJSON();
    saves.push(payload.document);
    revision += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ document: payload.document, revision: 'browser-fixture-' + revision }),
    });
  });
  return saves;
}

function resultLocator(page, nodeId) {
  return page.locator('[data-node-id="' + nodeId + '"] [data-compute-result]');
}

async function expectResult(page, nodeId, expected) {
  const locator = resultLocator(page, nodeId);
  await locator.waitFor({ state: 'visible' });
  await assert.doesNotReject(() => locator.waitFor({ state: 'visible' }));
  await page.waitForFunction(({ nodeId, expected }) => {
    const element = document.querySelector('[data-node-id="' + nodeId + '"] [data-compute-result]');
    return element && element.textContent.trim() === expected;
  }, { nodeId, expected });
  assert.equal((await locator.textContent()).trim(), expected);
}

async function selectPage(page, index) {
  await page.locator('[data-research-page-hotspot]').hover();
  await page.locator('[data-research-page-rail]').waitFor({ state: 'visible' });
  await page.locator('[data-research-page-id]').nth(index).click();
  await page.waitForFunction((number) => {
    const active = document.querySelector('[data-research-page-id].is-active');
    return active && active.textContent.trim() === String(number);
  }, index + 1);
}

async function runAcceptance(playwright, url, options = {}) {
  const browser = await playwright.chromium.launch({
    headless: options.headless !== false,
    executablePath: options.edgePath || undefined,
  });
  const report = { browser: browser.version(), circuits: {}, errors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.errors.push('console: ' + message.text());
    });
    const fixture = buildResearchCircuitFixture();
    const saves = await installFixtureRoute(page, fixture);

    await page.goto(url.replace(/\/$/, '') + '/research.html');
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-node-id="fa-a"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-research-page-id]').count(), 4);

    await expectResult(page, 'fa-sum-monitor', EXPECTED.fullAdder.sum);
    await expectResult(page, 'fa-carry-monitor', EXPECTED.fullAdder.carry);

    // Configuration uses the same visible inspector a person uses. Changing Cin
    // must immediately propagate through both downstream logic branches.
    await page.locator('[data-node-id="fa-cin"]').click();
    const cin = page.locator('[data-research-inspector-fields] input[type="checkbox"]');
    await cin.uncheck();
    await expectResult(page, 'fa-sum-monitor', '= false');
    await expectResult(page, 'fa-carry-monitor', '= true');
    await cin.check();
    await expectResult(page, 'fa-sum-monitor', EXPECTED.fullAdder.sum);
    report.circuits.fullAdder = { sum: true, carry: true, inspectorPropagation: true };

    await selectPage(page, 1);
    await expectResult(page, 'alu-monitor', EXPECTED.alu);
    report.circuits.alu8 = { output: '0x10', publicFamilies: ['Bits', 'Math', 'Logic', 'Compare', 'Select'] };

    await selectPage(page, 2);
    await expectResult(page, 'pc-register-monitor', '= 0 · 4b');
    await expectResult(page, 'pc-counter-monitor', '= 0 · 4b');
    await page.locator('[data-research-step]').click();
    await expectResult(page, 'pc-register-monitor', EXPECTED.firstStep);
    await expectResult(page, 'pc-counter-monitor', EXPECTED.firstStep);
    await page.locator('[data-node-id="pc-probe"]').click();
    await page.locator('[data-research-trace]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-research-trace-list] li').count(), 3,
      'one clock step should expose the initial value, Pulse, and resulting value');
    assert.equal(await page.locator('[data-research-trace-list] li[data-trace-kind="event"]').count(), 1);
    assert((await page.locator('[data-research-trace-list]').textContent()).includes('t=40 ms'));
    await page.locator('[data-research-trace-clear]').click();
    assert.equal(await page.locator('[data-research-trace-list] li').count(), 0);
    await page.locator('[data-research-reset]').click();
    await expectResult(page, 'pc-register-monitor', '= 0 · 4b');
    assert.equal(await page.locator('[data-research-trace-list] li').count(), 1,
      'reset should clear trace history and create a new t=0 value baseline');
    await page.locator('[data-research-run]').click();
    await page.waitForFunction(() => {
      const output = document.querySelector('[data-node-id="pc-counter-monitor"] [data-compute-result]');
      return output && output.textContent.trim() !== '= 0 · 4b';
    });
    await page.locator('[data-research-pause]').click();
    const pausedPc = (await resultLocator(page, 'pc-counter-monitor').textContent()).trim();
    await page.waitForTimeout(120);
    assert.equal((await resultLocator(page, 'pc-counter-monitor').textContent()).trim(), pausedPc,
      'paused simulation must freeze the 4-bit datapath');
    report.circuits.programCounter4 = { step: true, reset: true, runPause: true, probeTrace: true, pausedAt: pausedPc };

    await selectPage(page, 3);
    await expectResult(page, 'timer-counter-monitor', '= 0');
    await page.locator('[data-node-id="timer-start"] [data-node-action]').click();
    await page.locator('[data-research-run]').click();
    await page.waitForFunction(() => {
      const output = document.querySelector('[data-node-id="timer"] [data-compute-result]');
      return output && output.textContent.includes('运行中');
    });
    await page.waitForTimeout(70);
    await page.locator('[data-node-id="timer-pause"] [data-node-action]').click();
    await page.waitForFunction(() => {
      const output = document.querySelector('[data-node-id="timer"] [data-compute-result]');
      return output && output.textContent.includes('已暂停');
    });
    await page.waitForTimeout(120);
    await expectResult(page, 'timer-counter-monitor', '= 0');
    await page.locator('[data-node-id="timer-start"] [data-node-action]').click();
    await expectResult(page, 'timer-counter-monitor', EXPECTED.timerDone);
    await page.locator('[data-research-pause]').click();
    await page.locator('[data-node-id="timer-reset"] [data-node-action]').click();
    await page.waitForFunction(() => {
      const output = document.querySelector('[data-node-id="timer"] [data-compute-result]');
      return output && output.textContent.includes('已暂停');
    });
    report.circuits.timerCounter = { start: true, pause: true, reset: true, donePulse: true };

    await page.waitForTimeout(450);
    assert(saves.length > 0, 'public interactions should still use the normal coalesced persistence path');
    assert(!saves.some((snapshot) => JSON.stringify(snapshot).includes('traceByNodeId')
      || JSON.stringify(snapshot).includes('"trace"')), 'runtime probe history must never enter saved documents');
    assert.deepEqual(report.errors, []);
    report.savedSnapshots = saves.length;
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [url, outputPath] = process.argv.slice(2);
  if (!url) {
    console.log('Optional browser test: node tests/research-circuit-browser.js <local URL> [report.json]');
    return;
  }
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'browser fixture only accepts a local server');
  const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const report = await runAcceptance(playwright, url, { edgePath: process.env.RELATUM_EDGE_PATH });
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

module.exports = { installFixtureRoute, runAcceptance };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
