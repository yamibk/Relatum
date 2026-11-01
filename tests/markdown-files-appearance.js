'use strict';
// Runs inside the isolated, real native host used by markdown-files-desktop.js.
const assert = require('node:assert/strict'), path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function checkAppearance(page, artifacts, waitForSaved) {
  const outline = page.locator('.markdown-outline'), toggle = page.locator('[data-action="outline"]');
  const mode = page.locator('[data-action="source"]'), settings = page.locator('dialog.relatum-settings');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'apple');
  assert.equal(await page.evaluate(() => typeof window.RelatumNoteTheme), 'undefined', 'legacy notebook themes stay out of this host');
  assert(!(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /note-theme\.(?:js|css)|inter-variable|source-serif-4/.test(entry.name)))));
  const colors = async selectors => page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
    let node = document.querySelector(selector), value = '';
    while (node) { value = getComputedStyle(node).backgroundColor; if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') break; node = node.parentElement; }
    return [selector, value];
  })), selectors);
  const surfaces = ['body', '.markdown-root', '.markdown-toolbar', '.markdown-footer', '.note-document-pane', '.cm-editor', '.markdown-outline'];
  async function palette(dark) {
    const expected = dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)';
    for (const [selector, color] of Object.entries(await colors(surfaces))) assert.equal(color, expected, selector);
    await page.locator('[data-action="more"]').click();
    assert.equal((await colors(['[data-role="more"]']))['[data-role="more"]'], expected);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="settings"]').click(); await settings.waitFor();
    for (const [selector, color] of Object.entries(await colors(['.relatum-settings', '.relatum-settings-sidebar', '.relatum-settings-header', '.relatum-settings-scroll', '.markdown-files-card', '.markdown-files-steps > div']))) assert.equal(color, expected, selector);
    await settings.locator('nav [data-settings-category="appearance"]').click();
    assert.equal(await settings.locator('select').count(), 0);
    assert.equal(await settings.locator('[data-role="markdown-dark"]').isChecked(), dark);
    await pause(250);
    await page.screenshot({ path: path.join(artifacts, dark ? 'markdown-settings-black.png' : 'markdown-settings-white.png') });
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });
  }
  await palette(false);
  // Make line wrapping and scroll positions observable while retaining the
  // editor instance, its native history, and the actual file save pipeline.
  await page.evaluate(() => {
    const e = RelatumMarkdownWindow.editor;
    e.view.dispatch({ changes: { from: e.view.state.doc.length, insert: '\n' + 'A long paragraph keeps the same width. 中文段落保持相同宽度。'.repeat(12) + '\n\n' + 'A paragraph for scrolling.\n\n'.repeat(100) } });
    e.revealPosition(30, { align: 'start' });
    window.originalMarkdownEditor = e;
  });
  await page.locator('[data-action="save"]').click();
  await waitForSaved();
  const geometry = () => page.evaluate(() => {
    const e = RelatumMarkdownWindow.editor, rect = e.view.scrollDOM.getBoundingClientRect();
    const paragraph = Array.from(e.view.contentDOM.querySelectorAll('.cm-line')).find(node => node.textContent.startsWith('A long paragraph'));
    return { x: rect.x, width: rect.width, clientWidth: e.view.scrollDOM.clientWidth,
      anchor: e.view.state.selection.main.anchor, head: e.view.state.selection.main.head,
      scrollTop: e.view.scrollDOM.scrollTop, wrappedHeight: paragraph?.getBoundingClientRect().height };
  });
  await pause(80); const before = await geometry();
  await toggle.click();
  const intermediate = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pane = document.querySelector('.markdown-outline');
    return { transform: getComputedStyle(pane).transform, duration: getComputedStyle(pane).transitionDuration };
  });
  assert(intermediate.duration.includes('0.23'));
  assert.notEqual(intermediate.transform, 'none', 'the outline slides, rather than instantly appearing');
  await pause(260);
  assert.deepEqual(await geometry(), before, 'opening the outline leaves editor geometry, wrap, selection and scroll unchanged');
  const paneRect = await outline.boundingBox(), viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(Math.abs(paneRect.width - 240) < 1); assert(Math.abs(paneRect.x + paneRect.width - viewport.width) < 1);
  await page.screenshot({ path: path.join(artifacts, 'markdown-outline-white.png') });
  // Repeated opening/closing reverses the same CSS motion; a previous end event
  // or timeout cannot hide a newly opened outline.
  await toggle.click(); await pause(40); await toggle.click(); await pause(320);
  assert.equal(await outline.isVisible(), true); assert.equal(await outline.getAttribute('aria-hidden'), 'false');
  await page.locator('[data-action="close"]').click(); await pause(290);
  assert.equal(await outline.evaluate(node => node.hidden && node.inert), true);
  assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await geometry(), before);
  // Both the icon and its accessible label reflect the committed editor mode.
  const modeState = () => page.evaluate(() => {
    const button = document.querySelector('[data-action="source"]');
    return { pressed: button.getAttribute('aria-pressed'), title: button.title,
      source: getComputedStyle(button.querySelector('.note-view-icon-source')).display,
      live: getComputedStyle(button.querySelector('.note-view-icon-live')).display,
      editor: document.querySelector('[data-role="editor"]').classList.contains('is-source-mode') };
  });
  assert.equal((await modeState()).pressed, 'false');
  const saved = await page.evaluate(() => ({ value: RelatumMarkdownWindow.editor.snapshot().value,
    anchor: RelatumMarkdownWindow.editor.view.state.selection.main.anchor, head: RelatumMarkdownWindow.editor.view.state.selection.main.head }));
  await mode.click(); await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'true');
  const sourceState = await modeState(); assert(sourceState.editor); assert.equal(sourceState.source, 'none'); assert.notEqual(sourceState.live, 'none'); assert.equal(sourceState.title, '切换到实时预览');
  await page.evaluate(() => { const button = document.querySelector('[data-action="source"]'); button.click(); button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'false');
  assert.equal((await modeState()).editor, false); assert.equal((await modeState()).title, '切换到源码模式');
  assert.deepEqual(await page.evaluate(() => ({ value: RelatumMarkdownWindow.editor.snapshot().value,
    anchor: RelatumMarkdownWindow.editor.view.state.selection.main.anchor, head: RelatumMarkdownWindow.editor.view.state.selection.main.head })), saved);
  await page.evaluate(() => {
    const e = RelatumMarkdownWindow.editor; e.view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    document.querySelector('[data-action="source"]').click();
  });
  assert.equal((await modeState()).pressed, 'false', 'a pending IME handoff does not publish a mode change early');
  await page.evaluate(() => RelatumMarkdownWindow.editor.view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true })));
  await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'true');
  await mode.click(); await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'false');
  assert(await page.evaluate(() => RelatumMarkdownWindow.editor === originalMarkdownEditor));
  await page.locator('.note-table td[data-table-row="0"][data-table-col="0"]').first().click();
  await page.locator('.note-table-cell-editor').fill('模式切换保留表格');
  await mode.click(); await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'true');
  assert((await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value)).includes('模式切换保留表格'));
  await mode.click(); await page.waitForFunction(() => document.querySelector('[data-action="source"]').getAttribute('aria-pressed') === 'false');
  const history = await page.evaluate(() => {
    const e = RelatumMarkdownWindow.editor, value = e.snapshot().value;
    const undo = RelatumCodeMirror.undo(e.view), redo = RelatumCodeMirror.redo(e.view);
    return { undo, redo, restored: e.snapshot().value === value };
  });
  assert.deepEqual(history, { undo: true, redo: true, restored: true }, 'mode changes preserve the existing undo history');
  await page.locator('[data-action="save"]').click();
  await waitForSaved();
  // Only grayscale appearance changes; neither old theme preferences nor the
  // editor's document and selection are replaced.
  await page.locator('[data-action="settings"]').click();
  await settings.locator('nav [data-settings-category="appearance"]').click();
  await settings.locator('[data-role="markdown-dark"]').check();
  await page.keyboard.press('Escape');
  await palette(true);
  const native = await page.evaluate(() => pywebview.api.markdown_set_appearance(true)); assert.equal(native.ok, true);
  console.log('Native monochrome caption supported: ' + native.native);
  await page.evaluate(async () => { await RelatumDesktopPreferences.flush(); });
  await page.reload(); await page.waitForFunction(() => window.RelatumMarkdownWindow?.editor);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.markdownDark), '1');
  assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'apple');
  await toggle.click(); await pause(260); await palette(true);
  await page.screenshot({ path: path.join(artifacts, 'markdown-outline-black.png') });
  await page.setViewportSize({ width: 560, height: 760 }); await pause(60);
  const narrow = await geometry(); await toggle.click(); await pause(270); assert.deepEqual(await geometry(), narrow);
  await toggle.click(); await pause(270); assert.deepEqual(await geometry(), narrow);
  const narrowRect = await outline.boundingBox(); assert(Math.abs(narrowRect.x + narrowRect.width - 560) < 1);
  assert(await page.evaluate(() => !!document.elementFromPoint(35, 180)?.closest('.cm-editor')), 'the exposed document remains editable');
  await page.screenshot({ path: path.join(artifacts, 'markdown-outline-narrow.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click(); assert.equal(await outline.evaluate(node => node.hidden && node.inert), true);
  await toggle.click(); assert.equal(await outline.evaluate(node => node.getAnimations().length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await toggle.click(); await pause(40); await toggle.click();
  await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } })); });
  assert.equal(await outline.evaluate(node => node.inert && node.hidden), true);
  await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } })); });
  await pause(320); assert.equal(await outline.isVisible(), true); assert.equal(await outline.evaluate(node => node.getAnimations().length), 0);
};
