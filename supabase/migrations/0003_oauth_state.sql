-- 0003_oauth_state.sql · per-flow, expiring, single-use OAuth state
--
-- Makes the Google OAuth round-trip state per-flow (F2): authorize mints a
-- fresh nonce per flow and stores it (with a 10-minute expiry) next to the
-- user's integration row; the callback requires the row to still hold THIS
-- nonce and consumes it BEFORE exchanging the authorization code. A leaked
-- or replayed state can therefore no longer bind a different Google account
-- into the victim's row: replay after consumption fails, expired flows fail,
-- superseded flows (a newer authorize overwrote the nonce) fail.
--
-- RLS and grants are UNCHANGED on purpose: the table stays service-role-only
-- (RLS enabled, zero policies, anon/authenticated revoked in 0002). Only the
-- pending-nonce columns are added.

ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS pending_nonce text;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS pending_expires timestamptz;