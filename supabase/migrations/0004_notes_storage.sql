-- 0004_notes_storage.sql · private attachment storage for Notes (AC4)
--
-- Bucket: 'atrium', PRIVATE, 10 MB per-object limit (the server-side
-- backstop; the client enforces the same cap with honest errors).
-- Path convention: <userId>/<noteId>/<filename> — the FIRST path segment
-- is the owner's auth uid, and that is exactly what the policy scopes by.
--
-- RLS: storage.objects gets ONE policy for authenticated users: every
-- operation (select/insert/update/delete) is allowed only when
-- bucket_id = 'atrium' AND the first folder of the object name equals the
-- caller's auth.uid(). No anon policy — anonymous JWTs get nothing.
-- Signed URLs (createSignedUrl) inherit the same SELECT check, so only
-- the owner can mint a download link for their own objects, and the
-- client keeps the expiry short (300 s).
--
-- Both statements are REPLAY-SAFE so re-running this file on an
-- already-migrated stack is a clean no-op (Postgres has no CREATE POLICY
-- IF NOT EXISTS): the bucket rides ON CONFLICT upsert, and the policy is
-- created only when pg_policies does not list it yet.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('atrium', 'atrium', false, 10485760)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'notes_objects_owner_scoped'
  ) THEN
    CREATE POLICY notes_objects_owner_scoped ON storage.objects
      FOR ALL TO authenticated
      USING (
        bucket_id = 'atrium'
        AND COALESCE((storage.foldername(name))[1], '') = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'atrium'
        AND COALESCE((storage.foldername(name))[1], '') = auth.uid()::text
      );
  END IF;
END $$;