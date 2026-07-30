'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets/editor.html'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets/editor.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets/canvas.js'), 'utf8');
const markdown = fs.readFileSync(path.join(root, 'assets/markdown.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/styles.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

assert(html.includes('data-action="markdown-notebook"'), 'tools menu must expose Notebook');
assert(html.includes('data-role="markdown-notebook-dialog"'), 'Notebook dialog must exist');
assert(html.includes('data-role="markdown-notebook-source"'), 'Notebook must keep a source editor');
assert(html.includes('data-role="markdown-notebook-preview"'), 'Notebook must keep a live preview');
assert(html.includes('data-role="markdown-notebook-delete-confirm"'),
  'Notebook must use its own accessible delete confirmation');
assert(html.includes('data-role="markdown-notebook-help"'),
  'Notebook must expose an anchored mind-map generation guide');
assert(html.includes('data-role="markdown-notebook-topbar-toggle"')
    && html.includes('data-action="markdown-notebook-shortcut"'),
  'Notebook must expose its opt-in editor-toolbar shortcut');
const shortcutTag = html.match(/<button[^>]+data-action="markdown-notebook-shortcut"[^>]*>/);
assert(shortcutTag && shortcutTag[0].includes('hidden') && !shortcutTag[0].includes('data-mode='),
  'Notebook shortcut must default hidden and remain independent from canvas modes');
assert(html.includes('role="alertdialog"') && html.includes('aria-describedby="markdown-notebook-delete-detail"'),
  'delete confirmation must expose alert-dialog semantics');
assert(html.includes('<script src="markdown-notebook.js" defer></script>'), 'data layer must load before canvas');

const notebookEditorStart = editor.indexOf('(function setupMarkdownNotebook()');
const notebookEditorEnd = editor.indexOf('// ── 节点矩阵', notebookEditorStart);
const notebookEditor = editor.slice(notebookEditorStart, notebookEditorEnd);
assert(notebookEditor && !notebookEditor.includes('window.confirm'),
  'Notebook deletion must not use the native browser confirm');
assert(editor.includes("canvas:notebookMindmapDefaults:v1"), 'mind-map choices need their own preference key');
assert(editor.includes("canvas:notebookTopbarShortcut")
    && editor.includes("localStorage.getItem(TOPBAR_SHORTCUT_KEY) === '1'")
    && editor.includes('topbarShortcut.hidden = !visible'),
  'Notebook toolbar shortcut must be a default-off local preference with immediate visibility');
assert(editor.includes("document.addEventListener('editor:open-markdown-notebook', open)"), 'tool action must open dialog');
assert(editor.includes('delete canvasData.markdownNotebook'), 'last note must remove the optional top-level field');
assert(notebookEditor.includes('function closeDeleteConfirm(restoreFocus)')
    && notebookEditor.includes('function confirmDeleteNote()'),
  'Notebook deletion must have explicit cancel/confirm lifecycle');
assert(notebookEditor.includes("helpButton.setAttribute('aria-expanded', 'true')")
    && notebookEditor.includes("helpButton.setAttribute('aria-expanded', 'false')"),
  'mind-map help trigger must keep its expanded state accessible');
assert(notebookEditor.includes('function handleNotebookEscape(event)')
    && notebookEditor.includes("document.addEventListener('keydown', handleNotebookEscape, true)")
    && /function handleNotebookEscape\(event\)[\s\S]*?close\(false\);/.test(notebookEditor),
  'Notebook Escape handling must run in capture phase even if focus escapes the dialog');
assert(notebookEditor.includes("helpCount.textContent = copyWithCount('markdownNotebookHelpReady', outlineModel.count)"),
  'help summary must reuse the same parsed outline result as generation');
assert(notebookEditor.includes("helpLive.dataset.tone = 'error'"),
  'help summary must expose the 200-node limit state');
assert(editor.includes('window.MarkdownMini.renderResult(markdown)'),
  'preview must reuse the safe renderer and its feature result');
assert(editor.includes('rendered.features.mermaid') && editor.includes('rendered.features.math'),
  'preview must gate Mermaid and math work by detected source features');
assert(editor.includes('canvasApi.scheduleMarkdownMath(preview, markdown, true)'),
  'preview must pass its already-computed math feature to the canvas renderer');
assert(editor.includes('}, immediate ? 0 : 100);'),
  'preview must use a trailing delay instead of rendering synchronously per keystroke');
assert(editor.includes("sourceInput.addEventListener('input', commitSourceInput)"),
  'source input must update the active note through the lightweight hot path');
assert(editor.includes("sourceInput.addEventListener('keydown', continueMarkdownList)"),
  'source input must expose lightweight Enter list continuation');
const virtualPersistBlock = editor.slice(
  editor.indexOf('function persistVirtual()'),
  editor.indexOf('function touchNote(', editor.indexOf('function persistVirtual()')),
);
assert(virtualPersistBlock && !virtualPersistBlock.includes('markDirty()'),
  'persisting the virtual first note must not emit a second dirty change');
const sourceInputBlock = editor.slice(
  editor.indexOf('function commitSourceInput()'),
  editor.indexOf('function replaceSourceRange(', editor.indexOf('function commitSourceInput()')),
);
assert(sourceInputBlock && !sourceInputBlock.includes('renderList()'),
  'ordinary source input must not rebuild the complete note list');
assert(!notebookEditor.includes('.draggable =')
    && !notebookEditor.includes('dataTransfer')
    && !notebookEditor.includes("addEventListener('drop'"),
  'Notebook sorting must not use native HTML drag-and-drop or text payloads');
assert(notebookEditor.includes("grip.addEventListener('pointerdown'")
    && notebookEditor.includes('Math.hypot(dx, dy) < 6'),
  'Notebook sorting must start only from the grip after a pointer threshold');
assert(notebookEditor.includes('function flipNoteRows(mutate)')
    && notebookEditor.includes('function flyNoteGhostTo(ghost, row, done)')
    && notebookEditor.includes('function noteEdgeScroll(clientY)'),
  'Notebook sorting must provide live FLIP displacement, landing motion, and edge scrolling');
assert(notebookEditor.includes("list.addEventListener('dragstart', (event) => event.preventDefault())"),
  'Notebook must defensively suppress browser-native drag search');
const noteDragMoveBlock = notebookEditor.slice(
  notebookEditor.indexOf('function onNoteDragPointerMove('),
  notebookEditor.indexOf('function clearNoteDragListeners(', notebookEditor.indexOf('function onNoteDragPointerMove(')),
);
assert(noteDragMoveBlock && !noteDragMoveBlock.includes('renderList(')
    && !noteDragMoveBlock.includes('touchNote('),
  'pointer movement must not rebuild notes, update data, or trigger preview work');
const noteDragFinishBlock = notebookEditor.slice(
  notebookEditor.indexOf('function finishNoteDrag('),
  notebookEditor.indexOf('function onNoteDragPointerUp(', notebookEditor.indexOf('function finishNoteDrag(')),
);
assert(noteDragFinishBlock && !noteDragFinishBlock.includes('renderList(')
    && noteDragFinishBlock.includes('syncMobileNoteOrder(domOrder)'),
  'drop must reuse the already-positioned note DOM and update only the mobile selector');
assert(notebookEditor.includes("ghost.style.transition = 'none'")
    && notebookEditor.includes("ghost.style.animation = 'none'")
    && notebookEditor.indexOf('positionNoteDragGhost(drag, drag.startX, drag.startY)')
      < notebookEditor.indexOf('document.body.appendChild(ghost)'),
  'the drag ghost must be fully positioned before insertion and never inherit card transitions');
assert(notebookEditor.includes('backgroundColor: targetStyle.backgroundColor')
    && notebookEditor.includes("row.classList.add('drag-handoff')"),
  'landing must morph to the real card appearance before a transition-free handoff');

assert(markdown.includes('function parseListMarker(line)'),
  'Markdown must expose one shared list-marker grammar');
assert(markdown.includes('if (i === previousIndex)'),
  'block parsing must guarantee that the read position advances');
assert(markdown.includes('function renderResult(src)'),
  'Markdown must expose HTML and rendering features in one result');
assert(markdown.includes('structure: structure'),
  'Markdown must expose the shared zero-DOM structure helpers');

assert(canvas.includes('global.CanvasModule.getSelectedMarkdownOutline = getSelectedMarkdownOutline'),
  'CanvasModule must expose selection snapshots');
assert(canvas.includes('global.CanvasModule.createMindmapFromOutline = createMindmapFromOutline'),
  'CanvasModule must expose atomic outline generation');
assert(canvas.includes('history: false') && canvas.includes('notify: false'),
  'generation must suppress intermediate history/save commits');
assert(
  canvas.includes('if (options.history !== false) pushHistory();')
    && canvas.includes('if (options.notify !== false) notify();')
    && canvas.includes('if (options.focus !== false) focusNodeIds(tree.nodeSet, false);'),
  'outline generation must commit and focus by default while allowing an atomic outer caller to take ownership',
);
assert(
  editor.includes('api.createMindmapFromOutline(outlineModel, {')
    && !editor.includes('api.createMindmapFromOutline(outlineModel, {\n        history: false'),
  'Notebook generation must keep the default one-history/one-save behavior',
);

const notebookStart = css.indexOf('/* ── 笔记坞');
const notebookEnd = css.indexOf('/* 选中态：', notebookStart);
const notebookCss = css.slice(notebookStart, notebookEnd);
assert(notebookCss && !/backdrop-filter\s*:/.test(notebookCss), 'Notebook may not use sustained backdrop blur');
assert(!/#(?:fff[0-9a-f]?d|fdf[0-9a-f]?|f7f[0-9a-f]?e|2f5f4|d99c21)/i.test(notebookCss),
  'Notebook styles must remain neutral black, white, and gray');
assert(notebookCss.includes('.markdown-notebook-help-popover.tool-layer-entering')
    && notebookCss.includes('.markdown-notebook-confirm.tool-layer-leaving'),
  'Notebook help and confirmation must have finite enter/exit motion');
assert(notebookCss.includes('.markdown-notebook-topbar-option input:checked'),
  'Notebook toolbar preference must use the local neutral checkbox treatment');
assert(notebookCss.includes('.markdown-notebook-list-item.is-removing')
    && notebookCss.includes('.markdown-notebook-workspace.is-switching'),
  'Notebook note deletion and switching must provide local feedback');
assert(notebookCss.includes('.markdown-notebook-list-item.drag-source')
    && notebookCss.includes('.markdown-notebook-list-item.drag-handoff')
    && notebookCss.includes('.markdown-notebook-list-ghost')
    && notebookCss.includes('body.markdown-notebook-dragging'),
  'Notebook sorting must expose placeholder, ghost, and transient drag states');
assert(/\.markdown-notebook-list-ghost\s*\{[\s\S]*?transition:\s*none !important;/.test(notebookCss)
    && /body\.markdown-notebook-dragging \.markdown-notebook-list-item\s*\{[\s\S]*?transition:\s*none !important;/.test(notebookCss),
  'CSS transitions must not compete with pointer tracking or FLIP motion');
assert(/\.markdown-notebook-list-grip\s*\{[\s\S]*?touch-action:\s*none;[\s\S]*?-webkit-user-drag:\s*none;/.test(notebookCss),
  'Notebook grip must block native selection and dragging without affecting document text');
assert(notebookCss.includes('@media (prefers-reduced-motion: reduce)'),
  'Notebook motion must provide a reduced-motion fallback');
assert(notebookCss.includes('--notebook-stage-top: #ffffff')
    && notebookCss.includes('--notebook-stage: #fbfbfc'),
  'Notebook light workspace must use the near-white stage palette');
assert(/\.markdown-notebook-overlay\s*\{[\s\S]*?background:\s*linear-gradient\(/.test(notebookCss),
  'Notebook must own a milk-white overlay instead of changing the shared tool overlay');
assert(/\.markdown-notebook-main\s*\{[\s\S]*?border-radius:\s*20px 20px 0 0;/.test(notebookCss),
  'Notebook workspace must soften its top boundary with rounded corners');
assert(/\.markdown-notebook-pane-head\s*\{[\s\S]*?border-bottom:\s*0;[\s\S]*?background:\s*var\(--notebook-card\);/.test(notebookCss),
  'Markdown and preview headers must share the pure card surface');
assert(notebookCss.includes('.markdown-notebook-pane-head::after')
    && notebookCss.includes('var(--notebook-divider) 16%'),
  'pane separators must fade at both ends instead of using a hard full-width rule');
const neutralToolsStart = css.indexOf('/* ── 画布工具 · 中性黑白视觉系统');
const neutralToolsCss = css.slice(neutralToolsStart);
assert(neutralToolsCss.includes('--tool-overlay: rgba(0, 0, 0, 0.28)'),
  'Notebook whitening must not mutate the shared tool overlay');

assert(backend.includes('notebook_dir = temp_dir / "笔记坞"'), 'Markdown export needs a Notebook subfolder');
assert(backend.includes('"nodeCount": node_count') && backend.includes('"noteCount": note_count'),
  'export response must expose additive node/note counts');

console.log('markdown notebook contract tests passed');
