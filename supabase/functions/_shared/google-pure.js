/* =====================================================================
   GOOGLE INTEGRATION · shared pure logic (ONE source, three runtimes)
   Plain ES module with zero imports: the SAME file is imported by
     - the Deno edge functions (supabase/functions/google-auth + google-data),
     - the Vite frontend (src/core/google.js, src/views/calendar.js),
     - node --test (test/google-data.test.js).
   Nothing here may touch network, filesystem or runtime globals beyond
   the Web-standard TextEncoder/btoa/crypto.subtle trio, which exists in
   Deno, Node 18+ and browsers alike.
   ===================================================================== */

/* ---------- scopes (READ-ONLY, by design) ---------- */

/* Atrium can READ Gmail and Google Calendar — never send, never create,
   never modify. The scopes constant is the single point of truth for the
   authorize URL and the scopes column stored with the token. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];

/* Google OAuth expects the scope list space-separated in one parameter. */
export const GOOGLE_SCOPE_PARAM = GOOGLE_SCOPES.join(' ');

/* ---------- fetch-on-render guards (error states are terminal) ---------- */

/* A fetch may start only from a non-terminal state. 'loading' is in
   flight, 'ok'/'empty' are settled results and 'error' is TERMINAL until
   the user's explicit Retry action resets the state to 'idle'. render()
   is synchronous and pages call the ensure*() helpers on every render, so
   an auto-retrying error state would loop forever (fetch → fail → render
   → fetch) and hammer the edge function + Google's token endpoint.
   'idle', 'off' (disconnected surface; surfaces re-arm via connect) and
   unset states may fetch. */
export function shouldFetch(state) {
  return state !== 'loading' && state !== 'ok' && state !== 'empty' && state !== 'error';
}

/* Calendar fetches are window-scoped: a settled or failed state only
   blocks refetching the SAME window (winKey === fetchedKey). A changed
   window is a navigation, not a retry, and always fetches. */
export function shouldFetchWindow(state, winKey, fetchedKey) {
  return shouldFetch(state) || winKey !== fetchedKey;
}

/* ---------- OAuth state with per-flow nonce ---------- */

/* CSRF state for the OAuth round-trip: "<user id>.<nonce>.<base64url(HMAC-SHA256(user id + '.' + nonce, secret))>".
   The nonce makes the state per-flow: authorize mints a fresh one and
   stores it (with a 10-minute expiry) next to the user's integration row;
   the callback requires the row to still hold THIS nonce and consumes it
   before exchanging the code, so a leaked state cannot be replayed to
   bind a different Google account into the victim's row. The callback
   re-computes the signature in constant time; a forged, expired,
   consumed or foreign-key state fails the check. The secret is the
   service-role key, which never leaves the server. */

export async function signState(userId, nonce, key) {
  if (!userId || !nonce || !key) throw new TypeError('signState needs a user id, a fresh nonce and a signing key');
  return `${userId}.${nonce}.${await hmacSign(`${userId}.${nonce}`, key)}`;
}

export async function verifyState(state, key) {
  if (!state || !key) return { ok: false, reason: 'missing' };
  const parts = String(state).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, reason: 'format' };
  const [userId, nonce, signature] = parts;
  const expected = await hmacSign(`${userId}.${nonce}`, key);
  if (!safeEqual(signature, expected)) return { ok: false, reason: 'signature' };
  return { ok: true, userId, nonce };
}

/* Pending-nonce row checks (used by the callback before consuming):
   the stored pending row must still hold THIS flow's nonce — a missing
   row or a NULL pending_nonce means the flow was never started, was
   superseded by a newer authorize, or was already consumed. */
export function pendingMatches(row, nonce) {
  return !!(row && row.pending_nonce && nonce && row.pending_nonce === nonce);
}

/* The stored pending flow must not be expired. A missing or unparseable
   expiry fails closed. `nowMs` is injectable so tests are deterministic. */
export function pendingExpired(pendingExpires, nowMs = Date.now()) {
  if (!pendingExpires) return true;
  const t = new Date(pendingExpires).getTime();
  return !Number.isFinite(t) || t <= nowMs;
}

/* ---------- consent-return banner decision (frontend) ---------- */

/* The '#settings?google=ok' hash is attacker-craftable, so it can never by
   itself claim success. The decision needs the FETCHED integration status:
   'success' only when the status reports connected, 'pending' while the
   status check is still in flight or unavailable, 'inactive' when it
   completed without a connection, 'error' for a genuine failed round-trip
   (google=denied|error&reason=…), null when there is no return to show. */
export function googleReturnBanner(ret, status) {
  if (!ret) return null;
  if (ret.google !== 'ok') return { kind: 'error' };
  if (status && status.connected) return { kind: 'success' };
  if (status && status.loaded && !status.error) return { kind: 'inactive' };
  return { kind: 'pending' };
}

export function b64urlFromBytes(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encoder = new TextEncoder();

export async function hmacSign(message, key) {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlFromBytes(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
}

/* Length-independent string comparison: every character pair is XORed into
   one accumulator, so equality leaks no prefix information. Non-strings or
   differing lengths are simply unequal. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- Gmail metadata → inbox item ---------- */

/* 'From' header value → { name, email }. Handles "Name <a@b.c>", quoted
   names with commas, and bare addresses. Never throws. */
export function parseFromHeader(value) {
  const v = String(value ?? '').trim();
  if (!v) return { name: '', email: '' };
  const lt = v.lastIndexOf('<');
  const gt = v.lastIndexOf('>');
  if (lt !== -1 && gt > lt) {
    const email = v.slice(lt + 1, gt).trim();
    const name = v
      .slice(0, lt)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    return { name, email };
  }
  const hasAddress = v.includes('@');
  return { name: hasAddress ? '' : v, email: hasAddress ? v : '' };
}

/* Gmail messages.get (format=metadata) resource → the flat object the
   inbox list renders. Sparse payloads fall back honestly; nothing throws
   and no field is ever NaN. */
export function mapGmailMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const headers = (m.payload && m.payload.headers) || [];
  const header = name => {
    const h = headers.find(x => x && x.name && x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  const { name, email } = parseFromHeader(header('from'));
  const date = m.internalDate != null ? Number(m.internalDate) : 0;
  return {
    id: m.id || '',
    from: name || email || '(unknown sender)',
    email,
    subject: header('subject') || '(no subject)',
    snippet: m.snippet || '',
    date: Number.isFinite(date) ? date : 0,
    unread: Array.isArray(m.labelIds) ? m.labelIds.includes('UNREAD') : false,
    webLink: m.id ? `https://mail.google.com/mail/u/0/#inbox/${m.id}` : '',
  };
}

/* ---------- inbox merge (workspace notifs + gmail, ONE sorted list) ---------- */

/* Unify workspace notifications and mapped Gmail messages into the single
   newest-first list the Inbox 'All' view renders. Rows are kind-tagged:
     { kind: 'notif', at: <epoch ms>, item: <the original notif> }
     { kind: 'gmail', at: <epoch ms>, item: <the mapped gmail message> }
   Options:
     cat        'all' merges both kinds; 'mention' | 'assign' | 'comment' |
                'update' show notifs of that type only; 'gmail' shows mail
                only — a workspace notif can never leak into the gmail view.
                                Unknown cats yield empty rows (matching pre-merge behavior,
                                where an unknown filter matched nothing); 'all' is the merge.
                    unreadOnly filters read notifs AND read mail together (the Inbox's
                'Unread only' toggle applies across both kinds).
   Missing/unparseable timestamps sort as 0 (never NaN) so one malformed
   row cannot poison the ordering; equal times keep insertion order
   (stable sort). Pure: no DOM, no store, no clock, no throwing. */
export function mergeInbox(notifs, gmsgs, { cat = 'all', unreadOnly = false } = {}) {
  const NOTIF_CATS = ['mention', 'assign', 'comment', 'update'];
  const timeOf = v => {
    const t = Number(v);
    return Number.isFinite(t) ? t : 0;
  };
  const list = v => (Array.isArray(v) ? v : []);
  const rows = [];
  if (cat === 'all' || NOTIF_CATS.includes(cat)) {
    for (const n of list(notifs)) {
      if (!n) continue;
      if (cat !== 'all' && n.type !== cat) continue;
      if (unreadOnly && n.read) continue;
      rows.push({ kind: 'notif', at: timeOf(n.at), item: n });
    }
  }
  if (cat === 'all' || cat === 'gmail') {
    for (const m of list(gmsgs)) {
      if (!m) continue;
      if (unreadOnly && !m.unread) continue;
      rows.push({ kind: 'gmail', at: timeOf(m.date), item: m });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

/* ---------- Google Calendar event helpers ---------- */

/* The day an event sits on in the month grid. All-day events carry a plain
   date; timed events carry an RFC3339 dateTime with the event's own UTC
   offset — bucketing uses that date part so the result is deterministic
   and independent of the machine's timezone. */
export function eventDateKey(ev) {
  const start = (ev && ev.start) || {};
  if (start.date) return String(start.date).slice(0, 10);
  if (start.dateTime) return String(start.dateTime).slice(0, 10);
  return '';
}

/* 'HH:MM' in the event's own offset, or 'All day'. */
export function eventTimeLabel(ev) {
  const start = (ev && ev.start) || {};
  if (start.date) return 'All day';
  if (start.dateTime) return String(start.dateTime).slice(11, 16);
  return '';
}

/* Popover line: '09:30 – 10:30' for timed events (event-local), 'All day'
   for date-only events, '09:30' when the end is missing. */
export function eventTimeRange(ev) {
  if (!ev || !ev.start) return '';
  if (ev.start.date) return 'All day';
  const start = eventTimeLabel(ev);
  if (!start) return '';
  const end = ev.end && ev.end.dateTime ? String(ev.end.dateTime).slice(11, 16) : '';
  return end ? `${start} – ${end}` : start;
}

/* ---------- month grid window ---------- */

/* The exact date window the calendar month grid renders: from the first
   day of the grid (start-of-week before the 1st) to the last rendered
   day, using the same 42-cells-trimmed-to-35 rule as views/calendar.js.
   `month` is 0-indexed (JS convention) and `weekStart` matches prefs.weekStart
   (0 = Sunday, 1 = Monday). Local dates only — no UTC shifting. */
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthWindow(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const diff = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - diff);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const count = cells[35].getMonth() !== month ? 35 : 42;
  return { from: isoDate(start), to: isoDate(cells[count - 1]) };
}

/* Pad a YYYY-MM-DD..YYYY-MM-DD window by one day on each side. The edge
   function converts these to UTC timeMin/timeMax; a ±1 day margin makes
   the UTC window cover every event-local date inside the grid, whatever
   the event's offset (+13:00 to -12:00) is. */
function shiftDate(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return isoDate(dt);
}

export function expandDayRange(from, to) {
  if (!from || !to) return { from, to };
  return { from: shiftDate(from, -1), to: shiftDate(to, 1) };
}
