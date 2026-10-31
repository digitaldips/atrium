/* Unit tests for the pure CRM-linkage layer (src/core/links.js).
   Data-in/data-out only: no network, no DOM, no store imports — the link
   store initializer, auto-link matcher, dedupe and prefill builders must
   be testable in plain node. The links[] rows live inside the workspace
   document: { id, clientId, kind 'mail'|'event'|'task', ref, title, when,
   snippet }. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_KINDS,
  ensureDocShape,
  eventFromTask,
  findLink,
  linksForClient,
  linkedClientIdForTask,
  mailFromTask,
  mailSuggestion,
  makeLinkRow,
  matchClientByEmail,
  removeLink,
  taskFromMail,
  upsertLink,
} from '../src/core/links.js';

const CLIENTS = [
  { id: 'cl1', name: 'Van der Berg Architects', email: 'sanne@vanderberg-arch.example' },
  { id: 'cl2', name: 'Meridian Fitness', email: 'Jonas@MeridianFitness.example' },
  { id: 'cl3', name: 'Koffie & Co', email: 'femke@koffieco.example' },
];

const msg = (id, email, extra = {}) => ({
  id,
  from: 'Sanne',
  email,
  subject: 'Museum wing timing',
  snippet: 'Can we move the walkthrough to Tuesday?',
  date: 1700000000000,
  webLink: 'https://mail.google.com/mail/u/0/#inbox/' + id,
  ...extra,
});

/* ---------- AC1: ensureDocShape zero-loss initializer ---------- */

test('ensureDocShape adds a links array to a doc without one', () => {
  const doc = { me: 'm1', clients: [{ id: 'cl1' }], tasks: [] };
  const out = ensureDocShape(doc);
  assert.equal(out, doc, 'must mutate and return the same doc object');
  assert.deepEqual(out.links, []);
});

test('ensureDocShape leaves every existing key byte-for-byte identical', () => {
  const doc = {
    me: 'm1',
    ws: { name: 'Operance', c: '#1D1C1A' },
    clients: [{ id: 'cl1', name: 'Existing', status: 'active' }],
    deals: [{ id: 'd1', value: 48000, stage: 'proposal' }],
    tasks: [{ id: 't1', title: 'x', subtasks: [], labels: [] }],
    comments: [{ id: 'c1' }],
    activity: [{ id: 'a1' }],
    projOrder: ['p1'],
  };
  const before = JSON.stringify(doc);
  ensureDocShape(doc);
  const after = JSON.stringify({ ...doc, links: undefined });
  assert.equal(before, after, 'only the links array may be added');
  assert.equal(doc.clients.length, 1);
  assert.equal(doc.deals[0].value, 48000);
  assert.equal(doc.ws.name, 'Operance');
});

test('ensureDocShape keeps an existing links array by reference, untouched', () => {
  const links = [{ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'm1', title: 'Hi', when: 1, snippet: 's' }];
  const doc = { clients: [], deals: [], links };
  const out = ensureDocShape(doc);
  assert.equal(out.links, links, 'existing array must not be cloned or replaced');
  assert.equal(out.links.length, 1);
  assert.equal(out.links[0].ref, 'm1');
});

test('ensureDocShape replaces corrupt non-array links with an empty array', () => {
  const doc = { clients: [], deals: [], links: 'oops' };
  ensureDocShape(doc);
  assert.deepEqual(doc.links, []);
});

test('ensureDocShape is idempotent and null-safe', () => {
  const doc = { tasks: [] };
  const once = ensureDocShape(doc);
  const twice = ensureDocShape(once);
  assert.equal(twice, doc);
  assert.deepEqual(twice.links, []);
  assert.equal(ensureDocShape(null), null);
  assert.equal(ensureDocShape(undefined), undefined);
});

/* ---------- AC2: auto-link matcher (exact, case-insensitive, none) ---------- */

test('matchClientByEmail matches an exact address case-insensitively', () => {
  assert.equal(matchClientByEmail(CLIENTS, 'sanne@vanderberg-arch.example').id, 'cl1');
  assert.equal(matchClientByEmail(CLIENTS, 'SANNE@VANDERBERG-ARCH.EXAMPLE').id, 'cl1');
  assert.equal(matchClientByEmail(CLIENTS, '  Jonas@meridianfitness.example ').id, 'cl2');
});

test('matchClientByEmail refuses fuzzy, partial or missing matches', () => {
  assert.equal(matchClientByEmail(CLIENTS, 'someone@vanderberg-arch.example'), null, 'same domain is NOT a match');
  assert.equal(matchClientByEmail(CLIENTS, 'sanne@vanderberg-arch.example@mail.com'), null);
  assert.equal(matchClientByEmail(CLIENTS, 'sanne'), null);
  assert.equal(matchClientByEmail(CLIENTS, ''), null);
  assert.equal(matchClientByEmail(CLIENTS, null), null);
  assert.equal(matchClientByEmail(CLIENTS, undefined), null);
  assert.equal(matchClientByEmail([], 'sanne@vanderberg-arch.example'), null);
  assert.equal(matchClientByEmail(null, 'sanne@vanderberg-arch.example'), null);
});

test('mailSuggestion proposes the client for a matching, unlinked message', () => {
  const links = [];
  const s = mailSuggestion(links, CLIENTS, msg('g1', 'Sanne@Vanderberg-arch.Example'));
  assert.ok(s, 'a matching address must suggest');
  assert.equal(s.clientId, 'cl1');
  assert.equal(s.matchedEmail, 'sanne@vanderberg-arch.example');
});

test('mailSuggestion stays silent when the message is already linked', () => {
  const links = [{ id: 'lk1', clientId: 'cl3', kind: 'mail', ref: 'g1', title: 't', when: 1, snippet: '' }];
  assert.equal(mailSuggestion(links, CLIENTS, msg('g1', 'sanne@vanderberg-arch.example')), null, 'kind+ref already linked');
});

test('mailSuggestion stays silent without an exact match or a real message', () => {
  assert.equal(mailSuggestion([], CLIENTS, msg('g2', 'noreply@unknown.example')), null);
  assert.equal(mailSuggestion([], CLIENTS, msg('g2', '')), null);
  assert.equal(mailSuggestion([], CLIENTS, null), null);
  assert.equal(mailSuggestion([], CLIENTS, { id: 'g2' }), null, 'message without an address never suggests');
});

/* ---------- link rows: validation, dedupe, lookup ---------- */

test('makeLinkRow builds a normalized row and rejects invalid input', () => {
  const row = makeLinkRow({ id: 'lk9', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'Hi', when: 5, snippet: 's' });
  assert.deepEqual(row, { id: 'lk9', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'Hi', when: 5, snippet: 's' });
  assert.equal(makeLinkRow({ id: 'x', clientId: 'cl1', kind: 'note', ref: 'g1' }), null, 'unknown kind');
  assert.equal(makeLinkRow({ id: 'x', clientId: '', kind: 'mail', ref: 'g1' }), null, 'no client');
  assert.equal(makeLinkRow({ id: 'x', clientId: 'cl1', kind: 'mail', ref: '' }), null, 'no ref');
  assert.equal(makeLinkRow(null), null);
});

test('upsertLink dedupes clientId+kind+ref (no duplicate rows)', () => {
  const a = makeLinkRow({ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'First', when: 1, snippet: '' });
  const b = makeLinkRow({ id: 'lk2', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'Second', when: 2, snippet: '' });
  const out = upsertLink(upsertLink([], a), b);
  assert.equal(out.length, 1, 'same clientId+kind+ref must not duplicate');
  assert.equal(out[0].title, 'Second', 'the newer row wins');
  assert.equal(out[0].id, 'lk2');
});

test('upsertLink keeps kind+ref unique across clients (moving removes the old row)', () => {
  const a = makeLinkRow({ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'First', when: 1, snippet: '' });
  const b = makeLinkRow({ id: 'lk2', clientId: 'cl2', kind: 'mail', ref: 'g1', title: 'Moved', when: 2, snippet: '' });
  const out = upsertLink(upsertLink([], a), b);
  assert.equal(out.length, 1, 'a gmail message can link to at most ONE client');
  assert.equal(out[0].clientId, 'cl2');
});

test('upsertLink keeps other rows and different kinds untouched', () => {
  const links = [
    makeLinkRow({ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'A', when: 1, snippet: '' }),
    makeLinkRow({ id: 'lk2', clientId: 'cl1', kind: 'task', ref: 't1', title: 'B', when: 2, snippet: '' }),
  ];
  const add = makeLinkRow({ id: 'lk3', clientId: 'cl1', kind: 'mail', ref: 'g2', title: 'C', when: 3, snippet: '' });
  const out = upsertLink(links, add);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(r => r.id).sort(), ['lk1', 'lk2', 'lk3']);
  assert.equal(upsertLink(links, null), links, 'a null row changes nothing');
  assert.deepEqual(
    out.find(r => r.id === 'lk2'),
    links[1],
  );
});

test('findLink and removeLink work on kind+ref', () => {
  const links = [
    makeLinkRow({ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'A', when: 1, snippet: '' }),
    makeLinkRow({ id: 'lk2', clientId: 'cl1', kind: 'task', ref: 't1', title: 'B', when: 2, snippet: '' }),
  ];
  assert.equal(findLink(links, 'mail', 'g1').id, 'lk1');
  assert.equal(findLink(links, 'mail', 'gX'), null);
  const after = removeLink(links, 'mail', 'g1');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'lk2');
  assert.equal(links.length, 2, 'removeLink is pure — the input array is untouched');
  assert.deepEqual(removeLink(links, 'mail', 'gX'), links);
});

test('linksForClient filters by client and sorts newest-first (missing when last)', () => {
  const links = [
    makeLinkRow({ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'Old', when: 100, snippet: '' }),
    makeLinkRow({ id: 'lk2', clientId: 'cl2', kind: 'mail', ref: 'g2', title: 'Other client', when: 500, snippet: '' }),
    makeLinkRow({ id: 'lk3', clientId: 'cl1', kind: 'event', ref: 'e1', title: 'New', when: 300, snippet: '' }),
    makeLinkRow({ id: 'lk4', clientId: 'cl1', kind: 'task', ref: 't1', title: 'No when', snippet: '' }),
    makeLinkRow({ id: 'lk5', clientId: 'cl1', kind: 'mail', ref: 'g3', title: 'Newest', when: 900, snippet: '' }),
  ];
  const all = linksForClient(links, 'cl1');
  assert.deepEqual(
    all.map(r => r.id),
    ['lk5', 'lk3', 'lk1', 'lk4'],
    'newest first, missing when sorts last',
  );
  const mail = linksForClient(links, 'cl1', 'mail');
  assert.deepEqual(
    mail.map(r => r.id),
    ['lk5', 'lk1'],
  );
  assert.deepEqual(linksForClient(links, 'clX'), []);
  assert.deepEqual(linksForClient(null, 'cl1'), []);
});

test('linkedClientIdForTask returns the client of a task link', () => {
  const links = [makeLinkRow({ id: 'lk1', clientId: 'cl2', kind: 'task', ref: 't7', title: 'T', when: 1, snippet: '' })];
  assert.equal(linkedClientIdForTask(links, 't7'), 'cl2');
  assert.equal(linkedClientIdForTask(links, 't8'), null);
  assert.equal(linkedClientIdForTask([], 't7'), null);
});

test('LINK_KINDS vocabulary is fixed', () => {
  assert.deepEqual(LINK_KINDS, ['mail', 'event', 'task']);
});

/* ---------- AC4: task-from-mail prefill builder ---------- */

test('taskFromMail prefills title, notes and the gmail ref', () => {
  const p = taskFromMail(msg('g1', 'sanne@x.example'), 'cl1');
  assert.equal(p.title, 'Museum wing timing');
  assert.ok(p.notes.includes('Can we move the walkthrough to Tuesday?'), 'notes carry the snippet');
  assert.ok(p.notes.includes('https://mail.google.com/mail/u/0/#inbox/g1'), 'notes carry the webLink');
  assert.deepEqual(p.gmail, { id: 'g1', webLink: 'https://mail.google.com/mail/u/0/#inbox/g1', subject: 'Museum wing timing' });
  assert.equal(p.linkClientId, 'cl1');
});

test('taskFromMail degrades honestly on sparse messages and no client', () => {
  const p = taskFromMail({ id: 'g2', subject: '(no subject)', from: 'Femke', snippet: '', webLink: '' }, null);
  assert.equal(p.title, 'Email from Femke', '(no subject) falls back to the sender');
  assert.equal(p.notes, '', 'no snippet and no webLink → empty notes');
  assert.deepEqual(p.gmail, { id: 'g2', webLink: '', subject: '(no subject)' });
  assert.equal(p.linkClientId, null);
  assert.equal(taskFromMail(null, 'cl1').title, 'Email from Gmail', 'a missing message still yields a usable prefill');
});

/* ---------- AC5: mail-from-task and event-from-task prefill builders ---------- */

const T = {
  id: 't1',
  key: 'ATR-1',
  title: 'Send proposal to Koffie & Co',
  status: 'progress',
  due: '2026-11-05',
  desc: '<p>Price it at €12.500.</p>',
};

test('mailFromTask prefills compose with the linked client and a body template', () => {
  const p = mailFromTask(T, 'femke@koffieco.example', 'https://atrium.app/atrium/task/ATR-1');
  assert.equal(p.to, 'femke@koffieco.example');
  assert.equal(p.subject, 'Send proposal to Koffie & Co');
  assert.ok(p.body.includes('Send proposal to Koffie & Co'), 'body references the task');
  assert.ok(p.body.includes('2026-11-05'), 'body carries the due date');
  assert.ok(p.body.includes('https://atrium.app/atrium/task/ATR-1'), 'body carries the webLink back to the task');
});

test('mailFromTask works without a client or a URL', () => {
  const p = mailFromTask(T, '', '');
  assert.equal(p.to, '');
  assert.ok(p.body.includes('Send proposal to Koffie & Co'));
  assert.ok(!p.body.includes('https://'), 'no URL → no link line');
});

test('eventFromTask prefills the event modal from the task', () => {
  const p = eventFromTask(T, 'cl1');
  assert.equal(p.title, 'Send proposal to Koffie & Co');
  assert.equal(p.date, '2026-11-05', 'the due date prefills the event date');
  assert.ok(p.description.includes('Send proposal to Koffie & Co'), 'description references the task');
  assert.equal(p.attendees, '', 'no surprise invites — attendees stay empty');
  assert.equal(p.allDay, false);
});

test('eventFromTask without a due date prefills an empty date honestly', () => {
  const p = eventFromTask({ ...T, due: null }, null);
  assert.equal(p.date, '');
  assert.ok(p.description.includes('Send proposal to Koffie & Co'));
});

/* --- descToText / decodeEsc (review fixes: lossless edit round-trip) --- */
import { decodeEsc, descToText, goneMailPreview } from '../src/core/links.js';
/* esc mirrored inline: utils.js touches navigator at module load (node-hostile). */
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
test('descToText: R&D round-trips through esc without double-escaping', () => {
  const desc = 'R&D review with Q&A <draft>';
  assert.equal(descToText('<p>' + esc(desc) + '</p>'), desc);
});
test('descToText: strips wrapper tags and collapses whitespace', () => {
  assert.equal(descToText('<p>hello   world</p>'), 'hello world');
  assert.equal(descToText(''), '');
  assert.equal(descToText(null), '');
});
test('decodeEsc: decodes exactly the five esc entities; unknown passes through', () => {
  assert.equal(decodeEsc('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'');
  assert.equal(decodeEsc('&unknown; &nbsp;'), '&unknown; &nbsp;');
});
test('goneMailPreview: subject from the link row; honest fallback without one', () => {
  const links = [{ id: 'l1', clientId: 'c1', kind: 'mail', ref: 'g1', title: 'Re: quote' }];
  assert.equal(goneMailPreview('g1', links).subject, 'Re: quote');
  assert.equal(goneMailPreview('g1', links).gone, true);
  assert.equal(goneMailPreview('gx', links).subject, '(linked message)');
  assert.deepEqual(goneMailPreview('gx', null).labels, []);
});
