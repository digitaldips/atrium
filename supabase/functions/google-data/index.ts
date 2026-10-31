// =====================================================================
// google-data — Gmail + Google Calendar for Atrium (FULL client)
// Every route validates the caller's Supabase JWT, resolves the stored
// refresh token and exchanges it for a fresh access token (per request;
// nothing cached). invalid_grant (revoked/expired grant) → { connected:
// false } so the UI falls back to its connect prompt.
//
// READS  GET  gmail?max=                       INBOX list (metadata batch)
//        GET  gmail/message?id=                one message, format=full
//                                              (preferred body + attachments)
//        GET  gmail/thread?id=                 thread, oldest → newest
//        GET  gmail/search?q=&max=&pageToken=  q passthrough, paged
//        GET  gmail/attachment?id=&attachmentId=  base64 attachment data
//        GET  calendar?from=&to=               primary calendar window
// WRITES POST gmail/send                       RFC 5322 raw MIME (To/Cc/
//                                              Subject/In-Reply-To/References),
//                                              threadId passthrough
//        POST gmail/modify?id=                 { unread } ± { archive } via
//                                              UNREAD / INBOX labels
//        POST gmail/trash?id=   gmail/untrash?id=
//        POST calendar/event                   insert (sendUpdates=all)
//        PATCH calendar/event/update?id=       update (sendUpdates=all)
//        DELETE calendar/event/delete?id=      delete (sendUpdates=all)
//
// Untrusted input is sanitized before it reaches Google URLs: ids are
// restricted to Gmail's base64url alphabet, the search query is clamped
// and control-char-stripped, max/pageToken are clamped, and MIME header
// values are CR/LF-stripped in buildMime. Event payloads are validated
// in buildEventResource — invalid input answers 400, never a partial
// resource forwarded to Google.
// =====================================================================
import {
  buildEventResource,
  buildMime,
  clampNum,
  expandDayRange,
  mapGmailFull,
  mapGmailMessage,
  mapThread,
  monthWindow,
  validGmailQuery,
} from '../_shared/google-pure.js';
import { SUPABASE_URL, action, corsHeaders, json, unauthorized, getAuthUser, getIntegration, refreshAccessToken } from '../_shared/edge.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/* Gmail/Calendar resource ids are base64url opaque tokens. Anything
   outside this alphabet never reaches a Google URL. */
function safeId(s: string): string {
  return /^[A-Za-z0-9_-]{1,256}$/.test(s) ? s : '';
}

function authedGet(url: string, accessToken: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/* metadata batch: From/Subject headers + snippet, internalDate, labelIds
   — the shape the Inbox list (list AND search results) renders. */
async function fetchGmailBatch(accessToken: string, ids: string[]): Promise<unknown[]> {
  const metas = await Promise.all(
    ids.map(id =>
      authedGet(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, accessToken).then(r =>
        r.ok ? r.json() : null,
      ),
    ),
  );
  return metas.map(meta => mapGmailMessage(meta)).filter(Boolean);
}

async function listGmail(accessToken: string, params: URLSearchParams): Promise<{ res?: Response; ids: string[]; nextPageToken: string }> {
  const list = await authedGet(`${GMAIL_API}/messages?${params}`, accessToken);
  if (!list.ok) return { res: list, ids: [], nextPageToken: '' };
  const body = await list.json().catch(() => ({ messages: [] }) as { messages?: Array<{ id: string }>; nextPageToken?: string });
  const ids = (body.messages || []).map(m => safeId(m.id)).filter(Boolean);
  return { ids, nextPageToken: typeof body.nextPageToken === 'string' && body.nextPageToken.length <= 512 ? body.nextPageToken : '' };
}

async function fetchCalendar(accessToken: string, from: string, to: string): Promise<Response> {
  const pad = expandDayRange(from, to);
  const params = new URLSearchParams({
    timeMin: `${pad.from}T00:00:00Z`,
    timeMax: `${pad.to}T23:59:59Z`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const res = await authedGet(`${CAL_API}?${params}`, accessToken);
  if (!res.ok) return res;
  const body = await res.json().catch(() => ({ items: [] }));
  const events = ((body.items as unknown[]) || []).map((e: Record<string, unknown>) => ({
    id: typeof e.id === 'string' ? e.id : '',
    summary: typeof e.summary === 'string' ? e.summary : '',
    start: e.start || {},
    end: e.end || {},
    location: typeof e.location === 'string' ? e.location : '',
    description: typeof e.description === 'string' ? e.description : '',
    attendees: Array.isArray(e.attendees)
      ? (e.attendees as Array<{ email?: string }>).map(a => (a && typeof a.email === 'string' ? a.email : '')).filter(Boolean)
      : [],
    htmlLink: typeof e.htmlLink === 'string' ? e.htmlLink : '',
  }));
  return new Response(JSON.stringify(events), { headers: { 'Content-Type': 'application/json' } });
}

/* Common shape: resolve the caller → stored refresh token → access token.
   Returns a Response to send as-is, or { accessToken } to continue. */
async function withAccessToken(req: Request): Promise<Response | { accessToken: string }> {
  const user = await getAuthUser(req);
  if (!user) return unauthorized(req);
  const row = await getIntegration(user.id);
  if (!row || !row.google_refresh_token) return json(req, { connected: false });
  const t = await refreshAccessToken(row.google_refresh_token);
  if (t.invalidGrant) return json(req, { connected: false, reason: 'invalid_grant' });
  if (!t.accessToken) return json(req, { error: 'token_exchange_failed', status: t.status }, 502);
  return { accessToken: t.accessToken };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* Google error → honest 502 carrying Google's own message (the UI shows
   it verbatim in compose/event forms). */
async function googleError(req: Request, res: Response): Promise<Response> {
  let detail = '';
  try {
    const j = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: { message?: unknown } }).error === 'object') {
      const msg = (j as { error: { message?: unknown } }).error.message;
      if (typeof msg === 'string') detail = msg.slice(0, 300);
    }
  } catch {
    /* body was not JSON — detail stays empty */
  }
  return json(req, { error: 'google_error', status: res.status, detail }, 502);
}

const ATTACHMENT_MAX = 10 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

  const act = action(req, 'google-data');
  const p = new URL(req.url).searchParams;
  try {
    switch (act) {
      /* ---------- inbox list (INBOX, metadata) ---------- */
      case 'gmail': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const max = clampNum(p.get('max'), { min: 1, max: 50, fallback: 20 });
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const { res, ids } = await listGmail(auth.accessToken, new URLSearchParams({ labelIds: 'INBOX', maxResults: String(max) }));
        if (res) return googleError(req, res);
        return json(req, { connected: true, messages: await fetchGmailBatch(auth.accessToken, ids) });
      }

      /* ---------- one message, full ---------- */
      case 'gmail/message': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        /* Auth FIRST: an unauthenticated caller gets 401 before any
           validation, so endpoints never behave differently for attackers. */
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const res = await authedGet(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, auth.accessToken);
        if (!res.ok) return googleError(req, res);
        const full = await res.json();
        return json(req, { connected: true, message: mapGmailFull(full) });
      }

      /* ---------- one thread, oldest → newest ---------- */
      case 'gmail/thread': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const res = await authedGet(`${GMAIL_API}/threads/${encodeURIComponent(id)}?format=full`, auth.accessToken);
        if (!res.ok) return googleError(req, res);
        const full = await res.json();
        return json(req, { connected: true, thread: mapThread(full) });
      }

      /* ---------- search (q passthrough, paged) ---------- */
      case 'gmail/search': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const q = validGmailQuery(p.get('q') || '');
        if (!q) return json(req, { error: 'invalid_query' }, 400);
        const max = clampNum(p.get('max'), { min: 1, max: 50, fallback: 25 });
        const pageToken = safeId(p.get('pageToken') || '');
        const params = new URLSearchParams({ q, maxResults: String(max) });
        if (pageToken) params.set('pageToken', pageToken);
        const { res, ids, nextPageToken } = await listGmail(auth.accessToken, params);
        if (res) return googleError(req, res);
        return json(req, { connected: true, messages: await fetchGmailBatch(auth.accessToken, ids), nextPageToken });
      }

      /* ---------- attachment data (base64 → blob client-side) ---------- */
      case 'gmail/attachment': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        const attachmentId = safeId(p.get('attachmentId') || '');
        if (!id || !attachmentId) return json(req, { error: 'invalid_id' }, 400);
        const res = await authedGet(`${GMAIL_API}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, auth.accessToken);
        if (!res.ok) return googleError(req, res);
        const full = (await res.json().catch(() => null)) as { data?: unknown; size?: unknown } | null;
        const size = Number(full?.size) || 0;
        if (size > ATTACHMENT_MAX) return json(req, { error: 'attachment_too_large', size }, 413);
        return json(req, { connected: true, data: typeof full?.data === 'string' ? full.data : '', size });
      }

      /* ---------- send (RFC 5322 raw MIME) ---------- */
      case 'gmail/send': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const to = typeof body?.to === 'string' ? body.to.trim() : '';
        const text = typeof body?.body === 'string' ? body.body : '';
        if (!to || to.length > 1000) return json(req, { error: 'invalid_recipient' }, 400);
        if (text.length > 200_000) return json(req, { error: 'body_too_long' }, 400);
        const subject = typeof body?.subject === 'string' ? body.subject : '';
        if (subject.length > 998) return json(req, { error: 'subject_too_long' }, 400);
        const cc = typeof body?.cc === 'string' ? body.cc : '';
        const inReplyTo = typeof body?.inReplyTo === 'string' ? body.inReplyTo.slice(0, 998) : '';
        const references = typeof body?.references === 'string' ? body.references.slice(0, 4000) : '';
        const threadId = typeof body?.threadId === 'string' ? safeId(body.threadId) : '';
        const raw = buildMime({ to, cc, subject, body: text, inReplyTo, references });
        const sendBody: Record<string, string> = { raw };
        if (threadId) sendBody.threadId = threadId;
        const res = await fetch(`${GMAIL_API}/messages/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(sendBody),
        });
        if (!res.ok) return googleError(req, res);
        const sent = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
        return json(req, {
          connected: true,
          id: typeof sent.id === 'string' ? sent.id : '',
          threadId: typeof sent.threadId === 'string' ? sent.threadId : threadId,
        });
      }

      /* ---------- modify labels (read/unread, archive) ---------- */
      case 'gmail/modify': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const body = await readJson(req);
        const addLabelIds: string[] = [];
        const removeLabelIds: string[] = [];
        if (body && 'unread' in body) {
          (body.unread ? addLabelIds : removeLabelIds).push('UNREAD');
        }
        if (body?.archive === true) removeLabelIds.push('INBOX');
        if (!addLabelIds.length && !removeLabelIds.length) return json(req, { error: 'nothing_to_do' }, 400);
        const res = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/modify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ addLabelIds, removeLabelIds }),
        });
        if (!res.ok) return googleError(req, res);
        const mod = (await res.json().catch(() => ({}))) as { id?: string };
        return json(req, { connected: true, id: typeof mod.id === 'string' ? mod.id : id });
      }

      /* ---------- trash / untrash ---------- */
      case 'gmail/trash':
      case 'gmail/untrash': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const verb = act === 'gmail/trash' ? 'trash' : 'untrash';
        const res = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/${verb}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        });
        if (!res.ok) return googleError(req, res);
        return json(req, { connected: true, id });
      }

      /* ---------- calendar window (existing contract) ---------- */
      case 'calendar': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        let from = p.get('from') || '';
        let to = p.get('to') || '';
        if (!isIsoDate(from) || !isIsoDate(to)) {
          // Honest default when the client sends no usable window: this month's grid.
          const now = new Date();
          const w = monthWindow(now.getFullYear(), now.getMonth(), 1);
          from = w.from;
          to = w.to;
        }
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const res = await fetchCalendar(auth.accessToken, from, to);
        if (!res.ok) return googleError(req, res);
        return json(req, { connected: true, events: await res.json() });
      }

      /* ---------- event insert ---------- */
      case 'calendar/event': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const resource = buildEventResource(await readJson(req));
        if (!resource) return json(req, { error: 'invalid_event' }, 400);
        const res = await fetch(`${CAL_API}?sendUpdates=all`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(resource),
        });
        if (!res.ok) return googleError(req, res);
        const ev = (await res.json().catch(() => ({}))) as { id?: string; summary?: string; start?: unknown; end?: unknown };
        return json(req, { connected: true, event: { id: ev.id || '', summary: ev.summary || '', start: ev.start, end: ev.end } });
      }

      /* ---------- event update ---------- */
      case 'calendar/event/update': {
        if (req.method !== 'PATCH') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const resource = buildEventResource(await readJson(req));
        if (!resource) return json(req, { error: 'invalid_event' }, 400);
        const res = await fetch(`${CAL_API}/${encodeURIComponent(id)}?sendUpdates=all`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(resource),
        });
        if (!res.ok) return googleError(req, res);
        const ev = (await res.json().catch(() => ({}))) as { id?: string; summary?: string; start?: unknown; end?: unknown };
        return json(req, { connected: true, event: { id: ev.id || '', summary: ev.summary || '', start: ev.start, end: ev.end } });
      }

      /* ---------- event delete ---------- */
      case 'calendar/event/delete': {
        if (req.method !== 'DELETE') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const res = await fetch(`${CAL_API}/${encodeURIComponent(id)}?sendUpdates=all`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        });
        if (!res.ok && res.status !== 410) return googleError(req, res);
        return json(req, { connected: true, deleted: true });
      }

      default:
        return json(
          req,
          {
            error: 'not_found',
            hint: 'gmail | gmail/message | gmail/thread | gmail/search | gmail/attachment | gmail/send | gmail/modify | gmail/trash | gmail/untrash | calendar | calendar/event | calendar/event/update | calendar/event/delete',
          },
          404,
        );
    }
  } catch (err) {
    console.error('google-data error:', err instanceof Error ? err.message : err);
    return json(req, { error: 'internal' }, 500);
  }
});
