-- 0002_user_integrations.sql · per-user OAuth integration tokens
--
-- Stores the Google OAuth refresh token (Gmail + Calendar, read-only) for
-- each user. SECURITY MODEL: RLS is ENABLED with ZERO policies — anon and
-- authenticated rows are invisible and unwritable through PostgREST; only
-- the service role (bypasses RLS) may read/write. Edge functions access
-- the table with the service-role key; refresh tokens are never sent to
-- the browser.
--
-- ACLs are restocked explicitly (same reason as 0001): a fresh clone that
-- replays migrations manually loses default privileges, and defense in
-- depth here matters — tokens must never leak through a forgotten grant.

CREATE TABLE public.user_integrations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google',
  google_refresh_token text,
  google_email text,
  scopes text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.user_integrations FROM anon, authenticated;

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

-- Zero policies on purpose: the table is service-role-only. Nothing is
-- granted to anon/authenticated, and RLS denies everything else.