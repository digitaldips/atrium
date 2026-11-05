# ADR 0003: Multi-user membership — invite, resolution, shared-doc sync, identity bridging

Date: 2026-11-05 (T6, atrium-teams)
Status: accepted

## Context

Atrium was single-owner by design: `loadWorkspaceDoc` resolved `owner_id = me`
only, `workspace_members` existed but was unused, and every surface
(tasks/mail/chat/docs) rendered from one owner's workspace document. Jonathan
(jonathan@operanceai.com) signed up; Wesley needs to add him to 'Operance' as
a full member sharing tasks, mail, docs and chat.

Constraints carried from 0001/0005/0006: RLS already permits members to
SELECT their workspace, read/write docs_pages and chat under
member-or-owner policies; `owner_manages_members` lets only the OWNER insert
membership rows; the workspace document (`workspaces.data`) has no UPDATE
policy for members; doc.members carry doc-local ids (`m1`) while chat uses
auth uuids and task assignees use doc member ids.

## Decision

1. **Membership-wins resolution.** Hydrate resolves (a) a workspace the
   viewer is a MEMBER of (workspace_members join, most recently updated
   first) → loaded, never bootstrapped; (b) else the owner row → loaded or
   bootstrapped. The pure decision lives in `pickWorkspaceTarget`
   (`src/core/team.js`, node-tested). Consequence: an invited user who owns
   their own bootstrap workspace never sees it again (no switcher in scope);
   the orphan row is left untouched — their client only ever syncs the
   shared workspace (update-by-id), never their orphan via the owner-keyed
   upsert.

2. **Member doc sync = update by id.** `pushDocUpdate` branches on
   `S.ui.memberCtx` (set by hydrate BEFORE any sync can fire): members
   write `workspaces.data` via `member_doc_update` (migration 0008,
   `FOR UPDATE USING is_workspace_member(id)`), never the owner-keyed
   upsert — a member upsert by their own `owner_id` would create/overwrite
   their orphan row with the shared doc. `flushPendingSync`, `save()`,
   `A.retryOnline` all funnel through `pushDocUpdate`; the only remaining
   direct upserts are owner bootstrap and owner onboarding (member-guarded).

3. **Identity bridging: authUserId on doc.members.** doc.members entries
   gain `authUserId` (the auth uuid). A member's hydrate sets
   `S.data.me` to the doc member whose `authUserId` matches their auth uuid
   (viewer overlay). The shared doc's `me` remains the OWNER's: the member's
   sync payload restores it (`buildMemberUpdatePayload`), and the offline
   cache carries `wsId` + `ownerMe` so an offline boot reconstructs the
   member context instead of ever taking the owner path. The owner's own
   entry is stamped when they first invite (or at promotion), which is what
   makes the chat DM picker able to name both sides; the picker also reads
   `workspaces.owner_id` (members can SELECT the joined workspace row).

4. **Invite.** Owner-only (Members → Add member). The owner's client
   resolves an email to an auth uuid via `atrium_find_user_id` (migration
   0008: SECURITY DEFINER, gated to users owning a workspace, arg name
   qualified inside the body to dodge the plpgsql column/param clash).
   - Resolved → `workspace_members` row inserted first (an RLS row without
     a doc entry leaves the invitee unable to resolve the workspace; the
     reverse leaves a dangling doc entry — the partial-invite window heals
     via a tolerated `23505` on retry), then the doc entry
     (`makeInviteEntry`: id `m<n>` next free, name from the email local
     part, role Member, status active).
   - Unresolved → pending: doc entry with `pending: true`, status invited,
     NO membership row (RLS forbids a NULL/unknown user id). The OWNER's
     hydrate re-resolves pending entries via the RPC and promotes them
     (stamp authUserId, clear pending, insert the membership row) — the
     only RLS-coherent place, since members cannot insert membership rows.
   - Duplicate (case-insensitive, real members and pending entries) →
     honest inline error, no write.
   - **Legacy demo entries** (pre-T6 invites created display-only members
     with neither `authUserId` nor `pending` — Wesley's live doc carries
     exactly one for jonathan@operanceai.com): not duplicates; the invite
     upgrades them in place (`upgradeLegacyMember` — id/role/name preserved,
     authUserId stamped, status active), keeping every doc-side reference
     stable. Proven zero-loss against a fetched copy of the live row: the
     JSON diff touches only `status` + `authUserId` of that entry.

5. **Two-writer model: LWW at doc granularity.** Owner and member both
   write the whole document through the debounced save; the last completed
   write wins the doc, and per-surface tables (docs_pages, chat_messages)
   write Postgres directly with their own RLS. Coarse LWW is acceptable at
   this scale (two humans, debounced 500 ms); finer merging is rejected
   until a real conflict shows up in practice.

6. **Corruption guards.** A member cannot: invite (honest toast), create or
   delete workspaces (onboarding/delete would push seed or template docs
   over the shared doc), or remove members (removal is out of scope and a
   doc-entry deletion would strand the RLS membership row).
   `applyUserIdentity` runs only on the owner bootstrap path — it must
   never stamp a member's identity over the owner's shared-doc entry.

## Rejected alternatives

- **Pending members stored in workspace_members with a NULL user id** — the
  PK `(workspace_id, user_id)` forbids it; rejected.
- **Invitee self-resolution** (pending user hydrates the shared workspace
  by matching their own email and inserts their membership row) — blocked by
  `owner_manages_members` (only the owner inserts); would require widening
  RLS for no benefit. Owner-side promotion chosen.
- **Per-key merge of the workspace doc** (e.g. merging `tasks[]` by id) —
  large surface, race-prone, no demonstrated need at two users; LWW chosen,
  revisit only on a proven lost-write complaint.
- **Server-side invite endpoint** (edge function with service role) —
  duplicates the RPC in a second runtime; the owner-gated RPC plus client
  flow keeps one code path and honest toasts.
- **Separate member role column / permission matrix** — explicitly out of
  scope (AC 10); `workspace_members.role` stays 'member'.

## Evidence

- Migration live: `pg_policies.member_doc_update` + function (arg `email`,
  SECURITY DEFINER, execute granted to authenticated only).
- Node tests (RED→GREEN, 27 new): resolution order incl. the
  bootstrap fall-through regression (first-login crash caught by the dist
  probe), me-mapping by authUserId, next-member-id, invite
  validation/duplicate/pending/legacy-upgrade, member sync payload
  (owner-me restored) and update-by-id-vs-upsert routing, pending
  promotion (incl. 23505 heal + failing-rpc skip).
- Two-client dist-bundle probe (throwaway pair): owner invites → member's
  fresh session hydrates the shared workspace (Members shows "(you)" on
  their row) → member creates task PP-202 + DMs the owner via the picker →
  owner reload sees both tasks + the DM. Route walks: 21/21 routes, zero
  console errors in both sessions. Ground truth in Postgres at every step.
- Pending lifecycle: never-signed-in email → honest confirm → pending entry
  ("Invited" badge) → user signs up → owner's next hydrate promotes (m3
  active + membership row 2).
- Wesley's live row untouched by all probes; zero-loss proof on a fetched
  copy (above).

## Consequences (tightened by the T6 quality gate, 2026-11-05)

- **Hijack chain broken at resolution**: any workspace owner can plant a
  membership row for any user (`owner_manages_members`), and the
  `atrium_find_user_id` RPC resolves emails (now gated to the caller's OWN
  workspace, migration 0009). Resolution therefore prefers a NON-EMPTY own
  workspace; membership-wins only for viewers whose own row is missing or
  still the empty bootstrap default (the real-invitee case). Trade-off: an
  invitee who actively uses their own workspace stays in it — accepted.
- **Shared-doc LWW got an honest boundary**: syncs carry an `updated_at`
  precondition (member AND owner update-by-id paths; bootstrap keeps the
  upsert). A stale session snapshot can no longer silently revert another
  member's committed writes — the loser trips the sync-failure state with a
  reload prompt. The loss window is now the write race, not the session.
- **Member prefs are session-local**: the member sync writes the
  hydrate-time shared-prefs snapshot, so a member's theme/Google
  calendarIds can never rewrite the owner's prefs. Member-local prefs
  persistence is a follow-up.
- **Email→uuid enumeration**: the RPC is owner-gated per workspace, but any
  owner can still resolve platform emails — accepted (domain-internal,
  invitation context); revisit with a consent/token invite flow.
- **Removed members**: a removed member's sync hits 0 rows and stops with an
  honest "you were removed" state instead of a silent no-op.
