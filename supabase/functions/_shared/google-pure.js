/* =====================================================================
   GOOGLE INTEGRATION · shared pure logic (ONE source, three runtimes)
   Plain ES module with zero imports: the SAME file is imported by
     - the Deno edge functions (supabase/functions/google-auth + google-data),
     - the Vite frontend (src/core/google.js, src/views/calendar.js),
     - node --test (test/google-data.test.js).
   Nothing here may touch network, filesystem or runtime globals beyond
   the Web-standard TextEncoder/TextDecoder/btoa/atob/crypto.subtle set,
   which exists in Deno, Node 18+ and browsers alike.
   ===================================================================== */

/* ---------- scopes (FULL access, Operance google-api parity) ---------- */

/* Atrium can READ, SEND and ORGANIZE Gmail and manage primary-calendar
   events — the exact scope set the Operance Workspace's google-api asks
   for: gmail.modify (labels/archive), gmail.send, calendar.readonly,
   calendar.events (insert/update/delete). The scopes constant is the
   single point of truth for the authorize URL and the scopes column
   stored with the token. Upgrading scopes requires the user to click
   Connect again: prompt=consent then issues a fresh refresh token
   covering the new grants (no schema change). */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

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
  const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
  return {
    id: m.id || '',
    from: name || email || '(unknown sender)',
    email,
    subject: header('subject') || '(no subject)',
    snippet: m.snippet || '',
    date: Number.isFinite(date) ? date : 0,
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    labels,
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

/* ---------- external-link allowlist (untrusted hrefs) ---------- */

/* Only these hosts may ever become an <a href> from Google data. The
   mapping functions run EVERY url through safeLink, so an htmlLink or
   webLink that arrives crafted (different scheme, lookalike host, user
   credentials) degrades to '' and the UI renders no link at all. */
export const SAFE_LINK_HOSTS = ['mail.google.com', 'accounts.google.com', 'calendar.google.com'];

export function safeLink(url, hosts = SAFE_LINK_HOSTS) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
  try {
    const u = new URL(url);
    return hosts.includes(u.hostname) && !u.username && !u.password ? url : '';
  } catch {
    return '';
  }
}

/* ---------- base64url → UTF-8 (Gmail body data, attachment data) ---------- */

export function decodeB64url(s) {
  if (typeof s !== 'string' || !s) return '';
  try {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/* ---------- Gmail format=full body-part preference ---------- */

/* Gmail nests MIME parts (multipart/mixed → alternative → …). The body
   text is the FIRST text/plain part carrying inline data; text/html is
   the fallback (flagged so the UI knows to sanitize before rendering).
   Parts with a filename are attachments — never body text. Never throws:
   a sparse payload yields { kind: 'text', body: '' }. */
function collectBody(payload, out) {
  if (!payload || typeof payload !== 'object') return;
  const mt = String(payload.mimeType || '');
  const data = payload.body && typeof payload.body === 'object' ? payload.body.data : null;
  if (data && typeof data === 'string' && !payload.filename) {
    if (!out.plain && mt === 'text/plain') out.plain = decodeB64url(data);
    else if (!out.html && mt === 'text/html') out.html = decodeB64url(data);
  }
  if (Array.isArray(payload.parts)) for (const p of payload.parts) collectBody(p, out);
}

export function parseGmailBody(payload) {
  const out = { plain: '', html: '' };
  collectBody(payload, out);
  if (out.plain) return { kind: 'text', body: out.plain };
  if (out.html) return { kind: 'html', body: out.html };
  return { kind: 'text', body: '' };
}

/* Every attachmentId part, flattened (nested containers included):
   { filename, mimeType, attachmentId, size } — size is a Number, 0 when
   missing. Body parts (no attachmentId) are skipped. */
function collectAttachments(payload, out) {
  if (!payload || typeof payload !== 'object') return;
  const body = payload.body;
  if (body && typeof body === 'object' && body.attachmentId) {
    out.push({
      filename: String(payload.filename || ''),
      mimeType: String(payload.mimeType || ''),
      attachmentId: String(body.attachmentId),
      size: Number(body.size) || 0,
    });
  }
  if (Array.isArray(payload.parts)) for (const p of payload.parts) collectAttachments(p, out);
}

export function parseAttachments(payload) {
  const out = [];
  collectAttachments(payload, out);
  return out;
}

/* ---------- deep message mapping (format=full) ---------- */

/* Gmail messages.get (format=full) → the object the message view renders:
   headers for reply threading, the preferred body, the attachment list
   and a webLink that is safe by construction (host allowlisted, id
   restricted to Gmail's base64url alphabet). Never throws. */
export function mapGmailFull(m) {
  if (!m || typeof m !== 'object') return null;
  const headers = (m.payload && m.payload.headers) || [];
  const header = name => {
    const h = headers.find(x => x && x.name && x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  const { name, email } = parseFromHeader(header('from'));
  const date = m.internalDate != null ? Number(m.internalDate) : 0;
  const id = m.id || '';
  return {
    id,
    threadId: m.threadId || '',
    from: name || email || '(unknown sender)',
    email,
    to: header('to'),
    cc: header('cc'),
    replyTo: header('reply-to'),
    subject: header('subject') || '(no subject)',
    messageId: header('message-id'),
    inReplyTo: header('in-reply-to'),
    references: header('references'),
    date: Number.isFinite(date) ? date : 0,
    unread: Array.isArray(m.labelIds) ? m.labelIds.includes('UNREAD') : false,
    labels: Array.isArray(m.labelIds) ? m.labelIds : [],
    snippet: m.snippet || '',
    body: parseGmailBody(m.payload),
    attachments: parseAttachments(m.payload),
    webLink: id && /^[A-Za-z0-9_-]+$/.test(id) ? safeLink(`https://mail.google.com/mail/u/0/#inbox/${id}`) : '',
  };
}

/* threads.get (format=full) → messages grouped chronologically (oldest →
   newest, stable on equal timestamps). Junk entries are dropped. */
export function mapThread(t) {
  if (!t || typeof t !== 'object') return { id: '', messages: [] };
  const msgs = (Array.isArray(t.messages) ? t.messages : [])
    .map(mapGmailFull)
    .filter(Boolean)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.date - b.m.date || a.i - b.i)
    .map(x => x.m);
  return { id: t.id || '', messages: msgs };
}

/* ---------- RFC 5322 MIME builder (send/reply) ---------- */

/* Header values come from user input (compose form), so CR/LF (and any
   other control character) is collapsed to a single space BEFORE the
   value is written — a Subject of "Hi\r\nBcc: attacker@evil" can never
   smuggle a second header into the raw MIME. Header order is fixed:
   To, Cc, Subject, In-Reply-To, References, then the MIME headers. */
function mimeHeader(v) {
  return (
    String(v ?? '')
      // eslint-disable-next-line no-control-regex -- control chars ARE the injection payload
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
  );
}

export function buildMime(msg = {}) {
  const lines = [`To: ${mimeHeader(msg.to)}`];
  if (msg.cc) lines.push(`Cc: ${mimeHeader(msg.cc)}`);
  lines.push(`Subject: ${mimeHeader(msg.subject)}`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${mimeHeader(msg.inReplyTo)}`);
  if (msg.references) lines.push(`References: ${mimeHeader(msg.references)}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit');
  return b64urlFromBytes(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n' + String(msg.body ?? '')));
}

/* Compose request body → normalized header fields, with the send
   endpoint's cap contract: `to` is required and capped at 1000, the
   optional `cc` line is capped at 1000 too (it lands in a header exactly
   like `to`), subject ≤ 998 and body ≤ 200k. Returns { error } carrying
   the code the endpoint answers 400 with, or the normalized fields. */
export function parseCompose(body) {
  const to = typeof body?.to === 'string' ? body.to.trim() : '';
  const text = typeof body?.body === 'string' ? body.body : '';
  const subject = typeof body?.subject === 'string' ? body.subject : '';
  const cc = typeof body?.cc === 'string' ? body.cc : '';
  if (!to || to.length > 1000) return { error: 'invalid_recipient' };
  if (text.length > 200_000) return { error: 'body_too_long' };
  if (subject.length > 998) return { error: 'subject_too_long' };
  if (cc.length > 1000) return { error: 'invalid_recipient' };
  return { to, cc, subject, text };
}

/* ---------- calendar event resource builder (insert/update) ---------- */

/* Bare-address charset: RFC 5322 atom characters only, compared
   lowercase. Angle brackets, quotes, commas, semicolons, colons and
   whitespace never validate — a display-form entry can only survive by
   being reduced to its bare address first (normalizeAttendeeEmails). */
const EVENT_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/* Attendee entries arrive as the user typed them: bare addresses
   (a@b.co) or display form ("Name <a@b.co>"). A wrapped entry contributes
   only the address between the angle brackets; anything that does not
   reduce to a valid bare address is dropped (invalid entries never reach
   Google). Deduped, lowercased, capped at `max`. */
export function normalizeAttendeeEmails(raw, max = 50) {
  const emails = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    let s = eventText(a, 254);
    const wrapped = s.match(/<([^<>]*)>/);
    if (wrapped) s = wrapped[1];
    const email = s.trim().toLowerCase();
    if (EVENT_EMAIL_RE.test(email) && !emails.includes(email)) emails.push(email);
    if (emails.length >= max) break;
  }
  return emails;
}

function eventText(v, max) {
  return (
    String(v ?? '')
      // eslint-disable-next-line no-control-regex -- control chars ARE the injection payload
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
const rfc3339Re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/* User form → Google events resource. Validates shapes strictly (title
   required, start/end present and of the SAME kind — date-only for
   all-day, RFC3339 dateTime for timed), normalizes attendees to
   { email } objects (deduped, ≤50) and caps hostile sizes. Invalid
   input returns null so the caller answers 400 instead of forwarding a
   partial resource to Google. */
export function buildEventResource(input) {
  if (!input || typeof input !== 'object') return null;
  const title = eventText(input.title, 500);
  if (!title) return null;
  const s = input.start && typeof input.start === 'object' ? input.start : null;
  if (!s) return null;
  let start = null;
  if (typeof s.date === 'string' && isoDateRe.test(s.date)) start = { date: s.date };
  else if (typeof s.dateTime === 'string' && s.dateTime.length <= 40 && rfc3339Re.test(s.dateTime)) start = { dateTime: s.dateTime };
  if (!start) return null;
  const e = input.end && typeof input.end === 'object' ? input.end : null;
  let end = null;
  if (e) {
    if (start.date && typeof e.date === 'string' && isoDateRe.test(e.date)) end = { date: e.date };
    else if (start.dateTime && typeof e.dateTime === 'string' && e.dateTime.length <= 40 && rfc3339Re.test(e.dateTime)) end = { dateTime: e.dateTime };
  }
  if (!end) return null;
  const res = { summary: title, start, end };
  const location = eventText(input.location, 500);
  if (location) res.location = location;
  const description = eventText(input.description, 8000);
  if (description) res.description = description;
  const emails = normalizeAttendeeEmails(input.attendees);
  if (emails.length) res.attendees = emails.map(email => ({ email }));
  return res;
}

/* ---------- gmail search query + numeric clamps (untrusted params) ---------- */

/* A search query reaches Google inside our API URL — control characters
   are collapsed to spaces and the query is clamped to 200 chars before
   it is forwarded as a q parameter. Non-strings become ''. */
export function validGmailQuery(q) {
  if (typeof q !== 'string') return '';
  const stripped = q.replace(/[\u0000-\u001f\u007f]+/g, ' '); // eslint-disable-line no-control-regex -- control chars ARE the injection payload
  return stripped.trim().slice(0, 200);
}

export function clampNum(v, { min, max, fallback }) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* Endpoint failure body → the honest user-facing message. Keeps the
   error code the edge function chose and appends Google's own detail
   verbatim when googleError surfaced one (capped to 300 chars there) —
   "show Google's message" only works if the detail survives the throw. */
export function errorFromEndpoint(out, status) {
  const base = out && typeof out.error === 'string' && out.error ? out.error : status ? `Request failed (${status})` : 'Request failed';
  const detail = out && typeof out.detail === 'string' ? out.detail.trim() : '';
  return detail ? `${base}: ${detail}` : base;
}

/* ---------- Gmail depth: drafts, labels, bulk (shared pure logic) ---------- */

/* Gmail drafts.get resource → the compose-prefill shape. Works for BOTH
   the list fetch (format=metadata: no body data → an empty text body) and
   the open fetch (format=full: the preferred body is parsed exactly like
   mapGmailFull does). Never throws; a draft without an id is dropped. */
export function mapGmailDraft(d) {
  if (!d || typeof d !== 'object' || !d.id) return null;
  const m = d.message && typeof d.message === 'object' ? d.message : {};
  const headers = (m.payload && m.payload.headers) || [];
  const header = name => {
    const h = headers.find(x => x && x.name && x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  const date = m.internalDate != null ? Number(m.internalDate) : 0;
  return {
    id: d.id,
    messageId: m.id || '',
    threadId: m.threadId || '',
    to: header('to'),
    cc: header('cc'),
    subject: header('subject') || '(no subject)',
    snippet: m.snippet || '',
    date: Number.isFinite(date) ? date : 0,
    body: parseGmailBody(m.payload),
  };
}

/* Draft compose body → normalized fields. A DRAFT may have no recipients
   yet (unlike send, where `to` is required), so every field is optional —
   but the caps carry over exactly (to/cc ≤ 1000, subject ≤ 998, body ≤
   200k): oversized drafts are rejected, never forwarded to Google. */
export function parseDraftCompose(body) {
  const to = typeof body?.to === 'string' ? body.to.trim() : '';
  const cc = typeof body?.cc === 'string' ? body.cc : '';
  const subject = typeof body?.subject === 'string' ? body.subject : '';
  const text = typeof body?.body === 'string' ? body.body : '';
  if (to.length > 1000 || cc.length > 1000) return { error: 'invalid_recipient' };
  if (subject.length > 998) return { error: 'subject_too_long' };
  if (text.length > 200_000) return { error: 'body_too_long' };
  return { to, cc, subject, text };
}

/* labels.list/get resource → { id, name, type }. A missing type field is
   treated as 'system' (fail closed: system labels can never be deleted). */
export function mapGmailLabel(l) {
  if (!l || typeof l !== 'object' || !l.id) return null;
  return {
    id: l.id,
    name: typeof l.name === 'string' && l.name ? l.name : l.id,
    type: l.type === 'user' ? 'user' : 'system',
  };
}

/* System label ids (the fixed set + the two dynamic prefixes: category
   tabs and group labels). User label ids look like "Label_<hex>" — never
   system. Gmail's delete endpoint must refuse system ids; this check is
   the cheap static half (the labels.get type check is the honest half). */
const SYSTEM_LABEL_IDS = new Set([
  'INBOX',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'TRASH',
  'SPAM',
  'MUTE',
  'BINALERT_PHISHING',
  'ARCHIVED',
  'FORUM',
  'SOCIAL',
  'PROMOTIONS',
  'UPDATES',
  'PERSONAL',
]);

export function isSystemLabelId(id) {
  if (typeof id !== 'string' || !id) return false;
  return SYSTEM_LABEL_IDS.has(id) || id.startsWith('CATEGORY_') || id.startsWith('GOOGR');
}

/* A user-typed label name: control characters (header-injection payloads)
   collapse to spaces, edges trim, hard cap at 100 chars. Empty → '' (the
   caller answers 400). */
export function validLabelName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // eslint-disable-line no-control-regex -- control chars ARE the injection payload
    .trim()
    .slice(0, 100);
}

/* Gmail resource ids (messages, threads, labels) are base64url opaque
   tokens. Keep only strings from that alphabet, deduped, capped at `max`
   (batch calls go out with at most 50 ids; label lists with at most 10).
   Non-strings / malformed ids never reach a Google URL. */
export function validIdList(raw, max = 50) {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v) && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/* Bulk-modify payload for messages.batchModify. `unread: true|false` maps
   to UNREAD add/remove, `archive: true` removes INBOX; explicit
   addLabelIds/removeLabelIds (≤10, valid ids only) carry the label and
   star operations. Errors instead of partial payloads: no ids → 'no_ids',
   an empty operation set → 'nothing_to_do'. */
export function buildBatchModify(ids, ops = {}) {
  const list = validIdList(ids, 50);
  if (!list.length) return { error: 'no_ids' };
  const add = validIdList(ops.addLabelIds, 10);
  const remove = validIdList(ops.removeLabelIds, 10);
  if (ops.unread === true && !add.includes('UNREAD')) add.unshift('UNREAD');
  if (ops.unread === false && !remove.includes('UNREAD')) remove.unshift('UNREAD');
  if (ops.archive === true && !remove.includes('INBOX')) remove.unshift('INBOX');
  if (!add.length && !remove.length) return { error: 'nothing_to_do' };
  return { ids: list, addLabelIds: add, removeLabelIds: remove };
}

/* Bulk delete payload for messages.batchDelete (IRREVERSIBLE — no server
   undo exists; the UI confirms before calling). Same clamp contract. */
export function buildBatchDelete(ids) {
  const list = validIdList(ids, 50);
  if (!list.length) return { error: 'no_ids' };
  return { ids: list };
}

/* Calendar ids are email addresses, Google group ids or the 'primary'
   alias — a different alphabet from Gmail's opaque tokens. Whatever does
   not match never reaches a Google URL. */
export function safeCalId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_.@#-]{1,300}$/.test(s) ? s : '';
}

/* freeBusy request for the enabled calendars over a padded day window
   (the ±1 day margin matches the calendar window so events in any UTC
   offset are covered). `calendarIds` are format-validated, deduped and
   capped at 10; none → ['primary']. Non-ISO dates → null (400). */
export function buildFreebusyRequest(input = {}) {
  const from = typeof input.from === 'string' ? input.from : '';
  const to = typeof input.to === 'string' ? input.to : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const pad = expandDayRange(from, to);
  const ids = [];
  for (const v of Array.isArray(input.calendarIds) ? input.calendarIds : []) {
    const id = safeCalId(v);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= 10) break;
  }
  if (!ids.length) ids.push('primary');
  return { timeMin: `${pad.from}T00:00:00Z`, timeMax: `${pad.to}T23:59:59Z`, items: ids.map(id => ({ id })) };
}

/* Busy intervals as { s, e } epoch ms. Sorted, then overlapping or
   TOUCHING runs merged (a 09–10 and a 10–11 block are one 09–11 busy
   stretch for the strip). Zero-length and junk entries dropped. */
export function mergeBusyIntervals(intervals) {
  const list = (Array.isArray(intervals) ? intervals : [])
    .map(v => (v && Number.isFinite(v.s) && Number.isFinite(v.e) && v.e > v.s ? { s: v.s, e: v.e } : null))
    .filter(Boolean)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) {
      if (iv.e > last.e) last.e = iv.e;
    } else out.push({ s: iv.s, e: iv.e });
  }
  return out;
}

/* Google freeBusy response → { busy, perCalendar }: the merged busy set
   across every requested calendar (what the strip renders) plus the
   per-calendar breakdown. Invalid timestamps are dropped, never NaN. */
export function mapFreebusy(body) {
  const perCalendar = {};
  const all = [];
  const cals = body && typeof body === 'object' && body.calendars && typeof body.calendars === 'object' ? body.calendars : {};
  for (const [id, c] of Object.entries(cals)) {
    const busy = (c && Array.isArray(c.busy) ? c.busy : [])
      .map(b => {
        const s = Date.parse(b && b.start);
        const e = Date.parse(b && b.end);
        return Number.isFinite(s) && Number.isFinite(e) && e > s ? { s, e } : null;
      })
      .filter(Boolean);
    perCalendar[id] = busy;
    all.push(...busy);
  }
  return { busy: mergeBusyIntervals(all), perCalendar };
}

/* Busy blocks on ONE day window [startMs, endMs): intervals overlapping
   the window are clipped to it, fully-outside ones dropped. The strip
   positions these against the day's local 00:00–24:00. */
export function busyOnDay(intervals, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  return mergeBusyIntervals(intervals)
    .filter(iv => iv.e > startMs && iv.s < endMs)
    .map(iv => ({ s: Math.max(iv.s, startMs), e: Math.min(iv.e, endMs) }));
}

/* ---------- multiple calendars: calendarList + enabled set ---------- */

/* calendarList.list items → the fields the surfaces need (id, name,
   colors, primary flag, access role). Junk entries dropped; a missing
   summary falls back to the id. */
export function mapCalendarList(items) {
  return (Array.isArray(items) ? items : [])
    .filter(c => c && typeof c === 'object' && typeof c.id === 'string' && c.id)
    .map(c => ({
      id: c.id,
      summary: typeof c.summary === 'string' && c.summary ? c.summary : c.id,
      colorId: typeof c.colorId === 'string' ? c.colorId : '',
      backgroundColor: typeof c.backgroundColor === 'string' ? c.backgroundColor : '',
      primary: c.primary === true,
      accessRole: typeof c.accessRole === 'string' ? c.accessRole : '',
    }));
}

/* The enabled set actually fetched: stored ids kept in order, unknown
   ids dropped (a deleted calendar must not break the window fetch),
   'primary' resolved to the real primary entry for color attribution.
   Nothing valid → ['primary'] (Google's alias, always accepted). */
export function resolveEnabledCalendars(ids, calendars) {
  const list = Array.isArray(calendars) ? calendars : [];
  const byId = new Set(list.map(c => c.id));
  const out = [];
  for (const v of Array.isArray(ids) ? ids : []) {
    if (typeof v !== 'string' || !v) continue;
    let id = v;
    if (v === 'primary') {
      const p = list.find(c => c.primary);
      if (!p) continue;
      id = p.id;
    }
    if (byId.has(id) && !out.includes(id)) out.push(id);
  }
  if (!out.length) out.push('primary');
  return out;
}

/* Event create/update/delete target: an EMPTY calendarId defaults to
   primary; 'primary' resolves through the list; anything else must be a
   member of the user's calendarList AND writable (owner/writer). Errors
   answer before a single byte reaches Google: unknown_calendar,
   invalid_calendar, calendar_read_only. No list context (fetch failed):
   only the 'primary' alias is allowed. */
const CAL_WRITE_ROLES = ['owner', 'writer'];

export function eventCalendarTarget(rawId, calendars) {
  const list = Array.isArray(calendars) ? calendars : [];
  const id = rawId == null || rawId === '' ? 'primary' : String(rawId);
  if (id === 'primary') {
    const p = list.find(c => c.primary);
    if (!p) return { id: 'primary' };
    return CAL_WRITE_ROLES.includes(p.accessRole) ? { id: p.id, summary: p.summary } : { error: 'calendar_read_only' };
  }
  if (!safeCalId(id)) return { error: 'invalid_calendar' };
  const c = list.find(x => x.id === id);
  if (!c) return { error: 'unknown_calendar' };
  if (!CAL_WRITE_ROLES.includes(c.accessRole)) return { error: 'calendar_read_only' };
  return { id, summary: c.summary };
}

/* Per-calendar event lists → ONE array sorted by event-local start.
   All-day events (plain date) sort before timed events on the same day
   ('2026-10-31' < '2026-10-31T09:00…' lexicographically), matching the
   grid's day-first convention. Stable on equal starts. */
function eventStartKey(e) {
  const s = (e && e.start) || {};
  return String(s.dateTime || s.date || '');
}

export function mergeCalendarEvents(lists) {
  const out = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    for (const e of Array.isArray(l) ? l : []) if (e && typeof e === 'object') out.push(e);
  }
  return out.sort((a, b) => {
    const ka = eventStartKey(a);
    const kb = eventStartKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/* ---------- prefs.calendarIds initializer (zero-loss) ---------- */

/* The workspace document predating multi-calendar support has no
   prefs.calendarIds. This initializer runs on EVERY ingest path (trusted
   cache, bootstrap, hydrate) and ONLY fills the missing key: a valid
   array is kept by reference, corrupt values reset to ['primary'],
   everything else untouched. Idempotent — the ensureCrmData pattern. */
export function ensureGooglePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return prefs;
  const ok = Array.isArray(prefs.calendarIds) && prefs.calendarIds.every(id => typeof id === 'string' && id.length > 0);
  if (!ok) prefs.calendarIds = ['primary'];
  return prefs;
}

/* ---------- scope display helper ---------- */

/* Full scope URLs → short names for the Settings surface. Entries that
   are not under Google's auth prefix are dropped (honest display only
   ever names grants we asked Google for). Accepts the space-joined
   string the scopes column stores or an array. */
export function scopeShortNames(scopes) {
  const list = Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? scopes.split(' ') : [];
  return list
    .filter(Boolean)
    .map(s => String(s).replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))
    .filter(s => s && !s.includes('/'));
}
