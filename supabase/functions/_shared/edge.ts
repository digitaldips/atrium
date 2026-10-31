/* =====================================================================
   SHARED EDGE HELPERS (Deno only — imported by google-auth + google-data)
   The gateway route /functions/v1/* carries ONLY a cors plugin and NO JWT
   check, so every function validates the Authorization bearer itself.
   ===================================================================== */
import { createClient } from 'npm:@supabase/supabase-js@2';

export const APP_ORIGIN = Deno.env.get('APP_ORIGIN') || 'https://atrium.ship.digitaldips.xyz';
export const PUBLIC_URL = Deno.env.get('PUBLIC_URL') || Deno.env.get('SUPABASE_PUBLIC_URL') || APP_ORIGIN;
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
export const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
export const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

export const ALLOWED_ORIGIN = APP_ORIGIN;

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function unauthorized(req: Request): Response {
  return json(req, { error: 'unauthorized', message: 'A valid signed-in user token is required.' }, 401);
}

/* Route segments after the mount prefix: /google-data/gmail → 'gmail',
   /google-data/gmail/message → 'gmail/message'. Also tolerate a runtime
   that strips the function name (/status → 'status'). Sub-routes join
   with '/', so a handler can switch on the full sub-path. */
export function action(req: Request, name: string): string {
  const seg = new URL(req.url).pathname.split('/').filter(Boolean);
  return seg[0] === name ? seg.slice(1).join('/') || '' : seg.join('/');
}

/* Validate the caller's Supabase JWT by asking GoTrue to resolve it to a
   user. Returns the auth user or null — never a made-up identity. */
export async function getAuthUser(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const client = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user;
}

/* Service-role REST helpers for public.user_integrations (RLS on, zero
   policies — only the service role may touch this table). */
function serviceHeaders(extra: Record<string, string> = {}) {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

export async function getIntegration(userId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_integrations?user_id=eq.${encodeURIComponent(userId)}&select=user_id,google_refresh_token,google_email,scopes,connected_at,pending_nonce,pending_expires`,
    {
      headers: serviceHeaders(),
    },
  );
  if (!res.ok) throw new Error(`user_integrations select failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function upsertIntegration(userId: string, patch: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_integrations?on_conflict=user_id`, {
    method: 'POST',
    headers: serviceHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({ user_id: userId, provider: 'google', updated_at: new Date().toISOString(), ...patch }),
  });
  if (!res.ok) throw new Error(`user_integrations upsert failed: ${res.status}`);
}

export async function deleteIntegration(userId: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_integrations?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(),
  });
  if (!res.ok) throw new Error(`user_integrations delete failed: ${res.status}`);
}

/* Store the pending OAuth flow for a user: a fresh nonce + its expiry.
   Upsert (merge-duplicates) touches ONLY the pending columns — never the
   token columns — so starting a new consent flow cannot disturb an
   existing connection. One pending flow per user (PK user_id): a newer
   authorize supersedes an older one. */
export async function setPendingNonce(userId: string, nonce: string, expiresAt: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_integrations?on_conflict=user_id`, {
    method: 'POST',
    headers: serviceHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({ user_id: userId, provider: 'google', pending_nonce: nonce, pending_expires: expiresAt }),
  });
  if (!res.ok) throw new Error(`user_integrations pending-nonce upsert failed: ${res.status}`);
}

/* Consume the pending nonce (single-use): the UPDATE matches on the nonce
   itself, so only the first callback with a still-pending flow wins the
   race — a concurrent replay finds no matching row and is rejected.
   Returns true when this call consumed the flow. */
export async function consumePendingNonce(userId: string, nonce: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_integrations?user_id=eq.${encodeURIComponent(userId)}&pending_nonce=eq.${encodeURIComponent(nonce)}`, {
    method: 'PATCH',
    headers: serviceHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ pending_nonce: null, pending_expires: null }),
  });
  if (!res.ok) throw new Error(`user_integrations pending-nonce consume failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

/* Exchange a refresh token for a fresh access token (per request; nothing
   is cached in v1). invalid_grant means the user revoked access or the
   token expired — callers must treat that as { connected: false }. */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken?: string; invalidGrant?: boolean; status: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      client_secret: Deno.env.get('GOOGLE_SECRET') || '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const j = await res.json().catch(() => ({}) as Record<string, string>);
  if (res.ok && j.access_token) return { accessToken: j.access_token, status: res.status };
  if (j.error === 'invalid_grant') return { invalidGrant: true, status: res.status };
  return { status: res.status };
}
