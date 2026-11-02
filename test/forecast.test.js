/* Unit tests for the pure forecast engine (src/core/forecast.js).
   Data-in/data-out only: no network, no DOM, no store — the kans model,
   deal-type math, month bucketing and rollups must run in plain node.
   The month window is ALWAYS passed in as `now` — nothing here reads the
   wall clock, so every number below is deterministic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageKans,
  isOpenDeal,
  expectedValue,
  weightedValue,
  realisticPipeline,
  forecastByMonth,
  wonByMonth,
  stageBreakdown,
  orgRollup,
  winRate,
} from '../src/core/forecast.js';

const NOW = '2026-11-15'; /* any parseable now: the engine must not care */

/* ---------- kans model ---------- */

test('stageKans: the 4 categories + terminal stages, unknown stages carry kans 0', () => {
  assert.equal(stageKans('longshot'), 0.01);
  assert.equal(stageKans('mogelijk'), 0.25);
  assert.equal(stageKans('waarschijnlijk'), 0.5);
  assert.equal(stageKans('zeker'), 1);
  assert.equal(stageKans('won'), 1);
  assert.equal(stageKans('lost'), 0);
  assert.equal(stageKans('nope'), 0);
  assert.equal(stageKans(undefined), 0);
});

/* ---------- expected value (deal types) ---------- */

test('expectedValue: project = projectwaarde (total)', () => {
  assert.equal(expectedValue({ type: 'project', value: 48000 }), 48000);
  assert.equal(expectedValue({ value: 48000 }), 48000, 'missing type defaults to project');
  assert.equal(expectedValue({ type: 'project', value: '12500' }), 12500, 'string values coerce');
  assert.equal(expectedValue({ type: 'project', value: 12500.4 }), 12500, 'rounds to whole euros');
});

test('expectedValue: retainer = bedrag per maand × looptijd', () => {
  assert.equal(expectedValue({ type: 'retainer', monthly: 500, months: 12 }), 6000);
  assert.equal(expectedValue({ type: 'retainer', monthly: '750', months: '4' }), 3000);
  assert.equal(expectedValue({ type: 'retainer', monthly: 33.333, months: 3 }), 100, 'float noise rounds');
});

test('expectedValue: invalid or missing inputs are 0, never NaN', () => {
  assert.equal(expectedValue({ type: 'project' }), 0);
  assert.equal(expectedValue({ type: 'project', value: -5 }), 0);
  assert.equal(expectedValue({ type: 'project', value: 'abc' }), 0);
  assert.equal(expectedValue({ type: 'retainer' }), 0, 'missing months');
  assert.equal(expectedValue({ type: 'retainer', monthly: 500 }), 0);
  assert.equal(expectedValue({ type: 'retainer', monthly: 0, months: 12 }), 0);
  assert.equal(expectedValue({ type: 'retainer', monthly: 500, months: 'x' }), 0);
  assert.equal(expectedValue(null), 0);
  assert.equal(expectedValue(undefined), 0);
  assert.equal(expectedValue('junk'), 0);
});

/* ---------- weighted value ---------- */

test('weightedValue = expected × stage kans, rounded to whole euros', () => {
  assert.equal(weightedValue({ value: 48000, stage: 'waarschijnlijk' }), 24000);
  assert.equal(weightedValue({ value: 12500, stage: 'mogelijk' }), 3125);
  assert.equal(weightedValue({ value: 12500, stage: 'longshot' }), 125, '1% of 12.5k is real money');
  assert.equal(weightedValue({ value: 48000, stage: 'zeker' }), 48000, 'zeker stays in the pipeline at 100%');
  assert.equal(weightedValue({ value: 9999, stage: 'waarschijnlijk' }), 5000, '4999.5 rounds to 5000');
});

test('weightedValue: terminal and unknown stages weigh 0; junk-safe', () => {
  assert.equal(weightedValue({ value: 5000, stage: 'lost' }), 0);
  assert.equal(weightedValue({ value: 5000, stage: 'nope' }), 0);
  assert.equal(weightedValue({ value: 'abc', stage: 'mogelijk' }), 0);
  assert.equal(weightedValue(null), 0);
});

test('isOpenDeal: open = everything except won and lost (zeker stays open)', () => {
  assert.equal(isOpenDeal({ stage: 'longshot' }), true);
  assert.equal(isOpenDeal({ stage: 'mogelijk' }), true);
  assert.equal(isOpenDeal({ stage: 'waarschijnlijk' }), true);
  assert.equal(isOpenDeal({ stage: 'zeker' }), true, 'signed contracts keep running in the pipeline');
  assert.equal(isOpenDeal({ stage: 'won' }), false);
  assert.equal(isOpenDeal({ stage: 'lost' }), false);
  assert.equal(isOpenDeal({ stage: 'corrupt' }), true, 'a corrupt stage never hides money');
  assert.equal(isOpenDeal(null), false);
});

test('realisticPipeline sums expected × kans over open deals only', () => {
  const deals = [
    { value: 48000, stage: 'zeker' },
    { value: 12500, stage: 'mogelijk' },
    { value: 8500, stage: 'won' },
    { value: 4000, stage: 'lost' },
  ];
  assert.equal(realisticPipeline(deals), 48000 + 3125);
  assert.equal(realisticPipeline([]), 0);
  assert.equal(realisticPipeline(null), 0);
});

/* ---------- forecast by month ---------- */

test('forecastByMonth buckets open deals by close month across the year boundary', () => {
  const deals = [
    { id: 'd1', type: 'project', value: 48000, stage: 'waarschijnlijk', close: '2026-11-20' },
    { id: 'd2', type: 'retainer', monthly: 500, months: 12, value: 6000, stage: 'mogelijk', close: '2026-12-05' },
    { id: 'd3', type: 'project', value: 12000, stage: 'zeker', close: '2027-01-31' },
    { id: 'd4', type: 'project', value: 10000, stage: 'longshot', close: '2027-05-15' },
    { id: 'd5', type: 'project', value: 7000, stage: 'mogelijk' },
    { id: 'd6', type: 'project', value: 30000, stage: 'waarschijnlijk', close: '2026-10-01' },
    { id: 'd7', type: 'project', value: 8500, stage: 'won', close: '2026-11-01' },
    { id: 'd8', type: 'project', value: 4000, stage: 'lost', close: '2026-12-01' },
  ];
  const fc = forecastByMonth(deals, 7, NOW);
  assert.deepEqual(
    fc.months.map(m => m.key),
    ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05'],
    'current month + next 6, ascending',
  );
  assert.equal(fc.months[0].label, 'Nov 2026');
  assert.deepEqual(fc.months[0], { key: '2026-11', label: 'Nov 2026', count: 1, expected: 48000, weighted: 24000 });
  assert.deepEqual(fc.months[1], { key: '2026-12', label: 'Dec 2026', count: 1, expected: 6000, weighted: 1500 });
  assert.deepEqual(fc.months[2], { key: '2027-01', label: 'Jan 2027', count: 1, expected: 12000, weighted: 12000 });
  assert.deepEqual(fc.months[3], { key: '2027-02', label: 'Feb 2027', count: 0, expected: 0, weighted: 0 });
  assert.deepEqual(fc.months[6], { key: '2027-05', label: 'May 2027', count: 1, expected: 10000, weighted: 100 });
  /* no close date → unscheduled; dated but out of the window → outside */
  assert.deepEqual(fc.unscheduled, { count: 1, expected: 7000, weighted: 1750 });
  assert.deepEqual(fc.outside, { count: 1, expected: 30000, weighted: 15000 });
  /* won and lost deals never enter the forecast */
  assert.equal(fc.months[0].count, 1);
});

test('forecastByMonth: a retainer counts its full expected value in its close month', () => {
  const fc = forecastByMonth([{ type: 'retainer', monthly: 800, months: 6, value: 4800, stage: 'waarschijnlijk', close: '2026-12-10' }], 7, NOW);
  assert.deepEqual(fc.months[1], { key: '2026-12', label: 'Dec 2026', count: 1, expected: 4800, weighted: 2400 });
});

test('forecastByMonth: window edges — first day, last day, day after the window', () => {
  const deals = [
    { value: 100, stage: 'mogelijk', close: '2026-11-01' },
    { value: 200, stage: 'mogelijk', close: '2027-05-31' },
    { value: 400, stage: 'mogelijk', close: '2027-06-01' },
  ];
  const fc = forecastByMonth(deals, 7, NOW);
  assert.equal(fc.months[0].count, 1);
  assert.equal(fc.months[6].count, 1);
  assert.equal(fc.months[6].expected, 200);
  assert.deepEqual(fc.outside, { count: 1, expected: 400, weighted: 100 });
});

test('forecastByMonth: a past close date on an open deal is outside, not unscheduled', () => {
  const fc = forecastByMonth([{ value: 1000, stage: 'zeker', close: '2026-08-01' }], 7, NOW);
  assert.deepEqual(fc.outside, { count: 1, expected: 1000, weighted: 1000 });
  assert.deepEqual(fc.unscheduled, { count: 0, expected: 0, weighted: 0 });
});

test('forecastByMonth: corrupt close strings land in unscheduled, junk-safe', () => {
  const fc = forecastByMonth(
    [
      { value: 1000, stage: 'mogelijk', close: 'garbage' },
      { value: 500, stage: 'mogelijk', close: '2026-99-99' },
    ],
    3,
    NOW,
  );
  assert.equal(fc.unscheduled.count, 1, 'a non-date close behaves like no close');
  assert.equal(fc.outside.count, 1, 'an impossible month is dated but out of the window');
  assert.deepEqual(forecastByMonth(null, 7, NOW).months.length, 7);
  assert.equal(forecastByMonth(null, 7, NOW).unscheduled.count, 0);
  assert.deepEqual(forecastByMonth([], 0, NOW).months, []);
  assert.equal(forecastByMonth([], 0, NOW).outside.count, 0);
});

test('forecastByMonth accepts Date and timestamp now values like the string form', () => {
  const deals = [{ value: 1000, stage: 'mogelijk', close: '2026-11-20' }];
  const a = forecastByMonth(deals, 2, '2026-11-15');
  const b = forecastByMonth(deals, 2, new Date(2026, 10, 15));
  const c = forecastByMonth(deals, 2, new Date(2026, 10, 15).getTime());
  assert.deepEqual(
    a.months.map(m => m.key),
    b.months.map(m => m.key),
  );
  assert.deepEqual(
    a.months.map(m => m.key),
    c.months.map(m => m.key),
  );
  assert.deepEqual(
    forecastByMonth(deals, 2, 'nonsense-now'),
    { months: [], unscheduled: { count: 0, expected: 0, weighted: 0 }, outside: { count: 1, expected: 1000, weighted: 250 } },
    'an unparseable now degenerates to an empty window deterministically',
  );
});

/* ---------- won history ---------- */

test('wonByMonth: last 6 + current months, oldest first, by wonAt', () => {
  const t = s => new Date(s).getTime();
  const deals = [
    { value: 8500, stage: 'won', wonAt: t('2026-07-10T12:00:00') },
    { value: 48000, stage: 'won', wonAt: t('2026-11-02T09:00:00') },
    { value: 5000, stage: 'won', wonAt: t('2025-12-01T09:00:00') },
    { value: 700, stage: 'won' },
    { value: 300, stage: 'mogelijk', wonAt: t('2026-08-01T09:00:00') },
  ];
  const rows = wonByMonth(deals, 6, NOW);
  assert.deepEqual(
    rows.map(r => r.key),
    ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'],
  );
  assert.deepEqual(rows[1], { key: '2026-07', label: 'Jul 2026', count: 1, value: 8500 });
  assert.deepEqual(rows[5], { key: '2026-11', label: 'Nov 2026', count: 1, value: 48000 });
  assert.equal(rows[0].count, 0);
  assert.equal(rows[2].count, 0, 'a stale wonAt on a non-won deal never counts');
  assert.equal(rows[3].count, 0, 'won deals without wonAt are not placed (legacy rows stay out of history)');
});

test('wonByMonth: empty and junk-safe', () => {
  assert.deepEqual(wonByMonth([], 6, NOW), wonByMonth(null, 6, NOW));
  const rows = wonByMonth(null, 6, NOW);
  assert.equal(rows.length, 6);
  assert.equal(
    rows.every(r => r.count === 0 && r.value === 0),
    true,
  );
});

/* ---------- stage breakdown ---------- */

test('stageBreakdown: the 4 categories + won + lost, value / count / kans / weighted', () => {
  const deals = [
    { value: 48000, stage: 'zeker' },
    { value: 12500, stage: 'mogelijk' },
    { value: 7000, stage: 'mogelijk' },
    { value: 8500, stage: 'won' },
    { value: 4000, stage: 'lost' },
    { value: 100, stage: 'weird' },
  ];
  const rows = stageBreakdown(deals);
  assert.deepEqual(
    rows.map(r => r.id),
    ['longshot', 'mogelijk', 'waarschijnlijk', 'zeker', 'won', 'lost', 'unknown'],
    'methodology order, plus an honest row when corrupt stages exist',
  );
  const m = rows.find(r => r.id === 'mogelijk');
  assert.deepEqual(
    { id: m.id, name: m.name, kans: m.kans, count: m.count, expected: m.expected, weighted: m.weighted },
    {
      id: 'mogelijk',
      name: 'Mogelijk',
      kans: 0.25,
      count: 2,
      expected: 19500,
      weighted: 4875,
    },
  );
  const z = rows.find(r => r.id === 'zeker');
  assert.deepEqual({ count: z.count, expected: z.expected, weighted: z.weighted }, { count: 1, expected: 48000, weighted: 48000 });
  const l = rows.find(r => r.id === 'lost');
  assert.deepEqual({ count: l.count, weighted: l.weighted }, { count: 1, weighted: 0 });
  const u = rows.find(r => r.id === 'unknown');
  assert.deepEqual(
    { name: u.name, kans: u.kans, count: u.count, expected: u.expected, weighted: u.weighted },
    {
      name: 'Onbekend',
      kans: 0,
      count: 1,
      expected: 100,
      weighted: 0,
    },
  );
});

test('stageBreakdown: no unknown row when every stage is known; empty input', () => {
  assert.deepEqual(stageBreakdown([{ value: 5, stage: 'zeker' }]).length, 6);
  assert.deepEqual(stageBreakdown([]).length, 6);
  assert.equal(stageBreakdown(null).length, 6);
  assert.equal(
    stageBreakdown(null).every(r => r.count === 0),
    true,
  );
});

/* ---------- per-organisation rollup ---------- */

test('orgRollup: open weighted per org (direct + derived), sorted descending', () => {
  const orgs = [{ id: 'o1', name: 'A BV' }, { id: 'o2', name: 'B BV' }, null, { name: 'No id' }];
  const clients = [{ id: 'cl1', org: 'o1' }, { id: 'cl2' }, { id: 'cl3', org: 'o2' }];
  const deals = [
    { id: 'd1', org: 'o1', value: 48000, stage: 'waarschijnlijk' },
    { id: 'd2', client: 'cl1', value: 12000, stage: 'zeker' },
    { id: 'd3', org: 'o2', value: 50000, stage: 'mogelijk' },
    { id: 'd4', client: 'cl1', org: 'o9', value: 999, stage: 'waarschijnlijk' },
    { id: 'd5', client: 'cl2', value: 700, stage: 'mogelijk' },
    { id: 'd6', org: 'o1', value: 8500, stage: 'won' },
  ];
  const rows = orgRollup(orgs, deals, clients);
  assert.equal(rows.length, 2, 'junk orgs are dropped');
  const [a, b] = rows;
  assert.equal(a.org.id, 'o1');
  assert.deepEqual(
    { contacts: a.contacts, deals: a.deals, openExpected: a.openExpected, openWeighted: a.openWeighted },
    {
      contacts: 1,
      deals: 2,
      openExpected: 60000,
      openWeighted: 36000,
    },
  );
  assert.deepEqual({ orgId: b.org.id, openWeighted: b.openWeighted }, { orgId: 'o2', openWeighted: 12500 });
});

test('orgRollup: ties sort by name, empty inputs, zero division of nothing', () => {
  const rows = orgRollup(
    [
      { id: 'b', name: 'B' },
      { id: 'a', name: 'A' },
    ],
    [],
    [],
  );
  assert.deepEqual(
    rows.map(r => r.org.id),
    ['a', 'b'],
    'equal weighted (0) falls back to name order',
  );
  assert.equal(orgRollup(null, null, null).length, 0);
});

/* ---------- win rate ---------- */

test('winRate: gewonnen / (gewonnen + verloren), zero-division safe', () => {
  assert.deepEqual(winRate([{ stage: 'won' }, { stage: 'won' }, { stage: 'lost' }]), { won: 2, lost: 1, rate: 2 / 3 });
  assert.deepEqual(winRate([]), { won: 0, lost: 0, rate: 0 });
  assert.deepEqual(winRate(null), { won: 0, lost: 0, rate: 0 });
  assert.deepEqual(winRate([{ stage: 'mogelijk' }, { stage: 'zeker' }]), { won: 0, lost: 0, rate: 0 }, 'open deals do not count');
  assert.deepEqual(winRate([{ stage: 'lost' }]), { won: 0, lost: 1, rate: 0 });
});

/* Review findings: months must FLOOR consistently (form line vs submit),
   and absurd inputs must not overflow to Infinity (serializes to null). */
test('expectedValue — fractional months floor, matching the submit path (100 × 2.5 mnd = 200, not 250)', () => {
  assert.equal(expectedValue({ type: 'retainer', monthly: 100, months: 2.5 }), 200);
  assert.equal(expectedValue({ type: 'retainer', monthly: 100, months: 2.9 }), 200);
  assert.equal(expectedValue({ type: 'retainer', monthly: 100, months: 0.9 }), 0);
});
test('expectedValue — overflow guard: absurd amounts clamp to 0 instead of Infinity', () => {
  assert.equal(expectedValue({ type: 'retainer', monthly: 1e308, months: 10 }), 0);
  assert.equal(expectedValue({ type: 'project', value: 1e308 }), 1e308);
  assert.equal(weightedValue({ type: 'retainer', monthly: 1e308, months: 10, stage: 'zeker' }), 0);
});
