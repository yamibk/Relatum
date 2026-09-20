export const RESEARCH_VALUE_TYPES = Object.freeze(['number', 'boolean', 'string', 'time', 'bits']);

export function bitsBigInt(value) {
  if (!value || value.type !== 'bits') return null;
  try { return BigInt(String(value.value)); } catch (_error) { return null; }
}

export function bitsValue(width, value) {
  width = Math.min(64, Math.max(1, Math.round(Number(width) || 1)));
  let number = 0n;
  try { number = BigInt(value); } catch (_error) { number = 0n; }
  const mask = (1n << BigInt(width)) - 1n;
  return { type: 'bits', width, value: '0x' + (number & mask).toString(16) };
}

export function copyResearchValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'bits') return bitsValue(value.width, value.value);
  if (value.type === 'number' || value.type === 'time') {
    return Number.isFinite(Number(value.value)) ? { type: value.type, value: Number(value.value) } : null;
  }
  if (value.type === 'boolean') return { type: 'boolean', value: value.value === true };
  if (value.type === 'string') return { type: 'string', value: String(value.value == null ? '' : value.value) };
  return null;
}

export function sameResearchValue(left, right) {
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === 'bits') return left.width === right.width && bitsBigInt(left) === bitsBigInt(right);
  return Object.is(left.value, right.value);
}

export function truthyResearchValue(value) {
  if (!value) return false;
  if (value.type === 'boolean') return value.value;
  if (value.type === 'bits' && value.width === 1) return bitsBigInt(value) === 1n;
  return false;
}

export function formatResearchValue(value) {
  if (!value) return '';
  if (value.type === 'bits') {
    const digits = Math.max(1, Math.ceil(value.width / 4));
    return String(value.value).replace(/^0x/i, '').padStart(digits, '0').toUpperCase() + ` · ${value.width}b`;
  }
  if (value.type === 'boolean') return value.value ? 'true' : 'false';
  if (value.type === 'time') {
    const date = new Date(value.value);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : '--:--:--';
  }
  return String(value.value == null ? '' : value.value);
}
