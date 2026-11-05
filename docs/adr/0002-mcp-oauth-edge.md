# 2. MCP transport + self-hosted OAuth model

Date: 2026-11-05 · Status: accepted · Task: T4 atrium-mcp-agentic (Orbit integration)

## Decision

The MCP server is a single stateless edge function (`supabase/functions/mcp/`)
serving Streamable-HTTP JSON-RPC at `/functions/v1/mcp`, with a self-hosted
OAuth 2.0 + PKCE authorization layer in the same function and Postgres tables
(`oauth_clients`, `oauth_requests`, `oauth_grants`, `oauth_tokens`) — mirroring
Orbit's design (mcp.rs + 0035_mcp_oauth.sql) instead of delegating to an
external identity provider.

- Identity: the consent/approve/grants endpoints require the caller's Atrium
  GoTrue JWT; bearer tokens are SHA-256 hashes stored in `oauth_tokens`
  (hashes only, never plaintext), grants carry scope lists
  (tasks:read/tasks:write/docs:read/chat:read) that gate every tool call.
- Consent UX: authorize redirects to the app's `#agentic-auth` route; the app
  renders scopes and posts the approval with a one-time CSRF nonce whose hash
  rides the request row.
- Tool data: MCP reads/writes flow through the service role after the token
  check, scoping to the grant's user+workspace — the same last-writer-wins
  doc model the app itself uses; `update_task` carries the task's `updated`
  epoch as an optimistic-version token.

## Why

- Orbit's model is proven and matched Wesley's ask ("like Orbit, but in
  Atrium"): no external OAuth provider, no client secret, no API token.
- Atrium's stack is self-hosted Supabase with zero public services; an edge
  function needs no new infrastructure, reuses the JWT/user model, and keeps
  secrets out of the frontend entirely.
- Tables with RLS disabled + service-role-only grants keep token material
  unreachable from anon/authenticated clients by construction.

## Rejected alternatives

- External IdP (Auth0/WorkOS) as the OAuth provider: extra vendor + cost for a
  self-hosted app; Orbit explicitly runs without one.
- Long-lived personal API tokens instead of OAuth: no per-client revocation,
  no scoping, no consent UX — weaker than what Orbit ships.
- MCP stdio proxy on a host: unreachable for remote MCP clients; Streamable
  HTTP was required.

## Consequences

- Tool scope strings are enforced at tools/list and tools/call; adding a tool
  means wiring it into `required_scope`.
- Token single-use is enforced with a conditional PATCH
  (`refresh_used_at=is.null`); concurrent refresh losers burn the grant, so
  clients must treat refresh like Orbit's: one holder, replay = revocation.
- The `mcp` edge function is deployed by copying `supabase/functions/mcp/`
  into the stack's `volumes/functions/` and restarting the edge-runtime
  container (self-hosted recipe).
