// 笔记工作区快捷键注册表。只管理本机偏好，不接触 Markdown 或后端数据。
(function () {
  'use strict';

  const STORAGE_KEY = 'canvas:noteShortcuts:v1';
  const COMMANDS = Object.freeze([
    { id: 'save', zh: '保存当前笔记', en: 'Save current note', defaults: ['Mod-s'] },
    { id: 'bold', zh: '加粗', en: 'Bold', defaults: ['Mod-b'] },
    { id: 'italic', zh: '斜体', en: 'Italic', defaults: ['Mod-i'] },
    { id: 'link', zh: '插入链接', en: 'Insert link', defaults: ['Mod-k'] },
    { id: 'inline-code', zh: '行内代码', en: 'Inline code', defaults: ['Mod-`'] },
    { id: 'code-block', zh: '代码块', en: 'Code block', defaults: ['Mod-Shift-k'] },
  ].map((command) => Object.freeze(command)));
  const COMMAND_INDEX = new Map(COMMANDS.map((command) => [command.id, command]));
  const MODIFIER_ORDER = Object.freeze(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']);
  const MODIFIERS = new Set(MODIFIER_ORDER);
  const MODIFIER_KEYS = new Set(['Control', 'Ctrl', 'Meta', 'OS', 'Alt', 'AltGraph', 'Shift']);
  const KEY_ALIASES = Object.freeze({
    Esc: 'Escape', ' ': 'Space', Spacebar: 'Space', Del: 'Delete',
    Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown',
  });
  const DISPLAY_KEYS = Object.freeze({
    Escape: 'Esc', Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End',
    PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert',
  });
  const RESERVED = Object.freeze([
    { id: 'new-note', zh: '新建笔记', en: 'New note', bindings: ['Mod-n'] },
    { id: 'new-tab', zh: '新建标签页', en: 'New tab', bindings: ['Mod-t'] },
    { id: 'close-tab', zh: '关闭当前标签页', en: 'Close current tab', bindings: ['Mod-w'] },
    { id: 'next-tab', zh: '切换标签页', en: 'Switch tabs', bindings: ['Mod-Tab', 'Mod-Shift-Tab'] },
    { id: 'rename', zh: '重命名', en: 'Rename', bindings: ['F2'] },
    { id: 'select-tab', zh: '按编号切换标签页', en: 'Select tab by number', bindings: Array.from({ length: 9 }, (_, index) => `Mod-${index + 1}`) },
    { id: 'clipboard', zh: '系统剪贴板操作', en: 'System clipboard action', bindings: ['Mod-c', 'Mod-x', 'Mod-v'] },
    { id: 'select-all', zh: '全选', en: 'Select all', bindings: ['Mod-a'] },
    { id: 'undo', zh: '撤销', en: 'Undo', bindings: ['Mod-z'] },
    { id: 'redo', zh: '重做', en: 'Redo', bindings: ['Mod-y', 'Mod-Shift-z'] },
    { id: 'find', zh: '查找', en: 'Find', bindings: ['Mod-f'] },
    { id: 'reload', zh: '应用刷新', en: 'Reload application', bindings: ['Mod-r'] },
    { id: 'print', zh: '系统打印', en: 'System print', bindings: ['Mod-p'] },
  ].map((entry) => Object.freeze(entry)));

  function isMacPlatform() {
    const platform = typeof navigator !== 'undefined'
      ? String(navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || '') : '';
    return /Mac|iPhone|iPad|iPod/i.test(platform);
  }

  function normalizeKey(rawKey) {
    let key = String(rawKey == null ? '' : rawKey);
    key = KEY_ALIASES[key] || key;
    if (!key || MODIFIER_KEYS.has(key)) return '';
    if (key.length === 1 && /[A-Z]/.test(key)) key = key.toLowerCase();
    if (/^f(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
    return key;
  }

  function canonicalModifier(rawModifier) {
    const value = String(rawModifier || '').toLowerCase();
    if (value === 'mod') return 'Mod';
    // A persisted primary modifier must remain portable; CodeMirror maps Mod
    // to Ctrl on Windows/Linux and Command on macOS.
    if (value === 'ctrl' || value === 'control') return 'Mod';
    if (value === 'alt' || value === 'option') return 'Alt';
    if (value === 'shift') return 'Shift';
    if (value === 'meta' || value === 'cmd' || value === 'command') return 'Mod';
    return '';
  }

  function normalizeBinding(rawBinding) {
    const source = String(rawBinding || '').trim();
    if (!source) return '';
    const parts = source.split('-');
    const modifiers = new Set();
    let index = 0;
    while (index < parts.length) {
      const modifier = canonicalModifier(parts[index]);
      if (!modifier) break;
      modifiers.add(modifier);
      index += 1;
    }
    const key = normalizeKey(parts.slice(index).join('-'));
    if (!key) return '';
    const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
    return ordered.concat(key).join('-');
  }

  function bindingFromEvent(event) {
    if (!event) return '';
    const key = normalizeKey(event.key);
    if (!key) return '';
    const mac = isMacPlatform();
    const modifiers = [];
    if ((mac && event.metaKey) || (!mac && event.ctrlKey)) modifiers.push('Mod');
    if (event.ctrlKey && (mac || !modifiers.includes('Mod'))) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey && (!mac || !modifiers.includes('Mod'))) modifiers.push('Meta');
    return normalizeBinding(modifiers.concat(key).join('-'));
  }

  function isAllowedBinding(binding) {
    const normalized = normalizeBinding(binding);
    if (!normalized) return false;
    const parts = normalized.split('-');
    const key = parts[parts.length - 1];
    const hasCommandModifier = parts.slice(0, -1).some((part) => part === 'Mod' || part === 'Ctrl' || part === 'Alt' || part === 'Meta');
    return hasCommandModifier || /^F(?:[1-9]|1[0-2])$/.test(key);
  }

  function defaultBindings() {
    return Object.fromEntries(COMMANDS.map((command) => [command.id, command.defaults.slice()]));
  }

  function cloneBindings(bindings) {
    const defaults = defaultBindings();
    COMMANDS.forEach((command) => {
      if (!bindings || !Array.isArray(bindings[command.id])) return;
      defaults[command.id] = bindings[command.id].map(normalizeBinding).filter(Boolean);
    });
    return defaults;
  }

  function sameBindings(left, right) {
    return left.length === right.length && left.every((binding, index) => binding === right[index]);
  }

  function conflictFor(binding, commandId, bindings) {
    const normalized = normalizeBinding(binding);
    if (!normalized) return null;
    const active = cloneBindings(bindings);
    for (const command of COMMANDS) {
      if (command.id === commandId) continue;
      if (active[command.id].includes(normalized)) return { type: 'command', id: command.id, command };
    }
    for (const entry of RESERVED) {
      if (entry.bindings.some((item) => normalizeBinding(item) === normalized)) {
        return { type: 'reserved', id: entry.id, command: entry };
      }
    }
    return null;
  }

  function sanitizeStored(raw) {
    const defaults = defaultBindings();
    if (!raw || raw.version !== 1 || !raw.commands || typeof raw.commands !== 'object') return defaults;
    const next = defaultBindings();
    let invalid = false;
    COMMANDS.forEach((command) => {
      if (!Object.prototype.hasOwnProperty.call(raw.commands, command.id)) return;
      const stored = raw.commands[command.id];
      if (!Array.isArray(stored)) { invalid = true; return; }
      const normalized = [];
      stored.forEach((binding) => {
        const value = normalizeBinding(binding);
        if (!value || !isAllowedBinding(value)) { invalid = true; return; }
        if (!normalized.includes(value)) normalized.push(value);
      });
      if (!invalid || stored.length === 0 || normalized.length) next[command.id] = normalized;
    });
    if (invalid) return defaults;
    for (const command of COMMANDS) {
      const seen = new Set();
      for (const binding of next[command.id]) {
        if (seen.has(binding) || conflictFor(binding, command.id, next)) return defaults;
        seen.add(binding);
      }
    }
    return next;
  }

  function load(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) return defaultBindings();
    try { return sanitizeStored(JSON.parse(target.getItem(STORAGE_KEY) || 'null')); }
    catch (error) { return defaultBindings(); }
  }

  function save(bindings, storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const normalized = cloneBindings(bindings);
    if (!target) return normalized;
    const commands = {};
    COMMANDS.forEach((command) => {
      if (!sameBindings(normalized[command.id], command.defaults)) commands[command.id] = normalized[command.id];
    });
    try {
      if (Object.keys(commands).length) target.setItem(STORAGE_KEY, JSON.stringify({ version: 1, commands }));
      else target.removeItem(STORAGE_KEY);
    } catch (error) {}
    return normalized;
  }

  function reset(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    try { if (target) target.removeItem(STORAGE_KEY); } catch (error) {}
    return defaultBindings();
  }

  function displayBinding(binding, mac) {
    const normalized = normalizeBinding(binding);
    if (!normalized) return '';
    const parts = normalized.split('-');
    const key = parts.pop();
    const useMac = typeof mac === 'boolean' ? mac : isMacPlatform();
    const labels = parts.map((part) => {
      if (part === 'Mod') return useMac ? '⌘' : 'Ctrl';
      if (part === 'Meta') return useMac ? '⌘' : 'Meta';
      if (part === 'Ctrl') return useMac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return useMac ? '⌥' : 'Alt';
      if (part === 'Shift') return useMac ? '⇧' : 'Shift';
      return part;
    });
    labels.push(DISPLAY_KEYS[key] || (key.length === 1 ? key.toUpperCase() : key));
    return labels.join(useMac ? '' : ' + ');
  }

  window.RelatumNoteShortcuts = Object.freeze({
    STORAGE_KEY, COMMANDS, RESERVED,
    normalizeBinding, bindingFromEvent, isAllowedBinding, defaultBindings, cloneBindings,
    conflictFor, load, save, reset, displayBinding, isMacPlatform,
  });
})();
