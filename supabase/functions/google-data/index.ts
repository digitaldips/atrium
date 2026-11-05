// =====================================================================
// google-data — Gmail + Google Calendar for Atrium (FULL client)
// Every route validates the caller's Supabase JWT, resolves the stored
// refresh token and exchanges it for a fresh access token (per request;
// nothing cached). invalid_grant (revoked/expired grant) → { connected:
// false } so the UI falls back to its connect prompt.
//
// READS  GET  gmail?max=&label=                INBOX list (metadata batch;
//                                              label=<labelId> filters
//                                              server-side: STARRED, labels)
//        GET  gmail/message?id=                one message, format=full
//                                              (preferred body + attachments)
//        GET  gmail/thread?id=                 thread, oldest → newest
//        GET  gmail/search?q=&max=&pageToken=  q passthrough, paged
//        GET  gmail/attachment?id=&attachmentId=  base64 attachment data
//        GET  gmail/drafts?max=                draft list (metadata batch)
//        GET  gmail/draft?id=                  one draft, format=full
//        GET  gmail/labels                     labels.list (id/name/type)
//        GET  calendar?from=&to=&ids=          events over the ENABLED
//                                              calendar set (validated
//                                              against the calendarList,
//                                              per-calendar color attribution)
//        GET  calendar/list                    calendarList (picker source)
// WRITES POST gmail/send                       RFC 5322 raw MIME (To/Cc/
//                                              Subject/In-Reply-To/References),
//                                              threadId passthrough
//        POST gmail/modify?id=                 { unread } ± { archive } ±
//                                              { addLabelIds, removeLabelIds }
//                                              (UNREAD / INBOX / STARRED / …)
//        POST gmail/trash?id=   gmail/untrash?id=
//        GET  gmail/draft?id=  POST gmail/draft  (create) PATCH gmail/draft?id
//             (update)  POST gmail/draft/send?id  DELETE gmail/draft?id
//        POST gmail/label { name }             create user label
//             DELETE gmail/label?id=           user labels only — system
//                                              labels refused (400)
//        POST gmail/batchModify  gmail/batchDelete  gmail/batchTrash
//                                              (ids clamped ≤ 50)
//        POST calendar/freebusy                busy intervals over the
//                                              enabled calendars
//        POST calendar/event [&calendarId=]    insert (sendUpdates=all)
//        PATCH calendar/event/update?id=&calendarId=   update
//        DELETE calendar/event/delete?id=&calendarId=  delete
//
// Untrusted input is sanitized before it reaches Google URLs: ids are
// restricted to Gmail's base64url alphabet, the search query is clamped
// and control-char-stripped, max/pageToken are clamped, and MIME header
// values are CR/LF-stripped in buildMime. Event payloads are validated
// in buildEventResource — invalid input answers 400, never a partial
// resource forwarded to Google.
// =====================================================================
import {
  buildBatchDelete,
  buildBatchModify,
  buildEventResource,
  buildFreebusyRequest,
  buildMime,
  clampNum,
  eventCalendarTarget,
  expandDayRange,
  isSystemLabelId,
  mapCalendarList,
  mapFreebusy,
  mapGmailDraft,
  mapGmailFull,
  mapGmailMessage,
  mapThread,
  mergeCalendarEvents,
  monthWindow,
  parseCompose,
  parseDraftCompose,
  resolveEnabledCalendars,
  safeCalId,
  validIdList,
  validLabelName,
  validGmailQuery,
} from '../_shared/google-pure.js';
import { SUPABASE_URL, action, corsHeaders, json, unauthorized, getAuthUser, getIntegration, refreshAccessToken } from '../_shared/edge.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';
const CAL_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const CAL_FREEBUSY = 'https://www.googleapis.com/calendar/v3/freeBusy';

/* Gmail/Calendar resource ids are base64url opaque tokens. Anything
   outside this alphabet never reaches a Google URL. */
function safeId(s: string): string {
  return /^[A-Za-z0-9_-]{1,256}$/.test(s) ? s : '';
}

function authedGet(url: string, accessToken: string): Promise<Response> {
  /* 12s cap: a hanging Google call must fail HONESTLY (retryable error) —
     an untimed fetch runs into the isolate wall-clock and dies mid-request. */
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12_000) });
}

/* metadata batch: From/Subject headers + snippet, internalDate, labelIds
   — the shape the Inbox list (list AND search results) renders. */
async function fetchGmailBatch(accessToken: string, ids: string[]): Promise<unknown[]> {
  const metas = await Promise.all(
    ids.map(id =>
      authedGet(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, accessToken)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  );
  /* An empty result must be TRUE: every metadata fetch failing (rate limit,
     quota, outage) must error honestly, not read as an empty inbox. */
  if (ids.length && metas.every(m => !m)) throw new Error('gmail_batch_failed');
  return metas.map(meta => mapGmailMessage(meta)).filter(Boolean);
}

async function listGmail(accessToken: string, params: URLSearchParams): Promise<{ res?: Response; ids: string[]; nextPageToken: string }> {
  const list = await authedGet(`${GMAIL_API}/messages?${params}`, accessToken);
  if (!list.ok) return { res: list, ids: [], nextPageToken: '' };
  const body = await list.json().catch(() => ({ messages: [] }) as { messages?: Array<{ id: string }>; nextPageToken?: string });
  const ids = (body.messages || []).map(m => safeId(m.id)).filter(Boolean);
  return { ids, nextPageToken: typeof body.nextPageToken === 'string' && body.nextPageToken.length <= 512 ? body.nextPageToken : '' };
}

async function fetchDraftBatch(accessToken: string, ids: string[]): Promise<unknown[]> {
  const drafts = await Promise.all(
    ids.map(id =>
      authedGet(
        `${GMAIL_API}/drafts/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Cc`,
        accessToken,
      ).then(r => (r.ok ? r.json() : null)),
    ),
  );
  return drafts.map(d => mapGmailDraft(d)).filter(Boolean);
}

/* The user's calendarList (the ONLY calendars this account can ever
   address). Fetched once per window/event request; a failed list fetch
   degrades to an empty list — only the 'primary' alias stays reachable. */
async function fetchCalendarEntries(
  accessToken: string,
): Promise<Array<{ id: string; summary: string; colorId: string; backgroundColor: string; primary: boolean; accessRole: string }>> {
  const res = await authedGet(`${CAL_LIST}?maxResults=100`, accessToken);
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
  return mapCalendarList(body?.items);
}

/* Calendar window over the ENABLED set: each requested id is validated
   against the calendarList (a calendar the account cannot see is never
   queried), events are fetched per calendar in parallel and merged into
   ONE time-sorted list with per-calendar color attribution
   (calendarId / calendarSummary / colorId / calendarColor).
   F6: one failing calendar no longer sinks the window — its failure is
   returned as a calendarErrors marker ({ calendarId, status }) and the
   successful calendars still render; the frontend names the failure
   (toast / error banner). */
async function fetchCalendarWindow(
  accessToken: string,
  from: string,
  to: string,
  idsParam: string,
): Promise<{ events: unknown[]; calendarErrors: Array<{ calendarId: string; status: number }> }> {
  const pad = expandDayRange(from, to);
  const params = new URLSearchParams({
    timeMin: `${pad.from}T00:00:00Z`,
    timeMax: `${pad.to}T23:59:59Z`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const requested: string[] = [];
  for (const part of idsParam.split(',')) {
    const id = safeCalId(part.trim());
    if (id && !requested.includes(id)) requested.push(id);
    if (requested.length >= 10) break;
  }
  const entries = await fetchCalendarEntries(accessToken);
  const enabled = resolveEnabledCalendars(requested, entries);
  const byId = new Map(entries.map(c => [c.id, c]));
  const perCalendar = await Promise.all(
    enabled.map(async id => {
      const res = await authedGet(`${CAL_BASE}/${encodeURIComponent(id)}/events?${params}`, accessToken);
      if (!res.ok) return { id, res, events: [] as unknown[] };
      const body = (await res.json().catch(() => ({ items: [] }))) as { items?: unknown[] };
      const entry = byId.get(id);
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
        calendarId: id,
        calendarSummary: entry ? entry.summary : '',
        colorId: entry ? entry.colorId : '',
        calendarColor: entry ? entry.backgroundColor : '',
      }));
      return { id, res: null as Response | null, events };
    }),
  );
  const merged = mergeCalendarEvents(perCalendar.map(x => x.events)) as unknown[];
  const failures: Array<{ calendarId: string; status: number }> = [];
  for (const x of perCalendar) {
    if (x.res) failures.push({ calendarId: x.id, status: x.res.status });
  }
  return { events: merged, calendarErrors: failures };
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

/* Event write target: resolve + validate the calendarId (query param,
   body fallback) against the user's calendarList BEFORE anything is sent.
   Returns the calendars/{id} base URL or an error Response. */
async function eventCalendarUrl(req: Request, accessToken: string, rawId: string): Promise<Response | string> {
  const entries = await fetchCalendarEntries(accessToken);
  const target = eventCalendarTarget(rawId, entries);
  if ('error' in target) return json(req, { error: target.error }, target.error === 'calendar_read_only' ? 403 : 400);
  return `${CAL_BASE}/${encodeURIComponent(target.id)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

  const act = action(req, 'google-data');
  const p = new URL(req.url).searchParams;
  try {
    switch (act) {
      /* ---------- inbox / label-filtered list (metadata) ---------- */
      case 'gmail': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const max = clampNum(p.get('max'), { min: 1, max: 50, fallback: 20 });
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        /* label=<labelId> filters server-side (STARRED, a user label, …).
           Unfiltered → the INBOX list, exactly as before. */
        const labelFilter = safeId(p.get('label') || '');
        const t0 = Date.now();
        const { res, ids } = await listGmail(auth.accessToken, new URLSearchParams({ labelIds: labelFilter || 'INBOX', maxResults: String(max) }));
        if (res) {
          console.error(`[gmail] list failed status=${res.status} ms=${Date.now() - t0}`);
          return googleError(req, res);
        }
        const messages = await fetchGmailBatch(auth.accessToken, ids);
        console.error(`[gmail] list ok ids=${ids.length} batch_ok=${messages.length} ms=${Date.now() - t0} label='${labelFilter}'`);
        return json(req, { connected: true, messages, label: labelFilter });
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
        const parsed = parseCompose(body);
        if ('error' in parsed) return json(req, parsed, 400);
        const { to, cc, subject, text } = parsed;
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

      /* ---------- modify labels (read/unread, archive, star, labels) ---------- */
      case 'gmail/modify': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const body = await readJson(req);
        /* Label/star ops ride the same endpoint: addLabelIds/removeLabelIds
           (≤10 valid ids each) merge with the unread/archive shorthand. */
        const addLabelIds = validIdList(body?.addLabelIds, 10);
        const removeLabelIds = validIdList(body?.removeLabelIds, 10);
        if (body && 'unread' in body) {
          (body.unread ? addLabelIds : removeLabelIds).push('UNREAD');
        }
        if (body?.archive === true) removeLabelIds.push('INBOX');
        const dedupe = (a: string[]) => Array.from(new Set(a));
        const add = dedupe(addLabelIds);
        const remove = dedupe(removeLabelIds);
        if (!add.length && !remove.length) return json(req, { error: 'nothing_to_do' }, 400);
        const res = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/modify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
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

      /* ---------- drafts (list / one / create / update / send / delete) ---------- */
      case 'gmail/drafts': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const max = clampNum(p.get('max'), { min: 1, max: 50, fallback: 25 });
        const list = await authedGet(`${GMAIL_API}/drafts?maxResults=${max}`, auth.accessToken);
        if (!list.ok) return googleError(req, list);
        const body = (await list.json().catch(() => ({ drafts: [] }))) as { drafts?: Array<{ id?: unknown }> };
        const ids = ((body.drafts as unknown[]) || [])
          .map(d => (d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? safeId((d as { id: string }).id) : ''))
          .filter(Boolean)
          .slice(0, 50);
        return json(req, { connected: true, drafts: await fetchDraftBatch(auth.accessToken, ids) });
      }

      case 'gmail/draft': {
        if (req.method === 'GET') {
          const auth = await withAccessToken(req);
          if (auth instanceof Response) return auth;
          const id = safeId(p.get('id') || '');
          if (!id) return json(req, { error: 'invalid_id' }, 400);
          const res = await authedGet(`${GMAIL_API}/drafts/${encodeURIComponent(id)}?format=full`, auth.accessToken);
          if (!res.ok) return googleError(req, res);
          const full = await res.json();
          return json(req, { connected: true, draft: mapGmailDraft(full) });
        }
        /* create + update share this action: POST drafts.create, PATCH
           drafts.update. Recipients are OPTIONAL (a draft may be empty),
           but the caps are the send caps — parseDraftCompose rejects
           oversized input before the MIME is built. */
        if (req.method !== 'POST' && req.method !== 'PATCH') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const parsed = parseDraftCompose(body);
        if ('error' in parsed) return json(req, parsed, 400);
        const inReplyTo = typeof body?.inReplyTo === 'string' ? body.inReplyTo.slice(0, 998) : '';
        const references = typeof body?.references === 'string' ? body.references.slice(0, 4000) : '';
        const threadId = typeof body?.threadId === 'string' ? safeId(body.threadId) : '';
        const raw = buildMime({ to: parsed.to, cc: parsed.cc, subject: parsed.subject, body: parsed.text, inReplyTo, references });
        if (req.method === 'PATCH') {
          const id = safeId(p.get('id') || '');
          if (!id) return json(req, { error: 'invalid_id' }, 400);
          const updateMessage: Record<string, string> = { raw };
          if (threadId) updateMessage.threadId = threadId;
          const res = await fetch(`${GMAIL_API}/drafts/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, message: updateMessage }),
          });
          if (!res.ok) return googleError(req, res);
          const draft = (await res.json().catch(() => ({}))) as { id?: string };
          return json(req, { connected: true, draftId: typeof draft.id === 'string' ? draft.id : id });
        }
        const createMessage: Record<string, string> = { raw };
        if (threadId) createMessage.threadId = threadId;
        const res = await fetch(`${GMAIL_API}/drafts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: createMessage }),
        });
        if (!res.ok) return googleError(req, res);
        const draft = (await res.json().catch(() => ({}))) as { id?: string };
        return json(req, { connected: true, draftId: typeof draft.id === 'string' ? draft.id : '' });
      }

      case 'gmail/draft/send': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const res = await fetch(`${GMAIL_API}/drafts/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) return googleError(req, res);
        const sent = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
        return json(req, { connected: true, id: typeof sent.id === 'string' ? sent.id : '', threadId: typeof sent.threadId === 'string' ? sent.threadId : '' });
      }

      case 'gmail/draft/delete': {
        if (req.method !== 'DELETE') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const id = safeId(p.get('id') || '');
        if (!id) return json(req, { error: 'invalid_id' }, 400);
        const res = await fetch(`${GMAIL_API}/drafts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        });
        if (!res.ok && res.status !== 404) return googleError(req, res);
        return json(req, { connected: true, deleted: true });
      }

      /* ---------- labels (list / create / delete) ---------- */
      case 'gmail/labels': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const res = await authedGet(`${GMAIL_API}/labels`, auth.accessToken);
        if (!res.ok) return googleError(req, res);
        const body = (await res.json().catch(() => null)) as { labels?: unknown } | null;
        const labels = ((body?.labels as unknown[]) || []).map(l => mapGmailLabel(l)).filter(Boolean);
        return json(req, { connected: true, labels });
      }

      case 'gmail/label': {
        if (req.method === 'POST') {
          const auth = await withAccessToken(req);
          if (auth instanceof Response) return auth;
          const body = await readJson(req);
          const name = validLabelName(body?.name as unknown);
          if (!name) return json(req, { error: 'invalid_label_name' }, 400);
          const res = await fetch(`${GMAIL_API}/labels`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
          });
          if (!res.ok) return googleError(req, res);
          const label = await res.json();
          return json(req, { connected: true, label: mapGmailLabel(label) });
        }
        if (req.method === 'DELETE') {
          const auth = await withAccessToken(req);
          if (auth instanceof Response) return auth;
          const id = safeId(p.get('id') || '');
          if (!id) return json(req, { error: 'invalid_id' }, 400);
          /* System labels are refused twice: the static alphabet check
             first, then the fetched label's own type. */
          if (isSystemLabelId(id)) return json(req, { error: 'system_label' }, 400);
          const get = await authedGet(`${GMAIL_API}/labels/${encodeURIComponent(id)}`, auth.accessToken);
          if (!get.ok) return googleError(req, get);
          const label = (await get.json().catch(() => null)) as { type?: unknown } | null;
          if (label && label.type === 'system') return json(req, { error: 'system_label' }, 400);
          const res = await fetch(`${GMAIL_API}/labels/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${auth.accessToken}` },
          });
          if (!res.ok) return googleError(req, res);
          return json(req, { connected: true, deleted: true });
        }
        return json(req, { error: 'method_not_allowed' }, 405);
      }

      /* ---------- bulk: batchModify / batchDelete (ids clamped ≤ 50) ---------- */
      case 'gmail/batchModify': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const built = buildBatchModify(body?.ids as unknown, {
          unread: body?.unread as unknown,
          archive: body?.archive as unknown,
          addLabelIds: body?.addLabelIds as unknown,
          removeLabelIds: body?.removeLabelIds as unknown,
        });
        if ('error' in built) return json(req, built, 400);
        const res = await fetch(`${GMAIL_API}/messages/batchModify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: built.ids, addLabelIds: built.addLabelIds, removeLabelIds: built.removeLabelIds }),
        });
        if (!res.ok) return googleError(req, res);
        return json(req, { connected: true, count: built.ids.length });
      }

      case 'gmail/batchDelete': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const built = buildBatchDelete(body?.ids as unknown);
        if ('error' in built) return json(req, built, 400);
        const res = await fetch(`${GMAIL_API}/messages/batchDelete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: built.ids }),
        });
        if (!res.ok) return googleError(req, res);
        return json(req, { connected: true, count: built.ids.length });
      }

      /* ---------- bulk trash: batchModify cannot move to TRASH (Google
         refuses system-state labels on modify), so trash runs as a
         parallel loop of messages.trash — one call per id, clamped ≤ 50. ---------- */
      case 'gmail/batchTrash': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const built = buildBatchDelete(body?.ids as unknown);
        if ('error' in built) return json(req, built, 400);
        const results = await Promise.all(
          built.ids.map(id =>
            fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/trash`, { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}` } }),
          ),
        );
        const failed = results.find(r => !r.ok);
        if (failed) return googleError(req, failed);
        return json(req, { connected: true, count: built.ids.length });
      }

      /* ---------- calendar window (enabled set; default primary) ---------- */
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
        /* F6: the window resolves per calendar — calendarErrors carries
           the failures (partial results still render). */
        const win = await fetchCalendarWindow(auth.accessToken, from, to, p.get('ids') || '');
        return json(
          req,
          win.calendarErrors.length ? { connected: true, events: win.events, calendarErrors: win.calendarErrors } : { connected: true, events: win.events },
        );
      }

      /* ---------- calendarList (picker source) ---------- */
      case 'calendar/list': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const res = await authedGet(`${CAL_LIST}?maxResults=100`, auth.accessToken);
        if (!res.ok) return googleError(req, res);
        const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
        return json(req, { connected: true, calendars: mapCalendarList(body?.items) });
      }

      /* ---------- freeBusy over the enabled calendars ---------- */
      case 'calendar/freebusy': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const body = await readJson(req);
        const request = buildFreebusyRequest({ from: body?.from as unknown, to: body?.to as unknown, calendarIds: body?.calendarIds as unknown });
        if (!request) return json(req, { error: 'invalid_window' }, 400);
        /* Only calendars the account actually owns may be queried. */
        const entries = await fetchCalendarEntries(auth.accessToken);
        const enabled = resolveEnabledCalendars(
          request.items.map(i => i.id),
          entries,
        );
        const res = await fetch(CAL_FREEBUSY, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeMin: request.timeMin, timeMax: request.timeMax, items: enabled.map(id => ({ id })) }),
        });
        if (!res.ok) return googleError(req, res);
        const fb = (await res.json().catch(() => null)) as unknown;
        const mapped = mapFreebusy(fb);
        return json(req, { connected: true, busy: mapped.busy, perCalendar: mapped.perCalendar });
      }

      /* ---------- event insert ---------- */
      case 'calendar/event': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const raw = await readJson(req);
        const resource = buildEventResource(raw);
        if (!resource) return json(req, { error: 'invalid_event' }, 400);
        const calUrl = await eventCalendarUrl(req, auth.accessToken, p.get('calendarId') || (typeof raw?.calendarId === 'string' ? raw.calendarId : ''));
        if (calUrl instanceof Response) return calUrl;
        const res = await fetch(`${calUrl}?sendUpdates=all`, {
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
        const raw = await readJson(req);
        const resource = buildEventResource(raw);
        if (!resource) return json(req, { error: 'invalid_event' }, 400);
        const calUrl = await eventCalendarUrl(req, auth.accessToken, p.get('calendarId') || (typeof raw?.calendarId === 'string' ? raw.calendarId : ''));
        if (calUrl instanceof Response) return calUrl;
        const res = await fetch(`${calUrl}/${encodeURIComponent(id)}?sendUpdates=all`, {
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
        const calUrl = await eventCalendarUrl(req, auth.accessToken, p.get('calendarId') || '');
        if (calUrl instanceof Response) return calUrl;
        const res = await fetch(`${calUrl}/${encodeURIComponent(id)}?sendUpdates=all`, {
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
            hint: 'gmail | gmail/message | gmail/thread | gmail/search | gmail/attachment | gmail/send | gmail/modify | gmail/trash | gmail/untrash | gmail/drafts | gmail/draft | gmail/draft/send | gmail/draft/delete | gmail/labels | gmail/label | gmail/batchModify | gmail/batchDelete | gmail/batchTrash | calendar | calendar/list | calendar/freebusy | calendar/event | calendar/event/update | calendar/event/delete',
          },
          404,
        );
    }
  } catch (err) {
    console.error('google-data error:', err instanceof Error ? err.message : err);
    return json(req, { error: 'internal' }, 500);
  }
});
