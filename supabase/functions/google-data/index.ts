// =====================================================================
// google-data — read-only Gmail + Google Calendar for Atrium
//   GET /functions/v1/google-data/gmail?max=20
//        → { connected, messages: [{ id, from, email, subject, snippet,
//            date(ms), unread, webLink }] }  (INBOX only, metadata batch)
//   GET /functions/v1/google-data/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//        → { connected, events: [{ id, summary, start, end, location,
//            htmlLink }] }  (primary calendar, singleEvents, orderBy=startTime)
// Every request exchanges the stored refresh token for a fresh access
// token (nothing cached in v1). invalid_grant (user revoked access or the
// grant expired) → { connected: false } so the UI falls back to its
// connect prompt. The caller's Supabase JWT is validated on every route.
// =====================================================================
import { expandDayRange, mapGmailMessage, monthWindow } from '../_shared/google-pure.js';
import { SUPABASE_URL, action, corsHeaders, json, unauthorized, getAuthUser, getIntegration, refreshAccessToken } from '../_shared/edge.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function authedGet(url: string, accessToken: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function fetchGmail(accessToken: string, max: number): Promise<Response> {
  const list = await authedGet(`${GMAIL_API}/messages?labelIds=INBOX&maxResults=${max}`, accessToken);
  if (!list.ok) return list;
  const { messages = [] } = await list.json().catch(() => ({ messages: [] }));
  // Metadata batch: From/Subject headers + snippet, internalDate, labelIds.
  const metas = await Promise.all(
    (messages as Array<{ id: string }>).map(m =>
      authedGet(`${GMAIL_API}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, accessToken).then(r =>
        r.ok ? r.json() : null,
      ),
    ),
  );
  const mapped = metas.map(meta => mapGmailMessage(meta)).filter(Boolean);
  return new Response(JSON.stringify(mapped), { headers: { 'Content-Type': 'application/json' } });
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
    id: e.id || '',
    summary: e.summary || '',
    start: e.start || {},
    end: e.end || {},
    location: e.location || '',
    htmlLink: e.htmlLink || '',
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

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

  const act = action(req, 'google-data');
  const p = new URL(req.url).searchParams;
  try {
    switch (act) {
      case 'gmail': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const max = Math.min(50, Math.max(1, Number(p.get('max')) || 20));
        const auth = await withAccessToken(req);
        if (auth instanceof Response) return auth;
        const res = await fetchGmail(auth.accessToken, max);
        if (!res.ok) return json(req, { error: 'google_error', status: res.status }, 502);
        return json(req, { connected: true, messages: await res.json() });
      }

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
        if (!res.ok) return json(req, { error: 'google_error', status: res.status }, 502);
        return json(req, { connected: true, events: await res.json() });
      }

      default:
        return json(req, { error: 'not_found', hint: 'use gmail | calendar' }, 404);
    }
  } catch (err) {
    console.error('google-data error:', err instanceof Error ? err.message : err);
    return json(req, { error: 'internal' }, 500);
  }
});
