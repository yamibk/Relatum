'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/career/data.js'), 'utf8');
const context = { window: { RelatumI18n: { language: 'zh-CN' } }, document: { documentElement: { lang: 'zh-CN' } }, Intl, Date, Map, Set };
vm.runInNewContext(source.replace(/export /g, '') + '\nthis.project = select;', context);
const report = { history: {
  since: new Date(2026, 0, 1).getTime(), cutoff: new Date(2026, 0, 3).getTime(), coverage: [], events: [], hours: [],
  entities: [{ id: 'a', category: 'notes', name: 'A' }, { id: 'b', category: 'notes', name: 'B', deleted: true }, { id: 'c', category: 'canvas', name: 'Canvas' }],
  archivedNotes: { count: 2 },
  days: [{ date: '2026-01-01', seconds: 60, categories: { notes: 60 } }, { date: '2026-01-02', seconds: 10, categories: { notes: 10 } }],
  entityDays: [{ date: '2026-01-01', id: 'a', category: 'notes', seconds: 30 }, { date: '2026-01-01', id: 'b', category: 'notes', seconds: 30 },
    { date: '2026-01-01', id: 'archive:notes', category: 'notes', seconds: 20 }, { date: '2026-01-02', id: 'archive:notes', category: 'notes', seconds: 10 }],
  noteUsageDays: [{ date: '2026-01-01', archived: 20, unarchived: 30, total: 40 }, { date: '2026-01-02', archived: 10, unarchived: 10, total: 10 }]
} };
const original = JSON.stringify(report), all = context.project(report, { mode: 'all' });
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(all.noteUsage), { available: true, archived: { count: 2, seconds: 30 }, unarchived: { count: 2, seconds: 40 }, all: { count: 4, seconds: 50 } });
assert.notEqual(all.noteUsage.all.seconds, all.noteUsage.archived.seconds+all.noteUsage.unarchived.seconds, 'overlapping archived and unarchived intervals are not added twice');
assert.notEqual(all.noteUsage.all.seconds, all.seconds, 'workspace browsing is excluded');
assert.equal(context.project(report, { mode: 'all' }), all, 'identical projection is reused');
const day = context.project(report, { mode: 'custom', start: '2026-01-02', end: '2026-01-02' });
assert.deepEqual(plain(day.noteUsage), { available: true, archived: { count: 2, seconds: 10 }, unarchived: { count: 2, seconds: 10 }, all: { count: 4, seconds: 10 } });
const empty = context.project(report, { mode: 'custom', start: '2025-01-01', end: '2025-01-01' });
assert.equal(empty.noteUsage.all.seconds, 0); assert.equal(empty.noteUsage.all.count, 4, 'counts describe all statistical identities at generation');
assert.equal(JSON.stringify(report), original, 'frozen report is not mutated');
const legacy = JSON.parse(original); delete legacy.history.noteUsageDays;
const old = context.project(legacy, { mode: 'all' });
assert.equal(old.noteUsage.available, false); assert.equal(old.noteUsage.archived.seconds, 30);
assert.equal(old.noteUsage.unarchived.seconds, null); assert.equal(old.noteUsage.all.seconds, null, 'legacy snapshots do not estimate unions from scalar times');
const zero = JSON.parse(original); zero.history.noteUsageDays = [];
assert.equal(context.project(zero, { mode: 'all' }).noteUsage.all.seconds, 0, 'a known empty aggregate is zero, not unavailable');
console.log('Note usage: counts, date filters, overlap-safe totals, workspace exclusion, old snapshots and immutable projections passed');
