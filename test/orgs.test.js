/* Unit tests for the pure Organisations layer (src/core/orgs.js).
   Data-in/data-out only: no network, no DOM, no store imports — the
   doc initializer, domain matcher, rollups and cascade-unlink must be
   testable in plain node. Same contract as crm.js/links.js/notes.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailDomainOf,
  ensureOrgsData,
  makeOrg,
  matchOrgByDomain,
  normalizeDomain,
  orgActivityFor,
  orgCascadeUnlink,
  orgClients,
  orgDealsFor,
  orgListRow,
  orgNotesFor,
  orgSuggestionFor,
  orgSuggestionsForClients,
} from '../src/core/orgs.js';

/* ---------- AC1: ensureOrgsData zero-loss doc initializer ---------- */

test('ensureOrgsData adds a missing orgs array and nothing else', () => {
  const doc = {
    me: 'm1',
    members: [{ id: 'm1', name: 'Wesley' }],
    ws: { name: 'Operance' },
    clients: [{ id: 'cl1', name: 'Existing client', status: 'active' }],
    deals: [{ id: 'd1', title: 'Existing deal', stage: 'won', value: 100 }],
    notes: [{ id: 'n1', title: 'Note', html: '<p>x</p>', created: 1, updated: 1, pinned: false, attachments: [] }],
    links: [],
    tasks: [],
  };
  const before = JSON.stringify(doc);
  const out = ensureOrgsData(doc);
  assert.equal(out, doc, 'must mutate and return the same doc object');
  assert.deepEqual(out.orgs, []);
  const after = JSON.stringify({ ...doc, orgs: undefined });
  assert.equal(before, after, 'only the orgs array may be added — every other key byte-identical');
  assert.equal(doc.clients.length, 1, 'clients untouched');
  assert.equal(doc.deals[0].org, undefined, 'deals gain no org field from the initializer');
  assert.equal(doc.clients[0].org, undefined, 'clients gain no org field from the initializer');
});

test('ensureOrgsData keeps an existing orgs array by reference (idempotent)', () => {
  const orgs = [makeOrg({ id: 'org1', name: 'Noorderlicht Group', domain: 'noorderlicht.example', created: 1 })];
  const doc = { orgs, clients: [] };
  const out = ensureOrgsData(doc);
  assert.equal(out.orgs, orgs, 'existing array must not be cloned or replaced');
  const again = ensureOrgsData(out);
  assert.equal(again, doc);
  assert.equal(again.orgs, orgs);
});

test('ensureOrgsData replaces corrupt non-array values with an empty array', () => {
  const doc = { orgs: 'oops', clients: [] };
  ensureOrgsData(doc);
  assert.deepEqual(doc.orgs, []);
  const doc2 = { orgs: null };
  ensureOrgsData(doc2);
  assert.deepEqual(doc2.orgs, []);
});

test('ensureOrgsData is null-safe', () => {
  assert.equal(ensureOrgsData(null), null);
  assert.equal(ensureOrgsData(undefined), undefined);
  assert.equal(ensureOrgsData(42), 42);
});

test('ensureOrgsData drops junk rows and repairs corrupt fields (notes-style trust boundary)', () => {
  const doc = {
    orgs: [
      'junk string',
      42,
      null,
      { id: 'org1', name: 'Normal', domain: 'normal.example', industry: 'Tech', notes: '', created: 5 },
      { id: 'org2', name: 7, domain: '  HTTPS://WWW.Case.Test/path  ', industry: null, created: 'nope', extra: 'keep me' },
      { noId: true },
    ],
  };
  ensureOrgsData(doc);
  assert.equal(doc.orgs.length, 3, 'non-object junk rows are dropped, object rows kept (notes contract)');
  const [good, fixed] = doc.orgs;
  assert.equal(good.name, 'Normal');
  assert.deepEqual(Object.keys(good).sort(), ['created', 'domain', 'id', 'industry', 'name', 'notes']);
  assert.equal(fixed.name, '7', 'non-string name coerced honestly');
  assert.equal(fixed.domain, 'case.test', 'domain normalized: protocol, www, case, path stripped');
  assert.equal(fixed.industry, '');
  assert.equal(fixed.created, 0, 'non-numeric created coerced to 0');
  assert.equal(fixed.extra, 'keep me', 'unknown extra fields survive');
});

test('ensureOrgsData keeps well-formed rows byte-identical (zero rewrite)', () => {
  const row = { id: 'org1', name: 'Noorderlicht Group', domain: 'noorderlicht.example', industry: 'Maritime logistics', notes: 'n', created: 123 };
  const doc = { orgs: [row] };
  const before = JSON.stringify(doc);
  ensureOrgsData(doc);
  assert.equal(JSON.stringify(doc), before, 'canonical rows must not change bytes');
  assert.equal(doc.orgs[0], row, 'kept by reference');
});

/* ---------- AC1/AC4: domain normalization + exact matcher ---------- */

test('normalizeDomain strips protocol, www, credentials, port, path, case and whitespace', () => {
  assert.equal(normalizeDomain('Example.COM'), 'example.com');
  assert.equal(normalizeDomain('  https://www.Noorderlicht.Example/over-ons  '), 'noorderlicht.example');
  assert.equal(normalizeDomain('@Noorderlicht.example'), 'noorderlicht.example');
  assert.equal(normalizeDomain('user@noorderlicht.example'), 'noorderlicht.example', 'pasted email in the domain field yields the bare domain');
  assert.equal(normalizeDomain('noorderlicht.example:8080'), 'noorderlicht.example');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
  assert.equal(normalizeDomain(42), '42', 'junk coerced honestly — the matcher compares exact strings');
});

test('emailDomainOf extracts the domain after the @, empty when there is none', () => {
  assert.equal(emailDomainOf('Sanne@VanDerberg-Arch.example'), 'vanderberg-arch.example');
  assert.equal(emailDomainOf('  JONAS@MeridianFitness.example  '), 'meridianfitness.example');
  assert.equal(emailDomainOf('a@b@example.com'), 'example.com', 'last @ wins');
  assert.equal(emailDomainOf('not-an-email'), '');
  assert.equal(emailDomainOf('a@'), '');
  assert.equal(emailDomainOf(''), '');
  assert.equal(emailDomainOf(null), '');
});

test('matchOrgByDomain matches EXACT domains only, case-insensitive', () => {
  const orgs = [
    makeOrg({ id: 'org1', name: 'Noorderlicht Group', domain: 'noorderlicht.example', created: 1 }),
    makeOrg({ id: 'org2', name: 'Case Test', domain: 'Case.Example', created: 2 }),
  ];
  assert.equal(matchOrgByDomain(orgs, 'sanne@NOORDERLICHT.EXAMPLE')?.id, 'org1');
  assert.equal(matchOrgByDomain(orgs, 'femke@case.example')?.id, 'org2');
});

test('matchOrgByDomain refuses subdomain, partial and suffix games', () => {
  const orgs = [makeOrg({ id: 'org1', name: 'Exact Only', domain: 'example.com', created: 1 })];
  assert.equal(matchOrgByDomain(orgs, 'user@mail.example.com'), null, 'subdomain is not an exact match');
  assert.equal(matchOrgByDomain(orgs, 'user@notexample.com'), null, 'suffix sharing is not a match');
  assert.equal(matchOrgByDomain(orgs, 'user@example.com.evil.io'), null, 'the org domain must be the email domain itself');
  assert.equal(matchOrgByDomain(orgs, 'user@example.comx'), null);
  assert.equal(matchOrgByDomain(orgs, 'user@example.com '), orgs[0], 'trailing whitespace on the input is trimmed away');
});

test('matchOrgByDomain tolerates junk inputs', () => {
  assert.equal(matchOrgByDomain([], 'a@b.example'), null);
  assert.equal(matchOrgByDomain(null, 'a@b.example'), null);
  assert.equal(matchOrgByDomain([makeOrg({ id: 'x', name: 'No domain', created: 1 })], 'a@b.example'), null, 'an org without a usable domain never matches');
  assert.equal(matchOrgByDomain([{ id: 'junk', name: 'junk' }], 'a@b.example'), null);
  assert.equal(matchOrgByDomain([makeOrg({ id: 'x', name: 'x', domain: 'b.example', created: 1 })], 'no-at-sign'), null);
});

/* ---------- AC4: suggest + one-click confirm (never silent) ---------- */

test('orgSuggestionFor proposes the org with the match basis shown', () => {
  const orgs = [makeOrg({ id: 'org1', name: 'Noorderlicht Group', domain: 'vanderberg.example', created: 1 })];
  const c = { id: 'cl1', name: 'Sanne', email: 'sanne@vanderberg.example' };
  const sug = orgSuggestionFor(c, orgs);
  assert.ok(sug);
  assert.equal(sug.clientId, 'cl1');
  assert.equal(sug.org.id, 'org1');
  assert.equal(sug.matchedDomain, 'vanderberg.example', 'the UI shows the matched domain as the basis');
});

test('orgSuggestionFor never suggests for a client that already has an org', () => {
  const orgs = [makeOrg({ id: 'org1', name: 'A', domain: 'a.example', created: 1 }), makeOrg({ id: 'org2', name: 'B', domain: 'a.example', created: 2 })];
  const same = { id: 'cl1', name: 'x', email: 'u@a.example', org: 'org1' };
  assert.equal(orgSuggestionFor(same, orgs), null, 'already attached to the matching org');
  const other = { id: 'cl2', name: 'y', email: 'u@a.example', org: 'org9' };
  assert.equal(orgSuggestionFor(other, orgs), null, 'attached elsewhere — the form is the place to change it');
});

test('orgSuggestionsForClients collects suggestions and tolerates junk', () => {
  const orgs = [makeOrg({ id: 'org1', name: 'A', domain: 'a.example', created: 1 })];
  const clients = [
    { id: 'cl1', name: 'x', email: 'u@a.example' },
    { id: 'cl2', name: 'y', email: 'nope' },
    { id: 'cl3', name: 'z', email: 'u@a.example', org: 'org1' },
    'junk',
    null,
  ];
  const sugs = orgSuggestionsForClients(clients, orgs);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].clientId, 'cl1');
  assert.equal(orgSuggestionsForClients(null, orgs).length, 0);
  assert.equal(orgSuggestionsForClients(clients, null).length, 0);
});

/* ---------- AC3: org rollups (contacts / deals / notes / activity) ---------- */

const ORGS = [makeOrg({ id: 'org1', name: 'Noorderlicht Group', domain: 'noorderlicht.example', industry: 'Maritime logistics', created: 1 })];
const CLIENTS = [
  { id: 'cl1', name: 'Van der Berg Architects', email: 'sanne@vanderberg.example', org: 'org1' },
  { id: 'cl2', name: 'Meridian Fitness', email: 'jonas@meridianfitness.example' },
  { id: 'cl3', name: 'Koffie & Co', email: 'femke@koffieco.example', org: 'org1' },
];

test('orgClients returns only clients attached to the org', () => {
  assert.deepEqual(
    orgClients('org1', CLIENTS).map(c => c.id),
    ['cl1', 'cl3'],
  );
  assert.deepEqual(orgClients('nope', CLIENTS), []);
  assert.deepEqual(orgClients('org1', null), []);
});

test('orgDealsFor classifies direct vs derived deals — an explicit other-org deal stays exclusive', () => {
  const deals = [
    { id: 'd1', title: 'Museum wing', client: 'cl1', value: 48000, stage: 'proposal' }, // derived via cl1
    { id: 'd2', title: 'Direct org deal', client: 'cl2', value: 32000, stage: 'lead', org: 'org1' }, // direct
    { id: 'd3', title: 'Via cl3', client: 'cl3', value: 12500, stage: 'qualified' }, // derived via cl3
    { id: 'd4', title: 'Elsewhere', client: 'cl1', value: 500, stage: 'lead', org: 'org9' }, // explicit other org wins
    { id: 'd5', title: 'Unattached', client: 'cl2', value: 700, stage: 'lead' }, // client has no org
    { id: 'd6', title: 'Unknown client', client: 'ghost', value: 100, stage: 'lead' },
  ];
  const rows = orgDealsFor('org1', deals, CLIENTS);
  assert.deepEqual(
    rows.map(r => [r.deal.id, r.derived]),
    [
      ['d1', true],
      ['d2', false],
      ['d3', true],
    ],
    'derived = via a client of the org AND no explicit org of its own',
  );
  assert.equal(orgDealsFor('org1', null, CLIENTS).length, 0);
  assert.equal(orgDealsFor('org1', deals, null).length, 1, 'without clients only direct deals remain');
});

test('orgNotesFor returns notes attached to the org', () => {
  const notes = [
    { id: 'n1', title: 'One', org: 'org1' },
    { id: 'n2', title: 'Two' },
    { id: 'n3', title: 'Three', org: 'org1' },
  ];
  assert.deepEqual(
    orgNotesFor('org1', notes).map(n => n.id),
    ['n1', 'n3'],
  );
  assert.deepEqual(orgNotesFor('org1', null), []);
});

test('orgActivityFor rolls up mail/event links via the org clients, newest first, annotated, non-mutating', () => {
  const links = [
    { id: 'l1', clientId: 'cl1', kind: 'mail', ref: 'm1', title: 'Proposal mail', when: 100 },
    { id: 'l2', clientId: 'cl2', kind: 'mail', ref: 'm2', title: 'Other client mail', when: 400 }, // cl2 not in org
    { id: 'l3', clientId: 'cl3', kind: 'event', ref: 'e1', title: 'Kickoff', when: 300 },
    { id: 'l4', clientId: 'cl1', kind: 'task', ref: 't1', title: 'Task link', when: 500 }, // tasks are not activity here
    { id: 'l5', clientId: 'cl1', kind: 'mail', ref: 'm3', title: 'Older mail', when: 50 },
    { id: 'l6', clientId: 'ghost', kind: 'mail', ref: 'm4', title: 'Dangling', when: 900 },
  ];
  const rows = orgActivityFor('org1', links, CLIENTS);
  assert.deepEqual(
    rows.map(r => r.ref),
    ['e1', 'm1', 'm3'],
    'mail + events via org clients only, newest first; task links and dangling rows excluded',
  );
  assert.equal(rows[0].clientName, 'Koffie & Co', 'rows are annotated with the owning client for the read-only view');
  assert.equal(rows[1].clientName, 'Van der Berg Architects');
  assert.equal(JSON.stringify(links[0].clientName), undefined, 'the input links array is never mutated');
  assert.equal(orgActivityFor('org1', null, CLIENTS).length, 0);
});

test('orgListRow computes contacts count and open-pipeline value per org', () => {
  const deals = [
    { id: 'd1', client: 'cl1', value: 48000, stage: 'proposal' },
    { id: 'd2', client: 'cl2', value: 32000, stage: 'lead', org: 'org1' },
    { id: 'd9', client: 'cl3', value: 999, stage: 'won' },
  ];
  const row = orgListRow(ORGS[0], { clients: CLIENTS, deals });
  assert.equal(row.org.id, 'org1');
  assert.equal(row.contacts, 2);
  assert.equal(row.openValue, 80000, 'direct + derived open deals; won money is not open pipeline');
  assert.equal(row.industry, 'Maritime logistics');
  const emptyRow = orgListRow(makeOrg({ id: 'orgx', name: 'Empty', created: 1 }), { clients: CLIENTS, deals: [] });
  assert.equal(emptyRow.contacts, 0);
  assert.equal(emptyRow.openValue, 0);
});

/* ---------- AC1: cascade-unlink semantics (items are NEVER deleted) ---------- */

test('orgCascadeUnlink clears org=null on the org clients/deals/notes and deletes nothing', () => {
  const doc = {
    clients: [
      { id: 'cl1', name: 'In org', org: 'org1' },
      { id: 'cl2', name: 'No org' },
      { id: 'cl3', name: 'Other org', org: 'org9' },
    ],
    deals: [
      { id: 'd1', title: 'Direct', org: 'org1', client: 'cl1' },
      { id: 'd2', title: 'Derived', client: 'cl1' },
      { id: 'd3', title: 'Other', org: 'org9', client: 'cl3' },
    ],
    notes: [
      { id: 'n1', title: 'In org', org: 'org1' },
      { id: 'n2', title: 'Other', org: 'org9' },
    ],
    orgs: [makeOrg({ id: 'org1', name: 'Doomed', created: 1 })],
  };
  const counts = orgCascadeUnlink(doc, 'org1');
  assert.deepEqual(counts, { clients: 1, deals: 1, notes: 1 });
  assert.equal(doc.clients.length, 3, 'clients are NEVER deleted');
  assert.equal(doc.deals.length, 3, 'deals are NEVER deleted');
  assert.equal(doc.notes.length, 2, 'notes are NEVER deleted');
  assert.equal(doc.orgs.length, 1, 'the org row itself is removed by the caller, not here');
  assert.equal(doc.clients[0].org, null, 'unlinked to null');
  assert.equal(doc.clients[2].org, 'org9', 'other orgs untouched');
  assert.equal(doc.deals[0].org, null);
  assert.equal(doc.deals[1].org, undefined, 'a deal without an org ref is never rewritten by the cascade');
  assert.equal(doc.deals[2].org, 'org9');
  assert.equal(doc.notes[0].org, null);
  assert.equal(doc.notes[1].org, 'org9');
});

test('orgCascadeUnlink is idempotent and junk-safe', () => {
  const doc = { clients: [{ id: 'cl1', org: 'org1' }], deals: 'oops', notes: null };
  assert.deepEqual(orgCascadeUnlink(doc, 'org1'), { clients: 1, deals: 0, notes: 0 });
  assert.deepEqual(orgCascadeUnlink(doc, 'org1'), { clients: 0, deals: 0, notes: 0 }, 'second pass changes nothing');
  assert.deepEqual(orgCascadeUnlink({}, 'org1'), { clients: 0, deals: 0, notes: 0 });
  assert.deepEqual(orgCascadeUnlink(null, 'org1'), { clients: 0, deals: 0, notes: 0 });
  assert.deepEqual(orgCascadeUnlink({ clients: [{}] }, ''), { clients: 0, deals: 0, notes: 0 });
});
