'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');

assert(html.includes('data-role="assets-clean-dialog"'));
assert(html.includes('role="alertdialog" aria-modal="true"'));
assert(html.includes('aria-labelledby="assets-clean-dialog-title"'));
assert(html.includes('data-role="assets-clean-cancel"'));
assert(html.includes('data-role="assets-clean-confirm"'));
assert(html.includes('data-editor-i18n-title="assetsCleanButtonTitle"'));

assert(!editor.includes("window.confirm('将删除当前画布"));
assert(editor.includes("cleanBtn.addEventListener('click', openAssetsCleanDialog)"));
assert(editor.includes("cleanDialogConfirm.addEventListener('click', cleanUnusedAssets)"));
assert(editor.includes("event.key === 'Escape' && !cleanDialogBusy"));
assert(editor.includes("event.key !== 'Tab'"));
assert(editor.includes("cleanDialogConfirm.textContent = toolbarCopy('assetsCleanWorking')"));
assert(editor.includes("assetsCleanTitle: 'Clean unused attachments?'"));
assert(editor.includes("assetsCleanButtonTitle: '存在未使用的附件，点击查看清理范围'"));

assert(styles.includes('.assets-clean-card'));
assert(styles.includes('.assets-clean-confirm:focus-visible'));
assert(styles.includes('body.editor-page[data-background-tone="dark"] .assets-clean-card'));
assert(styles.includes('@keyframes assets-clean-card-in'));

console.log('editor assets-clean dialog contract: ok');
