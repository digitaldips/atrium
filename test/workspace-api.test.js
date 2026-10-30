/* Unit tests for the pure workspace data layer (src/core/workspace-api.js).
   No network: every client is a fake shaped like the supabase-js v2 query builder. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocPayload,
  errMessage,
  isAuthedSession,
  loadWorkspaceDoc,
  markSyncFailure,
  markSyncSuccess,
  needsBootstrap,
  signInWithPassword,
  signOutUser,
  signUp,
  upsertWorkspaceDoc,
  workspaceRowToDoc,
} from '../src/core/workspace-api.js';

/* ---- fake supabase-js client ---- */
function fakeClient({ row, selectErr = null, upsertErr = null, upsertRow = null, authHandlers = {} } = {}) {
  const calls = { from: [], selects: [], upserts: [], auth: [] };
  const client = {
    calls,
    from(table) {
      calls.from.push(table);
      return {
        select(cols) {
          calls.selects.push({ table, cols });
          return {
            eq(col, val) {
              calls.selects[calls.selects.length - 1].eq = { col, val };
              return {
                maybeSingle: async () => (selectErr ? { data: null, error: selectErr } : { data: row ?? null, error: null }),
              };
            },
          };
        },
        upsert(payload, opts) {
          calls.upserts.push({ table, payload, opts });
          return {
            select() {
              return {
                single: async () => (upsertErr ? { data: null, error: upsertErr } : { data: upsertRow ?? { ...payload, id: 'w1' }, error: null }),
              };
            },
          };
        },
      };
    },
    auth: {
      async signInWithPassword(creds) {
        calls.auth.push(['signInWithPassword', creds]);
        return authHandlers.signIn ? authHandlers.signIn(creds) : { data: { session: { user: { id: 'u1' } }, user: { id: 'u1' } }, error: null };
      },
      async signUp(creds) {
        calls.auth.push(['signUp', creds]);
        return authHandlers.signUp ? authHandlers.signUp(creds) : { data: { session: { user: { id: 'u1' } }, user: { id: 'u1' } }, error: null };
      },
      async signOut() {
        calls.auth.push(['signOut']);
        return authHandlers.signOut ? authHandlers.signOut() : { error: null };
      },
    },
  };
  return client;
}

test('buildDocPayload returns exactly the data/prefs/views triple', () => {
  const data = { tasks: [{ id: 't1' }], me: 'm1' };
  const prefs = { theme: 'dark' };
  const views = { board: { sort: { f: 'due', dir: 1 } } };
  const payload = buildDocPayload(data, prefs, views);
  assert.deepEqual(payload, { data, prefs, views });
  assert.equal(payload.data, data, 'must not clone or wrap the data object');
});

test('workspaceRowToDoc hydrates a stored row into the doc shape', () => {
  const data = { data: { tasks: [1] }, prefs: { theme: 'light' }, views: { v: 1 } };
  const row = { id: 'w1', name: 'Atrium', data, updated_at: '2026-10-30T00:00:00Z' };
  assert.deepEqual(workspaceRowToDoc(row), { data: data.data, prefs: data.prefs, views: data.views });
});

test('workspaceRowToDoc fills missing doc sections with null and rejects empty rows', () => {
  assert.equal(workspaceRowToDoc(null), null);
  assert.equal(workspaceRowToDoc(undefined), null);
  assert.equal(workspaceRowToDoc({ id: 'w1', data: null }), null);
  const partial = workspaceRowToDoc({ id: 'w1', data: { data: { tasks: [] } } });
  assert.deepEqual(partial, { data: { tasks: [] }, prefs: null, views: null });
});

test('needsBootstrap is true only when there is no usable workspace document', () => {
  assert.equal(needsBootstrap(null), true);
  assert.equal(needsBootstrap(undefined), true);
  assert.equal(needsBootstrap({}), true);
  assert.equal(needsBootstrap({ data: {} }), true);
  assert.equal(needsBootstrap({ data: { data: null } }), true);
  assert.equal(needsBootstrap({ data: { data: { prefs: { theme: 'dark' } } } }), true, 'a doc without tasks is not a workspace');
  assert.equal(needsBootstrap({ data: { data: { tasks: [] } } }), false);
  assert.equal(needsBootstrap({ data: { data: { tasks: [{ id: 't1' }] } } }), false);
});

test('errMessage maps known auth/network failures to friendly copy', () => {
  assert.equal(errMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' }), 'Incorrect email or password.');
  assert.equal(errMessage({ message: 'Invalid login credentials' }), 'Incorrect email or password.');
  assert.equal(
    errMessage({ code: 'user_already_exists', message: 'User already registered' }),
    'An account with this email already exists. Try signing in instead.',
  );
  assert.equal(errMessage({ code: 'email_not_confirmed', message: 'Email not confirmed' }), 'Please confirm your email address before signing in.');
  assert.equal(errMessage({ code: 'over_request_rate_limit', message: 'Too many requests' }), 'Too many attempts. Wait a minute and try again.');
  assert.equal(errMessage(new TypeError('Failed to fetch')), "Can't reach the server. Check your connection and try again.");
  assert.equal(errMessage({ message: 'permission denied for table workspaces' }), "Can't reach the server. Check your connection and try again.");
  assert.equal(errMessage({ message: 'kaboom' }), 'kaboom');
  assert.equal(errMessage(null, 'fallback copy'), 'fallback copy');
  assert.equal(errMessage(undefined), 'Something went wrong. Please try again.');
});

test('isAuthedSession only accepts sessions with a user id', () => {
  assert.equal(isAuthedSession(null), false);
  assert.equal(isAuthedSession(undefined), false);
  assert.equal(isAuthedSession({}), false);
  assert.equal(isAuthedSession({ user: {} }), false);
  assert.equal(isAuthedSession({ user: { id: 'u1' } }), true);
});

test('loadWorkspaceDoc selects the owner row via maybeSingle', async () => {
  const row = { id: 'w1', name: 'Atrium', data: { data: { tasks: [] } } };
  const client = fakeClient({ row });
  const out = await loadWorkspaceDoc(client, 'user-1');
  assert.equal(out, row);
  assert.deepEqual(client.calls.from, ['workspaces']);
  assert.equal(client.calls.selects[0].eq.col, 'owner_id');
  assert.equal(client.calls.selects[0].eq.val, 'user-1');
  assert.match(client.calls.selects[0].cols, /data/);
});

test('loadWorkspaceDoc surfaces query errors as friendly failures', async () => {
  const client = fakeClient({ selectErr: { message: 'permission denied' } });
  await assert.rejects(() => loadWorkspaceDoc(client, 'user-1'), /Can't reach the server/);
});

test('upsertWorkspaceDoc writes owner_id, name and doc payload with onConflict owner_id', async () => {
  const client = fakeClient({ upsertRow: { id: 'w9', owner_id: 'user-1' } });
  const payload = { data: { tasks: [] }, prefs: {}, views: {} };
  const out = await upsertWorkspaceDoc(client, 'user-1', payload, 'Atrium');
  assert.equal(out.id, 'w9');
  assert.equal(client.calls.upserts.length, 1);
  assert.deepEqual(client.calls.upserts[0].payload, { owner_id: 'user-1', name: 'Atrium', data: payload });
  assert.deepEqual(client.calls.upserts[0].opts, { onConflict: 'owner_id' });
});

test('upsertWorkspaceDoc defaults the name and rejects on error', async () => {
  const ok = fakeClient({});
  await upsertWorkspaceDoc(ok, 'u', { data: {}, prefs: {}, views: {} });
  assert.equal(ok.calls.upserts[0].payload.name, 'My workspace');
  const bad = fakeClient({ upsertErr: { message: 'new row violates row-level security policy' } });
  await assert.rejects(() => upsertWorkspaceDoc(bad, 'u', { data: {}, prefs: {}, views: {} }), /new row violates/);
});

test('signInWithPassword returns the session data or throws mapped errors', async () => {
  const good = fakeClient({});
  const res = await signInWithPassword(good, 'a@b.co', 'pw123456789');
  assert.equal(res.session.user.id, 'u1');
  assert.deepEqual(good.calls.auth[0], ['signInWithPassword', { email: 'a@b.co', password: 'pw123456789' }]);
  const bad = fakeClient({ authHandlers: { signIn: () => ({ data: null, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } }) } });
  await assert.rejects(() => signInWithPassword(bad, 'a@b.co', 'nope'), /Incorrect email or password/);
});

test('signUp returns signup data and surfaces already-registered errors', async () => {
  const good = fakeClient({});
  const res = await signUp(good, 'a@b.co', 'pw123456789');
  assert.equal(res.session.user.id, 'u1');
  const taken = fakeClient({ authHandlers: { signUp: () => ({ data: null, error: { code: 'user_already_exists', message: 'User already registered' } }) } });
  await assert.rejects(() => signUp(taken, 'a@b.co', 'pw123456789'), /already exists/);
});

test('signOutUser delegates to the client auth signOut', async () => {
  const client = fakeClient({});
  await signOutUser(client);
  assert.deepEqual(client.calls.auth[0], ['signOut']);
});

test('markSyncFailure flips the offline flag and returns readable copy; success clears it', () => {
  const S = { ui: { offline: false } };
  const msg = markSyncFailure(S, new TypeError('Failed to fetch'), 'Sync failed');
  assert.equal(S.ui.offline, true);
  assert.equal(msg, "Can't reach the server. Check your connection and try again.");
  markSyncSuccess(S);
  assert.equal(S.ui.offline, false);
  assert.equal(markSyncSuccess(S), false, 'clearing when already online reports no change');
  const S2 = {};
  markSyncFailure(S2, null, 'Sync failed');
  assert.equal(S2.ui.offline, true, 'works even when S.ui was not initialised');
});
