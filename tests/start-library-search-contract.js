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

[
  'data-role="library-search"',
  'data-role="library-search-input"',
  'data-role="library-search-scope"',
  'data-role="library-search-count"',
  'data-role="library-search-status"',
  'data-action="library-search-clear"',
  'data-role="library-search-toggle"',
  'data-search-scope="current"',
  'data-search-scope="all"',
].forEach((needle) => assert(html.includes(needle), '画布库搜索控件缺失：' + needle));

assert(start.includes("let librarySearchMode = 'current'"),
  '搜索范围必须默认当前页且只保存在前端会话内');
assert(start.includes("const LIBRARY_SEARCH_ENABLED_KEY = 'canvas:librarySearchEnabled'")
  && start.includes("localStorage.getItem(LIBRARY_SEARCH_ENABLED_KEY) === '1'"),
  '画布名称搜索必须由持久偏好显式开启并默认关闭');
assert(start.includes("librarySearch.toggleAttribute('inert', !active)")
  && start.includes('renderPanel({ searchUpdate: true })'),
  '关闭搜索必须退出交互并通过增量协调器恢复列表');
assert(start.includes("normalize('NFKC')") && start.includes('tokens.every((token) => title.includes(token))'),
  '搜索必须使用 NFKC、忽略大小写并按多关键词 AND 匹配');
assert(start.includes('stableAllCanvasFiles()') && start.includes('return bt - at'),
  '全库搜索必须使用稳定的最近打开顺序');
assert(start.includes('requestAnimationFrame(applyLibrarySearchInput)'),
  '输入事件必须按帧合并且不能增加可感知防抖');

const reconcileStart = start.indexOf('function reconcileLibrarySearchResults(');
const reconcileEnd = start.indexOf('function applyLibrarySearchInput(', reconcileStart);
assert(reconcileStart >= 0 && reconcileEnd > reconcileStart, '缺少 keyed 搜索结果协调器');
const reconcile = start.slice(reconcileStart, reconcileEnd);
assert(reconcile.includes("new Map(Array.from(fileList.querySelectorAll('.recent-item'))"),
  '搜索协调器必须按路径复用现有卡片');
assert(!reconcile.includes("fileList.innerHTML = ''"),
  '搜索输入不得清空并重建整个列表');
assert(reconcile.includes("li.classList.add('search-leaving')")
  && reconcile.includes("li.classList.add('search-entering')")
  && reconcile.includes("li.classList.add('search-moving')"),
  '搜索结果必须包含离场、入场与 FLIP 补位过渡');
assert(reconcile.includes('generation !== librarySearchRenderSeq'),
  '快速输入必须让旧动画帧失效');
assert(!reconcile.includes('recent-enter'), '搜索不得重播整页错峰动画');

assert(start.includes("if (librarySearchActive()) {\n      showToast(englishUI() ? 'Clear search before reordering'"),
  '搜索期间必须阻止键盘部分重排');
assert(start.includes('if (librarySearchActive() || activeGroup ==='),
  '搜索期间必须阻止卡片之间的拖拽重排');
assert(start.includes("e.key.toLowerCase() !== 'f'")
  && start.includes('!librarySearchEnabled')
  && start.includes('librarySearchInput.select()'),
  '画布库必须支持 Ctrl/Cmd+F 聚焦名称搜索');

[
  '.library-search-scope-slider',
  'body.start-page:not([data-library-search-enabled="1"]) .canvas-library-search',
  '.library-search-field:focus-within',
  '.library-search-clear.show',
  '.recent-item.search-leaving',
  '.recent-item.search-entering',
  'body.start-page[data-start-theme="dark"] .library-search-field',
  '@media (prefers-reduced-motion: reduce)',
].forEach((needle) => assert(styles.includes(needle), '搜索样式契约缺失：' + needle));
assert(styles.includes('background: #171817')
  && styles.includes('.library-search-scope button[aria-pressed="true"] { color: #fff; }'),
  '搜索范围切换必须使用黑色滑块和白色选中字');

[
  "'搜索范围': 'Search scope'",
  "'搜索画布名称': 'Search canvas names'",
  "'清除搜索': 'Clear search'",
  "'画布名称搜索': 'Canvas name search'",
].forEach((needle) => assert(i18n.includes(needle), '搜索双语文案缺失：' + needle));

console.log('start library search contract passed');
