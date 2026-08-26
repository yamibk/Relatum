'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const career = read('assets/career-report.js');
const css = read('assets/styles.css');
const i18n = read('assets/i18n.js');
const server = read('app.py');
const agents = read('AGENTS.md');

for (const workspace of ['canvas', 'notes', 'career']) {
  assert(html.includes(`data-start-workspace="${workspace}"`), `${workspace} workspace tab is missing`);
  assert(html.includes(`data-start-workspace-panel="${workspace}"`), `${workspace} workspace panel is missing`);
}
assert(!html.includes('data-start-workspace="blog"'), 'the removed Blog workspace tab must not return');
assert(!html.includes('blog-workspace'), 'the removed Blog workspace panel must be deleted');
assert(!start.includes('blog: 2'), 'workspace ordering must replace Blog with Career');
assert(!css.includes('.blog-workspace') && !css.includes('.blog-placeholder-paper'), 'Blog CSS residue must be removed');

assert(start.includes("script.src = 'career-report.js'"), 'Career runtime must be lazy-loaded');
assert(!html.includes('<script src="career-report.js"'), 'Career runtime must not block start-page parsing');
assert(start.includes("name === 'career'"), 'workspace switch must activate the Career runtime');
assert(start.includes('localStorage.setItem(START_WORKSPACE_KEY, name)'), 'Career workspace must persist like Canvas and Notes');
assert(html.includes('查看我的使用报告'), 'first-run entry action is missing');
assert(career.includes("'/api/career-report'"), 'Career snapshot GET is missing');
assert(career.includes("'/api/career-report-generate'"), 'Career generation POST is missing');
assert(server.includes('CAREER_REPORT_FILE = DATA / "career-report.json"'), 'frozen report file is missing');
assert(server.includes('def load_career_report()'), 'snapshot reader is missing');
assert(server.includes('def generate_career_report()'), 'snapshot generator is missing');
assert(server.includes('if parsed.path == "/api/career-report"'), 'snapshot GET route is missing');
assert(server.includes('if path == "/api/career-report-generate"'), 'generation POST route is missing');
assert(server.includes('_atomic_write_json(CAREER_REPORT_FILE, report)'), 'report replacement must remain atomic');

assert(career.includes("createElementNS(SVG_NS"), 'charts must use native SVG');
assert(career.includes('IntersectionObserver'), 'scroll reveal must be viewport-driven');
assert(career.includes('const SCROLL_IDLE_MS = 120'), 'scroll reveals need an explicit idle window');
assert(career.includes("scroll.addEventListener('scroll', handleScroll, { passive: true })"), 'Career scrolling must stay passive');
assert(career.includes('pendingReveals: new Set()'), 'scroll-time reveals must be queued and coalesced');
assert(career.includes('const NUMBER_TICK_MS = 50'), 'number text updates must be rate-limited');
assert(career.includes('numberJobs: new Map()'), 'visible numbers must share one scheduler');
assert(career.includes('requestAnimationFrame(runNumberFrame)'), 'number updates must use the shared animation frame');
assert(!career.includes('requestAnimationFrame(frame)'), 'per-number animation frame loops must not return');
assert(career.includes("class: 'career-daily-series'"), 'dense daily marks must animate as one series');
assert(!career.includes("cell.style.setProperty('--career-index'"), 'heatmap cells must not each schedule a reveal transition');
assert(css.includes('contain: layout paint style'), 'Career panels must isolate layout and paint invalidation');
assert(css.includes('[data-visible="1"] .career-dot-matrix'), 'dot matrices must reveal as one visual group');
assert(css.includes('[data-visible="1"] .career-heatmap'), 'heatmaps must reveal as one visual group');
assert(career.includes("prefers-reduced-motion: reduce"), 'runtime must respect reduced motion');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), 'Career CSS needs a reduced-motion fallback');
assert(css.includes('.career-workspace [hidden]'), 'Career entry/loading/report states must honor the hidden attribute');
assert(career.includes('Math.max(number(item.canvasSec), number(item.focusSec), number(item.pageSec))'), 'independent timers must not be added into a misleading total');
assert(career.includes("stat(tr('canvasSessions'), report.canvases && report.canvases.spanCount)"), 'overview must replace Focus time with Canvas sessions');
assert(career.includes("value: (item) => number(item.canvasSec)"), 'usage habits must chart monthly Canvas time');
assert(career.includes('notes.inferredModifiedMonths || []'), 'usage habits must reuse frozen note modification months');
assert(career.includes("stat(tr('linkedNotes'), linkedCount)"), 'note maintenance must distinguish linked notes');
assert(career.includes("stat(tr('orphanNotes'), orphanCount)"), 'note maintenance must distinguish unlinked notes');
assert(career.includes("stat(tr('recordDays'), Object.keys(dayMap).length)"), 'check-in and diary dates must use their union');
assert(!career.includes('lineChart(focus.months || []'), 'Focus must not keep a dedicated monthly chart');
assert(!career.includes("Object.entries(review.days || {})"), 'review events must not enter the habit heatmap');
assert(!career.includes("panel(tr('review'), tr('review')"), 'Review must not keep a dedicated report panel');
assert(server.includes('"inferredDays": inferred_days'), 'inferred canvas dates must stay separate from real activity');
assert(!career.includes('fetch(\'http') && !career.includes('fetch("http'), 'Career report must not access remote services');
assert(!career.includes('innerHTML'), 'report rendering must not inject user names through HTML strings');
assert(career.includes('data-career-action="generate"'), 'the only report action must be regeneration');
assert(i18n.includes("'生涯': 'Career'"), 'Career workspace needs an English label');
assert(agents.includes('career-report.json'), 'AGENTS.md must document the frozen report data file');

console.log('career-report-contract: ok');
