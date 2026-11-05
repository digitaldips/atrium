-- 0008_team.sql · T6 team membership
--
-- 1. member_doc_update: a workspace MEMBER may update the shared workspace
--    row (the doc jsonb write path). Owners already have full access via
--    owner_full_access (0001). Two writers are LWW at doc granularity by
--    design (ADR 0003).
-- 2. atrium_find_user_id(p_email): owner-gated SECURITY DEFINER lookup of
--    an auth.users id by email — the invite flow resolves the invited
--    person's authUserId (identity bridge between doc-local member ids
--    and auth uuids). Owners only: calling requires owning a workspace,
--    so the platform-wide email directory is not exposed to members.
-- Zero other policy changes.

-- ---------- policies ----------
CREATE POLICY member_doc_update ON public.workspaces
  FOR UPDATE TO authenticated
  USING (public.is_workspace_member(id))
  WITH CHECK (public.is_workspace_member(id));

-- ---------- invite email -> auth uid (owner-gated) ----------
-- DROP first: CREATE OR REPLACE silently keeps an existing function's
-- original argument names (a rename needs a fresh CREATE).
DROP FUNCTION IF EXISTS public.atrium_find_user_id(text);
CREATE FUNCTION public.atrium_find_user_id(email text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'atrium_find_user_id: sign in required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.owner_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'atrium_find_user_id: workspace owners only';
  END IF;
  SELECT u.id INTO v_id FROM auth.users u WHERE lower(u.email) = lower(email) LIMIT 1;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.atrium_find_user_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atrium_find_user_id(text) TO authenticated;

NOTIFY pgrst, 'reload schema';