/* =====================================================================
   AGENTIC (MCP) — client for the mcp edge function (Orbit integration T4).
   Pure helpers live in supabase/functions/_shared/mcp-pure.js (node-tested);
   this module is the fetch boundary: grants list (settings), the OAuth
   consent flow (agentic-auth route). Same fetch shape as google.js:
   apikey + the signed-in user's Authorization header, GET/POST.
   ===================================================================== */
import { S } from './store.js';
import { sb } from './supabase.js';
import { render } from '../shell/render.js';
import { claudeConnectLine, mcpServerUrl, scopeShort } from '../../supabase/functions/_shared/mcp-pure.js';

export { claudeConnectLine, mcpServerUrl, scopeShort };

const FN_BASE = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1';
export const mcpUrl = () => mcpServerUrl(import.meta.env.VITE_SUPABASE_URL || '');

export const agenticState = () => S.ui.agentic || { loaded: false, grants: [] };

async function sessionToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

async function mFetch(path, { method = 'GET', body } = {}) {
  const token = await sessionToken();
  if (!token) throw new Error('You are signed out — sign in again to manage connections.');
  const res = await fetch(`${FN_BASE()}/mcp${path}`, {
    method,
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error === 'login_required' ? 'Your session expired — sign in again.' : out.error || 'Not authorized.');
  return out;
}

/* Authorized-clients list for Settings → Agentic. Same fetch-on-render
   guard class as loadGoogleStatus: in-flight guard, terminal error until
   an explicit Retry re-arms exactly one fetch. */
export async function loadAgenticGrants() {
  if (!sb || S.ui.agenticLoading) return;
  S.ui.agenticLoading = true;
  try {
    const body = await mFetch('/grants');
    S.ui.agentic = { loaded: true, grants: Array.isArray(body.items) ? body.items : [] };
  } catch {
    S.ui.agentic = { loaded: false, grants: [], error: true };
  } finally {
    S.ui.agenticLoading = false;
  }
  render();
}

/* ---------- consent flow (agentic-auth route) ---------- */

export const consentState = () => S.ui.agenticConsent || { state: 'idle' };

/* Load the consent payload for request `req`: binds the signed-in user and
   returns client name, requested scopes, workspace + a one-time csrf. */
export async function startAgenticConsent(req) {
  if (S.ui.agenticConsentLoading) return;
  S.ui.agenticConsent = { state: 'loading' };
  S.ui.agenticConsentLoading = true;
  render();
  try {
    const data = await mFetch(`/consent?request=${encodeURIComponent(req)}`);
    S.ui.agenticConsent = { state: 'ready', data: { ...data, req } };
  } catch (err) {
    S.ui.agenticConsent = { state: 'error', error: err instanceof Error ? err.message : 'This authorization request is not valid.' };
  } finally {
    S.ui.agenticConsentLoading = false;
  }
  render();
}

/* Approve or deny: the edge function binds the grant and returns the
   client callback URL (code or access_denied) — the browser then leaves
   the app for the client's redirect target. */
export async function submitAgenticConsent(approved) {
  const c = S.ui.agenticConsent;
  if (c?.state !== 'ready' || S.ui.agenticSubmitting) return;
  S.ui.agenticSubmitting = true;
  render();
  try {
    const out = await mFetch('/approve', { method: 'POST', body: { request: c.data.req, csrf_token: c.data.csrf_token, approved, scopes: c.data.scopes } });
    if (!out.redirect_uri) throw new Error('No redirect target returned.');
    S.ui.agenticConsent = { state: 'done', redirect_uri: out.redirect_uri };
    window.location.assign(out.redirect_uri);
  } catch (err) {
    S.ui.agenticConsent = { state: 'error', error: err instanceof Error ? err.message : 'Approving failed.' };
    S.ui.agenticSubmitting = false;
  }
  render();
}

/* Revoke one of the user's grants (Settings → Agentic → Revoke). */
export async function revokeAgenticGrant(id) {
  const out = await mFetch('/grants/revoke', { method: 'POST', body: { grant_id: id } });
  if (!out.revoked) throw new Error('Revoke failed.');
  await loadAgenticGrants();
}
