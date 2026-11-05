/* T6 team membership: pure resolution, me-mapping, invite handling, and the
   member sync path (update-by-id — must never take the owner upsert route). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextMemberId,
  memberNameFromEmail,
  makeInviteEntry,
  splitInviteEmails,
  findMemberByAuth,
  applyPendingResolution,
  upgradeLegacyMember,
  pickMemberWorkspace,
  pickWorkspaceTarget,
} from '../src/core/team.js';
import { buildMemberUpdatePayload, updateMemberWorkspaceDoc, pushDocUpdate, promotePendingMembers, applyUserIdentity } from '../src/core/workspace-api.js';

const ownerEntry = { id: 'm1', name: 'Wesley', email: 'wesley@operanceai.com', role: 'Owner', authUserId: 'auth-owner' };
const memberEntry = { id: 'm2', name: 'Jonathan', email: 'jonathan@operanceai.com', role: 'Member', authUserId: 'auth-member' };
const pendingEntry = { id: 'm3', name: 'Pat', email: 'pat@operanceai.com', role: 'Member', pending: true, status: 'invited' };

/* ---------- resolution order (MF1 hardening: a NON-EMPTY own workspace
   always wins — a membership row can be planted by any workspace owner,
   so membership wins only when the viewer's own row is missing/empty) ---------- */
test('pickWorkspaceTarget prefers a NON-EMPTY own workspace over a planted membership', () => {
  const memberRow = { id: 'w-attacker', data: { data: { tasks: [] } } };
  const ownerRow = { id: 'w-own', data: { data: { tasks: [{ id: 't1' }] } } };
  const pick = pickWorkspaceTarget(memberRow, ownerRow, () => false);
  assert.equal(pick.mode, 'owner');
  assert.equal(pick.row.id, 'w-own');
});

test('pickWorkspaceTarget: membership wins when the own row is missing or empty (real invitee)', () => {
  const memberRow = { id: 'w-shared', data: { data: { tasks: [] } } };
  const orphan = { id: 'w-own', data: {} };
  const pick = pickWorkspaceTarget(memberRow, orphan, r => !r || !r.data || !r.data.data || !Object.keys(r.data.data).length);
  assert.equal(pick.mode, 'member');
  assert.equal(pick.row.id, 'w-shared');
  assert.deepEqual(
    pickWorkspaceTarget(memberRow, null, () => false),
    { row: memberRow, mode: 'member' },
  );
});

test('pickWorkspaceTarget falls back to the owner row, then bootstrap', () => {
  const ownerRow = { id: 'w-own', data: { data: { tasks: [] } } };
  assert.deepEqual(
    pickWorkspaceTarget(null, ownerRow, () => false),
    { row: ownerRow, mode: 'owner' },
  );
  const none = pickWorkspaceTarget(null, null, () => false);
  assert.equal(none.row, null);
  assert.equal(none.mode, 'bootstrap');
});

test('pickWorkspaceTarget bootstraps an owner row without a usable document', () => {
  const empty = { id: 'w-own', data: {} };
  const pick = pickWorkspaceTarget(null, empty, r => !r || !r.data || !r.data.data || !Array.isArray(r.data.data.tasks));
  assert.equal(pick.mode, 'bootstrap');
  assert.equal(pick.row, empty);
});

test('pickMemberWorkspace picks the most recently updated membership', () => {
  assert.equal(pickMemberWorkspace([]), null);
  const a = { id: 'w-a', updated_at: '2026-11-01T10:00:00Z' };
  const b = { id: 'w-b', updated_at: '2026-11-04T10:00:00Z' };
  assert.equal(pickMemberWorkspace([{ workspaces: a }, { workspaces: b }]).id, 'w-b');
});

/* ---------- me-mapping (AC2: by authUserId, NOT doc.me) ---------- */
test('findMemberByAuth maps the viewer to the doc member carrying their authUserId', () => {
  const members = [ownerEntry, memberEntry, pendingEntry];
  assert.equal(findMemberByAuth(members, 'auth-member'), memberEntry);
  assert.equal(findMemberByAuth(members, 'auth-owner'), ownerEntry);
});

test('findMemberByAuth returns null for unknown or unlinked viewers', () => {
  const members = [ownerEntry, pendingEntry];
  assert.equal(findMemberByAuth(members, 'auth-nobody'), null);
  assert.equal(findMemberByAuth([], 'auth-member'), null);
});

test('applyUserIdentity stamps only the me entry — member entries are untouched', () => {
  const members = [ownerEntry, { ...memberEntry }, { ...pendingEntry }];
  const S = { data: { me: 'm1', members }, prefs: {} };
  assert.equal(applyUserIdentity(S, { email: 'wesley@operanceai.com', user_metadata: { full_name: 'Wesley R' } }), true);
  assert.equal(members[0].name, 'Wesley R');
  assert.equal(members[1].name, 'Jonathan');
  assert.equal(members[1].email, 'jonathan@operanceai.com');
  assert.equal(members[2].pending, true);
});

/* ---------- member ids (AC1: id 'm<n>', next free) ---------- */
test('nextMemberId allocates the next free m<n>, filling gaps', () => {
  assert.equal(nextMemberId([]), 'm1');
  assert.equal(nextMemberId([{ id: 'm1' }]), 'm2');
  assert.equal(nextMemberId([{ id: 'm1' }, { id: 'm3' }]), 'm2');
  assert.equal(nextMemberId([{ id: 'm1' }, { id: 'm2' }, { id: 'm5' }]), 'm3');
});

test('nextMemberId ignores non m<n> ids (legacy uid entries)', () => {
  assert.equal(nextMemberId([{ id: 'm1' }, { id: 'mk3x9qz' }]), 'm2');
});

/* ---------- invite entries (AC1 + AC6: makeDoc-style validation) ---------- */
test('memberNameFromEmail derives a display name from the local part', () => {
  assert.equal(memberNameFromEmail('jonathan@operanceai.com'), 'Jonathan');
  assert.equal(memberNameFromEmail('ann.zwart@operanceai.com'), 'Ann Zwart');
  assert.equal(memberNameFromEmail('john_o-connor@x.io'), 'John O Connor');
});

test('makeInviteEntry builds a resolved member entry', () => {
  const members = [{ id: 'm1' }];
  const e = makeInviteEntry({ members, email: 'jonathan@operanceai.com', authUserId: 'auth-member', team: 'tm1' });
  assert.equal(e.id, 'm2');
  assert.equal(e.name, 'Jonathan');
  assert.equal(e.email, 'jonathan@operanceai.com');
  assert.equal(e.authUserId, 'auth-member');
  assert.equal(e.role, 'Member');
  assert.equal(e.status, 'active');
  assert.equal('pending' in e, false);
  assert.equal(e.last, null);
});

test('makeInviteEntry builds a pending entry when the email is not on the platform', () => {
  const e = makeInviteEntry({ members: [{ id: 'm1' }], email: 'newbie@operanceai.com', authUserId: null, team: '' });
  assert.equal(e.authUserId, undefined);
  assert.equal(e.pending, true);
  assert.equal(e.status, 'invited');
});

test('makeInviteEntry refuses invalid input (makeDoc-style validation)', () => {
  assert.equal(makeInviteEntry({ members: [], email: 'not-an-email', authUserId: null, team: '' }), null);
  assert.equal(makeInviteEntry({ members: [], email: '', authUserId: 'auth-x', team: '' }), null);
  assert.equal(makeInviteEntry({ members: [], email: 'a@b.c', authUserId: 'auth-x', team: '', id: 'bad id' }), null);
});

/* ---------- duplicates (AC1: duplicate email handled honestly) ---------- */
test('splitInviteEmails separates fresh addresses from duplicates (case-insensitive)', () => {
  const members = [ownerEntry, memberEntry, pendingEntry];
  const { fresh, dups } = splitInviteEmails(members, ['JONATHAN@operanceai.com', 'pat@operanceai.com', 'new@operanceai.com']);
  assert.deepEqual(fresh, ['new@operanceai.com']);
  assert.deepEqual(dups, ['JONATHAN@operanceai.com', 'pat@operanceai.com']);
});

/* Legacy demo invites (pre-T6): doc members with neither authUserId nor
   pending are display-only residue — they must be UPGRADED by the invite,
   not treated as duplicates (Wesley's live doc carries exactly such an
   entry for jonathan@operanceai.com). */
const legacyEntry = { id: 'mufx73z', name: 'Jonathan', email: 'jonathan@operanceai.com', role: 'Admin', status: 'invited' };

test('splitInviteEmails offers legacy unlinked entries for upgrade instead of refusing', () => {
  const { fresh, dups, upgrades } = splitInviteEmails([ownerEntry, legacyEntry], ['JONATHAN@operanceai.com', 'new@operanceai.com']);
  assert.deepEqual(fresh, ['new@operanceai.com']);
  assert.deepEqual(dups, [], 'a legacy entry is not a duplicate');
  assert.deepEqual(upgrades, [{ email: 'JONATHAN@operanceai.com', entry: legacyEntry }]);
});

test('upgradeLegacyMember stamps the identity in place, by reference, idempotently', () => {
  const e = { ...legacyEntry };
  assert.equal(upgradeLegacyMember(e, 'auth-member'), true);
  assert.equal(e.authUserId, 'auth-member');
  assert.equal(e.status, 'active');
  assert.equal(e.id, 'mufx73z', 'the doc-local id is preserved (referential stability)');
  assert.equal(e.role, 'Admin', 'display role is not rewritten');
  assert.equal('pending' in e, false);
  const ref = e;
  assert.equal(upgradeLegacyMember(e, 'auth-member'), false, 'idempotent');
  assert.equal(ref, e);
});

/* ---------- pending resolution (AC1: resolve authUserId at first sign-in) ---------- */
test('applyPendingResolution patches the entry in place and clears the pending key', () => {
  const m = { ...pendingEntry };
  const changed = applyPendingResolution(m, 'auth-pat');
  assert.equal(changed, true);
  assert.equal(m.authUserId, 'auth-pat');
  assert.equal('pending' in m, false, 'pending key is deleted, not set to false');
  assert.equal(m.status, 'active');
});

test('applyPendingResolution is idempotent and by-reference', () => {
  const m = { ...pendingEntry };
  applyPendingResolution(m, 'auth-pat');
  assert.equal(applyPendingResolution(m, 'auth-pat'), false);
  const ref = m;
  applyPendingResolution(m, 'auth-pat2');
  assert.equal(ref.authUserId, 'auth-pat2');
});

/* ---------- member sync: update-by-id, owner-me restored (AC3 + me-model) ---------- */
test('buildMemberUpdatePayload restores the owner me in the payload without mutating S.data', () => {
  const S = {
    data: { me: 'm2', tasks: [{ id: 't1' }], members: [ownerEntry, memberEntry] },
    prefs: { theme: 'dark' },
    views: { v: 1 },
    ui: { memberCtx: { wsId: 'w-shared', memberId: 'm2', ownerMe: 'm1' } },
  };
  const sharedPrefs = { theme: 'light', calendarIds: ['primary'] };
  const payload = buildMemberUpdatePayload(S, 'm1', sharedPrefs);
  assert.equal(payload.data.me, 'm1', 'synced doc keeps the owner me');
  assert.deepEqual(payload.data.tasks, [{ id: 't1' }]);
  assert.deepEqual(payload.data.members, [ownerEntry, memberEntry]);
  /* S2: the member's LOCAL prefs never ride the shared sync — the
     hydrate-time shared snapshot is written back untouched. */
  assert.deepEqual(payload.prefs, sharedPrefs, "member's local prefs (theme dark) must not leak into the shared doc");
  assert.deepEqual(payload.views, { v: 1 });
  assert.equal(S.data.me, 'm2', 'the viewer overlay is not mutated by building the payload');
});

function fakeUpdateClient({ updateErr = null, rpcId = null, insertErr = null, updateRows = null, probeRow = null } = {}) {
  const calls = { updates: [], upserts: [], inserts: [], rpcs: [], probes: [] };
  const client = {
    calls,
    from() {
      return {
        update(payload) {
          const rec = { payload, eqs: [], table: 'workspaces' };
          calls.updates.push(rec);
          const chain = {
            eq(key, val) {
              rec.eqs.push({ key, val });
              return chain;
            },
            select() {
              rec.selected = true;
              return Promise.resolve({ data: updateRows, error: updateErr });
            },
          };
          return chain;
        },
        select() {
          calls.probes.push(1);
          return {
            eq(key, val) {
              return { maybeSingle: async () => ({ data: probeRow, error: null }) };
            },
          };
        },
        upsert(payload, opts) {
          calls.upserts.push({ payload, opts });
          return {
            select() {
              return { single: async () => ({ data: { ...payload, id: 'w1' }, error: null }) };
            },
          };
        },
        insert(rows) {
          calls.inserts.push(rows);
          return {
            select: async () => ({ data: rows, error: insertErr }),
          };
        },
      };
    },
    rpc(fn, args) {
      calls.rpcs.push({ fn, args });
      return Promise.resolve({ data: rpcId, error: null });
    },
  };
  return client;
}

test('updateMemberWorkspaceDoc updates the shared row by id with the updated_at precondition and never upserts by owner', async () => {
  const client = fakeUpdateClient({ updateRows: [{ id: 'w-shared', updated_at: 'T2' }] });
  const S = { data: { me: 'm2', tasks: [] }, prefs: {}, views: {}, ui: {} };
  const row = await updateMemberWorkspaceDoc(client, 'w-shared', S, 'm1', { theme: 'light' }, 'T1');
  assert.equal(client.calls.upserts.length, 0, 'member sync must not take the owner upsert path');
  assert.equal(client.calls.updates.length, 1);
  assert.deepEqual(client.calls.updates[0].eqs, [
    { key: 'id', val: 'w-shared' },
    { key: 'updated_at', val: 'T1' },
  ]);
  assert.equal(client.calls.updates[0].selected, true, 'the update must return the fresh row (syncedUpdatedAt tracking)');
  assert.equal(row.updated_at, 'T2', 'the fresh updated_at rides back for the next precondition');
  assert.equal(client.calls.updates[0].payload.data.data.me, 'm1', 'row jsonb keeps the owner me (row.data.data.me)');
});

test('updateMemberWorkspaceDoc throws SYNC_CONFLICT on a stale snapshot (row still exists)', async () => {
  const client = fakeUpdateClient({ updateRows: [], probeRow: { id: 'w-shared' } });
  const S = { data: { me: 'm2', tasks: [] }, prefs: {}, views: {}, ui: {} };
  await assert.rejects(
    () => updateMemberWorkspaceDoc(client, 'w-shared', S, 'm1', {}, 'T1'),
    e => e.code === 'SYNC_CONFLICT',
  );
});

test('updateMemberWorkspaceDoc throws SYNC_REMOVED when the row is gone (removed member)', async () => {
  const client = fakeUpdateClient({ updateRows: [], probeRow: null });
  const S = { data: { me: 'm2', tasks: [] }, prefs: {}, views: {}, ui: {} };
  await assert.rejects(
    () => updateMemberWorkspaceDoc(client, 'w-shared', S, 'm1', {}, 'T1'),
    e => e.code === 'SYNC_REMOVED',
  );
});

test('updateMemberWorkspaceDoc throws honestly on failure', async () => {
  const client = fakeUpdateClient({ updateErr: { message: 'row-level security', code: '42501' } });
  const S = { data: { me: 'm2', tasks: [] }, prefs: {}, views: {}, ui: {} };
  await assert.rejects(() => updateMemberWorkspaceDoc(client, 'w-shared', S, 'm1', {}, 'T1'), /row-level security/);
});

test('pushDocUpdate routes through update-by-id when the viewer is a member', async () => {
  const client = fakeUpdateClient({ updateRows: [{ id: 'w-shared', updated_at: 'T2' }] });
  const S = {
    data: { me: 'm2', tasks: [] },
    prefs: {},
    views: {},
    ui: { offline: false, syncedUpdatedAt: 'T1', sharedPrefsSnapshot: { theme: 'light' }, memberCtx: { wsId: 'w-shared', memberId: 'm2', ownerMe: 'm1' } },
  };
  const res = await pushDocUpdate(client, 'auth-member', S, 'Operance');
  assert.equal(res, 'ok');
  assert.equal(client.calls.upserts.length, 0, 'a member sync must never touch their own orphan row via upsert');
  assert.equal(client.calls.updates.length, 1);
  assert.deepEqual(client.calls.updates[0].eqs, [
    { key: 'id', val: 'w-shared' },
    { key: 'updated_at', val: 'T1' },
  ]);
  assert.equal(S.ui.syncedUpdatedAt, 'T2', 'the precondition advances with each successful sync');
});

test('pushDocUpdate reports the conflict honestly instead of marking success', async () => {
  const client = fakeUpdateClient({ updateRows: [], probeRow: { id: 'w-shared' } });
  const S = {
    data: { me: 'm2', tasks: [] },
    prefs: {},
    views: {},
    ui: { offline: false, syncedUpdatedAt: 'T1', sharedPrefsSnapshot: {}, memberCtx: { wsId: 'w-shared', memberId: 'm2', ownerMe: 'm1' } },
  };
  const res = await pushDocUpdate(client, 'auth-member', S, 'Operance');
  assert.equal(res, 'conflict');
  assert.equal(S.ui.offline, true, 'the conflict must trip the honest sync-failure state (no silent success)');
});

test('pushDocUpdate keeps the owner upsert path when the workspace was never synced', async () => {
  const client = fakeUpdateClient();
  const S = { data: { me: 'm1', tasks: [] }, prefs: {}, views: {}, ui: { offline: false } };
  const res = await pushDocUpdate(client, 'auth-owner', S, 'Operance');
  assert.equal(res, 'ok');
  assert.equal(client.calls.upserts.length, 1);
  assert.equal(client.calls.updates.length, 0);
  assert.equal(client.calls.upserts[0].payload.owner_id, 'auth-owner');
});

test('pushDocUpdate takes the owner update-by-id path once a synced snapshot exists', async () => {
  const client = fakeUpdateClient({ updateRows: [{ id: 'w-own', updated_at: 'T2' }] });
  const S = { data: { me: 'm1', tasks: [] }, prefs: {}, views: {}, ui: { offline: false, wsId: 'w-own', syncedUpdatedAt: 'T1' } };
  const res = await pushDocUpdate(client, 'auth-owner', S, 'Operance');
  assert.equal(res, 'ok');
  assert.equal(client.calls.upserts.length, 0, 'after bootstrap the owner syncs by id too (MF2 precondition)');
  assert.equal(client.calls.updates.length, 1);
  assert.deepEqual(client.calls.updates[0].eqs, [
    { key: 'id', val: 'w-own' },
    { key: 'updated_at', val: 'T1' },
  ]);
});

/* ---------- pending promotion (owner hydrate heals pending invitees) ---------- */
test('promotePendingMembers resolves, patches, and inserts membership rows', async () => {
  const client = fakeUpdateClient({ rpcId: 'auth-pat' });
  const members = [{ ...ownerEntry }, { ...pendingEntry }];
  const changed = await promotePendingMembers(client, 'w-shared', members, 'm1', 'auth-owner');
  assert.equal(changed, true);
  assert.equal(client.calls.rpcs.length, 1);
  assert.deepEqual(client.calls.rpcs[0], { fn: 'atrium_find_user_id', args: { p_workspace_id: 'w-shared', p_email: 'pat@operanceai.com' } });
  assert.deepEqual(client.calls.inserts, [{ workspace_id: 'w-shared', user_id: 'auth-pat' }]);
  assert.equal(members[1].authUserId, 'auth-pat');
  assert.equal('pending' in members[1], false);
  assert.equal(members[0].authUserId, 'auth-owner', 'owner entry gains its authUserId (identity bridge)');
});

test('promotePendingMembers leaves entries alone when the email is still unknown', async () => {
  const client = fakeUpdateClient({ rpcId: null });
  const members = [{ ...ownerEntry, authUserId: undefined }, { ...pendingEntry }];
  const changed = await promotePendingMembers(client, 'w-shared', members, 'm1', 'auth-owner');
  assert.equal(changed, true, 'owner stamp alone still counts as a change');
  assert.equal(members[1].pending, true);
  assert.equal(members[1].authUserId, undefined);
  assert.equal(client.calls.inserts.length, 0);
  assert.equal(members[0].authUserId, 'auth-owner');
});

test('promotePendingMembers is a no-op when everything is already resolved', async () => {
  const client = fakeUpdateClient({ rpcId: 'auth-x' });
  const members = [{ ...ownerEntry }, { ...memberEntry }];
  const changed = await promotePendingMembers(client, 'w-shared', members, 'm1', 'auth-owner');
  assert.equal(changed, false);
  assert.equal(client.calls.rpcs.length, 0);
  assert.equal(client.calls.inserts.length, 0);
});

test('promotePendingMembers heals a duplicate membership row (23505) instead of failing', async () => {
  const client = fakeUpdateClient({ rpcId: 'auth-pat', insertErr: { code: '23505', message: 'duplicate key' } });
  const members = [{ ...ownerEntry, authUserId: undefined }, { ...pendingEntry }];
  const changed = await promotePendingMembers(client, 'w-shared', members, 'm1', 'auth-owner');
  assert.equal(changed, true);
  assert.equal(members[1].authUserId, 'auth-pat');
});

test('promotePendingMembers skips a failing rpc without blocking the rest', async () => {
  const client = fakeUpdateClient({ rpcId: null });
  client.rpc = () => Promise.reject(new Error('rpc down'));
  const members = [{ ...ownerEntry, authUserId: undefined }, { ...pendingEntry }];
  const changed = await promotePendingMembers(client, 'w-shared', members, 'm1', 'auth-owner');
  assert.equal(changed, true, 'the owner stamp still lands');
  assert.equal(members[1].pending, true, 'failed resolution leaves the entry pending for the next hydrate');
});
