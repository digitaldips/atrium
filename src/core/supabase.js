/* =====================================================================
   SUPABASE CLIENT · the only side-effectful boundary to the backend.
   Vite bakes VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY at build time
   (from .env, which is gitignored — no key values in the repo). All pure
   logic lives in workspace-api.js and takes the client as an argument;
   this thin wrapper creates and shares the real client.
   ===================================================================== */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/* The client is null when env vars are absent (e.g. a build without
   .env): the app then runs in local-only mode — auth screens stay
   prototype-free, data lives in the localStorage cache only. */
export const sb =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

export const supabaseConfigured = !!sb;

/* The signed-in user id, set at boot/login/signup and cleared on
   sign-out. The debounced write-through sync in store.js reads it to
   decide whether an upsert should happen. */
let currentUserId = null;
export function setCurrentUser(id) {
  currentUserId = id;
}
export function getCurrentUser() {
  return currentUserId;
}
