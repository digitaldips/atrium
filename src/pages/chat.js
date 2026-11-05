/* =====================================================================
   CHAT · two-pane page (rail + conversation) with threads, files, search
   (Orbit integration T2)
   =====================================================================
   Rail: channels (unread = message_count − read_count, pure unreadOf)
   + Direct messages, new channel (public) and new DM (member picker)
   actions. Conversation: messages from Postgres (chat_messages, migration
   0006) through the session-only cache CC (src/actions/chat.js) — the
   workspace document gains NO new keys. Every untrusted string (body,
   names, topics, file names) is esc()'d; message bodies render as plain
   text (pre-wrap), never HTML. Threads open in a right-hand panel; the
   Files panel lists the conversation's messages that carry a file ref
   (validated at coercion) with signed-URL downloads.
   ===================================================================== */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { docSnippet } from '../core/docs.js';
import { fsize, empty } from '../ui/helpers.js';
import { groupChatThreads } from '../core/chat.js';
import {
  CC,
  dmLabel,
  ensureChatBootstrap,
  ensureChatFiles,
  ensureChatRail,
  ensureChatSel,
  myId,
  railChannels,
  railDms,
  runChatSearch,
  unreadOf,
} from '../actions/chat.js';

const ms = ts => {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : 0;
};

function ensureChatUi() {
  if (!S.ui.chat) S.ui.chat = { q: '', filesOpen: false, newName: '', newTopic: '' };
}

/* Author display: the caller's own name for their own rows; other users
   have no readable profile directory, so they render honestly as 'Member'. */
function authorName(uid) {
  if (!uid || uid === myId()) return S.prefs.name || 'You';
  return 'Member';
}

export function pageChat() {
  ensureChatUi();
  const selId = S.ui.params.id || '';
  /* Fetch orchestrators — every one gates on a settled state, so calling
     them on each render is safe (render → fetch → render terminates).
     Bootstrap runs first and re-renders when it creates #general, which
     re-arms the rail fetch. */
  ensureChatBootstrap();
  ensureChatRail();
  ensureChatSel(selId);
  if (S.ui.chat.filesOpen && selId) ensureChatFiles();
  if ((S.ui.chat.q || '').trim()) runChatSearch();
  const q = S.ui.chat.q || '';
  return `<div class="page flush">
    <div style="display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);flex:1;min-height:0" class="chat-grid">
      <style>@media(max-width:900px){.chat-grid{grid-template-columns:minmax(0,1fr)!important}.chat-rail{display:${selId ? 'none' : 'flex'}!important}.chat-conv{display:${selId ? 'flex' : 'none'}!important;position:fixed;inset:0;z-index:48;background:var(--surface)}}</style>
      <div class="chat-rail" style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
        <div style="padding:18px var(--gutter) 0" class="row"><h1 style="font-size:var(--fs-xl);margin:0;font-weight:600;letter-spacing:-.015em">Chat</h1><span class="sp"></span>
          <button class="btn btn-ghost btn-sm" data-a="chatNewDm" data-tip="New direct message" aria-label="New direct message">${ic('message-square', 13)}DM</button>
          <button class="btn btn-primary btn-sm" data-a="chatNewChannel">${ic('plus', 13)}Channel</button></div>
        <div class="row" style="padding:10px var(--gutter);gap:6px;border-bottom:1px solid var(--divider)">
          <input class="input" id="chat-q" data-in="chatQ" placeholder="Search messages" value="${esc(q)}" aria-label="Search messages" style="height:32px;font-size:13px;padding:6px 10px">
          ${q ? `<button class="btn btn-ghost btn-sm" data-a="chatQClear" aria-label="Clear search">${ic('x', 13)}</button>` : ''}
        </div>
        <div class="inbox-list" data-keep="chat-rail">${q ? searchArea() : railArea(selId)}</div>
      </div>
      <div class="chat-conv" style="display:flex;min-height:0;min-width:0">
        <div style="flex:1;display:flex;flex-direction:column;min-height:0;min-width:0">${conversationArea(selId)}</div>
        ${sidePanel()}
      </div>
    </div>
  </div>`;
}

/* ---------- left pane: rail / search results ---------- */

function railArea(selId) {
  if (CC.railState === 'loading')
    return '<div class="row" style="padding:14px var(--gutter)"><span class="faint" style="font-size:12.5px">Loading…</span></div>';
  if (CC.railState === 'error')
    return `<div class="row" style="padding:14px var(--gutter);gap:8px;align-items:center"><span class="muted" style="font-size:12.5px">${esc(CC.railError || 'Could not load channels.')}</span><button class="btn btn-secondary btn-sm" data-a="chatRetry">Retry</button></div>`;
  const chans = railChannels();
  const dms = railDms();
  if (!chans.length && !dms.length)
    return empty(
      'message-square',
      'No channels yet',
      'Create your first channel — #general is created automatically on first visit.',
      '<button class="btn btn-primary btn-sm" data-a="chatNewChannel">New channel</button>',
      'sm',
      3,
    );
  const item = (c, label) => {
    const unread = unreadOf(c);
    return `<div class="row" style="padding:8px 8px 8px var(--gutter);gap:8px;cursor:pointer;border-bottom:1px solid var(--divider);${selId === c.id ? 'background:var(--surface-2);' : ''}" data-a="chatSel" data-id="${esc(c.id)}" role="button" tabindex="0">
      <span class="faint" style="flex-shrink:0">${ic(c.kind === 'dm' ? 'message-square' : 'hash', 13)}</span>
      <span class="trunc" style="font-size:13px;${selId === c.id ? 'font-weight:600' : ''}${unread ? ';font-weight:600' : ''}">${esc(label)}</span>
      <span class="sp"></span>
      ${unread ? `<span class="ct dotc" style="flex-shrink:0">${unread}</span>` : ''}
    </div>`;
  };
  return `<div class="eyebrow" style="padding:12px var(--gutter) 4px">Channels</div>${chans.map(c => item(c, '#' + (c.name || 'channel'))).join('')}
    <div class="eyebrow" style="padding:14px var(--gutter) 4px">Direct messages</div>${
      dms.length
        ? dms.map(c => item(c, dmLabel(c))).join('')
        : '<div class="row" style="padding:6px var(--gutter)"><span class="faint" style="font-size:12px">No DMs yet — start one with the DM button.</span></div>'
    }`;
}

function searchArea() {
  const res = CC.search;
  if (!res || res.state === 'loading')
    return '<div class="row" style="padding:14px var(--gutter)"><span class="faint" style="font-size:12.5px">Searching…</span></div>';
  if (res.state === 'error')
    return `<div class="row" style="padding:14px var(--gutter);gap:8px;align-items:center"><span class="muted" style="font-size:12.5px">${esc(res.error)}</span><button class="btn btn-secondary btn-sm" data-a="chatSearchRetry">Retry</button></div>`;
  if (!res.groups.length)
    return empty('search', 'No messages match', `Nothing matches “${res.q}”. Search covers message text in every channel and DM.`, '', 'sm', 3);
  return res.groups
    .map(g => {
      const c = CC.channels.find(x => x.id === g.channelId);
      const label = c ? (c.kind === 'dm' ? dmLabel(c) : '#' + (c.name || 'channel')) : 'Channel';
      return `<div class="eyebrow" style="padding:12px var(--gutter) 4px">${esc(label)}</div>${g.messages
        .map(
          m => `<div class="row" style="align-items:flex-start;gap:8px;padding:10px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer" data-a="chatGoMsg" data-chan="${esc(g.channelId)}" data-mid="${esc(m.id)}" role="button" tabindex="0">
        <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
          <div class="faint" style="font-size:11px">${esc(authorName(m.user_id))} · ${m.created_at ? ago(ms(m.created_at)) : ''}</div>
          <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(docSnippet(m.body, res.q, 90))}</div>
        </div>
      </div>`,
        )
        .join('')}`;
    })
    .join('');
}

/* ---------- conversation pane ---------- */

function conversationArea(selId) {
  if (!selId)
    return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('message-square', 20)}</div><h2 class="es-h">Select a conversation</h2><p>Pick a channel or DM from the rail, or create one. Messages arrive live — keep the tab open.</p></div></div></div>`;
  const c = CC.channels.find(x => x.id === selId);
  if (CC.selState === 'loading' || (CC.selId !== selId && CC.selState !== 'idle'))
    return '<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><p class="faint">Loading conversation…</p></div></div></div>';
  if (CC.selState === 'error')
    return `<div class="fullstate"><div class="box">${empty('circle-alert', 'Could not load this conversation', CC.selError || 'Check your connection and retry.', '<button class="btn btn-secondary btn-sm" data-a="chatSelRetry">Retry</button>', '', 2)}</div></div>`;
  const title = c ? (c.kind === 'dm' ? dmLabel(c) : '#' + (c.name || 'channel')) : 'Conversation';
  const topic = c && c.topic ? `<span class="faint trunc" style="font-size:12px;max-width:320px">${esc(c.topic)}</span>` : '';
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <span class="faint">${ic(c && c.kind === 'dm' ? 'message-square' : 'hash', 14)}</span>
      <span class="trunc" style="font-weight:600;font-size:13.5px">${esc(title)}</span>
      ${topic}
      <span class="sp"></span>
      <button class="btn btn-secondary btn-sm ${S.ui.chat.filesOpen ? 'btn-primary' : ''}" data-a="chatFilesToggle" aria-pressed="${S.ui.chat.filesOpen ? 'true' : 'false'}">${ic('paperclip', 13)}Files</button>
    </div>
    <div id="chat-msgs" data-keep="chat-msgs" style="flex:1;overflow-y:auto;min-height:0;padding:14px 0">${messagesArea()}</div>
    ${composerArea()}`;
}

function messagesArea() {
  if (CC.selState !== 'ok' || !CC.selId) return '';
  if (!CC.messages.length)
    return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('message-square', 18)}</div><h2 class="es-h" style="font-size:15px">No messages yet</h2><p>Say hello — messages arrive live in every open tab.</p></div></div></div>`;
  return groupChatThreads(CC.messages)
    .map(r => {
      const mine = r.user_id === myId();
      const hl = CC.hl === r.id ? 'background:var(--surface-3);border-radius:10px;' : '';
      return msgRow(r, mine, hl);
    })
    .join('');
}

function msgRow(m, mine, hl) {
  const file = m.file
    ? `<button class="note-att" style="margin-top:6px" data-a="chatFileDl" data-mid="${esc(m.id)}" aria-label="Download ${esc(m.file.name)}">${ic('file-text', 13)}<span class="trunc" style="max-width:220px">${esc(m.file.name)}</span><span class="faint" style="font-size:11px;flex-shrink:0">${fsize(m.file.size)}</span><span class="faint">${ic('download', 12)}</span></button>`
    : '';
  return `<div class="msg-row ${mine ? 'msg-me' : ''}" data-mid="${esc(m.id)}" style="padding:6px 16px;gap:10px;display:flex;align-items:flex-start;${mine ? 'flex-direction:row-reverse;' : ''}${hl}">
    <span class="av sm" style="--c:var(--accent);flex-shrink:0;font-size:11px">${esc((authorName(m.user_id)[0] || 'M').toUpperCase())}</span>
    <div style="max-width:min(560px,78%);min-width:0">
      <div class="row" style="gap:8px;font-size:11.5px;${mine ? 'flex-direction:row-reverse;' : ''}">
        <span style="font-weight:600">${esc(authorName(m.user_id))}</span>
        <span class="faint">${m.created_at ? ago(ms(m.created_at)) : ''}</span>
      </div>
      ${m.body ? `<div class="msg-body" style="font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;${mine ? 'color:var(--text-1)' : ''}">${esc(m.body)}</div>` : m.file ? '' : '<div class="faint" style="font-size:12.5px;font-style:italic">Message deleted</div>'}
      ${file}
      <div class="row" style="gap:4px;margin-top:2px;${mine ? 'flex-direction:row-reverse;' : ''}">
        ${!m.parent_id ? `<button class="ibtn ibtn-xs" data-a="chatThread" data-id="${esc(m.id)}" data-tip="Reply in thread" aria-label="Reply in thread">${ic('corner-up-left', 12)}</button>` : ''}
        ${mine ? `<button class="ibtn ibtn-xs" data-a="chatMsgDel" data-mid="${esc(m.id)}" data-tip="Delete message" aria-label="Delete message">${ic('trash-2', 12)}</button>` : ''}
        ${!m.parent_id && m.replyCount ? `<button class="ct" style="flex-shrink:0;cursor:pointer" data-a="chatThread" data-id="${esc(m.id)}">${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}</button>` : ''}
      </div>
    </div>
  </div>`;
}

function composerArea() {
  return `<div style="border-top:1px solid var(--divider);padding:10px 16px;flex-shrink:0">
    <div class="row" style="gap:8px;align-items:flex-end">
      <label class="ibtn ibtn-sm" for="chat-file-in" data-tip="Attach a file" role="button" tabindex="0" aria-label="Attach a file" style="cursor:pointer">${ic('paperclip', 14)}</label>
      <input id="chat-file-in" type="file" data-in="chatFile" style="display:none" aria-hidden="true" tabindex="-1">
      <textarea id="chat-compose" data-in="chatCompose" data-key-enter="chatSend" data-autosize rows="1" placeholder="Message… (Enter to send, Shift+Enter for a new line)" aria-label="Message" style="flex:1;resize:none;font-size:13.5px">${esc(CC.draft)}</textarea>
      <button class="btn btn-primary btn-sm" data-a="chatSend" aria-label="Send message">${ic('send', 13)}Send</button>
    </div>
  </div>`;
}

/* ---------- right panel: thread (AC5) or files (AC6) ---------- */

function sidePanel() {
  if (CC.thread) return threadPanel();
  if (S.ui.chat.filesOpen) return filesPanel();
  return '';
}

function threadPanel() {
  const root = groupChatThreads(CC.messages).find(x => x.id === CC.thread);
  if (!root) return '';
  return `<div style="width:320px;border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0;flex-shrink:0">
    <div class="row" style="height:46px;padding:0 12px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <span style="font-weight:600;font-size:12.5px" class="trunc">Thread</span><span class="sp"></span>
      <button class="ibtn ibtn-sm" data-a="chatThreadClose" aria-label="Close thread">${ic('x', 14)}</button>
    </div>
    <div style="flex:1;overflow-y:auto;min-height:0;padding:10px 0">
      ${msgRow(root, root.user_id === myId(), '')}
      <div class="eyebrow" style="padding:10px 12px 4px">${root.replyCount || 0} ${root.replyCount === 1 ? 'reply' : 'replies'}</div>
      ${root.replies.map(r => msgRow(r, r.user_id === myId(), '')).join('')}
    </div>
    <div style="border-top:1px solid var(--divider);padding:10px 12px;flex-shrink:0">
      <textarea id="chat-reply" data-in="chatReply" data-key-enter="chatReply" data-autosize rows="1" placeholder="Reply in thread… (Enter to send)" aria-label="Thread reply" style="width:100%;resize:none;font-size:13px">${esc(CC.threadDraft)}</textarea>
    </div>
  </div>`;
}

function filesPanel() {
  const st = CC.filesState;
  let body;
  if (st === 'loading') body = '<div class="row" style="padding:14px 12px"><span class="faint" style="font-size:12.5px">Loading files…</span></div>';
  else if (st === 'error')
    body = `<div class="row" style="padding:14px 12px;gap:8px;align-items:center"><span class="muted" style="font-size:12.5px">${esc(CC.filesError || 'Could not load files.')}</span><button class="btn btn-secondary btn-sm" data-a="chatFilesRetry">Retry</button></div>`;
  else if (!CC.files || !CC.files.rows.length)
    body = '<div class="row" style="padding:14px 12px"><span class="faint" style="font-size:12.5px">No files in this conversation yet.</span></div>';
  else
    body = CC.files.rows
      .map(
        m => `<div class="note-att" style="padding:8px 12px">
      <span class="faint">${ic('file-text', 13)}</span>
      <div class="grow" style="min-width:0">
        <div class="trunc" style="font-size:12.5px;font-weight:500">${esc(m.file ? m.file.name : '')}</div>
        <div class="faint" style="font-size:11px">${m.file ? fsize(m.file.size) : ''} · ${esc(authorName(m.user_id))} · ${m.created_at ? ago(ms(m.created_at)) : ''}</div>
      </div>
      <button class="ibtn ibtn-xs" data-a="chatFileDl" data-mid="${esc(m.id)}" data-tip="Download" aria-label="Download ${esc(m.file ? m.file.name : 'file')}">${ic('download', 12)}</button>
    </div>`,
      )
      .join('');
  return `<div style="width:300px;border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0;flex-shrink:0">
    <div class="row" style="height:46px;padding:0 12px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <span style="font-weight:600;font-size:12.5px">Files</span><span class="sp"></span>
      <button class="ibtn ibtn-sm" data-a="chatFilesToggle" aria-label="Close files">${ic('x', 14)}</button>
    </div>
    <div style="flex:1;overflow-y:auto;min-height:0">${body}</div>
  </div>`;
}

/* ---------- modals (registered in overlays/modals.js) ---------- */

export function chatNewChannelModal(m, H) {
  return `${H('New channel', 'Public channels are visible to the whole workspace; private ones only to people you add later')}
    <div class="modal-b">
      <div class="field"><label class="label" for="chat-new-name">Name</label>
        <input class="input" id="chat-new-name" data-in="chatNewName" value="${esc(S.ui.chat?.newName || '')}" placeholder="e.g. design-reviews" maxlength="80" autofocus>
      </div>
      <div class="field"><label class="label" for="chat-new-topic">Topic <span class="faint">(optional)</span></label>
        <input class="input" id="chat-new-topic" data-in="chatNewTopic" value="${esc(S.ui.chat?.newTopic || '')}" placeholder="What is this channel for?" maxlength="250">
      </div>
      <div class="field"><label class="label" for="chat-new-kind">Visibility</label>
        <select class="select" id="chat-new-kind" data-in="chatNewKind" aria-label="Channel visibility">
          <option value="public" ${S.ui.chat?.newKind === 'private' ? '' : 'selected'}>Public — everyone in the workspace</option>
          <option value="private" ${S.ui.chat?.newKind === 'private' ? 'selected' : ''}>Private — invited people only</option>
        </select>
      </div>
      <p class="faint" style="font-size:11.5px;margin:6px 0 0">You join the channel as its first member. #general cannot be created here — it exists by default.</p>
    </div>
    <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="chatChannelCreateGo">Create channel</button></div>`;
}

export function chatNewDmModal(m, H) {
  const p = CC.picker;
  let body;
  if (p && p.state === 'loading') body = '<p class="faint" style="font-size:12.5px">Loading members…</p>';
  else if (p && p.state === 'error')
    body = `<div class="row" style="gap:8px"><span class="muted" style="font-size:12.5px">${esc(p.error)}</span><button class="btn btn-secondary btn-sm" data-a="chatPickerRetry">Retry</button></div>`;
  else if (!p || !p.rows.length)
    body =
      '<p class="muted" style="font-size:12.5px">No members to message yet. DMs open between workspace members — when someone else is a member of this workspace (or shares a channel with you), they appear here.</p>';
  else
    body = p.rows
      .map(
        uid => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--divider);gap:8px">
        <span class="av sm" style="--c:var(--accent)">M</span>
        <span class="trunc grow" style="font-size:13px">Member ···${esc(uid.slice(-4))}</span>
        <button class="btn btn-secondary btn-sm" data-a="chatDmCreateGo" data-uid="${esc(uid)}">Message</button>
      </div>`,
      )
      .join('');
  return `${H('New direct message', 'Direct messages are private between the two of you')}
    <div class="modal-b">
      <div class="field"><label class="label">Workspace members</label>${body}</div>
    </div>
    <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Close</button></div>`;
}
