// Offline color presets and the default chart appearance for Notes.
(function () {
  'use strict';

  const KEY = 'canvas:noteChartPalette:v1';
  const CHANGED = 'relatum:note-chart-palette';
  const classicHues = [
    ['blue', ['湖蓝', 'Lake blue'], '#397ab9', '#84b8ec'],
    ['coral', ['珊瑚', 'Coral'], '#be624d', '#f29983'],
    ['mint', ['薄荷', 'Mint'], '#348a73', '#78cfb2'],
    ['iris', ['鸢尾紫', 'Iris'], '#8661b1', '#bda0e6'],
    ['amber', ['琥珀', 'Amber'], '#9d7725', '#e4c36d'],
    ['rose', ['玫瑰', 'Rose'], '#b65787', '#e995bd'],
    ['teal', ['青绿', 'Teal'], '#3e8698', '#79c6d3'],
    ['olive', ['橄榄', 'Olive'], '#73843f', '#b7c77a'],
  ];
  const hues = [
    ...classicHues,
    ['sky', ['天蓝', 'Sky blue'], '#428fcb', '#77c6f4'],
    ['apricot', ['杏橙', 'Apricot'], '#d28049', '#f3b280'],
    ['lemon', ['柠檬黄', 'Lemon'], '#ba971b', '#e9d26b'],
    ['leaf', ['草绿', 'Leaf green'], '#539445', '#8ecb79'],
  ];
  function mix(color, toward, amount) {
    if (!amount) return color;
    return '#' + color.slice(1).match(/../g).map(channel => {
      const from = parseInt(channel, 16);
      return Math.round(from + (toward - from) * amount).toString(16).padStart(2, '0');
    }).join('');
  }
  const tones = [
    ['light', ['浅色', 'Light'], ['浅', 'Light '], .34, .22],
    ['medium', ['中间色', 'Medium'], ['中调', 'Medium '], .20, .10],
    ['deep', ['深色', 'Deep'], ['', ''], 0, 0],
  ];
  const swatches = new Map();
  const swatchGroups = tones.map(([tone, label, prefix, lightMix, darkMix]) => {
    const ids = hues.map(([hue, name, light, dark]) => {
      const id = tone === 'deep' ? hue : `${hue}-${tone}`;
      swatches.set(id, { tone, light: mix(light, 255, lightMix), dark: mix(dark, 255, darkMix) });
      return [id, [prefix[0] + name[0], prefix[1] + name[1]]];
    });
    return { tone, label, swatches: ids };
  });
  const presets = {
    vivid: { label: ['鲜艳', 'Vivid'],
      light: ['#287ceb', '#ed674d', '#17a17a', '#9858d7', '#ec9a21', '#e05091', '#149fb4', '#70a32a', '#559bed', '#f68135', '#ccae13', '#5456c8'],
      dark: ['#6ea9ff', '#ff896f', '#45d9a6', '#bf86ff', '#ffc05c', '#ff7db6', '#4ed4e7', '#a0d757', '#89c4ff', '#ffab68', '#f2d34b', '#9595ff'] },
    soft: { label: ['柔和', 'Soft'],
      light: ['#699ad1', '#df8c7b', '#6eb8a2', '#aa8ccd', '#d5a554', '#ce8dae', '#73aeba', '#a1b371', '#83afd9', '#e7a276', '#d2ba64', '#959bce'],
      dark: ['#8fb8e4', '#eea192', '#89cbb6', '#bea5dd', '#e2bc76', '#dfa5c0', '#8bc3ce', '#b7c889', '#9cc7eb', '#efb795', '#e0ce85', '#aeb4e0'] },
    deep: { label: ['深色', 'Deep'],
      light: classicHues.map(([, , light]) => light), dark: classicHues.map(([, , , dark]) => dark) },
    contrast: { label: ['高对比', 'High contrast'],
      light: ['#0056a6', '#b53916', '#007758', '#6d339c', '#986100', '#a62367', '#007383', '#506b00', '#3a6297', '#894527', '#796700', '#3b377d'],
      dark: ['#65b7ff', '#ff8c69', '#59e0ac', '#d5a2ff', '#ffd15a', '#ff83b9', '#56dce8', '#bddf59', '#a3c9ff', '#ffc1a0', '#f0e775', '#a5a0ff'] },
  };
  const DEFAULT = 'soft';
  const valid = id => Object.hasOwn(presets, id);
  const normalize = id => id === 'fresh' ? 'soft' : id === 'earth' ? 'deep' : valid(id) ? id : undefined;
  let current = DEFAULT;
  try { current = normalize(localStorage.getItem(KEY)) || DEFAULT; } catch (_) {}

  function publish(id) {
    if (current === id) return true;
    current = id;
    window.dispatchEvent(new Event(CHANGED));
    return true;
  }

  function colors(id, dark) { return presets[normalize(id) || current][dark ? 'dark' : 'light'].slice(); }

  function swatchColor(id, dark) {
    return swatches.get(id)?.[dark ? 'dark' : 'light'];
  }

  function categoryColor(palette, dark, column, key, swatch) {
    const explicit = swatchColor(swatch, dark);
    if (explicit) return explicit;
    const identity = `${column}\0${key}`;
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
    const preset = normalize(palette) || current;
    const colors = presets[preset][dark ? 'dark' : 'light'];
    const slot = (hash >>> 0) % 24;
    const variant = Math.floor(slot / colors.length);
    return mix(colors[slot % colors.length], dark || preset === 'soft' ? 255 : 0, variant * (preset === 'soft' ? .08 : .12));
  }

  function dateFormatter(bucket, english) {
    return new Intl.DateTimeFormat(english ? 'en' : 'zh-CN', bucket === 'month'
      ? { timeZone: 'UTC', year: 'numeric', month: 'short' }
      : { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  }

  function categoryLabel(point, type, english) {
    if (type !== 'checkbox') return point.label;
    return point.key === '1' ? (english ? 'Checked' : '已勾选') : (english ? 'Unchecked' : '未勾选');
  }

  window.addEventListener('storage', event => {
    if (event.storageArea === window.localStorage && (event.key === KEY || event.key === null)) publish(normalize(event.newValue) || DEFAULT);
  });
  window.RelatumNoteChartPalette = Object.freeze({
    changed: CHANGED,
    presets: Object.entries(presets).map(([id, preset]) => [id, preset.label]), swatchGroups,
    read: () => current, colors, swatchColor, swatchTone: id => swatches.get(id)?.tone, categoryColor, categoryLabel, dateFormatter,
    effective: id => normalize(id) || current,
    apply(id) {
      if (!valid(id)) return false;
      try { if (localStorage.getItem(KEY) !== id) localStorage.setItem(KEY, id); }
      catch (_) { return false; }
      return publish(id);
    },
    reset() {
      try { localStorage.removeItem(KEY); } catch (_) { return false; }
      return publish(DEFAULT);
    },
  });
})();
