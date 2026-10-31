/* ---------- INBOX ---------- */
import { MOD, ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, client, commentsOf, crmClients, crmLinks, mem, pColor, proj, task } from '../core/store.js';
import { findLink, goneMailPreview, mailSuggestion } from '../core/links.js';
import { googleStatus, ensureGmail, ensureGmailLabels, ensureGmailDrafts } from '../core/google.js';
import { mergeInbox, safeLink, bulkSelectionWarning } from '../../supabase/functions/_shared/google-pure.js';
import { av, empty, fmtComment, fsize } from '../ui/helpers.js';
import { sanitizeMailHtml } from '../core/sanitize.js';
import { cellAssignee, cellDue, cellPrio, cellStatus } from '../components/task-list.js';
import { commentHtml } from '../overlays/drawer.js';

export function pageInbox() {
  const cats = [
    ['all', 'All'],
    ['mention', 'Mentions'],
    ['assign', 'Assignments'],
    ['comment', 'Comments'],
    ['update', 'Updates'],
    ['gmail', 'Gmail'],
  ];
  const cat = S.ui.inboxCat;
  const gcat = cat === 'gmail';
  const g = googleStatus();
  if ((gcat || cat === 'all') && g.connected) {
    ensureGmail(); // fetch-on-render; no-op once cached
    if (gcat) {
      ensureGmailLabels();
      if (S.ui.gview === 'drafts') ensureGmailDrafts();
    }
  }
  const notifs = D()
    .notifs.slice()
    .sort((a, b) => b.at - a.at);
  const gmsgs = S.ui.gmsgs || [];
  const count = k => (k === 'gmail' ? gmsgs.filter(m => m.unread).length : notifs.filter(n => (k === 'all' || n.type === k) && !n.read).length);
  /* One merged, time-sorted stream for every non-gmail category (pure
     mergeInbox — the tested kind tags + filter semantics); the gmail
     category keeps its dedicated list below. */
  const rows = gcat ? null : mergeInbox(notifs, gmsgs, { cat, unreadOnly: S.ui.inboxUnread });
  const sel = D().notifs.find(n => n.id === S.ui.inboxSel) || null;
  /* The selected gmail row normally comes from the fetched list; a message
     opened by click-through (task drawer / client detail) may only exist in
     the deep-read cache — that cache carries the same header fields, so
     the preview still renders honestly instead of showing a blank pane. */
  const gsel =
    gmsgs.find(m => m.id === S.ui.gsel) ||
    ((S.ui.gmsg = S.ui.gmsg || {})[S.ui.gsel] && S.ui.gmsg[S.ui.gsel].state === 'ok' ? S.ui.gmsg[S.ui.gsel].msg : null) ||
    ((S.ui.gmsg || {})[S.ui.gsel] && S.ui.gmsg[S.ui.gsel].state === 'error' ? goneMailPreview(S.ui.gsel, D().links) : null);
  return `<div class="page flush">
    <div style="display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);flex:1;min-height:0" class="inbox-grid">
      <style>@media(max-width:900px){.inbox-grid{grid-template-columns:minmax(0,1fr)!important}.inbox-prev{display:${sel || gsel ? 'flex' : 'none'}!important;position:fixed;inset:0;z-index:48;background:var(--surface)}}</style>
      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
        <div style="padding:18px var(--gutter) 0" class="row"><h1 style="font-size:var(--fs-xl);margin:0;font-weight:600;letter-spacing:-.015em">Inbox</h1><span class="sp"></span>
          ${
            gcat
              ? `<span class="row" style="gap:6px;font-size:12px;color:var(--text-2)">${ic('mail', 14)}${g.connected ? `Google · ${esc(g.email || 'connected')}` : 'Not connected'}</span>${
                  g.connected ? ` <button class="btn btn-secondary btn-sm" data-a="gCompose">${ic('pencil', 13)}Compose</button>` : ''
                }`
              : `<label class="row" style="font-size:12px;color:var(--text-2);gap:6px;cursor:pointer"><input type="checkbox" class="toggle" data-a="toggleUnreadOnly" ${S.ui.inboxUnread ? 'checked' : ''}>Unread</label>
          <button class="ibtn ibtn-sm" data-a="markAllRead" data-tip="Mark all as read" aria-label="Mark all as read">${ic('check-check', 15)}</button>`
          }</div>
        <div class="tabs inbox-tabs" role="tablist">${cats.map(([k, n]) => `<button role="tab" class="tab ${cat === k ? 'on' : ''}" data-a="set" data-k="inboxCat" data-v="${k}">${n}${count(k) ? `<span class="cnt">${count(k)}</span>` : ''}</button>`).join('')}</div>
        ${gcat && g.connected ? gmailChips() : ''}
        ${gcat && g.connected ? gmailBulkBar() : ''}
        ${gcat && g.connected ? gmailSearchBar() : ''}
        <div class="inbox-list" data-keep="inbox-list">${gcat ? gmailList(g, gmsgs) : mergedList(rows, sel)}</div>
      </div>
      <div class="inbox-prev" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">${gsel ? gmailPreview(gsel) : gcat ? `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('mail', 20)}</div><h2 class="es-h">Select a message</h2><p>Recent Gmail messages open here as a read-only preview.</p></div></div></div>` : sel ? inboxPreview(sel) : `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('mail-open', 20)}</div><h2 class="es-h">Select a notification</h2><p>Read the conversation and reply without leaving your inbox.</p></div></div></div>`}</div>
    </div>
  </div>`;
}

/* ---------- Gmail chips: view + label filters ---------- */

/* Session-scoped filter state: S.ui.gview ('mail' | 'drafts') and
   S.ui.glabel ('' = the INBOX list). Selecting a chip re-arms the list
   fetch; user labels manage inline (create, delete — system refused). */
function gmailChips() {
  const labels = (S.ui.glabels = S.ui.glabels || { state: 'idle', items: [] });
  const userLabels = labels.items.filter(l => l.type === 'user');
  const chip = (on, label, attrs, extra = '') =>
    `<span class="row" style="gap:2px"><button type="button" class="gchip ${on ? 'on' : ''}" ${attrs}>${label}</button>${extra}</span>`;
  const drafts = S.ui.gdrafts || { state: 'idle', items: [] };
  const draftCount = drafts.state === 'ok' ? drafts.items.length : 0;
  const labelChip = l =>
    chip(
      S.ui.gview === 'mail' && S.ui.glabel === l.id,
      esc(l.name),
      `data-a="gLabelChip" data-id="${esc(l.id)}"`,
      l.type === 'user'
        ? `<button class="ibtn ibtn-xs" data-a="gLabelDelete" data-id="${esc(l.id)}" data-tip="Delete label “${esc(l.name)}”" aria-label="Delete label ${esc(l.name)}">${ic('x', 11)}</button>`
        : '',
    );
  return `<div class="row" style="padding:8px var(--gutter) 0;gap:6px;flex-wrap:wrap;align-items:center">
    ${chip(S.ui.gview === 'mail' && !S.ui.glabel, ic('inbox', 13) + '<span>Inbox</span>', 'data-a="gMailChip"')}
    ${chip(S.ui.gview === 'mail' && S.ui.glabel === 'STARRED', ic('star', 13) + '<span>Starred</span>', 'data-a="gLabelChip" data-id="STARRED"')}
    ${userLabels.map(labelChip).join('')}
    ${chip(S.ui.gview === 'drafts', ic('file', 13) + `<span>Drafts</span>${draftCount ? `<span class="cnt">${draftCount}</span>` : ''}`, 'data-a="gDraftsChip"')}
    <button class="ibtn ibtn-xs" data-a="gLabelNew" data-tip="New label" aria-label="Create label">${ic('plus', 13)}</button>
    ${labels.state === 'loading' ? `<span class="faint" style="font-size:11.5px" role="status">Loading labels…</span>` : ''}
  </div>`;
}

/* ---------- Gmail bulk bar (gselSet) ---------- */

/* Delete-forever has NO server undo — the copy says so; the button routes
   through an explicit confirm dialog (actions). Trash keeps Gmail's own
   30-day undo, so it does not need the double warning. */
function gmailBulkBar() {
  const n = S.ui.gselSet ? S.ui.gselSet.size : 0;
  if (!n) return '';
  /* F4: over the 50-id server clamp the actions disable with the honest
     warning — the selection is never silently truncated. */
  const over = bulkSelectionWarning(n);
  const dis = over ? 'disabled aria-disabled="true"' : '';
  return `<div class="bulkbar" role="toolbar" aria-label="Bulk actions"><b style="font-weight:600">${n} selected</b>${over ? `<span class="faint" style="font-size:11.5px">${esc(over)}</span>` : ''}<span class="sep"></span>
    <button class="btn btn-sm" data-a="gBulk" data-op="read" ${dis}>${ic('mail-open', 14)}Mark read</button>
    <button class="btn btn-sm" data-a="gBulk" data-op="unread" ${dis}>${ic('mail', 14)}Mark unread</button>
    <button class="btn btn-sm" data-a="gBulk" data-op="archive" ${dis}>${ic('archive', 14)}Archive</button>
    <button class="btn btn-sm" data-a="gBulk" data-op="trash" ${dis}>${ic('trash-2', 14)}Trash</button>
    <button class="btn btn-sm" data-a="gBulk" data-op="delete" ${dis} style="color:var(--red)">${ic('trash-2', 14)}Delete forever</button>
    <span class="sep"></span><button class="btn btn-sm" data-a="gBulkClear" aria-label="Clear selection">${ic('x', 14)}</button></div>`;
}

/* ---------- Merged 'all' list (workspace notifs + Gmail, one stream) ---------- */

/* rows come from the pure mergeInbox helper: kind-tagged, newest first.
   The Unread toggle filters BOTH kinds; gmail rows render unread dots via
   gmailItem. Gmail fetch states reuse the gmail category's semantics —
   'error' is terminal until Retry, so the inline alert + Retry button is
   the only recovery path (no auto-refetch loop). */
function mergedList(rows, sel) {
  const err =
    S.ui.gState === 'error'
      ? `<div style="padding:10px var(--gutter)"><div class="alert danger">${ic('triangle-alert', 16)}<div><b>Couldn't load your Gmail.</b><div class="muted" style="margin-top:2px">${esc(S.ui.gError || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gRetry" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button></div>`
      : '';
  if (!rows.length)
    return (
      err +
      empty(
        'inbox',
        "You're all caught up.",
        S.ui.inboxUnread ? 'No unread items in this inbox.' : 'New mentions, assignments, comments, and Gmail messages will show up here.',
        '',
        'sm',
      )
    );
  return err + rows.map(r => (r.kind === 'gmail' ? gmailItem(r.item, r.item.id === S.ui.gsel) : inboxItem(r.item, sel && sel.id === r.item.id))).join('');
}

/* ---------- Gmail lists (mail + drafts) ---------- */
function gmailList(g, msgs) {
  if (!g.loaded && !g.connected) return empty('mail', 'Checking Google…', 'One moment — asking whether your account is connected.', '', 'sm');
  if (!g.connected)
    return empty(
      'mail',
      'Connect Gmail',
      'Show your recent Gmail inbox right here, next to your Atrium notifications. Read-only — Atrium can never read more than you allow, send mail, or change anything.',
      `<button class="btn btn-primary btn-sm" data-a="googleConnect">${ic('mail', 14)}Connect Gmail</button>`,
      'sm',
      3,
    );
  if (S.ui.gview === 'drafts') return gmailDraftsList();
  if (S.ui.gSearchQ && S.ui.gSearch && S.ui.gSearch.state !== 'idle') return gmailSearchList(S.ui.gSearchQ);
  if (S.ui.gState === 'loading')
    return `<div style="padding:16px var(--gutter)" class="row muted" role="status">${ic('refresh-cw', 14)}Loading recent mail…</div>`;
  if (S.ui.gState === 'error')
    return `<div style="padding:16px var(--gutter)"><div class="alert danger">${ic('triangle-alert', 16)}<div><b>Couldn't load your Gmail.</b><div class="muted" style="margin-top:2px">${esc(S.ui.gError || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gRetry" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button></div>`;
  if (!msgs.length) return empty('mail', 'No recent mail', 'Your Gmail inbox is empty — messages will appear here when they arrive.', '', 'sm', 3);
  return msgs.map(m => gmailItem(m, m.id === S.ui.gsel, { bulk: true })).join('');
}

/* Drafts filter: open → the compose modal prefilled and draft-aware
   (Send uses draft/send, further saves update the same draft). */
function gmailDraftsList() {
  const d = S.ui.gdrafts || { state: 'idle', items: [] };
  if (d.state === 'loading') return `<div style="padding:16px var(--gutter)" class="row muted" role="status">${ic('refresh-cw', 14)}Loading drafts…</div>`;
  if (d.state === 'error')
    return `<div style="padding:16px var(--gutter)"><div class="alert danger">${ic('triangle-alert', 16)}<div><b>Couldn't load your drafts.</b><div class="muted" style="margin-top:2px">${esc(d.error || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gDraftsChip" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button></div>`;
  if (!d.items.length) return empty('file', 'No drafts', 'Compose a message and hit Save draft — unfinished mail waits here.', '', 'sm', 3);
  return d.items
    .map(m => {
      const on = S.ui.compose?.draftId === m.id;
      return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on ? 'background:var(--surface-2);' : ''}" data-a="gDraftOpen" data-id="${esc(m.id)}" role="button" tabindex="0">
      <span class="av md" style="--c:var(--amber)" aria-hidden="true">${ic('file', 13)}</span>
      <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
        <div class="row" style="gap:8px"><span class="trunc ${on ? 'muted' : ''}" style="${on ? '' : 'font-weight:600'}">${esc(m.subject)}</span><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${m.date ? ago(m.date) : ''}</span></div>
        <div class="trunc muted" style="font-size:12.5px;margin-top:1px">${m.to ? `To ${esc(m.to)}` : '<span class="faint">No recipients yet</span>'}</div>
        <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(m.snippet || m.body?.body || '')}</div>
      </div>
      <button class="ibtn ibtn-xs" data-a="gDraftDelete" data-id="${esc(m.id)}" data-tip="Delete draft" aria-label="Delete draft">${ic('trash-2', 13)}</button>
    </div>`;
    })
    .join('');
}

/* A row renders a bulk checkbox ONLY inside the gmail category (the bulk
   bar lives there); the star works everywhere (All view included).
   Nested [data-a] targets dispatch their own action — the checkbox never
   opens the message. */
/* ---------- CRM linkage badges (AC2/AC6): linked client, or the one-click
   confirm badge for an exact-address auto-link suggestion. Rendered on
   every gmail row (merged 'all' stream + gmail category + search). ---------- */
function crmBadges(m) {
  const links = crmLinks();
  const link = findLink(links, 'mail', m.id);
  if (link) {
    const c = client(link.clientId);
    return c ? `<span class="lblbadge" title="Linked client">${ic('user', 11)}${esc(c.name)}</span>` : '';
  }
  const sug = mailSuggestion(links, crmClients(), m);
  return sug && sug.client
    ? `<button type="button" class="lblbadge sug" data-a="gLinkConfirm" data-id="${esc(m.id)}" data-tip="Matches ${esc(sug.matchedEmail)} on client email — click to link" aria-label="Link to ${esc(sug.client.name)}">${ic('user-plus', 11)}Link to ${esc(sug.client.name)}</button>`
    : '';
}

function gmailItem(m, on, opt = {}) {
  const selected = S.ui.gselSet ? S.ui.gselSet.has(m.id) : false;
  const crm = crmBadges(m);
  const names = (S.ui.glabels && S.ui.glabels.items) || [];
  const nameOf = id => {
    const l = names.find(x => x.id === id);
    return l ? l : { id, name: id, type: 'system' };
  };
  const badges = (m.labels || [])
    .filter(id => id !== 'INBOX' && id !== 'UNREAD' && !id.startsWith('CATEGORY_') && !id.startsWith('GOOGR'))
    .slice(0, 3)
    .map(id => {
      const l = nameOf(id);
      return `<span class="lblbadge ${l.type === 'system' ? 'sys' : ''}" title="${esc(l.name)}">${esc(l.name)}</span>`;
    })
    .join('');
  return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on || selected ? 'background:var(--surface-2);' : ''}" data-a="gsel" data-id="${esc(m.id)}" role="button" tabindex="0">
    ${m.unread ? '<span style="position:absolute;left:6px;top:22px;width:6px;height:6px;border-radius:50%;background:var(--accent)" aria-label="Unread"></span>' : ''}
    ${opt.bulk ? `<input type="checkbox" class="check" ${selected ? 'checked' : ''} data-a="gSelRow" data-id="${esc(m.id)}" aria-label="Select message from ${esc(m.from)}" style="margin-top:4px">` : ''}
    <button type="button" class="ibtn ibtn-xs" data-a="gStar" data-id="${esc(m.id)}" data-tip="${m.starred ? 'Remove star' : 'Add star'}" aria-label="${m.starred ? 'Remove star' : 'Add star'}" style="margin-top:3px;${m.starred ? 'color:#F4B400' : ''}">${ic('star', 14)}</button>
    <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
      <div class="row" style="gap:8px"><span class="trunc" style="${m.unread ? 'font-weight:600' : ''}">${esc(m.from)}</span><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${m.date ? ago(m.date) : ''}</span></div>
      <div class="trunc" style="margin-top:1px;${m.unread ? 'font-weight:600' : ''}">${esc(m.subject)}</div>
      <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(m.snippet)}</div>
      ${badges || crm ? `<div class="row" style="gap:4px;margin-top:5px;flex-wrap:wrap">${badges}${crm}</div>` : ''}
    </div>
  </div>`;
}
/* ---------- Gmail search (gmail category only) ---------- */
function gmailSearchBar() {
  const q = S.ui.gSearchQ || '';
  return `<div class="row" style="padding:8px var(--gutter);gap:6px;border-bottom:1px solid var(--divider)">
    <input class="input" id="g-search-in" data-in="gSearchQ" data-key-enter="gSearchRun" placeholder="Search mail" value="${esc(q)}" aria-label="Search mail" style="height:32px;font-size:13px;padding:6px 10px">
    <button class="ibtn ibtn-sm" data-a="gSearchRun" aria-label="Search mail" data-tip="Search">${ic('search', 14)}</button>
    ${q ? `<button class="btn btn-ghost btn-sm" data-a="gSearchBack">${ic('x', 13)}Back to inbox</button>` : ''}
  </div>`;
}
function gmailSearchList(q) {
  const s = S.ui.gSearch || {};
  if (s.state === 'loading')
    return `<div style="padding:16px var(--gutter)" class="row muted" role="status">${ic('refresh-cw', 14)}Searching mail for “${esc(q)}”…</div>`;
  if (s.state === 'error')
    return `<div style="padding:16px var(--gutter)"><div class="alert danger">${ic('triangle-alert', 16)}<div><b>Search failed.</b><div class="muted" style="margin-top:2px">${esc(s.error || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gSearchRun" data-q="${esc(q)}" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button></div>`;
  if (s.state === 'empty')
    return empty(
      'search',
      'No results',
      `Nothing in your mail matches “${esc(q)}”. Try different words or a Gmail operator like from: or after:.`,
      '',
      'sm',
      3,
    );
  const more =
    s.nextPageToken && !s.loadingMore
      ? `<button class="btn btn-secondary btn-sm" data-a="gSearchMore" style="margin:10px var(--gutter)">${ic('chevron-down', 13)}More results</button>`
      : s.loadingMore
        ? `<div class="row muted" style="padding:10px var(--gutter);font-size:12.5px" role="status">${ic('refresh-cw', 13)}Loading more…</div>`
        : '';
  return (s.msgs || []).map(m => gmailItem(m, m.id === S.ui.gsel)).join('') + more;
}

/* ---------- Gmail message view (deep read, thread context) ---------- */

/* mailBody renders ONE message body. HTML goes through sanitizeMailHtml
   (DOMPurify — the only door for untrusted mail HTML); text/plain is
   rendered as pre-wrapped escaped text. */
function mailBody(m) {
  const b = m.body || { kind: 'text', body: '' };
  if (!b.body) return `<p class="faint" style="font-size:13px">No message body.</p>`;
  if (b.kind === 'html') return `<div class="mail-body" style="font-size:13.5px;line-height:1.65;color:var(--text)">${sanitizeMailHtml(b.body)}</div>`;
  return `<div style="font-size:13.5px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)">${esc(b.body)}</div>`;
}
function attachRow(m) {
  if (!m.attachments || !m.attachments.length) return '';
  return `<div class="row" style="flex-wrap:wrap;gap:6px;margin:10px 0">${m.attachments
    .map(
      a =>
        `<button class="btn btn-secondary btn-sm" data-a="gAttach" data-msg-id="${esc(m.id)}" data-attachment-id="${esc(a.attachmentId)}" data-filename="${esc(a.filename || 'attachment')}" data-mime="${esc(a.mimeType || 'application/octet-stream')}" data-size="${Number(a.size) || 0}">${ic('paperclip', 13)}${esc(a.filename || 'attachment')}<span class="faint" style="font-size:11px">${fsize(Number(a.size) || 0)}</span></button>`,
    )
    .join('')}</div>`;
}
function gmsgActions(m) {
  return `<div class="row" style="gap:6px;margin:14px 0 4px">
    <button class="btn btn-primary btn-sm" data-a="gReply" data-id="${esc(m.id)}">${ic('reply', 13)}Reply</button>
    <button class="btn btn-secondary btn-sm" data-a="gStar" data-id="${esc(m.id)}">${ic('star', 13)}${m.starred ? 'Unstar' : 'Star'}</button>
    <button class="btn btn-secondary btn-sm" data-a="gMarkUnread" data-id="${esc(m.id)}">${ic('mail', 13)}Mark unread</button>
    <button class="btn btn-secondary btn-sm" data-a="gArchive" data-id="${esc(m.id)}">${ic('archive', 13)}Archive</button>
    <button class="btn btn-danger-ghost btn-sm" data-a="gTrash" data-id="${esc(m.id)}">${ic('trash-2', 13)}Trash</button>
  </div>`;
}
function gmsgCard(m, open) {
  const d = m.date ? new Date(m.date) : null;
  const chev = ic(open ? 'chevron-up' : 'chevron-down', 13);
  return `${open ? `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;background:var(--surface)">` : `<div style="border-bottom:1px solid var(--divider)">`}
    <button class="row" style="gap:10px;width:100%;text-align:left;padding:${open ? '0 0 8px' : '10px 0'};background:none;border:none;cursor:pointer" data-a="gmsgToggle" data-id="${esc(m.id)}" aria-expanded="${open}">
      <span class="grow" style="min-width:0"><span class="row" style="gap:8px;font-size:13px"><b style="font-weight:${open ? '600' : '500'}" class="trunc">${esc(m.from)}</b><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${d ? esc(d.toLocaleString()) : ''}</span><span class="muted" style="flex-shrink:0">${chev}</span></span>${open ? '' : `<div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(m.subject)}</div>`}</span>
    </button>
    ${open ? `${attachRow(m)}${mailBody(m)}` : ''}
  </div>`;
}
/* AC2/AC4: the message view's CRM row — linked client (+ Unlink), or the
   searchable 'Link to client…' picker plus the one-click confirm badge for
   an exact-address auto-link suggestion, and the mail → task bridge. */
function gmsgCrmRow(m) {
  const links = crmLinks();
  const link = findLink(links, 'mail', m.id);
  const linkClient = link ? client(link.clientId) : null;
  const sug = link ? null : mailSuggestion(links, crmClients(), m);
  return `<div class="row" style="gap:8px;margin:-4px 0 12px;flex-wrap:wrap;align-items:center">
    ${linkClient ? `<span class="lblbadge" title="Linked client">${ic('user', 12)}${esc(linkClient.name)}</span>` : ''}
    ${linkClient ? `<button class="btn btn-ghost btn-sm" data-a="linkRemove" data-kind="mail" data-id="${esc(m.id)}">${ic('unlink', 13)}Unlink</button>` : `<button class="btn btn-secondary btn-sm" data-a="pop" data-pop="linkclient" data-kind="mail" data-id="${esc(m.id)}">${ic('user-plus', 13)}Link to client…</button>`}
    ${sug && sug.client ? `<button class="btn btn-secondary btn-sm" data-a="gLinkConfirm" data-id="${esc(m.id)}" data-tip="Matches ${esc(sug.matchedEmail)} on client email">${ic('circle-check', 13)}Link to ${esc(sug.client.name)}<span class="faint" style="font-size:11px">· matches ${esc(sug.matchedEmail)}</span></button>` : ''}
    <span class="sp"></span>
    <button class="btn btn-secondary btn-sm" data-a="gAddTask" data-id="${esc(m.id)}">${ic('list-plus', 13)}Add task</button>
  </div>`;
}

function gmailPreview(m) {
  const deep = (S.ui.gmsg = S.ui.gmsg || {})[m.id];
  const msg = deep && deep.msg;
  const d = m.date ? new Date(m.date) : null;
  const link = msg ? safeLink(msg.webLink) || '' : '';
  const threadId = msg && msg.threadId;
  const th = threadId ? (S.ui.gthread = S.ui.gthread || {})[threadId] : null;
  const openSet = (S.ui.gOpen = S.ui.gOpen || new Set());
  /* Label badges: names resolved against the cached labels list; unknown
     ids degrade to their own id (system-styled). */
  const names = (S.ui.glabels && S.ui.glabels.items) || [];
  const badgeRow = (msg?.labels || m.labels || [])
    .filter(id => id !== 'INBOX' && id !== 'UNREAD' && !id.startsWith('CATEGORY_') && !id.startsWith('GOOGR'))
    .slice(0, 6)
    .map(id => {
      const l = names.find(x => x.id === id) || { id, name: id, type: 'system' };
      return `<span class="lblbadge ${l.type === 'system' ? 'sys' : ''}">${esc(l.name)}</span>`;
    })
    .join('');
  /* Body area: loading / error / single body / thread cards. */
  let bodyArea;
  if (!deep || deep.state === 'loading')
    bodyArea = `<div class="row muted" style="padding:16px 0;font-size:13px" role="status">${ic('refresh-cw', 14)}Loading message…</div>`;
  else if (deep.state === 'error')
    bodyArea = `<div class="alert danger">${ic('triangle-alert', 16)}<div><b>Couldn't load the message.</b><div class="muted" style="margin-top:2px">${esc(deep.error || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gMsgRetry" data-id="${esc(m.id)}" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button>`;
  else if (th && th.state === 'ok' && th.messages.length > 1) bodyArea = th.messages.map(tm => gmsgCard(tm, openSet.has(tm.id) || tm.id === m.id)).join('');
  else if (th && th.state === 'loading')
    bodyArea = `${attachRow(msg)}${mailBody(msg)}<div class="row muted" style="padding:12px 0;font-size:12px" role="status">${ic('refresh-cw', 12)}Checking for other messages in this thread…</div>`;
  else if (th && th.state === 'error')
    bodyArea = `${attachRow(msg)}${mailBody(msg)}<div class="row muted" style="padding:10px 0;font-size:12px">${ic('triangle-alert', 12)}Thread context unavailable — showing this message only. <button class="link" data-a="gThreadRetry" data-tid="${esc(threadId)}">Retry</button></div>`;
  else bodyArea = `${attachRow(msg || m)}${mailBody(msg || m)}`;
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <button class="ibtn ibtn-sm" data-a="gsel" data-id="" aria-label="Back">${ic('arrow-left', 15)}</button>
      <span class="av sm" style="--c:var(--red)" aria-hidden="true">${ic('mail', 12)}</span><span class="muted" style="font-size:12.5px">Gmail</span><span class="sp"></span>
      ${msg ? gmsgActions(msg) : ''}
      ${link ? `<a class="btn btn-sm btn-secondary" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="Open in Gmail">${ic('mail-open', 14)}</a>` : ''}
    </div>
    <div style="padding:20px 28px;max-width:760px;width:100%">
      ${m.gone ? `<div class="alert" style="margin:0 0 14px">${ic('triangle-alert', 15)}<span>This linked message is no longer available in Gmail — it may have been deleted.</span></div>` : ''}
      <h2 style="font-size:var(--fs-xl);margin:0 0 10px;font-weight:600;letter-spacing:-.015em">${esc(m.subject)}</h2>
      <div class="row" style="gap:10px;margin-bottom:14px;font-size:13px">${m.unread ? '<span class="badge accent">Unread</span>' : ''}<b style="font-weight:500">${esc(m.from)}</b>${m.email ? `<span class="muted">&lt;${esc(m.email)}&gt;</span>` : ''}<span class="sp"></span><span class="muted" style="font-size:12.5px">${d ? esc(d.toLocaleString()) : ''}</span></div>
      ${badgeRow ? `<div class="row" style="gap:4px;margin:-6px 0 12px;flex-wrap:wrap">${badgeRow}</div>` : ''}
      ${msg ? gmsgCrmRow(m) : ''}
      ${msg && msg.to ? `<div class="row faint" style="font-size:12px;margin-bottom:12px">to ${esc(msg.to)}</div>` : ''}
      ${bodyArea}
      <p class="faint" style="font-size:12px;margin-top:18px">Replies, archiving and trash act on this message in your Gmail. Attachments download straight from your account.</p>
    </div>`;
}
export function notifText(n) {
  const t = n.task ? task(n.task) : null;
  const p = n.project ? proj(n.project) : t ? proj(t.project) : null;
  const who = n.by ? `<b style="font-weight:600">${esc(mem(n.by)?.name)}</b>` : '';
  if (!n.by && p && !t) return `<b style="font-weight:600">${esc(n.text)}</b>`;
  if (!n.by && t) return `<b style="font-weight:600">${esc(t.title)}</b> <span class="muted">${esc(n.text)}</span>`;
  return `${who} <span class="muted">${esc(n.text)}</span> ${t ? `<b style="font-weight:500">${esc(t.title)}</b>` : ''}`;
}
export function notifIcon(n) {
  if (n.by) return av(n.by, 'md', false);
  const i = n.type === 'update' && n.project ? 'triangle-alert' : 'clock';
  return `<span class="av md" style="--c:${n.project ? 'var(--red)' : 'var(--amber)'}">${ic(i, 13)}</span>`;
}
export function inboxItem(n, on) {
  const t = n.task ? task(n.task) : null;
  const p = n.project ? proj(n.project) : t ? proj(t.project) : null;
  const typeIc = { mention: 'at-sign', assign: 'user-plus', comment: 'message-square', update: 'refresh-cw' }[n.type];
  return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on ? 'background:var(--surface-2);' : ''}" data-a="selNotif" data-id="${n.id}" role="button" tabindex="0">
    ${!n.read ? '<span style="position:absolute;left:6px;top:22px;width:6px;height:6px;border-radius:50%;background:var(--accent)" aria-label="Unread"></span>' : ''}
    ${notifIcon(n)}
    <div class="grow" style="font-size:13px;line-height:1.45">
      <div>${notifText(n)}</div>
      <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${fmtComment(n.snippet)}</div>
      <div class="row" style="gap:6px;margin-top:5px;font-size:11.5px;color:var(--text-3)">${ic(typeIc, 11)}${p ? `<span class="pdot" style="--c:${pColor(p)};width:6px;height:6px"></span>${esc(p.name)}` : ''}<span>·</span><span>${ago(n.at)}</span></div>
    </div>
    <button class="ibtn ibtn-xs" data-a="toggleRead" data-id="${n.id}" data-tip="${n.read ? 'Mark as unread' : 'Mark as read'}" aria-label="${n.read ? 'Mark as unread' : 'Mark as read'}">${ic(n.read ? 'mail' : 'mail-open', 13)}</button>
  </div>`;
}
export function inboxPreview(n) {
  const t = n.task ? task(n.task) : null;
  const p = n.project ? proj(n.project) : t ? proj(t.project) : null;
  if (!t)
    return `<div style="padding:24px 28px"><button class="btn btn-sm btn-ghost" data-a="set" data-k="inboxSel" data-v="" style="margin:-4px 0 12px -8px">${ic('arrow-left', 14)}Back</button><div class="alert danger">${ic('triangle-alert', 16)}<div><b>${esc(n.text)}</b><div class="muted" style="margin-top:2px">${esc(n.snippet)}</div></div></div><div style="margin-top:14px"><button class="btn btn-secondary" data-a="go" data-r="project" data-id="${p.id}" data-tab="overview">Open project</button></div></div>`;
  const cs = commentsOf(t.id).slice(-4);
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <button class="ibtn ibtn-sm" data-a="set" data-k="inboxSel" data-v="" aria-label="Back">${ic('arrow-left', 15)}</button>
      <span class="pdot" style="--c:${pColor(p)}"></span><span class="muted" style="font-size:12.5px">${esc(p.name)}</span><span class="faint mono">${t.key}</span><span class="sp"></span>
      <button class="btn btn-sm btn-secondary" data-a="openTask" data-id="${t.id}">${ic('panel-right-open', 14)}Open task</button></div>
    <div style="padding:24px 28px;max-width:720px;width:100%">
      <h2 style="font-size:var(--fs-xl);margin:0 0 10px;font-weight:600;letter-spacing:-.015em">${esc(t.title)}</h2>
      <div class="row" style="flex-wrap:wrap;gap:4px;margin-bottom:18px">${cellStatus(t)}${cellAssignee(t)}${cellPrio(t)}${cellDue(t)}</div>
      <div class="eyebrow" style="margin-bottom:4px">Conversation</div>
      ${cs.length ? cs.map(commentHtml).join('') : `<p class="muted">${esc(n.snippet)}</p>`}
      <div class="cbox" style="margin-top:10px"><textarea id="inbox-reply" data-in="draft" data-id="${t.id}" data-key-mod-enter="postComment" placeholder="Reply… use @ to mention" aria-label="Reply">${esc(S.ui.drafts[t.id] || '')}</textarea>
      <div class="row"><span class="faint" style="font-size:11.5px">${MOD}+Enter to send</span><span class="sp"></span><button class="btn btn-primary btn-sm" data-a="postComment" data-id="${t.id}">Reply</button></div></div>
    </div>`;
}
