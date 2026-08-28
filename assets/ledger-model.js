(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelatumLedgerModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAGE_MAX = 99;
  const MULTIPLIER_SCALE = 10000n;
  const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

  function normalizePage(value) {
    const page = Number(value);
    return Number.isInteger(page) && page >= 1 && page <= PAGE_MAX ? page : 1;
  }

  function dateParts(day) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const value = new Date(parts.year, parts.month - 1, parts.day);
    return value.getFullYear() === parts.year && value.getMonth() + 1 === parts.month
      && value.getDate() === parts.day ? parts : null;
  }

  function parseAmountCents(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('请输入有效金额，最多两位小数');
    const parts = raw.split('.');
    const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('请输入大于零的有效金额');
    return cents;
  }

  function normalizeMultiplier(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error('请输入有效倍率，最多四位小数');
    const parts = raw.split('.');
    const integer = parts[0].replace(/^0+(?=\d)/, '') || '0';
    const fraction = (parts[1] || '').replace(/0+$/, '');
    const canonical = fraction ? integer + '.' + fraction : integer;
    const scaled = multiplierScaled(canonical);
    if (scaled <= 0n || scaled > 1000000n * MULTIPLIER_SCALE) {
      throw new Error('倍率必须大于零且不超过 1000000');
    }
    return canonical;
  }

  function multiplierScaled(value) {
    if (value == null || value === '') return MULTIPLIER_SCALE;
    const raw = String(value);
    if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error('倍率格式无效');
    const parts = raw.split('.');
    return BigInt(parts[0]) * MULTIPLIER_SCALE
      + BigInt((parts[1] || '').padEnd(4, '0'));
  }

  function effectiveAmountCents(entry) {
    const amount = entry && entry.amountCents;
    if (!Number.isSafeInteger(amount) || amount <= 0) return 0n;
    let scaled;
    try { scaled = multiplierScaled(entry && entry.multiplier); }
    catch (error) { return 0n; }
    if (scaled <= 0n || scaled > 1000000n * MULTIPLIER_SCALE) return 0n;
    const result = (BigInt(amount) * scaled + MULTIPLIER_SCALE / 2n) / MULTIPLIER_SCALE;
    return result > 0n && result <= MAX_SAFE_CENTS ? result : 0n;
  }

  function entrySort(left, right) {
    return String(right.date).localeCompare(String(left.date))
      || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      || String(right.id || '').localeCompare(String(left.id || ''));
  }

  function derivePayload(ledger, options) {
    const source = ledger && typeof ledger === 'object' ? ledger : null;
    const opts = options || {};
    const page = normalizePage(opts.page);
    const year = Number(opts.year);
    const month = Number(opts.month);
    const cumulative = opts.viewMode === 'cumulative';
    const entries = [];
    (source && Array.isArray(source.entries) ? source.entries : []).forEach((entry) => {
      if (normalizePage(entry.ledgerPage) !== page) return;
      if (!cumulative) {
        const parts = dateParts(entry.date);
        if (!parts || parts.year !== year || parts.month !== month) return;
      }
      entries.push(entry);
    });
    entries.sort(entrySort);
    let incomeCents = 0n;
    let expenseCents = 0n;
    entries.forEach((entry) => {
      const amount = effectiveAmountCents(entry);
      if (entry.type === 'income') incomeCents += amount;
      else expenseCents += amount;
    });
    return {
      version: source && source.version || 2,
      revision: source && Number.isSafeInteger(source.revision) ? source.revision : 0,
      year, month, page,
      highestPage: source ? normalizePage(source.highestPage) : 1,
      scope: cumulative ? 'all' : 'month',
      unit: source && source.pageUnits ? String(source.pageUnits[String(page)] || '') : '',
      summary: { incomeCents, expenseCents, balanceCents: incomeCents - expenseCents,
        count: entries.length },
      entries,
    };
  }

  function recomputeHighestPage(ledger) {
    let highest = 1;
    (ledger && Array.isArray(ledger.entries) ? ledger.entries : []).forEach((entry) => {
      highest = Math.max(highest, normalizePage(entry.ledgerPage));
    });
    Object.keys(ledger && ledger.pageUnits || {}).forEach((page) => {
      highest = Math.max(highest, normalizePage(page));
    });
    if (ledger) ledger.highestPage = highest;
    return highest;
  }

  function upsertEntry(ledger, previousId, entry) {
    if (!ledger || !Array.isArray(ledger.entries) || !entry) return false;
    const index = ledger.entries.findIndex((item) => item.id === previousId);
    if (index >= 0) ledger.entries[index] = entry;
    else ledger.entries.push(entry);
    recomputeHighestPage(ledger);
    return true;
  }

  function removeEntry(ledger, id) {
    if (!ledger || !Array.isArray(ledger.entries)) return false;
    const length = ledger.entries.length;
    ledger.entries = ledger.entries.filter((entry) => entry.id !== id);
    recomputeHighestPage(ledger);
    return ledger.entries.length !== length;
  }

  function setPageUnit(ledger, page, unit) {
    if (!ledger) return false;
    if (!ledger.pageUnits || typeof ledger.pageUnits !== 'object') ledger.pageUnits = {};
    const key = String(normalizePage(page));
    const previous = String(ledger.pageUnits[key] || '');
    if (unit) ledger.pageUnits[key] = String(unit);
    else delete ledger.pageUnits[key];
    recomputeHighestPage(ledger);
    return previous !== String(unit || '');
  }

  function acceptRevision(ledger, value) {
    if (!ledger || !Number.isSafeInteger(value) || value < 0) return { valid: false, gap: true };
    const current = Number.isSafeInteger(ledger.revision) && ledger.revision >= 0 ? ledger.revision : 0;
    ledger.revision = Math.max(current, value);
    return { valid: true, gap: value > current + 1 };
  }

  return {
    PAGE_MAX,
    MULTIPLIER_SCALE,
    MAX_SAFE_CENTS,
    normalizePage,
    dateParts,
    parseAmountCents,
    normalizeMultiplier,
    multiplierScaled,
    effectiveAmountCents,
    entrySort,
    derivePayload,
    recomputeHighestPage,
    upsertEntry,
    removeEntry,
    setPageUnit,
    acceptRevision,
  };
});
