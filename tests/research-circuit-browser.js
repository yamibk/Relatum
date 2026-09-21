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
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  return { start, end };
}

async function finishConnectionPointer(page) {
  await page.mouse.up();
  await page.keyboard.up('Alt');
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

    const sidePanel = page.locator('[data-research-side-panel]');
    const computeDock = page.locator('[data-research-compute-dock]');
    const libraryPanelBox = await sidePanel.boundingBox();
    assert(libraryPanelBox, 'the unified side panel must be visible by default');
    await page.locator('[data-node-id="fa-sum"]').click();
    await page.locator('[data-research-inspector]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.research-side-panel-content-ghost').count(), 1,
      'switching from the node library to properties must retain an outgoing content layer');
    const propertyPanelBox = await sidePanel.boundingBox();
    assert(propertyPanelBox
      && Math.round(propertyPanelBox.width) === Math.round(libraryPanelBox.width)
      && Math.round(propertyPanelBox.height) === Math.round(libraryPanelBox.height),
    'the node library and property inspector must use the same outer frame');
    await page.waitForTimeout(240);
    assert.equal(await page.locator('.research-side-panel-content-ghost').count(), 0,
      'the outgoing panel content layer must be removed after its finite transition');
    await page.locator('[data-research-viewport]').press('Escape');
    await page.locator('[data-research-node-library]').waitFor({ state: 'visible' });
    await page.locator('[data-research-help-open]').click();
    await page.locator('[data-research-help-close]').click();
    assert.equal(await page.locator('[data-research-help-overlay]').evaluate((element) => (
      !element.hidden && element.classList.contains('is-closing')
    )), true, 'the help overlay must retain its visible closing frame');
    await page.waitForFunction(() => document.querySelector('[data-research-help-overlay]').hidden);
    const initialDockBox = await computeDock.boundingBox();
    assert(initialDockBox && Math.round(initialDockBox.width) === 520 && Math.round(initialDockBox.height) === 44,
      'the expanded compute dock must retain its fixed 520 × 44 frame');
    await page.locator('[data-research-viewport]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains('is-collapsed')), true,
      'bare Tab must collapse the unified side panel');
    assert.equal(await page.evaluate(() => localStorage.getItem('research:sidePanelCollapsed:v1')), '1');
    await page.evaluate(() => RelatumResearchWorkspace.suspend());
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains('is-collapsed')), true,
      'suspend/activate must retain the side-panel choice');
    await page.locator('[data-research-dock-collapse]').click();
    assert.equal(await computeDock.evaluate((element) => element.classList.contains('is-collapsed')), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('research:computeDockCollapsed:v1')), '1');
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await page.reload();
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-node-id="fa-a"]').waitFor({ state: 'visible' });
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains('is-collapsed')), true,
      'a refresh must restore the collapsed side panel');
    assert.equal(await computeDock.evaluate((element) => element.classList.contains('is-collapsed')), true,
      'a refresh must restore the collapsed compute dock');

    // Research view preferences are local-only and independent from the main canvas.
    await page.locator('[data-research-settings-open]').click();
    await page.locator('[data-research-settings-panel]').waitFor({ state: 'visible' });
    await page.locator('[data-research-help-open]').click();
    assert.equal(await page.locator('[data-research-settings-panel]').evaluate((element) => element.hidden), true,
      'opening Research help must immediately close the settings surface');
    await page.locator('[data-research-settings-open]').evaluate((element) => element.click());
    assert.equal(await page.locator('[data-research-help-overlay]').evaluate((element) => element.hidden), true,
      'opening Research settings must immediately close the help overlay');
    const setRange = async (selector, value) => page.locator(selector).evaluate((element, nextValue) => {
      element.value = String(nextValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await setRange('[data-research-pan-speed]', 12);
    await setRange('[data-research-pan-inertia]', 0.6);
    await setRange('[data-research-zoom-speed]', 2.2);
    assert.deepEqual(await page.evaluate(() => ({
      panSpeed: localStorage.getItem('research:panSpeed:v1'),
      panInertia: localStorage.getItem('research:panInertia:v1'),
      zoomSpeed: localStorage.getItem('research:zoomSpeed:v1'),
      canvasPanSpeed: localStorage.getItem('canvas:panSpeed'),
    })), { panSpeed: '12', panInertia: '0.6', zoomSpeed: '2.2', canvasPanSpeed: null },
    'Research view preferences must use their own localStorage namespace');
    await page.locator('[data-research-settings-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-research-settings-panel]').hidden);
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await page.reload();
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-node-id="fa-a"]').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => ({
      panSpeed: document.querySelector('[data-research-pan-speed]').value,
      panInertia: document.querySelector('[data-research-pan-inertia]').value,
      zoomSpeed: document.querySelector('[data-research-zoom-speed]').value,
    })), { panSpeed: '12', panInertia: '0.6', zoomSpeed: '2.2' },
    'a refresh must restore all Research view preferences');

    const researchViewport = page.locator('[data-research-viewport]');
    const viewBox = await researchViewport.boundingBox();
    assert(viewBox, 'Research viewport must remain visible for view interaction checks');
    const anchor = { x: viewBox.x + viewBox.width * .72, y: viewBox.y + viewBox.height * .38 };
    const beforeWheel = await page.evaluate(({ x, y }) => {
      const surface = document.querySelector('[data-research-surface]');
      const matrix = new DOMMatrix(getComputedStyle(surface).transform);
      window.__researchMinimapNodeIdentity = document.querySelector('[data-research-minimap-node-id]')
        || document.querySelector('[data-minimap-node-id]')
        || document.querySelector('.research-minimap-node');
      return {
        transform: surface.style.transform,
        worldX: (x - matrix.e) / matrix.a,
        worldY: (y - matrix.f) / matrix.d,
      };
    }, anchor);
    const immediateWheelTransform = await page.evaluate(({ x, y }) => {
      const viewport = document.querySelector('[data-research-viewport]');
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -100, clientX: x, clientY: y,
      }));
      return document.querySelector('[data-research-surface]').style.transform;
    }, anchor);
    assert.equal(immediateWheelTransform, beforeWheel.transform,
      'normal-motion wheel zoom must begin through the camera RAF instead of jumping immediately');
    await page.waitForTimeout(300);
    const afterWheel = await page.evaluate(({ x, y }) => {
      const surface = document.querySelector('[data-research-surface]');
      const matrix = new DOMMatrix(getComputedStyle(surface).transform);
      return {
        transform: surface.style.transform,
        worldX: (x - matrix.e) / matrix.a,
        worldY: (y - matrix.f) / matrix.d,
        sameMinimapNode: window.__researchMinimapNodeIdentity === document.querySelector('.research-minimap-node'),
      };
    }, anchor);
    assert.notEqual(afterWheel.transform, beforeWheel.transform, 'wheel zoom must visibly advance across animation frames');
    assert(Math.abs(afterWheel.worldX - beforeWheel.worldX) < .15
      && Math.abs(afterWheel.worldY - beforeWheel.worldY) < .15,
    'continuous wheel zoom must preserve the pointer anchor');
    assert.equal(afterWheel.sameMinimapNode, true,
      'camera animation must retain minimap node DOM instead of rebuilding it per frame');

    const panStart = { x: viewBox.x + viewBox.width * .62, y: viewBox.y + viewBox.height * .56 };
    await page.keyboard.down('Space');
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down();
    await page.mouse.move(panStart.x + 110, panStart.y + 24);
    await page.mouse.up();
    await page.keyboard.up('Space');
    const releasedTransform = await page.locator('[data-research-surface]').evaluate((element) => element.style.transform);
    await page.waitForTimeout(120);
    const inertialTransform = await page.locator('[data-research-surface]').evaluate((element) => element.style.transform);
    assert.notEqual(inertialTransform, releasedTransform, 'a quick canvas drag must continue with configured inertia');

    await setRange('[data-research-pan-inertia]', 0);
    await page.keyboard.down('Space');
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down();
    await page.mouse.move(panStart.x - 70, panStart.y - 18);
    await page.mouse.up();
    await page.keyboard.up('Space');
    const zeroInertiaRelease = await page.locator('[data-research-surface]').evaluate((element) => element.style.transform);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-research-surface]').evaluate((element) => element.style.transform), zeroInertiaRelease,
      'setting drag inertia to zero must stop exactly at pointer release');

    const translationX = async () => page.locator('[data-research-surface]').evaluate((element) => (
      new DOMMatrix(getComputedStyle(element).transform).e
    ));
    await researchViewport.focus();
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(300);
    await setRange('[data-research-pan-speed]', 1);
    const slowPanStart = await translationX();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(120);
    await page.keyboard.up('ArrowRight');
    const slowPanDistance = Math.abs((await translationX()) - slowPanStart);
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(300);
    await setRange('[data-research-pan-speed]', 20);
    const fastPanStart = await translationX();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(120);
    await page.keyboard.up('ArrowRight');
    const fastPanDistance = Math.abs((await translationX()) - fastPanStart);
    assert(fastPanDistance > slowPanDistance * 4,
      'the keyboard pan-speed preference must materially change frame-normalized movement');

    const minimap = page.locator('[data-research-minimap]');
    const minimapBox = await minimap.boundingBox();
    const minimapViewboxBox = await page.locator('[data-research-minimap-viewbox]').boundingBox();
    assert(minimapBox && minimapViewboxBox, 'the upgraded minimap and its viewport frame must remain visible');
    const minimapTarget = minimapViewboxBox.x - minimapBox.x > minimapBox.width / 2
      ? { x: minimapBox.x + 8, y: minimapBox.y + 8 }
      : { x: minimapBox.x + minimapBox.width - 8, y: minimapBox.y + minimapBox.height - 8 };
    const beforeMinimapJump = await page.locator('[data-research-surface]').evaluate((element) => element.style.transform);
    await page.mouse.click(minimapTarget.x, minimapTarget.y);
    await page.waitForTimeout(300);
    assert.notEqual(await page.locator('[data-research-surface]').evaluate((element) => element.style.transform), beforeMinimapJump,
      'clicking outside the minimap viewport frame must smoothly center the camera');

    await page.evaluate(() => {
      localStorage.setItem('canvas:panSpeed', '19');
      localStorage.setItem('canvas:panInertia', '0.85');
      localStorage.setItem('canvas:zoomSpeed', '2.7');
    });
    await page.locator('[data-research-settings-open]').click();
    await page.locator('[data-research-settings-reset-open]').click();
    await page.locator('[data-research-settings-reset-accept]').click();
    assert.deepEqual(await page.evaluate(() => ({
      research: [
        localStorage.getItem('research:panSpeed:v1'),
        localStorage.getItem('research:panInertia:v1'),
        localStorage.getItem('research:zoomSpeed:v1'),
      ],
      canvas: [
        localStorage.getItem('canvas:panSpeed'),
        localStorage.getItem('canvas:panInertia'),
        localStorage.getItem('canvas:zoomSpeed'),
      ],
      controls: [
        document.querySelector('[data-research-pan-speed]').value,
        document.querySelector('[data-research-pan-inertia]').value,
        document.querySelector('[data-research-zoom-speed]').value,
      ],
    })), { research: [null, null, null], canvas: ['19', '0.85', '2.7'], controls: ['8', '0.15', '1'] },
    'restoring Research defaults must not mutate main-canvas preferences');
    await page.locator('[data-research-settings-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-research-settings-panel]').hidden);
    await researchViewport.focus();
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(300);
    report.circuits.viewport = {
      smoothZoom: true, anchoredZoom: true, dragInertia: true, zeroInertia: true,
      adjustableKeyboardPan: true, minimapPersistentNodes: true, minimapJump: true, isolatedPreferences: true,
    };

    await page.locator('[data-research-dock-collapse]').click();
    await page.locator('[data-research-viewport]').focus();
    await page.keyboard.press('Tab');
    await page.locator('[data-research-add-search]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains('is-collapsed')), false,
      'Tab inside the panel must keep native keyboard navigation');
    await page.locator('[data-research-inspector-close]').click();

    const countBeforeNodeDoubleClick = await page.locator('[data-node-id]').count();
    await page.locator('[data-node-id="fa-a"]').dblclick();
    assert.equal(await page.locator('[data-node-id]').count(), countBeforeNodeDoubleClick,
      'double-clicking a node must never create another node');
    assert.equal(await page.locator('[data-node-id="fa-a"] [data-node-text][contenteditable="true"]').count(), 1,
      'double-clicking a node must enter inline label editing');
    await page.keyboard.press('Escape');
    const viewportBox = await page.locator('[data-research-viewport]').boundingBox();
    assert(viewportBox, 'Research viewport must remain visible');
    await page.mouse.dblclick(viewportBox.x + viewportBox.width - 180, viewportBox.y + viewportBox.height - 170);
    assert.equal(await page.locator('[data-node-id]').count(), countBeforeNodeDoubleClick + 1,
      'a stable blank-canvas double-click must create exactly one selected type');
    await page.locator('[data-node-id="fa-a"]').click();
    await page.locator('[data-node-id="fa-b"]').click({ modifiers: ['Control'] });
    const multiSelectDockBox = await computeDock.boundingBox();
    assert(multiSelectDockBox && Math.round(multiSelectDockBox.width) === Math.round(initialDockBox.width)
      && Math.round(multiSelectDockBox.height) === Math.round(initialDockBox.height),
    'multi-selection must not resize the compute dock');
    await page.locator('[data-research-run]').click();
    const runningDockBox = await computeDock.boundingBox();
    assert(runningDockBox && Math.round(runningDockBox.width) === Math.round(initialDockBox.width)
      && Math.round(runningDockBox.height) === Math.round(initialDockBox.height),
    'run state must not resize the compute dock');
    await page.locator('[data-research-pause]').click();

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

    const plainDragNode = await boxCenter(page.locator('[data-node-id="fa-b"]'));
    await page.mouse.move(plainDragNode.x, plainDragNode.y);
    await page.mouse.down();
    await page.mouse.move(plainDragNode.x + 12, plainDragNode.y + 8, { steps: 4 });
    assert.equal(await page.locator('[data-research-active-edges] line.is-preview').count(), 0,
      'ordinary node dragging must not start any connection preview');
    await page.mouse.up();
    await page.waitForTimeout(450);
    assert.equal(saves.at(-1).pages[0].edges.length, fixture.pages[0].edges.length,
      'ordinary node dragging must not persist a connection');

    // Both port directions may start a wire gesture. Rewiring from an occupied
    // value input must retain the existing edge identity and remain one undo step.
    await page.locator('button[data-research-connection-kind="wire"]').click();
    const xorInputA = page.locator('[data-node-id="fa-xor-1"] [data-research-port="a"]');
    const cinOutput = page.locator('[data-node-id="fa-cin"] [data-research-port="out"]');
    await page.waitForTimeout(450);
    const savesBeforeReconnect = saves.length;
    await moveWirePointer(page, xorInputA, cinOutput);
    assert.equal(await page.locator('[data-research-active-edges] line.is-data').count(), 1,
      'Alt-drag from an exact port must start a wire preview');
    assert.equal(await page.locator('[data-research-active-edges] line.is-invalid').count(), 0,
      'a compatible reverse wire gesture must remain valid');
    await finishConnectionPointer(page);
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
    await page.keyboard.down('Alt');
    await page.mouse.move(outputCenter.x, outputCenter.y);
    await page.mouse.down();
    await page.mouse.move(outputCenter.x + 40, outputCenter.y + 50, { steps: 4 });
    const activeWire = page.locator('[data-research-active-edges] line.is-data');
    assert(Math.abs(Number(await activeWire.getAttribute('x1')) - outputCenter.x) < 0.75);
    const activeWireY = Number(await activeWire.getAttribute('y1'));
    assert(Math.abs(activeWireY - outputCenter.y) < 0.75,
      `wire preview y1 ${activeWireY} must match rendered port center ${outputCenter.y}`);
    await finishConnectionPointer(page);
    const savesBeforeInvalid = saves.length;
    await moveWirePointer(page, page.locator('[data-node-id="fa-a"] [data-research-port="out"]'), xorInputA);
    assert.equal(await page.locator('[data-research-active-edges] line.is-invalid').count(), 1,
      'an occupied value input must show a red invalid preview');
    await finishConnectionPointer(page);
    await page.waitForTimeout(450);
    assert.equal(saves.length, savesBeforeInvalid, 'an invalid wire gesture must not schedule persistence');

    // Relation previews and committed relation geometry use the rendered node
    // borders rather than disappearing beneath each node center.
    await page.locator('button[data-research-connection-kind="relation"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('research:connectionKind:v1')), 'relation');
    const relationFrom = await boxCenter(page.locator('[data-node-id="fa-a"]'));
    const relationTo = await boxCenter(page.locator('[data-node-id="fa-carry-monitor"]'));
    await page.keyboard.down('Alt');
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
    await finishConnectionPointer(page);
    const selectedDockBox = await computeDock.boundingBox();
    assert(selectedDockBox && Math.round(selectedDockBox.width) === Math.round(initialDockBox.width)
      && Math.round(selectedDockBox.height) === Math.round(initialDockBox.height),
    'selection and connection changes must not resize the compute dock');
    report.circuits.wiring = { reverseStart: true, atomicReconnect: true, invalidPreview: true, borderGeometry: true };

    // Configuration uses the same visible inspector a person uses. Changing Cin
    // must immediately propagate through both downstream logic branches.
    await page.locator('[data-node-id="fa-cin"]').click();
    await page.locator('[data-research-viewport]').focus();
    await page.keyboard.press('Tab');
    const cin = page.locator('[data-research-inspector-fields] input[type="checkbox"]');
    await cin.focus();
    await page.keyboard.press('Tab');
    assert.equal(await sidePanel.evaluate((element) => element.classList.contains('is-collapsed')), false,
      'Tab in an inspector control must not collapse the unified panel');
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
    await page.locator('[data-research-inspector-close]').click();
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
    await reducedPage.locator('[data-node-id="fa-sum"]').waitFor({ state: 'visible' });
    const reducedViewportBox = await reducedPage.locator('[data-research-viewport]').boundingBox();
    assert(reducedViewportBox, 'reduced-motion Research viewport must remain visible');
    const reducedWheel = await reducedPage.evaluate(({ x, y }) => {
      const viewport = document.querySelector('[data-research-viewport]');
      const surface = document.querySelector('[data-research-surface]');
      const before = surface.style.transform;
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -100, clientX: x, clientY: y,
      }));
      return { before, after: surface.style.transform };
    }, { x: reducedViewportBox.x + reducedViewportBox.width / 2, y: reducedViewportBox.y + reducedViewportBox.height / 2 });
    assert.notEqual(reducedWheel.after, reducedWheel.before,
      'reduced motion must apply wheel zoom immediately without an animated intermediate state');
    const reducedPanStart = {
      x: reducedViewportBox.x + reducedViewportBox.width * .66,
      y: reducedViewportBox.y + reducedViewportBox.height * .62,
    };
    await reducedPage.keyboard.down('Space');
    await reducedPage.mouse.move(reducedPanStart.x, reducedPanStart.y);
    await reducedPage.mouse.down();
    await reducedPage.mouse.move(reducedPanStart.x + 90, reducedPanStart.y + 20);
    await reducedPage.mouse.up();
    await reducedPage.keyboard.up('Space');
    const reducedRelease = await reducedPage.locator('[data-research-surface]').evaluate((element) => element.style.transform);
    await reducedPage.waitForTimeout(90);
    assert.equal(await reducedPage.locator('[data-research-surface]').evaluate((element) => element.style.transform), reducedRelease,
      'reduced motion must disable post-release canvas inertia');
    await reducedPage.locator('[data-node-id="fa-sum"]').click();
    assert.equal(await reducedPage.locator('.research-side-panel-content-ghost').count(), 0,
      'reduced motion must switch panel content without an outgoing animation layer');
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
    report.circuits.viewport.reducedMotion = true;
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
