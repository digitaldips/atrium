-- 0007_mcp.sql · MCP server OAuth tables (Orbit integration T4)
--
-- Agentic access: MCP clients (Claude etc.) connect through an OAuth 2.0
-- authorization-code + PKCE flow. These tables mirror Orbit's 0035 shape,
-- adapted to Atrium's conventions:
--   oauth_clients   registered MCP clients (dynamic client registration)
--   oauth_grants    a user's approved connection: workspace + scope text[]
--   oauth_requests  in-flight authorizations; the issued code lives here as a
--                   hash, bound to the request row, SINGLE-USE (used_at)
--   oauth_tokens    access/refresh tokens — HASHES ONLY, never plaintext
--
-- Security posture mirrors user_integrations (0002): RLS enabled with ZERO
-- policies and all table privileges revoked from anon/authenticated — only
-- the service role (the mcp edge function) touches these tables.

-- ---------- tables ----------
CREATE TABLE public.oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES public.oauth_clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  scope text[] NOT NULL DEFAULT '{}',
  resource text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grants_user_idx ON public.oauth_grants (user_id, created_at DESC);
CREATE INDEX oauth_grants_client_idx ON public.oauth_grants (client_id);

CREATE TABLE public.oauth_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  state text,
  pkce text NOT NULL,
  resource text,
  scope text[] NOT NULL DEFAULT '{}',
  ip text,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  code_hash text UNIQUE,
  csrf_hash text,
  grant_id uuid REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  used_at timestamptz
);
CREATE INDEX oauth_requests_expiry_idx ON public.oauth_requests (expires_at);

CREATE TABLE public.oauth_tokens (
  access_hash text PRIMARY KEY,
  refresh_hash text NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  refresh_used_at timestamptz
);
CREATE INDEX oauth_tokens_grant_idx ON public.oauth_tokens (grant_id);

-- ---------- access: service role only (RLS zero policies) ----------
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.oauth_clients FROM anon, authenticated;
REVOKE ALL ON public.oauth_grants FROM anon, authenticated;
REVOKE ALL ON public.oauth_requests FROM anon, authenticated;
REVOKE ALL ON public.oauth_tokens FROM anon, authenticated;
GRANT ALL ON public.oauth_clients TO service_role;
GRANT ALL ON public.oauth_grants TO service_role;
GRANT ALL ON public.oauth_requests TO service_role;
GRANT ALL ON public.oauth_tokens TO service_role;