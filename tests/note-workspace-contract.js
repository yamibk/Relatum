'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const notes = read('assets/note-workspace.js');
const live = read('assets/note-live-editor.js');
const markdown = read('assets/markdown.js');
const mermaid = read('assets/mermaid-renderer.js');
const desktop = read('assets/desktop-shell.js');
const css = read('assets/styles.css');
const server = read('app.py');

for (const workspace of ['canvas', 'notes', 'blog']) {
  assert(html.includes(`data-start-workspace="${workspace}"`), `${workspace} workspace switch is missing`);
  assert(html.includes(`data-start-workspace-panel="${workspace}"`), `${workspace} workspace panel is missing`);
}
assert(start.includes('canvas:startWorkspace:v1'), 'last Canvas/Notes workspace must be persisted');
assert(start.includes('button[data-start-workspace]'), 'workspace binding must not match the body dataset');
assert(start.includes('note-workspace.js'), 'Notes runtime must stay lazy-loaded');
assert(start.includes('vendor/codemirror/relatum-codemirror.min.js'), 'CodeMirror must be a lazy offline vendor asset');
assert(start.includes('note-live-editor.js'), 'Live Preview engine must load before the Notes workspace adapter');
assert(start.indexOf('vendor/codemirror/relatum-codemirror.min.js') < start.indexOf('note-live-editor.js'), 'CodeMirror must load before the Live Preview engine');
assert(start.indexOf('note-live-editor.js') < start.indexOf('note-workspace.js'), 'Live Preview engine must load before the workspace adapter');
assert(start.includes('requestIdleCallback'), 'Canvas idle time must warm the Notes runtime without delaying first paint');
assert(start.includes('workspace.preload()'), 'idle warmup must include the Notes tree and current document data');
assert(notes.includes('async function preload() { return initializeWorkspace(); }'), 'Notes needs a side-effect-free preload entry point');
assert(start.includes('prefers-reduced-motion'), 'workspace transitions need reduced-motion support');
assert(html.includes("classList.add('note-boot-pending')"), 'a Notes cold boot must hide the static empty state before first paint');
assert(html.includes('noteRevealTimer') && html.includes('}, 4000);'), 'the Notes cold-boot reveal gate needs a finite fallback');
assert(notes.includes('function revealColdBoot()'), 'Notes must reveal only after its tree and current document initialize');
assert(notes.includes('const initialized = await initializeWorkspace(); revealColdBoot();'), 'the cold-boot gate must cover both the tree and active document read');
assert(start.includes("if (name !== 'notes')"), 'leaving Notes during boot must cancel the reveal gate');

for (const endpoint of [
  '/api/notes-tree', '/api/note?', '/api/note-create', '/api/note-save',
  '/api/note-links', '/api/note-move', '/api/note-trash', '/api/note-upload-image',
  '/api/note-reveal', '/api/note-reveal-assets', '/api/note-history',
  '/api/note-history-restore', '/api/note-import-begin', '/api/note-import-upload',
  '/api/note-import-commit', '/api/note-import-abort',
]) {
  assert(notes.includes(endpoint) || server.includes(endpoint), `missing Notes endpoint: ${endpoint}`);
}
assert(notes.includes('setDirty'), 'note edits must synchronize desktop dirty state');
assert(notes.includes('setBeforeCloseHandler'), 'desktop close must join the note save chain');
assert(notes.includes('在系统资源管理器中显示'), 'note/folder menus must expose File Explorer');
assert(notes.includes('SAVE_DELAY = 350'), 'note input needs the 350ms quiet autosave window');
assert(notes.includes('documentCache: new Map()'), 'recent notes need an in-memory switch cache');
assert(notes.includes('state.openingPath = liveEntry.path'), 'tree selection feedback must happen on the click frame');
assert(notes.includes('updateTreeSelection(); openNote(liveEntry.path'), 'opening a note must not wait before updating its tree row');
const openNoteSource = notes.slice(notes.indexOf('async function openNote'), notes.indexOf('async function createEntry'));
assert(!openNoteSource.includes('await flushSave'), 'note loading must not wait for the previous autosave chain');
assert(openNoteSource.includes('if (cached && !(options && options.force))'), 'cached notes must switch without another disk read');
assert(openNoteSource.includes('const loadPromise = fetchDocument(path);\n    if (!(options && options.skipSave) && previous) flushSave(previous)'), 'an uncached read must start before the previous note is flushed');
assert(notes.includes('webkitGetAsEntry'), 'external directory drops must preserve their hierarchy');
assert(notes.includes('note-tree-rename'), 'renames must use an inline tree editor');
assert(notes.includes('renameCommitPromise'), 'inline rename completion must be shared with the next tree click');
assert(notes.includes('finishInlineRename()'), 'a tree click must finish an active inline rename instead of being swallowed');
assert(!notes.includes('if (state.renamePath) return;'), 'an active inline rename must not swallow the next tree click');
assert(notes.includes('expandTreePath(result.path, true)'), 'new folders must reveal their full parent chain');
assert(notes.includes('expandTreePath(result.path, false)'), 'new notes must reveal their full parent chain');
assert(notes.includes('row.setAttribute(\'aria-expanded\''), 'folder expansion state must be exposed to UI automation and assistive tech');
assert(!notes.includes("toggle.textContent = expanded ? '⌄' : '›'"), 'folder disclosure must not depend on font glyph characters');
assert(notes.includes('function setFolderExpanded'), 'folder disclosure should update only the affected subtree');
assert(notes.includes("shell.className = 'note-tree-children-shell'"), 'folder children need a transition shell');
for (const obsolete of ['revision_conflict', '磁盘版本已变化', '加载磁盘版本', '另存为副本', '尚未打开笔记', 'note-save-state']) {
  assert(!notes.includes(obsolete) && !html.includes(obsolete), `obsolete note state remains: ${obsolete}`);
}
assert(html.includes('note-live-editor-host') && html.includes('note-editor-fallback'), 'Live Preview and source mode need shared Markdown editing surfaces');
assert(html.includes('data-role="note-reading-view"'), 'Notes needs a safe read-only Markdown surface');
assert(html.includes('data-role="note-tabs"') && html.includes('data-note-action="new-tab"'), 'Notes needs a persistent multi-document tab strip');
assert(html.includes('data-role="note-inline-title"'), 'the active Markdown filename needs an editable inline title');
assert(html.includes('data-note-action="toggle-focus"'), 'the Notes library header needs a top-bar focus toggle');
assert(html.includes('data-role="note-word-count"') && html.includes('data-role="note-character-count"'), 'the document footer needs word and character counts');
assert(html.includes('data-role="note-font-scale"'), 'the start-page gear needs a Markdown font scale control');
assert(notes.includes('RelatumNoteLiveEditor.create'), 'workspace must create the Live Preview adapter');
assert(notes.includes('editorSnapshot()') && notes.includes('setEditorDocument'), 'workspace save/load must use editor snapshots');
assert(notes.includes('onDocChanged: (meta) => markChanged(meta)'), 'Live Preview edits must report metadata rather than cloning the full document');
assert(notes.includes("OPEN_TABS_KEY = 'canvas:noteOpenTabs:v1'"), 'open Markdown tabs must survive a local restart');
assert(notes.includes('function renderTabs()') && notes.includes('async function closeTab'), 'tabs need open, close, reorder, and switch behavior');
assert(notes.includes('RelatumNoteLiveEditor.create(editorHost'), 'all Markdown tabs must reuse one CodeMirror surface');
assert(notes.includes("viewModeButton('live'") && notes.includes("viewModeButton('source'") && notes.includes("viewModeButton('reading'"),
  'the current-note menu must expose Live Preview, source, and reading modes');
assert(notes.includes("NOTE_VIEW_KEY = 'canvas:noteView:v1'"), 'the selected Markdown view mode must persist locally');
assert(notes.includes('function setViewMode(mode)') && notes.includes('function renderReadingDocument(payload)'),
  'view switching must keep one Markdown source and render reading mode on demand');
assert(live.includes('function setSourceMode(active)') && live.includes('sourceMode ? [] : [blockField, viewportParsePlugin, inlinePlugin]'),
  'source mode must keep CodeMirror while removing Live Preview projections');
assert(live.includes('function renderMarkdown(host, source, notePath, options)'),
  'reading mode must reuse the Live Preview safe renderer and lazy offline assets');
assert(notes.includes('function commitInlineTitle()') && notes.includes("rawValue + '.md'"), 'the inline title must rename the backing Markdown file');
assert(notes.includes("state.lastMoveCode === 'exists' ? tr('duplicateTitle')"), 'duplicate inline titles need the Obsidian-style floating warning');
assert(notes.includes("document.body.classList.toggle('note-focus-mode'"), 'the Notes focus toggle must collapse the global top bar without replacing the workspace');
assert(notes.includes("liveEditor.view.scrollDOM.addEventListener('scroll', scheduleInlineTitleScroll"), 'the inline filename title must follow the shared editor scroll surface');
assert(notes.includes("root.style.setProperty('--note-title-scroll-offset'"), 'the inline filename title needs a bounded scroll projection');
assert(notes.includes('DOCUMENT_CACHE_LIMIT = 24'), 'multi-tab documents need a bounded inactive-document cache');
assert(notes.includes("words: '{count} 个词'") && notes.includes("characters: '{count} 个字符'"), 'word and character counts must be localized');
const changeListener = live.slice(live.indexOf('EditorView.updateListener'), live.indexOf('EditorView.domEventHandlers'));
assert(!changeListener.includes('toString()'), 'ordinary keystrokes must not stringify the full Markdown document');
assert(live.includes('length: view.state.doc.length'), 'ordinary keystrokes should update character count without cloning Markdown');
assert(live.includes('function setNotePath(path)') && live.includes('notePathEffect.of(currentPath)'), 'a file rename must refresh path-dependent widgets without rebuilding editor state');
assert(live.includes('compositionEffect') && live.includes('compositionDirty'), 'IME composition must suspend projection and defer autosave notification');
assert(!live.includes('defaultHighlightStyle') && !live.includes('syntaxHighlighting('), 'Relatum source roles must replace CodeMirror default heading/link decoration');
assert(live.includes("kind: 'callout'") && live.includes("kind === 'callout'"), 'Obsidian-style Callout blocks must have a stable projection');
assert(live.includes('/api/note-asset?note='), 'Live Preview local images must use the authorized note asset endpoint');
assert(live.includes('EditorView.updateListener') && live.includes('if (!update.docChanged'), 'only document transactions may enter the save chain');
assert(live.includes('securityLevel') === false, 'Mermaid security policy belongs to the shared renderer');
assert(/securityLevel:\s*'strict'/.test(mermaid) && /flowchart:\s*\{[\s\S]*?htmlLabels:\s*false/.test(mermaid),
  'shared Mermaid renderer must use strict mode without HTML labels');
assert(mermaid.includes("querySelectorAll('script, foreignObject")
  && mermaid.includes("createElementNS('http://www.w3.org/2000/svg', 'text')"),
  'Mermaid output must convert safe labels to SVG text and remove foreignObject');
assert(markdown.includes('localImages'), 'MarkdownMini local image rendering must remain opt-in');
assert(markdown.includes('data-note-image'), 'MarkdownMini must not emit an eager remote image src');
assert(desktop.includes('setBeforeCloseHandler'), 'desktop shell needs an async pre-close hook');
assert(css.includes('.start-workspace-panel[hidden]'), 'hidden workspace panels must never overlap');
assert(css.includes('.start-workspace-stage'), 'workspace panels need a geometry-stable shared stage');
assert(css.includes('.note-tree-children'), 'nested folders need visible hierarchy guides');
assert(css.includes('.note-tree-row[aria-expanded] .note-tree-toggle::before'), 'folder disclosure needs a geometric CSS icon');
assert(css.includes('.note-tree-children-shell.is-open'), 'nested folders need a height and opacity transition');
assert(css.includes('.note-tree-icon.is-folder { opacity:'), 'folder icons need the unified SVG treatment');
assert(css.includes('.note-path-crumb.is-file'), 'the active note header needs a folder breadcrumb');
assert(css.includes('body.start-page[data-start-workspace="notes"].note-focus-mode > .top-bar'), 'Notes focus mode needs an animated top-bar collapse');
assert(css.includes('--note-content-width: 1040px'), 'the Markdown body needs the wider long-form measure');
assert(css.includes('--note-content-left: clamp(42px, 6vw, 112px)'), 'the Markdown body must be shifted left on wide screens');
assert(css.includes('font-size: calc(16px * var(--note-font-scale, 1))') && css.includes('line-height: 1.5'), 'Markdown typography must use the Obsidian-aligned 16px/1.5 baseline');
assert(css.includes('--note-font-text: -apple-system') && css.includes('"Segoe UI Variable Text"'), 'Markdown text must prefer the Obsidian-like system font stack');
assert(css.includes('.note-live-h1 { padding-top: .28em !important; font-size: 1.75em; }'), 'H1 needs a distinct, compact scale below the inline filename title');
assert(css.includes("transform: translateY(calc(-1 * var(--note-title-scroll-offset, 0px)))"), 'the inline filename title must scroll away instead of staying fixed');
assert(css.includes('padding: calc(var(--note-inline-title-space) + 10px) 0 120px'), 'the title reservation must live inside the editor scroller');
assert(live.includes('replace(nodeRef.from, headingMarkerProjectionEnd'), 'inactive ATX markers must not leave a visible separator indent');
assert(css.includes('.note-links-pane') && css.includes('transform: translateX(100%)'), 'links and history must remain an overlay instead of a permanent third column');
assert(css.includes('.note-live-source-mark') && css.includes('--note-live-marker: #a8a7a2'), 'visible Markdown markers need Relatum light-theme source colors');
assert(css.includes('--note-live-marker: #8f948d'), 'visible Markdown markers need a dark-theme source color');
assert(css.includes('.note-live-heading *') && css.includes('text-decoration: none !important'), 'heading content must defensively reject inherited underlines');
assert(!css.includes('position: fixed !important;\n  z-index: 80'), 'workspace animation must not replace final geometry');
assert(css.includes('@media (max-width: 1120px)'), 'the two-pane workspace needs narrow-window collapse');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), 'new motion needs a reduced-motion fallback');
assert(start.includes("NOTE_FONT_SCALE_KEY = 'canvas:noteFontScale:v1'") && start.includes("style.setProperty('--note-font-scale'"), 'the font scale must apply offline and persist locally');

console.log('note workspace contract: ok');
