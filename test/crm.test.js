/* Unit tests for the pure CRM layer (src/core/crm.js).
   Data-in/data-out only: no network, no DOM, no store imports — the
   migration, stage math and formatting must be testable in plain node. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRM_STAGES,
  CLIENT_STATUSES,
  clientCompany,
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

/* ---------- AC1: legacy stage normalization (zero-loss) ---------- */

test('ensureCrmData normalizes legacy stage ids: lead/qualified→mogelijk, proposal→waarschijnlijk', () => {
  const doc = {
    deals: [
      { id: 'd1', stage: 'lead', value: 100 },
      { id: 'd2', stage: 'qualified', value: 200 },
      { id: 'd3', stage: 'proposal', value: 300 },
      { id: 'd4', stage: 'won', value: 400 },
      { id: 'd5', stage: 'lost', value: 500 },
      { id: 'd6', stage: 'zeker', value: 600 },
      { id: 'd7', stage: 'weird', value: 700 },
      null,
    ],
  };
  ensureCrmData(doc);
  assert.deepEqual(
    doc.deals.map(d => (d ? d.stage : null)),
    ['mogelijk', 'mogelijk', 'waarschijnlijk', 'won', 'lost', 'zeker', 'weird', null],
    'only the three legacy ids remap; won/lost/unknown and junk rows are untouched',
  );
});

test('ensureCrmData normalization is zero-loss: untouched deals keep their reference, remapped deals keep every other field', () => {
  const kept = { id: 'd9', stage: 'won', value: 1, notes: 'x' };
  const legacy = { id: 'd8', stage: 'lead', value: 5, close: '2026-11-01', org: 'o1', owner: 'm1' };
  const doc = { deals: [kept, legacy] };
  ensureCrmData(doc);
  assert.equal(doc.deals[0], kept, 'non-legacy deals stay the same object');
  const remapped = doc.deals[1];
  assert.notEqual(remapped, legacy, 'the remapped row is a new object');
  assert.equal(remapped.stage, 'mogelijk');
  assert.deepEqual(Object.keys(remapped).sort(), ['close', 'id', 'org', 'owner', 'stage', 'value'], 'no fields added or dropped');
  assert.equal(remapped.value, 5);
  assert.equal(remapped.close, '2026-11-01');
  assert.equal(remapped.org, 'o1');
  assert.equal(remapped.owner, 'm1');
});

test('ensureCrmData normalization is idempotent and skips clean docs without touching the array', () => {
  const deals = [
    { id: 'd1', stage: 'mogelijk' },
    { id: 'd2', stage: 'zeker' },
  ];
  const doc = { deals };
  const out = ensureCrmData(doc);
  assert.equal(out.deals, deals, 'a clean doc keeps the array by reference');
  const snap = JSON.stringify(doc.deals);
  ensureCrmData(doc);
  assert.equal(JSON.stringify(doc.deals), snap);
});

/* ---------- AC1: the 4-category kans methodology (verbatim from the user's table) ---------- */

test('CRM_STAGES are the methodology stages longshot→mogelijk→waarschijnlijk→zeker→won→lost', () => {
  assert.deepEqual(
    CRM_STAGES.map(s => s.id),
    ['longshot', 'mogelijk', 'waarschijnlijk', 'zeker', 'won', 'lost'],
  );
  assert.deepEqual(
    CLIENT_STATUSES.map(s => s.id),
    ['lead', 'active', 'inactive'],
    'client statuses are a separate vocabulary and unchanged',
  );
});

test('every stage carries name + kans + betekenis/fase/focus', () => {
  const byId = Object.fromEntries(CRM_STAGES.map(s => [s.id, s]));
  assert.deepEqual(
    ['longshot', 'mogelijk', 'waarschijnlijk', 'zeker'].map(id => [byId[id].name, byId[id].kans]),
    [
      ['Long shot', 0.01],
      ['Mogelijk', 0.25],
      ['Waarschijnlijk', 0.5],
      ['Zeker', 1],
    ],
  );
  assert.equal(byId.won.name, 'Gewonnen');
  assert.equal(byId.lost.name, 'Verloren');
  assert.equal(byId.won.kans, 1);
  assert.equal(byId.lost.kans, 0);
  for (const s of CRM_STAGES)
    for (const k of ['betekenis', 'fase', 'focus']) {
      assert.equal(typeof s[k], 'string', `${s.id}.${k} is a string`);
      assert.ok(s[k].length > 0, `${s.id}.${k} is not empty`);
    }
});

test('the 4 categories carry the exact verbatim methodology strings', () => {
  const byId = Object.fromEntries(CRM_STAGES.map(s => [s.id, s]));
  assert.equal(byId.longshot.betekenis, 'Dreamklant of koude lead: interessant, maar (nog) geen echt contact');
  assert.equal(byId.longshot.fase, 'Geïdentificeerd / eerste contact');
  assert.equal(byId.longshot.focus, 'Ingang zoeken, warm maken via netwerk/content');
  assert.equal(byId.mogelijk.betekenis, 'In gesprek, behoefte verkend, maar nog geen voorstel of duidelijk budget');
  assert.equal(byId.mogelijk.fase, 'Kennismaking / verkenning');
  assert.equal(byId.mogelijk.focus, 'Behoefte scherp krijgen, voorstel voorbereiden');
  assert.equal(byId.waarschijnlijk.betekenis, 'Concrete behoefte, budget en beslisser bekend; voorstel ligt er of is in onderhandeling');
  assert.equal(byId.waarschijnlijk.fase, 'Offerte/SOW uitgebracht');
  assert.equal(byId.waarschijnlijk.focus, 'Opvolgen, bezwaren wegnemen, closen');
  assert.equal(byId.zeker.betekenis, 'Getekend of bestaande klant met lopende opdracht/retainer');
  assert.equal(byId.zeker.fase, 'Opdracht/contract rond');
  assert.equal(byId.zeker.focus, 'Leveren, uitbreiden, referentie vragen');
});

test('stageIndex resolves methodology positions and rejects unknown stages', () => {
  assert.equal(stageIndex('longshot'), 0);
  assert.equal(stageIndex('mogelijk'), 1);
  assert.equal(stageIndex('waarschijnlijk'), 2);
  assert.equal(stageIndex('zeker'), 3);
  assert.equal(stageIndex('won'), 4);
  assert.equal(stageIndex('lost'), 5);
  assert.equal(stageIndex('nope'), -1);
  assert.equal(isKnownStage('waarschijnlijk'), true);
  assert.equal(isKnownStage('lead'), false, 'legacy ids are no longer pipeline stages');
  assert.equal(isKnownStage('done'), false);
});

test('isValidTransition accepts any move between known stages, rejects unknown/same', () => {
  assert.equal(isValidTransition('longshot', 'mogelijk'), true);
  assert.equal(isValidTransition('waarschijnlijk', 'longshot'), true, 'dragging backwards is allowed');
  assert.equal(isValidTransition('zeker', 'won'), true, 'zeker → Gewonnen is the afgerond move');
  assert.equal(isValidTransition('won', 'lost'), true);
  assert.equal(isValidTransition('zeker', 'mogelijk'), true, 'a signed contract can reopen');
  assert.equal(isValidTransition('longshot', 'won'), true);
  assert.equal(isValidTransition('longshot', 'nope'), false);
  assert.equal(isValidTransition('nope', 'longshot'), false);
  assert.equal(isValidTransition(undefined, 'longshot'), false);
  assert.equal(isValidTransition('longshot', 'longshot'), false, 'same stage is not a move');
});

/* ---------- AC4/AC6: deal totals math ---------- */

test('dealTotals sums open pipeline separately from won and lost', () => {
  const deals = [
    { value: 48000, stage: 'waarschijnlijk' },
    { value: 32000, stage: 'mogelijk' },
    { value: 12500, stage: 'zeker' },
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
  const t = dealTotals([{ value: 100, stage: 'nope' }, { value: '250', stage: 'longshot' }, { value: null, stage: 'mogelijk' }, {}]);
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

/* clientCompany: the org is the single affiliation; legacy company strings
   render only as a read-only fallback (pre-org clients). */
test('clientCompany — org name wins over legacy company', () => {
  const orgs = [{ id: 'org1', name: 'Noorderlicht Group' }];
  const c = { name: 'Sanne', company: 'Old Co', orgs: ['org1'] };
  assert.equal(clientCompany(c, orgs), 'Noorderlicht Group');
});
test('clientCompany — legacy company is the fallback when no org', () => {
  assert.equal(clientCompany({ name: 'Sanne', company: 'Old Co', org: null }, [{ id: 'org1', name: 'X' }]), 'Old Co');
  assert.equal(clientCompany({ name: 'Sanne', company: 'Old Co' }, []), 'Old Co');
});
test('clientCompany — empty when neither, junk-safe, missing org id', () => {
  assert.equal(clientCompany({ name: 'Sanne' }, []), '');
  assert.equal(clientCompany(null, []), '');
  assert.equal(clientCompany({ company: 'Old', org: 'gone' }, [{ id: 'org1', name: 'X' }]), 'Old');
  assert.equal(clientCompany({ org: 'gone' }, [null, {}]), '');
});

/* T11 multi-org: client.orgs is the source of truth; legacy org migrates. */
test('ensureCrmData — legacy single org migrates to orgs array, org key removed, value moved', () => {
  const doc = { clients: [{ id: 'c1', name: 'Rick', org: 'org1' }], deals: [] };
  ensureCrmData(doc);
  assert.deepEqual(doc.clients[0].orgs, ['org1']);
  assert.equal('org' in doc.clients[0], false);
});
test('ensureCrmData — junk org drops to empty orgs; existing orgs untouched; idempotent', () => {
  const doc = {
    clients: [
      { id: 'c1', org: 42 },
      { id: 'c2', orgs: ['a', 'b'] },
    ],
    deals: [],
  };
  ensureCrmData(doc);
  assert.deepEqual(doc.clients[0].orgs, []);
  assert.equal('org' in doc.clients[0], false);
  assert.deepEqual(doc.clients[1].orgs, ['a', 'b']);
  const before = JSON.stringify(doc);
  ensureCrmData(doc);
  assert.equal(JSON.stringify(doc), before);
});
test('clientCompany — multiple orgs join with " · "; legacy company only when no orgs', () => {
  const orgs = [
    { id: 'o1', name: 'Alpha' },
    { id: 'o2', name: 'Beta' },
  ];
  assert.equal(clientCompany({ orgs: ['o2', 'o1'] }, orgs), 'Beta · Alpha');
  assert.equal(clientCompany({ orgs: [], company: 'Old Co' }, orgs), 'Old Co');
  assert.equal(clientCompany({ orgs: ['gone'] }, orgs), '');
});
