/* ---------- INBOX ---------- */
import { MOD, ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, commentsOf, mem, pColor, proj, task } from '../core/store.js';
import { googleStatus, ensureGmail } from '../core/google.js';
import { av, empty, fmtComment } from '../ui/helpers.js';
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
  if (gcat && g.connected) ensureGmail(); // fetch-on-render; no-op once cached
  let ns = D()
    .notifs.slice()
    .sort((a, b) => b.at - a.at);
  const gmsgs = S.ui.gmsgs || [];
  const count = k => (k === 'gmail' ? gmsgs.filter(m => m.unread).length : ns.filter(n => (k === 'all' || n.type === k) && !n.read).length);
  ns = ns.filter(n => cat === 'all' || n.type === cat);
  if (S.ui.inboxUnread) ns = ns.filter(n => !n.read);
  const sel = D().notifs.find(n => n.id === S.ui.inboxSel) || null;
  const gsel = gcat ? gmsgs.find(m => m.id === S.ui.gsel) || null : null;
  return `<div class="page flush">
    <div style="display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);flex:1;min-height:0" class="inbox-grid">
      <style>@media(max-width:900px){.inbox-grid{grid-template-columns:minmax(0,1fr)!important}.inbox-prev{display:${sel || gsel ? 'flex' : 'none'}!important;position:fixed;inset:0;z-index:48;background:var(--surface)}}</style>
      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
        <div style="padding:18px var(--gutter) 0" class="row"><h1 style="font-size:var(--fs-xl);margin:0;font-weight:600;letter-spacing:-.015em">Inbox</h1><span class="sp"></span>
          ${
            gcat
              ? `<span class="row" style="gap:6px;font-size:12px;color:var(--text-2)">${ic('mail', 14)}${g.connected ? `Google · ${esc(g.email || 'connected')}` : 'Not connected'}</span>`
              : `<label class="row" style="font-size:12px;color:var(--text-2);gap:6px;cursor:pointer"><input type="checkbox" class="toggle" data-a="toggleUnreadOnly" ${S.ui.inboxUnread ? 'checked' : ''}>Unread</label>
          <button class="ibtn ibtn-sm" data-a="markAllRead" data-tip="Mark all as read" aria-label="Mark all as read">${ic('check-check', 15)}</button>`
          }</div>
        <div class="tabs inbox-tabs" role="tablist">${cats.map(([k, n]) => `<button role="tab" class="tab ${cat === k ? 'on' : ''}" data-a="set" data-k="inboxCat" data-v="${k}">${n}${count(k) ? `<span class="cnt">${count(k)}</span>` : ''}</button>`).join('')}</div>
        <div class="inbox-list" data-keep="inbox-list">${gcat ? gmailList(g, gmsgs) : ns.length ? ns.map(n => inboxItem(n, sel && sel.id === n.id)).join('') : empty('inbox', "You're all caught up.", S.ui.inboxUnread ? 'No unread notifications in this category.' : 'New mentions, assignments, and comments will show up here.', '', 'sm')}</div>
      </div>
      <div class="inbox-prev" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">${gsel ? gmailPreview(gsel) : gcat ? `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('mail', 20)}</div><h2 class="es-h">Select a message</h2><p>Recent Gmail messages open here as a read-only preview.</p></div></div></div>` : sel ? inboxPreview(sel) : `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('mail-open', 20)}</div><h2 class="es-h">Select a notification</h2><p>Read the conversation and reply without leaving your inbox.</p></div></div></div>`}</div>
    </div>
  </div>`;
}

/* ---------- Gmail (read-only, via google-data/gmail) ---------- */
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
  if (S.ui.gState === 'loading')
    return `<div style="padding:16px var(--gutter)" class="row muted" role="status">${ic('refresh-cw', 14)}Loading recent mail…</div>`;
  if (S.ui.gState === 'error')
    return `<div style="padding:16px var(--gutter)"><div class="alert danger">${ic('triangle-alert', 16)}<div><b>Couldn't load your Gmail.</b><div class="muted" style="margin-top:2px">${esc(S.ui.gError || 'Something went wrong.')}</div></div></div><button class="btn btn-secondary btn-sm" data-a="gRetry" style="margin-top:10px">${ic('refresh-cw', 13)}Retry</button></div>`;
  if (!msgs.length) return empty('mail', 'No recent mail', 'Your Gmail inbox is empty — messages will appear here when they arrive.', '', 'sm', 3);
  return msgs.map(m => gmailItem(m, m.id === S.ui.gsel)).join('');
}
function gmailItem(m, on) {
  return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on ? 'background:var(--surface-2);' : ''}" data-a="gsel" data-id="${esc(m.id)}" role="button" tabindex="0">
    ${m.unread ? '<span style="position:absolute;left:6px;top:22px;width:6px;height:6px;border-radius:50%;background:var(--accent)" aria-label="Unread"></span>' : ''}
    <span class="av md" style="--c:var(--red)" aria-hidden="true">${ic('mail', 13)}</span>
    <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
      <div class="row" style="gap:8px"><span class="trunc" style="${m.unread ? 'font-weight:600' : ''}">${esc(m.from)}</span><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${m.date ? ago(m.date) : ''}</span></div>
      <div class="trunc" style="margin-top:1px;${m.unread ? 'font-weight:600' : ''}">${esc(m.subject)}</div>
      <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(m.snippet)}</div>
    </div>
  </div>`;
}
function gmailPreview(m) {
  const d = m.date ? new Date(m.date) : null;
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <button class="ibtn ibtn-sm" data-a="gsel" data-id="" aria-label="Back">${ic('arrow-left', 15)}</button>
      <span class="av sm" style="--c:var(--red)" aria-hidden="true">${ic('mail', 12)}</span><span class="muted" style="font-size:12.5px">Gmail</span><span class="sp"></span>
      ${m.webLink ? `<a class="btn btn-sm btn-secondary" href="${esc(m.webLink)}" target="_blank" rel="noopener noreferrer">${ic('mail-open', 14)}Open in Gmail</a>` : ''}</div>
    <div style="padding:24px 28px;max-width:720px;width:100%">
      <h2 style="font-size:var(--fs-xl);margin:0 0 10px;font-weight:600;letter-spacing:-.015em">${esc(m.subject)}</h2>
      <div class="row" style="gap:10px;margin-bottom:18px;font-size:13px">${m.unread ? '<span class="badge accent">Unread</span>' : ''}<b style="font-weight:500">${esc(m.from)}</b>${m.email ? `<span class="muted">&lt;${esc(m.email)}&gt;</span>` : ''}<span class="sp"></span><span class="muted" style="font-size:12.5px">${d ? esc(d.toLocaleString()) : ''}</span></div>
      <div class="eyebrow" style="margin-bottom:6px">Preview</div>
      <p class="muted" style="font-size:13.5px;line-height:1.6">${esc(m.snippet) || '<span class="faint">No preview available.</span>'}</p>
      <p class="faint" style="font-size:12px;margin-top:14px">Atrium shows a read-only preview. Open the message in Gmail to read everything and reply.</p>
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
