/* =====================================================================
   GOOGLE INTEGRATION (frontend glue) · session-token calls to the edge
   functions. Pure logic lives in supabase/functions/_shared/google-pure.js
   (shared with the Deno runtime and node tests). State on S.ui:
     S.ui.google   { connected, email, loaded }   fetched at boot + after
                                                   connect / disconnect
     S.ui.gState   'idle' | 'loading' | 'ok' | 'error' | 'off'  (gmail list;
                   'error' is terminal until the manual Retry action)
     S.ui.gmsgs    mapped gmail messages
     S.ui.gsel     selected gmail message id
     S.ui.gevState 'idle' | 'loading' | 'ok' | 'error' | 'off'
     S.ui.gevs     calendar events for the fetched window
     S.ui.gevWin   'from..to' window the events belong to
   Deep-read / action state (FULL client):
     S.ui.gmsg     { [id]: { state, msg, error } }   format=full message cache
     S.ui.gthread  { [threadId]: { state, messages, error } }
     S.ui.gOpen    Set of expanded message ids inside the thread view
     S.ui.gSearchQ active search query ('' = browsing the inbox list)
     S.ui.gSearch  { state, msgs, nextPageToken, error } for that query
     S.ui.gform    compose/reply form { to, cc, subject, body, threadId,
                   inReplyTo, references, sending, error }
   The functions live at {VITE_SUPABASE_URL}/functions/v1 and are called
   with fetch + apikey/Authorization headers (sb.functions.invoke always
   POSTs, which these GET endpoints don't accept).
   ===================================================================== */
import { S } from './store.js';
import { sb } from './supabase.js';
import { render } from '../shell/render.js';
import { shouldFetch, shouldFetchWindow } from '../../supabase/functions/_shared/google-pure.js';

const FN_BASE = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1';

export const googleStatus = () => S.ui.google || { connected: false, email: null, loaded: false };

async function sessionToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

/* GET/POST/PATCH/DELETE to an edge function with the signed-in user's
   access token. 401 (expired session) surfaces as a thrown error the
   callers show. */
async function gFetch(path, { method = 'GET', params, body } = {}) {
  const token = await sessionToken();
  if (!token) throw new Error('You are signed out — sign in again to use Google features.');
  const u = new URL(`${FN_BASE()}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') u.searchParams.set(k, v);
  }
  const res = await fetch(u, {
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
  if (res.status === 401) throw new Error(out.error === 'unauthorized' ? 'Your session expired — sign in again.' : out.error || 'Not authorized.');
  if (!res.ok && !('connected' in out)) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

/* Boot / post-connect / post-disconnect: who is connected? Renders so the
   Inbox + Calendar + Settings surfaces settle into the right state. The
   in-flight guard keeps render-triggered calls from stacking: one status
   check at a time, and an errored check stays terminal until Retry. */
export async function loadGoogleStatus() {
  if (!sb || S.ui.googleStatusLoading) return;
  S.ui.googleStatusLoading = true;
  try {
    const body = await gFetch('google-auth/status');
    S.ui.google = { connected: !!body.connected, email: body.email || null, scopes: Array.isArray(body.scopes) ? body.scopes : [], loaded: true };
  } catch {
    S.ui.google = { connected: false, email: null, loaded: false, error: true };
  } finally {
    S.ui.googleStatusLoading = false;
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

/* Fetch-on-render guard: an 'error' state is TERMINAL — the Inbox calls
   this on every synchronous render, so an auto-retrying failure would
   loop forever (fetch → fail → render → fetch) and hammer the edge
   function + Google's token endpoint. Only the manual Retry action
   resets the state to 'idle' and re-arms exactly one fetch. */
export async function ensureGmail() {
  if (!shouldFetch(S.ui.gState)) return;
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
   window changes (month navigation) and after a disconnect/retry. The
   same-window guard is the pure shouldFetchWindow decision: a settled or
   failed ('error') state only blocks refetching the SAME window — an
   error stays terminal until the manual Retry action resets it. */
export async function ensureGoogleCalendar(win) {
  const key = `${win.from}..${win.to}`;
  if (!shouldFetchWindow(S.ui.gevState, key, S.ui.gevKey)) return;
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

/* ---------- Gmail deep read (message + thread, format=full) ---------- */

/* Fetch-on-render cached like the list: one fetch per message id, an
   error stays terminal for THAT id until Retry re-arms it. Opening an
   unread message marks it read via gmail/modify (best effort — a failed
   mark never blocks reading). */
export async function ensureGmailMessage(id) {
  if (!id) return;
  const c = (S.ui.gmsg = S.ui.gmsg || {});
  if (c[id] && c[id].state !== 'error') return;
  c[id] = { state: 'loading', msg: null };
  render();
  try {
    const body = await gFetch('google-data/gmail/message', { params: { id } });
    if (!body.connected) {
      S.ui.google = { connected: false, email: null, loaded: true };
      c[id] = { state: 'error', msg: null, error: 'Google is no longer connected.' };
      render();
      return;
    }
    const msg = body.message;
    c[id] = { state: 'ok', msg };
    /* Update the list row too (unread dot, snippet honesty). */
    const row = (S.ui.gmsgs || []).find(m => m.id === id);
    if (row && msg && msg.unread !== undefined) row.unread = msg.unread;
    render();
    if (msg && msg.unread) {
      try {
        await modifyGmail(id, { unread: false });
      } catch {
        /* best effort: reading must not depend on the label write */
      }
    }
    if (msg && msg.threadId) ensureGmailThread(msg.threadId);
  } catch (e) {
    c[id] = { state: 'error', msg: null, error: String(e?.message || 'Could not load the message.') };
  }
  render();
}

/* Thread context: messages grouped chronologically by the pure mapThread. */
export async function ensureGmailThread(threadId) {
  if (!threadId) return;
  const t = (S.ui.gthread = S.ui.gthread || {});
  if (t[threadId] && t[threadId].state !== 'error') return;
  t[threadId] = { state: 'loading', messages: [] };
  render();
  try {
    const body = await gFetch('google-data/gmail/thread', { params: { id: threadId } });
    if (!body.connected) {
      t[threadId] = { state: 'error', messages: [], error: 'Google is no longer connected.' };
    } else {
      t[threadId] = { state: 'ok', messages: Array.isArray(body.thread?.messages) ? body.thread.messages : [] };
    }
  } catch (e) {
    t[threadId] = { state: 'error', messages: [], error: String(e?.message || 'Could not load the thread.') };
  }
  render();
}

/* ---------- Gmail search (q passthrough, paged) ---------- */

/* state: 'idle' | 'loading' | 'ok' | 'empty' | 'error'. The query lives
   in S.ui.gSearchQ; '' means the plain inbox list is shown. A new query
   always fetches; error is terminal until a fresh run or Back-to-inbox. */
export async function runGmailSearch(q) {
  const query = String(q || '').trim();
  S.ui.gSearchQ = query;
  S.ui.gSearch = { state: 'loading', msgs: [], nextPageToken: '', error: null };
  render();
  if (!query) return;
  try {
    const body = await gFetch('google-data/gmail/search', { params: { q: query, max: 25 } });
    if (!body.connected) {
      S.ui.google = { connected: false, email: null, loaded: true };
      S.ui.gSearch = { state: 'error', msgs: [], nextPageToken: '', error: 'Google is no longer connected.' };
    } else {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      S.ui.gSearch = { state: msgs.length ? 'ok' : 'empty', msgs, nextPageToken: body.nextPageToken || '', error: null };
    }
  } catch (e) {
    S.ui.gSearch = { state: 'error', msgs: [], nextPageToken: '', error: String(e?.message || 'Search failed.') };
  }
  render();
}

export async function moreGmailSearch() {
  const s = S.ui.gSearch;
  if (!s || s.state !== 'ok' || !s.nextPageToken || s.loadingMore) return;
  s.loadingMore = true;
  render();
  try {
    const body = await gFetch('google-data/gmail/search', { params: { q: S.ui.gSearchQ, max: 25, pageToken: s.nextPageToken } });
    if (body.connected) {
      s.msgs = [...(s.msgs || []), ...(Array.isArray(body.messages) ? body.messages : [])];
      s.nextPageToken = body.nextPageToken || '';
    }
  } catch {
    /* keep the loaded page; the next More click retries */
  }
  s.loadingMore = false;
  render();
}

export function clearGmailSearch() {
  S.ui.gSearchQ = '';
  S.ui.gSearch = { state: 'idle', msgs: [], nextPageToken: '', error: null };
  render();
}

/* ---------- Gmail actions ---------- */

/* All actions throw their honest error; the caller toasts it. The list
   refetches after a state change (gState='idle' → next render fetches),
   matching the fetch-on-render guards. */
export async function sendGmail(form) {
  const body = await gFetch('google-data/gmail/send', {
    method: 'POST',
    body: form,
  });
  if (!body.connected) throw new Error('Google is no longer connected.');
  return body;
}

export async function modifyGmail(id, patch) {
  const body = await gFetch('google-data/gmail/modify', { method: 'POST', params: { id }, body: patch });
  if (!body.connected) throw new Error('Google is no longer connected.');
  /* Reflect the label change locally: unread in the list + deep cache. */
  if (patch && typeof patch.unread === 'boolean') {
    const row = (S.ui.gmsgs || []).find(m => m.id === id);
    if (row) row.unread = patch.unread;
    const srow2 = ((S.ui.gSearch && S.ui.gSearch.msgs) || []).find(m => m.id === id);
    if (srow2) srow2.unread = patch.unread;
    const c = S.ui.gmsg && S.ui.gmsg[id];
    if (c && c.msg) c.msg.unread = patch.unread;
  }
  render();
  return body;
}

export async function trashGmail(id, untrash = false) {
  const body = await gFetch(untrash ? 'google-data/gmail/untrash' : 'google-data/gmail/trash', { method: 'POST', params: { id } });
  if (!body.connected) throw new Error('Google is no longer connected.');
  return body;
}

/* Attachment data: base64url from the endpoint (size-capped there too). */
export async function gAttachmentFetch(id, attachmentId) {
  const body = await gFetch('google-data/gmail/attachment', { params: { id, attachmentId } });
  if (!body.connected) throw new Error('Google is no longer connected.');
  if (!body.data) throw new Error('The attachment data could not be loaded.');
  return body;
}

/* Refetch helper shared by the mutating actions: the terminal 'ok' state
   is reset so the next render fetches a fresh INBOX list. */
export function refetchGmailList() {
  S.ui.gState = 'idle';
  S.ui.gsel = null;
  S.ui.gSearchQ = '';
  S.ui.gSearch = { state: 'idle', msgs: [], nextPageToken: '', error: null };
  render();
}

/* ---------- Google Calendar CRUD ---------- */

export async function createGEvent(payload) {
  const body = await gFetch('google-data/calendar/event', { method: 'POST', body: payload });
  if (!body.connected) throw new Error('Google is no longer connected.');
  return body.event;
}

export async function updateGEvent(id, payload) {
  const body = await gFetch('google-data/calendar/event/update', { method: 'PATCH', params: { id }, body: payload });
  if (!body.connected) throw new Error('Google is no longer connected.');
  return body.event;
}

export async function deleteGEvent(id) {
  const body = await gFetch('google-data/calendar/event/delete', { method: 'DELETE', params: { id } });
  if (!body.connected) throw new Error('Google is no longer connected.');
  return body.deleted !== false;
}

/* Re-arm the calendar window after a mutation: the settled/error guard
   only blocks the SAME window state, so resetting key + state forces the
   next render to refetch the visible grid. */
export function refetchCalendarWindow(win) {
  S.ui.gevKey = null;
  S.ui.gevState = 'idle';
  ensureGoogleCalendar(win);
}
