'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('assets', 'index.html');
const start = read('assets', 'start.js');
const styles = read('assets', 'styles.css');
const i18n = read('assets', 'i18n.js');
const backend = read('app.py');

assert(html.includes('data-action="recent-sync"'), '未分组扫描按钮缺失');
assert(html.includes('aria-label="扫描画布文件夹"') && html.includes('hidden'),
  '扫描按钮必须默认隐藏并提供无障碍名称');
assert(start.includes('recentSyncButton.hidden = activeGroup !== INBOX_PAGE'),
  '扫描按钮只能在未分组页显示');
assert(start.includes("fetch('/api/recent-sync'"), '扫描按钮必须调用 recent-sync 接口');
assert(start.includes('result.needsConfirmation') && start.includes('window.confirm(message)'),
  '存在失效登记时必须先预览并确认');
assert(start.includes('requestRecentSync(result.removeIds || [])'),
  '确认请求只能提交预览返回的不透明条目 ID');
assert(start.includes("recentSyncButton.classList.add('is-refreshing')")
  && start.includes("recentSyncButton.classList.remove('is-refreshing')"),
  '扫描按钮必须提供有限加载反馈');
assert(start.includes("typeof file.lastOpenedAt === 'string' && file.lastOpenedAt.trim()"),
  '最近页必须排除从未打开的扫描条目');
assert(start.includes('新增 ') && start.includes('Canvas library is already up to date'),
  '扫描结果必须提供中英文反馈');
assert(styles.includes('.recent-sync-button[hidden] { display: none; }'),
  '按钮隐藏状态不能被通用 flex 样式覆盖');
assert(styles.includes('body.start-page[data-start-theme="dark"] .recent-sync-button'),
  '扫描按钮必须适配深色起步页');
assert(i18n.includes("'扫描画布文件夹': 'Scan canvas folder'"),
  '扫描按钮必须提供英文说明');
[
  '"/api/recent-sync"',
  'def sync_recent_library(',
  'def _api_recent_sync(',
  '"needsConfirmation": True',
  '"lastOpenedAt": ""',
].forEach((needle) => assert(backend.includes(needle), '后端扫描契约缺失：' + needle));

console.log('start recent sync contract passed');
