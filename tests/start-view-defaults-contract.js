const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const daily = fs.readFileSync(path.join(root, 'assets', 'daily-workspace.js'), 'utf8');
const study = fs.readFileSync(path.join(root, 'assets', 'study.js'), 'utf8');

assert(daily.indexOf('tasks: {') < daily.indexOf('calendar: {'), 'Daily defaults to its first available Tasks page');
assert(daily.includes("localStorage.setItem('daily:page:v1', id)") && daily.includes('available().includes(requested) ? requested : available()[0]'),
  'Daily restores a valid saved subpage and falls back to an enabled page');

assert(study.includes("localStorage.getItem(VIEW_MODE_KEY) === 'progress' ? 'progress' : 'list'")
  && study.includes("catch (e) { return 'list'; }"),
  'Study must default to the compact list when no valid saved view preference exists');
assert(study.includes("localStorage.setItem(VIEW_MODE_KEY, next)"),
  'Study view changes must continue to persist the explicit user preference');
assert(study.includes("setViewMode(viewMode === 'list' ? 'progress' : 'list', true);"),
  'the Study spine must continue to toggle between list and progress views');

console.log('start view defaults contract passed');
