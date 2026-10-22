# Optional host runtimes; app assets remain offline and dependency free.
param([string]$Python = 'python', [string]$Node = 'node', [switch]$Browser)
$ErrorActionPreference = 'Stop'
& $Python -m unittest tests.test_note_index tests.test_note_index_api tests.test_notes_library tests.test_note_browser tests.test_note_graph tests.test_note_notebooks tests.test_note_reveal tests.test_note_canvas_browser tests.test_note_canvases tests.test_note_trash tests.test_career_report tests.test_feature_profile
if ($LASTEXITCODE -ne 0) { throw 'Note backend checks failed.' }
foreach ($check in @('note-live-editor-regression.js','note-typora-regression.js','note-outline-regression.js','note-syntax-index-regression.js','note-tags-regression.js','note-canvas-reference-regression.js','graph-instance-cache-regression.js','graph-layout-regression.js','note-graph-preferences-regression.js','note-tab-motion-regression.js','note-workspace-contract.js')) {
    & $Node (Join-Path $PSScriptRoot $check)
    if ($LASTEXITCODE -ne 0) { throw ('Failed: ' + $check) }
}
if ($Browser) {
    foreach ($check in @('note-typora-browser.js','note-table-alignment-browser.js','note-search-browser.js','note-folder-picker-browser.js','note-ui-browser.js','note-context-menu-browser.js','note-reveal-browser.js','note-browser-browser.js','note-tree-sort-browser.js','note-tree-motion-browser.js','note-notebooks-browser.js','note-visibility-browser.js','note-view-state-browser.js','note-canvas-browser-discovery.js','note-outline-browser.js','note-graph-browser.js')) {
        & $Node (Join-Path $PSScriptRoot $check)
        if ($LASTEXITCODE -ne 0) { throw ('Failed: ' + $check) }
    }
    & $Node (Join-Path $PSScriptRoot 'note-graph-preload-browser.js') --regression-only
    if ($LASTEXITCODE -ne 0) { throw 'Graph preload checks failed.' }
}
