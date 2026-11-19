// Offline color presets and the default chart appearance for Notes.
(function () {
  'use strict';

  const KEY = 'canvas:noteChartPalette:v1';
  const CHANGED = 'relatum:note-chart-palette';
  const presets = {
    fresh: { label: ['清透', 'Fresh'],
      light: ['#397ab9', '#be624d', '#348a73', '#8661b1', '#9d7725', '#b65787', '#3e8698', '#73843f'],
      dark: ['#84b8ec', '#f29983', '#78cfb2', '#bda0e6', '#e4c36d', '#e995bd', '#79c6d3', '#b7c77a'] },
    earth: { label: ['沉稳', 'Earth'],
      light: ['#476e62', '#a66043', '#61758f', '#9a793a', '#806887', '#567a85', '#a75c65', '#737b45'],
      dark: ['#8abcaa', '#e49b78', '#97b1d5', '#d6b361', '#bd9bc7', '#83bbc7', '#df929d', '#b3be76'] },
    contrast: { label: ['高对比', 'High contrast'],
      light: ['#0059a8', '#9e3500', '#11734e', '#6c3896', '#885800', '#982657', '#00697e', '#536513'],
      dark: ['#70c8ff', '#ffa86c', '#65e1ae', '#cda2ff', '#ffe078', '#ff93c2', '#70daed', '#c8e76f'] },
  };
  const swatches = [
    ['blue', ['湖蓝', 'Lake blue']], ['coral', ['珊瑚', 'Coral']], ['mint', ['薄荷', 'Mint']], ['iris', ['鸢尾紫', 'Iris']],
    ['amber', ['琥珀', 'Amber']], ['rose', ['玫瑰', 'Rose']], ['teal', ['青绿', 'Teal']], ['olive', ['橄榄', 'Olive']],
  ];
  const valid = id => Object.hasOwn(presets, id);
  const normalize = id => valid(id) ? id : 'fresh';
  let current = 'fresh';
  try { current = normalize(localStorage.getItem(KEY)); } catch (_) {}

  function publish(id) {
    if (current === id) return true;
    current = id;
    window.dispatchEvent(new Event(CHANGED));
    return true;
  }

  function colors(id, dark) { return presets[normalize(id)][dark ? 'dark' : 'light'].slice(); }

  function swatchColor(id, dark) {
    const index = swatches.findIndex(([key]) => key === id);
    return presets.fresh[dark ? 'dark' : 'light'][index];
  }

  function categoryColor(palette, dark, column, key, swatch) {
    const explicit = swatchColor(swatch, dark);
    if (explicit) return explicit;
    const identity = `${column}\0${key}`;
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
    const slot = (hash >>> 0) % 24;
    const color = presets[normalize(palette)][dark ? 'dark' : 'light'][slot % 8];
    const amount = Math.floor(slot / 8) * .12;
    if (!amount) return color;
    const toward = dark ? 255 : 0;
    return '#' + color.slice(1).match(/../g).map(channel => {
      const from = parseInt(channel, 16);
      return Math.round(from + (toward - from) * amount).toString(16).padStart(2, '0');
    }).join('');
  }

  function categoryLabel(point, type, english) {
    if (type !== 'checkbox') return point.label;
    return point.key === '1' ? (english ? 'Checked' : '已勾选') : (english ? 'Unchecked' : '未勾选');
  }

  window.addEventListener('storage', event => {
    if (event.storageArea === window.localStorage && (event.key === KEY || event.key === null)) publish(normalize(event.newValue));
  });
  window.RelatumNoteChartPalette = Object.freeze({
    changed: CHANGED,
    presets: Object.entries(presets).map(([id, preset]) => [id, preset.label]), swatches,
    read: () => current, colors, swatchColor, categoryColor, categoryLabel,
    effective: id => valid(id) ? id : current,
    apply(id) {
      if (!valid(id)) return false;
      try { if (localStorage.getItem(KEY) !== id) localStorage.setItem(KEY, id); }
      catch (_) { return false; }
      return publish(id);
    },
    reset() {
      try { localStorage.removeItem(KEY); } catch (_) { return false; }
      return publish('fresh');
    },
  });
})();
