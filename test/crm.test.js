/* Unit tests for the pure CRM layer (src/core/crm.js).
   Data-in/data-out only: no network, no DOM, no store imports — the
   migration, stage math and formatting must be testable in plain node. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRM_STAGES,
  CLIENT_STATUSES,
  activeClientCount,
  dealTotals,
  ensureCrmData,
  eur,
  isKnownStage,
  isValidTransition,
  stageIndex,
} from '../src/core/crm.js';

/* ---------- AC1: ensureCrmData zero-loss migration ---------- */

test('ensureCrmData initialises missing clients/deals arrays on an existing doc', () => {
  const doc = {
    me: 'm1',
    members: [{ id: 'm1', name: 'Wesley' }],
    ws: { name: 'Operance' },
    tasks: [{ id: 't1', title: 'Ship CRM' }],
    projOrder: ['p1'],
  };
  const out = ensureCrmData(doc);
  assert.equal(out, doc, 'must mutate and return the same doc object');
  assert.deepEqual(out.clients, []);
  assert.deepEqual(out.deals, []);
});

test('ensureCrmData leaves every unrelated key byte-for-byte identical', () => {
  const doc = {
    me: 'm1',
    ws: { name: 'Operance', c: '#1D1C1A' },
    tasks: [{ id: 't1', title: 'x', subtasks: [] }],
    comments: [{ id: 'c1' }],
    activity: [{ id: 'a1' }],
    projOrder: ['p1', 'p2'],
    notifs: [],
    prefsLike: { nested: { deep: true } },
  };
  const before = JSON.stringify(doc);
  ensureCrmData(doc);
  const after = JSON.stringify({ ...doc, clients: undefined, deals: undefined });
  assert.equal(before, after, 'only the two arrays may be added');
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.ws.name, 'Operance');
});

test('ensureCrmData keeps existing clients/deals arrays untouched (same reference)', () => {
  const clients = [{ id: 'cl1', name: 'Existing', status: 'active' }];
  const deals = [{ id: 'd1', title: 'Existing deal', stage: 'won', value: 100 }];
  const doc = { clients, deals, tasks: [] };
  const out = ensureCrmData(doc);
  assert.equal(out.clients, clients, 'existing array must not be cloned or replaced');
  assert.equal(out.deals, deals);
  assert.equal(out.clients.length, 1);
  assert.equal(out.deals[0].stage, 'won');
});

test('ensureCrmData replaces corrupt non-array values with empty arrays', () => {
  const doc = { clients: 'oops', deals: null, tasks: [] };
  ensureCrmData(doc);
  assert.deepEqual(doc.clients, []);
  assert.deepEqual(doc.deals, []);
});

test('ensureCrmData is idempotent and null-safe', () => {
  const doc = { tasks: [] };
  const once = ensureCrmData(doc);
  const twice = ensureCrmData(once);
  assert.equal(twice, doc);
  assert.deepEqual(twice.clients, []);
  assert.equal(ensureCrmData(null), null);
  assert.equal(ensureCrmData(undefined), undefined);
});

/* ---------- AC3/AC6: stage order + transition validity ---------- */

test('CRM_STAGES are in the fixed pipeline order lead→qualified→proposal→won→lost', () => {
  assert.deepEqual(
    CRM_STAGES.map(s => s.id),
    ['lead', 'qualified', 'proposal', 'won', 'lost'],
  );
  assert.deepEqual(
    CLIENT_STATUSES.map(s => s.id),
    ['lead', 'active', 'inactive'],
  );
});

test('stageIndex resolves positions and rejects unknown stages', () => {
  assert.equal(stageIndex('lead'), 0);
  assert.equal(stageIndex('won'), 3);
  assert.equal(stageIndex('lost'), 4);
  assert.equal(stageIndex('nope'), -1);
  assert.equal(isKnownStage('proposal'), true);
  assert.equal(isKnownStage('done'), false);
});

test('isValidTransition accepts any move between known stages, rejects unknown/same', () => {
  assert.equal(isValidTransition('lead', 'qualified'), true);
  assert.equal(isValidTransition('proposal', 'lead'), true, 'dragging backwards is allowed');
  assert.equal(isValidTransition('won', 'lost'), true);
  assert.equal(isValidTransition('lead', 'won'), true);
  assert.equal(isValidTransition('lead', 'nope'), false);
  assert.equal(isValidTransition('nope', 'lead'), false);
  assert.equal(isValidTransition(undefined, 'lead'), false);
  assert.equal(isValidTransition('lead', 'lead'), false, 'same stage is not a move');
});

/* ---------- AC4/AC6: deal totals math ---------- */

test('dealTotals sums open pipeline separately from won and lost', () => {
  const deals = [
    { value: 48000, stage: 'proposal' },
    { value: 32000, stage: 'lead' },
    { value: 12500, stage: 'qualified' },
    { value: 8500, stage: 'won' },
    { value: 4000, stage: 'lost' },
  ];
  const t = dealTotals(deals);
  assert.equal(t.openValue, 92500);
  assert.equal(t.openCount, 3);
  assert.equal(t.wonValue, 8500);
  assert.equal(t.wonCount, 1);
  assert.equal(t.lostValue, 4000);
  assert.equal(t.lostCount, 1);
  assert.equal(t.total, 105000);
  assert.equal(t.count, 5);
});

test('dealTotals treats unknown stages as open and tolerates bad values', () => {
  const t = dealTotals([{ value: 100, stage: 'nope' }, { value: '250', stage: 'lead' }, { value: null, stage: 'lead' }, {}]);
  assert.equal(t.openValue, 350);
  assert.equal(t.openCount, 4);
  assert.equal(t.wonValue, 0);
  assert.equal(t.lostValue, 0);
});

test('dealTotals on empty or missing input returns zeroes', () => {
  assert.deepEqual(dealTotals([]), { openValue: 0, openCount: 0, wonValue: 0, wonCount: 0, lostValue: 0, lostCount: 0, total: 0, count: 0 });
  assert.equal(dealTotals(null).openValue, 0);
  assert.equal(dealTotals(undefined).count, 0);
});

test('activeClientCount counts only active clients', () => {
  const clients = [{ status: 'active' }, { status: 'lead' }, { status: 'active' }, { status: 'inactive' }, {}];
  assert.equal(activeClientCount(clients), 2);
  assert.equal(activeClientCount([]), 0);
  assert.equal(activeClientCount(null), 0);
});

/* ---------- AC4/AC6: EUR formatting ---------- */

test('eur formats whole euros with thousands separators', () => {
  assert.equal(eur(0), '€0');
  assert.equal(eur(1250), '€1,250');
  assert.equal(eur(12345.67), '€12,346');
  assert.equal(eur(92500), '€92,500');
  assert.equal(eur(1000000), '€1,000,000');
  assert.equal(eur('nope'), '€0', 'non-numeric values format as zero, not NaN');
});

/* --- value sanitizer (review fix 3) --- */
import { sanitizeDealValue } from '../src/core/crm.js';
test('sanitizeDealValue: accepts normal amounts, clamps negatives and junk to 0', () => {
  assert.equal(sanitizeDealValue('1250'), 1250);
  assert.equal(sanitizeDealValue(92.4), 92);
  assert.equal(sanitizeDealValue(-50), 0);
  assert.equal(sanitizeDealValue('abc'), 0);
  assert.equal(sanitizeDealValue(undefined), 0);
  assert.equal(sanitizeDealValue(0), 0);
});
