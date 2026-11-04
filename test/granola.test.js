/* Unit tests for the pure Granola import layer (src/core/granola.js).
   Data-in/data-out only: frontmatter parsing, markdown→HTML, export
   sniffing (.md text or .json) and the sourceId dedupe plan must run in
   plain node. The ACTION applies the plan through supabase-js and
   sanitizes every produced html through docsSanitize (DOMPurify) before
   any insert — this module emits raw HTML text only. Granola has no
   public API: import runs from an export file (honest in the UI). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_BYTES,
  granolaImportPlan,
  granolaSource,
  granolaSourceId,
  markdownToHtml,
  parseFrontmatter,
  parseGranolaDoc,
  parseGranolaExport,
} from '../src/core/granola.js';

/* ---------- AC7: YAML frontmatter (title, date) ---------- */

test('parseFrontmatter extracts title and date from the leading fence', () => {
  const md = '---\ntitle: Weekly sync\ndate: 2026-11-04\n---\n\nBody starts here.';
  const { attrs, body } = parseFrontmatter(md);
  assert.deepEqual(attrs, { title: 'Weekly sync', date: '2026-11-04' });
  assert.equal(body, '\nBody starts here.');
});

test('parseFrontmatter strips quotes and tolerates a missing closing fence', () => {
  const { attrs, body } = parseFrontmatter('---\ntitle: "Quoted name"\nnotes: keep: this\nBody');
  assert.equal(attrs.title, 'Quoted name');
  assert.equal(attrs.notes, 'keep: this');
  assert.ok(body.includes('Body'));
  const none = parseFrontmatter('just body');
  assert.deepEqual(none.attrs, {});
  assert.equal(none.body, 'just body');
});

/* ---------- AC7: markdown → HTML (pure, escapes raw input) ---------- */

test('markdownToHtml renders headings, emphasis, code, lists, quotes and paragraphs', () => {
  const html = markdownToHtml('# H1\n## H2\nSome **bold**, *ital* and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n```\ncode fence\n```\n\ntail');
  assert.ok(html.includes('<h1>H1</h1>'));
  assert.ok(html.includes('<h2>H2</h2>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>ital</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<ol><li>one</li><li>two</li></ol>'));
  assert.ok(html.includes('<blockquote>quoted</blockquote>'));
  assert.ok(html.includes('<pre><code>code fence</code></pre>'));
  assert.ok(html.includes('<p>tail</p>'));
});

test('markdownToHtml keeps links only when the scheme is safe and escapes everything raw', () => {
  const safe = markdownToHtml('[x](https://ok.example)');
  assert.ok(safe.includes('<a href="https://ok.example">x</a>'));
  const evil = markdownToHtml('[x](javascript:alert(1)) <img src=x onerror=alert(1)> & <>"');
  assert.ok(!evil.includes('<img'), 'raw HTML must be escaped, never rendered');
  assert.ok(evil.includes('&lt;img'));
  assert.ok(!evil.includes('href="javascript:'), 'unsafe scheme drops the link markup');
});

/* ---------- AC7: one .md doc → page payload ---------- */

test('parseGranolaDoc builds title, html and a deterministic sourceId', () => {
  const md = '---\ntitle: Standup notes\ndate: 2026-11-04\n---\n\n- point one\n- point two';
  const doc = parseGranolaDoc(md);
  assert.equal(doc.title, 'Standup notes');
  assert.ok(doc.html.includes('<li>point one</li>'));
  assert.equal(doc.sourceId, granolaSourceId('Standup notes', '2026-11-04'));
  const again = parseGranolaDoc(md);
  assert.equal(doc.sourceId, again.sourceId, 'same export → same sourceId (dedupe key)');
});

test('parseGranolaDoc falls back to the first heading/body line when frontmatter has no title', () => {
  const doc = parseGranolaDoc('# Meeting title\n\nBody');
  assert.equal(doc.title, 'Meeting title');
});

/* ---------- AC7: export sniffing (.md text or .json) ---------- */

test('parseGranolaExport accepts a JSON array, a {docs:[…]} wrapper and a single object', () => {
  const arr = JSON.stringify([
    { id: 'g1', title: 'One', content: 'body one' },
    { title: 'Two', notes: 'body two' },
  ]);
  assert.deepEqual(
    parseGranolaExport(arr).map(d => [d.title, d.sourceId]),
    [
      ['One', 'g1'],
      ['Two', granolaSourceId('Two', null)],
    ],
  );
  const wrap = JSON.stringify({ docs: [{ id: 'g9', title: 'W', content: 'x' }] });
  assert.deepEqual(
    parseGranolaExport(wrap).map(d => d.sourceId),
    ['g9'],
  );
  const one = JSON.stringify({ title: 'Solo', markdown: 'body' });
  assert.deepEqual(
    parseGranolaExport(one).map(d => d.title),
    ['Solo'],
  );
});

test('parseGranolaExport treats plain markdown text as one doc and refuses junk', () => {
  const docs = parseGranolaExport('# Hi\n\nBody');
  assert.deepEqual(
    docs.map(d => d.title),
    ['Hi'],
  );
  assert.deepEqual(parseGranolaExport('   '), []);
  assert.deepEqual(parseGranolaExport('{not json'), []);
});

/* ---------- AC7: dedupe plan on sourceId ---------- */

test('granolaImportPlan creates new pages and updates existing ones in place (no dup rows)', () => {
  const items = [
    { title: 'A', markdown: 'a-body', sourceId: 'a', date: null },
    { title: 'B', markdown: 'b-body', sourceId: 'b', date: null },
    { title: 'C', markdown: 'c-body', sourceId: 'c', date: null },
  ];
  const existing = [
    { id: 'p-old', title: 'Old B', source: granolaSource('b') },
    { id: 'p-other', title: 'Other', source: null },
  ];
  const plan = granolaImportPlan(items, existing, 1_000_000_000_000);
  assert.deepEqual(
    plan.creates.map(c => c.title),
    ['A', 'C'],
  );
  assert.deepEqual(
    plan.updates.map(u => [u.id, u.title, u.kind]),
    [['p-old', 'B', 'import']],
  );
  assert.equal(plan.updates[0].source.sourceId, 'b', 'update keeps the source tag');
  assert.equal(plan.creates[0].source.kind, 'granola');
  const flat = [...plan.creates, ...plan.updates];
  assert.equal(flat.length, items.length, 'every exported doc lands exactly once');
});

test('granolaImportPlan leaves existing pages without a granola source untouched', () => {
  const items = [{ title: 'A', markdown: 'x', sourceId: 'a' }];
  const plan = granolaImportPlan(
    items,
    [
      { id: 'p1', title: 'A', source: null },
      { id: 'p2', title: 'A2' },
    ],
    0,
  );
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(
    plan.creates.map(c => c.title),
    ['A'],
  );
});

/* ---------- AC9: trust boundary — the honest file-size cap ---------- */

test('MAX_IMPORT_BYTES is 10 MB', () => {
  assert.equal(MAX_IMPORT_BYTES, 10 * 1024 * 1024);
});

test('granolaSourceId is a stable slug, capped, with sane fallbacks', () => {
  assert.equal(granolaSourceId('My Meeting!', '2026-11-04'), 'my-meeting-2026-11-04');
  assert.equal(granolaSourceId('My Meeting!', null), 'my-meeting');
  assert.equal(granolaSourceId('X'.repeat(200), null).length <= 64, true);
  assert.equal(granolaSourceId('', null), 'untitled');
  assert.equal(granolaSourceId('  ', '   '), 'untitled');
  assert.ok(granolaSourceId('über cool', null).length > 0, 'unicode titles still slug');
});
