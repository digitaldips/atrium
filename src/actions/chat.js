/* =====================================================================
   CHAT ACTIONS · channels, DMs, threads, files, search, read state,
   realtime (Orbit integration T2)
   =====================================================================
   Rows persist to chat_channels/chat_members/chat_messages (migration
   0006) through supabase-js — the workspace document is untouched.
   Unread = channel.message_count − my member's read_count (Orbit's
   counters-not-COUNT): opening a channel writes last_read_at +
   read_count = message_count; the AFTER INSERT trigger bumps the
   counter. Realtime: ONE Postgres-changes channel per workspace while
   the chat route is open — INSERTs append to an open conversation and
   refresh the rail (unread math) everywhere else; render.js closes it
   on route leave (syncChatChannel('')). Every fetch orchestrator gates
   through shouldFetchState and re-checks its target after each await
   (T1's out-of-order lesson). Composer drafts live in CC so a realtime
   render mid-keystroke cannot clobber pending text (T1 MF-1 lesson).
   ------------------------------------------------------------------
   Trust boundaries: message/channel rows coerce through makeChat*;
   file refs validate like notes' validateAttachmentRef (4-segment
   chat path); names sanitize through safeAttachmentName before any
   upload; every rendered untrusted string is esc()'d in the page. */
import { $ } from '../core/utils.js';
import { S } from '../core/store.js';
import {
  CHAT_DEFAULT_NAME,
  CHAT_FILE_BUCKET,
  MAX_CHAT_BODY,
  MAX_CHAT_FILE_BYTES,
  chatFileRefFor,
  chatSearchFilter,
  dmKey,
  groupChatSearch,
  makeChatChannel,
  makeChatMessage,
  needsDefaultChannel,
  unreadCount,
} from '../core/chat.js';
import { shouldFetchState } from '../core/docs.js';
import { sb, getCurrentUser } from '../core/supabase.js';
import { errMessage } from '../core/workspace-api.js';
import { ensureWsId } from './docs.js';
import { toast } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { A, IN, KEY, confirmDlg } from './actions.js';
import { closeModal, openModal } from '../overlays/modals.js';

const MESSAGES_LIMIT = 300;
const SEARCH_LIMIT = 50;

/* Session-only cache of Postgres rows. Dies with the page load — S and
   the workspace doc stay out of it (zero doc keys). */
export const CC = {
  channels: [] /* coerced rows; each carries .members = chat_members embed rows */,
  railState: 'idle',
  railError: '',
  selId: '',
  messages: [],
  selState: 'idle',
  selError: '',
  thread: null /* root message id while a thread panel is open */,
  threadDraft: '',
  draft: '',
  files: null /* { channelId, rows } while the Files panel is open */,
  filesState: 'idle',
  filesError: '',
  search: null /* { q, groups, state, error } */,
  picker: null /* { rows, state, error } — DM candidates */,
  pickerState: 'idle',
  bootState: 'idle',
  bootWs: '',
  hl: '' /* message id to highlight after a search-result jump */,
};

export const myId = () => getCurrentUser();

function needChat() {
  if (S.ui.offline) {
    toast("You're offline — chat needs a connection.", { kind: 'err' });
    return false;
  }
  if (!sb) {
    toast("Chat needs a connection to Atrium's database.", { kind: 'err' });
    return false;
  }
  if (!getCurrentUser()) {
    toast('Sign in to use Chat.', { kind: 'err' });
    return false;
  }
  return true;
}

/* ---------- AC2: idempotent #general bootstrap ---------- */
export async function ensureChatBootstrap() {
  const wsId = await ensureWsId();
  if (!wsId || !sb || !getCurrentUser()) return;
  if (CC.bootState !== 'idle' && CC.bootWs === wsId) return;
  CC.bootWs = wsId;
  CC.bootState = 'loading';
  try {
    const { data, error } = await sb.from('chat_channels').select('id, name, is_default, kind, archived_at').eq('workspace_id', wsId);
    if (error) throw error;
    if (needsDefaultChannel(data || [])) {
      const ins = await sb
        .from('chat_channels')
        .insert({ workspace_id: wsId, kind: 'public', name: CHAT_DEFAULT_NAME, is_default: true, created_by: getCurrentUser() })
        .select('id')
        .maybeSingle();
      /* A concurrent boot could win the unique default index — refetch either way. */
      if (ins.error && ins.error.code !== '23505') throw ins.error;
    }
    /* My membership for #general (a member who joins later gets it here). */
    const gen = await sb.from('chat_channels').select('id').eq('workspace_id', wsId).eq('is_default', true).maybeSingle();
    if (gen.error) throw gen.error;
    if (gen.data?.id) {
      const up = await sb
        .from('chat_members')
        .upsert({ channel_id: gen.data.id, workspace_id: wsId, user_id: getCurrentUser() }, { onConflict: 'channel_id,user_id', ignoreDuplicates: true });
      if (up.error) throw up.error;
    }
    CC.bootState = 'ok';
    CC.railState = 'idle'; /* the bootstrap may have added a channel */
  } catch (e) {
    CC.bootState = 'error';
    toast(`Could not prepare chat — ${errMessage(e)}`, { kind: 'err' });
  }
  render(); /* the rail refetches (railState was re-armed) */
}

/* ---------- AC3: rail (channels + DMs + unread) ---------- */
export async function ensureChatRail() {
  if (!sb) {
    CC.railState = 'error';
    CC.railError = "Chat needs a connection to Atrium's database.";
    return;
  }
  if (!shouldFetchState(CC.railState)) return;
  CC.railState = 'loading';
  render();
  try {
    const wsId = await ensureWsId();
    if (!wsId) throw new Error('No workspace found for this account.');
    const { data, error } = await sb
      .from('chat_channels')
      .select('*, chat_members(user_id, last_read_at, read_count, joined_at)')
      .eq('workspace_id', wsId)
      .is('archived_at', null)
      .order('created_at');
    if (error) throw error;
    /* Stale response: the rail may have been re-targeted while in flight. */
    if (CC.railState !== 'loading') return;
    CC.channels = (data || [])
      .map(r => {
        const c = makeChatChannel(r);
        if (c) c.members = (r.chat_members || []).filter(Boolean);
        return c;
      })
      .filter(Boolean);
    CC.railState = 'ok';
  } catch (e) {
    CC.railState = 'error';
    CC.railError = errMessage(e, 'Could not load channels.');
  }
  render();
}

const myMember = c => (c.members || []).find(m => m.user_id === myId()) || null;

/* Rail sections: channels (default first, then by age) and DMs. */
export function railChannels() {
  const chans = CC.channels.filter(c => c.kind !== 'dm');
  return [...chans.filter(c => c.is_default), ...chans.filter(c => !c.is_default).sort((a, b) => String(a.name).localeCompare(String(b.name)))];
}
export const railDms = () => CC.channels.filter(c => c.kind === 'dm').sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

export function dmLabel(c) {
  const other = (c.members || []).find(m => m.user_id && m.user_id !== myId());
  if (!other) return 'Empty DM';
  return `Member ···${other.user_id.slice(-4)}`;
}

export const unreadOf = c => unreadCount(c, myMember(c));

/* ---------- AC8: read state ---------- */
async function markRead(channelId) {
  const c = CC.channels.find(x => x.id === channelId);
  const mem = c && myMember(c);
  if (!c || !mem || !sb || !getCurrentUser()) return;
  const now = new Date().toISOString();
  mem.last_read_at = now;
  mem.read_count = c.message_count || 0;
  const { error } = await sb
    .from('chat_members')
    .update({ last_read_at: now, read_count: c.message_count || 0 })
    .eq('channel_id', channelId)
    .eq('user_id', getCurrentUser());
  if (error) toast(`Could not mark the channel read — ${errMessage(error)}`, { kind: 'err' });
}

/* After MY OWN insert: my read catches up to the trigger-bumped counter. */
async function syncOwnRead(channelId) {
  const c = CC.channels.find(x => x.id === channelId);
  if (!c || !sb || !getCurrentUser()) return;
  const { data, error } = await sb.from('chat_channels').select('message_count').eq('id', channelId).maybeSingle();
  if (error || !data) return;
  c.message_count = data.message_count || 0;
  const mem = myMember(c);
  if (mem) {
    mem.read_count = c.message_count;
    mem.last_read_at = new Date().toISOString();
    await sb
      .from('chat_members')
      .update({ last_read_at: mem.last_read_at, read_count: mem.read_count })
      .eq('channel_id', channelId)
      .eq('user_id', getCurrentUser());
  }
  scheduleRailRefresh();
}

/* ---------- AC4: conversation (messages + threads) ---------- */
export async function ensureChatSel(id) {
  if (!id) {
    CC.selId = '';
    CC.messages = [];
    CC.selState = 'idle';
    CC.thread = null;
    return; /* the ws-level channel stays subscribed for rail refresh */
  }
  if (CC.selId === id && CC.selState !== 'idle') {
    /* Settled for this id — but a fresh search-result jump still needs its highlight. */
    if (S.ui.params.msg && S.ui.params.msg !== CC.hl) {
      CC.hl = S.ui.params.msg;
      setTimeout(scrollToHighlighted, 60);
    }
    return;
  }
  CC.selId = id;
  CC.selState = 'loading';
  CC.selError = '';
  CC.thread = null;
  CC.filesState = 'idle';
  render();
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, channel_id, parent_id, user_id, body, file, created_at, deleted_at')
      .eq('channel_id', id)
      .is('deleted_at', null)
      .order('created_at')
      .order('id')
      .limit(MESSAGES_LIMIT);
    if (error) throw error;
    /* Stale response: a newer selection won the race — this fetch must
       not mount the wrong conversation. */
    if (CC.selId !== id) return;
    CC.messages = (data || []).map(makeChatMessage).filter(Boolean);
    CC.selState = 'ok';
    await markRead(id);
    if (S.ui.params.msg) {
      CC.hl = S.ui.params.msg; /* search-result jump: highlight + scroll once */
      setTimeout(scrollToHighlighted, 60);
    } else {
      CC.hl = '';
      setTimeout(scrollChatBottom, 30);
    }
  } catch (e) {
    if (CC.selId !== id) return;
    CC.selState = 'error';
    CC.selError = errMessage(e, 'Could not load this conversation.');
  }
  render();
}

function scrollChatBottom() {
  const el = document.getElementById('chat-msgs');
  if (el) el.scrollTop = el.scrollHeight;
}

function scrollToHighlighted() {
  if (!CC.hl) return;
  const el = document.querySelector(`[data-mid="${CSS.escape(CC.hl)}"]`);
  if (el) el.scrollIntoView({ block: 'center' });
}

/* ---------- composer + send (AC4) ---------- */
IN.chatCompose = el => {
  CC.draft = el.value;
};

KEY.chatSend = () => A.chatSend();

A.chatSend = async () => {
  const channelId = CC.selId;
  const body = (CC.draft || '').trim();
  if (!channelId || !body || !needChat()) return;
  CC.draft = '';
  const ta = $('#chat-compose');
  if (ta) ta.value = '';
  render();
  await insertChatMessage({ channel_id: channelId, body });
};

/* One insert shared by composer, thread reply and file attach. */
async function insertChatMessage({ channel_id, body, parent_id = null }) {
  const me = getCurrentUser();
  const { data, error } = await sb
    .from('chat_messages')
    .insert({ channel_id, parent_id, user_id: me, body: String(body || '').slice(0, MAX_CHAT_BODY) })
    .select()
    .single();
  if (error) {
    toast(`Could not send — ${errMessage(error)}`, { kind: 'err' });
    return null;
  }
  const m = makeChatMessage(data);
  if (m && !CC.messages.some(x => x.id === m.id)) CC.messages.push(m);
  render();
  scrollChatBottom();
  await syncOwnRead(channel_id);
  return m;
}

/* ---------- AC6: files ---------- */
IN.chatFile = async el => {
  const file = el.files && el.files[0];
  el.value = '';
  if (!file) return;
  const channelId = CC.selId;
  if (!channelId || !needChat()) return;
  if (file.size > MAX_CHAT_FILE_BYTES) {
    toast(`“${file.name}” is over the 10 MB limit and was not uploaded.`, { kind: 'err' });
    return;
  }
  const wsId = await ensureWsId();
  if (!wsId) {
    toast("Can't reach the server.", { kind: 'err' });
    return;
  }
  const body = (CC.draft || '').trim();
  CC.draft = '';
  const ta = $('#chat-compose');
  if (ta) ta.value = '';
  const m = await insertChatMessage({ channel_id: channelId, body });
  if (!m) return;
  const ref = chatFileRefFor(file, wsId, channelId, m.id);
  if (!ref) {
    toast(`“${file.name}” could not be attached (name or size rejected) — the message posted without it.`, { kind: 'err' });
    return;
  }
  const up = await sb.storage.from(CHAT_FILE_BUCKET).upload(ref.path, file);
  if (up.error) {
    toast(`Message posted but the upload failed — ${errMessage(up.error)}`, { kind: 'err' });
    return;
  }
  const { data, error } = await sb.from('chat_messages').update({ file: ref }).eq('id', m.id).select().single();
  if (error || !data) {
    toast(`Upload stored but the message could not be linked — ${errMessage(error)}`, { kind: 'err' });
    return;
  }
  const fixed = makeChatMessage(data);
  if (fixed) CC.messages = CC.messages.map(x => (x.id === fixed.id ? fixed : x));
  CC.filesState = 'idle'; /* the Files panel must show the new file */
  render();
  toast(`Uploaded ${ref.name}`);
};

A.chatFileDl = async el => {
  const m = CC.messages.find(x => x.id === el.dataset.mid) || (CC.files?.rows || []).find(x => x.id === el.dataset.mid);
  const ref = m?.file;
  if (!ref || !sb) return;
  const { data, error } = await sb.storage.from(CHAT_FILE_BUCKET).createSignedUrl(ref.path, 300);
  if (error || !data?.signedUrl) {
    toast(`Download failed — ${errMessage(error)}`, { kind: 'err' });
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener');
};

/* Files panel (AC6): per-conversation list of messages that carry a file. */
A.chatFilesToggle = () => {
  S.ui.chat.filesOpen = !S.ui.chat.filesOpen;
  CC.filesState = 'idle';
  CC.files = null;
  render();
  ensureChatFiles();
};

export async function ensureChatFiles() {
  const id = CC.selId;
  if (!S.ui.chat.filesOpen || !id || !sb) return;
  if (CC.files && CC.files.channelId === id && CC.filesState !== 'idle') return;
  CC.files = { channelId: id, rows: [] };
  CC.filesState = 'loading';
  render();
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, channel_id, parent_id, user_id, body, file, created_at, deleted_at')
      .eq('channel_id', id)
      .not('file', 'is', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (CC.selId !== id || !CC.files || CC.files.channelId !== id) return; /* stale */
    CC.files = { channelId: id, rows: (data || []).map(makeChatMessage).filter(Boolean) };
    CC.filesState = 'ok';
  } catch (e) {
    if (!CC.files || CC.files.channelId !== id) return;
    CC.filesState = 'error';
    CC.filesError = errMessage(e, 'Could not load files.');
  }
  render();
}

/* ---------- AC5: threads ---------- */
A.chatThread = el => {
  const id = el.dataset.id || '';
  CC.thread = CC.thread === id ? null : id;
  CC.threadDraft = '';
  render();
  setTimeout(() => document.getElementById('chat-reply')?.focus(), 30);
};

A.chatThreadClose = () => {
  CC.thread = null;
  CC.threadDraft = '';
  render();
};

IN.chatReply = el => {
  CC.threadDraft = el.value;
};

A.chatReply = async () => {
  const root = CC.messages.find(x => x.id === CC.thread);
  const body = (CC.threadDraft || '').trim();
  if (!root || !body || !needChat()) return;
  CC.threadDraft = '';
  const ta = $('#chat-reply');
  if (ta) ta.value = '';
  await insertChatMessage({ channel_id: root.channel_id, parent_id: root.id, body });
};

/* ---------- delete (own messages) ---------- */
A.chatMsgDel = el => {
  const id = el.dataset.mid;
  const m = CC.messages.find(x => x.id === id);
  if (!m || m.user_id !== myId() || !needChat()) return;
  confirmDlg({
    title: 'Delete this message?',
    body: 'A message with thread replies stays as an empty placeholder so the thread keeps its context.',
    ok: 'Delete message',
    danger: true,
    run: async () => {
      const root = m.parent_id ? null : CC.messages.find(x => x.parent_id === m.id);
      const { error } = root
        ? await sb.from('chat_messages').update({ body: '', deleted_at: new Date().toISOString() }).eq('id', m.id)
        : await sb.from('chat_messages').delete().eq('id', m.id);
      if (error) return toast(`Could not delete — ${errMessage(error)}`, { kind: 'err' });
      if (CC.thread === m.id) CC.thread = null;
      CC.selState = 'idle'; /* refetch: the deleted root must show empty, not vanish */
      CC.filesState = 'idle';
      render();
      ensureChatSel(CC.selId);
      scheduleRailRefresh();
      toast('Message deleted');
    },
  });
};

/* ---------- AC7: search ---------- */
let searchT = null;

IN.chatQ = el => {
  S.ui.chat.q = el.value;
  CC.search = null; /* re-arm for the new query */
  render();
  clearTimeout(searchT);
  searchT = setTimeout(runChatSearch, 300);
};

export async function runChatSearch() {
  const q = (S.ui.chat.q || '').trim();
  if (!q || !sb) {
    CC.search = null;
    return;
  }
  if (CC.search && CC.search.q === q && CC.search.state !== 'idle') return;
  CC.search = { q, groups: [], state: 'loading' };
  render();
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, channel_id, parent_id, user_id, body, file, created_at')
      .is('deleted_at', null)
      .ilike('body', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(SEARCH_LIMIT);
    if (error) throw error;
    /* Stale response: the user typed a new query while this was in flight. */
    if ((S.ui.chat.q || '').trim() !== q) return;
    /* The client filter re-checks literally — ILIKE treats % and _ as wildcards. */
    const rows = chatSearchFilter(data || [], q);
    const groups = groupChatSearch(rows);
    /* Channel meta for groups not already on the rail (unjoined public channels). */
    const missing = groups.map(g => g.channelId).filter(cid => !CC.channels.some(c => c.id === cid));
    if (missing.length) {
      const { data: chans, error: cerr } = await sb.from('chat_channels').select('*').in('id', missing);
      if (!cerr) {
        for (const r of chans || []) {
          const c = makeChatChannel(r);
          if (c && !CC.channels.some(x => x.id === c.id)) {
            c.members = [];
            CC.channels.push(c);
          }
        }
      }
    }
    CC.search = { q, groups, state: 'ok' };
  } catch (e) {
    CC.search = { q, groups: [], state: 'error', error: errMessage(e, 'Search failed.') };
  }
  render();
}

A.chatQClear = () => {
  S.ui.chat.q = '';
  CC.search = null;
  clearTimeout(searchT);
  render();
  setTimeout(() => document.getElementById('chat-q')?.focus(), 0);
};

A.chatSearchRetry = () => {
  CC.search = null;
  runChatSearch();
};

/* Search result click: open the channel, highlight + scroll to the message. */
A.chatGoMsg = el => {
  go('chat', { id: el.dataset.chan || '', msg: el.dataset.mid || '' });
};

/* ---------- create channel / DM (AC3) ---------- */
A.chatNewChannel = () => {
  if (!needChat()) return;
  S.ui.chat.newName = '';
  S.ui.chat.newTopic = '';
  openModal({ type: 'chatNewChannel' });
};

IN.chatNewName = el => {
  S.ui.chat.newName = el.value;
};
IN.chatNewTopic = el => {
  S.ui.chat.newTopic = el.value;
};

A.chatChannelCreateGo = async () => {
  if (!needChat()) return;
  const name = (S.ui.chat.newName || '').trim().slice(0, 80);
  if (!name) {
    toast('Give the channel a name.', { kind: 'info' });
    return;
  }
  const wsId = await ensureWsId();
  if (!wsId) {
    toast("Can't reach the server.", { kind: 'err' });
    return;
  }
  const { data, error } = await sb
    .from('chat_channels')
    .insert({
      workspace_id: wsId,
      kind: 'public',
      name,
      topic: (S.ui.chat.newTopic || '').trim().slice(0, 250),
      created_by: getCurrentUser(),
    })
    .select()
    .single();
  if (error) {
    toast(`Could not create the channel — ${errMessage(error)}`, { kind: 'err' });
    return;
  }
  const c = makeChatChannel(data);
  if (c) {
    c.members = [];
    CC.channels.push(c);
  }
  const up = await sb.from('chat_members').upsert({ channel_id: data.id, workspace_id: wsId, user_id: getCurrentUser() }, { onConflict: 'channel_id,user_id' });
  if (up.error) toast(`Channel created but you could not join it — ${errMessage(up.error)}`, { kind: 'err' });
  closeModal();
  CC.railState = 'idle';
  render();
  go('chat', { id: data.id });
  toast(`Created #${name}`);
};

A.chatNewDm = () => {
  if (!needChat()) return;
  CC.picker = null;
  CC.pickerState = 'idle';
  openModal({ type: 'chatNewDm' });
  ensureChatPicker();
};

export async function ensureChatPicker() {
  if (CC.pickerState !== 'idle' || !sb) return;
  CC.pickerState = 'loading';
  render();
  try {
    const wsId = await ensureWsId();
    if (!wsId) throw new Error('No workspace found for this account.');
    const me = getCurrentUser();
    /* Real auth ids only: workspace_members I can read (owner sees the
       workspace's rows) + co-members of my channels. Doc members carry
       doc-local ids — not auth ids — so they are not candidates. */
    const ids = new Set();
    const { data: wm, error: werr } = await sb.from('workspace_members').select('user_id').eq('workspace_id', wsId);
    if (werr) throw werr;
    for (const r of wm || []) if (r.user_id && r.user_id !== me) ids.add(r.user_id);
    for (const c of CC.channels) for (const m of c.members || []) if (m.user_id && m.user_id !== me) ids.add(m.user_id);
    CC.picker = { rows: [...ids].sort(), state: 'ok' };
  } catch (e) {
    CC.picker = { rows: [], state: 'error', error: errMessage(e, 'Could not load members.') };
  }
  render();
}

A.chatDmCreateGo = async el => {
  if (!needChat()) return;
  const other = el.dataset.uid;
  const me = getCurrentUser();
  if (!other || other === me) return;
  const key = dmKey([me, other]);
  const existing = key && CC.channels.find(c => c.kind === 'dm' && c.dm_key === key);
  if (existing) {
    closeModal();
    return go('chat', { id: existing.id });
  }
  const wsId = await ensureWsId();
  if (!wsId) {
    toast("Can't reach the server.", { kind: 'err' });
    return;
  }
  const { data, error } = await sb.from('chat_channels').insert({ workspace_id: wsId, kind: 'dm', name: '', dm_key: key, created_by: me }).select().single();
  if (error) {
    toast(`Could not open the DM — ${errMessage(error)}`, { kind: 'err' });
    return;
  }
  const c = makeChatChannel(data);
  if (c) {
    c.members = [];
    CC.channels.push(c);
  }
  const up = await sb.from('chat_members').upsert(
    [
      { channel_id: data.id, workspace_id: wsId, user_id: me },
      { channel_id: data.id, workspace_id: wsId, user_id: other },
    ],
    { onConflict: 'channel_id,user_id' },
  );
  if (up.error) toast(`DM opened but membership failed — ${errMessage(up.error)}`, { kind: 'err' });
  closeModal();
  CC.railState = 'idle';
  render();
  go('chat', { id: data.id });
};

/* ---------- retry actions (reset exactly one fetch) ---------- */
A.chatSel = el => {
  const id = el.dataset.id || '';
  if (id === CC.selId && CC.selState === 'ok') markRead(id); /* re-open: read state refreshes anyway */
  go('chat', { id });
};
A.chatRetry = () => {
  CC.railState = 'idle';
  render();
};
A.chatSelRetry = () => {
  CC.selState = 'idle';
  ensureChatSel(CC.selId);
};
A.chatFilesRetry = () => {
  CC.filesState = 'idle';
  render();
  ensureChatFiles();
};
A.chatPickerRetry = () => {
  CC.picker = null;
  CC.pickerState = 'idle';
  render();
  ensureChatPicker();
};

/* ---------- realtime (AC4 cross-tab + rail unread) ---------- */
let rchan = null;
let rWs = '';
let railT = null;

function onChatInsert(payload) {
  const row = payload && payload.new;
  if (!row || !row.id) return;
  const m = makeChatMessage(row);
  if (!m || m.deleted_at) return;
  if (CC.selId === m.channel_id && !CC.messages.some(x => x.id === m.id)) {
    CC.messages.push(m);
    render();
    setTimeout(scrollChatBottom, 20);
  }
  scheduleRailRefresh();
}

/* Debounced rail refresh: message_count moved, so unread math changed. */
export function scheduleRailRefresh() {
  if (!sb) return;
  CC.railState = 'idle';
  clearTimeout(railT);
  railT = setTimeout(() => {
    railT = null;
    if (S.ui.route === 'chat') ensureChatRail();
  }, 400);
}

/* One workspace-wide Postgres-changes channel while the chat route is
   open; render.js closes it on route leave (T1's lifecycle pattern). */
export function syncChatChannel(wsId) {
  if (!sb) return;
  const target = wsId || '';
  if (rchan && rWs === target) return;
  if (rchan) {
    const old = rchan;
    rchan = null;
    sb.removeChannel(old);
  }
  rWs = target;
  if (!target) return;
  rchan = sb
    .channel('chat:ws:' + target)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, onChatInsert)
    .subscribe();
}

export { unreadCount };
