/* Unit tests for the FRESH workspace seed (src/data/seed.js).
   The seed is the minimal doc every new account bootstraps from: NO
   sample/demo content anywhere — one member (the owner; the real Google
   name+email land at bootstrap via applyUserIdentity), the neutral
   'My workspace' name and empty content arrays, so every page shows its
   own honest empty state. The zero-loss ensure* initializer contract is
   asserted too: the fresh doc passes through all four initializers
   untouched, because they only GUARANTEE arrays and the seed already
   has every array. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/data/seed.js';
import { ensureCrmData } from '../src/core/crm.js';
import { ensureDocShape } from '../src/core/links.js';
import { ensureNotes } from '../src/core/notes.js';
import { ensureOrgsData } from '../src/core/orgs.js';
import { applyUserIdentity } from '../src/core/workspace-api.js';

const CONTENT_ARRAYS = [
  'clients',
  'deals',
  'links',
  'notes',
  'orgs',
  'projects',
  'tasks',
  'comments',
  'activity',
  'notifs',
  'files',
  'events',
  'projOrder',
  'teams',
  'savedViews',
  'recentSearches',
  'sessions',
  'invoices',
  'workspaces',
];

test('seed is a fresh workspace: every content array starts empty', () => {
  const d = seed();
  for (const k of CONTENT_ARRAYS) {
    assert.deepEqual(d[k], [], `seed.${k} must be an empty array on a fresh workspace`);
  }
});

test('seed keeps the structural fields pages and actions read', () => {
  const d = seed();
  assert.equal(d.me, 'm1', 'me points at the single owner member');
  assert.deepEqual(d.members, [{ id: 'm1', name: 'You', email: '', role: 'Owner', team: '', title: '', c: '#5A67D8', status: 'active', last: 0, tz: '' }]);
  assert.equal(d.ws.name, 'My workspace', 'neutral default; rename lives in Settings → Workspace');
  assert.equal(typeof d.ws.url, 'string');
  assert.equal(typeof d.ws.c, 'string');
  assert.equal(d.tfa, false);
  assert.equal(typeof d.notifPrefs, 'object');
  assert.deepEqual(Object.keys(d.notifPrefs).sort(), [
    'assign_self',
    'email_assign',
    'email_comment',
    'email_digest',
    'email_mention',
    'mention_all',
    'push_assign',
    'push_comment',
    'push_due',
    'push_mention',
  ]);
});

test('seed carries no fictional demo content', () => {
  const flat = JSON.stringify(seed());
  for (const marker of [
    'Tanjim',
    'Sarah Chen',
    'Website Redesign',
    'Van der Berg',
    'Meridian',
    'Koffie',
    'Noorderlicht',
    'Welcome to Notes',
    'Acme Labs',
    'homepage-wireframes',
    'atrium.app',
  ]) {
    assert.ok(!flat.includes(marker), `fresh seed must not contain "${marker}"`);
  }
});

test('seed teams are empty so the NO_TEAM fallback renders (no team seeds injected)', () => {
  const d = seed();
  assert.deepEqual(d.teams, []);
  assert.equal(d.members[0].team, '', 'the owner member starts on No team');
});

test('fresh seed passes every ensure* initializer untouched (zero-loss contract)', () => {
  const doc = seed();
  const before = JSON.stringify(doc);
  ensureCrmData(doc);
  ensureDocShape(doc);
  ensureNotes(doc);
  ensureOrgsData(doc);
  assert.equal(JSON.stringify(doc), before, 'initializers guarantee arrays — the fresh doc already has every array');
});

test('applyUserIdentity stamps the account identity onto the fresh me member and prefs', () => {
  const S = { data: seed(), prefs: { name: 'You', title: '' } };
  const user = { id: 'u1', email: 'wes@operanceai.com', user_metadata: { name: 'Wes Romeijnders' } };
  assert.equal(applyUserIdentity(S, user), true);
  assert.deepEqual(S.data.members[0], {
    id: 'm1',
    name: 'Wes Romeijnders',
    email: 'wes@operanceai.com',
    role: 'Owner',
    team: '',
    title: '',
    c: '#5A67D8',
    status: 'active',
    last: 0,
    tz: '',
  });
  assert.equal(S.prefs.name, 'Wes Romeijnders');
});

test('fresh seeds are independent objects (no shared array references across calls)', () => {
  const a = seed();
  const b = seed();
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'seed shape is stable across calls');
  a.projects.push({ id: 'pX' });
  a.tasks.push({ id: 'tX' });
  assert.deepEqual(b.projects, [], 'mutating one seed must never leak into another');
  assert.deepEqual(b.tasks, []);
});
