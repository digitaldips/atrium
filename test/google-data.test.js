/* Unit tests for the shared Google-integration logic in
   supabase/functions/_shared/google-pure.js. The module is plain ES with
   zero imports, so the SAME source runs under node --test, the Deno edge
   runtime and the Vite frontend. Pure data-in/data-out only: no network,
   no filesystem, no Deno APIs. crypto.subtle (Web Crypto) is a global in
   Node 18+, Deno and browsers alike. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_SCOPES,
  GOOGLE_SCOPE_PARAM,
  safeEqual,
  signState,
  verifyState,
  pendingMatches,
  pendingExpired,
  shouldFetch,
  shouldFetchWindow,
  googleReturnBanner,
  parseFromHeader,
  mapGmailMessage,
  mergeInbox,
  eventDateKey,
  eventTimeLabel,
  eventTimeRange,
  monthWindow,
  expandDayRange,
} from '../supabase/functions/_shared/google-pure.js';

/* ---------- scopes constant ---------- */

test('GOOGLE_SCOPES is exactly the two read-only scopes', () => {
  assert.deepEqual(GOOGLE_SCOPES, ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']);
});

test('GOOGLE_SCOPE_PARAM joins the scopes with spaces (Google OAuth wire format)', () => {
  assert.equal(GOOGLE_SCOPE_PARAM, GOOGLE_SCOPES.join(' '));
  assert.equal(GOOGLE_SCOPES.length, 2, 'no write scope may ever creep in');
  for (const s of GOOGLE_SCOPES) assert.match(s, /\.readonly$/, `scope ${s} must be read-only`);
});

/* ---------- state HMAC sign/verify (per-flow nonce, F2) ---------- */

const KEY = 'service-role-key-for-tests';
const UID = '11111111-2222-3333-4444-555555555555';

test('signState returns "userid.nonce.signature" and verifyState accepts it', async () => {
  const state = await signState(UID, 'nonce-1', KEY);
  assert.match(state, new RegExp(`^${UID}\\.nonce-1\\.[A-Za-z0-9_-]+$`), 'userid + nonce + dot + base64url signature');
  const v = await verifyState(state, KEY);
  assert.deepEqual(v, { ok: true, userId: UID, nonce: 'nonce-1' });
});

test('the nonce makes the state per-flow: a fresh nonce mints a fresh signature', async () => {
  const a = await signState('user-a', 'nonce-1', KEY);
  const b = await signState('user-a', 'nonce-1', KEY);
  assert.equal(a, b, 'same user + same nonce + same key is deterministic');
  const c = await signState('user-a', 'nonce-2', KEY);
  assert.notEqual(a, c, 'a fresh nonce per authorize must change the state (no replayable constant)');
  assert.notEqual(
    (await signState('user-a', 'nonce-1', KEY)).split('.')[2],
    (await signState('user-b', 'nonce-1', KEY)).split('.')[2],
    'different users never share a signature',
  );
});

test('a tampered state is rejected (payload edited)', async () => {
  const state = await signState('user-a', 'nonce-1', KEY);
  const evil = state.replace('user-a', 'user-b'); // attacker swaps the user id
  assert.equal((await verifyState(evil, KEY)).ok, false, 'swapped id must not verify');
  const evilNonce = state.replace('nonce-1', 'nonce-9'); // attacker swaps the nonce
  assert.equal((await verifyState(evilNonce, KEY)).ok, false, 'swapped nonce must not verify');
  const flipped = state.slice(0, -2) + (state.endsWith('aa') ? 'ab' : 'aa');
  assert.equal((await verifyState(flipped, KEY)).ok, false, 'flipped signature char must not verify');
});

test('a foreign key is rejected', async () => {
  const state = await signState('user-a', 'nonce-1', KEY);
  const v = await verifyState(state, 'a-different-secret');
  assert.equal(v.ok, false);
  assert.notEqual(v.reason, undefined);
});

test('malformed states are rejected without throwing', async () => {
  for (const bad of ['', '.', 'justauserid', 'a.b', 'a.b.c.d', '.nonce.sig', 'x..sig', 'x.nonce.']) {
    const v = await verifyState(bad, KEY);
    assert.equal(v.ok, false, `state ${JSON.stringify(bad)} must not verify`);
  }
  assert.equal((await verifyState(null, KEY)).ok, false);
});

/* ---------- single-use consumption + expiry decisions (F2) ---------- */

test('pendingMatches requires the row to still hold THIS flow nonce', () => {
  assert.equal(pendingMatches({ pending_nonce: 'n1' }, 'n1'), true);
  assert.equal(pendingMatches({ pending_nonce: 'n1' }, 'n2'), false, 'a different (superseded) nonce never matches');
  assert.equal(pendingMatches({ pending_nonce: null }, 'n1'), false, 'a consumed (NULL) nonce never matches');
  assert.equal(pendingMatches(null, 'n1'), false, 'no row at all → no match');
  assert.equal(pendingMatches({ pending_nonce: 'n1' }, ''), false, 'an empty claimed nonce never matches');
});

test('pendingExpired fails closed and honours the injected instant', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(pendingExpired('2026-10-31T11:59:59Z', now), true, 'past expiry is expired');
  assert.equal(pendingExpired('2026-10-31T12:00:01Z', now), false, 'future expiry is still valid');
  assert.equal(pendingExpired('2026-10-31T12:00:00Z', now), true, 'expiry at this instant is expired (<=)');
  assert.equal(pendingExpired(null, now), true, 'missing expiry fails closed');
  assert.equal(pendingExpired('garbage', now), true, 'unparseable expiry fails closed');
});

/* ---------- fetch-on-render guards (F1: error states are terminal) ---------- */

test('shouldFetch: fresh states may fetch, terminal states may not', () => {
  for (const fresh of [undefined, null, '', 'idle', 'off']) assert.equal(shouldFetch(fresh), true, `${String(fresh)} may fetch`);
  for (const terminal of ['loading', 'ok', 'empty', 'error']) assert.equal(shouldFetch(terminal), false, `${terminal} is terminal until Retry`);
});

test('shouldFetchWindow: same-window terminal state blocks; a changed window always fetches', () => {
  assert.equal(shouldFetchWindow('ok', 'a..b', 'a..b'), false, 'settled window is cached');
  assert.equal(shouldFetchWindow('error', 'a..b', 'a..b'), false, 'error is terminal for the SAME window');
  assert.equal(shouldFetchWindow('error', 'c..d', 'a..b'), true, 'navigating to a new window fetches');
  assert.equal(shouldFetchWindow('loading', 'a..b', 'a..b'), false, 'no duplicate in-flight fetch');
  assert.equal(shouldFetchWindow('loading', 'c..d', 'a..b'), true);
  assert.equal(shouldFetchWindow('idle', 'a..b', 'a..b'), true);
  assert.equal(shouldFetchWindow('off', 'a..b', 'a..b'), true, 'off re-arms (surfaces re-arm via connect)');
});

test('safeEqual is an honest constant-length comparison', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, 'x'), false);
});

/* ---------- consent-return banner decision (F3: the hash is untrusted) ---------- */

const OK_RET = { google: 'ok', reason: '' };

test('googleReturnBanner never claims success from the hash alone', () => {
  assert.equal(googleReturnBanner(null, { connected: true, loaded: true }), null, 'no return → no banner');
  assert.equal(googleReturnBanner({ google: 'denied' }, { connected: true, loaded: true }).kind, 'error', 'a genuine failure stays an error banner');
  assert.equal(googleReturnBanner(OK_RET, { connected: true, loaded: true }).kind, 'success', 'success ONLY when the fetched status reports connected');
  assert.equal(
    googleReturnBanner(OK_RET, { connected: false, loaded: false }).kind,
    'pending',
    'crafted ok-hash before the status lands → neutral pending, never success',
  );
  assert.equal(googleReturnBanner(OK_RET, undefined).kind, 'pending', 'no status at all → pending');
  assert.equal(googleReturnBanner(OK_RET, { connected: false, loaded: false, error: true }).kind, 'pending', 'status check unavailable → pending');
  assert.equal(
    googleReturnBanner(OK_RET, { connected: false, loaded: true }).kind,
    'inactive',
    'status check completed without a connection → honest inactive',
  );
});

/* ---------- gmail mapping ---------- */

test('parseFromHeader handles named, quoted, bare and empty values', () => {
  assert.deepEqual(parseFromHeader('Wes Romeijnders <wes@operanceai.com>'), { name: 'Wes Romeijnders', email: 'wes@operanceai.com' });
  assert.deepEqual(
    parseFromHeader('"Ops, Operance" <ops@operanceai.com>'),
    { name: 'Ops, Operance', email: 'ops@operanceai.com' },
    'quoted names keep their comma',
  );
  assert.deepEqual(parseFromHeader('bare@x.io'), { name: '', email: 'bare@x.io' });
  assert.deepEqual(parseFromHeader('Name Only'), { name: 'Name Only', email: '' });
  assert.deepEqual(parseFromHeader('   '), { name: '', email: '' });
  assert.deepEqual(parseFromHeader(null), { name: '', email: '' });
});

test('mapGmailMessage maps a metadata payload into the UI shape', () => {
  const raw = {
    id: 'msg-1',
    snippet: 'Hello from the snippet',
    internalDate: '1761907200000',
    labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    payload: {
      headers: [
        { name: 'From', value: 'Wes Romeijnders <wes@operanceai.com>' },
        { name: 'To', value: 'me@atrium.app' },
        { name: 'Subject', value: 'Lunch tomorrow?' },
        { name: 'Date', value: 'Sat, 31 Oct 2026 10:00:00 +0000' },
      ],
    },
  };
  assert.deepEqual(mapGmailMessage(raw), {
    id: 'msg-1',
    from: 'Wes Romeijnders',
    email: 'wes@operanceai.com',
    subject: 'Lunch tomorrow?',
    snippet: 'Hello from the snippet',
    date: 1761907200000,
    unread: true,
    webLink: 'https://mail.google.com/mail/u/0/#inbox/msg-1',
  });
});

test('mapGmailMessage falls back honestly on sparse payloads', () => {
  const bare = mapGmailMessage({ id: 'msg-2', payload: { headers: [] } });
  assert.equal(bare.from, '(unknown sender)');
  assert.equal(bare.subject, '(no subject)');
  assert.equal(bare.snippet, '');
  assert.equal(bare.date, 0, 'no internalDate → 0, never NaN');
  assert.equal(bare.unread, false, 'no labels → not unread');
  assert.equal(bare.webLink, 'https://mail.google.com/mail/u/0/#inbox/msg-2');
});

test('mapGmailMessage header lookup is case-insensitive and null-safe', () => {
  const m = mapGmailMessage({ id: 'x', payload: { headers: [{ name: 'FROM', value: 'bare@x.io' }] } });
  assert.equal(m.from, 'bare@x.io', 'a bare address is shown as the sender');
  assert.equal(m.email, 'bare@x.io');
  assert.equal(mapGmailMessage(null), null, 'null in, null out');
});

/* ---------- inbox merge (workspace notifs + gmail, ONE sorted list) ---------- */

const N = (id, at, type = 'mention', read = false) => ({ id, at, type, read, text: `n-${id}` });
const G = (id, date, unread = true) => ({ id, date, unread, from: `g-${id}`, subject: `s-${id}`, snippet: '', webLink: '' });

test('mergeInbox tags each row with its kind and returns the original items', () => {
  const notif = N('n1', 100);
  const msg = G('g1', 200);
  assert.deepEqual(mergeInbox([notif], [msg]), [
    { kind: 'gmail', at: 200, item: msg },
    { kind: 'notif', at: 100, item: notif },
  ]);
});

test('mergeInbox sorts one unified list by time, newest first, across kinds', () => {
  const merged = mergeInbox([N('old', 1000), N('new', 9000), N('mid', 4000)], [G('newest', 9500), G('oldest', 500), G('midg', 4500)]);
  assert.deepEqual(
    merged.map(r => r.item.id),
    ['newest', 'new', 'midg', 'mid', 'old', 'oldest'],
    'gmail and notif rows interleave by epoch ms, newest first',
  );
});

test('mergeInbox cat gating: "all" merges, notif cats filter their kind only, "gmail" shows only mail', () => {
  const notifs = [N('m', 1, 'mention'), N('a', 2, 'assign'), N('c', 3, 'comment'), N('u', 4, 'update')];
  const gmsgs = [G('g', 5)];
  assert.equal(mergeInbox(notifs, gmsgs, { cat: 'all' }).length, 5, '"all" merges both kinds');
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'mention' }).map(r => r.item.id),
    ['m'],
    'mention shows only mention notifs — no mail',
  );
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'assign' }).map(r => r.item.id),
    ['a'],
  );
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'comment' }).map(r => r.item.id),
    ['c'],
  );
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'update' }).map(r => r.item.id),
    ['u'],
  );
  const gm = mergeInbox(notifs, gmsgs, { cat: 'gmail' });
  assert.deepEqual(
    gm.map(r => r.item.id),
    ['g'],
    '"gmail" shows only gmail rows',
  );
  assert.equal(
    gm.every(r => r.kind === 'gmail'),
    true,
    'a workspace notif can never leak into the gmail category',
  );
});

test('mergeInbox unreadOnly applies to BOTH kinds', () => {
  const notifs = [N('nunread', 1, 'mention', false), N('nread', 2, 'mention', true)];
  const gmsgs = [G('gunread', 3, true), G('gread', 4, false)];
  const filtered = mergeInbox(notifs, gmsgs, { cat: 'all', unreadOnly: true });
  assert.deepEqual(
    filtered.map(r => `${r.kind}:${r.item.id}`),
    ['gmail:gunread', 'notif:nunread'],
    'read notifs AND read mail are filtered out together',
  );
  assert.equal(mergeInbox(notifs, gmsgs, { cat: 'all', unreadOnly: false }).length, 4, 'toggle off keeps everything');
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'gmail', unreadOnly: true }).map(r => r.item.id),
    ['gunread'],
  );
  assert.deepEqual(
    mergeInbox(notifs, gmsgs, { cat: 'mention', unreadOnly: true }).map(r => r.item.id),
    ['nunread'],
  );
});

test('mergeInbox handles empty and missing inputs without throwing', () => {
  assert.deepEqual(mergeInbox([], []), []);
  assert.deepEqual(mergeInbox(null, undefined), [], 'null inputs behave like empty lists');
  assert.deepEqual(
    mergeInbox([N('n1', 10)], [], { cat: 'all' }).map(r => r.item.id),
    ['n1'],
  );
  assert.deepEqual(
    mergeInbox([], [G('g1', 10)], { cat: 'all' }).map(r => r.item.id),
    ['g1'],
  );
  assert.deepEqual(mergeInbox([], [G('g1', 10)], { cat: 'mention' }), [], 'no notifs → empty notif-category view');
  assert.deepEqual(mergeInbox([N('n1', 10)], [], { cat: 'gmail' }), [], 'no mail → empty gmail view');
});

test('mergeInbox defaults to the merged "all" view with the unread toggle off', () => {
  assert.equal(mergeInbox([N('n1', 1)], [G('g1', 2)]).length, 2);
  assert.equal(mergeInbox([N('n1', 1)], [G('g1', 2)], {}).length, 2, 'empty options object');
  assert.equal(mergeInbox([N('n1', 1, 'mention', true)], [G('g1', 2, false)]).length, 2, 'read items kept without unreadOnly');
});

test('mergeInbox never produces NaN ordering: missing timestamps sort as 0 instead of poisoning the sort', () => {
  const merged = mergeInbox([N('n1', undefined), N('n2', 5000)], [G('g1', null)]);
  assert.deepEqual(
    merged.map(r => r.item.id),
    ['n2', 'n1', 'g1'],
  );
});

/* ---------- calendar event bucketing ---------- */

test('eventDateKey buckets all-day events by their date string', () => {
  assert.equal(eventDateKey({ start: { date: '2026-11-05' } }), '2026-11-05');
});

test('eventDateKey buckets timed events by the event-local date (offset kept, machine TZ ignored)', () => {
  assert.equal(eventDateKey({ start: { dateTime: '2026-11-05T09:30:00+01:00' } }), '2026-11-05');
  assert.equal(eventDateKey({ start: { dateTime: '2026-11-05T23:30:00-05:00' } }), '2026-11-05');
});

test('eventDateKey returns "" for malformed events instead of throwing', () => {
  assert.equal(eventDateKey({}), '');
  assert.equal(eventDateKey(null), '');
  assert.equal(eventDateKey({ start: {} }), '');
});

test('eventTimeLabel: all-day → "All day", timed → event-local HH:MM', () => {
  assert.equal(eventTimeLabel({ start: { date: '2026-11-05' } }), 'All day');
  assert.equal(eventTimeLabel({ start: { dateTime: '2026-11-05T09:30:00+01:00' } }), '09:30');
  assert.equal(eventTimeLabel({ start: { dateTime: '2026-11-05T23:05:00-05:00' } }), '23:05');
  assert.equal(eventTimeLabel({}), '');
});

test('eventTimeRange renders a start–end range for timed events and "All day" otherwise', () => {
  const timed = { start: { dateTime: '2026-11-05T09:30:00+01:00' }, end: { dateTime: '2026-11-05T10:30:00+01:00' } };
  assert.equal(eventTimeRange(timed), '09:30 – 10:30');
  assert.equal(eventTimeRange({ start: { date: '2026-11-05' }, end: { date: '2026-11-06' } }), 'All day');
  assert.equal(eventTimeRange({ start: { dateTime: '2026-11-05T09:30:00Z' } }), '09:30', 'missing end → start only');
});

/* ---------- month window for the calendar grid ---------- */

test('monthWindow covers the rendered grid for a 5-row month (Jan 2026, weeks start Monday)', () => {
  assert.deepEqual(monthWindow(2026, 0, 1), { from: '2025-12-29', to: '2026-02-01' });
});

test('monthWindow covers a 6-row month (Nov 2026, weeks start Monday)', () => {
  assert.deepEqual(monthWindow(2026, 10, 1), { from: '2026-10-26', to: '2026-12-06' });
});

test('monthWindow honours the week-start preference (Sunday, Mar 2026)', () => {
  assert.deepEqual(monthWindow(2026, 2, 0), { from: '2026-03-01', to: '2026-04-04' });
});

/* ---------- timeMin/timeMax padding for the events.list query ---------- */

test('expandDayRange pads both ends by one day so UTC timeMin/timeMax cover every event-local date', () => {
  assert.deepEqual(expandDayRange('2026-11-01', '2026-11-30'), { from: '2026-10-31', to: '2026-12-01' });
  assert.deepEqual(expandDayRange('2026-01-01', '2026-01-31'), { from: '2025-12-31', to: '2026-02-01' }, 'year boundary rolls correctly');
});

test('expandDayRange passes malformed input through instead of throwing', () => {
  assert.deepEqual(expandDayRange('', ''), { from: '', to: '' });
  assert.deepEqual(expandDayRange(null, '2026-11-01'), { from: null, to: '2026-11-01' });
});
