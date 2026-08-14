// Relatum 便签统一色库：速记墙、起步页跨页便签与画布便签共用。
(function (root) {
  'use strict';

  const STORAGE_KEY = 'canvas:stickyPalette:v1';
  const SWATCHES = [
    { key: 'pink', zh: '粉', en: 'Pink', family: 'rose', hex: '#ffbdd6' },
    { key: 'blue', zh: '蓝', en: 'Blue', family: 'blue', hex: '#b4d4ff' },
    { key: 'purple', zh: '紫', en: 'Purple', family: 'violet', hex: '#d0bcff' },
    { key: 'green', zh: '绿', en: 'Green', family: 'leaf', hex: '#b2e9cd' },
    { key: 'yellow', zh: '黄', en: 'Yellow', family: 'amber', hex: '#ffe69e' },
    { key: 'orange', zh: '橙', en: 'Orange', family: 'amber', hex: '#ffc7a0' },
    { key: 'teal', zh: '青绿', en: 'Teal', family: 'aqua', hex: '#a9e6d8' },
    { key: 'sky', zh: '天蓝', en: 'Sky Blue', family: 'blue', hex: '#b6e2f7' },
    { key: 'lavender', zh: '薰衣草', en: 'Lavender', family: 'violet', hex: '#c8c4f6' },
    { key: 'coral', zh: '珊瑚', en: 'Coral', family: 'rose', hex: '#ffc1b4' },
    { key: 'lime', zh: '青柠', en: 'Lime', family: 'leaf', hex: '#d9eca8' },
    { key: 'rose', zh: '玫瑰', en: 'Rose', family: 'rose', hex: '#ffb1c0' },
    { key: 'mint', zh: '薄荷', en: 'Mint', family: 'aqua', hex: '#bdeccf' },
    { key: 'apricot', zh: '杏色', en: 'Apricot', family: 'amber', hex: '#ffd6a3' },
    { key: 'paper', zh: '纸白', en: 'Paper', family: 'neutral', hex: '#ece5d8' },
    { key: 'stone', zh: '石灰', en: 'Stone', family: 'neutral', hex: '#d0d4cf' },
    { key: 'sand', zh: '沙褐', en: 'Sand', family: 'amber', hex: '#dcbf93' },
    { key: 'sage', zh: '鼠尾草', en: 'Sage', family: 'leaf', hex: '#c6d8af' },
    { key: 'indigo', zh: '靛蓝', en: 'Indigo', family: 'blue', hex: '#b9c4ec' },
    { key: 'plum', zh: '灰梅', en: 'Plum', family: 'violet', hex: '#d8bad3' },
  ].map((item) => Object.freeze(item));
  const KEYS = SWATCHES.map((item) => item.key);
  const KEY_SET = new Set(KEYS);
  const BY_KEY = new Map(SWATCHES.map((item) => [item.key, item]));
  const BY_HEX = new Map(SWATCHES.map((item) => [item.hex.toLowerCase(), item]));

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function normalizeDisabled(value) {
    const source = value && typeof value === 'object' && Array.isArray(value.disabled)
      ? value.disabled : [];
    const seen = new Set();
    source.forEach((key) => {
      if (typeof key === 'string' && KEY_SET.has(key)) seen.add(key);
    });
    return seen.size >= KEYS.length ? [] : KEYS.filter((key) => seen.has(key));
  }

  function readDisabled() {
    const store = storage();
    if (!store) return [];
    try {
      return normalizeDisabled(JSON.parse(store.getItem(STORAGE_KEY) || 'null'));
    } catch (e) {
      return [];
    }
  }

  function getEnabledKeys() {
    const disabled = new Set(readDisabled());
    const enabled = KEYS.filter((key) => !disabled.has(key));
    return enabled.length ? enabled : KEYS.slice();
  }

  function dispatchChange(enabledKeys) {
    if (!root.dispatchEvent || typeof root.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('relatum:sticky-palette-change', {
      detail: { enabledKeys: enabledKeys.slice() },
    }));
  }

  function setEnabledKeys(value) {
    const requested = new Set(Array.isArray(value) ? value.filter((key) => KEY_SET.has(key)) : []);
    const enabled = requested.size ? KEYS.filter((key) => requested.has(key)) : KEYS.slice();
    const disabled = KEYS.filter((key) => !requested.has(key));
    const store = storage();
    if (store) {
      try {
        if (!disabled.length || !requested.size) store.removeItem(STORAGE_KEY);
        else store.setItem(STORAGE_KEY, JSON.stringify({ version: 1, disabled }));
      } catch (e) {}
    }
    dispatchChange(enabled);
    return enabled;
  }

  function reset() {
    const store = storage();
    if (store) {
      try { store.removeItem(STORAGE_KEY); } catch (e) {}
    }
    dispatchChange(KEYS);
    return KEYS.slice();
  }

  function normalizedEnabled(value) {
    if (!Array.isArray(value)) return getEnabledKeys();
    const requested = new Set(value.filter((key) => KEY_SET.has(key)));
    const enabled = KEYS.filter((key) => requested.has(key));
    return enabled.length ? enabled : KEYS.slice();
  }

  function pick(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const enabled = normalizedEnabled(opts.enabledKeys).map((key) => BY_KEY.get(key));
    const familyMap = new Map();
    enabled.forEach((item) => {
      if (!familyMap.has(item.family)) familyMap.set(item.family, []);
      familyMap.get(item.family).push(item);
    });
    let families = Array.from(familyMap.keys());
    if (families.length > 1 && typeof opts.excludeFamily === 'string') {
      families = families.filter((family) => family !== opts.excludeFamily);
    }
    const family = families[Math.min(families.length - 1, Math.floor(random() * families.length))];
    let candidates = (familyMap.get(family) || enabled).slice();
    if (candidates.length > 1 && typeof opts.excludeKey === 'string') {
      candidates = candidates.filter((item) => item.key !== opts.excludeKey);
    }
    return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
      || enabled[0] || SWATCHES[4];
  }

  const api = Object.freeze({
    storageKey: STORAGE_KEY,
    swatches: Object.freeze(SWATCHES.slice()),
    keys: Object.freeze(KEYS.slice()),
    byKey(key) { return BY_KEY.get(key) || null; },
    keyForHex(value) {
      const item = BY_HEX.get(String(value || '').trim().toLowerCase());
      return item ? item.key : '';
    },
    getEnabledKeys,
    setEnabledKeys,
    reset,
    pick,
  });

  root.RelatumStickyPalette = api;
  if (root.addEventListener) {
    root.addEventListener('storage', (event) => {
      if (event && event.key === STORAGE_KEY) dispatchChange(getEnabledKeys());
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
