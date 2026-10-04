// Install before page scripts, including the same-origin research iframe.
(function () {
  'use strict';
  const seed = window.RelatumDesktopPreferencesSeed;
  if (!seed) return;
  const managed = key => typeof key === 'string' && /^(canvas:|research:)/.test(key);
  const storage = window.localStorage;
  const proto = Storage.prototype;
  const set = proto.setItem, remove = proto.removeItem, clear = proto.clear;
  let owner;
  try { if (window.parent !== window) owner = window.parent.RelatumDesktopPreferences; } catch (_) {}
  if (!owner) {
    const marker = 'relatum:desktopPreferencesSession';
    const identity = seed.sessionKey + ':' + seed.launchId;
    if (storage.getItem(marker) !== identity) {
      if (seed.initialized) {
        Object.keys(storage).filter(managed).forEach(key => remove.call(storage, key));
        Object.entries(seed.values).forEach(([key, value]) => { if (managed(key) && typeof value === 'string') set.call(storage, key, value); });
      }
      set.call(storage, marker, identity);
    }
    let pending = {}, chain = Promise.resolve(), failed = false, sending = false;
    const ready = () => window.pywebview && window.pywebview.api && typeof window.pywebview.api.update_window_preferences === 'function';
    function drain() {
      if (sending || !ready() || !Object.keys(pending).length) return chain;
      const delta = pending; pending = {};
      sending = true;
      chain = Promise.resolve().then(() => window.pywebview.api.update_window_preferences(delta)).then(() => { failed = false; }, () => {
        pending = Object.assign({}, delta, pending); failed = true;
      }).then(() => { sending = false; if (!failed) drain(); });
      return chain;
    }
    owner = {
      update(delta) { Object.assign(pending, delta); drain(); },
      async flush() {
        while (sending || Object.keys(pending).length) {
          if (!ready()) return false;
          await drain();
          if (failed) return false;
        }
        if (failed || Object.keys(pending).length) return false;
        if (ready()) { try { await window.pywebview.api.flush_window_preferences(); } catch (_) { return false; } }
        return true;
      }
    };
    window.addEventListener('pywebviewready', drain);
    // Import legacy full-mode preferences once, without altering its cache.
    const initial = {};
    Object.keys(storage).filter(managed).forEach(key => { initial[key] = storage.getItem(key); });
    owner.update(initial);
    window.addEventListener('pagehide', () => owner.flush());
  }
  window.RelatumDesktopPreferences = owner;
  proto.setItem = function (key, value) {
    set.call(this, key, value);
    if (this === storage && managed(String(key))) owner.update({ [String(key)]: String(value) });
  };
  proto.removeItem = function (key) {
    remove.call(this, key);
    if (this === storage && managed(String(key))) owner.update({ [String(key)]: null });
  };
  proto.clear = function () {
    const delta = {};
    if (this === storage) Object.keys(storage).filter(managed).forEach(key => { delta[key] = null; });
    clear.call(this);
    if (this === storage) owner.update(delta);
  };
})();
