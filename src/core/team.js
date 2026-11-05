/* =====================================================================
   TEAM · pure helpers for multi-user membership (T6).
   Data-in/data-out only: no store, no client, no network — the async
   wrappers live in workspace-api.js and pass results through these.
   ===================================================================== */

/* ---------- member ids ---------- */

/* Next free doc-local member id 'm<n>' — numeric ids only, so legacy
   uid('m') demo entries (m + random base36) can never collide. */
export function nextMemberId(members) {
  const used = new Set(
    (members || [])
      .map(m => m && m.id)
      .filter(id => /^m\d+$/.test(id))
      .map(id => Number(id.slice(1))),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `m${n}`;
}

/* Display name from an email local part: separators become spaces, each
   word capitalised (same derivation the demo invite used). */
export function memberNameFromEmail(email) {
  return (email || '')
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/* ---------- invite entries (makeDoc-style validation) ---------- */

/* Validate + build one doc.members entry. Returns null on invalid input —
   callers must surface that honestly, never push a half-shaped member.
   Resolved (authUserId present) → active member; unresolved → pending,
   promoted to active by the owner's hydrate once they first sign in. */
export function makeInviteEntry({ members, email, authUserId, team = '', id } = {}) {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return null;
  const resolvedId = id !== undefined ? id : nextMemberId(members);
  if (!/^m\d+$/.test(resolvedId)) return null;
  const entry = {
    id: resolvedId,
    name: memberNameFromEmail(email) || 'Member',
    email,
    role: 'Member',
    team: team || '',
    title: 'Member',
    c: '#6B7280',
    status: 'active',
    last: null,
    tz: '—',
  };
  if (authUserId) entry.authUserId = authUserId;
  else {
    entry.pending = true;
    entry.status = 'invited';
  }
  return entry;
}

/* Split invite targets into fresh vs already-in-the-workspace addresses
   (case-insensitive; pending entries count as members too). */
export function splitInviteEmails(members, emails) {
  const seen = new Set((members || []).map(m => (m.email || '').toLowerCase()));
  const fresh = [];
  const dups = [];
  for (const e of emails || []) {
    (seen.has(e.toLowerCase()) ? dups : fresh).push(e);
  }
  return { fresh, dups };
}

/* ---------- identity bridge ---------- */

/* The doc member whose authUserId matches the viewer's auth uuid — the
   me-mapping keystone for members (owner resolution stays doc.me). */
export function findMemberByAuth(members, authUserId) {
  if (!authUserId) return null;
  return (members || []).find(m => m && m.authUserId === authUserId) || null;
}

/* Promote one pending member entry in place: stamp authUserId, clear the
   pending key (deleted, not false) and mark the entry active. Idempotent;
   mutates by reference so nothing else in the doc is touched. Returns
   whether anything changed. */
export function applyPendingResolution(member, authUserId) {
  if (!member || !authUserId) return false;
  if (member.authUserId === authUserId && !member.pending) return false;
  member.authUserId = authUserId;
  delete member.pending;
  member.status = 'active';
  return true;
}

/* ---------- workspace resolution (AC2: member > owner > bootstrap) ---------- */

/* Pick the member workspace to hydrate: most recently updated membership
   wins (no switcher — deterministic pick of one). */
export function pickMemberWorkspace(rows) {
  const ws = (rows || [])
    .map(r => r && r.workspaces)
    .filter(Boolean)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return ws[0] || null;
}

/* Resolution order for hydrate: (a) a workspace I am a MEMBER of,
   (b) my own owner row, (c) bootstrap (row null). */
export function pickWorkspaceTarget(memberRow, ownerRow) {
  if (memberRow) return { row: memberRow, mode: 'member' };
  if (ownerRow) return { row: ownerRow, mode: 'owner' };
  return { row: null, mode: 'bootstrap' };
}
