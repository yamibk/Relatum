'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const store = fs.readFileSync(path.join(root, 'research_store.py'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets/research/research-editor.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets/research/research-canvas.js'), 'utf8');

assert(app.includes('RESEARCH_WORKSPACE_DIR = DATA / "research-workspace"'),
  'Research data must live in its own data namespace');
assert(app.includes('if parsed.path == "/api/research/workspace"')
  && app.includes('if path == "/api/research/workspace"'),
  'Research must expose isolated GET and POST routes');
assert(app.includes('ResearchWorkspaceStore(RESEARCH_WORKSPACE_DIR, atomic_json=_atomic_write_json)'),
  'Research saves must reuse the established atomic JSON writer');
assert(store.includes('workspace.backup.json') && store.includes('workspace.corrupt-')
  && store.includes('ResearchConflictError'),
  'Research persistence must keep a valid backup, quarantine corruption and reject stale revisions');
assert(store.includes('normalize_research_document(source)'),
  'the server must validate Research schema before replacing user data');
assert(editor.includes('SAVE_DELAY_MS = 350') && editor.includes('saveDirty = true')
  && editor.includes('scheduleSave()'),
  'the editor must coalesce automatic saves');
assert(!editor.includes('sessionStorage')
  && !/localStorage\.(?:setItem|getItem)\([^\n]*(?:workspace|document|pages|nodes|edges)/.test(editor),
  'Research document persistence must not fall back to browser storage');
assert(editor.includes('research:sidePanelCollapsed:v1')
  && editor.includes('research:computeDockCollapsed:v1')
  && editor.includes('research:connectionKind:v1'),
  'browser storage may only retain the explicit local interaction preferences');
assert(canvas.includes("'research:coordinatesVisible:v1'")
  && canvas.includes("'research:coordinateLabelsVisible:v1'"),
  'coordinate visibility must remain an explicit local preference outside the Research document');
assert(!editor.includes("setPersistenceStatus('正在保存…', 'saving')")
  && editor.includes("completed = true; setPersistenceStatus('')")
  && !editor.includes("setPersistenceStatus('已保存', 'saved')"),
  'normal automatic saves must stay silent while preserving exceptional status reporting');

console.log('research persistence contract passed');
