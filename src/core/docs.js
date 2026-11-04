/* =====================================================================
   DOCS · pure data layer for the Docs module (Orbit integration T1)
   Data-in/data-out only (no DOM, no store, no network) so the tree
   build, sibling positioning, subtree query, version-snapshot decision,
   content-text extraction, snippet windows and row coercion run in
   plain node tests. Pages live in Postgres (docs_pages/docs_versions,
   migration 0005) — the workspace document gains NO new keys. HTML
   sanitization is a browser concern (DOMPurify needs a DOM):
   src/core/sanitize.js handles it, never this module.
   ===================================================================== */

export const DOC_UNTITLED = 'Untitled page';
/* Orbit's rule: auto-snapshot a page only when the newest snapshot is at
   least 10 minutes old (page_versions, apps/server/migrations/0028). */
export const SNAPSHOT_MIN_MS = 10 * 60 * 1000;

/* ---------- tree build (AC1) ---------- */
/* Flat rows → ordered nested nodes. Siblings sort by position (the
   projects convention), then created_at, then id for stability. A
   parent_id that points outside the row set (deleted parent, junk) or a
   parent cycle degrades the node to a root instead of vanishing or
   hanging. Each node carries depth for indent rendering. */
export function buildDocTree(rows) {
  const nodes = new Map();
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || r.id == null || r.id === '' || nodes.has(r.id)) continue;
    nodes.set(r.id, { ...r, children: [] });
  }
  for (const n of nodes.values()) {
    const p = n.parent_id ? nodes.get(n.parent_id) : null;
    if (p) p.children.push(n);
  }
  const cmp = (x, y) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0);
  const depthOf = n => {
    const guard = new Set([n.id]);
    let d = 0,
      cur = n;
    while (cur.parent_id && nodes.has(cur.parent_id)) {
      if (guard.has(cur.parent_id)) return null; /* cycle → treat as root */
      guard.add(cur.parent_id);
      cur = nodes.get(cur.parent_id);
      d++;
    }
    return d;
  };
  const roots = [];
  for (const n of nodes.values()) {
    const d = depthOf(n);
    if (d == null) {
      const p = nodes.get(n.parent_id);
      if (p) p.children = p.children.filter(c => c !== n);
      n.parent_id = null;
      n.depth = 0;
    } else n.depth = d;
    if (!n.parent_id || !nodes.has(n.parent_id)) roots.push(n);
  }
  const sortSibs = list => {
    list.sort((a, b) => cmp(a.position, b.position) || cmp(a.created_at, b.created_at) || cmp(String(a.id), String(b.id)));
    for (const n of list) sortSibs(n.children);
  };
  sortSibs(roots);
  return roots;
}

/* Position-ordered creation like projects: next position = max sibling
   position + 1 (0 for the first page at any level). */
export function nextDocPosition(rows, parentId) {
  const sibs = (rows || []).filter(r => r && (r.parent_id || null) === (parentId || null));
  return sibs.reduce((m, r) => Math.max(m, Number(r.position) || 0), -1) + 1;
}

/* The subtree rooted at id, WITHOUT the root itself — the move picker
   must never offer a page its own descendant as a parent (cycle). */
export function descendantIds(rows, id) {
  const out = new Set();
  const kids = new Map();
  for (const r of rows || []) {
    if (r && r.parent_id) {
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id).push(r.id);
    }
  }
  const stack = (kids.get(id) || []).slice();
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue; /* cycle guard */
    out.add(cur);
    for (const k of kids.get(cur) || []) stack.push(k);
  }
  return out;
}

/* ---------- version snapshot decision (AC5, Orbit ≥10-min rule) ---------- */
/* `newestSnapshotAt` is the created_at (ms) of the page's newest snapshot,
   or null when it has none. Exact-boundary: ≥ minMs counts. */
export function shouldSnapshot(now, newestSnapshotAt, minMs = SNAPSHOT_MIN_MS) {
  if (newestSnapshotAt == null) return true;
  return now - Number(newestSnapshotAt) >= minMs;
}

/* ---------- content_text extraction (feeds docs_pages.content_text) ---------- */
/* Pure text pipeline, same contract as the notes title extractor: strip
   tags → decode exactly the five esc() entities → collapse whitespace. */
export function docTextFromHtml(html) {
  /* Strip tags BEFORE decoding: a decoded `<` (e.g. "3 < 4") must not
     merge into a tag match and eat real text. */
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, e => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[e])
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- search snippet (AC6) ---------- */
/* A window of `len` chars around the first case-insensitive match, with
   … ellipses; falls back to the head of the text. Output is TEXT — the
   caller escapes it. */
export function docSnippet(text, query, len = 120) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const q = String(query ?? '').trim();
  if (!t) return '';
  if (!q) return t.length > len ? t.slice(0, len) + '…' : t;
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.length > len ? t.slice(0, len) + '…' : t;
  const start = Math.max(0, i - Math.floor((len - q.length) / 2));
  const out = t.slice(start, start + len);
  return (start > 0 ? '…' : '') + out + (start + len < t.length ? '…' : '');
}

/* ---------- fetch-on-render guards (settled-state contract) ---------- */
/* Same shape as google-pure.js's shouldFetch: pages call ensure* on every
   synchronous render, so 'loading' re-arms nothing and 'error'/'ok' are
   TERMINAL until an explicit action resets the state to 'idle' and
   re-arms exactly one fetch. */
export function shouldFetchState(state) {
  return state === 'idle';
}

/* ---------- row coercion (hydration trust boundary, AC9) ---------- */
/* One docs_pages row from Postgres → honest normalized shape. Corrupt
   values coerce (a non-string content_html is html-ish junk → ''),
   `source` must be a plain object or it is refused, and unknown fields
   are dropped. Well-formed rows round-trip unchanged. */
export function makeDocPage(input) {
  if (!input || typeof input !== 'object') return null;
  const pos = Number(input.position);
  const ver = Number(input.version);
  return {
    id: typeof input.id === 'string' ? input.id : '',
    workspace_id: typeof input.workspace_id === 'string' ? input.workspace_id : '',
    parent_id: typeof input.parent_id === 'string' && input.parent_id ? input.parent_id : null,
    title: input.title == null ? '' : String(input.title),
    icon: input.icon == null ? null : String(input.icon),
    content_html: typeof input.content_html === 'string' ? input.content_html : '',
    content_text: input.content_text == null ? '' : String(input.content_text),
    position: Number.isFinite(pos) ? pos : 0,
    version: Number.isFinite(ver) && ver >= 0 ? Math.floor(ver) : 0,
    source: input.source && typeof input.source === 'object' && !Array.isArray(input.source) ? { ...input.source } : null,
    created_at: input.created_at ?? null,
    updated_at: input.updated_at ?? null,
    deleted_at: input.deleted_at ?? null,
  };
}
