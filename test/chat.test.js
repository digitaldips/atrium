/* Unit tests for the pure Chat layer (src/core/chat.js).
   Data-in/data-out only: no network, no DOM, no store imports — dm_key
   building, thread grouping, unread math, search filtering, the default-
   channel bootstrap check and the file-ref trust boundary must run in
   plain node. chat_* tables live in Postgres (migration 0006) — the
   workspace document gains no new keys. Filename sanitization reuses
   notes.js's safeAttachmentName (single source of truth). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dmKey,
  unreadCount,
  groupChatThreads,
  chatSearchFilter,
  groupChatSearch,
  needsDefaultChannel,
  chatFileRefFor,
  validateChatFileRef,
  chatFilePath,
  makeChatMessage,
  makeChatChannel,
} from '../src/core/chat.js';

/* ---------- AC1/AC3: dm_key builder ---------- */

test('dmKey sorts member ids and joins them', () => {
  assert.equal(dmKey(['b-id', 'a-id']), 'a-id,b-id');
  assert.equal(dmKey(['a-id', 'b-id']), 'a-id,b-id'); // same set → same key
});

test('dmKey dedupes and drops empty ids', () => {
  assert.equal(dmKey(['a', 'a', '', 'b']), 'a,b');
  assert.equal(dmKey(['a', ' a ']), null); // trims, dedupes → one person is not a DM
});

test('dmKey needs two people; fewer returns null (not a DM)', () => {
  assert.equal(dmKey(['only-me']), null);
  assert.equal(dmKey([]), null);
  assert.equal(dmKey(null), null);
});

/* ---------- AC8: unread counts (counters, not COUNT) ---------- */

test('unreadCount is message_count minus read_count, never negative', () => {
  assert.equal(unreadCount({ message_count: 12 }, { read_count: 5 }), 7);
  assert.equal(unreadCount({ message_count: 3 }, { read_count: 10 }), 0);
  assert.equal(unreadCount({ message_count: 4 }, null), 4); // no member row → all unread
  assert.equal(unreadCount(null, { read_count: 2 }), 0);
  assert.equal(unreadCount({}, {}), 0);
});

test('unreadCount coerces junk counters to 0 honestly', () => {
  assert.equal(unreadCount({ message_count: '9' }, { read_count: '3' }), 6);
  assert.equal(unreadCount({ message_count: NaN }, { read_count: '3' }), 0);
});

/* ---------- AC5: thread grouping ---------- */

const msg = (id, parent_id, created_at, extra = {}) => ({
  id,
  channel_id: 'c1',
  parent_id,
  user_id: 'u1',
  body: 'body-' + id,
  file: null,
  created_at,
  deleted_at: null,
  ...extra,
});

test('groupChatThreads nests replies under their root in order', () => {
  const rows = [msg('r1', null, 3), msg('x2', 'r1', 1), msg('x1', 'r1', 2), msg('r2', null, 1)];
  const g = groupChatThreads(rows);
  assert.deepEqual(
    g.map(r => r.id),
    ['r2', 'r1'],
  ); // roots by created_at asc
  assert.deepEqual(
    g[1].replies.map(r => r.id),
    ['x2', 'x1'],
  );
  assert.equal(g[1].replyCount, 2);
  assert.equal(g[0].replies.length, 0);
});

test('groupChatThreads drops deleted replies, keeps a deleted root that has replies', () => {
  const rows = [msg('r1', null, 1), msg('x1', 'r1', 2), msg('x2', 'r1', 3, { deleted_at: 't' })];
  const g = groupChatThreads(rows);
  assert.equal(g.length, 1); // deleted root without a body stays as the thread container
  assert.deepEqual(
    g[0].replies.map(r => r.id),
    ['x1'],
  );
});

test('groupChatThreads drops a reply whose parent is missing (no orphan row)', () => {
  const g = groupChatThreads([msg('orphan', 'gone-root', 1)]);
  assert.deepEqual(g, []);
});

test('groupChatThreads survives junk rows without throwing', () => {
  assert.deepEqual(groupChatThreads([null, 'x', 42, undefined]), []);
  assert.deepEqual(groupChatThreads([]), []);
});

/* ---------- AC7/AC9: search filter + grouping ---------- */

test('chatSearchFilter keeps case-insensitive substring matches only', () => {
  const rows = [msg('a', null, 1, { body: 'Launch plan' }), msg('b', null, 2, { body: 'standup notes' }), msg('c', null, 3, { body: 'LAUNCH day' })];
  assert.deepEqual(
    chatSearchFilter(rows, 'launch').map(r => r.id),
    ['a', 'c'],
  );
});

test('chatSearchFilter treats % and _ literally (no wildcard injection)', () => {
  const rows = [msg('a', null, 1, { body: '100% done' }), msg('b', null, 2, { body: '100x done' })];
  assert.deepEqual(
    chatSearchFilter(rows, '100%').map(r => r.id),
    ['a'],
  );
});

test('chatSearchFilter with empty query returns everything empty (caller renders prompt)', () => {
  assert.deepEqual(chatSearchFilter([msg('a', null, 1)], ''), []);
  assert.deepEqual(chatSearchFilter([msg('a', null, 1)], '   '), []);
});

test('groupChatSearch groups rows by channel, newest channel first', () => {
  const rows = [msg('a', null, 1, { channel_id: 'c1' }), msg('b', null, 2, { channel_id: 'c2' }), msg('c', null, 3, { channel_id: 'c1' })];
  const g = groupChatSearch(rows);
  assert.deepEqual(
    g.map(x => x.channelId),
    ['c1', 'c2'],
  ); // c1 has the newest message (3)
  assert.deepEqual(
    g[0].messages.map(r => r.id),
    ['a', 'c'],
  ); // within group, oldest first
});

/* ---------- AC2: default-channel bootstrap check ---------- */

test('needsDefaultChannel is true only when no is_default channel exists', () => {
  assert.equal(needsDefaultChannel([]), true);
  assert.equal(needsDefaultChannel(null), true);
  assert.equal(needsDefaultChannel([{ is_default: true }, { is_default: false }]), false);
  assert.equal(needsDefaultChannel([{ is_default: false }]), true);
  assert.equal(needsDefaultChannel([{ is_default: null }]), true);
});

/* ---------- AC6/AC10: file ref trust boundary ---------- */

test('chatFilePath builds <workspaceId>/<channelId>/<messageId>/<safe name>', () => {
  assert.equal(chatFilePath('ws1', 'ch1', 'm1', 'report.pdf'), 'ws1/ch1/m1/report.pdf');
  assert.equal(chatFilePath('ws1', 'ch1', 'm1', '../etc/passwd'), 'ws1/ch1/m1/etc-passwd'); // sanitized
  assert.equal(chatFilePath('', 'ch1', 'm1', 'x'), ''); // missing scope → refuse
  assert.equal(chatFilePath('ws1', '', 'm1', 'x'), '');
});

test('chatFileRefFor caps size and sanitizes the name', () => {
  const ok = chatFileRefFor({ name: 'a b.png', size: 10, type: 'image/png' }, 'ws', 'ch', 'm');
  assert.deepEqual(ok, { name: 'a b.png', path: 'ws/ch/m/a b.png', size: 10, type: 'image/png' });
  assert.equal(chatFileRefFor({ name: 'big.png', size: 11 * 1024 * 1024, type: 'image/png' }, 'ws', 'ch', 'm'), null);
  assert.equal(chatFileRefFor({ name: 'x.png', size: -1, type: 'image/png' }, 'ws', 'ch', 'm'), null);
  assert.equal(chatFileRefFor(null, 'ws', 'ch', 'm'), null);
});

test('validateChatFileRef accepts a well-formed 4-segment ref and rejects junk', () => {
  const good = { name: 'a b.png', path: 'ws/ch/m/a b.png', size: 10, type: 'image/png' };
  assert.deepEqual(validateChatFileRef(good), good);
  assert.equal(validateChatFileRef(null), null);
  assert.equal(validateChatFileRef({ ...good, name: '../evil' }), null); // separators in name
  assert.equal(validateChatFileRef({ ...good, path: 'ws/ch/a b.png' }), null); // 3 segments (notes shape, not chat)
  assert.equal(validateChatFileRef({ ...good, path: 'ws/ch/m/other.png' }), null); // tail must be the name
  assert.equal(validateChatFileRef({ ...good, size: 'x' }), null);
  assert.equal(validateChatFileRef({ ...good, type: null }), null);
  // junk path segments refused
  assert.equal(validateChatFileRef({ ...good, path: 'ws/ch//a b.png' }), null);
  assert.equal(validateChatFileRef({ ...good, path: '/ch/m/a b.png' }), null);
});

/* ---------- row coercion (hydration trust boundary, AC10) ---------- */

test('makeChatMessage coerces a Postgres row and validates the file ref', () => {
  const row = {
    id: 'm1',
    channel_id: 'c1',
    parent_id: null,
    user_id: 'u1',
    body: 'hi',
    file: { name: 'a.png', path: 'ws/ch/m1/a.png', size: 3, type: 'image/png' },
    created_at: '2026-11-04T10:00:00Z',
    deleted_at: null,
  };
  const m = makeChatMessage(row);
  assert.equal(m.body, 'hi');
  assert.deepEqual(m.file, row.file);
  assert.equal(makeChatMessage(null), null);
  assert.equal(makeChatMessage({ ...row, file: { name: 'evil', path: 'x', size: 1, type: 't' } }).file, null);
  assert.equal(makeChatMessage({ ...row, body: 42 }).body, '42'); // coerced honestly
  assert.equal(makeChatMessage({ ...row, id: '' }), null); // unusable row dropped
});

test('makeChatChannel coerces a channel row', () => {
  const c = makeChatChannel({
    id: 'c1',
    workspace_id: 'ws',
    kind: 'public',
    name: 'general',
    topic: 'Hi there',
    dm_key: null,
    is_default: true,
    archived_at: null,
    message_count: 4,
    created_by: 'u1',
    created_at: 't',
    updated_at: 't',
  });
  assert.equal(c.name, 'general');
  assert.equal(c.message_count, 4);
  assert.equal(makeChatChannel({ kind: 'weird' }), null); // bad kind refused
  assert.equal(makeChatChannel(null), null);
  assert.equal(makeChatChannel({ id: 'c2', workspace_id: 'ws', kind: 'dm' }).dm_key, null); // dm without key coerced null → unusable, page filters it
});
