'use strict';
const assert = require('node:assert/strict');
module.exports = async function lifecycle(page, waitForSaved) {
  await page.evaluate(() => {
    const api = pywebview.api, documentAction = api.markdown_document, setDirty = api.set_dirty;
    window.__lifecycle = { changed: 0, reads: 0, dirty: [], hold: true, release: null };
    api.set_dirty = value => { __lifecycle.dirty.push(value); return setDirty(value); };
    api.markdown_document = (action, ...args) => {
      if (action === 'read') { __lifecycle.reads++; if (__lifecycle.failRead) return Promise.resolve({ ok: false, error: 'reload test failure' }); }
      if (action === 'changed') {
        __lifecycle.changed++;
        if (__lifecycle.hold) return new Promise(resolve => { __lifecycle.release = resolve; });
      }
      return documentAction(action, ...args);
    };
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => !!__lifecycle.release);
  assert.equal(await page.evaluate(() => __lifecycle.changed), 1, 'Focus/visibility notifications share one in-flight disk check');
  await page.evaluate(() => { __lifecycle.release({ ok: true, changed: false }); __lifecycle.release = null; });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    const editor = RelatumMarkdownWindow.editor;
    window.__lifecycleEditor = editor;
    for (let i = 0; i < 12; i++) editor.replaceSelection('x');
  });
  await page.waitForFunction(() => __lifecycle.dirty.includes(true));
  await page.evaluate(() => { __lifecycle.release({ ok: true, changed: true }); __lifecycle.release = null; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => __lifecycle.reads), 0, 'A response from before editing cannot reload the editor');
  assert(await page.evaluate(() => __lifecycleEditor === RelatumMarkdownWindow.editor));
  assert.deepEqual(await page.evaluate(() => __lifecycle.dirty), [true], 'Repeated typing sends one dirty transition');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => !!__lifecycle.release);
  await page.locator('[data-action="save"]').click(); await waitForSaved();
  await page.waitForFunction(() => __lifecycle.dirty.includes(false));
  await page.evaluate(() => { __lifecycle.release({ ok: true, changed: true }); __lifecycle.release = null; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => __lifecycle.reads), 0, 'A response from before saving cannot reload the editor');
  assert.deepEqual(await page.evaluate(() => __lifecycle.dirty), [true, false]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => !!__lifecycle.release);
  await page.evaluate(() => {
    document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
    __lifecycle.release({ ok: false, error: 'obsolete failure' }); __lifecycle.release = null;
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-role="error"]').isVisible(), false, 'Hidden-session failures are ignored');
  await page.evaluate(() => {
    __lifecycle.hold = false;
    document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => { __lifecycle.hold = true; __lifecycle.failRead = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => !!__lifecycle.release);
  await page.evaluate(() => { __lifecycle.release({ ok: true, changed: true }); __lifecycle.release = null; });
  await page.locator('[data-role="error"]').filter({ hasText: 'reload test failure' }).waitFor();
  assert(await page.evaluate(() => __lifecycleEditor === RelatumMarkdownWindow.editor), 'A current reload error is visible and keeps the editor');
};
