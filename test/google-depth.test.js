/* Unit tests for the Google-DEPTH additions (drafts, labels/stars, bulk,
   freeBusy, multi-calendar) in supabase/functions/_shared/google-pure.js.
   Same contract as google-data.test.js: pure data-in/data-out, no network,
   no DOM, no clock — the SAME module runs under node --test, the Deno edge
   runtime and the Vite frontend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapGmailDraft,
  parseDraftCompose,
  mapGmailLabel,
  isSystemLabelId,
  validLabelName,
  validIdList,
  buildBatchModify,
  buildBatchDelete,
  safeCalId,
  buildFreebusyRequest,
  mapFreebusy,
  mergeBusyIntervals,
  busyOnDay,
  mapCalendarList,
  resolveEnabledCalendars,
  eventCalendarTarget,
  mergeCalendarEvents,
  ensureGooglePrefs,
  mapGmailMessage,
  // review fixes F1–F6
  shouldFetchDrafts,
  draftSendPlan,
  MAX_FREEBUSY_DAYS,
  BULK_MAX,
  bulkSelectionWarning,
  refilterSelection,
  busyBarLayout,
  calendarWindowOutcome,
} from '../supabase/functions/_shared/google-pure.js';

/* ---------- AC1 · drafts mapping ---------- */

const DRAFT_FULL = {
  id: 'draft-1',
  message: {
    id: 'msg-9',
    threadId: 'th-1',
    snippet: 'Half-written note',
    internalDate: '1761907200000',
    payload: {
      headers: [
        { name: 'To', value: 'ana@client.co, bob@client.co' },
        { name: 'Cc', value: 'qa@client.co' },
        { name: 'Subject', value: 'Proposal draft' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: btoa('Hello draft body') } }],
    },
  },
};

test('mapGmailDraft maps a format=full draft into compose-prefill shape', () => {
  const d = mapGmailDraft(DRAFT_FULL);
  assert.deepEqual(d, {
    id: 'draft-1',
    messageId: 'msg-9',
    threadId: 'th-1',
    to: 'ana@client.co, bob@client.co',
    cc: 'qa@client.co',
    subject: 'Proposal draft',
    snippet: 'Half-written note',
    date: 1761907200000,
    body: { kind: 'text', body: 'Hello draft body' },
  });
});

test('mapGmailDraft falls back honestly on sparse/metadata drafts', () => {
  const meta = mapGmailDraft({ id: 'draft-2', message: { id: 'm2', payload: { headers: [{ name: 'Subject', value: 'Empty' }] } } });
  assert.equal(meta.id, 'draft-2');
  assert.equal(meta.subject, 'Empty');
  assert.equal(meta.to, '');
  assert.deepEqual(meta.body, { kind: 'text', body: '' }, 'metadata payload has no body data');
  assert.equal(mapGmailDraft(null), null);
  assert.equal(mapGmailDraft({}), null, 'a draft without an id is dropped');
});

/* ---------- AC1 · draft compose validation (recipients OPTIONAL) ---------- */

test('parseDraftCompose allows empty recipients (unlike send) but keeps the caps', () => {
  assert.deepEqual(parseDraftCompose({ body: 'notes only' }), { to: '', cc: '', subject: '', text: 'notes only' });
  assert.deepEqual(parseDraftCompose({ to: '  a@b.co  ', subject: 'Hi', body: 'x' }), { to: 'a@b.co', cc: '', subject: 'Hi', text: 'x' });
  assert.deepEqual(parseDraftCompose({ to: 'x'.repeat(1001) }), { error: 'invalid_recipient' });
  assert.deepEqual(parseDraftCompose({ cc: 'x'.repeat(1001) }), { error: 'invalid_recipient' });
  assert.deepEqual(parseDraftCompose({ subject: 'x'.repeat(999) }), { error: 'subject_too_long' });
  assert.deepEqual(parseDraftCompose({ body: 'x'.repeat(200_001) }), { error: 'body_too_long' });
  assert.deepEqual(parseDraftCompose({}), { to: '', cc: '', subject: '', text: '' });
  assert.deepEqual(parseDraftCompose(null), { to: '', cc: '', subject: '', text: '' }, 'null body → empty draft, never a throw');
});

/* ---------- AC2 · labels ---------- */

test('mapGmailLabel maps id/name/type; junk is dropped', () => {
  assert.deepEqual(mapGmailLabel({ id: 'INBOX', name: 'Inbox', type: 'system' }), { id: 'INBOX', name: 'Inbox', type: 'system' });
  assert.deepEqual(mapGmailLabel({ id: 'Label_1', name: 'Clients', type: 'user' }), { id: 'Label_1', name: 'Clients', type: 'user' });
  assert.equal(mapGmailLabel({ id: 'Label_2' }).type, 'system', 'a missing type field is treated as system (fail closed)');
  assert.equal(mapGmailLabel(null), null);
  assert.equal(mapGmailLabel({ name: 'no id' }), null);
});

test('isSystemLabelId recognises system labels and prefixes; user labels are not system', () => {
  for (const id of ['INBOX', 'UNREAD', 'STARRED', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_FORUM', 'GOOGR1234']) {
    assert.equal(isSystemLabelId(id), true, id);
  }
  for (const id of ['Label_1', 'Label_abc', 'user-tag', 'primary', '', null, undefined]) {
    assert.equal(isSystemLabelId(id), false, String(id));
  }
});

test('validLabelName strips control characters, trims and caps at 100 chars', () => {
  assert.equal(validLabelName('  Clients  '), 'Clients');
  assert.equal(validLabelName('Bad\r\nBcc: attacker@evil'), 'Bad Bcc: attacker@evil', 'header injection is collapsed to spaces');
  assert.equal(validLabelName('x'.repeat(140)).length, 100);
  assert.equal(validLabelName('   '), '');
  assert.equal(validLabelName(42), '');
  assert.equal(validLabelName(null), '');
});

test('validIdList keeps only Gmail base64url ids, deduped and clamped', () => {
  const ok = ['msg-a', 'msg-b', 'msg-a', 'not ok!', 'x'.repeat(257)];
  assert.deepEqual(validIdList(ok), ['msg-a', 'msg-b'], 'invalid ids dropped, dedupe, 256-char cap');
  assert.deepEqual(validIdList(Array.from({ length: 60 }, (_, i) => `m${i}`)).length, 50, 'clamped to 50');
  assert.deepEqual(validIdList(['STARRED', 'Label_1', 'UNREAD']), ['STARRED', 'Label_1', 'UNREAD'], 'label ids pass the same alphabet');
  assert.deepEqual(validIdList(null), []);
  assert.deepEqual(validIdList('nope'), [], 'a bare string is not an id list');
  assert.deepEqual(validIdList(['a', 'b'], 1), ['a'], 'max clamp is honoured');
});

/* ---------- AC3 · bulk payload builders + clamps ---------- */

test('buildBatchModify builds add/remove label payloads and clamps ids to 50', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
  const out = buildBatchModify(ids, { unread: true, archive: true });
  assert.equal(out.ids.length, 50);
  assert.deepEqual(out.ids, ids.slice(0, 50));
  assert.deepEqual(out.addLabelIds, ['UNREAD']);
  assert.deepEqual(out.removeLabelIds, ['INBOX']);
});

test('buildBatchModify honours unread:false, explicit label lists and dedupes', () => {
  const out = buildBatchModify(['m1', 'm1', 'm2'], { unread: false, addLabelIds: ['STARRED', 'Label_1', 'STARRED', 'no!'], removeLabelIds: ['Label_2'] });
  assert.deepEqual(out.ids, ['m1', 'm2'], 'deduped');
  assert.deepEqual(out.addLabelIds, ['STARRED', 'Label_1'], 'invalid label ids dropped, deduped');
  assert.deepEqual(out.removeLabelIds, ['UNREAD', 'Label_2'], 'unread:false removes UNREAD alongside the explicit list');
});

test('buildBatchModify fails honestly on empty ids or a no-op payload', () => {
  assert.deepEqual(buildBatchModify([], { unread: true }), { error: 'no_ids' });
  assert.deepEqual(buildBatchModify(['   ', 'bad id'], { unread: true }), { error: 'no_ids' }, 'all-invalid ids are an error, not a partial call');
  assert.deepEqual(buildBatchModify(['m1'], {}), { error: 'nothing_to_do' });
  assert.deepEqual(buildBatchModify(['m1'], { addLabelIds: [], removeLabelIds: [] }), { error: 'nothing_to_do' });
  assert.deepEqual(buildBatchDelete([]), { error: 'no_ids' });
});

test('buildBatchDelete clamps and dedupes ids', () => {
  const out = buildBatchDelete(Array.from({ length: 55 }, (_, i) => `m${i}`));
  assert.equal(out.ids.length, 50);
  assert.deepEqual(buildBatchDelete(['m1', 'm1']), { ids: ['m1'] });
});

/* ---------- AC4 · freeBusy ---------- */

test('safeCalId allows calendar-id characters only (emails, dots, #groups)', () => {
  assert.equal(safeCalId('wes@operanceai.com'), 'wes@operanceai.com');
  assert.equal(safeCalId('#contacts@group.v.calendar.google.com'), '#contacts@group.v.calendar.google.com');
  assert.equal(safeCalId('c_abc123@group.calendar.google.com'), 'c_abc123@group.calendar.google.com');
  assert.equal(safeCalId('primary'), 'primary');
  assert.equal(safeCalId('bad id'), '', 'spaces rejected');
  assert.equal(safeCalId('x\ny'), '', 'control chars rejected');
  assert.equal(safeCalId('x'.repeat(301)), '', 'over 300 chars rejected');
  assert.equal(safeCalId(null), '');
});

test('buildFreebusyRequest pads the day window and builds items (default primary)', () => {
  const r = buildFreebusyRequest({ from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(r, {
    timeMin: '2026-10-30T00:00:00Z',
    timeMax: '2026-11-01T23:59:59Z',
    items: [{ id: 'primary' }],
  });
  const r2 = buildFreebusyRequest({ from: '2026-10-01', to: '2026-10-31', calendarIds: ['wes@operanceai.com', 'no id', 'wes@operanceai.com', 'primary'] });
  assert.deepEqual(r2.items, [{ id: 'wes@operanceai.com' }, { id: 'primary' }], 'invalid dropped, deduped, order kept');
  assert.equal(buildFreebusyRequest({ from: 'nope', to: '2026-10-31' }), null, 'a non-ISO date is rejected');
  assert.equal(buildFreebusyRequest({}), null);
});

const MS = (h, m = 0) => Date.parse(`2026-10-31T${String(Math.floor(h)).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const DAY_END = Date.parse('2026-11-01T00:00:00Z');

test('mergeBusyIntervals sorts and merges overlapping/touching intervals', () => {
  assert.deepEqual(
    mergeBusyIntervals([
      { s: MS(14), e: MS(15) },
      { s: MS(9), e: MS(10) },
      { s: MS(9, 30), e: MS(12) },
      { s: MS(12), e: MS(13) },
    ]),
    [
      { s: MS(9), e: MS(13) },
      { s: MS(14), e: MS(15) },
    ],
    'unsorted input, overlap and touching all merge',
  );
  assert.deepEqual(mergeBusyIntervals([]), []);
  assert.deepEqual(mergeBusyIntervals([{ s: MS(9), e: MS(9) }, { s: 1, e: 'x' }, null]), [], 'zero-length and junk entries are dropped');
  assert.deepEqual(
    mergeBusyIntervals([
      { s: MS(10), e: MS(11) },
      { s: MS(10), e: MS(12) },
    ]),
    [{ s: MS(10), e: MS(12) }],
    'contained intervals absorb',
  );
});

test('busyOnDay clips busy intervals to the day window', () => {
  const day0 = MS(0);
  const blocks = busyOnDay(
    [
      { s: day0 - 3600e3, e: day0 + 3600e3 },
      { s: MS(14), e: MS(15) },
      { s: MS(23), e: DAY_END + 5400e3 },
      { s: DAY_END + 3600e3, e: DAY_END + 7200e3 },
    ],
    day0,
    DAY_END,
  );
  assert.deepEqual(
    blocks,
    [
      { s: day0, e: day0 + 3600e3 },
      { s: MS(14), e: MS(15) },
      { s: MS(23), e: DAY_END },
    ],
    'spilling intervals are clipped, fully-outside intervals dropped',
  );
  assert.deepEqual(busyOnDay([{ s: 1, e: 2 }], NaN, 10), [], 'invalid window → no blocks');
  assert.deepEqual(busyOnDay([{ s: 1, e: 2 }], 10, 10), [], 'empty window → no blocks');
});

test('mapFreebusy maps Google freeBusy bodies into merged busy intervals', () => {
  const body = {
    calendars: {
      'wes@operanceai.com': {
        busy: [
          { start: '2026-10-31T09:00:00Z', end: '2026-10-31T10:00:00Z' },
          { start: '2026-10-31T09:30:00Z', end: '2026-10-31T11:00:00Z' },
        ],
      },
      'team@group.calendar.google.com': { busy: [{ start: '2026-10-31T14:00:00Z', end: '2026-10-31T15:00:00Z' }] },
      broken: { busy: [{ start: 'garbage', end: '2026-10-31T10:00:00Z' }] },
    },
  };
  const m = mapFreebusy(body);
  assert.deepEqual(
    m.busy,
    [
      { s: MS(9), e: MS(11) },
      { s: MS(14), e: MS(15) },
    ],
    'per-calendar busy merged across calendars, junk dropped',
  );
  assert.equal(m.perCalendar['wes@operanceai.com'].length, 2, "per-calendar breakdown keeps Google's raw blocks; the merge happens in m.busy");
  assert.deepEqual(mapFreebusy(null), { busy: [], perCalendar: {} });
  assert.deepEqual(mapFreebusy({ calendars: {} }), { busy: [], perCalendar: {} });
});

/* ---------- AC5 · calendarList mapping + enabled-set resolution ---------- */

const CALS = [
  { id: 'wes@operanceai.com', summary: 'Wesley', colorId: '12', backgroundColor: '#1A73E8', primary: true, accessRole: 'owner' },
  { id: 'team@group.calendar.google.com', summary: 'Team', colorId: '3', backgroundColor: '#8E24AA', accessRole: 'writer' },
  { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', colorId: '7', backgroundColor: '#F6BF26', accessRole: 'reader' },
];

test('mapCalendarList maps the fields the surfaces need; junk dropped', () => {
  assert.deepEqual(mapCalendarList(CALS), [
    { id: 'wes@operanceai.com', summary: 'Wesley', colorId: '12', backgroundColor: '#1A73E8', primary: true, accessRole: 'owner' },
    { id: 'team@group.calendar.google.com', summary: 'Team', colorId: '3', backgroundColor: '#8E24AA', primary: false, accessRole: 'writer' },
    { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', colorId: '7', backgroundColor: '#F6BF26', primary: false, accessRole: 'reader' },
  ]);
  assert.deepEqual(mapCalendarList([null, 'x', { noId: 1 }]), []);
  assert.deepEqual(mapCalendarList(null), []);
  assert.equal(mapCalendarList([{ id: 'c1' }])[0].summary, 'c1', 'missing summary falls back to the id');
});

test('resolveEnabledCalendars validates prefs ids against the fetched list (primary alias resolved)', () => {
  assert.deepEqual(resolveEnabledCalendars(['primary'], CALS), ['wes@operanceai.com'], "'primary' resolves to the real primary entry");
  assert.deepEqual(resolveEnabledCalendars(['wes@operanceai.com', 'team@group.calendar.google.com'], CALS), [
    'wes@operanceai.com',
    'team@group.calendar.google.com',
  ]);
  assert.deepEqual(resolveEnabledCalendars(['wes@operanceai.com', 'deleted@calendar.google.com'], CALS), ['wes@operanceai.com'], 'unknown ids dropped');
  assert.deepEqual(resolveEnabledCalendars([], CALS), ['primary'], 'empty selection → API alias');
  assert.deepEqual(resolveEnabledCalendars(undefined, []), ['primary'], 'no list yet → alias');
  assert.deepEqual(resolveEnabledCalendars(['wes@operanceai.com', 'wes@operanceai.com'], CALS), ['wes@operanceai.com'], 'deduped');
});

test('eventCalendarTarget resolves the calendar for event writes (membership + write access)', () => {
  assert.deepEqual(eventCalendarTarget('', CALS), { id: 'wes@operanceai.com', summary: 'Wesley' }, 'default (no calendarId) → primary entry');
  assert.deepEqual(eventCalendarTarget('primary', CALS), { id: 'wes@operanceai.com', summary: 'Wesley' });
  assert.deepEqual(eventCalendarTarget('team@group.calendar.google.com', CALS), { id: 'team@group.calendar.google.com', summary: 'Team' });
  assert.deepEqual(eventCalendarTarget('holidays@group.v.calendar.google.com', CALS), { error: 'calendar_read_only' }, 'reader calendar refused');
  assert.deepEqual(eventCalendarTarget('ghost@group.calendar.google.com', CALS), { error: 'unknown_calendar' }, 'not in the calendar list → refused');
  assert.deepEqual(eventCalendarTarget('bad id', CALS), { error: 'invalid_calendar' });
  assert.deepEqual(eventCalendarTarget(null, []), { id: 'primary' }, 'no list context: the primary alias is allowed');
});

/* ---------- AC5 · merged events across calendars ---------- */

test('mergeCalendarEvents flattens and sorts per-calendar event lists by start', () => {
  const a = { id: 'a', summary: 'A', start: { dateTime: '2026-10-31T09:00:00Z' }, end: {} };
  const b = { id: 'b', summary: 'B', start: { date: '2026-10-31' }, end: {} };
  const c = { id: 'c', summary: 'C', start: { dateTime: '2026-10-30T23:00:00Z' }, end: {} };
  assert.deepEqual(
    mergeCalendarEvents([[a], [c], [b], 'junk']).map(e => e.id),
    ['c', 'b', 'a'],
    'all-day (date) sorts before timed on the same day',
  );
  assert.deepEqual(mergeCalendarEvents(null), []);
  assert.deepEqual(mergeCalendarEvents([[]]), []);
});

/* ---------- AC5 · prefs.calendarIds zero-loss init ---------- */

test('ensureGooglePrefs fills a missing calendarIds without touching anything else', () => {
  const prefs = { theme: 'dark', weekStart: 1, name: 'Wes' };
  const out = ensureGooglePrefs(prefs);
  assert.deepEqual(out.calendarIds, ['primary']);
  assert.deepEqual(Object.keys(prefs).sort(), ['calendarIds', 'name', 'theme', 'weekStart'], 'only the new key was added');
  assert.equal(prefs.theme, 'dark');
});

test('ensureGooglePrefs keeps a valid calendarIds array by reference and is idempotent', () => {
  const keep = ['wes@operanceai.com', 'team@group.calendar.google.com'];
  const prefs = { calendarIds: keep, theme: 'light' };
  const out = ensureGooglePrefs(prefs);
  assert.equal(out.calendarIds, keep, 'valid value kept by reference (zero-loss)');
  assert.equal(out, prefs, 'same object — idempotent in place');
  ensureGooglePrefs(prefs);
  assert.deepEqual(prefs.calendarIds, keep);
});

test('ensureGooglePrefs resets corrupt values to the default (an empty array is a valid user choice)', () => {
  for (const bad of [null, 'primary', {}, [42, '']]) {
    const prefs = { calendarIds: bad, theme: 'dark' };
    assert.deepEqual(ensureGooglePrefs(prefs).calendarIds, ['primary'], `corrupt ${JSON.stringify(bad)} → default`);
    assert.equal(prefs.theme, 'dark', 'other keys untouched');
  }
  const empty = { calendarIds: [], theme: 'dark' };
  assert.deepEqual(ensureGooglePrefs(empty).calendarIds, [], 'empty array kept: resolveEnabledCalendars falls back to primary at fetch time');
  assert.equal(ensureGooglePrefs(null), null);
});

/* ---------- AC2/AC3 · list rows carry labels (stars, chips, badges) ---------- */

test('mapGmailMessage maps labelIds: starred + full labels list', () => {
  const m = mapGmailMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD', 'STARRED', 'Label_1'], snippet: '', payload: { headers: [] } });
  assert.equal(m.starred, true);
  assert.deepEqual(m.labels, ['INBOX', 'UNREAD', 'STARRED', 'Label_1']);
  const bare = mapGmailMessage({ id: 'm2', payload: { headers: [] } });
  assert.equal(bare.starred, false, 'no labels → not starred');
  assert.deepEqual(bare.labels, []);
});

/* ---------- review fixes F1–F6 (gdepth fix loop) — pure contracts ---------- */

/* F1 — Drafts fetch guard. The Drafts page calls ensureGmailDrafts() on
   every synchronous render; without a settled-state guard the view loops
   fetch → render → fetch forever (edge + Gmail quota burn). The guard is
   a pure contract: only an armed state may fetch, and ONLY an explicit
   reset (chip click / Retry / a draft mutation) re-arms it. */
test('F1 shouldFetchDrafts blocks every settled state and arms only idle', () => {
  for (const settled of ['loading', 'ok', 'empty', 'error']) {
    assert.equal(shouldFetchDrafts(settled), false, `"${settled}" is settled/terminal — must never refetch on render`);
  }
  for (const armed of ['idle', 'off', undefined]) {
    assert.equal(shouldFetchDrafts(armed), true, `"${String(armed)}" arms exactly one fetch`);
  }
});

/* F2 — Draft-aware send plan. A send from a draft-aware compose must
   update the STORED draft with the current edited form first (PATCH
   gmail/draft) and only then send the draft (POST gmail/draft/send) —
   otherwise the stale stored draft goes out under a 'Message sent'
   toast. Without a draftId the direct send path is unchanged. */
test('F2 draftSendPlan routes draft sends through update-then-send', () => {
  const p = draftSendPlan('draft-abc');
  assert.equal(p.updateThenSend, true, 'a draftId means: update the draft first');
  assert.equal(p.draftId, 'draft-abc');
  for (const none of ['', null, undefined]) {
    assert.deepEqual(draftSendPlan(none), { directSend: true }, `no draftId (${String(none)}) → direct send, unchanged path`);
  }
});

/* F3 — freebusy window clamp. freeBusy.query accepts an unbounded
   timeMin/timeMax pair; a crafted ~12,000-year span must answer
   invalid_window (null) instead of reaching Google. 62 days is the
   service ceiling (a generous grid window); same-day and ≤62-day
   windows pass. */
test('F3 buildFreebusyRequest rejects windows wider than 62 days', () => {
  assert.equal(MAX_FREEBUSY_DAYS, 62);
  const day = buildFreebusyRequest({ from: '2026-10-31', to: '2026-10-31', calendarIds: [] });
  assert.ok(day && day.timeMin.startsWith('2026-10-30'), 'same-day request still padded ±1');
  const wide = buildFreebusyRequest({ from: '2026-01-01', to: '2026-03-04', calendarIds: [] });
  assert.ok(wide, 'exactly 62 days is allowed');
  for (const [from, to] of [
    ['2026-01-01', '2026-03-05'], // 63 days — one day over
    ['0001-01-01', '9999-12-31'], // the ~12,000-year span from the review
  ]) {
    assert.equal(buildFreebusyRequest({ from, to, calendarIds: [] }), null, `${from}..${to} → null (400 invalid_window)`);
  }
  assert.equal(buildFreebusyRequest({ from: '2026-11-05', to: '2026-11-01', calendarIds: [] }), null, 'reversed window is not a valid range');
});

/* F4 — bulk selection semantics. The server clamps ids at 50; the UI
   must never LOOK like it will act on more — over the clamp the action
   is refused with an honest message (never a silent truncation). A
   changed list (chip/filter switch, search) refilters the selection to
   the ids still in view, and reports how many dropped (for the toast). */
test('F4 bulkSelectionWarning enforces the 50-id clamp honestly', () => {
  assert.equal(BULK_MAX, 50);
  assert.equal(bulkSelectionWarning(0), '');
  assert.equal(bulkSelectionWarning(1), '');
  assert.equal(bulkSelectionWarning(50), '', 'exactly 50 is the allowed maximum');
  const over = bulkSelectionWarning(51);
  assert.match(over, /at most 50/, 'the honest message names the limit');
  assert.match(over, /51/, 'the message names the actual count');
});
test('F4 refilterSelection keeps only ids still in view and reports the drop count', () => {
  const sel = new Set(['a', 'b', 'c']);
  const out = refilterSelection(sel, ['b', 'x']);
  assert.deepEqual([...out.kept], ['b'], 'only the still-visible id survives');
  assert.equal(out.dropped, 2, 'the dropped count feeds the honest toast');
  assert.deepEqual([...refilterSelection(null, ['a']).kept], []);
  assert.equal(refilterSelection(null, []).dropped, 0);
  assert.equal(refilterSelection(new Set(['a']), null).dropped, 1, 'no visible ids → everything drops');
  assert.equal(refilterSelection(new Set(['a']), ['a']).dropped, 0);
});

/* F5 — busy-strip layout. ensureFreebusy clips blocks to the TRUE local
   day window ([00:00, next 00:00) — 23 h on a spring-forward day, 25 h
   on a fall-back day); the bars must divide by that SAME span, never a
   fixed 86400e3 (a late-evening block would overflow the strip or leave
   it short on DST-shifted days). Epoch ms are passed in, so the math is
   timezone-independent. */
test('F5 busyBarLayout positions bars against the real day span', () => {
  const h = 3600e3;
  // 23-hour day (spring forward): the last local hour must reach 100%
  const short = busyBarLayout([{ s: 1000 + 22 * h, e: 1000 + 23 * h }], 1000, 1000 + 23 * h);
  assert.equal(short.length, 1);
  assert.ok(Math.abs(short[0].left + short[0].width - 100) < 1e-6, 'end-of-day block reaches 100% on a 23 h day (fixed-24h math stops at ~95.8%)');
  // 25-hour day (fall back): the repeated hour stays inside the strip
  const long1 = busyBarLayout([{ s: 1000 + 24 * h, e: 1000 + 25 * h }], 1000, 1000 + 25 * h);
  assert.ok(Math.abs(long1[0].left - 96) < 1e-6, '24 h into a 25 h day = 96% (fixed-24h math overflows to ~99.4/100%)');
  assert.ok(Math.abs(long1[0].width - 4) < 1e-6);
  // normal day: full-day block spans the strip, blocks outside are dropped
  const full = busyBarLayout([{ s: 1000, e: 1000 + 24 * h }], 1000, 1000 + 24 * h);
  assert.ok(full[0].left === 0 && Math.abs(full[0].width - 100) < 1e-6);
  assert.deepEqual(busyBarLayout([{ s: 500, e: 600 }], 1000, 1000 + h), [], 'fully outside the day → dropped');
  assert.deepEqual(busyBarLayout(null, 1000, 1000 + h), [], 'no blocks → no bars');
  assert.deepEqual(busyBarLayout([{ s: 1000, e: 1000 + h }], 1000, 999), [], 'inverted/zero window → no bars');
});

/* F6 — multi-calendar window outcome. One failing calendar must not sink
   the fetch: partial results render and the failure is NAMED (via the
   calendarList summary, raw id as fallback); a window whose EVERY
   calendar failed is an honest error. */
test('F6 calendarWindowOutcome separates ok / partial / error / empty', () => {
  const cals = [
    { id: 'a@group.calendar.google.com', summary: 'Work' },
    { id: 'b@group.calendar.google.com', summary: 'Private' },
  ];
  const ev = id => ({ id, summary: 'x' });
  assert.deepEqual(calendarWindowOutcome([ev('1'), ev('2')], [], cals), { state: 'ok', names: [] });
  const partial = calendarWindowOutcome([ev('1')], [{ calendarId: 'b@group.calendar.google.com', status: 404 }], cals);
  assert.equal(partial.state, 'partial', 'partial results still render');
  assert.deepEqual(partial.names, ['Private'], 'the failing calendar is named via its summary');
  const all = calendarWindowOutcome(
    [],
    [
      { calendarId: 'a@group.calendar.google.com', status: 404 },
      { calendarId: 'b@group.calendar.google.com', status: 500 },
    ],
    cals,
  );
  assert.equal(all.state, 'error', 'every calendar failed → honest error');
  assert.deepEqual(all.names, ['Work', 'Private']);
  assert.deepEqual(calendarWindowOutcome([], [], cals), { state: 'empty', names: [] });
  const junk = calendarWindowOutcome([ev('1')], [{ status: 404 }, { calendarId: 'zzz@group.calendar.google.com', status: 404 }], cals);
  assert.deepEqual(junk.names, ['zzz@group.calendar.google.com'], 'junk error entries ignored; unknown ids fall back to the raw id');
});
