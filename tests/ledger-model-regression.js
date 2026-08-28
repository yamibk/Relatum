const assert = require('assert');
const model = require('../assets/ledger-model.js');

assert.strictEqual(model.parseAmountCents('12.50'), 1250);
assert.strictEqual(model.normalizeMultiplier('000.5800'), '0.58');
assert.strictEqual(model.normalizeMultiplier('10.0000'), '10');
assert.throws(() => model.normalizeMultiplier('1.23456'));

assert.strictEqual(model.effectiveAmountCents({ amountCents: 25, multiplier: '0.58' }), 15n);
assert.strictEqual(model.effectiveAmountCents({ amountCents: 101, multiplier: '1.005' }), 102n);
assert.strictEqual(model.effectiveAmountCents({ amountCents: 1, multiplier: '0.5' }), 1n);
assert.strictEqual(model.effectiveAmountCents({ amountCents: Number.MAX_SAFE_INTEGER,
  multiplier: '1' }), BigInt(Number.MAX_SAFE_INTEGER));
assert.strictEqual(model.effectiveAmountCents({ amountCents: Number.MAX_SAFE_INTEGER,
  multiplier: '1.0001' }), 0n);

const entries = [
  { id: 'a', type: 'expense', amountCents: 25, multiplier: '0.58', ledgerPage: 1,
    date: '2026-08-28', createdAt: '2026-08-28T10:00:00' },
  { id: 'b', type: 'income', amountCents: 101, multiplier: '1.005', ledgerPage: 1,
    date: '2026-08-27', createdAt: '2026-08-27T10:00:00' },
  { id: 'c', type: 'income', amountCents: 500, ledgerPage: 1,
    date: '2026-07-01', createdAt: '2026-07-01T10:00:00' },
  { id: 'd', type: 'expense', amountCents: 900, ledgerPage: 2,
    date: '2026-08-28', createdAt: '2026-08-28T11:00:00' },
];
const ledger = { version: 2, revision: 4, highestPage: 2, pageUnits: {}, entries };
const month = model.derivePayload(ledger, { year: 2026, month: 8, page: 1, viewMode: 'month' });
assert.deepStrictEqual(month.entries.map((entry) => entry.id), ['a', 'b']);
assert.deepStrictEqual(month.summary, {
  incomeCents: 102n, expenseCents: 15n, balanceCents: 87n, count: 2,
});
const cumulative = model.derivePayload(ledger,
  { year: 2026, month: 8, page: 1, viewMode: 'cumulative' });
assert.deepStrictEqual(cumulative.entries.map((entry) => entry.id), ['a', 'b', 'c']);
assert.strictEqual(cumulative.summary.incomeCents, 602n);

// 两笔账目交错成功时，每个响应只合并自己的目标。
const concurrent = JSON.parse(JSON.stringify(ledger));
model.upsertEntry(concurrent, 'a', { ...concurrent.entries[0], note: 'A optimistic' });
model.upsertEntry(concurrent, 'b', { ...concurrent.entries[1], note: 'B optimistic' });
model.upsertEntry(concurrent, 'b', { ...concurrent.entries.find((entry) => entry.id === 'b'), note: 'B saved' });
assert.strictEqual(concurrent.entries.find((entry) => entry.id === 'a').note, 'A optimistic');
model.upsertEntry(concurrent, 'a', { ...concurrent.entries.find((entry) => entry.id === 'a'), note: 'A saved' });
assert.strictEqual(concurrent.entries.find((entry) => entry.id === 'b').note, 'B saved');

// 一笔失败时只回滚该账目，另一笔已成功的增量继续保留。
model.upsertEntry(concurrent, 'a', entries[0]);
assert.strictEqual(concurrent.entries.find((entry) => entry.id === 'b').note, 'B saved');

// 同一账目的连续修改最终保留队列末尾的权威响应。
model.upsertEntry(concurrent, 'a', { ...entries[0], note: 'first optimistic' });
model.upsertEntry(concurrent, 'a', { ...entries[0], note: 'second optimistic' });
model.upsertEntry(concurrent, 'a', { ...entries[0], note: 'second saved' });
assert.strictEqual(concurrent.entries.find((entry) => entry.id === 'a').note, 'second saved');

// 单位保存与账目修改并行时互不覆盖。
model.setPageUnit(concurrent, 1, '积分');
model.upsertEntry(concurrent, 'b', { ...concurrent.entries.find((entry) => entry.id === 'b'), note: 'parallel saved' });
assert.strictEqual(concurrent.pageUnits['1'], '积分');
assert.strictEqual(concurrent.entries.find((entry) => entry.id === 'b').note, 'parallel saved');

assert.deepStrictEqual(model.acceptRevision(concurrent, 5), { valid: true, gap: false });
assert.deepStrictEqual(model.acceptRevision(concurrent, 7), { valid: true, gap: true });
assert.strictEqual(concurrent.revision, 7);
model.setPageUnit(concurrent, 9, '块');
assert.strictEqual(concurrent.highestPage, 9);
model.removeEntry(concurrent, 'd');
assert.strictEqual(concurrent.entries.some((entry) => entry.id === 'd'), false);

console.log('ledger model regression tests passed');
