/* Unit tests for the pure Notes layer (src/core/notes.js).
   Data-in/data-out only: no network, no DOM, no store imports — the notes
   store initializer, title extraction, search matching, ordering and
   attachment-ref validation must be testable in plain node. Notes live
   INSIDE the workspace document (doc.notes, same model as clients/deals/
   links — no new Postgres tables): { id, title, html, created, updated,
   pinned, attachments[] } with attachments rows { name, path, size, type }.
   html sanitization is a browser concern (DOMPurify needs a DOM) — the
   render/save paths in src/core/sanitize.js handle it, not this module. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENT_BYTES,
  UNTITLED,
  attachmentRefFor,
  ensureNotes,
  makeNote,
  noteAttachmentPath,
  noteSafeLinkUrl,
  noteSnippet,
  noteTitleFromHtml,
  notesSeed,
  removeNote,
  searchNotes,
  sortNotes,
  upsertNote,
  validateAttachmentRef,
} from '../src/core/notes.js';

/* ---------- AC1: ensureNotes zero-loss initializer ---------- */

test('ensureNotes adds a notes array to a doc without one', () => {
  const doc = { me: 'm1', clients: [{ id: 'cl1' }], tasks: [] };
  const out = ensureNotes(doc);
  assert.equal(out, doc, 'must mutate and return the same doc object');
  assert.deepEqual(out.notes, []);
});

test('ensureNotes leaves every existing key byte-for-byte identical', () => {
  const doc = {
    me: 'm1',
    ws: { name: 'Atrium', c: '#1D1C1A' },
    clients: [{ id: 'cl1', name: 'Existing', status: 'active' }],
    deals: [{ id: 'd1', value: 48000, stage: 'proposal' }],
    links: [{ id: 'lk1', clientId: 'cl1', kind: 'mail', ref: 'g1', title: 'Hi', when: 1, snippet: 's' }],
    tasks: [{ id: 't1', title: 'x', subtasks: [], labels: [] }],
    comments: [{ id: 'c1' }],
    activity: [{ id: 'a1' }],
    projOrder: ['p1'],
    prefsLike: 'untouched',
  };
  const before = JSON.stringify(doc);
  ensureNotes(doc);
  const after = JSON.stringify({ ...doc, notes: undefined });
  assert.equal(before, after, 'only the notes array may be added');
  assert.equal(doc.clients.length, 1);
  assert.equal(doc.deals[0].value, 48000);
  assert.equal(doc.links.length, 1, 'links[] (CRM linkage) is untouched');
  assert.equal(doc.tasks[0].title, 'x');
  assert.equal(doc.ws.name, 'Atrium');
});

test('ensureNotes keeps an existing notes array by reference, untouched', () => {
  const notes = [{ id: 'n1', title: 'Keep me', html: '<p>x</p>', created: 1, updated: 2, pinned: false, attachments: [] }];
  const doc = { clients: [], deals: [], links: [], notes };
  const out = ensureNotes(doc);
  assert.equal(out.notes, notes, 'existing array must not be cloned or replaced');
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].title, 'Keep me');
});

test('ensureNotes replaces corrupt non-array notes with an empty array', () => {
  const doc = { notes: 'oops' };
  ensureNotes(doc);
  assert.deepEqual(doc.notes, []);
});

test('ensureNotes is idempotent and null-safe', () => {
  const doc = { tasks: [] };
  const once = ensureNotes(doc);
  const twice = ensureNotes(once);
  assert.equal(twice, doc);
  assert.deepEqual(twice.notes, []);
  assert.equal(ensureNotes(null), null);
  assert.equal(ensureNotes(undefined), undefined);
});

/* ---------- makeNote: row factory ---------- */

test('makeNote builds a normalized note and rejects invalid input', () => {
  const n = makeNote({ id: 'n9', title: 'Plan', html: '<p>hi</p>', created: 100, updated: 200, pinned: true, attachments: [] });
  assert.deepEqual(n, { id: 'n9', title: 'Plan', html: '<p>hi</p>', created: 100, updated: 200, pinned: true, attachments: [] });
  assert.equal(makeNote(null), null);
  assert.equal(makeNote('nope'), null);
  assert.equal(makeNote(42), null);
});

test('makeNote defaults every field: sparse input yields a usable note', () => {
  const n = makeNote({ id: 'n1' });
  assert.equal(n.id, 'n1');
  assert.equal(n.title, '');
  assert.equal(n.html, '');
  assert.equal(n.pinned, false, 'pinned defaults to false');
  assert.deepEqual(n.attachments, []);
  assert.ok(Number.isFinite(n.created) && Number.isFinite(n.updated), 'timestamps default to now');
  assert.equal(makeNote({}).id, '', 'id left empty for the caller to assign');
});

test('makeNote coerces corrupt fields and keeps only valid attachment refs', () => {
  const n = makeNote({
    id: 'n2',
    title: 42,
    html: null,
    created: 'soon',
    updated: NaN,
    pinned: 'yes',
    attachments: [{ name: 'a.txt', path: 'u1/n1/a.txt', size: 3, type: 'text/plain' }, 'junk', null],
  });
  assert.equal(n.title, '42', 'non-string title coerced to string');
  assert.equal(n.html, '');
  assert.equal(n.created, 0, 'non-numeric created falls back to 0');
  assert.equal(n.updated, 0);
  assert.equal(n.pinned, true, 'truthy pinned becomes true');
  assert.equal(n.attachments.length, 1, 'invalid refs are dropped');
  assert.equal(n.attachments[0].name, 'a.txt');
});

/* ---------- AC6: title-from-html extraction ---------- */

test('noteTitleFromHtml prefers the first heading', () => {
  assert.equal(noteTitleFromHtml('<h2>Project kickoff</h2><p>Agenda below</p>'), 'Project kickoff');
  assert.equal(noteTitleFromHtml('<h3>  Third-level  </h3>'), 'Third-level');
});

test('noteTitleFromHtml falls back to the first paragraph text', () => {
  assert.equal(noteTitleFromHtml('<p>Retro agenda for <b>Thursday</b></p><p>second</p>'), 'Retro agenda for Thursday');
  assert.equal(noteTitleFromHtml('Plain text, no tags'), 'Plain text, no tags');
});

test('noteTitleFromHtml decodes esc() entities and collapses whitespace', () => {
  assert.equal(noteTitleFromHtml('<p>R&amp;D review with Q&amp;A</p>'), 'R&D review with Q&A');
  assert.equal(noteTitleFromHtml('<h2>  Multi\n\nspace \t title  </h2>'), 'Multi space title');
});

test('noteTitleFromHtml truncates long headings for list display', () => {
  const long = 'x'.repeat(200);
  const t = noteTitleFromHtml(`<h2>${long}</h2>`);
  assert.ok(t.length <= 81, `capped near 80 chars + ellipsis, got ${t.length}`);
  assert.ok(t.endsWith('…'));
});

test('noteTitleFromHtml returns empty for empty input (caller falls back)', () => {
  assert.equal(noteTitleFromHtml(''), '');
  assert.equal(noteTitleFromHtml(null), '');
  assert.equal(noteTitleFromHtml(undefined), '');
  assert.equal(noteTitleFromHtml('<p></p>'), '');
  assert.equal(noteTitleFromHtml('<div><span></span></div>'), '');
});

test('UNTITLED is the honest list fallback', () => {
  assert.equal(UNTITLED, 'Untitled note');
});

/* ---------- AC6: search matching (title + text, case-insensitive) ---------- */

const NOTES = [
  makeNote({ id: 'n1', title: 'Project kickoff', html: '<p>Agenda for the <b>kickoff</b> meeting</p>', created: 1, updated: 300 }),
  makeNote({ id: 'n2', title: 'Groceries', html: '<p>Milk, coffee filters and R&D-book stamps</p>', created: 1, updated: 200 }),
  makeNote({ id: 'n3', title: '', html: '<h2>Retrospective</h2><p>What went well</p>', created: 1, updated: 100, pinned: true }),
];

test('searchNotes matches the stored title case-insensitively', () => {
  assert.deepEqual(
    searchNotes(NOTES, 'KICKOFF').map(n => n.id),
    ['n1'],
  );
  assert.deepEqual(
    searchNotes(NOTES, 'groceries').map(n => n.id),
    ['n2'],
  );
});

test('searchNotes matches the note body text case-insensitively', () => {
  assert.deepEqual(
    searchNotes(NOTES, 'agenda').map(n => n.id),
    ['n1'],
  );
  assert.deepEqual(
    searchNotes(NOTES, 'WENT WELL').map(n => n.id),
    ['n3'],
  );
});

test('searchNotes finds notes without a title through the derived heading', () => {
  assert.deepEqual(
    searchNotes(NOTES, 'retrospective').map(n => n.id),
    ['n3'],
  );
});

test('searchNotes strips tags from the body before matching', () => {
  assert.deepEqual(
    searchNotes(NOTES, '<b>kickoff</b>').map(n => n.id),
    [],
    'raw tags are not searchable text',
  );
});

test('searchNotes is honest on misses, empty queries and bad input', () => {
  assert.deepEqual(searchNotes(NOTES, 'nonexistent-term'), []);
  assert.deepEqual(searchNotes(NOTES, ''), NOTES, 'empty query shows everything');
  assert.deepEqual(searchNotes(NOTES, '   '), NOTES, 'whitespace-only query shows everything');
  assert.deepEqual(searchNotes([], 'x'), []);
  assert.deepEqual(searchNotes(null, 'x'), []);
});

/* ---------- AC6: ordering (pin-first, updated desc) ---------- */

test('sortNotes puts pinned notes first, then updated desc (missing updated last)', () => {
  const a = makeNote({ id: 'a', updated: 100 });
  const b = makeNote({ id: 'b', updated: 900 });
  const c = makeNote({ id: 'c', updated: 500, pinned: true });
  const d = makeNote({ id: 'd', pinned: true, updated: 50 });
  const e = makeNote({ id: 'e' }); // no updated at all
  const out = sortNotes([a, b, c, d, e]);
  assert.deepEqual(
    out.map(n => n.id),
    ['c', 'd', 'b', 'a', 'e'],
    'pinned (newest first) → unpinned (newest first) → missing updated last',
  );
});

test('sortNotes is pure — the input array is untouched', () => {
  const arr = [makeNote({ id: 'a', updated: 1 }), makeNote({ id: 'b', updated: 2, pinned: true })];
  const before = arr.map(n => n.id).join();
  const out = sortNotes(arr);
  assert.deepEqual(
    out.map(n => n.id),
    ['b', 'a'],
  );
  assert.equal(arr.map(n => n.id).join(), before, 'input order preserved');
});

test('sortNotes tolerates corrupt input', () => {
  assert.deepEqual(sortNotes(null), []);
  assert.deepEqual(sortNotes(undefined), []);
  assert.deepEqual(sortNotes('nope'), []);
});

/* ---------- AC4: attachment refs ---------- */

test('validateAttachmentRef accepts a well-formed ref', () => {
  const ref = validateAttachmentRef({ name: 'brief.pdf', path: '5b920d94-f10e-41f8-afa3-238e2f8924e0/n1/brief.pdf', size: 12345, type: 'application/pdf' });
  assert.ok(ref);
  assert.equal(ref.name, 'brief.pdf');
  assert.equal(ref.path, '5b920d94-f10e-41f8-afa3-238e2f8924e0/n1/brief.pdf');
  assert.equal(ref.size, 12345);
  assert.equal(ref.type, 'application/pdf');
});

test('validateAttachmentRef rejects malformed shapes', () => {
  const good = { name: 'a.txt', path: 'u1/n1/a.txt', size: 1, type: 'text/plain' };
  assert.equal(validateAttachmentRef(null), null);
  assert.equal(validateAttachmentRef('a.txt'), null);
  assert.equal(validateAttachmentRef({ ...good, name: '' }), null, 'empty name');
  assert.equal(validateAttachmentRef({ ...good, name: '../../etc/passwd' }), null, 'traversal name');
  assert.equal(validateAttachmentRef({ ...good, name: 'a/b.txt' }), null, 'slash inside name');
  assert.equal(validateAttachmentRef({ ...good, path: 'u1/n1/wrong.txt' }), null, 'path must end with the name');
  assert.equal(validateAttachmentRef({ ...good, path: 'u1/a.txt' }), null, 'two segments only');
  assert.equal(validateAttachmentRef({ ...good, path: 'u1/n1/dir/a.txt' }), null, 'four segments');
  assert.equal(validateAttachmentRef({ ...good, path: '' }), null);
  assert.equal(validateAttachmentRef({ ...good, size: 'big' }), null, 'non-numeric size');
  assert.equal(validateAttachmentRef({ ...good, size: -1 }), null, 'negative size');
  assert.equal(validateAttachmentRef({ ...good, type: 42 }), null, 'non-string type');
  assert.ok(validateAttachmentRef({ ...good, type: '' }), 'empty type is allowed');
  assert.ok(validateAttachmentRef({ ...good, size: 0 }), 'zero size is allowed');
});

test('MAX_ATTACHMENT_BYTES is the 10 MB cap', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
});

test('attachmentRefFor builds a ref from a file and refuses oversize files', () => {
  const f = { name: 'Site Brief.pdf', size: 1024, type: 'application/pdf' };
  const ref = attachmentRefFor(f, 'u1', 'n1');
  assert.ok(ref);
  assert.equal(ref.name, 'Site Brief.pdf');
  assert.equal(ref.path, 'u1/n1/Site Brief.pdf');
  assert.equal(ref.size, 1024);
  assert.equal(ref.type, 'application/pdf');
  const big = attachmentRefFor({ ...f, size: MAX_ATTACHMENT_BYTES + 1 }, 'u1', 'n1');
  assert.equal(big, null, 'over the 10 MB cap → null (caller shows the honest error)');
  assert.equal(attachmentRefFor({ name: 'x.txt', size: 5 }, 'u1', 'n1').type, '', 'missing type falls back to empty string');
  assert.equal(attachmentRefFor(null, 'u1', 'n1'), null);
  assert.equal(attachmentRefFor(f, '', 'n1'), null, 'no user id → no path');
  assert.equal(attachmentRefFor(f, 'u1', ''), null, 'no note id → no path');
});

/* ---------- security: filename sanitization + path building ---------- */

test('safeAttachmentName strips traversal and separators', () => {
  const safe = n => noteAttachmentPath('u1', 'n1', n).split('/')[2];
  assert.equal(safe('../../etc/passwd'), 'etc-passwd');
  assert.equal(safe('..\\..\\secret.txt'), 'secret.txt');
  assert.equal(safe('a/b/c.txt'), 'a-b-c.txt');
  assert.equal(safe('C:\\Users\\ev\\doc.pdf'), 'C:-Users-ev-doc.pdf');
  assert.equal(safe('....//....//x.txt'), 'x.txt');
  assert.equal(safe('..'), 'file', 'a lone dot-dot cannot survive');
  assert.equal(safe('   '), 'file', 'whitespace-only falls back');
  assert.equal(safe(''), 'file');
  assert.equal(safe(null), 'file');
  assert.equal(safe('normal name (v2).pdf'), 'normal name (v2).pdf', 'ordinary names pass through');
  assert.ok(!safe('trailing dots...').endsWith('.'), 'trailing dots stripped');
});

test('safeAttachmentName strips control characters and caps length keeping the extension', () => {
  const safe = n => noteAttachmentPath('u1', 'n1', n).split('/')[2];
  assert.equal(safe('bad\u0000\u0007name.txt'), 'badname.txt');
  const long = 'y'.repeat(200) + '.pdf';
  const out = safe(long);
  assert.ok(out.length <= 120, `capped length, got ${out.length}`);
  assert.ok(out.endsWith('.pdf'), 'extension preserved');
});

test('noteAttachmentPath follows the <userId>/<noteId>/<filename> convention', () => {
  assert.equal(noteAttachmentPath('5b920d94-f10e-41f8-afa3-238e2f8924e0', 'n1', 'brief.pdf'), '5b920d94-f10e-41f8-afa3-238e2f8924e0/n1/brief.pdf');
  assert.equal(noteAttachmentPath('', 'n1', 'x.txt'), '', 'empty user id refuses to build a path');
  assert.equal(noteAttachmentPath('u1', '', 'x.txt'), '');
});

/* ---------- security: link URL scheme allowlist ---------- */

test('noteSafeLinkUrl allows only http(s) URLs without credentials', () => {
  assert.equal(noteSafeLinkUrl('https://example.com/page'), 'https://example.com/page');
  assert.equal(noteSafeLinkUrl('http://example.com'), 'http://example.com');
  assert.equal(noteSafeLinkUrl('  https://example.com  '), 'https://example.com', 'trimmed');
  assert.equal(noteSafeLinkUrl('https://user:pass@example.com'), '', 'credentials rejected');
  assert.equal(noteSafeLinkUrl('JavaScript:alert(1)'), '', 'script scheme rejected (case-insensitive)');
  assert.equal(noteSafeLinkUrl('javascript:alert(1)'), '');
  assert.equal(noteSafeLinkUrl('data:text/html,hi'), '');
  assert.equal(noteSafeLinkUrl('vbscript:hi'), '');
  assert.equal(noteSafeLinkUrl('ftp://example.com'), '');
  assert.equal(noteSafeLinkUrl('/relative/path'), '');
  assert.equal(noteSafeLinkUrl('//protocol-relative.example'), '');
  assert.equal(noteSafeLinkUrl(''), '');
  assert.equal(noteSafeLinkUrl(null), '');
  assert.equal(noteSafeLinkUrl('http://'), '', 'unparseable URL rejected');
});

/* ---------- upsert / remove / snippet ---------- */

test('upsertNote replaces by id in place and appends unknown ids (pure)', () => {
  const a = makeNote({ id: 'n1', title: 'A' });
  const b = makeNote({ id: 'n2', title: 'B' });
  const edited = makeNote({ id: 'n1', title: 'A2' });
  const out = upsertNote([a, b], edited);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A2');
  assert.equal(out[1], b, 'other rows kept by reference');
  assert.deepEqual(upsertNote([a], makeNote({ id: 'n9', title: 'New' })).length, 2, 'unknown id appends');
  const arr = [a];
  assert.equal(upsertNote(arr, null), arr, 'a null note changes nothing (same array back)');
});

test('removeNote filters by id (pure)', () => {
  const a = makeNote({ id: 'n1' });
  const b = makeNote({ id: 'n2' });
  const out = removeNote([a, b], 'n1');
  assert.deepEqual(
    out.map(n => n.id),
    ['n2'],
  );
  assert.equal(removeNote([a, b], 'n1').length, 1);
  assert.deepEqual(
    removeNote([a, b], 'zzz').map(n => n.id),
    ['n1', 'n2'],
  );
  assert.deepEqual(removeNote(null, 'n1'), []);
});

test('noteSnippet renders a plain-text preview with an ellipsis', () => {
  assert.equal(noteSnippet('<p>Hello <b>world</b></p>', 200), 'Hello world');
  assert.equal(noteSnippet('<p>' + 'z'.repeat(300) + '</p>', 110).length, 111, '110 chars + ellipsis');
  assert.ok(noteSnippet('<p>' + 'z'.repeat(300) + '</p>', 110).endsWith('…'));
  assert.equal(noteSnippet('', 110), '');
  assert.equal(noteSnippet(null, 110), '');
});

/* ---------- seed ---------- */

test('notesSeed returns one clearly-fictional sample note demonstrating editor output', () => {
  const s = notesSeed();
  assert.equal(s.length, 1);
  const n = s[0];
  assert.ok(n.id && n.title, 'id + title present');
  assert.ok(n.html.includes('<h2>'), 'demonstrates a heading');
  assert.ok(n.html.includes('<ul>'), 'demonstrates a bullet list');
  assert.ok(n.html.includes('<blockquote>'), 'demonstrates a quote');
  assert.ok(n.html.includes('<pre>'), 'demonstrates a code block');
  assert.ok(n.html.includes('href="https://'), 'demonstrates a link');
  assert.equal(n.pinned, true, 'sample note is pinned so the pin-first order is visible');
  assert.deepEqual(n.attachments, []);
  assert.ok(/fictional|sample|demo/i.test(n.html), 'the note says in plain words that it is a sample');
});
