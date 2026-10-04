'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/desktop-preferences.js'), 'utf8');
function context(seed, values = {}, api = null, parent = null) {
  class Storage {
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; }
    setItem(key, value) { this[key] = String(value); }
    removeItem(key) { delete this[key]; }
    clear() { Object.keys(this).forEach(key => delete this[key]); }
  }
  const localStorage = Object.assign(new Storage(), values), listeners = {};
  const window = { localStorage, RelatumDesktopPreferencesSeed: seed, addEventListener(name, callback) { listeners[name] = callback; } };
  window.parent = parent || window;
  if (api) window.pywebview = { api };
  const sandbox = vm.createContext({ window, Storage, Object, Promise });
  vm.runInContext(source, sandbox);
  return { window, localStorage, Storage, listeners };
}
(async () => {
  const persisted = {};
  const api = { async update_window_preferences(delta) { Object.entries(delta).forEach(([key, value]) => value === null ? delete persisted[key] : persisted[key] = value); }, async flush_window_preferences() {} };
  const seed = { sessionKey: 'notes', launchId: 'first', initialized: true, values: { 'canvas:startTheme': 'dark' } };
  const first = context(seed, { 'canvas:startTheme': 'stale', unrelated: 'keep' }, api);
  assert.equal(first.localStorage.getItem('canvas:startTheme'), 'dark');
  assert.equal(first.localStorage.getItem('unrelated'), 'keep');
  first.localStorage.setItem('canvas:startTheme', 'light');
  first.localStorage.setItem('research:panSpeed:v1', '180');
  assert(await first.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['canvas:startTheme'], 'light');
  const child = context(seed, {}, null, first.window);
  child.localStorage.setItem('research:coordinatesVisible:v1', '1');
  assert(await child.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['research:coordinatesVisible:v1'], '1');
  // Returning to a previously visited origin on a new launch must replace stale keys.
  const second = context({ ...seed, launchId: 'second', values: { 'canvas:startTheme': 'dark' } }, { ...first.localStorage }, api);
  assert.equal(second.localStorage.getItem('canvas:startTheme'), 'dark');
  second.localStorage.removeItem('canvas:startTheme');
  assert(await second.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['canvas:startTheme'], undefined);
  const legacy = context({ sessionKey: 'full', launchId: 'legacy', initialized: false, values: {} }, { 'canvas:noteFocusMode:v1': '1' }, api);
  assert(await legacy.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['canvas:noteFocusMode:v1'], '1');
  let fail = true;
  const retry = context(seed, {}, { ...api, async update_window_preferences(delta) { if (fail) throw Error('disk unavailable'); await api.update_window_preferences(delta); } });
  retry.localStorage.setItem('canvas:startTheme', 'light');
  assert.equal(await retry.window.RelatumDesktopPreferences.flush(), false);
  fail = false;
  retry.localStorage.setItem('canvas:startTheme', 'dark');
  assert(await retry.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['canvas:startTheme'], 'dark');
  console.log('desktop preferences regression: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
