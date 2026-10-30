/* Tests for the boot/login cache-binding + auth-route + identity contract:
   - the localStorage cache is trusted only when written by the signed-in user
   - the onboarding route requires a real session
   - the collected signup name lands on the in-app identity
   All pure logic from src/core/workspace-api.js — no DOM, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUserIdentity, cachePayloadForUser, isTrustedCache, resolveAuthRoute } from '../src/core/workspace-api.js';

const mkCache = (uid, tasks = [{ id: 't1' }]) => ({ data: { tasks, me: 'm1' }, prefs: { theme: 'system' }, views: {}, uid });

/* ---------- cache-uid binding ---------- */

test('cachePayloadForUser stamps the owner uid into the localStorage payload', () => {
  const payload = { data: { tasks: [] }, prefs: {}, views: {}, collapsed: false };
  const stamped = cachePayloadForUser('user-1', payload);
  assert.equal(stamped.uid, 'user-1');
  assert.equal(stamped.data, payload.data, 'must not clone or alter the doc');
  assert.deepEqual(cachePayloadForUser(null, payload), { ...payload, uid: null }, 'no user (local-only mode) stamps null, never another uid');
});

test('isTrustedCache accepts only a same-uid cache with a usable document', () => {
  assert.equal(isTrustedCache(mkCache('user-1'), 'user-1'), true, 'own cache is trusted');
  assert.equal(isTrustedCache(mkCache('user-2'), 'user-1'), false, 'another account\u2019s cache is never trusted');
  assert.equal(isTrustedCache(mkCache(undefined), 'user-1'), false, 'a pre-binding cache without a uid is never trusted');
  assert.equal(isTrustedCache(mkCache(null), 'user-1'), false);
  assert.equal(isTrustedCache(mkCache('user-1'), null), false, 'no session user -> nothing is trusted');
  assert.equal(isTrustedCache(null, 'user-1'), false);
  assert.equal(isTrustedCache({ uid: 'user-1' }, 'user-1'), false, 'a cache without a doc is not usable');
  assert.equal(isTrustedCache({ uid: 'user-1', data: {} }, 'user-1'), false, 'a cache without tasks is not a workspace');
});

/* ---------- auth route gate (M1) ---------- */

test('resolveAuthRoute bounces an unauthenticated visitor from onboarding to login', () => {
  assert.equal(resolveAuthRoute('onboarding', null), 'login', 'no session -> never the wizard');
  assert.equal(resolveAuthRoute('onboarding', undefined), 'login');
  assert.equal(resolveAuthRoute('login', null), 'login');
  assert.equal(resolveAuthRoute('signup', null), 'signup', 'signup stays public');
});

test('resolveAuthRoute passes a signed-in request through untouched', () => {
  assert.equal(resolveAuthRoute('onboarding', 'user-1'), 'onboarding');
  assert.equal(resolveAuthRoute('login', 'user-1'), 'login');
  assert.equal(resolveAuthRoute(null, 'user-1'), null, 'in-app state (null) is untouched');
  assert.equal(resolveAuthRoute(null, null), null);
});

/* ---------- signup identity (L3) ---------- */

test('applyUserIdentity writes the account name+email onto the me member and prefs.name', () => {
  const S = {
    data: {
      me: 'm1',
      members: [
        { id: 'm1', name: 'Tanjim Islam', email: 'hello@atrium.app' },
        { id: 'm2', name: 'Marcus Lee', email: 'marcus@atrium.app' },
      ],
    },
    prefs: { name: 'Tanjim Islam', theme: 'system' },
  };
  assert.equal(applyUserIdentity(S, { email: 'wes@atrium.app', user_metadata: { full_name: 'Wes Romeijnders' } }), true);
  assert.deepEqual(S.data.members[0], { id: 'm1', name: 'Wes Romeijnders', email: 'wes@atrium.app' });
  assert.equal(S.data.members[1].name, 'Marcus Lee', 'other members are untouched');
  assert.equal(S.prefs.name, 'Wes Romeijnders');
});

test('applyUserIdentity falls back to an email-derived name when metadata has none', () => {
  const S = { data: { me: 'm1', members: [{ id: 'm1', name: 'Tanjim Islam', email: 'hello@atrium.app' }] }, prefs: { name: 'Tanjim Islam' } };
  assert.equal(applyUserIdentity(S, { email: 'sam@example.com' }), true);
  assert.equal(S.data.members[0].name, 'Sam');
  assert.equal(S.data.members[0].email, 'sam@example.com');
  assert.equal(S.prefs.name, 'Sam');
});

test('applyUserIdentity is a safe no-op without a user or a me member', () => {
  const S = { data: { me: 'm1', members: [{ id: 'm1', name: 'Tanjim Islam', email: 'hello@atrium.app' }] }, prefs: { name: 'Tanjim Islam' } };
  assert.equal(applyUserIdentity(S, null), false);
  assert.equal(S.prefs.name, 'Tanjim Islam', 'identity unchanged when there is no user');
  const noMe = { data: { members: [] }, prefs: {} };
  assert.equal(applyUserIdentity(noMe, { email: 'a@b.co' }), true, 'prefs.name still applied without a me member');
  assert.equal(noMe.prefs.name, 'A');
});
