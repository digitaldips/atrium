// =====================================================================
// google-auth — Google OAuth for Atrium (READ-ONLY Gmail + Calendar)
//   GET  /functions/v1/google-auth/authorize  → 302 to accounts.google.com
//        (Accept: application/json → 200 { url } so a CORS fetch can
//         collect the URL instead of being eaten by a cross-origin 302)
//   GET  /functions/v1/google-auth/callback   → exchange code, store the
//        refresh token (service role), 302 back to the app
//   GET  /functions/v1/google-auth/status     → { connected, email }
//   POST /functions/v1/google-auth/disconnect → delete the row
// Every route (except OPTIONS) validates the caller's Supabase JWT —
// the gateway adds no auth on /functions/v1/*.
// Tokens NEVER leave the server: status/disconnect responses carry no
// token material, only { connected, email }.
// =====================================================================
import { GOOGLE_SCOPE_PARAM, signState, verifyState } from '../_shared/google-pure.js';
import {
  APP_ORIGIN,
  PUBLIC_URL,
  SUPABASE_URL,
  SERVICE_ROLE_KEY,
  action,
  corsHeaders,
  json,
  unauthorized,
  getAuthUser,
  getIntegration,
  upsertIntegration,
  deleteIntegration,
} from '../_shared/edge.ts';

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_SECRET') || '';

function redirectUri(): string {
  return `${PUBLIC_URL}/functions/v1/google-auth/callback`;
}

function consentUrl(userId: string, state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPE_PARAM);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
}

function backToApp(result: string, reason = ''): string {
  /* The app reads its route + params from the URL hash (#settings?google=…),
     so the query must live INSIDE the hash — URL.searchParams would put it
     in the search string where the app never looks. */
  const q = reason ? `&reason=${encodeURIComponent(reason)}` : '';
  return `${APP_ORIGIN}/#settings?google=${encodeURIComponent(result)}${q}`;
}

function seeOther(req: Request, location: string): Response {
  return new Response(null, { status: 302, headers: { ...corsHeaders(req), Location: location, 'Cache-Control': 'no-store' } });
}

/* Best-effort account email for display. tokeninfo needs no extra scope;
   if it does not return an email we store null and the UI shows just
   "Connected". */
async function accountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.email === 'string' && j.email.includes('@') ? j.email : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

  const act = action(req, 'google-auth');
  try {
    switch (act) {
      /* ---------- authorize: signed-in user → Google consent ---------- */
      case 'authorize': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        if (!CLIENT_ID || !CLIENT_SECRET) return json(req, { error: 'google_not_configured' }, 500);
        const user = await getAuthUser(req);
        if (!user) return unauthorized(req);
        const state = await signState(user.id, SERVICE_ROLE_KEY);
        const url = consentUrl(user.id, state);
        const wantsJson = (req.headers.get('Accept') || '').includes('application/json') || new URL(req.url).searchParams.get('format') === 'json';
        return wantsJson ? json(req, { url }) : seeOther(req, url);
      }

      /* ---------- callback: Google sends the user back with code+state ---------- */
      case 'callback': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const p = new URL(req.url).searchParams;
        if (p.get('error')) return seeOther(req, backToApp('denied'));
        const code = p.get('code') || '';
        const state = p.get('state') || '';
        // Bad/missing/forged state: 4xx, no storage writes.
        const v = await verifyState(state, SERVICE_ROLE_KEY);
        if (!v.ok) return json(req, { error: 'invalid_state', reason: v.reason }, 400);
        if (!code) return json(req, { error: 'missing_code' }, 400);
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: redirectUri(),
            grant_type: 'authorization_code',
          }),
        });
        const tokens = await tokenRes.json().catch(() => ({}) as Record<string, string>);
        if (!tokenRes.ok || !tokens.refresh_token) {
          // consent=consent+offline should always return a refresh token;
          // anything else surfaces honestly in the app.
          return seeOther(req, backToApp('error', tokens.error || 'no_refresh_token'));
        }
        const email = await accountEmail(tokens.access_token || '');
        await upsertIntegration(v.userId, {
          google_refresh_token: tokens.refresh_token,
          google_email: email,
          scopes: typeof tokens.scope === 'string' ? tokens.scope : GOOGLE_SCOPE_PARAM,
          connected_at: new Date().toISOString(),
        });
        return seeOther(req, backToApp('ok'));
      }

      /* ---------- status: is this user connected? (no token material) ---------- */
      case 'status': {
        if (req.method !== 'GET') return json(req, { error: 'method_not_allowed' }, 405);
        const user = await getAuthUser(req);
        if (!user) return unauthorized(req);
        const row = await getIntegration(user.id);
        const connected = !!(row && row.google_refresh_token);
        return json(req, { connected, email: connected ? row?.google_email || null : null });
      }

      /* ---------- disconnect: delete the stored token ---------- */
      case 'disconnect': {
        if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
        const user = await getAuthUser(req);
        if (!user) return unauthorized(req);
        await deleteIntegration(user.id);
        return json(req, { connected: false });
      }

      default:
        return json(req, { error: 'not_found', hint: 'use authorize | callback | status | disconnect' }, 404);
    }
  } catch (err) {
    console.error('google-auth error:', err instanceof Error ? err.message : err);
    return json(req, { error: 'internal' }, 500);
  }
});
