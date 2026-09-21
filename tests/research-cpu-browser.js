'use strict';

// Optional real-browser acceptance harness for the V3 subcircuit workflow.
// The CPU is authored from an empty workspace exclusively through the public
// Research UI. Playwright belongs to the test host, not the application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const clone = (value) => JSON.parse(JSON.stringify(value));
const emptyDocument = () => ({
  researchVersion: 3,
  subcircuits: [],
  pages: [{
    id: 'cpu-authoring', title: '', nodes: [], edges: [],
    view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 },
  }],
  activePageId: 'cpu-authoring',
});

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rounded(value) { return Math.round(Number(value || 0) * 100) / 100; }

function reportDurations(values) {
  return {
    count: values.length,
    medianMs: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    maxMs: rounded(Math.max(0, ...values)),
  };
}

async function installWorkspaceRoute(page) {
  let current = emptyDocument();
  let revision = 0;
  const saves = [];
  await page.route('**/api/research/workspace', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ document: clone(current), revision: 'cpu-' + revision }),
      });
      return;
    }
    const payload = request.postDataJSON();
    current = clone(payload.document);
    revision += 1;
    saves.push({ at: Date.now(), document: clone(current) });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ document: clone(current), revision: 'cpu-' + revision }),
    });
  });
  return {
    current: () => clone(current),
    saves,
  };
}

async function waitForSave(routeState, previousCount, timeoutMs = 12000) {
  const started = Date.now();
  while (routeState.saves.length <= previousCount && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(routeState.saves.length > previousCount, 'the public Research save must complete');
  return routeState.current();
}

async function waitForDocument(routeState, predicate, message, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const document = routeState.current();
    if (predicate(document)) return document;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function definitionByName(document, name) {
  return document.subcircuits.find((item) => item.name === name) || null;
}

function revisionByNumber(definition, revision) {
  return definition && definition.revisions.find((item) => item.revision === revision) || null;
}

function portId(definition, revision, name) {
  const record = revisionByNumber(definition, revision);
  const port = record && record.ports.find((item) => item.name === name);
  assert(port, `${definition && definition.name || 'definition'} r${revision} must expose ${name}`);
  return port.id;
}

class PublicResearchBuilder {
  constructor(page, routeState, actions) {
    this.page = page;
    this.routeState = routeState;
    this.actions = actions;
    this.currentTool = '';
    this.requestedWires = [];
  }

  viewport() { return this.page.locator('[data-research-viewport]'); }

  node(id) { return this.page.locator(`[data-node-id="${id}"]`); }

  async closeInspector() {
    const panel = this.page.locator('[data-research-side-panel]');
    if (await panel.isVisible() && !(await panel.evaluate((element) => element.classList.contains('is-collapsed')))) {
      await this.page.locator('[data-research-inspector-close]').click();
    }
  }

  async openInspector() {
    const panel = this.page.locator('[data-research-side-panel]');
    if (await panel.evaluate((element) => element.classList.contains('is-collapsed'))) {
      await this.viewport().focus();
      await this.page.keyboard.press('Tab');
    }
  }

  async chooseTool(type) {
    if (this.currentTool === type) return;
    const countBefore = await this.page.locator('[data-node-id]').count();
    await this.page.locator('[data-research-add]').click();
    assert.equal(await this.page.locator('[data-node-id]').count(), countBefore, `opening the palette must not create a node before ${type}`);
    const search = this.page.locator('[data-research-add-search]');
    await search.fill(type);
    assert.equal(await this.page.locator('[data-node-id]').count(), countBefore, `filtering the palette must not create a node before ${type}`);
    await this.page.locator(`[data-research-node-type="${type}"]`).evaluate((button) => button.click());
    assert.equal(await this.page.locator('[data-node-id]').count(), countBefore, `choosing ${type} must not create a node`);
    this.currentTool = type;
    this.actions.paletteSelections += 1;
  }

  async createNode(type, label, point, config = {}) {
    await this.closeInspector();
    await this.chooseTool(type);
    await this.closeInspector();
    const before = new Set(await this.page.locator('[data-node-id]').evaluateAll((items) => items.map((item) => item.dataset.nodeId)));
    await this.page.evaluate(({ x, y }) => {
      const viewport = document.querySelector('[data-research-viewport]');
      const rect = viewport.getBoundingClientRect();
      const clientX = rect.left + x;
      const clientY = rect.top + y;
      const target = document.elementFromPoint(clientX, clientY);
      target.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX, clientY, button: 0,
      }));
    }, point);
    const ids = await this.page.locator('[data-node-id]').evaluateAll((items) => items.map((item) => item.dataset.nodeId));
    const id = ids.find((candidate) => !before.has(candidate));
    if (!id) {
      const nodes = await this.page.locator('[data-node-id]').evaluateAll((items) => items.map((item) => ({
        id: item.dataset.nodeId,
        type: item.dataset.nodeType,
        label: item.querySelector('[data-node-text]').textContent,
      })));
      assert(id, `public double-click must create ${type}; before=${JSON.stringify(Array.from(before))}; nodes=${JSON.stringify(nodes)}`);
    }
    this.actions.nodesCreated += 1;
    await this.setLabel(label);
    for (const [field, value] of Object.entries(config)) await this.setField(field, value);
    await this.closeInspector();
    return id;
  }

  async setLabel(label) {
    await this.openInspector();
    const input = this.page.locator('[data-research-inspector-fields] label').first().locator('input');
    await input.fill(label);
    await input.evaluate((element) => element.blur());
    this.actions.propertyEdits += 1;
  }

  field(label) {
    return this.page.locator('[data-research-inspector-fields] label').filter({
      hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    }).first();
  }

  async setField(label, value) {
    await this.openInspector();
    const row = this.field(label);
    await row.waitFor({ state: 'visible' });
    if (value && typeof value === 'object' && value.kind === 'typed') {
      await row.locator('select').selectOption(value.type);
      if (value.type === 'boolean') {
        const input = row.locator('input').first();
        if (value.value) await input.check(); else await input.uncheck();
      } else {
        if (value.type === 'bits') {
          const width = row.locator('input').nth(1);
          await width.fill(String(value.width));
          await width.dispatchEvent('change');
        }
        const input = row.locator('input').first();
        await input.fill(String(value.value));
        await input.dispatchEvent('change');
      }
    } else if (typeof value === 'boolean') {
      if (value) await row.locator('input').check(); else await row.locator('input').uncheck();
    } else if (await row.locator('select').count()) {
      await row.locator('select').selectOption(String(value));
    } else {
      const input = row.locator('input');
      await input.fill(String(value));
      await input.evaluate((element) => element.blur());
    }
    this.actions.propertyEdits += 1;
  }

  async selectNode(id) {
    await this.node(id).click();
    await this.openInspector();
  }

  async selectNodes(ids) {
    assert(ids.length, 'a subcircuit selection may not be empty');
    await this.node(ids[0]).click();
    for (const id of ids.slice(1)) await this.node(id).click({ modifiers: ['Control'] });
    this.actions.multiSelections += 1;
  }

  async setWireMode() {
    const button = this.page.locator('button[data-research-connection-kind="wire"]');
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  }

  port(nodeId, id, direction) {
    return this.page.locator(`[data-node-id="${nodeId}"] [data-research-port="${id}"][data-research-port-direction="${direction}"]`);
  }

  async wire(fromNodeId, fromPort, toNodeId, toPort, record = true, reverse = false) {
    await this.closeInspector();
    await this.setWireMode();
    await this.page.waitForTimeout(35);
    const from = this.port(fromNodeId, fromPort, 'output');
    const to = this.port(toNodeId, toPort, 'input');
    const startLocator = reverse ? to : from;
    const endLocator = reverse ? from : to;
    const start = await startLocator.boundingBox();
    let end = await endLocator.boundingBox();
    assert(start && end, `wire endpoints must be visible: ${fromNodeId}.${fromPort} -> ${toNodeId}.${toPort}`);
    await this.page.keyboard.down('Alt');
    await this.page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await this.page.mouse.down();
    await this.page.waitForTimeout(20);
    end = await endLocator.boundingBox();
    assert(end, `wire target must remain visible: ${toNodeId}.${toPort}`);
    await this.page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
    await this.page.mouse.up();
    await this.page.keyboard.up('Alt');
    await this.page.waitForTimeout(20);
    if (record) this.requestedWires.push({ fromNodeId, fromPort, toNodeId, toPort });
    this.actions.wiresCreated += 1;
  }

  async ensureRequestedWires() {
    const exists = (document, spec) => {
      const page = document.pages.find((item) => item.id === document.activePageId);
      return !!page && page.edges.some((edge) => edge.kind === 'wire'
        && edge.from.nodeId === spec.fromNodeId && edge.from.portId === spec.fromPort
        && edge.to.nodeId === spec.toNodeId && edge.to.portId === spec.toPort);
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.page.waitForTimeout(450);
      const document = this.routeState.current();
      const missing = this.requestedWires.filter((spec) => !exists(document, spec));
      if (!missing.length) return;
      for (const spec of missing) {
        await this.wire(spec.fromNodeId, spec.fromPort, spec.toNodeId, spec.toPort, false, true);
        this.actions.wireRetries = (this.actions.wireRetries || 0) + 1;
      }
    }
    await this.page.waitForTimeout(500);
    const document = this.routeState.current();
    const missing = this.requestedWires.filter((spec) => !exists(document, spec));
    const activePage = document.pages.find((item) => item.id === document.activePageId);
    const relatedIds = new Set(missing.flatMap((spec) => [spec.fromNodeId, spec.toNodeId]));
    const related = activePage ? activePage.nodes.filter((node) => relatedIds.has(node.id)) : [];
    const targetEdges = activePage ? activePage.edges.filter((edge) => edge.kind === 'wire'
      && missing.some((spec) => edge.to.nodeId === spec.toNodeId)) : [];
    assert.equal(missing.length, 0, 'all requested public wires must persist: '
      + JSON.stringify({ missing, related, targetEdges }));
  }

  async moveNode(id, point) {
    await this.closeInspector();
    const box = await this.node(id).boundingBox();
    const viewport = await this.viewport().boundingBox();
    assert(box && viewport, 'node and viewport must be visible for public dragging');
    const start = { x: box.x + box.width / 2, y: box.y + Math.min(34, box.height / 2) };
    const target = { x: viewport.x + point.x, y: viewport.y + point.y };
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(target.x, target.y, { steps: 6 });
    await this.page.mouse.up();
    this.actions.nodeDrags += 1;
  }

  async addSubcircuit(definitionId, point, label = '') {
    await this.closeInspector();
    const before = new Set(await this.page.locator('[data-node-id]').evaluateAll((items) => items.map((item) => item.dataset.nodeId)));
    await this.page.locator('[data-research-add]').click();
    await this.page.locator('[data-research-add-search]').fill('');
    await this.page.locator(`[data-research-subcircuit-id="${definitionId}"]`).evaluate((button) => button.click());
    assert.equal(await this.page.locator('[data-node-id]').count(), before.size,
      'selecting a reusable subcircuit must not place it immediately');
    await this.closeInspector();
    await this.page.evaluate(({ x, y }) => {
      const viewport = document.querySelector('[data-research-viewport]');
      const rect = viewport.getBoundingClientRect();
      const clientX = rect.left + x;
      const clientY = rect.top + y;
      const target = document.elementFromPoint(clientX, clientY);
      target.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX, clientY, button: 0,
      }));
    }, point);
    await this.page.waitForFunction((known) => Array.from(document.querySelectorAll('[data-node-id]'))
      .some((item) => !known.includes(item.dataset.nodeId)), Array.from(before));
    const ids = await this.page.locator('[data-node-id]').evaluateAll((items) => items.map((item) => item.dataset.nodeId));
    const id = ids.find((candidate) => !before.has(candidate));
    assert(id, 'public blank-canvas double-click must create the selected subcircuit instance');
    this.actions.instancesCreated += 1;
    if (label) await this.setLabel(label);
    await this.closeInspector();
    return id;
  }

  async publish(ids, options) {
    await this.ensureRequestedWires();
    await this.closeInspector();
    await this.selectNodes(ids);
    await this.openInspector();
    await this.page.locator('[data-research-subcircuit-create]:visible').click();
    if (options.targetId) {
      await this.page.locator('[data-research-subcircuit-target]').selectOption(options.targetId);
    } else {
      await this.page.locator('[data-research-subcircuit-name]').fill(options.name);
    }
    const rows = this.page.locator('[data-research-subcircuit-ports] [data-port-id]');
    await rows.first().waitFor({ state: 'visible' });
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const name = row.locator('[data-port-name]');
      const current = await name.inputValue();
      const next = options.renamePort(current);
      assert(next, `a published boundary port must be named explicitly: ${current}`);
      await name.fill(next);
      this.actions.portRenames += 1;
    }
    const previousDefinition = definitionByName(this.routeState.current(), options.name);
    const previousLatest = previousDefinition ? previousDefinition.latestRevision : 0;
    await this.page.locator('[data-research-subcircuit-confirm]').click();
    const document = await waitForDocument(this.routeState, (candidate) => {
      const definition = definitionByName(candidate, options.name);
      return definition && definition.latestRevision > previousLatest;
    }, `published definition ${options.name} must be saved`);
    this.actions.definitionsPublished += 1;
    const definition = definitionByName(document, options.name);
    assert(definition, `published definition ${options.name} must be saved`);
    if (Number.isInteger(options.expectedEdges)) {
      const revision = revisionByNumber(definition, definition.latestRevision);
      assert.equal(revision.edges.length, options.expectedEdges,
        `${options.name} r${definition.latestRevision} must retain every public wire`);
    }
    const instances = document.pages.find((item) => item.id === document.activePageId).nodes
      .filter((item) => item.type === 'subcircuit' && item.config.definitionId === definition.id);
    assert(instances.length, `publishing ${options.name} must replace the selection with an instance`);
    this.requestedWires = [];
    return { definition, instanceId: instances.at(-1).id, document };
  }

  async clearPage() {
    await this.closeInspector();
    await this.viewport().press('Control+a');
    await this.viewport().press('Delete');
    await this.page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 0);
    this.currentTool = '';
    this.requestedWires = [];
  }

  async createPage() {
    const before = await this.page.locator('[data-research-page-id]').count();
    await this.page.locator('[data-research-page-hotspot]').hover();
    await this.page.locator('[data-research-page-rail]').waitFor({ state: 'visible' });
    await this.page.locator('[data-research-page-add]').click();
    await this.page.waitForFunction((count) => document.querySelectorAll('[data-research-page-id]').length === count + 1, before);
    this.currentTool = '';
    this.actions.pagesCreated += 1;
    return before;
  }

  async selectPage(index) {
    await this.page.locator('[data-research-page-hotspot]').hover();
    await this.page.locator('[data-research-page-rail]').waitFor({ state: 'visible' });
    await this.page.locator('[data-research-page-id]').nth(index).click();
    await this.page.waitForFunction((expected) => {
      const active = document.querySelector('[data-research-page-id].is-active');
      return active && active.textContent.trim() === String(expected + 1);
    }, index);
    this.currentTool = '';
  }
}

const typed = (type, value, width = 0) => ({ kind: 'typed', type, value, ...(type === 'bits' ? { width } : {}) });
const bits = (width, value) => typed('bits', value, width);

function renameByFragments(entries) {
  return (current) => {
    const match = entries.find(([fragment]) => current.includes(fragment));
    return match && match[1];
  };
}

async function buildRom(builder, initialValue, targetId = '') {
  const externalPc = await builder.createNode('constant', 'ROM PC Source', { x: 90, y: 560 }, { '值': bits(4, '0x0') });
  const pc = await builder.createNode('bits', 'ROM PC Input', { x: 320, y: 560 }, {
    '操作': 'resize', '输出位宽': 4,
  });
  const addresses = [];
  const compares = [];
  for (let index = 0; index < 3; index += 1) {
    addresses.push(await builder.createNode('constant', `ROM Address ${index}`, { x: 330, y: 120 + index * 155 }, {
      '值': bits(4, '0x' + index.toString(16)),
    }));
    compares.push(await builder.createNode('compare', `ROM PC = ${index}`, { x: 620, y: 120 + index * 155 }, {
      '比较': 'equal',
    }));
  }
  const instructions = [
    await builder.createNode('constant', `LDI ${initialValue}`, { x: 620, y: 650 }, {
      '值': bits(8, '0x0' + initialValue.toString(16)),
    }),
    await builder.createNode('constant', 'SUB 1', { x: 620, y: 800 }, { '值': bits(8, '0x11') }),
    await builder.createNode('constant', 'JNZ 1', { x: 620, y: 950 }, { '值': bits(8, '0x21') }),
    await builder.createNode('constant', 'HLT', { x: 620, y: 1100 }, { '值': bits(8, '0xf0') }),
  ];
  const select2 = await builder.createNode('select', 'ROM Select 2', { x: 900, y: 870 });
  const select1 = await builder.createNode('select', 'ROM Select 1', { x: 1160, y: 650 });
  const select0 = await builder.createNode('select', 'ROM Instruction', { x: 1420, y: 430 });
  const monitor = await builder.createNode('monitor', 'ROM Instruction Sink', { x: 1680, y: 430 });

  await builder.wire(externalPc, 'out', pc, 'a');
  for (let index = 0; index < 3; index += 1) {
    await builder.wire(pc, 'out', compares[index], 'a');
    await builder.wire(addresses[index], 'out', compares[index], 'b');
  }
  await builder.wire(compares[2], 'out', select2, 'condition');
  await builder.wire(instructions[2], 'out', select2, 'whenTrue');
  await builder.wire(instructions[3], 'out', select2, 'whenFalse');
  await builder.wire(compares[1], 'out', select1, 'condition');
  await builder.wire(instructions[1], 'out', select1, 'whenTrue');
  await builder.wire(select2, 'out', select1, 'whenFalse');
  await builder.wire(compares[0], 'out', select0, 'condition');
  await builder.wire(instructions[0], 'out', select0, 'whenTrue');
  await builder.wire(select1, 'out', select0, 'whenFalse');
  await builder.wire(select0, 'out', monitor, 'in');

  return builder.publish([pc, ...addresses, ...compares, ...instructions, select2, select1, select0], {
    name: 'CPU ROM', targetId,
    expectedEdges: 15,
    renamePort: renameByFragments([
      ['ROM PC Input.a', 'pc'],
      ['ROM Instruction.out', 'instruction'],
    ]),
  });
}

async function buildDecoder(builder) {
  const externalInstruction = await builder.createNode('constant', 'Decoder Instruction Source', { x: 90, y: 560 }, {
    '值': bits(8, '0x03'),
  });
  const instruction = await builder.createNode('bits', 'Decoder Instruction Input', { x: 320, y: 560 }, {
    '操作': 'resize', '输出位宽': 8,
  });
  const opcode = await builder.createNode('bits', 'Decoder Opcode', { x: 590, y: 330 }, {
    '操作': 'slice', '起始位': 4, '输出位宽': 4,
  });
  const operand = await builder.createNode('bits', 'Decoder Operand', { x: 590, y: 780 }, {
    '操作': 'slice', '起始位': 0, '输出位宽': 4,
  });
  const opcodeValues = [0, 1, 2, 15];
  const names = ['LDI', 'SUB', 'JNZ', 'HLT'];
  const constants = [];
  const compares = [];
  const monitors = [];
  for (let index = 0; index < names.length; index += 1) {
    constants.push(await builder.createNode('constant', `Opcode ${names[index]}`, { x: 820, y: 110 + index * 205 }, {
      '值': bits(4, '0x' + opcodeValues[index].toString(16)),
    }));
    compares.push(await builder.createNode('compare', `Decoder is${names[index]}`, { x: 1080, y: 110 + index * 205 }, {
      '比较': 'equal',
    }));
    monitors.push(await builder.createNode('monitor', `Decoder ${names[index]} Sink`, { x: 1350, y: 110 + index * 205 }));
  }
  const operandMonitor = await builder.createNode('monitor', 'Decoder Operand Sink', { x: 850, y: 1010 });

  await builder.wire(externalInstruction, 'out', instruction, 'a');
  await builder.wire(instruction, 'out', opcode, 'a');
  await builder.wire(instruction, 'out', operand, 'a');
  for (let index = 0; index < names.length; index += 1) {
    await builder.wire(opcode, 'out', compares[index], 'a');
    await builder.wire(constants[index], 'out', compares[index], 'b');
    await builder.wire(compares[index], 'out', monitors[index], 'in');
  }
  await builder.wire(operand, 'out', operandMonitor, 'in');

  return builder.publish([instruction, opcode, operand, ...constants, ...compares], {
    name: 'CPU Decoder',
    expectedEdges: 10,
    renamePort: renameByFragments([
      ['Decoder Instruction Input.a', 'instruction'],
      ['Decoder Operand.out', 'operand'],
      ['Decoder isLDI.out', 'isLdi'],
      ['Decoder isSUB.out', 'isSub'],
      ['Decoder isJNZ.out', 'isJnz'],
      ['Decoder isHLT.out', 'isHalt'],
    ]),
  });
}

async function buildAlu(builder) {
  const accSource = await builder.createNode('constant', 'ALU ACC Source', { x: 80, y: 250 }, { '值': bits(4, '0x3') });
  const operandSource = await builder.createNode('constant', 'ALU Operand Source', { x: 80, y: 560 }, { '值': bits(4, '0x1') });
  const ldiSource = await builder.createNode('toggle', 'ALU LDI Source', { x: 80, y: 850 }, { '初始状态': false });
  const subSource = await builder.createNode('toggle', 'ALU SUB Source', { x: 80, y: 1030 }, { '初始状态': true });
  const acc = await builder.createNode('bits', 'ALU ACC Input', { x: 360, y: 250 }, { '操作': 'resize', '输出位宽': 4 });
  const operand = await builder.createNode('bits', 'ALU Operand Input', { x: 360, y: 560 }, { '操作': 'resize', '输出位宽': 4 });
  const subtract = await builder.createNode('math', 'ALU Subtract', { x: 700, y: 400 }, { '运算': 'subtract' });
  const subSelect = await builder.createNode('select', 'ALU SUB Select', { x: 1040, y: 540 });
  const ldiSelect = await builder.createNode('select', 'ALU Next ACC', { x: 1350, y: 610 });
  const monitor = await builder.createNode('monitor', 'ALU Next ACC Sink', { x: 1640, y: 610 });

  await builder.wire(accSource, 'out', acc, 'a');
  await builder.wire(operandSource, 'out', operand, 'a');
  await builder.wire(acc, 'out', subtract, 'a');
  await builder.wire(operand, 'out', subtract, 'b');
  await builder.wire(subSource, 'out', subSelect, 'condition');
  await builder.wire(subtract, 'out', subSelect, 'whenTrue');
  await builder.wire(acc, 'out', subSelect, 'whenFalse');
  await builder.wire(ldiSource, 'out', ldiSelect, 'condition');
  await builder.wire(operand, 'out', ldiSelect, 'whenTrue');
  await builder.wire(subSelect, 'out', ldiSelect, 'whenFalse');
  await builder.wire(ldiSelect, 'out', monitor, 'in');

  return builder.publish([acc, operand, subtract, subSelect, ldiSelect], {
    name: 'CPU ALU',
    expectedEdges: 6,
    renamePort: renameByFragments([
      ['ALU ACC Input.a', 'acc'],
      ['ALU Operand Input.a', 'operand'],
      ['ALU Next ACC.condition', 'isLdi'],
      ['ALU SUB Select.condition', 'isSub'],
      ['ALU Next ACC.out', 'nextAcc'],
    ]),
  });
}

async function buildControl(builder) {
  const pcSource = await builder.createNode('constant', 'Control PC Source', { x: 80, y: 170 }, { '值': bits(4, '0x2') });
  const accSource = await builder.createNode('constant', 'Control ACC Source', { x: 80, y: 420 }, { '值': bits(4, '0x1') });
  const operandSource = await builder.createNode('constant', 'Control Operand Source', { x: 80, y: 670 }, { '值': bits(4, '0x1') });
  const jnzSource = await builder.createNode('toggle', 'Control JNZ Source', { x: 80, y: 900 }, { '初始状态': true });
  const haltSource = await builder.createNode('toggle', 'Control HLT Source', { x: 80, y: 1080 }, { '初始状态': false });
  const pc = await builder.createNode('bits', 'Control PC Input', { x: 350, y: 170 }, { '操作': 'resize', '输出位宽': 4 });
  const one = await builder.createNode('constant', 'Control One', { x: 350, y: 360 }, { '值': bits(4, '0x1') });
  const increment = await builder.createNode('math', 'Control PC + 1', { x: 680, y: 250 }, { '运算': 'add' });
  const zero = await builder.createNode('constant', 'Control Zero', { x: 350, y: 520 }, { '值': bits(4, '0x0') });
  const nonzero = await builder.createNode('compare', 'Control ACC Nonzero', { x: 680, y: 520 }, { '比较': 'not-equal' });
  const branch = await builder.createNode('logic', 'Control Take Branch', { x: 960, y: 680 }, { '运算': 'and' });
  const branchSelect = await builder.createNode('select', 'Control Branch Select', { x: 1230, y: 520 });
  const haltSelect = await builder.createNode('select', 'Control Next PC', { x: 1500, y: 420 });
  const monitor = await builder.createNode('monitor', 'Control Next PC Sink', { x: 1760, y: 420 });

  await builder.wire(pcSource, 'out', pc, 'a');
  await builder.wire(pc, 'out', increment, 'a');
  await builder.wire(one, 'out', increment, 'b');
  await builder.wire(accSource, 'out', nonzero, 'a');
  await builder.wire(zero, 'out', nonzero, 'b');
  await builder.wire(jnzSource, 'out', branch, 'a');
  await builder.wire(nonzero, 'out', branch, 'b');
  await builder.wire(branch, 'out', branchSelect, 'condition');
  await builder.wire(operandSource, 'out', branchSelect, 'whenTrue');
  await builder.wire(increment, 'out', branchSelect, 'whenFalse');
  await builder.wire(haltSource, 'out', haltSelect, 'condition');
  await builder.wire(pc, 'out', haltSelect, 'whenTrue');
  await builder.wire(branchSelect, 'out', haltSelect, 'whenFalse');
  await builder.wire(haltSelect, 'out', monitor, 'in');

  return builder.publish([pc, one, increment, zero, nonzero, branch, branchSelect, haltSelect], {
    name: 'CPU Control',
    expectedEdges: 8,
    renamePort: renameByFragments([
      ['Control PC Input.a', 'pc'],
      ['Control ACC Nonzero.a', 'acc'],
      ['Control Branch Select.whenTrue', 'operand'],
      ['Control Take Branch.a', 'isJnz'],
      ['Control Next PC.condition', 'isHalt'],
      ['Control Next PC.out', 'nextPc'],
    ]),
  });
}

async function buildCore(builder, definitions, targetId = '') {
  const romRevision = definitions.rom.latestRevision;
  const decoderRevision = definitions.decoder.latestRevision;
  const aluRevision = definitions.alu.latestRevision;
  const controlRevision = definitions.control.latestRevision;
  const clock = await builder.createNode('clock', 'CPU Clock Source', { x: 90, y: 570 }, { '周期（ms）': 40 });
  const pcRegister = await builder.createNode('register', 'PC Register', { x: 350, y: 260 }, {
    '初始值': bits(4, '0x0'),
  });
  const accRegister = await builder.createNode('register', 'ACC Register', { x: 350, y: 800 }, {
    '初始值': bits(4, '0x0'),
  });
  const rom = await builder.addSubcircuit(definitions.rom.id, { x: 650, y: 230 }, 'ROM');
  const decoder = await builder.addSubcircuit(definitions.decoder.id, { x: 930, y: 420 }, 'Decoder');
  const alu = await builder.addSubcircuit(definitions.alu.id, { x: 1220, y: 720 }, 'ALU');
  const control = await builder.addSubcircuit(definitions.control.id, { x: 1220, y: 230 }, 'Control');
  const pcMonitor = await builder.createNode('monitor', 'CPU PC Sink', { x: 1580, y: 130 });
  const accMonitor = await builder.createNode('monitor', 'CPU ACC Sink', { x: 1580, y: 390 });
  const instructionMonitor = await builder.createNode('monitor', 'CPU Instruction Sink', { x: 1580, y: 650 });
  const haltLamp = await builder.createNode('lamp', 'CPU Halt Sink', { x: 1580, y: 890 });
  const probe = await builder.createNode('probe', 'CPU Clock and ACC Probe', { x: 1850, y: 520 }, { '轨迹上限': 256 });

  const romPc = portId(definitions.rom, romRevision, 'pc');
  const romInstruction = portId(definitions.rom, romRevision, 'instruction');
  const decoderInstruction = portId(definitions.decoder, decoderRevision, 'instruction');
  const decoderOperand = portId(definitions.decoder, decoderRevision, 'operand');
  const decoderLdi = portId(definitions.decoder, decoderRevision, 'isLdi');
  const decoderSub = portId(definitions.decoder, decoderRevision, 'isSub');
  const decoderJnz = portId(definitions.decoder, decoderRevision, 'isJnz');
  const decoderHalt = portId(definitions.decoder, decoderRevision, 'isHalt');
  const aluAcc = portId(definitions.alu, aluRevision, 'acc');
  const aluOperand = portId(definitions.alu, aluRevision, 'operand');
  const aluLdi = portId(definitions.alu, aluRevision, 'isLdi');
  const aluSub = portId(definitions.alu, aluRevision, 'isSub');
  const aluNext = portId(definitions.alu, aluRevision, 'nextAcc');
  const controlPc = portId(definitions.control, controlRevision, 'pc');
  const controlAcc = portId(definitions.control, controlRevision, 'acc');
  const controlOperand = portId(definitions.control, controlRevision, 'operand');
  const controlJnz = portId(definitions.control, controlRevision, 'isJnz');
  const controlHalt = portId(definitions.control, controlRevision, 'isHalt');
  const controlNext = portId(definitions.control, controlRevision, 'nextPc');

  await builder.wire(clock, 'tick', pcRegister, 'write');
  await builder.wire(clock, 'tick', accRegister, 'write');
  await builder.wire(clock, 'tick', probe, 'pulse');
  await builder.wire(pcRegister, 'out', rom, romPc);
  await builder.wire(pcRegister, 'out', control, controlPc);
  await builder.wire(pcRegister, 'out', pcMonitor, 'in');
  await builder.wire(rom, romInstruction, decoder, decoderInstruction);
  await builder.wire(rom, romInstruction, instructionMonitor, 'in');
  await builder.wire(decoder, decoderOperand, alu, aluOperand);
  await builder.wire(decoder, decoderOperand, control, controlOperand);
  await builder.wire(decoder, decoderLdi, alu, aluLdi);
  await builder.wire(decoder, decoderSub, alu, aluSub);
  await builder.wire(decoder, decoderJnz, control, controlJnz);
  await builder.wire(decoder, decoderHalt, control, controlHalt);
  await builder.wire(decoder, decoderHalt, haltLamp, 'in');
  await builder.wire(accRegister, 'out', alu, aluAcc);
  await builder.wire(accRegister, 'out', control, controlAcc);
  await builder.wire(accRegister, 'out', accMonitor, 'in');
  await builder.wire(accRegister, 'out', probe, 'value');
  await builder.wire(alu, aluNext, accRegister, 'data');
  await builder.wire(control, controlNext, pcRegister, 'data');

  const published = await builder.publish([pcRegister, accRegister, rom, decoder, alu, control], {
    name: 'CPU Core', targetId,
    expectedEdges: 13,
    renamePort: renameByFragments([
      ['PC Register.write', 'pcTick'],
      ['ACC Register.write', 'accTick'],
      ['PC Register.out', 'pc'],
      ['ACC Register.out', 'acc'],
      ['ROM.instruction', 'instruction'],
      ['Decoder.isHalt', 'halt'],
    ]),
  });
  return {
    ...published,
    clock,
    pcMonitor,
    accMonitor,
    instructionMonitor,
    haltLamp,
    probe,
  };
}

async function expectNodeResult(page, nodeId, expected) {
  try {
    await page.waitForFunction(({ nodeId: id, value }) => {
      const result = document.querySelector(`[data-node-id="${id}"] [data-compute-result]`);
      return result && result.textContent.trim() === value;
    }, { nodeId, value: expected }, { timeout: 5000 });
  } catch (error) {
    const actual = await page.locator(`[data-node-id="${nodeId}"] [data-compute-result]`).textContent().catch(() => '<missing>');
    throw new Error(`${error.message}; node ${nodeId} expected ${expected}, got ${String(actual).trim()}`);
  }
  assert.equal((await page.locator(`[data-node-id="${nodeId}"] [data-compute-result]`).textContent()).trim(), expected);
}

async function stepAndMeasure(page, probeId, expectedEventCount) {
  const started = await page.evaluate(() => performance.now());
  await page.locator('[data-research-step]').click();
  await page.waitForFunction(({ probeId: id, count }) => {
    const node = document.querySelector(`[data-node-id="${id}"]`);
    if (!node || !node.classList.contains('is-selected')) return false;
    return document.querySelectorAll('[data-research-trace-list] li[data-trace-kind="event"]').length >= count;
  }, { probeId, count: expectedEventCount });
  return rounded((await page.evaluate(() => performance.now())) - started);
}

async function verifyProgram(page, core, steps, expectedInitialInstruction, expectedAccValues, samples = null) {
  await page.locator(`[data-node-id="${core.probe}"]`).click();
  const panel = page.locator('[data-research-side-panel]');
  if (await panel.evaluate((element) => element.classList.contains('is-collapsed'))) {
    await page.locator('[data-research-viewport]').focus();
    await page.keyboard.press('Tab');
  }
  await page.locator('[data-research-trace]').waitFor({ state: 'visible' });
  await expectNodeResult(page, core.pcMonitor, '= 0 · 4b');
  await expectNodeResult(page, core.accMonitor, '= 0 · 4b');
  await expectNodeResult(page, core.instructionMonitor, expectedInitialInstruction);
  await page.locator('[data-research-trace-clear]').click();
  let eventCount = await page.locator('[data-research-trace-list] li[data-trace-kind="event"]').count();
  for (let index = 0; index < steps; index += 1) {
    const elapsed = await stepAndMeasure(page, core.probe, eventCount + 1);
    eventCount += 1;
    if (samples) samples.push(elapsed);
  }
  await expectNodeResult(page, core.pcMonitor, '= 3 · 4b');
  await expectNodeResult(page, core.accMonitor, '= 0 · 4b');
  await expectNodeResult(page, core.instructionMonitor, '= F0 · 8b');
  assert(await page.locator(`[data-node-id="${core.haltLamp}"]`).evaluate((item) => item.classList.contains('is-lamp-on')),
    'HLT must light the public halt lamp');
  assert.equal(await page.locator('[data-research-trace-list] li[data-trace-kind="event"]').count(), steps,
    'Probe must record every CPU clock Pulse');
  const trace = await page.locator('[data-research-trace-list] li').evaluateAll((rows) => rows.map((row) => ({
    kind: row.dataset.traceKind,
    time: row.querySelector('time').textContent,
    value: row.querySelector('code').textContent,
  })).reverse());
  assert.deepEqual(trace.filter((entry) => entry.kind === 'value').map((entry) => entry.value),
    expectedAccValues.map((value) => `${value} · 4b`), 'Probe must retain the real ACC change order');
  trace.filter((entry) => entry.kind === 'value').forEach((entry) => {
    const valueIndex = trace.indexOf(entry);
    const pulseIndex = trace.findIndex((candidate) => candidate.kind === 'event' && candidate.time === entry.time);
    assert(pulseIndex >= 0 && pulseIndex < valueIndex,
      `the Clock Pulse must precede the ACC change at ${entry.time}`);
  });
}

async function createScalePage(builder, coreDefinition, routeState, metrics) {
  const pageIndex = await builder.createPage();
  const clock = await builder.createNode('clock', 'Scale Clock', { x: 100, y: 600 }, { '周期（ms）': 40 });
  const revision = coreDefinition.latestRevision;
  const pcTick = portId(coreDefinition, revision, 'pcTick');
  const accTick = portId(coreDefinition, revision, 'accTick');
  const pc = portId(coreDefinition, revision, 'pc');
  const acc = portId(coreDefinition, revision, 'acc');
  const instruction = portId(coreDefinition, revision, 'instruction');
  const halt = portId(coreDefinition, revision, 'halt');
  const instances = [];
  const started = Date.now();
  for (let index = 0; index < 25; index += 1) {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const instance = await builder.addSubcircuit(coreDefinition.id, {
      x: 360 + column * 300,
      y: 145 + row * 205,
    }, `CPU ${String(index + 1).padStart(2, '0')}`);
    instances.push(instance);
    await builder.wire(clock, 'tick', instance, pcTick);
    await builder.wire(clock, 'tick', instance, accTick);
  }
  const pcMonitor = await builder.createNode('monitor', 'Scale PC', { x: 1880, y: 180 });
  const accMonitor = await builder.createNode('monitor', 'Scale ACC', { x: 1880, y: 400 });
  const instructionMonitor = await builder.createNode('monitor', 'Scale Instruction', { x: 1880, y: 620 });
  const haltLamp = await builder.createNode('lamp', 'Scale Halt', { x: 1880, y: 840 });
  const probe = await builder.createNode('probe', 'Scale Probe', { x: 1880, y: 1060 }, { '轨迹上限': 256 });
  await builder.wire(instances[0], pc, pcMonitor, 'in');
  await builder.wire(instances[0], acc, accMonitor, 'in');
  await builder.wire(instances[0], instruction, instructionMonitor, 'in');
  await builder.wire(instances[0], halt, haltLamp, 'in');
  await builder.wire(instances[0], acc, probe, 'value');
  await builder.wire(clock, 'tick', probe, 'pulse');
  await builder.ensureRequestedWires();
  const document = routeState.current();
  metrics.scaleAuthoringMs = Date.now() - started;
  return {
    pageIndex,
    pageId: document.activePageId,
    instances,
    clock,
    pcMonitor,
    accMonitor,
    instructionMonitor,
    haltLamp,
    probe,
  };
}

async function loadValidationModules() {
  const definitions = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [registryModule, subcircuitModule, schemaModule, computeModule] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-registry.js')).href),
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-subcircuits.js')).href),
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-schema.js')).href),
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-compute.js')).href),
  ]);
  const registry = registryModule.createResearchRegistry(definitions);
  return { registry, subcircuitModule, schemaModule, computeModule };
}

async function validateFinalDocument(document, largePageId) {
  const modules = await loadValidationModules();
  const catalog = modules.subcircuitModule.createResearchSubcircuitCatalog(document.subcircuits);
  modules.registry.setSubcircuitCatalog(catalog);
  const checked = modules.schemaModule.validateResearchDocument(document, modules.registry);
  assert(checked.ok, checked.errors.map((item) => `${item.code}:${item.path || ''}`).join('\n'));
  const page = checked.document.pages.find((item) => item.id === largePageId);
  assert(page, 'the saved document must retain the 25-core scale page');
  const expansionStarted = performance.now();
  const compiled = modules.computeModule.compileResearchGraph(page, modules.registry);
  const expansionMs = rounded(performance.now() - expansionStarted);
  assert.equal(compiled.errors.length, 0, compiled.errors.map((item) => item.message).join('\n'));
  assert(compiled.stats.nodeCount >= 1000, `expected at least 1,000 expanded nodes, got ${compiled.stats.nodeCount}`);
  return {
    schemaValid: true,
    topLevelNodes: page.nodes.length,
    topLevelEdges: page.edges.length,
    expandedNodes: compiled.stats.nodeCount,
    expandedWires: compiled.stats.wireCount,
    expandedStateNodes: compiled.stats.stateNodeCount,
    expansionMs,
  };
}

async function inspectSavedPage(document, pageId, nodeIds) {
  const modules = await loadValidationModules();
  const catalog = modules.subcircuitModule.createResearchSubcircuitCatalog(document.subcircuits);
  modules.registry.setSubcircuitCatalog(catalog);
  const source = document.pages.find((item) => item.id === pageId);
  const runtime = modules.computeModule.createResearchComputeRuntime(source, { registry: modules.registry });
  return {
    errors: runtime.result.errors,
    missing: Object.entries(runtime.result.projection).filter(([, item]) => item && item.error)
      .slice(0, 20).map(([id, item]) => ({ id, error: item.error, inputs: item.inputs })),
    stats: runtime.result.stats,
    projection: Object.fromEntries(nodeIds.map((id) => [id, runtime.result.projection[id] || null])),
  };
}

async function run(playwright, url, options = {}) {
  const browser = await playwright.chromium.launch({
    headless: options.headless !== false,
    executablePath: options.edgePath || undefined,
  });
  const actions = {
    nodesCreated: 0,
    instancesCreated: 0,
    paletteSelections: 0,
    propertyEdits: 0,
    wiresCreated: 0,
    wireRetries: 0,
    nodeDrags: 0,
    multiSelections: 0,
    portRenames: 0,
    definitionsPublished: 0,
    pagesCreated: 0,
  };
  const report = {
    browser: browser.version(),
    viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
    cpu: {
      dataWidth: 4,
      instructionWidth: 8,
      instructions: ['LDI', 'SUB', 'JNZ', 'HLT'],
      r1Program: ['LDI 3', 'SUB 1', 'JNZ 1', 'HLT'],
      r2Program: ['LDI 5', 'SUB 1', 'JNZ 1', 'HLT'],
    },
    actions,
    revisions: {},
    metrics: {},
    errors: [],
  };
  try {
    const context = await browser.newContext({ viewport: report.viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      window.__researchCpuLongTasks = [];
      if (typeof PerformanceObserver === 'function') {
        try {
          const observer = new PerformanceObserver((list) => {
            list.getEntries().forEach((entry) => window.__researchCpuLongTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            }));
          });
          observer.observe({ type: 'longtask', buffered: true });
          window.__researchCpuLongTaskObserver = observer;
        } catch (_error) {}
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.errors.push('console: ' + message.text());
    });
    const routeState = await installWorkspaceRoute(page);
    const builder = new PublicResearchBuilder(page, routeState, actions);
    const longTasks = [];
    const collectLongTasks = async () => {
      const entries = await page.evaluate(() => window.__researchCpuLongTasks || []).catch(() => []);
      entries.forEach((entry) => longTasks.push(entry));
    };

    await page.goto(url.replace(/\/$/, '') + '/research.html');
    await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-research-viewport]').waitFor({ state: 'visible' });

    const authoringStarted = Date.now();
    const romR1 = await buildRom(builder, 3);
    await builder.clearPage();
    const decoder = await buildDecoder(builder);
    await builder.clearPage();
    const alu = await buildAlu(builder);
    await builder.clearPage();
    const control = await buildControl(builder);
    await builder.clearPage();
    let document = routeState.current();
    let definitions = {
      rom: definitionByName(document, 'CPU ROM'),
      decoder: definitionByName(document, 'CPU Decoder'),
      alu: definitionByName(document, 'CPU ALU'),
      control: definitionByName(document, 'CPU Control'),
    };
    Object.values(definitions).forEach((definition) => assert(definition, 'all four leaf modules must be published'));
    const coreR1 = await buildCore(builder, definitions);
    ['pcTick', 'accTick', 'pc', 'acc', 'instruction', 'halt'].forEach((name) => portId(coreR1.definition, 1, name));
    const coreInspection = await inspectSavedPage(routeState.current(), routeState.current().activePageId,
      [coreR1.pcMonitor, coreR1.accMonitor, coreR1.instructionMonitor, coreR1.haltLamp]);
    const coreSaved = routeState.current();
    const coreSavedPage = coreSaved.pages.find((item) => item.id === coreSaved.activePageId);
    const coreDebug = {
      monitorEdges: coreSavedPage.edges.filter((edge) => edge.kind === 'wire'
        && [coreR1.pcMonitor, coreR1.accMonitor, coreR1.instructionMonitor, coreR1.haltLamp].includes(edge.to.nodeId)),
      ports: revisionByNumber(definitionByName(coreSaved, 'CPU Core'), 1).ports,
    };
    assert(coreInspection.projection[coreR1.instructionMonitor] && coreInspection.projection[coreR1.instructionMonitor].output,
      'saved CPU instruction projection must exist: ' + JSON.stringify({ coreInspection, coreDebug }));
    report.metrics.baseAuthoringMs = Date.now() - authoringStarted;
    report.revisions.romR1 = romR1.definition.latestRevision;
    report.revisions.coreR1 = coreR1.definition.latestRevision;

    await verifyProgram(page, coreR1, 8, '= 03 · 8b', [3, 2, 1, 0]);
    report.cpu.r1Accepted = true;

    await builder.createPage();
    const romR2 = await buildRom(builder, 5, definitions.rom.id);
    await builder.clearPage();
    document = routeState.current();
    definitions = {
      rom: definitionByName(document, 'CPU ROM'),
      decoder: definitionByName(document, 'CPU Decoder'),
      alu: definitionByName(document, 'CPU ALU'),
      control: definitionByName(document, 'CPU Control'),
    };
    assert.equal(definitions.rom.latestRevision, 2);
    const coreR2 = await buildCore(builder, definitions, coreR1.definition.id);
    assert.equal(coreR2.definition.latestRevision, 2);
    report.revisions.romR2 = romR2.definition.latestRevision;
    report.revisions.coreR2 = coreR2.definition.latestRevision;

    document = routeState.current();
    const firstPage = document.pages[0];
    const pinned = firstPage.nodes.find((item) => item.id === coreR1.instanceId);
    assert(pinned && pinned.config.revision === 1, 'publishing CPU Core r2 must leave the old instance pinned to r1');
    report.revisions.oldInstanceStayedPinned = true;

    await builder.selectPage(0);
    await builder.selectNode(coreR1.instanceId);
    const upgrade = page.locator('[data-research-inspector-fields] button', { hasText: '升级到 r2' });
    await upgrade.waitFor({ state: 'visible' });
    await upgrade.click();
    document = await waitForDocument(routeState, (candidate) => candidate.pages[0].nodes
      .some((item) => item.id === coreR1.instanceId && item.config.revision === 2),
    'the public instance upgrade must persist r2');
    assert.equal(document.pages[0].nodes.find((item) => item.id === coreR1.instanceId).config.revision, 2);
    report.revisions.manualUpgrade = true;
    await expectNodeResult(page, coreR1.pcMonitor, '= 0 · 4b');
    await expectNodeResult(page, coreR1.accMonitor, '= 0 · 4b');
    await expectNodeResult(page, coreR1.instructionMonitor, '= 05 · 8b');
    report.revisions.upgradeClearedState = true;
    await page.locator('[data-research-reset]').click();
    await verifyProgram(page, coreR1, 12, '= 05 · 8b', [5, 4, 3, 2, 1, 0]);
    report.cpu.r2Accepted = true;

    document = routeState.current();
    const coreDefinition = definitionByName(document, 'CPU Core');
    const scale = await createScalePage(builder, coreDefinition, routeState, report.metrics);
    const stepSamples = [];
    for (let round = 0; round < 5; round += 1) {
      await page.locator('[data-research-reset]').click();
      await verifyProgram(page, scale, 12, '= 05 · 8b', [5, 4, 3, 2, 1, 0], stepSamples);
    }
    report.metrics.stepLatency = reportDurations(stepSamples);

    const reloads = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await collectLongTasks();
      const started = Date.now();
      await page.evaluate(() => RelatumResearchWorkspace.dispose());
      await page.reload();
      await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
      await page.evaluate(() => RelatumResearchWorkspace.activate());
      await expectNodeResult(page, scale.pcMonitor, '= 0 · 4b');
      await expectNodeResult(page, scale.instructionMonitor, '= 05 · 8b');
      reloads.push(Date.now() - started);
    }
    await collectLongTasks();
    report.metrics.coldReload = reportDurations(reloads);
    report.metrics.longTasks = {
      count: longTasks.length,
      totalMs: rounded(longTasks.reduce((sum, item) => sum + item.duration, 0)),
      maxMs: rounded(Math.max(0, ...longTasks.map((item) => item.duration))),
    };

    document = routeState.current();
    report.graph = await validateFinalDocument(document, scale.pageId);
    report.metrics.scaleExpansionMs = report.graph.expansionMs;
    report.persistence = {
      saves: routeState.saves.length,
      bytes: Buffer.byteLength(JSON.stringify(document), 'utf8'),
      definitions: document.subcircuits.length,
      revisions: document.subcircuits.reduce((sum, item) => sum + item.revisions.length, 0),
      pages: document.pages.length,
      runtimeTracePersisted: JSON.stringify(document).includes('traceByNodeId') || JSON.stringify(document).includes('"trace"'),
    };
    report.actions.total = Object.values(report.actions).reduce((sum, value) => sum + value, 0);
    assert.equal(report.persistence.runtimeTracePersisted, false, 'Probe/runtime trace must not be persisted');
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    report.accepted = true;
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [url, outputPath] = process.argv.slice(2);
  if (!url) {
    console.log('Optional browser test: node tests/research-cpu-browser.js <local URL> [report.json]');
    return;
  }
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'CPU browser fixture only accepts a local server');
  const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const report = await run(playwright, url, { edgePath: process.env.RELATUM_EDGE_PATH });
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

module.exports = { emptyDocument, installWorkspaceRoute, run };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
