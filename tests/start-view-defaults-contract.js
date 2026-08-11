const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const focus = fs.readFileSync(path.join(root, 'assets', 'focus.js'), 'utf8');
const study = fs.readFileSync(path.join(root, 'assets', 'study.js'), 'utf8');

assert(focus.includes("localStorage.getItem(VIEW_MODE_KEY) === 'timer' ? 'timer' : 'daily'")
  && focus.includes("catch (e) { return 'daily'; }"),
  'Focus must default to daily tasks when no valid saved view preference exists');
assert(focus.includes("localStorage.setItem(VIEW_MODE_KEY, viewMode)"),
  'Focus view changes must continue to persist the explicit user preference');
assert(focus.includes("const preferred = opts.forceTimer || sessionLocksView() ? 'timer' : readViewMode();")
  && focus.includes("commitViewMode(preferred, { persist: false, load: false, reveal: false });"),
  'forced timer entries must remain temporary and must not overwrite the daily default or saved preference');

assert(study.includes("localStorage.getItem(VIEW_MODE_KEY) === 'progress' ? 'progress' : 'list'")
  && study.includes("catch (e) { return 'list'; }"),
  'Study must default to the compact list when no valid saved view preference exists');
assert(study.includes("localStorage.setItem(VIEW_MODE_KEY, next)"),
  'Study view changes must continue to persist the explicit user preference');
assert(study.includes("setViewMode(viewMode === 'list' ? 'progress' : 'list', true);"),
  'the Study spine must continue to toggle between list and progress views');

console.log('start view defaults contract passed');
