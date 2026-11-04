/* Unit tests for the pure Docs layer (src/core/docs.js).
   Data-in/data-out only: no network, no DOM, no store imports — the page-tree
   build, sibling positioning, subtree query, version-snapshot decision,
   content-text extraction, snippet windows and row coercion must be testable
   in plain node. docs_pages/docs_versions live in Postgres (migration 0005)
   — the workspace document gains no new keys. Sanitization is a browser
   concern (DOMPurify needs a DOM) — src/core/sanitize.js handles it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_MIN_MS, buildDocTree, descendantIds, docSnippet, docTextFromHtml, makeDocPage, nextDocPosition, shouldSnapshot } from '../src/core/docs.js';

/* ---------- AC1: tree build ---------- */

const row = (id, parent_id, position, title = id) => ({ id, parent_id, position, title, icon: null, created_at: position });

test('buildDocTree orders roots and children by position and sets depth', () => {
  const rows = [row('b', null, 2, 'B'), row('a', null, 1, 'A'), row('a2', 'a', 2, 'A2'), row('a1', 'a', 1, 'A1'), row('a1x', 'a1', 1, 'A1x')];
  const tree = buildDocTree(rows);
  assert.deepEqual(
    tree.map(n => [n.id, n.depth]),
    [
      ['a', 0],
      ['b', 0],
    ],
  );
  assert.deepEqual(
    tree[0].children.map(n => [n.id, n.depth]),
    [
      ['a1', 1],
      ['a2', 1],
    ],
  );
  assert.deepEqual(
    tree[0].children[0].children.map(n => n.id),
    ['a1x'],
  );
});

test('buildDocTree treats an orphaned parent_id as a root (deleted parent, junk id)', () => {
  const rows = [row('kid', 'gone', 1, 'Kid'), row('kid2', '   ', 2, 'Kid2')];
  const tree = buildDocTree(rows);
  assert.deepEqual(
    tree.map(n => n.id),
    ['kid', 'kid2'],
  );
  assert.equal(tree[0].depth, 0);
});

test('buildDocTree survives a parent cycle without hanging', () => {
  const rows = [
    { id: 'x', parent_id: 'y', position: 1, title: 'X' },
    { id: 'y', parent_id: 'x', position: 2, title: 'Y' },
  ];
  const tree = buildDocTree(rows);
  assert.ok(tree.length >= 1, 'cycle members degrade to roots, no infinite loop');
});

/* ---------- AC1: position-ordered creation (like projects) ---------- */

test('nextDocPosition returns max sibling position + 1', () => {
  const rows = [
    { id: 'a', parent_id: null, position: 3 },
    { id: 'b', parent_id: null, position: 7 },
    { id: 'c', parent_id: 'a', position: 9 },
  ];
  assert.equal(nextDocPosition(rows, null), 8);
  assert.equal(nextDocPosition(rows, 'a'), 10);
  assert.equal(nextDocPosition([], null), 0);
});

/* ---------- AC1: move guard (cycle prevention in the parent picker) ---------- */

test('descendantIds returns the whole subtree without the root itself', () => {
  const rows = [row('a', null, 1), row('b', 'a', 1), row('c', 'b', 1), row('d', null, 2)];
  const out = descendantIds(rows, 'a');
  assert.deepEqual([...out].sort(), ['b', 'c']);
  assert.equal(out.has('a'), false);
});

/* ---------- AC5: version snapshot decision (Orbit ≥10-min rule) ---------- */

test('shouldSnapshot: no snapshot yet, fresh snapshot, and the 10-minute boundary', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldSnapshot(now, null), true, 'no snapshot yet → snapshot');
  assert.equal(shouldSnapshot(now, now - SNAPSHOT_MIN_MS + 1), false, '9:59.999 → no');
  assert.equal(shouldSnapshot(now, now - SNAPSHOT_MIN_MS), true, 'exactly 10 min → yes');
  assert.equal(shouldSnapshot(now, 0), true, 'epoch-old snapshot → yes');
});

/* ---------- AC2/AC6: content_text extraction for the search column ---------- */

test('docTextFromHtml strips tags, decodes the five esc entities and collapses whitespace', () => {
  assert.equal(docTextFromHtml('<h2>R&amp;D</h2><p>It&#39;s 3 &lt; 4 &amp; more</p>'), "R&D It's 3 < 4 & more");
  assert.equal(docTextFromHtml('  <p>a</p>\n<p>b</p>  '), 'a b');
  assert.equal(docTextFromHtml(''), '');
  assert.equal(docTextFromHtml(null), '');
});

/* ---------- AC6: search snippet window ---------- */

test('docSnippet windows around the first match with ellipses', () => {
  const text = 'x'.repeat(200) + ' the needle here ' + 'y'.repeat(200);
  const s = docSnippet(text, 'needle', 40);
  assert.ok(s.startsWith('…'));
  assert.ok(s.endsWith('…'));
  assert.ok(s.includes('the needle here'));
});

test('docSnippet falls back to the head when nothing matches and escapes nothing (pure text)', () => {
  assert.equal(docSnippet('plain head text', 'zzz', 5), 'plain…');
  assert.equal(docSnippet('', 'q'), '');
});

/* ---------- AC2: row coercion (hydration trust boundary) ---------- */

test('makeDocPage coerces junk fields honestly and drops non-object sources', () => {
  const p = makeDocPage({
    id: 'u1',
    workspace_id: 42,
    parent_id: 0,
    title: 5,
    icon: null,
    content_html: 9,
    content_text: undefined,
    position: '3',
    version: '7',
    source: 'javascript:alert(1)',
    created_at: '2026-11-04T10:00:00Z',
    updated_at: null,
    deleted_at: '2026-11-04T11:00:00Z',
    extra: 'dropped',
  });
  assert.equal(p.title, '5');
  assert.equal(p.content_html, '');
  assert.equal(p.content_text, '');
  assert.equal(p.position, 3);
  assert.equal(p.version, 7);
  assert.equal(p.workspace_id, '');
  assert.equal(p.parent_id, null, '0 is not a uuid → null');
  assert.equal(p.source, null, 'non-object source is refused');
  assert.equal(p.deleted_at, '2026-11-04T11:00:00Z');
  assert.equal(p.extra, undefined);
});

test('makeDocPage keeps a plain-object granola source and nulls nullables', () => {
  const p = makeDocPage({ id: 'u2', workspace_id: 'w1', source: { kind: 'granola', sourceId: 'g1' } });
  assert.deepEqual(p.source, { kind: 'granola', sourceId: 'g1' });
  assert.equal(p.parent_id, null);
  assert.equal(p.icon, null);
});
