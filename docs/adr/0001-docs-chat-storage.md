# ADR 0001 — Docs (and Chat) storage: Postgres tables, not the workspace document

- Status: accepted (workstream atrium-orbit, T1)
- Date: 2026-11-04
- Deciders: Wesley Romeijnders, orchestrator + implementer (dev-pipeline)

## Context

Atrium keeps everything the user works on in ONE workspace document —
`public.workspaces.data` (jsonb), write-through synced on a debounced save.
Notes, clients, deals, orgs and links all live inside that document as arrays.
The Docs module (ported from Orbit) needs: a nested page tree, version history
(auto/restore/import snapshots), full-text search over title + body, live
co-editing between tabs, and an optimistic-concurrency save path. Chat (T2)
will need threads, unread flags and per-message search.

## Decision

Docs pages live in NEW Postgres tables, not in the workspace document:

- `docs_pages` — one row per page: parent tree (`parent_id` self-ref),
  `title`, `icon`, sanitized-HTML `content_html`, `content_text`,
  generated `search` tsvector + GIN index, `position`, `version`
  (bumped by a BEFORE UPDATE trigger on every content change), `source`
  jsonb (import provenance), `deleted_at` (trash is soft), timestamps.
- `docs_versions` — snapshots with `kind in ('auto','restore','import')`,
  `created_by`, taken on the client save path under the Orbit ≥10-minute
  rule; restore always snapshots the current content first.

RLS mirrors 0001: only workspace members read/write
(`is_workspace_member` SECURITY DEFINER helper, DML-only grants). The
workspace document gains NO new keys (zero-loss by construction: the
`ensureXxxData` initializer class does not apply here at all).

**Live co-editing** is Supabase Realtime (broadcast + presence) on one
channel per page (`docs:page:<id>`), with the durable save path
version-checked: the client sends the version it read, the trigger
increments, a stale writer updates zero rows, adopts the fresh row and
re-bases with one retry (last-write-wins per commit; honest conflict
toast when the retry also fails).

**Granola import** runs from an export FILE (Granola has no public API):
YAML frontmatter + markdown body → small pure markdown→HTML converter →
pages tagged `source {kind:'granola', sourceId}`; re-import dedupes on
`sourceId` and updates in place; each import writes a `docs_versions`
row with kind `import`. A connection card shows status derived from the
tables (never connected / last import + page count) — no stored
connection state, because there is nothing to connect to.

## Alternatives considered

1. **Pages inside the workspace document (notes model).** Rejected:
   version history means per-page row sets (a doc-side `versions[]`
   array grows unboundedly inside every sync payload), FTS needs server
   support (a jsonb array can't back a tsvector column), realtime
   per-page channeling and optimistic concurrency per page are unnatural
   over a single-document upsert, and every keystroke autosave would
   rewrite the ENTIRE workspace document (sync amplification + lost
   updates against every other surface).
2. **Orbit's BlockNote JSON + Yjs collab server.** Rejected for this
   port: Orbit's model needs a dedicated collab server (page_collab_docs
   with Yjs updates + compaction) and a BlockNote editor. Atrium's notes
   editor is contenteditable + sanitized HTML with the same sanitizer
   contract at save and render; porting it keeps one editor idiom, zero
   new runtime dependencies, and no second server process on the stack.
   Version-checked saves give conflict detection without CRDT machinery
   (single-user workspaces today; LWW re-base is honest about it).
3. **SQLite FTS5 (Orbit's 0027).** Rejected: Postgres tsvector with a
   generated column + GIN is native here, RLS-scoped automatically, and
   reachable through supabase-js `.textSearch`.

## Consequences

- Positive: per-row RLS, server-side search, cheap per-page realtime,
  version rows are cheap, trash/restore is a column update, and the
  workspace document stays small and stable for CRM/notes sync.
- Negative: two storage models now coexist (document arrays for CRM,
  tables for docs/chat); the Docs module is online-first — offline edits
  are NOT queued (the workspace doc keeps the offline-first cache; docs
  surface honest offline errors instead).
- Chat (T2) follows the same shape (0006/0007 tables), which is why this
  ADR covers both.
