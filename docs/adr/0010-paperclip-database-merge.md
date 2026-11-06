# 0010 — Paperclip persists inside the Atrium Postgres instance (separate database)

Date: 2026-11-06 · Status: accepted · Workstream: atrium-paperclip-merge

## Context

Wesley runs Paperclip (open-source agent orchestration: companies, agents,
cases, approvals, budgets, activity audit; Node server + agent adapters that
spawn local processes such as Claude Code/OpenClaw) alongside Atrium (CRM ×
workspace × tasks; vanilla ES modules on a self-hosted Supabase stack). The
decision was taken to merge Paperclip into Atrium "to the fullest": its
actions, behavior, options, and stack must live in Atrium's database.

Constraints that shaped the decision:

1. Atrium's stack is Supabase: the `postgres` database's `public` schema is
   managed by Supabase migrations and exposed through PostgREST; `auth`,
   `storage`, `realtime` schemas are service-managed.
2. Paperclip's runtime cannot be Supabase-native: its adapters spawn OS
   processes (Claude Code, OpenClaw, bash) — edge functions cannot. Behavior
   parity (agents that actually run) is a hard requirement.
3. Paperclip's persistence is 168 tables (~200 upstream drizzle migrations);
   a shape-by-shape RLS port would take months and freeze behavior against
   upstream.

## Decision

Paperclip's entire persistence becomes a separate database `paperclip` INSIDE
the atrium-db Postgres instance (same instance, same container, same backups):
dump-restore 1:1 from the old paperclip-db, role `paperclip` owns everything,
the paperclip-server container joins `atrium_default` and connects to
`atrium-db:5437/paperclip`. The old `paperclip-db-1` container is stopped
(volume retained for rollback). Paperclip's server remains the execution
engine; Atrium surfaces agent actions/behavior/options in later tasks via a
service-role bridge (the established `user_integrations` access pattern).

## Alternatives rejected

- **Schema `paperclip` inside the `postgres` database (public schema)** —
  collides with Supabase-managed namespace conventions: migrations, PostgREST
  exposure, and grants all assume ownership of `public`; a foreign 168-table
  domain there risks supabase migration drift and accidental REST exposure.
- **Native Supabase port of the orchestration domain (tables + RLS + edge
  functions)** — loses behavior parity: no process spawning in edge
  functions, so agents could not execute; months of translation work that
  freezes against upstream Paperclip development. Revisit only if Atrium
  needs RLS-level integration for most agent surfaces.
- **Keep the separate paperclip-db container and only link UIs** — does not
  satisfy "stack into the database of Atrium"; keeps an extra postgres
  container alive on a memory-starved host.

## Consequences

- One Postgres instance backs both apps: fewer containers, one backup story.
  Atrium health checks must include the `paperclip` database (a crashed
  instance now takes down both apps — acceptable: same failure mode existed
  per-app before).
- Supabase's `postgres` database is untouched (verified: 12 public-schema
  objects before == after; only the database list grew by one).
- PostgREST cannot see `paperclip` (different database): Atrium-side reads
  must go through service-role edge functions with a direct connection
  string — the same trust boundary as `user_integrations`.
- Rollback: restart `paperclip-db-1` + revert compose DATABASE_URL host to
  `db:5432/paperclip` (documented in the workstream page HOW).
