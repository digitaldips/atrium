-- 0006_chat.sql · Chat module (Orbit integration T2)
--
-- Port of Orbit's chat model (apps/server/migrations/0037_chat.sql) to
-- Atrium patterns — SHAPES, not stack:
--   chat_channels  ~ conversations (categories are NOT ported; the AC drops
--                    them): kind public|private|dm, name unique per
--                    workspace when kind<>dm, dm_key sorted-member-ids
--                    unique, #general is_default.
--   chat_members   ~ membership + read state. read_count is Orbit's
--                    counter: the channel's message_count at the member's
--                    last read, so unread = message_count - read_count is
--                    an O(1) subtraction, never a COUNT query.
--                    workspace_id is denormalized (pinned to the channel's
--                    workspace by a composite FK) so RLS stays a flat
--                    workspace check, mirroring Orbit's scope model.
--   chat_messages  ~ messages; parent_id marks a thread reply; file is a
--                    jsonb ref {name, path, size, type} into the private
--                    'chat' bucket at <ws>/<channel>/<message>/<name>.
-- RLS: workspace-member scoped, mirroring 0005's settled pattern
-- (0001's SECURITY DEFINER helpers reused — the owner is NOT a
-- workspace_members row, so BOTH is_workspace_member and owns_workspace
-- must pass). DML-only grants.
-- The AFTER INSERT trigger bumps the channel's message_count — the
-- counter the unread math and the rail read on.

-- ---------- tables ----------
CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 250),
  dm_key text,
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  message_count int NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL)),
  CHECK (kind = 'dm' OR length(name) >= 1),
  CHECK (is_default = false OR (kind = 'public' AND archived_at IS NULL))
);

CREATE UNIQUE INDEX chat_channels_dm_key_idx
  ON public.chat_channels (workspace_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX chat_channels_name_idx
  ON public.chat_channels (workspace_id, name) WHERE kind <> 'dm' AND archived_at IS NULL;
CREATE UNIQUE INDEX chat_channels_default_idx
  ON public.chat_channels (workspace_id) WHERE is_default;
CREATE INDEX chat_channels_ws_idx ON public.chat_channels (workspace_id, kind);

CREATE TABLE public.chat_members (
  channel_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz,
  read_count int NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id),
  -- pins the denormalized workspace to the channel's workspace
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES public.chat_channels(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX chat_members_user_idx ON public.chat_members (user_id);
CREATE INDEX chat_members_ws_idx ON public.chat_members (workspace_id, user_id);

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) <= 4000),
  file jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX chat_messages_channel_idx
  ON public.chat_messages (channel_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX chat_messages_thread_idx
  ON public.chat_messages (parent_id, created_at) WHERE parent_id IS NOT NULL;

-- ---------- updated_at (reuse the 0001 helper) ----------
CREATE TRIGGER chat_channels_set_updated_at
  BEFORE UPDATE ON public.chat_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------- unread counters (Orbit's model) ----------
CREATE OR REPLACE FUNCTION public.chat_messages_bump_channel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.chat_channels
  SET message_count = message_count + 1
  WHERE id = NEW.channel_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_messages_channel_bump
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.chat_messages_bump_channel();

-- ---------- row level security (owner or workspace members) ----------
-- Same settled pattern as 0005: owner via owns_workspace, members via
-- is_workspace_member (SECURITY DEFINER helpers from 0001 — reused, not
-- redefined). chat_messages has no workspace_id; the policy EXISTSes the
-- channel, whose RLS terminates in the definer helpers (no recursion).
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_channels_member_all ON public.chat_channels
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id));

CREATE POLICY chat_members_member_all ON public.chat_members
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id) OR public.owns_workspace(workspace_id));

CREATE POLICY chat_messages_member_all ON public.chat_messages
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_channels c
      WHERE c.id = chat_messages.channel_id
        AND (public.is_workspace_member(c.workspace_id) OR public.owns_workspace(c.workspace_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chat_channels c
      WHERE c.id = chat_messages.channel_id
        AND (public.is_workspace_member(c.workspace_id) OR public.owns_workspace(c.workspace_id))
    )
  );

-- ---------- stock ACLs (mirror 0001/0005: DML-only, both roles; RLS denies anon) ----------
REVOKE ALL PRIVILEGES ON public.chat_channels, public.chat_members, public.chat_messages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.chat_channels, public.chat_members, public.chat_messages
  TO anon, authenticated;
GRANT ALL ON public.chat_channels, public.chat_members, public.chat_messages TO postgres, service_role;

-- ---------- storage: private 'chat' bucket, one member-scoped policy ----------
-- Path convention: <workspaceId>/<channelId>/<messageId>/<safe name>.
-- The policy validates segments 1+2 against a real channel of a workspace
-- the caller belongs to (the same is_workspace_member/owns_workspace
-- pair). Segments 3+4 are the message id and the sanitized file name —
-- the client sanitizes the name (safeAttachmentName) and the ref is
-- re-validated at every hydration (validateChatFileRef).
-- NOTE the qualified storage.objects.name: inside the EXISTS the bare
-- `name` would bind to chat_channels.name (scope shadowing) and the
-- policy would silently deny everything.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chat', 'chat', false, 10485760)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760;

DROP POLICY IF EXISTS chat_objects_member_scoped ON storage.objects;
CREATE POLICY chat_objects_member_scoped ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'chat'
    AND EXISTS (
      SELECT 1 FROM public.chat_channels c
      WHERE c.workspace_id::text = COALESCE((storage.foldername(storage.objects.name))[1], '')
        AND c.id::text = COALESCE((storage.foldername(storage.objects.name))[2], '')
        AND (public.is_workspace_member(c.workspace_id) OR public.owns_workspace(c.workspace_id))
    )
  )
  WITH CHECK (
    bucket_id = 'chat'
    AND EXISTS (
      SELECT 1 FROM public.chat_channels c
      WHERE c.workspace_id::text = COALESCE((storage.foldername(storage.objects.name))[1], '')
        AND c.id::text = COALESCE((storage.foldername(storage.objects.name))[2], '')
        AND (public.is_workspace_member(c.workspace_id) OR public.owns_workspace(c.workspace_id))
    )
  );
