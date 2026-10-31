/* =====================================================================
   GOOGLE INTEGRATION (frontend glue) · session-token calls to the edge
   functions. Pure logic lives in supabase/functions/_shared/google-pure.js
   (shared with the Deno runtime and node tests). State on S.ui:
     S.ui.google   { connected, email, loaded }   fetched at boot + after
                                                   connect / disconnect
     S.ui.gState   'idle' | 'loading' | 'ok' | 'error' | 'off'  (gmail list)
     S.ui.gmsgs    mapped gmail messages
     S.ui.gsel     selected gmail message id
     S.ui.gevState 'idle' | 'loading' | 'ok' | 'error' | 'off'
     S.ui.gevs     calendar events for the fetched window
     S.ui.gevWin   'from..to' window the events belong to
   The functions live at {VITE_SUPABASE_URL}/functions/v1 and are called
   with fetch + apikey/Authorization headers (sb.functions.invoke always
   POSTs, which these GET endpoints don't accept).
   ===================================================================== */
import { S } from './store.js';
import { sb } from './supabase.js';
import { render } from '../shell/render.js';

const FN_BASE = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1';

export const googleStatus = () => S.ui.google || { connected: false, email: null, loaded: false };

async function sessionToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

/* GET/POST to an edge function with the signed-in user's access token.
   401 (expired session) surfaces as a thrown error the callers show. */
async function gFetch(path, { method = 'GET', params } = {}) {
  const token = await sessionToken();
  if (!token) throw new Error('You are signed out — sign in again to use Google features.');
  const u = new URL(`${FN_BASE()}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') u.searchParams.set(k, v);
  }
  const res = await fetch(u, {
    method,
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error(body.error === 'unauthorized' ? 'Your session expired — sign in again.' : body.error || 'Not authorized.');
  if (!res.ok && !('connected' in body)) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* Boot / post-connect / post-disconnect: who is connected? Renders so the
   Inbox + Calendar + Settings surfaces settle into the right state. */
export async function loadGoogleStatus() {
  if (!sb) return;
  try {
    const body = await gFetch('google-auth/status');
    S.ui.google = { connected: !!body.connected, email: body.email || null, loaded: true };
  } catch {
    S.ui.google = { connected: false, email: null, loaded: false, error: true };
  }
  render();
}

/* Start the consent flow: the authorize endpoint returns the Google URL
   as JSON (Accept: application/json) because a CORS fetch cannot consume
   its cross-origin 302. */
export async function connectGoogle() {
  const body = await gFetch('google-auth/authorize');
  if (!body.url) throw new Error(body.error || 'Could not start Google sign-in.');
  window.location.assign(body.url);
}

export async function disconnectGoogle() {
  const body = await gFetch('google-auth/disconnect', { method: 'POST' });
  S.ui.google = { connected: !!body.connected, email: null, loaded: true };
  /* Drop every cached Google payload: the UI falls back to connect prompts. */
  S.ui.gState = 'off';
  S.ui.gmsgs = [];
  S.ui.gsel = null;
  S.ui.gevState = 'off';
  S.ui.gevs = [];
  S.ui.gevWin = null;
  render();
  return !!body.connected;
}

/* ---------- Gmail (Inbox category 'gmail') ---------- */

export async function ensureGmail() {
  if (S.ui.gState === 'loading' || S.ui.gState === 'ok') return;
  S.ui.gState = 'loading';
  render();
  try {
    const body = await gFetch('google-data/gmail', { params: { max: 25 } });
    if (!body.connected) {
      /* invalid_grant or revoked access: honest fallback to not-connected. */
      S.ui.google = { connected: false, email: null, loaded: true };
      S.ui.gState = 'off';
      S.ui.gmsgs = [];
    } else {
      S.ui.gState = 'ok';
      S.ui.gmsgs = Array.isArray(body.messages) ? body.messages : [];
    }
  } catch (e) {
    S.ui.gState = 'error';
    S.ui.gError = String(e?.message || 'Could not load your Gmail.');
  }
  render();
}

/* ---------- Google Calendar (route 'calendar') ---------- */

/* win = { from, to } — the visible grid window. Refetches whenever the
   window changes (month navigation) and after a disconnect/retry. */
export async function ensureGoogleCalendar(win) {
  const key = `${win.from}..${win.to}`;
  if (S.ui.gevWin === key && (S.ui.gevState === 'ok' || S.ui.gevState === 'empty')) return;
  if (S.ui.gevKey === key && S.ui.gevState === 'loading') return;
  S.ui.gevKey = key;
  S.ui.gevState = 'loading';
  S.ui.gevs = [];
  S.ui.gevWin = null;
  render();
  try {
    const body = await gFetch('google-data/calendar', { params: { from: win.from, to: win.to } });
    if (!body.connected) {
      S.ui.google = { connected: false, email: null, loaded: true };
      S.ui.gevState = 'off';
      S.ui.gevs = [];
      S.ui.gevWin = null;
    } else {
      S.ui.gevState = (body.events || []).length ? 'ok' : 'empty';
      S.ui.gevs = body.events || [];
      S.ui.gevWin = key;
    }
  } catch (e) {
    S.ui.gevState = 'error';
    S.ui.gevError = String(e?.message || 'Could not load your Google Calendar.');
    S.ui.gevWin = null;
  }
  render();
}
