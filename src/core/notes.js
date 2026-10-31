/* =====================================================================
   NOTES · pure data layer for the Notes module
   Every function is data-in/data-out (no DOM, no store, no network) so
   the initializer, title extraction, search, ordering and attachment-ref
   validation run in plain node tests and anywhere in the app. Rendering,
   sanitization (DOMPurify needs a DOM) and storage calls live in pages/
   actions (src/core/sanitize.js + src/actions/notes.js).

   Notes live INSIDE the workspace document (doc.notes, same model as
   clients/deals/links — no new Postgres tables). One note:
     { id, title, html, created, updated, pinned, attachments[] }
   html is ALWAYS DOMPurify-sanitized at save (src/actions/notes.js) and
   again at render (defense in depth) — this module never stores or
   renders raw markup. One attachment ref:
     { name, path, size, type }   path = <userId>/<noteId>/<filename>
   ===================================================================== */

/* ---------- vocabulary ---------- */
export const UNTITLED = 'Untitled note';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB — enforced client-side, bucket limit is the server backstop

/* ---------- zero-loss doc initializer + hydration trust boundary ---------- */
/* Same contract as ensureCrmData/ensureDocShape: the workspace document
   predating Notes has no notes[]. This initializer runs on hydrate AND
   bootstrap AND the trusted-cache bind. The rows come from the server
   document, so EVERY row passes through makeNote here — that is the
   hydration trust boundary: corrupt field values are coerced honestly,
   a truthy non-array attachments value resets to [], junk attachment
   refs are dropped and missing fields are filled. Rows that cannot be
   repaired at all (non-objects) are dropped rather than allowed to break
   the render. Well-formed rows are kept BY REFERENCE and byte-identical
   (zero-loss: only genuine repairs change bytes), which also keeps the
   pass idempotent. */
export function ensureNotes(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.notes)) {
    doc.notes = [];
    return doc;
  }
  let dirty = false;
  const rows = doc.notes.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      dirty = true;
      return null; /* a junk row cannot be repaired — drop it, don't crash the page */
    }
    /* Spread order keeps the row's own key order and any extra fields;
       makeNote only overrides the seven known fields. */
    const fixed = { ...row, ...makeNote(row) };
    if (JSON.stringify(fixed) !== JSON.stringify(row)) {
      dirty = true;
      return fixed;
    }
    return row;
  });
  if (!dirty) return doc;
  doc.notes = rows.filter(Boolean);
  return doc;
}

/* ---------- body commit (updated stamping) ---------- */
/* The editor/autosave commit path hands in the freshly sanitized html.
   A REAL content change assigns html AND stamps `updated` — body edits
   must drive sortNotes ordering and the ago() stamps exactly like title
   edits do. An unchanged commit (toolbar click that altered nothing, a
   second commit of the same bytes) is a no-op that never churns the
   timestamp. `now` is injectable so node tests can pin the stamp. */
export function noteApplyBody(n, html, now = Date.now()) {
  if (!n || typeof n !== 'object') return false;
  if (n.html === html) return false;
  n.html = html;
  n.updated = now;
  return true;
}

/* ---------- row factory ---------- */
/* Normalizes one note row. Returns null when the input is not an object.
   Corrupt field values are coerced honestly (string/number/boolean) and
   invalid attachment refs are dropped rather than trusted. The caller
   supplies the id for new notes; a rehydrated note keeps its own. */
export function makeNote(input) {
  const n = input && typeof input === 'object' ? input : null;
  if (!n) return null;
  const created = Number(n.created);
  const updated = Number(n.updated);
  return {
    id: typeof n.id === 'string' ? n.id : '',
    title: typeof n.title === 'string' ? n.title : String(n.title ?? ''),
    html: typeof n.html === 'string' ? n.html : '',
    created: Number.isFinite(created) ? created : 0,
    updated: Number.isFinite(updated) ? updated : 0,
    pinned: !!n.pinned,
    attachments: (Array.isArray(n.attachments) ? n.attachments : []).map(validateAttachmentRef).filter(Boolean),
  };
}

/* ---------- title extraction (AC6) ---------- */
/* The list shows the stored title; a note without one falls back to the
   first heading or paragraph of its own html, so an untitled note never
   reads as a blank row. Pure text pipeline: strip tags → decode exactly
   the five esc() entities → collapse whitespace → cap at 80 chars. */
const TITLE_CAP = 80;

const decodeEsc = s => String(s ?? '').replace(/&(?:amp|lt|gt|quot|#39);/g, e => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[e]);

const flat = s =>
  decodeEsc(String(s ?? ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function noteTitleFromHtml(html) {
  const h = String(html ?? '').match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const src = h
    ? flat(h[1])
    : (() => {
        const p = String(html ?? '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const text = p ? flat(p[1]) : flat(html);
        return text;
      })();
  if (!src) return '';
  return src.length > TITLE_CAP ? src.slice(0, TITLE_CAP) + '…' : src;
}

/* ---------- plain text (search + snippet) ---------- */
/* Strips every tag, decodes esc() entities, collapses whitespace. The
   search page and the list snippet render this through esc() — tags are
   gone so no markup can leak through the plain-text path either. */
export function noteTextFromHtml(html) {
  return flat(html);
}

/* Short plain-text preview for list rows (no ellipsis when it fits). */
export function noteSnippet(html, max = 110) {
  const text = noteTextFromHtml(html);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ---------- AC2/AC5: search (title + text, case-insensitive) ---------- */
/* A note matches when the query appears in its stored title OR its plain
   text (tags stripped, so 'R&D' matches through the decoded text, markup
   never). Empty/whitespace queries match everything (the page then shows
   the plain sorted list). Pure: returns a filtered copy in input order. */
export function searchNotes(notes, q) {
  const arr = Array.isArray(notes) ? notes : [];
  const query = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!query) return [...arr];
  return arr.filter(n => {
    if (!n || typeof n !== 'object') return false;
    const title = String(n.title || '').toLowerCase();
    if (title.includes(query)) return true;
    return noteTextFromHtml(n.html).toLowerCase().includes(query);
  });
}

/* ---------- AC2: ordering (pin-first, updated desc) ---------- */
/* Pinned notes surface first; within each group newest `updated` wins.
   Missing/NaN updated sorts last inside its group. Pure: new array. */
export function sortNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .filter(n => n && typeof n === 'object')
    .slice()
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      const au = Number(a.updated) || 0;
      const bu = Number(b.updated) || 0;
      return bu - au;
    });
}

/* ---------- pure list edits ---------- */
/* Replace-by-id in place; unknown ids append; a null note changes
   nothing. removeNote filters by id. Both return new arrays. */
export function upsertNote(notes, note) {
  const arr = Array.isArray(notes) ? notes : [];
  if (!note || typeof note !== 'object' || !note.id) return arr;
  const i = arr.findIndex(n => n && n.id === note.id);
  return i < 0 ? [...arr, note] : arr.map(n => (n && n.id === note.id ? note : n));
}

export function removeNote(notes, id) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && n.id !== id);
}

/* ---------- AC4: attachment refs ---------- */
/* One ref as stored on the note: { name, path, size, type }. path is the
   storage object path '<userId>/<noteId>/<filename>' — the exact prefix
   the storage RLS policies scope by. validateAttachmentRef is the trust
   boundary: refs arrive in the doc from sync, so a malformed ref (name
   with separators, path not ending in the name, non-numeric size) is
   normalized to null and dropped at hydration (makeNote) and rendering. */
export function validateAttachmentRef(a) {
  const r = a && typeof a === 'object' ? a : null;
  if (!r) return null;
  const name = typeof r.name === 'string' ? r.name : '';
  const path = typeof r.path === 'string' ? r.path : '';
  const size = Number(r.size);
  const type = typeof r.type === 'string' ? r.type : null;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.length > 255) return null;
  const parts = path.split('/');
  if (parts.length !== 3 || parts.some(p => !p)) return null;
  if (parts[2] !== name) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  if (type === null) return null;
  return { name, path, size, type };
}

/* Build a ref for a File-like object (browser File or a plain shape in
   tests). Oversize files return null — the caller shows the honest
   "over 10 MB" error and never uploads. */
export function attachmentRefFor(file, userId, noteId) {
  const f = file && typeof file === 'object' ? file : null;
  if (!f || !userId || !noteId) return null;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) return null;
  const name = safeAttachmentName(f.name);
  return { name, path: noteAttachmentPath(userId, noteId, name), size, type: typeof f.type === 'string' ? f.type : '' };
}

/* ---------- security: filename sanitization ---------- */
/* No path traversal can survive: separators become '-', dot-dot segments
   are dropped, control characters are stripped, trailing dots are removed
   and the result is capped at 120 chars with its extension preserved.
   Everything empty falls back to 'file'. */
const NAME_CAP = 120;

export function safeAttachmentName(name) {
  const raw = String(name ?? '');
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[/\\]+/)
    .filter(seg => seg && !/^[.\s]*$/.test(seg))
    .join('-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  const out = cleaned || 'file';
  if (out.length <= NAME_CAP) return out;
  const dot = out.lastIndexOf('.');
  const ext = dot > 0 ? out.slice(dot) : '';
  return ext && ext.length < NAME_CAP ? out.slice(0, NAME_CAP - ext.length) + ext : out.slice(0, NAME_CAP);
}

/* The canonical storage path for one attachment: <userId>/<noteId>/<safe
   name>. The uid prefix is what the storage.objects RLS policies scope
   by, so it must never be empty. */
export function noteAttachmentPath(userId, noteId, name) {
  if (!userId || !noteId) return '';
  return `${userId}/${noteId}/${safeAttachmentName(name)}`;
}

/* ---------- security: link URL allowlist ---------- */
/* The editor's link insertion accepts only http(s) URLs without embedded
   credentials. Everything else returns '' and the caller refuses with an
   honest error. The sanitizer is the second gate: its URI regexp would
   strip a javascript:/data: href even if one slipped through here. */
export function noteSafeLinkUrl(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return s;
  } catch {
    return '';
  }
}

/* ---------- fictional seed sample (fresh workspaces only) ---------- */
/* Clearly fictional: the note says in plain words that it is a sample.
   It demonstrates every editor construct (heading, list, quote, code
   block, link) so new workspaces see what the editor produces, and it is
   pinned so the pin-first ordering is visible on day one. */
const cOff = days => Date.now() - days * 864e5;

export function notesSeed() {
  return [
    makeNote({
      id: 'n1',
      title: 'Welcome to Notes',
      created: cOff(2),
      updated: cOff(1),
      pinned: true,
      attachments: [],
      html: [
        '<h2>This is a sample note</h2>',
        '<p>Everything here is <b>fictional demo content</b> — delete it whenever you like. Notes autosave as you type and live inside your workspace document.</p>',
        '<p><b>Formatting</b> you can use: <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, headings, quotes and code.</p>',
        '<h3>What Notes can hold</h3>',
        '<ul><li>Meeting agendas and action items</li><li>Drafts of client emails</li><li>Any document, with <b>file attachments</b> up to 10&nbsp;MB each</li></ul>',
        '<blockquote>Pin a note to keep it at the top of the list.</blockquote>',
        '<pre><code>cd ~/atrium &amp;&amp; npm run dev</code></pre>',
        '<p>Docs live at <a href="https://example.com/atrium-handbook" target="_blank" rel="noopener noreferrer nofollow">the (fictional) handbook</a>.</p>',
      ].join(''),
    }),
  ];
}
