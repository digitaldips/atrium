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
  scopeShortNames,
  safeLink,
  decodeB64url,
  buildMime,
  parseGmailBody,
  parseAttachments,
  mapGmailFull,
  mapThread,
  buildEventResource,
  validGmailQuery,
  clampNum,
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
  normalizeAttendeeEmails,
  parseCompose,
  errorFromEndpoint,
} from '../supabase/functions/_shared/google-pure.js';

/* ---------- scopes constant (Operance parity: FULL access) ---------- */

test('GOOGLE_SCOPES is exactly the four full-access scopes', () => {
  assert.deepEqual(GOOGLE_SCOPES, [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ]);
});

test('GOOGLE_SCOPE_PARAM joins the scopes with spaces (Google OAuth wire format)', () => {
  assert.equal(GOOGLE_SCOPE_PARAM, GOOGLE_SCOPES.join(' '));
  assert.equal(GOOGLE_SCOPES.length, 4, 'exactly the Operance-parity scope set');
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/gmail.send'), 'sending mail requires gmail.send');
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/gmail.modify'), 'label changes require gmail.modify');
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/calendar.events'), 'event CRUD requires calendar.events');
});

test('scopeShortNames strips the auth prefix and drops foreign entries', () => {
  assert.deepEqual(scopeShortNames(['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events']), [
    'gmail.modify',
    'calendar.events',
  ]);
  assert.deepEqual(
    scopeShortNames('https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly'),
    ['gmail.send', 'calendar.readonly'],
    'space-joined string (stored scopes column) is accepted',
  );
  assert.deepEqual(scopeShortNames(['https://evil.example/x']), [], 'non-googleapis entries are dropped');
  assert.deepEqual(scopeShortNames(null), []);
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
    starred: false,
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
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

/* ---------- external-link allowlist (untrusted hrefs) ---------- */

test('safeLink allows only https on the Google mail/accounts/calendar hosts', () => {
  assert.equal(safeLink('https://mail.google.com/mail/u/0/#inbox/abc'), 'https://mail.google.com/mail/u/0/#inbox/abc');
  assert.equal(safeLink('https://accounts.google.com/calendar/event?x=1'), 'https://accounts.google.com/calendar/event?x=1');
  assert.equal(safeLink('https://calendar.google.com/calendar/event?eid=zz'), 'https://calendar.google.com/calendar/event?eid=zz');
  assert.equal(safeLink('http://mail.google.com/mail/u/0/#inbox/abc'), '', 'plain http is never a safe link');
  assert.equal(safeLink('https://evil.example/mail.google.com'), '', 'lookalike hosts are rejected');
  assert.equal(safeLink('https://mail.google.com.evil.example/x'), '', 'suffix spoofing is rejected');
  assert.equal(safeLink('javascript:alert(1)'), '', 'javascript: is never a safe link');
  assert.equal(safeLink('https://user:pw@mail.google.com/x'), '', 'credentials in the URL are rejected');
  assert.equal(safeLink(''), '');
  assert.equal(safeLink(null), '');
});

/* ---------- base64url decode (Gmail body data) ---------- */

test('decodeB64url decodes Gmail base64url body data to UTF-8', () => {
  // 'Hello' → base64url via b64urlFromBytes semantics
  assert.equal(decodeB64url('SGVsbG8='), 'Hello');
  assert.equal(decodeB64url('SGVsbG8'), 'Hello', 'missing padding is tolerated');
  const enc = new TextEncoder().encode('héllo ✓');
  let bin = '';
  for (const b of enc) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeB64url(b64), 'héllo ✓', 'multi-byte UTF-8 survives base64url');
  assert.equal(decodeB64url('!!!not-base64!!!'), '', 'garbage decodes to empty string, never throws');
  assert.equal(decodeB64url(''), '');
  assert.equal(decodeB64url(null), '');
});

/* ---------- MIME message builder (RFC 5322, header-injection safe) ---------- */

test('buildMime encodes RFC 5322 headers + body as base64url with the fixed header order', () => {
  const raw = decodeB64url(buildMime({ to: 'wes@example.com', cc: 'ops@example.com', subject: 'Lunch?', body: 'How about 12:00?' }));
  const lines = raw.split('\r\n');
  assert.deepEqual(
    lines,
    [
      'To: wes@example.com',
      'Cc: ops@example.com',
      'Subject: Lunch?',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      'How about 12:00?',
    ],
    'To, Cc, Subject, then MIME headers, blank line, body',
  );
});

test('buildMime adds In-Reply-To/References between Subject and MIME-Version for replies', () => {
  const raw = decodeB64url(
    buildMime({
      to: 'a@b.c',
      subject: 'Re: Hello',
      body: 'hi',
      inReplyTo: '<msg-1@mail.gmail.com>',
      references: '<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>',
    }),
  );
  const lines = raw.split('\r\n');
  assert.equal(lines[0], 'To: a@b.c');
  assert.equal(lines[1], 'Subject: Re: Hello');
  assert.equal(lines[2], 'In-Reply-To: <msg-1@mail.gmail.com>');
  assert.equal(lines[3], 'References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>');
  assert.equal(lines[4], 'MIME-Version: 1.0');
});

test('buildMime strips CR/LF from every header value (header injection is impossible)', () => {
  const raw = decodeB64url(
    buildMime({
      to: 'wes@example.com\r\nBcc: attacker@evil.example',
      cc: 'ops@example.com\nX-Smuggled: 1',
      subject: 'Hi\r\nX-Injected: yes',
      inReplyTo: '<m@x>\r\nBcc: more@evil.example',
      references: '<r@x>\nBcc: again@evil.example',
      body: 'body',
    }),
  );
  const lines = raw.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(lines.length, 8, 'To/Cc/Subject/In-Reply-To/References + MIME-Version/Content-Type/Content-Transfer-Encoding — nothing else');
  assert.doesNotMatch(raw.split('\r\n\r\n')[0], /^Bcc:/im, 'no line begins with a smuggled Bcc header');
  assert.doesNotMatch(raw.split('\r\n\r\n')[0], /^X-Smuggled:/im);
  assert.doesNotMatch(raw.split('\r\n\r\n')[0], /^X-Injected:/im);
  assert.equal(lines[0], 'To: wes@example.com Bcc: attacker@evil.example', 'CRLF collapses to a space inside the value');
  assert.equal(lines[2], 'Subject: Hi X-Injected: yes');
});

test('buildMime tolerates missing fields and encodes the body byte-exactly', () => {
  const raw = decodeB64url(buildMime({ to: 'a@b.c', subject: 's', body: 'line1\r\nline2' }));
  assert.equal(raw.split('\r\n\r\n')[1], 'line1\r\nline2', 'body keeps its own CRLFs');
  const minimal = decodeB64url(buildMime({ to: 'a@b.c' }));
  assert.match(minimal, /^To: a@b\.c\r\nSubject: \r\nMIME-Version: 1\.0/m, 'missing subject/body default to empty');
});

/* ---------- body-part preference parser (format=full payload) ---------- */

const FULL_PART = (mimeType, data, extra = {}) => ({ mimeType, body: { data, size: 10 }, ...extra });

test('parseGmailBody prefers the text/plain part over text/html', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [FULL_PART('text/html', 'aHRtbCE='), FULL_PART('text/plain', 'cGxhaW4h')],
  };
  assert.deepEqual(parseGmailBody(payload), { kind: 'text', body: 'plain!' });
});

test('parseGmailBody falls back to the html part and flags it', () => {
  const payload = { mimeType: 'multipart/alternative', parts: [FULL_PART('text/html', 'PGI+aGk8L2I+')] };
  assert.deepEqual(parseGmailBody(payload), { kind: 'html', body: '<b>hi</b>' });
});

test('parseGmailBody reads a single-part message body', () => {
  assert.deepEqual(parseGmailBody({ mimeType: 'text/plain', body: { data: 'dG9wIGxldmVs' } }), { kind: 'text', body: 'top level' });
  assert.deepEqual(parseGmailBody({ mimeType: 'text/html', body: { data: 'PGk+aGk8L2k+' } }), { kind: 'html', body: '<i>hi</i>' });
});

test('parseGmailBody walks nested multipart containers and skips attachment parts', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: 'bmVzdGVk' } },
          { mimeType: 'text/html', body: { data: 'PG5lc3RlZD4=' } },
        ],
      },
      { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'att-1', size: 4242 } },
    ],
  };
  assert.deepEqual(parseGmailBody(payload), { kind: 'text', body: 'nested' }, 'the pdf part is not body text');
});

test('parseGmailBody returns an empty text body for sparse payloads instead of throwing', () => {
  assert.deepEqual(parseGmailBody({}), { kind: 'text', body: '' });
  assert.deepEqual(parseGmailBody(null), { kind: 'text', body: '' });
  assert.deepEqual(parseGmailBody({ mimeType: 'multipart/mixed', parts: [{ filename: 'x.pdf', body: { attachmentId: 'a' } }] }), { kind: 'text', body: '' });
});

/* ---------- attachment listing ---------- */

test('parseAttachments lists every attachmentId part with filename, type and size', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      FULL_PART('text/plain', 'aGk='),
      { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'att-1', size: '4242' } },
      {
        mimeType: 'multipart/related',
        parts: [{ mimeType: 'image/png', filename: 'pic.png', body: { attachmentId: 'att-2', size: 99 } }],
      },
    ],
  };
  assert.deepEqual(
    parseAttachments(payload),
    [
      { filename: 'report.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 4242 },
      { filename: 'pic.png', mimeType: 'image/png', attachmentId: 'att-2', size: 99 },
    ],
    'sizes are numbers and nested parts are found',
  );
});

test('parseAttachments ignores body parts and tolerates sparse input', () => {
  assert.deepEqual(parseAttachments(FULL_PART('text/plain', 'aGk=')), [], 'inline body parts are not attachments');
  assert.deepEqual(parseAttachments(null), []);
  assert.deepEqual(parseAttachments({ parts: [null, { filename: 'x', body: {} }] }), [], 'parts without an attachmentId are skipped');
});

/* ---------- deep message mapping (format=full → UI shape) ---------- */

test('mapGmailFull maps headers, body, attachments and a safe webLink', () => {
  const m = {
    id: 'msg-9',
    threadId: 'th-1',
    snippet: 'snip',
    internalDate: '1761907200000',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Wes <wes@x.io>' },
        { name: 'To', value: 'me@atrium.app' },
        { name: 'Cc', value: 'ops@atrium.app' },
        { name: 'Subject', value: 'Report' },
        { name: 'Message-ID', value: '<m1@x.io>' },
        { name: 'In-Reply-To', value: '<m0@x.io>' },
        { name: 'References', value: '<m0@x.io>' },
        { name: 'Reply-To', value: 'noreply@x.io' },
      ],
      mimeType: 'multipart/mixed',
      parts: [FULL_PART('text/plain', 'Ym9keSE='), { mimeType: 'application/pdf', filename: 'r.pdf', body: { attachmentId: 'a1', size: 12 } }],
    },
  };
  const got = mapGmailFull(m);
  assert.equal(got.id, 'msg-9');
  assert.equal(got.threadId, 'th-1');
  assert.equal(got.from, 'Wes');
  assert.equal(got.email, 'wes@x.io');
  assert.equal(got.to, 'me@atrium.app');
  assert.equal(got.cc, 'ops@atrium.app');
  assert.equal(got.replyTo, 'noreply@x.io');
  assert.equal(got.subject, 'Report');
  assert.equal(got.messageId, '<m1@x.io>');
  assert.equal(got.inReplyTo, '<m0@x.io>');
  assert.equal(got.references, '<m0@x.io>');
  assert.equal(got.date, 1761907200000);
  assert.equal(got.unread, true);
  assert.deepEqual(got.body, { kind: 'text', body: 'body!' });
  assert.deepEqual(got.attachments, [{ filename: 'r.pdf', mimeType: 'application/pdf', attachmentId: 'a1', size: 12 }]);
  assert.equal(got.webLink, 'https://mail.google.com/mail/u/0/#inbox/msg-9');
});

test('mapGmailFull is null-safe and builds a safe webLink only for clean ids', () => {
  assert.equal(mapGmailFull(null), null);
  const evil = mapGmailFull({ id: 'x/y?z', payload: { headers: [] } });
  assert.equal(evil.webLink, '', 'ids with path/query characters never become links');
});

/* ---------- thread grouping (oldest → newest) ---------- */

test('mapThread groups messages chronologically regardless of payload order', () => {
  const mk = (id, at) => ({ id, internalDate: String(at), payload: { headers: [{ name: 'Subject', value: id }] } });
  const t = mapThread({ id: 'th-9', messages: [mk('third', 3000), mk('first', 1000), mk('second', 2000)] });
  assert.equal(t.id, 'th-9');
  assert.deepEqual(
    t.messages.map(m => m.subject),
    ['first', 'second', 'third'],
    'replies read oldest → newest',
  );
});

test('mapThread keeps insertion order for equal timestamps and handles sparse input', () => {
  const mk = (id, at) => ({ id, internalDate: String(at), payload: { headers: [] } });
  const t = mapThread({ id: 'x', messages: [mk('a', 5), mk('b', 5)] });
  assert.deepEqual(
    t.messages.map(m => m.id),
    ['a', 'b'],
    'stable sort on ties',
  );
  assert.deepEqual(mapThread(null), { id: '', messages: [] });
  assert.deepEqual(mapThread({ id: 'x' }), { id: 'x', messages: [] });
  assert.deepEqual(mapThread({ id: 'x', messages: [null, 42] }).messages, [], 'junk entries are dropped');
});

/* ---------- calendar event payload builder (create/update) ---------- */

test('buildEventResource builds a timed event with attendees, location and description', () => {
  const res = buildEventResource({
    title: 'Design review',
    start: { dateTime: '2026-11-05T09:30:00+01:00' },
    end: { dateTime: '2026-11-05T10:30:00+01:00' },
    location: 'Room 2',
    description: 'Bring the wireframes',
    attendees: ['Wes@Example.com', 'ops@example.com', 'Wes@example.com', 'not-an-email', ''],
  });
  assert.deepEqual(
    res,
    {
      summary: 'Design review',
      start: { dateTime: '2026-11-05T09:30:00+01:00' },
      end: { dateTime: '2026-11-05T10:30:00+01:00' },
      location: 'Room 2',
      description: 'Bring the wireframes',
      attendees: [{ email: 'wes@example.com' }, { email: 'ops@example.com' }],
    },
    'attendees are normalized, deduped and validated',
  );
});

test('buildEventResource builds an all-day event with date-only start/end', () => {
  const res = buildEventResource({ title: 'Offsite', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } });
  assert.deepEqual(res.start, { date: '2026-11-05' });
  assert.deepEqual(res.end, { date: '2026-11-06' });
  assert.equal(res.attendees, undefined, 'no attendees key when the list is empty');
});

test('buildEventResource rejects invalid payloads with null (never a partial resource)', () => {
  assert.equal(buildEventResource(null), null);
  assert.equal(buildEventResource({}), null, 'missing title');
  assert.equal(buildEventResource({ title: 'x' }), null, 'missing start');
  assert.equal(buildEventResource({ title: 'x', start: { date: '05/11/2026' }, end: { date: '2026-11-06' } }), null, 'malformed date');
  assert.equal(
    buildEventResource({ title: 'x', start: { dateTime: '2026-11-05 09:30' }, end: { dateTime: '2026-11-05T10:30:00Z' } }),
    null,
    'malformed dateTime',
  );
  assert.equal(
    buildEventResource({ title: 'x', start: { date: '2026-11-05' }, end: { dateTime: '2026-11-05T10:30:00Z' } }),
    null,
    'all-day start with timed end is rejected',
  );
  assert.equal(buildEventResource({ title: 'x', start: { dateTime: '2026-11-05T09:30:00Z' }, end: {} }), null, 'missing end');
});

test('buildEventResource caps hostile field sizes and strips control characters', () => {
  const res = buildEventResource({
    title: 'T\r\n<script>'.padEnd(600, 'x'),
    start: { date: '2026-11-05' },
    end: { date: '2026-11-06' },
    description: 'd'.padEnd(9000, 'd'),
    attendees: Array.from({ length: 80 }, (_, i) => `p${i}@x.io`),
  });
  assert.equal(res.summary.length, 500, 'title is capped');
  assert.doesNotMatch(res.summary, /[\r\n]/);
  assert.equal(res.description.length, 8000, 'description is capped');
  assert.equal(res.attendees.length, 50, 'attendees are capped at 50');
});

/* ---------- gmail search query + numeric clamps ---------- */

test('validGmailQuery strips control characters and clamps the length', () => {
  assert.equal(validGmailQuery('from:wes subject:report'), 'from:wes subject:report');
  assert.equal(validGmailQuery('  padded  '), 'padded');
  assert.equal(validGmailQuery('a\r\nb'), 'a b', 'CRLF never reaches the Google URL');
  assert.equal(validGmailQuery('x'.repeat(500)).length, 200, 'query is clamped to 200 chars');
  assert.equal(validGmailQuery(42), '');
  assert.equal(validGmailQuery(null), '');
});

test('clampNum clamps to the range with an honest fallback', () => {
  assert.equal(clampNum('25', { min: 1, max: 50, fallback: 20 }), 25);
  assert.equal(clampNum('500', { min: 1, max: 50, fallback: 20 }), 50);
  assert.equal(clampNum('0', { min: 1, max: 50, fallback: 20 }), 1);
  assert.equal(clampNum('abc', { min: 1, max: 50, fallback: 20 }), 20);
  assert.equal(clampNum('', { min: 1, max: 50, fallback: 20 }), 20);
  assert.equal(clampNum('7.9', { min: 1, max: 50, fallback: 20 }), 8, 'rounds to an integer');
});

/* ---------- attendee normalization (F4: display-form addresses) ---------- */

test('normalizeAttendeeEmails reduces display-form addresses to the bare address', () => {
  assert.deepEqual(
    normalizeAttendeeEmails(['Wesley Romeijnders <wesley@operanceai.com>']),
    ['wesley@operanceai.com'],
    'Name <addr> contributes only the address',
  );
  assert.deepEqual(normalizeAttendeeEmails(['<x@y.z>']), ['x@y.z'], 'fully-wrapped form too');
  assert.deepEqual(normalizeAttendeeEmails(['Wes@Example.com', 'ops@example.com']), ['wes@example.com', 'ops@example.com'], 'bare form still lowercased');
});

test('normalizeAttendeeEmails drops entries that never reduce to a bare address', () => {
  assert.deepEqual(normalizeAttendeeEmails(['not-an-email', '', '   ']), []);
  assert.deepEqual(normalizeAttendeeEmails(['a<b@c.d']), [], 'stray angle bracket is not an address');
  assert.deepEqual(normalizeAttendeeEmails(['a,b@c.d']), [], 'commas never survive into a Google attendee');
  assert.deepEqual(normalizeAttendeeEmails(['"a"@b.c']), [], 'quoted local parts are rejected');
  assert.deepEqual(normalizeAttendeeEmails('nope'), [], 'non-array input yields []');
  assert.deepEqual(normalizeAttendeeEmails(['a@b', 'a b@c.d']), [], 'no-dot domains and spaces are dropped');
});

test('normalizeAttendeeEmails dedupes and caps at 50', () => {
  assert.deepEqual(normalizeAttendeeEmails(['A@B.co', 'a@b.co', 'a@b.co']), ['a@b.co']);
  const many = Array.from({ length: 60 }, (_, i) => `u${i}@x.co`);
  assert.equal(normalizeAttendeeEmails(many).length, 50, 'default cap 50');
  assert.equal(normalizeAttendeeEmails(many, 3).length, 3, 'cap is an argument');
});

test('buildEventResource sends Google only bare attendee emails (display form reduced)', () => {
  const res = buildEventResource({
    title: 'Sync',
    start: { date: '2026-11-05' },
    end: { date: '2026-11-06' },
    attendees: ['Wesley Romeijnders <wesley@operanceai.com>', '<other@x.co>', 'not-an-email'],
  });
  assert.deepEqual(res.attendees, [{ email: 'wesley@operanceai.com' }, { email: 'other@x.co' }], 'never an angle-bracket address to Google');
});

/* ---------- compose request parsing (F5: cc was the one uncapped header) ---------- */

test('parseCompose validates the compose request and caps every header', () => {
  assert.equal(parseCompose({ to: 'a@b.co', body: 'hi', subject: 's', cc: '' }).to, 'a@b.co', 'normalized fields come back');
  assert.equal(parseCompose({ to: 'a@b.co' }).error, undefined, 'cc is optional');
  assert.equal(parseCompose({ to: '' }).error, 'invalid_recipient', 'to is required');
  assert.equal(parseCompose({}).error, 'invalid_recipient', 'missing to');
  assert.equal(parseCompose({ to: 'x'.repeat(1001) }).error, 'invalid_recipient', 'to over cap');
  assert.equal(parseCompose({ to: 'a@b.co', cc: 'x'.repeat(1001) }).error, 'invalid_recipient', 'cc is capped like to');
  assert.equal(parseCompose({ to: 'a@b.co', cc: 'x'.repeat(1000) }).error, undefined, 'cc at the cap passes');
  assert.equal(parseCompose({ to: 'a@b.co', subject: 'x'.repeat(999) }).error, 'subject_too_long');
  assert.equal(parseCompose({ to: 'a@b.co', body: 'x'.repeat(200001) }).error, 'body_too_long');
});

/* ---------- endpoint error surface (F6: the 502 detail must reach the UI) ---------- */

test('errorFromEndpoint keeps the honest code and appends the Google detail verbatim', () => {
  assert.equal(errorFromEndpoint({ error: 'google_error', detail: "Google's own message" }, 502), "google_error: Google's own message");
  assert.equal(errorFromEndpoint({ error: 'google_error', detail: '   ' }, 502), 'google_error', 'blank detail adds nothing');
  assert.equal(errorFromEndpoint({}, 502), 'Request failed (502)');
  assert.equal(errorFromEndpoint({ error: 'forbidden' }), 'forbidden');
  assert.equal(errorFromEndpoint(null, 502), 'Request failed (502)');
});
