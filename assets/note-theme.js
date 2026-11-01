// Built-in note styles. The shared light/dark preference remains owned by the shell.
(function () {
  'use strict';
  const KEY = 'canvas:noteTheme:v1';
  const APPLE_SELECTION_KEY = 'canvas:noteAppleSelection:v1';
  const themes = Object.freeze([
    Object.freeze({ id: 'default', label: Object.freeze(['默认', 'Default']) }),
    Object.freeze({ id: 'claude', label: Object.freeze(['Claude', 'Claude']) }),
    Object.freeze({ id: 'sky', label: Object.freeze(['Sky', 'Sky']) }),
    Object.freeze({ id: 'apple', label: Object.freeze(['Apple', 'Apple']) }),
  ]);
  const normalize = id => themes.some(theme => theme.id === id) ? id : 'default';
  let current = 'default';
  try { current = normalize(localStorage.getItem(KEY)); } catch (_) {}
  document.documentElement.dataset.noteTheme = current;
  let appleSelection = 'blue';
  try { if (localStorage.getItem(APPLE_SELECTION_KEY) === 'gray') appleSelection = 'gray'; } catch (_) {}
  document.documentElement.dataset.noteAppleSelection = appleSelection;
  function commitAppleSelection(next) {
    if (next === appleSelection) return true;
    const detail = Object.freeze({ previous: appleSelection, current: next });
    appleSelection = next;
    document.documentElement.dataset.noteAppleSelection = next;
    window.dispatchEvent(new CustomEvent('relatum:note-apple-selection', { detail }));
    return true;
  }
  function commit(next) {
    if (next === current) return true;
    const detail = Object.freeze({ previous: current, current: next });
    window.dispatchEvent(new CustomEvent('relatum:note-theme-beforechange', { detail }));
    current = next;
    document.documentElement.dataset.noteTheme = next;
    window.dispatchEvent(new CustomEvent('relatum:note-theme', { detail }));
    return true;
  }
  window.RelatumNoteTheme = Object.freeze({
    list: () => themes,
    read: () => current,
    readAppleSelection: () => appleSelection,
    applyAppleSelection(value, { persist = true } = {}) {
      if (value !== 'blue' && value !== 'gray') return false;
      if (persist) {
        try { if (localStorage.getItem(APPLE_SELECTION_KEY) !== value) localStorage.setItem(APPLE_SELECTION_KEY, value); }
        catch (_) { return false; }
      }
      return commitAppleSelection(value);
    },
    resetAppleSelection() {
      try { localStorage.removeItem(APPLE_SELECTION_KEY); } catch (_) { return false; }
      return commitAppleSelection('blue');
    },
    apply(id, { persist = true } = {}) {
      if (!themes.some(theme => theme.id === id)) return false;
      if (persist) {
        try { if (localStorage.getItem(KEY) !== id) localStorage.setItem(KEY, id); }
        catch (_) { return false; }
      }
      return commit(id);
    },
    reset() {
      try { localStorage.removeItem(KEY); } catch (_) { return false; }
      return commit('default');
    },
  });
})();
