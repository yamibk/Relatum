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

async function boxCenter(locator) {
  const box = await locator.boundingBox();
  assert(box, 'interactive Research element must have a browser box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function moveWirePointer(page, from, to) {
  const start = await boxCenter(from);
  const end = await boxCenter(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  return { start, end };
}

async function waitForSaveAfter(page, saves, previousCount) {
  for (let attempt = 0; attempt < 20 && saves.length <= previousCount; attempt += 1) {
    await page.waitForTimeout(50);
  }
  assert(saves.length > previousCount, 'the coalesced Research save must complete');
  return saves.at(-1);
}

async function runAcceptance(playwright, url, options = {}) {
  const browser = await playwright.chromium.launch({
    headless: options.headless !== false,
    executablePath: options.edgePath || undefined,
  });
  const report = { browser: browser.version(), circuits: {}, errors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
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

    const rail = page.locator('[data-research-page-rail]');
    await page.locator('[data-research-page-hotspot]').hover();
    await rail.waitFor({ state: 'visible' });
    await rail.dispatchEvent('wheel', { deltaX: 0, deltaY: 30 });
    assert.equal(await page.locator('[data-research-viewport]').evaluate((element) => element.classList.contains('is-page-switching')), true,
      'vertical wheel navigation must start the Research page transition');
    await page.waitForFunction(() => document.querySelector('[data-research-page-id].is-active')?.textContent.trim() === '2');
    await page.waitForFunction(() => !document.querySelector('[data-research-viewport]').classList.contains('is-page-switching'));
    await rail.dispatchEvent('wheel', { deltaX: 40, deltaY: 5 });
    await page.waitForTimeout(40);
    assert.equal((await page.locator('[data-research-page-id].is-active').textContent()).trim(), '2',
      'horizontal wheel gestures must not switch Research pages');
    await rail.dispatchEvent('wheel', { deltaX: 0, deltaY: -30 });
    await page.waitForFunction(() => document.querySelector('[data-research-page-id].is-active')?.textContent.trim() === '1');
    await page.waitForFunction(() => !document.querySelector('[data-research-viewport]').classList.contains('is-page-switching'));
    report.circuits.pageRail = { verticalWheel: true, horizontalIgnored: true, animated: true };

    await expectResult(page, 'fa-sum-monitor', EXPECTED.fullAdder.sum);
    await expectResult(page, 'fa-carry-monitor', EXPECTED.fullAdder.carry);

    // Both port directions may start a wire gesture. Rewiring from an occupied
    // value input must retain the existing edge identity and remain one undo step.
    await page.locator('[data-research-mode="wire"]').click();
    const xorInputA = page.locator('[data-node-id="fa-xor-1"] [data-research-port="a"]');
    const cinOutput = page.locator('[data-node-id="fa-cin"] [data-research-port="out"]');
    const savesBeforeReconnect = saves.length;
    await moveWirePointer(page, xorInputA, cinOutput);
    assert.equal(await page.locator('[data-research-active-edges] line.is-invalid').count(), 0,
      'a compatible reverse wire gesture must remain valid');
    await page.mouse.up();
    let savedDocument = await waitForSaveAfter(page, saves, savesBeforeReconnect);
    let savedWire = savedDocument.pages[0].edges.find((edge) => edge.id === 'fa-a-xor');
    assert.equal(savedWire.from.nodeId, 'fa-cin');
    assert.equal(savedWire.to.nodeId, 'fa-xor-1');
    const savesBeforeUndo = saves.length;
    await page.locator('[data-research-viewport]').press('Control+z');
    savedDocument = await waitForSaveAfter(page, saves, savesBeforeUndo);
    savedWire = savedDocument.pages[0].edges.find((edge) => edge.id === 'fa-a-xor');
    assert.equal(savedWire.from.nodeId, 'fa-a', 'one undo must restore the old source');

    // A wire preview starts at the rendered port center even when the node grew
    // to show a result. Invalid occupied targets remain hittable and turn red.
    const outputCenter = await boxCenter(page.locator('[data-node-id="fa-a"] [data-research-port="out"]'));
    await page.mouse.move(outputCenter.x, outputCenter.y);
    await page.mouse.down();
    await page.mouse.move(outputCenter.x + 40, outputCenter.y + 50, { steps: 4 });
    const activeWire = page.locator('[data-research-active-edges] line.is-data');
    assert(Math.abs(Number(await activeWire.getAttribute('x1')) - outputCenter.x) < 0.75);
    const activeWireY = Number(await activeWire.getAttribute('y1'));
    assert(Math.abs(activeWireY - outputCenter.y) < 0.75,
      `wire preview y1 ${activeWireY} must match rendered port center ${outputCenter.y}`);
    await page.mouse.up();
    const savesBeforeInvalid = saves.length;
    await moveWirePointer(page, page.locator('[data-node-id="fa-a"] [data-research-port="out"]'), xorInputA);
    assert.equal(await page.locator('[data-research-active-edges] line.is-invalid').count(), 1,
      'an occupied value input must show a red invalid preview');
    await page.mouse.up();
    await page.waitForTimeout(450);
    assert.equal(saves.length, savesBeforeInvalid, 'an invalid wire gesture must not schedule persistence');

    // Relation previews and committed relation geometry use the rendered node
    // borders rather than disappearing beneath each node center.
    await page.locator('[data-research-mode="relation"]').click();
    const relationFrom = await boxCenter(page.locator('[data-node-id="fa-a"]'));
    const relationTo = await boxCenter(page.locator('[data-node-id="fa-carry-monitor"]'));
    await page.mouse.move(relationFrom.x, relationFrom.y);
    await page.mouse.down();
    await page.mouse.move(relationTo.x, relationTo.y, { steps: 8 });
    const relationPreview = page.locator('[data-research-active-edges] line.is-preview');
    const relationX1 = Number(await relationPreview.getAttribute('x1'));
    const relationX2 = Number(await relationPreview.getAttribute('x2'));
    const relationFromRight = relationFrom.box.x + relationFrom.box.width;
    assert(relationX1 >= relationFromRight - 1 && relationX1 <= relationFromRight + 1,
      'relation source must stop at its right border');
    assert(relationX2 >= relationTo.box.x - 1 && relationX2 <= relationTo.box.x + 1,
      'relation target must stop at its left border');
    await page.mouse.up();
    report.circuits.wiring = { reverseStart: true, atomicReconnect: true, invalidPreview: true, borderGeometry: true };

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
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await page.waitForTimeout(50);
    report.savedSnapshots = saves.length;
    await context.close();

    const reducedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const reducedPage = await reducedContext.newPage();
    reducedPage.setDefaultTimeout(10000);
    reducedPage.on('pageerror', (error) => report.errors.push('reduced-motion: ' + error.message));
    await installFixtureRoute(reducedPage, fixture);
    await reducedPage.goto(url.replace(/\/$/, '') + '/research.html');
    await reducedPage.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await reducedPage.evaluate(() => RelatumResearchWorkspace.activate());
    await reducedPage.locator('[data-research-page-hotspot]').hover();
    await reducedPage.locator('[data-research-page-rail]').waitFor({ state: 'visible' });
    await reducedPage.locator('[data-research-page-id]').nth(1).click();
    assert.deepEqual(await reducedPage.locator('[data-research-viewport]').evaluate((element) => ({
      switching: element.classList.contains('is-page-switching'),
      opacity: element.style.opacity,
      transform: element.style.transform,
    })), { switching: false, opacity: '', transform: '' },
    'reduced motion must switch Research pages without transient viewport animation');
    await reducedPage.evaluate(() => RelatumResearchWorkspace.dispose());
    await reducedContext.close();
    report.circuits.pageRail.reducedMotion = true;
    assert.deepEqual(report.errors, []);
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
