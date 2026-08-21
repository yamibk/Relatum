'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');

const trigger = html.match(/<button[^>]+data-action="start-help-open"[\s\S]*?<\/button>/);
assert(trigger, 'the local data guide trigger must exist');
assert(!/\sdisabled(?:\s|>|=)/.test(trigger[0]), 'the local data guide trigger must be enabled');
assert(trigger[0].includes('查看本地数据与空间管理说明'));

assert.strictEqual((html.match(/data-help-page="(?:safety|canvases|data)"/g) || []).length, 6);
assert(!html.includes('data-help-page="study"'));
assert(html.includes('Relatum · 本地数据说明'));
assert(html.includes('01 / 03'));

[
  "id: 'safety'",
  "id: 'canvases'",
  "id: 'data'",
  '名称.canvas',
  '名称.assets',
  'recent.json',
  'tree-page.json',
  'review.db',
  '删除哪一项，就会清空对应页面的数据',
  "canvas:dataGuideClicked:v1",
].forEach((token) => assert(start.includes(token), 'missing local data guide token: ' + token));
[
  'START_HELP_PAGES_ZH',
  'START_HELP_PAGES_EN',
  'function startHelpPages()',
  'Before deleting, read this',
  'canvases: canvases and attachments',
  'data: records, settings, and indexes',
  'It is completely separate from Study Goal Trees.',
  'Do not delete the whole <code>data</code> folder',
].forEach((token) => assert(start.includes(token), 'missing English local data guide token: ' + token));
assert(i18n.includes("'Relatum · 本地数据说明': 'Relatum · Local Data Guide'"));
assert(i18n.includes("'查看本地数据与空间管理说明': 'View the local data and storage guide'"));
assert(!start.includes('开始第一张画布'), 'the retired start tutorial content must be removed');
assert(!start.includes('function helpDemo('), 'the retired tutorial demos must be removed');

assert(/\.start-help-panel\s*\{[\s\S]*?animation:\s*start-help-enter\s+360ms/.test(styles));
assert(/\.start-help-overlay\.is-closing \.start-help-panel\s*\{[\s\S]*?animation:\s*start-help-exit\s+220ms/.test(styles));
assert(/\.start-help-overlay\.is-closing \.start-help-backdrop\s*\{[\s\S]*?animation:\s*start-help-backdrop-exit\s+180ms/.test(styles));
assert(start.includes("startHelp.classList.add('is-closing')"), 'closing must play before the guide is hidden');
assert(start.includes('startHelpCloseTimer = window.setTimeout(finishStartHelpClose, 260)'),
  'closing must defer hidden until the exit transition finishes');
assert(/\.start-help-nav-slider\s*\{[\s\S]*?transition:\s*transform\s+430ms/.test(styles));
assert(/\.start-help-section\s*\{[\s\S]*?animation:\s*start-help-section-enter\s+360ms/.test(styles));
assert(start.includes("page.animate(["), 'page switching must keep the horizontal transition');
assert(start.includes('startHelpScrollVelocity'), 'the guide must keep inertial scrolling');
assert(start.includes('const pageTurnZone = Math.min(88, Math.max(64, helpBook.clientWidth * 0.1))'),
  'the left part of the content scroller must also turn guide pages');
assert(/\.start-help-book::\-webkit-scrollbar-button[\s\S]*?display:\s*none;/.test(styles),
  'the data guide scrollbar must hide native arrow buttons');
assert(styles.includes('scrollbar-color: auto;'),
  'Chromium must let the custom no-button scrollbar override standard scrollbar styling');
assert(styles.includes('.start-help-book::-webkit-scrollbar-button:vertical:start:decrement'),
  'the data guide must suppress Edge directional scrollbar buttons explicitly');
assert(/\.start-help-book::\-webkit-scrollbar-thumb\s*\{[\s\S]*?border-radius:\s*999px;/.test(styles),
  'the data guide scrollbar must keep a compact capsule thumb');
assert(styles.includes('@media (prefers-reduced-motion: reduce)'));

console.log('start data guide contract passed');
