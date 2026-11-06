/* =====================================================================
   paperclip-bridge — ALLOWLIST proxy from Atrium to the Paperclip API.
   Behavior-parity invariant: every read/write goes through Paperclip's
   own HTTP API with a board Bearer token; the bridge NEVER touches the
   paperclip database directly.

   The gateway adds NO auth on /functions/v1/* — this function validates
   the caller's GoTrue JWT itself, then gates on membership of env
   PAPERCLIP_WORKSPACE_ID (the migration-0001 is_workspace_member helper,
   called with the CALLER's JWT so auth.uid() resolves inside Postgres).
   Only the routes in _shared/paperclip-pure.js's PC_ROUTES are forwarded;
   everything else is 400. Upstream calls carry AbortSignal.timeout(10s)
   and the x-forwarded-host the Paperclip private-hostname guard demands.
   The board token lives ONLY in the upstream Authorization header — it is
   never logged, never echoed, never part of any URL.
   ===================================================================== */
import { SUPABASE_URL, ANON_KEY, json, getAuthUser, action } from '../_shared/edge.ts';
import { resolveBridgeRoute, upstreamRoute, sanitizeQuery } from '../_shared/paperclip-pure.js';

const BASE = (Deno.env.get('PAPERCLIP_BRIDGE_BASE') || '').replace(/\/+$/, '');
const TOKEN = Deno.env.get('PAPERCLIP_BOARD_TOKEN') || '';
const COMPANY_ID = Deno.env.get('PAPERCLIP_COMPANY_ID') || '';
const WORKSPACE_ID = Deno.env.get('PAPERCLIP_WORKSPACE_ID') || '';
const UPSTREAM_TIMEOUT_MS = 10_000;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Max-Age': '86400' } });

  if (!BASE || !TOKEN || !COMPANY_ID || !WORKSPACE_ID) {
    return json(req, { error: 'bridge_not_configured' }, 503);
  }

  /* 1 — caller identity (GoTrue). */
  const user = await getAuthUser(req);
  if (!user) return json(req, { error: 'unauthorized', message: 'A valid signed-in user token is required.' }, 401);

  /* 2 — workspace access gate (read AND write). Operance-style workspaces
     grant access to members (is_workspace_member) AND the owner
     (owns_workspace) — migration 0001's own policy pair — so both helpers
     run with the CALLER's JWT (auth.uid() resolves inside Postgres). */
  const access = await workspaceAccess(req, user.id);
  if (access === null) return json(req, { error: 'upstream_error', message: 'Membership check failed.' }, 502);
  if (!access) return json(req, { error: 'forbidden', message: 'You are not a member of the Agents workspace.' }, 403);

  /* 3 — allowlist. Only recon'd short paths + methods pass; the upstream
     company is pinned to the env company so a caller can never aim the
     bridge elsewhere. */
  const sub = action(req, 'paperclip-bridge');
  const route = resolveBridgeRoute(req.method, sub);
  if (!route) return json(req, { error: 'bad_request', message: 'Not an allowlisted Paperclip route.' }, 400);

  const path = upstreamRoute(route.id, route.params, COMPANY_ID);
  if (!path) return json(req, { error: 'bad_request', message: 'Not an allowlisted Paperclip route.' }, 400);
  const q = sanitizeQuery(route.id, Object.fromEntries(new URL(req.url).searchParams));
  const url = `${BASE}${path}${q ? '?' + q : ''}`;

  /* 4 — forward with the board token (header only, 10s abort). */
  try {
    const body = req.method === 'POST' ? await req.text() : undefined;
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'x-forwarded-host': 'paperclip.ship.digitaldips.xyz',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await res.text();
    let out;
    try {
      out = JSON.parse(text);
    } catch {
      return json(req, { error: 'upstream_error', message: `Paperclip returned non-JSON (HTTP ${res.status}).` }, 502);
    }
    return json(req, out, res.status);
  } catch (err) {
    const timedOut = err instanceof DOMException ? err.name === 'TimeoutError' : err?.name === 'TimeoutError';
    console.error(`paperclip-bridge upstream failure (${route.id})${timedOut ? ' after 10s timeout' : ''}`);
    return json(req, { error: 'upstream_error', message: timedOut ? 'Paperclip did not respond within 10s.' : 'Paperclip is unreachable.' }, 502);
  }
});

function cors(req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = Deno.env.get('APP_ORIGIN') || 'https://atrium.ship.digitaldips.xyz';
  return {
    'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

/* Postgres RPCs is_workspace_member / owns_workspace (migration 0001)
   called with the CALLER's JWT so auth.uid() resolves; SECURITY DEFINER
   semantics. Returns true for member OR owner, false for neither, or
   null when the check itself failed (honest 502, never a silent
   deny/allow on transport errors). */
async function workspaceAccess(req, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
  const rpc = async fn => {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          Authorization: req.headers.get('Authorization') || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_workspace_id: WORKSPACE_ID }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`paperclip-bridge ${fn} failed: HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) === true;
    } catch (err) {
      console.error(`paperclip-bridge ${fn} error: ${err?.name || 'error'}`);
      return null;
    }
  };
  const member = await rpc('is_workspace_member');
  if (member !== false) return member; // true, or null (transport failure — honest 502)
  return rpc('owns_workspace');
}
