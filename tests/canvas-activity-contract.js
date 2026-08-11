const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const editor = read('assets', 'editor.js');
const editorHtml = read('assets', 'editor.html');
const start = read('assets', 'start.js');
const study = read('assets', 'study.js');
const graph = read('assets', 'study-graph.js');
const styles = read('assets', 'styles.css');
const i18n = read('assets', 'i18n.js');
const backend = read('app.py');

assert(!editorHtml.includes('data-role="canvas-work-time"'),
  '累计时长不应占用编辑器标题区');
assert(start.includes('recent-item-duration') && start.includes('canvasActivitySec'),
  '最近画布列表必须展示每张画布累计时长');
[
  "fetch('/api/canvas-activity'",
  "document.hasFocus()",
  "window.addEventListener('blur'",
  "document.addEventListener('visibilitychange'",
  "window.addEventListener('pagehide'",
  'keepalive: !!keepalive',
  '30000',
].forEach((needle) => assert(editor.includes(needle), '前台计时契约缺失：' + needle));
assert(!editor.includes('applyCanvasActivityTotals'),
  '保存成功后不得调用已移除的编辑器活动时长 UI 同步函数');

assert(study.includes("let cadenceLens = 'canvas';"), '新版年度足迹必须默认画布镜头');
assert(study.includes("localStorage.getItem('canvas:cadenceLens:v2')"), '必须使用独立 v2 镜头偏好');
assert(study.includes('data-lens="canvas"') && study.indexOf('data-lens="canvas"') < study.indexOf('data-lens="complete"'),
  '画布按钮必须排在完成按钮左侧');
assert(study.includes('const clv = cadenceFocusLevel(cmin);'), '画布分钟必须使用七档时长映射');
[15, 30, 60, 120, 180, 300].forEach((limit) =>
  assert(study.includes('min <= ' + limit), '画布热力图缺少分钟边界：' + limit));
[
  'payload.canvasDays',
  'payload.canvasEntries',
  'payload.canvasStats',
  'payload.canvasGraph',
  'payload.canvasOverviewGraph',
].forEach((needle) => assert(study.includes(needle), '画布活跃页字段未消费：' + needle));

assert(styles.includes('.cadence-lens-canvas .cadence-cell:not(.is-future).cadence-cl7'),
  '画布热力图必须提供第七档样式');
assert(styles.includes('.study-cadence.cadence-entering .cadence-day-detail:not(.is-refreshing) {')
  && styles.includes('animation: cadenceSectionIn 700ms 500ms var(--easing-page) both;'),
  'the cadence day summary must join the staged page entrance');
assert(styles.includes('animation-delay: calc(560ms + var(--detail-delay, 0ms));'),
  'cadence day records must remain staggered after the summary begins entering');
const reducedMotionStart = styles.indexOf('@media (prefers-reduced-motion: reduce)');
const reducedMotionEnd = styles.indexOf('@media (max-width: 680px)', reducedMotionStart);
const reducedMotionStyles = styles.slice(reducedMotionStart, reducedMotionEnd);
assert(reducedMotionStart >= 0 && reducedMotionEnd > reducedMotionStart
  && reducedMotionStyles.includes('.study-cadence.cadence-entering .cadence-day-detail:not(.is-refreshing)')
  && reducedMotionStyles.includes('animation: none;'),
  'the cadence day summary entrance must be disabled for reduced motion');
[
  'function ensureActivityReady()',
  'if (activityLoadPromise) return activityLoadPromise;',
  'function scheduleActivityPreload()',
  'window.requestIdleCallback(warmActivity, { timeout: 1500 })',
  'window.setTimeout(warmActivity, 600)',
  'cancelActivityPreload();',
  'scheduleCadenceVisibleActivation();',
].forEach((needle) => assert(study.includes(needle),
  'cadence idle preload contract missing: ' + needle));
assert(study.includes('active: cadenceShown'),
  'a pre-rendered cadence star graph must stay suspended while hidden');
assert(study.includes('if (!activityPayload || activityDirty) ensureActivityReady()'),
  'first activation must reuse or retry the idle preload request');
assert(graph.includes("data.kind === 'canvas'"), '星图必须识别画布数据结构');
assert(graph.includes('累计 '), '画布星图悬停必须展示累计时长');
assert(i18n.includes("'画布使用时间星图': 'Canvas time constellation'")
  && i18n.includes('canvas') && i18n.includes('canvases'),
  '画布足迹的静态和动态文案必须提供英文');

[
  'CANVAS_ACTIVITY_FILE',
  '"/api/canvas-activity"',
  '"canvasDays"',
  '"canvasEntries"',
  '"canvasStats"',
  '"canvasGraph"',
  '"canvasOverviewGraph"',
].forEach((needle) => assert(backend.includes(needle), '后端画布活动契约缺失：' + needle));

console.log('canvas activity contract checks passed');
