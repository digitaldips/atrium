/* Unit tests for the Google-only auth layer added to src/core/workspace-api.js.
   Pure functions only: the OAuth params builder, the sign-in wrapper (fake
   client), and the identity-from-metadata mapping. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACES_TABLE, applyUserIdentity, googleOAuthArgs, nameFromMetadata, signInWithGoogle } from '../src/core/workspace-api.js';

/* ---- fake supabase-js client (auth only) ---- */
function fakeOAuthClient({ oauthErr = null } = {}) {
  const calls = { auth: [] };
  const client = {
    calls,
    auth: {
      async signInWithOAuth(args) {
        calls.auth.push(['signInWithOAuth', args]);
        if (oauthErr) return { data: null, provider: 'google', url: null, error: oauthErr };
        return { data: { provider: 'google', url: 'https://accounts.google.com/o/oauth2/v2/auth' }, error: null };
      },
    },
  };
  return client;
}

/* ---------- AC4a: OAuth params builder ---------- */

test('googleOAuthArgs mirrors the Operance Workspace OAuth contract exactly', () => {
  const args = googleOAuthArgs('https://atrium.ship.digitaldips.xyz');
  assert.deepEqual(
    args,
    {
      provider: 'google',
      options: {
        redirectTo: 'https://atrium.ship.digitaldips.xyz',
        queryParams: {
          hd: 'operanceai.com',
          prompt: 'select_account',
        },
      },
    },
    'provider, redirectTo and queryParams must match the workspace.operanceai.com contract',
  );
});

test('googleOAuthArgs keeps the origin argument out of queryParams', () => {
  const args = googleOAuthArgs('http://127.0.0.1:5173');
  assert.equal(args.options.redirectTo, 'http://127.0.0.1:5173');
  assert.deepEqual(Object.keys(args.options.queryParams), ['hd', 'prompt'], 'no stray query params');
});

/* ---------- AC4a: the wrapper must pass the contract object through ---------- */

test('signInWithGoogle calls client.auth.signInWithOAuth with the exact contract args', async () => {
  const client = fakeOAuthClient();
  const res = await signInWithGoogle(client, 'https://atrium.ship.digitaldips.xyz');
  assert.equal(res.provider, 'google');
  assert.equal(client.calls.auth.length, 1, 'exactly one OAuth call');
  assert.deepEqual(
    client.calls.auth[0],
    ['signInWithOAuth', googleOAuthArgs('https://atrium.ship.digitaldips.xyz')],
    'the wrapper must not mutate or rebuild the contract object',
  );
});

test('signInWithGoogle surfaces provider errors instead of failing silently', async () => {
  const client = fakeOAuthClient({ oauthErr: { message: 'Provider is not enabled' } });
  await assert.rejects(() => signInWithGoogle(client, 'https://atrium.ship.digitaldips.xyz'), /Provider is not enabled/);
});

/* ---------- AC4b: identity-from-metadata mapping ---------- */

test('nameFromMetadata prefers user_metadata.full_name', () => {
  assert.equal(nameFromMetadata({ email: 'wes@operanceai.com', user_metadata: { full_name: 'Wes Romeijnders', name: 'Wes' } }), 'Wes Romeijnders');
});

test('nameFromMetadata falls back to user_metadata.name', () => {
  assert.equal(nameFromMetadata({ email: 'wes@operanceai.com', user_metadata: { name: 'Wes Romeijnders' } }), 'Wes Romeijnders');
  assert.equal(
    nameFromMetadata({ email: 'someone@operanceai.com', user_metadata: { full_name: '' } }),
    'Someone',
    'an empty full_name falls through to the local-part',
  );
});

test('nameFromMetadata falls back to the email local-part, capitalised', () => {
  assert.equal(nameFromMetadata({ email: 'sam.jones@operanceai.com', user_metadata: {} }), 'Sam.Jones');
  assert.equal(nameFromMetadata({ email: 'wes@operanceai.com' }), 'Wes', 'metadata may be absent entirely (Google supplies it, be safe)');
});

test('nameFromMetadata falls back to the neutral name when a user has nothing usable', () => {
  assert.equal(nameFromMetadata(null), '', 'no user -> no name at all');
  assert.equal(nameFromMetadata({}), 'You', 'a user with no metadata and no email gets the neutral fallback applyUserIdentity has always used');
});

test('applyUserIdentity applies the Google identity (name + email) to the me member and prefs.name', () => {
  const S = {
    data: {
      me: 'm1',
      members: [
        { id: 'm1', name: 'Tanjim Islam', email: 'hello@atrium.app' },
        { id: 'm2', name: 'Marcus Lee', email: 'marcus@atrium.app' },
      ],
    },
    prefs: { name: 'Tanjim Islam' },
  };
  const user = { id: 'u-google', email: 'wes@operanceai.com', user_metadata: { name: 'Wes Romeijnders', email: 'wes@operanceai.com', provider: 'google' } };
  assert.equal(applyUserIdentity(S, user), true);
  assert.deepEqual(S.data.members[0], { id: 'm1', name: 'Wes Romeijnders', email: 'wes@operanceai.com' }, 'seed member m1 takes the Google identity');
  assert.equal(S.data.members[1].name, 'Marcus Lee', 'other members untouched');
  assert.equal(S.prefs.name, 'Wes Romeijnders');
});

/* ---------- AC3: backend-agnostic build ---------- */

test('the workspace table name lives in exactly one constant', () => {
  assert.equal(WORKSPACES_TABLE, 'workspaces');
});
