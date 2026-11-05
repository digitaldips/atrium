/* ---------- MAIL (merged into the Inbox as its Mail tab — T5) ----------
   The standalone route is retired; pages/inbox.js renders these panes
   under the Inbox's Mail tab. State stays S.ui.mailFolder/mailSel/mailQ,
   and the pane renderers are byte-equivalent with the old standalone page. */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, client, crmClients, crmLinks } from '../core/store.js';
import { ensureMailData, folderUnreadCount, mailSearchFilter, mailThreadContact, threadsInFolder } from '../core/mail.js';
import { findLink, mailSuggestion } from '../core/links.js';
import { empty, fsize } from '../ui/helpers.js';

const FOLDER_EMPTY = {
  f_inbox: ['inbox', "You're all caught up.", 'Mail shared across the workspace will show up here.'],
  f_starred: ['star', 'Nothing starred yet', 'Star a thread to keep it pinned here.'],
  f_sent: ['send', 'No sent mail', 'Compose a message or reply — mock sends are stored here.'],
  f_drafts: ['note', 'No drafts', 'Compose a message and hit Save draft — unfinished mail waits here.'],
  f_archive: ['archive', 'Nothing archived', 'Archived threads stay searchable and restorable.'],
  f_trash: ['trash', 'Trash is empty', 'Trashed threads rest here until you restore or delete them.'],
};

/* Shared state for the tab renderers (the old pageMail head). */
function mailState() {
  if (!D().mail) ensureMailData(D()); // ingest paths own this; belt-and-braces for docs that predate the wiring
  const mail = D().mail;
  const folderId = S.ui.mailFolder || 'f_inbox';
  const folder = mail.folders.find(f => f.id === folderId) || mail.folders[0];
  const sel = mail.threads.find(t => t && t.id === S.ui.mailSel) || null;
  const q = (S.ui.mailQ || '').trim();
  const list = q ? mailSearchFilter(mail.threads, q) : threadsInFolder(mail.threads, folder.id);
  return { mail, folder, sel, q, list };
}

/* Header-row chip + Compose for the Inbox's h1 row (Mail tab active). */
export function mailHeaderChip() {
  return `<span class="row" style="gap:6px;font-size:12px;color:var(--text-2)">${ic('mail', 14)}Shared mailbox</span><button class="btn btn-secondary btn-sm" data-a="mCompose">${ic('pencil', 13)}Compose</button>`;
}

/* Left-pane content below the tabs: folder rail + search + thread list. */
export function mailPane() {
  const { mail, folder, q, list } = mailState();
  return `${folderRail(mail, folder)}
        ${mailSearchBar(q)}
        <div class="inbox-list" data-keep="mail-list">${mailList(mail, list, q, folder)}</div>`;
}

/* Preview pane: the selected thread, or the tab's empty state. */
export function mailPreviewPane() {
  const { mail, folder, sel } = mailState();
  return sel
    ? mailPreview(mail, sel, folder)
    : `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('mail-open', 20)}</div><h2 class="es-h">Select a thread</h2><p>Shared workspace mail opens here — everyone in this workspace sees the same mailbox.</p></div></div></div>`;
}

/* Whether a mail thread is selected (drives the mobile overlay). */
export function mailSelOpen() {
  const { sel } = mailState();
  return !!sel;
}

/* ---------- folder rail (unread counts; Starred is virtual) ---------- */
function folderRail(mail, active) {
  const chip = f => {
    const n = folderUnreadCount(mail.threads, f.id);
    const on = f.id === active.id;
    return `<button type="button" class="gchip ${on ? 'on' : ''}" data-a="mailFolder" data-id="${esc(f.id)}" role="tab" aria-selected="${on}">${ic(f.icon || 'folder', 13)}<span>${esc(f.name)}</span>${n ? `<span class="cnt">${n}</span>` : ''}</button>`;
  };
  return `<div class="row" style="padding:8px var(--gutter) 0;gap:6px;flex-wrap:wrap;align-items:center" role="tablist" aria-label="Folders">${mail.folders.map(chip).join('')}</div>`;
}

function mailSearchBar(q) {
  return `<div class="row" style="padding:8px var(--gutter);gap:6px;border-bottom:1px solid var(--divider)">
    <input class="input" id="mail-search-in" data-in="mSearch" placeholder="Search subject, snippet or body" value="${esc(q)}" aria-label="Search mail" style="height:32px;font-size:13px;padding:6px 10px">
    ${q ? `<button class="ibtn ibtn-sm" data-a="mSearchClear" aria-label="Clear search" data-tip="Clear search">${ic('x', 14)}</button>` : ''}
  </div>`;
}

function mailList(mail, list, q, folder) {
  if (q) {
    if (!list.length) return empty('search', 'No results', `Nothing in the workspace mailbox matches “${esc(q)}”.`, '', 'sm');
    return (
      `<div class="faint" style="padding:8px var(--gutter);font-size:11.5px">${list.length} result${list.length > 1 ? 's' : ''} for “${esc(q)}” across all folders</div>` +
      list.map(t => mailItem(t, t.id === S.ui.mailSel)).join('')
    );
  }
  if (!list.length) {
    const [icon, title, text] = FOLDER_EMPTY[folder.id] || ['folder', 'No mail here', 'Move threads here from the thread actions.'];
    return empty(icon, title, text, '', 'sm', 3);
  }
  return list.map(t => mailItem(t, t.id === S.ui.mailSel)).join('');
}

/* Sender line: incoming threads show the sender, outgoing (Sent/Drafts) show the recipient — like Gmail. */
function senderLine(t) {
  if (t.folderId === 'f_sent' || t.folderId === 'f_drafts') {
    const to = (t.messages?.[0]?.to || []).join(', ');
    return to ? `To ${esc(to)}` : '<span class="faint">No recipients yet</span>';
  }
  const last = t.messages?.length ? t.messages[t.messages.length - 1] : null;
  return esc(last?.from?.name || 'Unknown sender');
}

function mailItem(t, on) {
  const draft = t.folderId === 'f_drafts';
  const crm = crmBadges(t);
  return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on ? 'background:var(--surface-2);' : ''}" data-a="mSel" data-id="${esc(t.id)}" role="button" tabindex="0">
    ${t.unread ? '<span style="position:absolute;left:6px;top:22px;width:6px;height:6px;border-radius:50%;background:var(--accent)" aria-label="Unread"></span>' : ''}
    <button type="button" class="ibtn ibtn-xs" data-a="mStar" data-id="${esc(t.id)}" data-tip="${t.starred ? 'Remove star' : 'Add star'}" aria-label="${t.starred ? 'Remove star' : 'Add star'}" style="margin-top:3px;${t.starred ? 'color:#F4B400' : ''}">${ic('star', 14)}</button>
    <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
      <div class="row" style="gap:8px"><span class="trunc" style="${t.unread ? 'font-weight:600' : ''}">${draft ? '<span class="faint">Draft</span> ' : ''}${senderLine(t)}</span><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${ago(t.updatedAt)}</span></div>
      <div class="row" style="gap:6px;margin-top:1px"><span class="trunc" style="${t.unread ? 'font-weight:600' : ''}">${esc(t.subject)}</span>${t.hasAttachment ? `<span class="faint" style="flex-shrink:0" title="Has attachment">${ic('paperclip', 12)}</span>` : ''}</div>
      <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(t.snippet)}</div>
      ${crm ? `<div class="row" style="gap:4px;margin-top:5px;flex-wrap:wrap">${crm}</div>` : ''}
    </div>
    ${draft ? `<button class="ibtn ibtn-xs" data-a="mDraftDelete" data-id="${esc(t.id)}" data-tip="Delete draft" aria-label="Delete draft">${ic('trash-2', 13)}</button>` : ''}
  </div>`;
}

/* CRM linkage badges (AC5): linked client, or the one-click confirm badge
   for an exact-address auto-link suggestion on the last sender. */
function crmBadges(t) {
  const links = crmLinks();
  const link = findLink(links, 'mail', t.id);
  if (link) {
    const c = client(link.clientId);
    return c ? `<span class="lblbadge" title="Linked client">${ic('user', 11)}${esc(c.name)}</span>` : '';
  }
  const sug = mailSuggestion(links, crmClients(), mailThreadContactSafe(t));
  return sug && sug.client
    ? `<button type="button" class="lblbadge sug" data-a="mLinkConfirm" data-id="${esc(t.id)}" data-tip="Matches ${esc(sug.matchedEmail)} on client email — click to link" aria-label="Link to ${esc(sug.client.name)}">${ic('user-plus', 11)}Link to ${esc(sug.client.name)}</button>`
    : '';
}
const mailThreadContactSafe = t => {
  const m = D().members.find(x => x && x.id === D().me);
  return mailThreadContact(t, m?.email || '');
};

/* ---------- thread preview ---------- */
function attachChips(m) {
  if (!m.attachments || !m.attachments.length) return '';
  return `<div class="row" style="flex-wrap:wrap;gap:6px;margin:10px 0">${m.attachments
    .map(
      a =>
        `<button type="button" class="btn btn-secondary btn-sm" disabled aria-disabled="true" title="Attachments are display-only in shared mail — upload arrives with a later module">${ic('paperclip', 13)}${esc(a.filename || 'attachment')}<span class="faint" style="font-size:11px">${fsize(Number(a.size) || 0)}</span></button>`,
    )
    .join('')}</div>`;
}

function mailBody(m) {
  if (!m.body) return `<p class="faint" style="font-size:13px">No message body.</p>`;
  return `<div style="font-size:13.5px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)">${esc(m.body)}</div>`;
}

function mCard(m, open) {
  const d = m.createdAt ? new Date(m.createdAt) : null;
  const chev = ic(open ? 'chevron-up' : 'chevron-down', 13);
  return `${open ? `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;background:var(--surface)">` : `<div style="border-bottom:1px solid var(--divider)">`}
    <button class="row" style="gap:10px;width:100%;text-align:left;padding:${open ? '0 0 8px' : '10px 0'};background:none;border:none;cursor:pointer" data-a="mMsgToggle" data-id="${esc(m.id)}" aria-expanded="${open}">
      <span class="grow" style="min-width:0"><span class="row" style="gap:8px;font-size:13px"><b style="font-weight:${open ? '600' : '500'}" class="trunc">${esc(m.from?.name || 'Unknown')}</b><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${d ? esc(d.toLocaleString()) : ''}</span><span class="muted" style="flex-shrink:0">${chev}</span></span>${open ? '' : `<div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(m.body.slice(0, 120))}</div>`}</span>
    </button>
    ${open ? `${attachChips(m)}${mailBody(m)}` : ''}
  </div>`;
}

function mCrmRow(t) {
  const links = crmLinks();
  const link = findLink(links, 'mail', t.id);
  const linkClient = link ? client(link.clientId) : null;
  const sug = link ? null : mailSuggestion(links, crmClients(), mailThreadContactSafe(t));
  return `<div class="row" style="gap:8px;margin:-4px 0 12px;flex-wrap:wrap;align-items:center">
    ${linkClient ? `<span class="lblbadge" title="Linked client">${ic('user', 12)}${esc(linkClient.name)}</span>` : ''}
    ${linkClient ? `<button class="btn btn-ghost btn-sm" data-a="linkRemove" data-kind="mail" data-id="${esc(t.id)}">${ic('unlink', 13)}Unlink</button>` : `<button class="btn btn-secondary btn-sm" data-a="pop" data-pop="linkclient" data-kind="mailthread" data-id="${esc(t.id)}">${ic('user-plus', 13)}Link to client…</button>`}
    ${sug && sug.client ? `<button class="btn btn-secondary btn-sm" data-a="mLinkConfirm" data-id="${esc(t.id)}" data-tip="Matches ${esc(sug.matchedEmail)} on client email">${ic('circle-check', 13)}Link to ${esc(sug.client.name)}<span class="faint" style="font-size:11px">· matches ${esc(sug.matchedEmail)}</span></button>` : ''}
  </div>`;
}

function mailPreview(mail, t, folder) {
  const msgs = t.messages || [];
  const lastId = msgs.length ? msgs[msgs.length - 1].id : '';
  const openSet = (S.ui.mOpen = S.ui.mOpen || new Set());
  const draft = t.folderId === 'f_drafts';
  const trash = t.folderId === 'f_trash';
  const actions = trash
    ? `<button class="btn btn-secondary btn-sm" data-a="mRestore" data-id="${esc(t.id)}">${ic('rotate-ccw', 13)}Restore</button><button class="btn btn-danger-ghost btn-sm" data-a="mDelete" data-id="${esc(t.id)}">${ic('trash-2', 13)}Delete forever</button>`
    : draft
      ? `<button class="btn btn-primary btn-sm" data-a="mDraftOpen" data-id="${esc(t.id)}">${ic('pencil', 13)}Open draft</button><button class="btn btn-danger-ghost btn-sm" data-a="mDraftDelete" data-id="${esc(t.id)}">${ic('trash-2', 13)}Delete draft</button>`
      : `<button class="btn btn-primary btn-sm" data-a="mReply" data-id="${esc(t.id)}">${ic('reply', 13)}Reply</button>
    <button class="btn btn-secondary btn-sm" data-a="mStar" data-id="${esc(t.id)}">${ic('star', 13)}${t.starred ? 'Unstar' : 'Star'}</button>
    ${t.unread ? `<button class="btn btn-secondary btn-sm" data-a="mSel" data-id="${esc(t.id)}">${ic('mail-open', 13)}Mark read</button>` : `<button class="btn btn-secondary btn-sm" data-a="mUnread" data-id="${esc(t.id)}">${ic('mail', 13)}Mark unread</button>`}
    ${t.folderId !== 'f_archive' ? `<button class="btn btn-secondary btn-sm" data-a="mArchive" data-id="${esc(t.id)}">${ic('archive', 13)}Archive</button>` : ''}
    <button class="ibtn ibtn-sm" data-a="pop" data-pop="mailfolder" data-id="${esc(t.id)}" data-tip="Move to folder" aria-label="Move to folder">${ic('folder-input', 15)}</button>
    <button class="btn btn-danger-ghost btn-sm" data-a="mTrash" data-id="${esc(t.id)}">${ic('trash-2', 13)}Trash</button>`;
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0;flex-wrap:nowrap;overflow-x:auto">
      <button class="ibtn ibtn-sm" data-a="mBack" aria-label="Back">${ic('arrow-left', 15)}</button>
      <span class="av sm" style="--c:var(--blue)" aria-hidden="true">${ic('mail', 12)}</span><span class="muted" style="font-size:12.5px;flex-shrink:0">${esc(folder.name)}</span><span class="sp"></span>
      ${actions}
    </div>
    <div style="padding:20px 28px;max-width:760px;width:100%">
      <h2 style="font-size:var(--fs-xl);margin:0 0 10px;font-weight:600;letter-spacing:-.015em">${esc(t.subject)}</h2>
      <div class="row" style="gap:10px;margin-bottom:14px;font-size:13px">${t.unread ? '<span class="badge accent">Unread</span>' : ''}${t.starred ? '<span class="faint" style="color:#F4B400">' + ic('star', 13) + '</span>' : ''}<b style="font-weight:500">${esc(msgs.length ? msgs[msgs.length - 1].from?.name || 'Unknown' : 'Unknown')}</b>${msgs.length && msgs[msgs.length - 1].from?.email ? `<span class="muted">&lt;${esc(msgs[msgs.length - 1].from.email)}&gt;</span>` : ''}<span class="sp"></span><span class="muted" style="font-size:12.5px">${ago(t.updatedAt)}</span></div>
      ${mCrmRow(t)}
      ${msgs.length ? `<div class="faint" style="font-size:12px;margin-bottom:12px">${msgs.length} message${msgs.length > 1 ? 's' : ''}${msgs[msgs.length - 1]?.to?.length ? ` — to ${esc(msgs[msgs.length - 1].to.join(', '))}` : ''}</div>` : ''}
      ${msgs.map(m => mCard(m, openSet.has(m.id) || m.id === lastId)).join('')}
      ${draft ? `<p class="faint" style="font-size:12px;margin-top:18px">This is a draft in the shared workspace — Open draft to finish and send it.</p>` : `<p class="faint" style="font-size:12px;margin-top:18px">Shared workspace mail — replies and moves are visible to everyone in this workspace. Sending is a mock send: messages are stored here, nothing is emailed.</p>`}
    </div>`;
}
