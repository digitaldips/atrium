/* =====================================================================
   CHAT · pure data layer for the Chat module (Orbit integration T2)
   Data-in/data-out only (no DOM, no store, no network) so dm_key
   building, unread math (counters, not COUNT — Orbit 0037's model),
   thread grouping, search filtering/grouping, the default-channel
   bootstrap check and the file-ref trust boundary run in plain node
   tests. Rows live in Postgres (chat_channels/chat_members/chat_messages,
   migration 0006) — the workspace document gains NO new keys. Filename
   sanitization reuses notes.js's safeAttachmentName (one sanitizer).
   ===================================================================== */
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from './notes.js';

export const CHAT_DEFAULT_NAME = 'general';
export const CHAT_FILE_BUCKET = 'chat';
export const MAX_CHAT_FILE_BYTES = MAX_ATTACHMENT_BYTES; // 10 MB — client gate, bucket limit is the backstop
export const MAX_CHAT_BODY = 4000; // mirrors the chat_messages body CHECK

/* ---------- AC1/AC3: dm_key ---------- */
/* The sorted member ids joined by ',' so one set of people has exactly
   one DM (unique index on (workspace_id, dm_key) enforces it server-side).
   Fewer than two people is not a DM → null. */
export function dmKey(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : []).map(id => String(id ?? '').trim()).filter(Boolean);
  const uniq = [...new Set(ids)].sort();
  return uniq.length >= 2 ? uniq.join(',') : null;
}

/* ---------- AC8: unread counts (Orbit's counters-not-COUNT) ---------- */
/* chat_members carries read_count (the channel message_count at the member's
   last read) next to last_read_at; the send/trigger bumps message_count.
   Unread is an O(1) subtraction the DB already knows — never a COUNT query. */
export function unreadCount(channel, member) {
  const total = Number(channel && channel.message_count);
  const read = Number(member && member.read_count);
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, total - (Number.isFinite(read) ? read : 0));
}

/* ---------- AC2: default-channel bootstrap ---------- */
/* Idempotent ensureChatBootstrap runs when the workspace has no #general
   yet (is_default). Pure decision, Postgres write in the action layer. */
export function needsDefaultChannel(channels) {
  return !(Array.isArray(channels) ? channels : []).some(c => c && c.is_default);
}

/* ---------- AC5: thread grouping ---------- */
/* Flat rows → ordered roots with nested replies. Roots sort by created_at
   (oldest first, chat style). A deleted root that still has replies stays
   as the thread container (empty body); deleted replies drop; a reply
   whose parent is absent degrades to nothing instead of an orphan row.
   Junk rows are skipped, never fatal. */
export function groupChatThreads(rows) {
  const byId = new Map();
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || !r.id || byId.has(r.id)) continue;
    if (r.deleted_at && r.parent_id) continue; /* deleted replies drop */
    byId.set(r.id, { ...r, replies: [] });
  }
  const roots = [];
  for (const n of byId.values()) {
    if (n.parent_id && byId.has(n.parent_id) && n.parent_id !== n.id) {
      byId.get(n.parent_id).replies.push(n);
    } else if (!n.parent_id || !byId.has(n.parent_id)) {
      if (n.parent_id) continue; /* orphaned reply → no container, drop */
      roots.push(n);
    }
  }
  const cmp = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));
  for (const n of byId.values()) n.replies.sort(cmp);
  roots.sort(cmp);
  for (const n of roots) n.replyCount = n.replies.length;
  return roots;
}

/* ---------- AC7/AC9: search ---------- */
/* Client-side confirmation filter over the server's ILIKE candidates:
   a literal case-insensitive substring. User input with % / _ must NOT
   act as a wildcard here (PostgREST's ilike pattern would treat it so). */
export function chatSearchFilter(rows, q) {
  const needle = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return [];
  return (Array.isArray(rows) ? rows : []).filter(
    r =>
      r &&
      typeof r === 'object' &&
      String(r.body ?? '')
        .toLowerCase()
        .includes(needle),
  );
}

/* Group search hits by channel: newest channel first, within a group
   oldest first (reading order once the channel opens). */
export function groupChatSearch(rows) {
  const groups = new Map();
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object' && r.channel_id);
  for (const r of list) {
    if (!groups.has(r.channel_id)) groups.set(r.channel_id, []);
    groups.get(r.channel_id).push(r);
  }
  const out = [];
  for (const [channelId, messages] of groups) {
    messages.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id)));
    out.push({ channelId, messages, newestAt: messages[messages.length - 1]?.created_at ?? '' });
  }
  out.sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)));
  return out;
}

/* ---------- AC6/AC10: file refs (storage bucket 'chat') ---------- */
/* Path convention: <workspaceId>/<channelId>/<messageId>/<safe name> —
   exactly what the storage.objects RLS policy validates segment-wise. */
export function chatFilePath(wsId, channelId, messageId, name) {
  const safe = safeAttachmentName(name);
  if (!wsId || !channelId || !messageId || !safe) return '';
  return `${wsId}/${channelId}/${messageId}/${safe}`;
}

/* Build a ref for a File-like object; oversize/junk returns null — the
   caller shows the honest error and never uploads. */
export function chatFileRefFor(file, wsId, channelId, messageId) {
  const f = file && typeof file === 'object' ? file : null;
  if (!f || !wsId || !channelId || !messageId) return null;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size < 0 || size > MAX_CHAT_FILE_BYTES) return null;
  const name = safeAttachmentName(f.name);
  const path = chatFilePath(wsId, channelId, messageId, name);
  if (!path) return null;
  return { name, path, size, type: typeof f.type === 'string' ? f.type : '' };
}

/* The trust boundary for refs that ARRIVE from Postgres (another tab, a
   sync): path must be the 4-segment chat shape ending in the name. Junk
   → null, dropped at coercion and rendering. */
export function validateChatFileRef(a) {
  const r = a && typeof a === 'object' ? a : null;
  if (!r) return null;
  const name = typeof r.name === 'string' ? r.name : '';
  const path = typeof r.path === 'string' ? r.path : '';
  const size = Number(r.size);
  const type = typeof r.type === 'string' ? r.type : null;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.length > 255) return null;
  const parts = path.split('/');
  if (parts.length !== 4 || parts.some(p => !p)) return null;
  if (parts[3] !== name) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  if (type === null) return null;
  return { name, path, size, type };
}

/* ---------- row coercion (hydration trust boundary) ---------- */
/* One chat_messages row → honest normalized shape; the file ref passes
   validateChatFileRef (junk → null), unknown fields drop. */
export function makeChatMessage(input) {
  if (!input || typeof input !== 'object') return null;
  const id = typeof input.id === 'string' && input.id ? input.id : null;
  if (!id) return null;
  const file = validateChatFileRef(input.file);
  return {
    id,
    channel_id: typeof input.channel_id === 'string' ? input.channel_id : '',
    parent_id: typeof input.parent_id === 'string' && input.parent_id ? input.parent_id : null,
    user_id: typeof input.user_id === 'string' && input.user_id ? input.user_id : null,
    body: input.body == null ? '' : String(input.body),
    file,
    created_at: input.created_at ?? null,
    deleted_at: input.deleted_at ?? null,
  };
}

/* One chat_channels row → honest shape; a bad kind or missing id is
   refused outright. */
export function makeChatChannel(input) {
  if (!input || typeof input !== 'object') return null;
  const id = typeof input.id === 'string' && input.id ? input.id : null;
  if (!id) return null;
  const kind = input.kind;
  if (kind !== 'public' && kind !== 'private' && kind !== 'dm') return null;
  const mc = Number(input.message_count);
  return {
    id,
    workspace_id: typeof input.workspace_id === 'string' ? input.workspace_id : '',
    kind,
    name: input.name == null ? '' : String(input.name),
    topic: input.topic == null ? '' : String(input.topic),
    dm_key: typeof input.dm_key === 'string' && input.dm_key ? input.dm_key : null,
    is_default: !!input.is_default,
    archived_at: input.archived_at ?? null,
    message_count: Number.isFinite(mc) && mc >= 0 ? Math.floor(mc) : 0,
    created_by: input.created_by ?? null,
    created_at: input.created_at ?? null,
    updated_at: input.updated_at ?? null,
  };
}
