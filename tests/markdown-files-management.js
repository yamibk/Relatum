'use strict';
const assert = require('node:assert/strict');

// Uses the real shared panel and settings confirmation. Only the native registry
// bridge is replaced; no test registers or unregisters an actual application.
module.exports = async function management(page, workspace) {
  async function install() {
    await page.evaluate(() => {
      const state = { ok: true, autoSave: false, outline: false, recent: [],
        association: { supported: true, registered: true, iconCurrent: true, default: true } };
      window.__management = { state, calls: [], fail: false, hold: false, release: null };
      pywebview.api.markdown_files = async (action, value) => {
        const test = __management; test.calls.push(action);
        if (test.hold && action === 'register') await new Promise(resolve => { test.release = resolve; });
        if (test.fail && action === 'unregister') return { ok: false, error: 'Registry test failure' };
        if (action === 'register') state.association.registered = true;
        if (action === 'unregister') state.association.registered = false;
        if (action === 'autoSave' || action === 'outline') state[action] = value;
        return structuredClone(state);
      };
    });
  }
  async function enter() {
    if (workspace) {
      if (!await page.locator('.relatum-settings[open]').count()) await page.locator('[data-note-action="toggle-library-settings"]').click();
      await page.locator('nav [data-settings-category="appearance"]').click();
      await page.locator('nav [data-settings-category="markdown-files"]').click();
    } else await page.locator('[data-action="settings"]').click();
    await page.waitForFunction(() => {
      const panel = document.querySelector('.markdown-files-settings');
      return panel?.getAttribute('aria-busy') === 'false' && !panel.querySelector('[data-markdown-action="unregister"]').disabled;
    });
  }
  const panel = page.locator('.markdown-files-settings'), confirmation = page.locator('.relatum-settings-confirm');
  for (const language of ['zh-CN', 'en']) {
    if (language === 'en') {
      await page.locator('.relatum-settings[open] [data-settings-action="close"]').click();
      await page.locator('.relatum-settings[open]').waitFor({ state: 'detached' });
      await page.evaluate(() => localStorage.setItem('canvas:toolbarLanguage', 'en'));
      await page.reload();
      if (workspace) await page.waitForFunction(() => CanvasNoteWorkspace && document.body.dataset.startWorkspace === 'notes');
      else await page.waitForFunction(() => window.RelatumMarkdownWindow?.editor);
    }
    await install(); await enter();
    await panel.locator('summary').click();
    await page.evaluate(() => {
      const panel = document.querySelector('.markdown-files-settings');
      __management.nodes = [panel.querySelector('details'), panel.querySelector('[data-markdown-action="register"]'), panel.querySelector('[data-markdown-action="autoSave"]')];
    });
    await panel.locator('[data-markdown-action="unregister"]').click();
    await confirmation.waitFor({ state: 'visible' });
    assert.equal(await confirmation.locator('h3').textContent(), language === 'en' ? 'Remove this registration?' : '取消此位置的注册？');
    assert.equal(await confirmation.locator('p').textContent().then(value => value.length > 20), true);
    await confirmation.locator('[data-settings-action="cancel-reset"]').click();
    await page.waitForFunction(() => document.querySelector('.markdown-files-settings').getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => __management.calls.includes('unregister')), false, 'Cancel never reaches the registry');
    assert.equal(await panel.locator('details').getAttribute('open') !== null, true);
    await panel.locator('[data-markdown-action="unregister"]').click();
    await confirmation.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => document.querySelector('[data-markdown-action="unregister"]').disabled);
    assert.equal(await page.evaluate(() => __management.calls.filter(value => value === 'unregister').length), 1);
    assert.match(await panel.locator('.markdown-files-card').nth(1).textContent(), language === 'en' ? /Windows still selects Relatum/ : /Windows 仍选择 Relatum/);
    assert(await page.evaluate(() => __management.nodes.every(node => node.isConnected)), 'Actions preserve existing controls and details');
    await panel.locator('[data-markdown-action="register"]').click();
    await page.waitForFunction(() => document.querySelector('.markdown-files-settings').getAttribute('aria-busy') === 'false');
    await page.evaluate(() => { __management.fail = true; });
    await panel.locator('[data-markdown-action="unregister"]').click();
    await confirmation.locator('[data-settings-action="accept-reset"]').click();
    await panel.getByText('Registry test failure', { exact: true }).waitFor();
    assert.equal(await panel.locator('[data-markdown-action="unregister"]').isEnabled(), true, 'Failure permits retry');
    await page.evaluate(() => { __management.fail = false; __management.hold = true; });
    await panel.locator('[data-markdown-action="register"]').click();
    await page.waitForFunction(() => !!__management.release);
    const before = await page.evaluate(() => __management.calls.length);
    await panel.locator('[data-markdown-action="register"]').click({ force: true });
    assert.equal(await page.evaluate(() => __management.calls.length), before, 'Pending actions cannot be activated twice');
    assert(await page.evaluate(() => __management.nodes.every(node => node.isConnected)));
    await page.evaluate(() => { __management.hold = false; __management.release(); });
    await page.waitForFunction(() => document.querySelector('.markdown-files-settings').getAttribute('aria-busy') === 'false');
    await panel.locator('[data-markdown-action="unregister"]').click();
    await confirmation.waitFor({ state: 'visible' });
    const removals = await page.evaluate(() => __management.calls.filter(value => value === 'unregister').length);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await page.waitForFunction(() => !document.querySelector('.relatum-settings[open]'));
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    assert.equal(await page.evaluate(() => __management.calls.filter(value => value === 'unregister').length), removals, 'Leaving cancels pending confirmation');
    // Reopen for the language-switch step and check state remained usable.
    await enter();
  }
};
