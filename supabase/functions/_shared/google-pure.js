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

/* ---------- base64url + HMAC-SHA256 state signing ---------- */

/* CSRF state for the OAuth round-trip: "<user id>.<base64url(HMAC-SHA256(user id, secret))>".
   The callback re-computes the signature from the user id and compares in
   constant time; a forged or replayed state fails the check. The secret is
   the service-role key, which never leaves the server. */

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

export async function signState(userId, key) {
  if (!userId || !key) throw new TypeError('signState needs a user id and a signing key');
  return `${userId}.${await hmacSign(userId, key)}`;
}

export async function verifyState(state, key) {
  if (!state || !key) return { ok: false, reason: 'missing' };
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: 'format' };
  const userId = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = await hmacSign(userId, key);
  if (!safeEqual(signature, expected)) return { ok: false, reason: 'signature' };
  return { ok: true, userId };
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
