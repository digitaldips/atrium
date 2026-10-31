/* =====================================================================
   WORKSPACE DATA LAYER · pure functions over a supabase-js-shaped client
   Every function here takes the client as an argument, so unit tests can
   exercise the whole data layer with a fake client and no network. The
   side-effectful client init lives in supabase.js, which binds these
   helpers to the real Supabase project.
   ===================================================================== */

/* ---------- document payload ---------- */

/* The Postgres table backing the workspace document. ONE constant, ONE
   point of change: a future backend target may name the table differently
   (AC3, backend-agnostic build). */
export const WORKSPACES_TABLE = 'workspaces';

/* The workspace document persisted to public.workspaces.data (jsonb):
   exactly the app state triple, nothing from S.ui. */
export function buildDocPayload(data, prefs, views) {
  return { data, prefs, views };
}

/* public.workspaces row -> { data, prefs, views }, or null when the row
   holds no usable document (missing row, or the jsonb default '{}'). */
export function workspaceRowToDoc(row) {
  if (!row || !row.data || typeof row.data !== 'object') return null;
  return { data: row.data.data ?? null, prefs: row.data.prefs ?? null, views: row.data.views ?? null };
}

/* A row needs bootstrapping when it is missing or carries no workspace
   document (e.g. first login before onboarding has ever finished). */
export function needsBootstrap(row) {
  const doc = workspaceRowToDoc(row);
  return !doc || !doc.data || !Array.isArray(doc.data.tasks);
}

/* ---------- error copy ---------- */

const NETWORK_RE = /failed to fetch|networkerror|network error|fetch failed|load failed|permission denied/i;

/* Map Supabase/PostgREST failures to short, honest user-facing copy.
   Unknown messages pass through; a missing error falls back. */
export function errMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return fallback;
  const code = err.code || '';
  const msg = err.message || '';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (code === 'user_already_exists' || /already registered|already exists/i.test(msg))
    return 'An account with this email already exists. Try signing in instead.';
  if (code === 'email_not_confirmed') return 'Please confirm your email address before signing in.';
  if (code === 'over_request_rate_limit' || /too many requests|rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (err instanceof TypeError || NETWORK_RE.test(msg)) return "Can't reach the server. Check your connection and try again.";
  return msg || fallback;
}

/* ---------- session ---------- */

export function isAuthedSession(session) {
  return !!(session && session.user && session.user.id);
}

/* ---------- auth route gate ---------- */

/* Which auth screen may render for a given requested route and session
   user id. Onboarding is a session-only route: an unauthenticated visitor
   (no matter what the URL hash says) is bounced to the login screen. */
export function resolveAuthRoute(requested, userId) {
  if (requested === 'onboarding' && !userId) return 'login';
  return requested;
}

/* ---------- localStorage cache binding ---------- */

/* Cache invariant: the localStorage workspace cache is trusted ONLY when
   it was written by the same signed-in user (uid). A cache without a uid
   or with a different uid is another account's workspace — it must never
   be rendered, edited, or synced. store.js stamps uid on every save() and
   discards untrusted caches at boot/login (bindCacheToUser). */

export function cachePayloadForUser(uid, payload) {
  return { ...payload, uid: uid || null };
}

/* True only when `cached` is a usable document written by `userId`. */
export function isTrustedCache(cached, userId) {
  return !!(cached && userId && cached.uid === userId && cached.data && Array.isArray(cached.data.tasks));
}

/* ---------- identity ---------- */

/* Mirror the authenticated account onto the workspace's own identity:
   the 'me' seed member gets the real name+email and prefs.name gets the
   real name, so the in-app identity matches the account from first
   render. Applied at signup, at OAuth bootstrap (fresh row) and wherever
   a fresh account identity must land; an existing synced doc keeps
   whatever identity the user chose in-app. */

/* Pure identity mapping (AC4b): the display name for an auth user, from
   Google-style user_metadata — full_name, then name, then the capitalised
   email local-part, then a neutral fallback. */
export function nameFromMetadata(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  const fallback = (user.email || '').split('@')[0].replace(/\b\w/g, c => c.toUpperCase());
  return meta.full_name || meta.name || fallback || 'You';
}

export function applyUserIdentity(S, user) {
  if (!S || !user) return false;
  const email = user.email || '';
  const name = nameFromMetadata(user);
  const meRow = S.data?.members?.find(m => m.id === S.data?.me);
  if (meRow) {
    meRow.name = name;
    meRow.email = email;
  }
  if (S.prefs) S.prefs.name = name;
  return !!(meRow || S.prefs);
}

/* ---------- google-only OAuth sign-in (Operance contract) ---------- */

/* The exact signInWithOAuth argument object, as one pure, testable
   function (AC1): same contract as workspace.operanceai.com — Google
   provider, back to the app origin, hd-restricted to the Operance
   domain, always showing the account chooser. */
export function googleOAuthArgs(redirectTo) {
  return {
    provider: 'google',
    options: {
      redirectTo,
      queryParams: {
        hd: 'operanceai.com',
        prompt: 'select_account',
      },
    },
  };
}

/* Kick off the Google OAuth flow. On success supabase-js redirects the
   browser to Google; on return the app boots fresh and the existing
   getSession() boot path hydrates the workspace. Provider errors (e.g.
   the backend has no Google provider configured) are thrown so the login
   surface can show them honestly. */
export async function signInWithGoogle(client, redirectTo) {
  const { data, error } = await client.auth.signInWithOAuth(googleOAuthArgs(redirectTo));
  if (error) throw new Error(errMessage(error));
  return data;
}

/* ---------- workspace document API (client passed in) ---------- */

/* SELECT the owner's workspace row, or null when they have none. */
export async function loadWorkspaceDoc(client, userId) {
  const { data, error } = await client.from(WORKSPACES_TABLE).select('id, name, data, updated_at').eq('owner_id', userId).maybeSingle();
  if (error) throw new Error(errMessage(error));
  return data;
}

/* UPSERT {data,prefs,views} for this owner. owner_id has a unique index,
   so this inserts on first login and updates afterwards. */
export async function upsertWorkspaceDoc(client, userId, payload, name) {
  const { data, error } = await client
    .from(WORKSPACES_TABLE)
    .upsert({ owner_id: userId, name: name || 'My workspace', data: payload }, { onConflict: 'owner_id' })
    .select()
    .single();
  if (error) throw new Error(errMessage(error));
  return data;
}

/* First login: create the row from seed (or current in-memory) state. */
export function bootstrapDocFromSeed(client, userId, seedDoc, prefs = {}, views = {}, name = 'My workspace') {
  return upsertWorkspaceDoc(client, userId, buildDocPayload(seedDoc, prefs, views), name);
}

/* ---------- auth wrappers (client passed in) ---------- */

export async function signInWithPassword(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(errMessage(error));
  return data;
}

export async function signUp(client, email, password, options = {}) {
  const { data, error } = await client.auth.signUp({ email, password, options });
  if (error) throw new Error(errMessage(error));
  return data;
}

export async function signOutUser(client) {
  const { error } = await client.auth.signOut();
  if (error) throw new Error(errMessage(error));
}

/* ---------- write-through sync ---------- */

/* One sync step: upsert the current doc triple. Returns 'ok' on success,
   'failed' on failure, and 'skipped' in local-only mode (no client or no
   signed-in user, e.g. a debounce that outlived a sign-out) — never
   throws. Callers must treat 'skipped' as a no-op, NOT as an error: only
   'failed' sets the caller's S.ui.offline flag so the UI can say so. */
export async function pushDocUpdate(client, userId, S, name) {
  if (!client || !userId) return 'skipped';
  try {
    await upsertWorkspaceDoc(client, userId, buildDocPayload(S.data, S.prefs, S.views), name);
    markSyncSuccess(S);
    return 'ok';
  } catch (err) {
    markSyncFailure(S, err);
    return 'failed';
  }
}

export function markSyncFailure(S, err, fallback) {
  if (!S.ui) S.ui = {};
  S.ui.offline = true;
  return errMessage(err, fallback);
}

/* Returns true when a live offline flag was cleared. */
export function markSyncSuccess(S) {
  if (S.ui?.offline) {
    S.ui.offline = false;
    return true;
  }
  return false;
}

/* Trailing-edge debounce for the sync timer: a burst of saves inside the
   window collapses into a single call with the latest payload. */
export function makeDebouncedSync(fn, ms = 500) {
  let timer = null;
  let lastArgs = null;
  const schedule = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, ms);
  };
  const flush = async () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    if (lastArgs) await fn(...lastArgs);
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return { schedule, flush, cancel };
}
