const VALUE_TYPES = new Set(['number', 'boolean', 'string', 'time', 'bits']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeTypedValue(source, fallback = { type: 'number', value: 0 }) {
  const value = source && typeof source === 'object' ? source : fallback;
  const type = VALUE_TYPES.has(String(value.type || '')) ? String(value.type) : String(fallback.type || 'number');
  if (type === 'number' || type === 'time') {
    const number = Number(value.value);
    return { type, value: Number.isFinite(number) ? number : Number(fallback.value) || 0 };
  }
  if (type === 'boolean') return { type, value: value.value === true };
  if (type === 'string') return { type, value: String(value.value == null ? '' : value.value) };
  const width = Math.min(64, Math.max(1, Math.round(Number(value.width) || Number(fallback.width) || 1)));
  let parsed = 0n;
  try { parsed = BigInt(String(value.value == null ? '0' : value.value)); } catch (_error) { parsed = 0n; }
  const mask = (1n << BigInt(width)) - 1n;
  return { type: 'bits', width, value: '0x' + (parsed & mask).toString(16) };
}

function normalizeField(field, value) {
  const fallback = clone(field.default);
  if (field.type === 'typedValue') return normalizeTypedValue(value, fallback);
  if (field.type === 'boolean') return value == null ? !!fallback : value === true;
  if (field.type === 'integer') {
    const number = Number.isInteger(Number(value)) ? Number(value) : Number(fallback) || 0;
    return Math.min(Number(field.max), Math.max(Number(field.min), number));
  }
  if (field.type === 'select') {
    const text = String(value == null ? fallback : value);
    return Array.isArray(field.options) && field.options.includes(text) ? text : String(fallback);
  }
  return value == null ? fallback : value;
}

export function createResearchRegistry(document) {
  const source = document && typeof document === 'object' ? document : {};
  if (source.version !== 3 || !Array.isArray(source.nodes)) throw new Error('研究节点注册表版本无效');
  let subcircuitCatalog = null;
  const categories = Array.isArray(source.categories) ? source.categories.map((item) => ({ ...item })) : [];
  const byType = new Map();
  source.nodes.forEach((definition) => {
    const type = String(definition && definition.type || '');
    if (!type || byType.has(type)) throw new Error('研究节点类型重复：' + type);
    const ports = Array.isArray(definition.ports) ? definition.ports.map((port) => ({
      ...port,
      id: String(port.id || ''),
      direction: port.direction === 'output' ? 'output' : 'input',
      channel: port.channel === 'event' ? 'event' : 'value',
      types: Array.isArray(port.types) ? port.types.map(String) : ['any'],
      required: port.required === true,
      multiple: port.multiple === true,
      bitsWidths: Array.isArray(port.bitsWidths) ? port.bitsWidths.map(Number) : [],
      matchGroup: String(port.matchGroup || ''),
    })) : [];
    const configFields = Array.isArray(definition.configFields)
      ? definition.configFields.map((field) => ({ ...field })) : [];
    byType.set(type, Object.freeze({ ...definition, type, ports, configFields }));
  });

  function definition(type) {
    return byType.get(String(type || '')) || null;
  }

  function portsFor(nodeOrType) {
    const node = nodeOrType && typeof nodeOrType === 'object' ? nodeOrType : null;
    if (node && node.type === 'subcircuit') {
      return subcircuitCatalog ? subcircuitCatalog.portsForNode(node) : [];
    }
    const item = definition(node ? node.type : nodeOrType);
    return item ? item.ports : [];
  }

  function port(nodeOrType, portId, direction = '') {
    return portsFor(nodeOrType).find((candidate) => candidate.id === String(portId || '')
      && (!direction || candidate.direction === direction)) || null;
  }

  function normalizeConfig(type, config = {}) {
    const item = definition(type);
    if (!item) return {};
    const input = config && typeof config === 'object' ? config : {};
    if (item.dynamicPorts === 'subcircuit') {
      return {
        definitionId: String(input.definitionId || ''),
        revision: Math.max(1, Math.round(Number(input.revision) || 1)),
      };
    }
    const result = {};
    item.configFields.forEach((field) => {
      result[field.key] = normalizeField(field, input[field.key]);
    });
    return result;
  }

  function createNode(type, overrides = {}) {
    const item = definition(type);
    if (!item) return null;
    return {
      type: item.type,
      label: String(overrides.label || item.defaultLabel || item.label || item.type),
      config: normalizeConfig(item.type, overrides.config),
      statePolicy: item.stateful && overrides.statePolicy === 'persist' ? 'persist' : 'reset',
      ...((item.stateful && overrides.statePolicy === 'persist' || item.dynamicPorts === 'subcircuit') && overrides.savedState
        ? { savedState: clone(overrides.savedState) } : {}),
    };
  }

  function compatiblePorts(fromNode, fromPortId, toNode, toPortId) {
    const fromPort = port(fromNode, fromPortId, 'output');
    const toPort = port(toNode, toPortId, 'input');
    if (!fromPort || !toPort || fromPort.channel !== toPort.channel) return false;
    if (fromPort.channel === 'event') return true;
    if (fromPort.types.includes('any') || toPort.types.includes('any')) return true;
    return fromPort.types.some((type) => toPort.types.includes(type));
  }

  return Object.freeze({
    version: 3,
    categories,
    definitions: () => Array.from(byType.values()),
    definition,
    portsFor,
    port,
    normalizeConfig,
    normalizeTypedValue,
    createNode,
    compatiblePorts,
    setSubcircuitCatalog(catalog) { subcircuitCatalog = catalog || null; },
    subcircuitCatalog: () => subcircuitCatalog,
  });
}

let registryPromise = null;

export function loadResearchRegistry() {
  if (!registryPromise) {
    registryPromise = fetch(new URL('./research-node-definitions.json', import.meta.url))
      .then((response) => {
        if (!response.ok) throw new Error('无法读取研究节点注册表');
        return response.json();
      })
      .then(createResearchRegistry);
  }
  return registryPromise;
}

export { normalizeTypedValue };
