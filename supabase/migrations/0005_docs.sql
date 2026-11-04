-- 0005_docs.sql · Docs module (Orbit integration T1)
--
-- docs_pages: one row per page in the nested page tree. Content is stored as
-- sanitized HTML (the notes model — NOT Orbit's BlockNote JSON) with
-- content_text powering full-text search via a generated tsvector column.
-- docs_versions: snapshots (auto ≥10 min rule, restore, import).
-- RLS: workspace members read/write, mirroring 0001's is_workspace_member
-- helper (SECURITY DEFINER there — reused, not redefined). DML-only grants.
-- The BEFORE UPDATE trigger bumps `version` on every content change: the
-- client's save path sends the version it read and a stale writer updates
-- zero rows (optimistic concurrency for live co-editing).

-- ---------- tables ----------
CREATE TABLE public.docs_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.docs_pages(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  icon text,
  content_html text NOT NULL DEFAULT '',
  content_text text NOT NULL DEFAULT '',
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content_text, ''))) STORED,
  position int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 0 CHECK (version >= 0),
  source jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX docs_pages_tree_idx ON public.docs_pages (workspace_id, parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX docs_pages_trash_idx ON public.docs_pages (workspace_id, deleted_at);
CREATE INDEX docs_pages_search_idx ON public.docs_pages USING gin (search);

CREATE TABLE public.docs_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES public.docs_pages(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  content_html text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('auto', 'restore', 'import')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX docs_versions_page_idx ON public.docs_versions (page_id, created_at DESC);

-- ---------- updated_at (reuse the 0001 helper) ----------
CREATE TRIGGER docs_pages_set_updated_at
  BEFORE UPDATE ON public.docs_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------- optimistic-concurrency version bump ----------
CREATE OR REPLACE FUNCTION public.docs_pages_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content_html IS DISTINCT FROM OLD.content_html
     OR NEW.content_text IS DISTINCT FROM OLD.content_text THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_pages_version_bump
  BEFORE UPDATE ON public.docs_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.docs_pages_bump_version();

-- ---------- row level security (owner or workspace members) ----------
-- The workspace owner is NOT a workspace_members row (0001's model:
-- owners hold access via owns_workspace, members via is_workspace_member)
-- so both helpers must pass. RLS on the live stack was verified with a
-- real owner JWT (insert allowed) and a foreign-user JWT (denied).
ALTER TABLE public.docs_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docs_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_member_all ON public.docs_pages
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id));

CREATE POLICY docs_versions_member_all ON public.docs_versions
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id));

-- ---------- stock ACLs (mirror 0001: DML-only, both roles; RLS denies anon) ----------
REVOKE ALL PRIVILEGES ON public.docs_pages, public.docs_versions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.docs_pages, public.docs_versions TO anon, authenticated;
GRANT ALL ON public.docs_pages, public.docs_versions TO postgres, service_role;