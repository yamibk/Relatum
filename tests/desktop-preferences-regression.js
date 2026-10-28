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
  const system = JSON.stringify({ animations: false, prefetch: false, cache: 'small', renderScale: .75 });
  const layout = JSON.stringify({ order: ['career', 'notes', 'canvas', 'research'], hidden: ['notes', 'canvas', 'research', 'career'] });
  first.localStorage.setItem('canvas:workspaceLayout:v1', layout);
  first.localStorage.setItem('canvas:noteSystem:v1', system);
  const globalSystem = JSON.stringify({ preload: false, dailyRetention: 'session' });
  first.localStorage.setItem('canvas:globalSystem:v1', globalSystem);
  assert(await first.window.RelatumDesktopPreferences.flush());
  assert.equal(persisted['canvas:startTheme'], 'light');
  assert.equal(persisted['canvas:noteSystem:v1'], system);
  assert.equal(persisted['canvas:globalSystem:v1'], globalSystem);
  assert.equal(persisted['canvas:workspaceLayout:v1'], layout);
  const layoutRestored = context({ ...seed, launchId: 'layout-restored', values: { 'canvas:workspaceLayout:v1': layout } }, {}, api);
  assert.equal(layoutRestored.localStorage.getItem('canvas:workspaceLayout:v1'), layout, 'workspace order and all-hidden selection survive a new desktop origin');
  const systemRestored = context({ ...seed, launchId: 'system-restored', values: { 'canvas:noteSystem:v1': system } }, {}, api);
  assert.equal(systemRestored.localStorage.getItem('canvas:noteSystem:v1'), system, 'system policy survives a new desktop origin');
  const globalRestored = context({ ...seed, launchId: 'global-restored', values: { 'canvas:globalSystem:v1': globalSystem } }, {}, api);
  assert.equal(globalRestored.localStorage.getItem('canvas:globalSystem:v1'), globalSystem, 'global resource policy survives a new desktop origin');
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
  // Restored snapshots never count as deliberate language choices.
  const languageCalls = [];
  let languageFail = false, releaseFailure;
  const languageApi = {
    async update_window_preferences(delta, language) {
      if (languageFail) {
        await new Promise(resolve => { releaseFailure = resolve; });
        throw Error('disk unavailable');
      }
      languageCalls.push({ delta, language });
    },
    async flush_window_preferences() {}
  };
  const languages = context({ ...seed, values: { 'canvas:toolbarLanguage': 'en' } }, {}, languageApi);
  assert(await languages.window.RelatumDesktopPreferences.flush());
  assert(languageCalls.every(call => call.language === null));
  languages.localStorage.setItem('canvas:toolbarLanguage', 'en');
  assert(await languages.window.RelatumDesktopPreferences.flush());
  assert.equal(languageCalls.at(-1).language, 'en', 'same stored value still represents a deliberate choice');
  const iframe = context(seed, {}, null, languages.window);
  iframe.localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  assert(await iframe.window.RelatumDesktopPreferences.flush());
  assert.equal(languageCalls.at(-1).language, 'zh-CN');
  languageFail = true;
  languages.localStorage.setItem('canvas:toolbarLanguage', 'en');
  await Promise.resolve(); await Promise.resolve();
  assert(releaseFailure);
  languages.localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  const failedFlush = languages.window.RelatumDesktopPreferences.flush();
  releaseFailure();
  assert.equal(await failedFlush, false);
  languageFail = false;
  assert(await languages.window.RelatumDesktopPreferences.flush());
  assert.equal(languageCalls.at(-1).language, 'zh-CN', 'retry retains the newer choice');
  languages.localStorage.removeItem('canvas:toolbarLanguage');
  assert(await languages.window.RelatumDesktopPreferences.flush());
  assert.equal(languageCalls.at(-1).language, null, 'deleting a preference is not a language selection');
  const delayed = context(seed);
  delayed.localStorage.setItem('canvas:toolbarLanguage', 'en');
  delayed.window.pywebview = { api: languageApi };
  delayed.listeners.pywebviewready();
  assert(await delayed.window.RelatumDesktopPreferences.flush());
  assert.equal(languageCalls.at(-1).language, 'en', 'a choice before bridge readiness is retained');
  console.log('desktop preferences regression: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
