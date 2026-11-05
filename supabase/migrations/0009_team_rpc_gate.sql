-- 0009: tighten atrium_find_user_id (T6 quality gate S1/MF1) — the RPC is
-- load-bearing in the membership-hijack chain: any bootstrapped user could
-- resolve any @operanceai.com email to an auth uuid. The caller must now
-- OWN the workspace they are inviting into.
CREATE OR REPLACE FUNCTION public.atrium_find_user_id(p_workspace_id uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'atrium_find_user_id: sign in required';
  END IF;
  IF p_workspace_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'atrium_find_user_id: workspace owners only';
  END IF;
  IF p_email IS NULL OR p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  RETURN v_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
-- The changed signature creates an overload; drop the old single-arg
-- version or the enumeration hole stays open through it.
DROP FUNCTION IF EXISTS public.atrium_find_user_id(text);
