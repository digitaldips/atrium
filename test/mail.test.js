/* Unit tests for the pure Mail layer (src/core/mail.js) — T3 atrium-mail.
   Data-in/data-out only: no network, no DOM, no store imports — the seed
   builder, the zero-loss doc initializer, folder filtering/unread counts,
   search, thread actions and the reply/compose/draft builders must run in
   plain node. doc.mail lives INSIDE the workspace document (shared
   workspace state, no new tables). CRM linkage reuses links.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMailSeed,
  ensureMailData,
  threadsInFolder,
  folderUnreadCount,
  mailSearchFilter,
  mailPatchThread,
  mailMoveThread,
  mailSetRead,
  mailToggleStar,
  appendMailReply,
  makeMailThread,
  mailThreadContact,
  removeMailThread,
} from '../src/core/mail.js';

const NOW = 1730000000000;
const me = { name: 'Wesley', email: 'wesley@operanceai.com' };

/* ---------- AC2/AC6: seed keeps the Orbit shape ---------- */

test('buildMailSeed returns Orbit folder set (6 system + custom) and >=8 threads', () => {
  const s = buildMailSeed(NOW, me);
  const ids = s.folders.map(f => f.id);
  for (const id of ['f_inbox', 'f_starred', 'f_sent', 'f_drafts', 'f_archive', 'f_trash']) assert.ok(ids.includes(id), id);
  assert.ok(
    s.folders.some(f => f.custom),
    'custom folders present',
  );
  assert.ok(s.threads.length >= 8, 'at least 8 threads');
});

test('buildMailSeed threads carry the Orbit flags + message shape', () => {
  const s = buildMailSeed(NOW, me);
  for (const t of s.threads) {
    assert.ok(t.id && t.folderId && typeof t.subject === 'string' && typeof t.snippet === 'string');
    assert.equal(typeof t.unread, 'boolean');
    assert.equal(typeof t.starred, 'boolean');
    assert.equal(typeof t.hasAttachment, 'boolean');
    assert.ok(Array.isArray(t.messages) && t.messages.length >= 1);
    for (const m of t.messages) {
      assert.ok(m.id && m.from && typeof m.from.email === 'string');
      assert.ok(Array.isArray(m.to));
      assert.equal(typeof m.body, 'string');
      assert.equal(typeof m.createdAt, 'number');
      assert.ok(m.createdAt <= NOW, 'createdAt is an epoch-ms number not in the future');
      assert.ok(m.attachments === undefined || Array.isArray(m.attachments), 'attachments refs are a list when present');
    }
  }
  assert.ok(
    s.threads.some(t => t.unread && t.starred),
    'an unread+starred thread exists',
  );
  assert.ok(
    s.threads.some(t => t.hasAttachment && t.messages.some(m => m.attachments?.length)),
    'attachment refs exist',
  );
  assert.ok(
    s.threads.some(t => t.messages.length >= 3),
    'a multi-message thread exists',
  );
});

/* ---------- AC2: ensureMailData — zero-loss initializer ---------- */

test('ensureMailData fills a missing mail key with the seed', () => {
  const doc = { data: { ws: { name: 'Operance' }, clients: [] } };
  const out = ensureMailData(doc);
  assert.ok(out.mail.folders.length && out.mail.threads.length);
  assert.equal(doc, out, 'mutates in place (same contract as ensureCrmData)');
});

test('ensureMailData keeps an existing mail object BY REFERENCE (idempotent, zero-loss)', () => {
  const doc = { mail: { folders: [{ id: 'f_inbox', name: 'Inbox' }], threads: [{ id: 't_keep', folderId: 'f_inbox' }] } };
  const mailRef = doc.mail;
  const threadsRef = doc.mail.threads;
  const again = ensureMailData(doc);
  assert.equal(again.mail, mailRef, 'existing mail object kept by reference');
  assert.equal(again.mail.threads, threadsRef, 'existing threads kept by reference');
  assert.equal(again.mail.threads[0].id, 't_keep', 'existing threads untouched');
  assert.equal(doc.mail.folders.length, 1, 'existing folders untouched (no reseed merge)');
});

test('ensureMailData fills missing keys INSIDE an existing mail object', () => {
  const doc = { mail: { folders: [{ id: 'f_inbox', name: 'Inbox' }] } };
  ensureMailData(doc);
  assert.ok(Array.isArray(doc.mail.threads) && doc.mail.threads.length, 'threads seeded when missing');
});

test('ensureMailData repairs junk sub-keys without touching siblings', () => {
  const doc = { mail: { folders: 'junk', threads: null } };
  ensureMailData(doc);
  assert.ok(Array.isArray(doc.mail.folders));
  assert.ok(Array.isArray(doc.mail.threads));
});

test('ensureMailData is idempotent: a second call changes nothing', () => {
  const doc = { clients: [{ id: 'c1' }] };
  ensureMailData(doc);
  const snapshot = JSON.stringify(doc);
  const out = ensureMailData(doc);
  assert.equal(JSON.stringify(out), snapshot);
});

test('ensureMailData is zero-loss on every other doc key', () => {
  const doc = { tasks: [{ id: 't1' }], clients: [{ id: 'c1', name: 'Van den Berg' }], links: [{ id: 'lk1' }], notes: [], prefs_note: 'keep me' };
  const before = JSON.stringify(doc);
  ensureMailData(doc);
  assert.equal(doc.tasks, doc.tasks);
  assert.equal(JSON.stringify(doc.tasks), JSON.stringify([{ id: 't1' }]));
  assert.equal(JSON.stringify(doc.clients), JSON.stringify([{ id: 'c1', name: 'Van den Berg' }]));
  assert.notEqual(JSON.stringify(doc), before, 'mail key added');
  assert.deepEqual(
    Object.keys(doc).filter(k => k === 'mail'),
    ['mail'],
  );
});

test('ensureMailData survives null/garbage input without throwing', () => {
  assert.equal(ensureMailData(null), null);
  assert.equal(ensureMailData(undefined), undefined);
  assert.deepEqual(ensureMailData('x'), 'x');
  assert.deepEqual(ensureMailData({ mail: 42 }).mail.folders.length > 0, true, 'junk mail value is replaced');
});

/* ---------- AC1/AC4: folder filtering + unread counts (Orbit semantics) ---------- */

const th = (id, folderId, extra = {}) => ({
  id,
  folderId,
  subject: 'S ' + id,
  snippet: '',
  unread: false,
  starred: false,
  hasAttachment: false,
  updatedAt: 1000,
  messages: [],
  ...extra,
});

test('threadsInFolder filters by folderId, newest first; Starred is virtual', () => {
  const ts = [
    th('a', 'f_inbox', { updatedAt: 100 }),
    th('b', 'f_inbox', { updatedAt: 300 }),
    th('c', 'f_sent', { updatedAt: 200 }),
    th('d', 'f_archive', { updatedAt: 500, starred: true }),
  ];
  assert.deepEqual(
    threadsInFolder(ts, 'f_inbox').map(t => t.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    threadsInFolder(ts, 'f_starred').map(t => t.id),
    ['d'],
  );
  assert.deepEqual(threadsInFolder(ts, 'f_trash'), []);
});

test('folderUnreadCount counts unread threads in the folder (starred counts starred unread)', () => {
  const ts = [
    th('a', 'f_inbox', { unread: true }),
    th('b', 'f_inbox'),
    th('c', 'f_inbox', { unread: true }),
    th('d', 'f_sent', { starred: true, unread: true }),
  ];
  assert.equal(folderUnreadCount(ts, 'f_inbox'), 2);
  assert.equal(folderUnreadCount(ts, 'f_starred'), 1);
  assert.equal(folderUnreadCount(ts, 'f_trash'), 0);
  assert.equal(folderUnreadCount(null, 'f_inbox'), 0);
});

/* ---------- AC4: search filters subject/snippet/body ---------- */

test('mailSearchFilter matches subject, snippet and message bodies case-insensitively', () => {
  const ts = [
    th('sub', 'f_inbox', { subject: 'Scaffolding Invoice' }),
    th('snip', 'f_inbox', { snippet: 'payment due soon' }),
    th('body', 'f_inbox', { messages: [{ id: 'm1', from: { name: 'X', email: 'x@y.z' }, to: [], body: 'About the CRANE inspection', createdAt: 1 }] }),
    th('no', 'f_inbox', { subject: 'unrelated', messages: [{ id: 'm2', from: { name: 'X', email: 'x@y.z' }, to: [], body: 'nothing here', createdAt: 1 }] }),
  ];
  assert.deepEqual(
    mailSearchFilter(ts, 'invoice').map(t => t.id),
    ['sub'],
  );
  assert.deepEqual(
    mailSearchFilter(ts, 'PAYMENT').map(t => t.id),
    ['snip'],
  );
  assert.deepEqual(
    mailSearchFilter(ts, 'crane').map(t => t.id),
    ['body'],
  );
  assert.deepEqual(mailSearchFilter(ts, ''), [], 'empty query matches nothing (UI skips filtering)');
  assert.deepEqual(mailSearchFilter(null, 'x'), []);
});

/* ---------- AC3: thread actions (pure list edits) ---------- */

test('mailPatchThread returns a new list, patches only the target, junk-safe', () => {
  const ts = [th('a', 'f_inbox'), th('b', 'f_inbox')];
  const out = mailPatchThread(ts, 'b', { unread: true });
  assert.notEqual(out, ts, 'new array');
  assert.equal(out[0], ts[0], 'untouched rows kept by reference');
  assert.equal(out[1].unread, true);
  assert.deepEqual(
    mailPatchThread(ts, 'gone', { unread: true }).map(t => t.id),
    ['a', 'b'],
    'missing id → unchanged list',
  );
  assert.deepEqual(mailPatchThread(null, 'a', {}), []);
});

test('mailMoveThread moves a thread to another folder', () => {
  const out = mailMoveThread([th('a', 'f_inbox')], 'a', 'f_archive');
  assert.equal(out[0].folderId, 'f_archive');
});

test('mailSetRead and mailToggleStar flip flags purely', () => {
  const ts = [th('a', 'f_inbox', { unread: true, starred: false })];
  assert.equal(mailSetRead(ts, 'a', true)[0].unread, false);
  assert.equal(mailSetRead(ts, 'gone', true)[0].unread, true, 'missing id untouched');
  const starred = mailToggleStar(ts, 'a');
  assert.equal(starred[0].starred, true);
  assert.equal(mailToggleStar(ts, 'a')[0].starred, true, 'original list not mutated');
});

test('removeMailThread drops exactly the target', () => {
  const ts = [th('a'), th('b')];
  const out = removeMailThread(ts, 'a');
  assert.deepEqual(
    out.map(t => t.id),
    ['b'],
  );
  assert.equal(ts.length, 2, 'input untouched');
});

/* ---------- AC3: reply appends to the thread + writes Sent ---------- */

test('appendMailReply appends a from-me message and updates snippet/unread/updatedAt', () => {
  const t = th('a', 'f_inbox', {
    unread: true,
    messages: [{ id: 'm1', from: { name: 'Marco', email: 'marco@vandenbergbv.nl' }, to: ['me@operanceai.com'], body: 'hello', createdAt: 1 }],
  });
  const { thread, sent } = appendMailReply(t, {
    id: 'mm2',
    from: { name: 'Wesley', email: 'wesley@operanceai.com' },
    body: 'On it — checking the site camera now.',
    now: 5555,
  });
  assert.equal(thread.messages.length, 2);
  const reply = thread.messages[1];
  assert.deepEqual(reply.from, { name: 'Wesley', email: 'wesley@operanceai.com' });
  assert.deepEqual(reply.to, ['marco@vandenbergbv.nl'], 'reply goes to the last message sender');
  assert.equal(reply.createdAt, 5555);
  assert.equal(thread.unread, false);
  assert.equal(thread.updatedAt, 5555);
  assert.ok(thread.snippet.includes('site camera'));
  assert.deepEqual(sent.messages[0].body, 'On it — checking the site camera now.', 'mock send also writes Sent');
  assert.equal(sent.folderId, 'f_sent');
  assert.equal(sent.messages[0].to[0], 'marco@vandenbergbv.nl');
  assert.equal(t.messages.length, 1, 'input thread untouched');
});

test('appendMailReply does not write a Sent copy for a thread already in Sent', () => {
  const t = th('a', 'f_sent', { messages: [{ id: 'm1', from: { name: 'Me', email: 'me@x.y' }, to: ['a@b.c'], body: 'x', createdAt: 1 }] });
  const { thread, sent } = appendMailReply(t, { id: 'mm2', from: { name: 'W', email: 'w@x.y' }, body: 'y', now: 2 });
  assert.equal(thread.messages.length, 2);
  assert.equal(sent, null);
});

test('appendMailReply Re:-prefills nothing itself — caller owns subject — but keeps the thread subject', () => {
  const t = th('a', 'f_inbox', {
    subject: 'Site camera offline',
    messages: [{ id: 'm1', from: { name: 'M', email: 'm@x.y' }, to: [], body: 'b', createdAt: 1 }],
  });
  const { thread } = appendMailReply(t, { id: 'mm2', from: { name: 'W', email: 'w@x.y' }, body: 'ok', now: 3 });
  assert.equal(thread.subject, 'Site camera offline');
});

test('appendMailReply survives a thread with no messages (never throws)', () => {
  const t = th('a', 'f_inbox');
  const { thread, sent } = appendMailReply(t, { id: 'mm9', from: { name: 'W', email: 'w@x.y' }, body: 'bump', now: 9 });
  assert.equal(thread.messages.length, 1);
  assert.deepEqual(thread.messages[0].to, []);
  assert.equal(sent.messages[0].to[0], undefined, 'no counterpart → honest empty to');
});

/* ---------- AC3: compose + draft builders ---------- */

test('makeMailThread builds a Sent thread from a compose form', () => {
  const t = makeMailThread({
    id: 'm_new',
    folderId: 'f_sent',
    subject: 'Crane inspection Friday',
    to: 'klanten@vandenbergbv.nl',
    from: { name: 'Wesley', email: 'wesley@operanceai.com' },
    body: 'Site closed Friday.',
    now: NOW,
  });
  assert.equal(t.folderId, 'f_sent');
  assert.equal(t.unread, false);
  assert.equal(t.starred, false);
  assert.equal(t.hasAttachment, false);
  assert.equal(t.subject, 'Crane inspection Friday');
  assert.equal(t.messages[0].to[0], 'klanten@vandenbergbv.nl');
  assert.equal(t.updatedAt, NOW);
  assert.ok(t.snippet.startsWith('Site closed'));
});

test('makeMailThread falls back to (no subject) and empty recipients honestly', () => {
  const t = makeMailThread({ id: 'm_d', folderId: 'f_drafts', subject: '', to: '', from: { name: 'W', email: '' }, body: 'draft body', now: NOW });
  assert.equal(t.folderId, 'f_drafts');
  assert.equal(t.subject, '(no subject)');
  assert.deepEqual(t.messages[0].to, []);
  assert.deepEqual(t.messages[0].attachments, []);
});

/* ---------- AC5: CRM linkage contact extraction ---------- */

test('mailThreadContact returns the last message sender for mailSuggestion', () => {
  const t = th('a', 'f_inbox', {
    messages: [
      { id: 'm1', from: { name: 'Anna', email: 'anna@bouwbanen.nl' }, to: [], body: '', createdAt: 1 },
      { id: 'm2', from: { name: 'W', email: 'w@x.y' }, to: [], body: '', createdAt: 2 },
      { id: 'm3', from: { name: 'Marco', email: 'Marco@VandenbergBV.nl' }, to: [], body: '', createdAt: 3 },
    ],
  });
  const c = mailThreadContact(t);
  assert.deepEqual(c, { id: 'a', email: 'Marco@VandenbergBV.nl' });
});

test('mailThreadContact skips threads whose last sender is me or empty', () => {
  const mine = th('b', 'f_sent', { messages: [{ id: 'm1', from: { name: 'Wesley', email: 'wesley@operanceai.com' }, to: [], body: '', createdAt: 1 }] });
  assert.deepEqual(mailThreadContact(mine, 'wesley@operanceai.com'), null, 'my own sent mail suggests nothing');
  const none = th('c', 'f_inbox');
  assert.equal(mailThreadContact(none), null);
  assert.equal(mailThreadContact(null), null);
});
