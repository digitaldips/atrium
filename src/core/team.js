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
   (case-insensitive; pending entries count as members too). A doc member
   with NEITHER authUserId NOR pending is pre-T6 demo residue — it is not
   a duplicate: the invite UPGRADES that entry in place (upgrades[]),
   which is exactly the live state of Wesley's doc for jonathan@… . */
export function splitInviteEmails(members, emails) {
  const real = (members || []).filter(m => m && m.email && (m.authUserId || m.pending));
  const legacy = (members || []).filter(m => m && m.email && !m.authUserId && !m.pending);
  const seen = new Set(real.map(m => m.email.toLowerCase()));
  const legacyByEmail = new Map(legacy.map(m => [m.email.toLowerCase(), m]));
  const fresh = [];
  const dups = [];
  const upgrades = [];
  for (const e of emails || []) {
    const k = e.toLowerCase();
    if (seen.has(k)) dups.push(e);
    else if (legacyByEmail.has(k)) upgrades.push({ email: e, entry: legacyByEmail.get(k) });
    else fresh.push(e);
  }
  return { fresh, dups, upgrades };
}

/* Upgrade a legacy demo entry to a real member: stamp the identity,
   mark active — in place, by reference (doc-local id, role, name, team
   and any references stay untouched). Idempotent; returns whether
   anything changed. */
export function upgradeLegacyMember(member, authUserId) {
  if (!member || !authUserId) return false;
  if (member.authUserId === authUserId && member.status === 'active') return false;
  member.authUserId = authUserId;
  member.status = 'active';
  return true;
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

/* Resolution order for hydrate (AC2): (a) a workspace I am a MEMBER of,
   (b) my owner row — loaded when it holds a document, (c) bootstrap when
   it is missing or empty (mode 'bootstrap'). needsBootstrapFn is the
   caller's needsBootstrap — injected so this stays dependency-free. */
export function pickWorkspaceTarget(memberRow, ownerRow, needsBootstrapFn) {
  const nb = needsBootstrapFn || (() => false);
  /* MF1 hardening: a NON-EMPTY own workspace always wins. Any workspace
     owner can plant a membership row for any user (owner_manages_members),
     so membership-wins only when the viewer's own row is missing or still
     the empty bootstrap default — a planted row can never hijack a viewer
     who actively uses their own workspace. */
  if (ownerRow && !nb(ownerRow)) return { row: ownerRow, mode: 'owner' };
  if (memberRow) return { row: memberRow, mode: 'member' };
  return { row: ownerRow, mode: 'bootstrap' };
}
