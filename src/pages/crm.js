/* ---------- CRM · Clients (route: crm) + shared CRM summary ---------- */
import { esc, fmtDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, client, crmClients, crmDeals, crmLinks, crmOrgs, mem, org } from '../core/store.js';
import { linksForClient } from '../core/links.js';
import { orgSuggestionsForClients } from '../core/orgs.js';
import { CLIENT_STATUSES, CSTATUS, CRM_STAGE, activeClientCount, clientCompany, dealTotals, eur, isKnownStage } from '../core/crm.js';
import { ST } from '../core/constants.js';
import { av, empty, stIcon } from '../ui/helpers.js';

/* ---------- presentation vocabulary ---------- */
export const CSTATUS_C = { lead: 'var(--blue)', active: 'var(--green)', inactive: 'var(--gray)' };
export const STAGE_C = { lead: 'var(--gray)', qualified: 'var(--blue)', proposal: 'var(--violet)', won: 'var(--green)', lost: 'var(--red)' };

export const cStatusPill = s => {
  const k = CSTATUS[s] ? s : 'lead';
  return `<span class="cstat" style="--c:${CSTATUS_C[k]}"><i></i>${CSTATUS[k].name}</span>`;
};
export const stagePill = s => {
  const k = isKnownStage(s) ? s : 'lead';
  return `<span class="cstat" style="--c:${STAGE_C[k]}"><i></i>${CRM_STAGE[k].name}</span>`;
};
export const crmAv = c => {
  const ini = (c?.name || c?.company || '?')
    .split(' ')
    .map(x => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const st = CSTATUS[c?.status] ? c.status : 'lead';
  return `<span class="av sm clav" style="--c:${CSTATUS_C[st]}" data-tip="${esc(c?.company || c?.name || 'Client')}">${esc(ini)}</span>`;
};

/* ---------- AC4: summary strip (shared by both CRM routes) ---------- */
export function crmSummary() {
  const t = dealTotals(crmDeals());
  const cl = crmClients();
  const n = v => `${v} deal${v === 1 ? '' : 's'}`;
  return `<div class="stats" style="margin-bottom:16px">
    <div class="stat"><span class="k">Open pipeline</span><span class="v">${eur(t.openValue)}</span><span class="d">${n(t.openCount)} open</span></div>
    <div class="stat"><span class="k">Won</span><span class="v">${eur(t.wonValue)}</span><span class="d">${n(t.wonCount)} won</span></div>
    <div class="stat"><span class="k">Active clients</span><span class="v">${activeClientCount(cl)}</span><span class="d">${cl.length} total</span></div>
  </div>`;
}

/* ---------- AC4: auto-suggest strip (SUGGEST + one-click confirm) ---------- */
/* Pure matcher output from core/orgs.js; a confirmed badge is re-derived
   from live state before it acts (A.orgAttach). Session-dismissed client
   ids (S.ui.orgSugDismissed) calm the strip without touching data. */
function orgSuggestStrip() {
  const sugs = orgSuggestionsForClients(crmClients(), crmOrgs()).filter(s => !(S.ui.orgSugDismissed || {})[s.clientId]);
  if (!sugs.length) return '';
  return `<div class="col" style="gap:6px;margin-bottom:12px">${sugs
    .map(
      s =>
        `<div class="alert info" role="status">${ic('building-2', 14)}<span style="min-width:0"><b>${esc(s.client.name)}</b> — email domain <b>${esc(s.matchedDomain)}</b> matches <b>${esc(s.org.name)}</b>. Attach the contact to this organisation?</span><span class="sp"></span><button class="btn btn-sm btn-primary" data-a="orgAttach" data-id="${esc(s.clientId)}">Attach</button><button class="btn btn-sm btn-ghost" data-a="orgAttachDismiss" data-id="${esc(s.clientId)}">Dismiss</button></div>`,
    )
    .join('')}</div>`;
}

/* ---------- clients page (route: crm) ---------- */
export function pageCrm() {
  const u = S.ui;
  const q = (u.crmQ || '').toLowerCase();
  const st = u.crmStatus || 'all';
  const orgF = u.crmOrg || 'all';
  let cs = crmClients().filter(
    c =>
      (st === 'all' || c.status === st) &&
      (orgF === 'all' || (orgF === 'none' ? !c.org : c.org === orgF)) &&
      (!q || [c.name, c.company, c.email].some(x => (x || '').toLowerCase().includes(q))),
  );
  cs = [...cs].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const dealsOf = c => crmDeals().filter(d => d.client === c.id);
  let body;
  if (!crmClients().length)
    body = `<div class="panel">${empty('contact', 'No clients yet', 'Add your first client to start tracking contacts and deals.', `<button class="btn btn-primary btn-sm" data-a="newClient">${ic('plus', 14)}Add client</button>`)}</div>`;
  else if (!cs.length)
    body = `<div class="panel">${empty('search-x', 'No results found', 'No clients match your search or filter. Try a different term.', `<button class="btn btn-secondary btn-sm" data-a="clearCrmFilters">Clear filters</button>`)}</div>`;
  else
    body = `<div class="panel" style="overflow-x:auto"><table class="perm-t" style="min-width:760px"><thead><tr><th style="padding-left:14px">Client</th><th style="text-align:left">Status</th><th style="text-align:left">Contact</th><th style="text-align:left">Notes</th><th>Deals</th><th style="text-align:left">Value</th><th style="text-align:left">Added</th><th></th></tr></thead><tbody>
    ${cs
      .map(c => {
        const ds = dealsOf(c);
        const val = ds.filter(d => d.stage !== 'lost').reduce((s, d) => s + (Number(d.value) || 0), 0);
        const oc = c.org ? org(c.org) : null;
        const orgLine = oc ? `${ic('building-2', 10)} ${esc(oc.name)}` : esc(clientCompany(c, crmOrgs()));
        return `<tr style="cursor:pointer" data-a="openClient" data-id="${c.id}"><td style="padding-left:14px"><span class="row">${crmAv(c)}<span style="min-width:0"><span style="font-weight:500;display:block">${esc(c.name)}</span><span class="faint" style="font-size:11.5px">${orgLine ? `<span class="trunc" style="display:inline-block;max-width:100%">${orgLine}</span>` : ''}</span></span>${c.owner ? `<span style="margin-left:auto;flex:none">${av(c.owner, 'sm')}</span>` : ''}</span></td><td style="text-align:left">${cStatusPill(c.status)}</td><td style="text-align:left"><span style="display:block;font-size:12.5px">${esc(c.email || '—')}</span><span class="faint" style="font-size:11.5px">${esc(c.phone || '')}</span></td><td style="text-align:left;max-width:260px"><span class="trunc faint" style="font-size:12px;display:inline-block;max-width:250px">${esc(c.notes || '')}</span></td><td class="num">${ds.length}</td><td style="text-align:left" class="num muted">${eur(val)}</td><td style="text-align:left" class="num muted">${fmtDate(new Date(c.created || Date.now()))}</td><td><button class="ibtn ibtn-sm" data-a="editClient" data-id="${c.id}" aria-label="Edit client">${ic('ellipsis', 14)}</button></td></tr>`;
      })
      .join('')}
    </tbody></table></div>`;
  return `<div class="page wide">
    <div class="ph"><div><h1>Clients</h1><p>${crmClients().length} client${crmClients().length === 1 ? '' : 's'} · ${activeClientCount(crmClients())} active</p></div><div class="acts"><button class="btn btn-primary" data-a="newClient">${ic('plus', 14)}Add client</button></div></div>
    ${crmSummary()}
    ${orgSuggestStrip()}
    <div class="row" style="margin-bottom:16px;gap:8px;flex-wrap:wrap">
      <div class="inwrap">${ic('search', 13)}<input class="input search-sm" id="crm-q" data-in="crmQ" placeholder="Search clients" value="${esc(u.crmQ || '')}" aria-label="Search clients"></div>
      <select class="select" style="height:26px;width:auto;font-size:12px" data-in="crmStatus" aria-label="Filter by status"><option value="all">All statuses</option>${CLIENT_STATUSES.map(
        s => `<option value="${s.id}" ${st === s.id ? 'selected' : ''}>${s.name}</option>`,
      ).join('')}</select>
      <select class="select" style="height:26px;width:auto;font-size:12px" data-in="crmOrg" aria-label="Filter by organisation"><option value="all">All organisations</option><option value="none" ${orgF === 'none' ? 'selected' : ''}>No organisation</option>${crmOrgs()
        .map(o => `<option value="${esc(o.id)}" ${orgF === o.id ? 'selected' : ''}>${esc(o.name)}</option>`)
        .join('')}</select>
    </div>
    ${body}
  </div>`;
}

/* ---------- AC3: client detail linkage (Mail / Meetings / Tasks) ---------- */
/* Newest-first from the links[] rows; every row carries its own Unlink.
   Mail senders come from the cached Gmail copies when available — the
   stored row (title/when/snippet) is the fallback, so nothing renders
   empty when the message is not in this session's caches. */
function clientLinkSections(c) {
  const links = crmLinks();
  const mail = linksForClient(links, c.id, 'mail');
  const meetings = linksForClient(links, c.id, 'event');
  const tasks = linksForClient(links, c.id, 'task');
  const msgOf = ref =>
    (S.ui.gmsgs || []).find(m => m && m.id === ref) ||
    ((S.ui.gSearch && S.ui.gSearch.msgs) || []).find(m => m && m.id === ref) ||
    (S.ui.gmsg && S.ui.gmsg[ref] && S.ui.gmsg[ref].state === 'ok' ? S.ui.gmsg[ref].msg : null) ||
    null;
  const mailRows = mail.length
    ? mail
        .map(l => {
          const m = msgOf(l.ref);
          const line = [m?.from || '', l.snippet || ''].filter(Boolean).join(' · ') || 'Open in Gmail';
          return `<div class="mini" role="button" tabindex="0" data-a="gOpenMail" data-id="${esc(l.ref)}"><span class="ftype" style="--c:var(--red)">${ic('mail', 14)}</span><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(l.title || '(no subject)')}</div><div class="faint" style="font-size:11.5px"><span class="trunc" style="display:inline-block;max-width:100%">${esc(line)}</span></div></div><span class="faint num" style="font-size:11.5px;flex-shrink:0">${l.when ? fmtDate(new Date(l.when)) : ''}</span><button class="ibtn ibtn-xs x" data-a="linkRemove" data-kind="mail" data-id="${esc(l.ref)}" aria-label="Unlink mail">${ic('x', 12)}</button></div>`;
        })
        .join('')
    : `<div class="faint" style="font-size:12.5px">No linked mail yet — link a message from the inbox.</div>`;
  const meetingRows = meetings.length
    ? meetings
        .map(
          l =>
            `<div class="mini" role="button" tabindex="0" data-a="pop" data-pop="gevent" data-closemodal="1" data-id="${esc(l.ref)}"><span class="ftype" style="--c:#1A73E8">${ic('calendar-days', 14)}</span><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(l.title || '(untitled event)')}</div></div><span class="faint num" style="font-size:11.5px;flex-shrink:0">${l.when ? fmtDate(new Date(l.when)) : ''}</span><button class="ibtn ibtn-xs x" data-a="linkRemove" data-kind="event" data-id="${esc(l.ref)}" aria-label="Unlink meeting">${ic('x', 12)}</button></div>`,
        )
        .join('')
    : `<div class="faint" style="font-size:12.5px">No linked meetings yet — link an event from its popover.</div>`;
  const taskRows = tasks.length
    ? tasks
        .map(l => {
          const t = D().tasks.find(x => x && x.id === l.ref);
          return `<div class="mini" role="button" tabindex="0" data-a="openTask" data-id="${esc(l.ref)}">${stIcon(t ? t.status : 'todo', 13)}<div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px${t ? '' : ';color:var(--text-3)'}">${esc(t ? l.title || t.title : l.title || 'Removed task')}</div></div><span class="faint" style="font-size:11.5px;flex-shrink:0">${t ? esc(ST[t.status]?.name || t.status) : 'removed'}</span><button class="ibtn ibtn-xs x" data-a="linkRemove" data-kind="task" data-id="${esc(l.ref)}" aria-label="Unlink task">${ic('x', 12)}</button></div>`;
        })
        .join('')
    : `<div class="faint" style="font-size:12.5px">No linked tasks yet — link one from a message or its drawer.</div>`;
  return `
    <div>
      <div class="eyebrow" style="margin-bottom:6px">Mail · ${mail.length}</div>
      ${mailRows}
    </div>
    <div>
      <div class="eyebrow" style="margin-bottom:6px">Meetings · ${meetings.length}</div>
      ${meetingRows}
    </div>
    <div>
      <div class="eyebrow" style="margin-bottom:6px">Tasks · ${tasks.length}</div>
      ${taskRows}
    </div>`;
}

/* ---------- client detail modal ---------- */
export function clientDetailHtml(m, H) {
  const c = client(m.id);
  if (!c)
    return `${H('Client')}<div class="modal-b muted">This client no longer exists.</div><div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Close</button></div>`;
  const ds = crmDeals()
    .filter(d => d.client === c.id)
    .sort((a, b) => b.created - a.created);
  const t = dealTotals(ds);
  const prop = (icon, label, val) => `<dt>${ic(icon, 14)}${label}</dt><dd>${val}</dd>`;
  return `${H(esc(c.name), esc(clientCompany(c, crmOrgs()) || 'Client'))}
  <div class="modal-b" style="gap:14px">
    <dl class="kv">
      ${prop('mail', 'Email', c.email ? `<button class="pillbtn" data-a="copyText" data-text="${esc(c.email)}">${ic('copy', 12)}${esc(c.email)}</button>` : '<span class="faint">—</span>')}
      ${prop('phone', 'Phone', c.phone ? `<button class="pillbtn" data-a="copyText" data-text="${esc(c.phone)}">${ic('copy', 12)}${esc(c.phone)}</button>` : '<span class="faint">—</span>')}
      ${prop('signal-high', 'Status', cStatusPill(c.status))}
      ${c.owner ? prop('user', 'Owner', av(c.owner, 'sm')) : ''}
      ${c.org && org(c.org) ? prop('building-2', 'Organisation', `<button class="pillbtn" data-a="openOrg" data-id="${esc(c.org)}">${ic('building-2', 12)}${esc(org(c.org).name)}</button>`) : ''}
      ${prop('calendar', 'Added', fmtDate(new Date(c.created || Date.now())))}
    </dl>
    ${c.notes ? `<div class="field"><span class="label">Notes</span><div class="muted" style="font-size:13px;line-height:1.55;white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}
    <div>
      <div class="eyebrow" style="margin-bottom:6px">Deals · ${eur(t.openValue)} open · ${eur(t.wonValue)} won</div>
      ${
        ds.length
          ? `<div class="panel" style="padding:4px;box-shadow:none">${ds
              .map(
                d =>
                  `<div class="mini" style="min-height:44px" data-a="editDeal" data-id="${d.id}"><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(d.title)}</div><div class="faint" style="font-size:11.5px">${d.close ? 'Close ' + fmtDate(d.close) : 'No close date'}</div></div><span class="num" style="font-weight:600;font-size:12.5px">${eur(d.value)}</span>${stagePill(d.stage)}</div>`,
              )
              .join('')}</div>`
          : `<div class="faint" style="font-size:12.5px">No deals yet for this client.</div>`
      }
    </div>
    ${clientLinkSections(c)}
  </div>
  <div class="modal-f"><button class="btn btn-ghost" data-a="openPipeline">${ic('briefcase', 14)}Pipeline</button><span class="sp"></span><button class="btn btn-secondary" data-a="removeClient" data-id="${c.id}">${ic('trash-2', 14)}Remove</button><button class="btn btn-primary" data-a="editClient" data-id="${c.id}">Edit client</button></div>`;
}

/* ---------- AC5: organisation select options (None + orgs) ---------- */
const orgOptionsHtml = selected =>
  `<option value="">None</option>${crmOrgs()
    .map(o => `<option value="${esc(o.id)}"${selected === o.id ? ' selected' : ''}>${esc(o.name)}</option>`)
    .join('')}`;

/* Workspace members as owner options; empty option = explicitly unowned. */
const ownerOptionsHtml = selected =>
  `<option value="">—</option>${(D().members || [])
    .map(m => `<option value="${esc(m.id)}"${selected === m.id ? ' selected' : ''}>${esc(m.name)}</option>`)
    .join('')}`;

/* ---------- client add/edit modal ---------- */
export function clientFormHtml(m, H) {
  const f = S.ui.crmForm || {};
  const err = S.ui.errors.crmName;
  return `${H(m.edit ? 'Edit client' : 'New client', m.edit ? '' : 'A contact you do business with.')}
  <form class="modal-b" data-submit="submitClient" style="gap:12px">
    <div class="field"><label class="label" for="c-name">Name</label><input class="input ${err ? 'is-error' : ''}" id="c-name" data-in="crmForm" data-f="name" value="${esc(f.name || '')}" placeholder="e.g. Sanne van der Berg" autofocus aria-invalid="${!!err}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:180px"><label class="label" for="c-email">Email</label><input class="input" id="c-email" type="email" data-in="crmForm" data-f="email" value="${esc(f.email || '')}" placeholder="name@company.com"></div>
      <div class="field grow" style="min-width:150px"><label class="label" for="c-phone">Phone</label><input class="input" id="c-phone" data-in="crmForm" data-f="phone" value="${esc(f.phone || '')}" placeholder="+31 20 555 0134"></div>
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:150px"><label class="label" for="c-status">Status</label><select class="select" id="c-status" data-in="crmForm" data-f="status">${CLIENT_STATUSES.map(
        s => `<option value="${s.id}" ${f.status === s.id ? 'selected' : ''}>${s.name}</option>`,
      ).join('')}</select></div>
      <div class="field grow" style="min-width:170px"><label class="label" for="c-org">Organisation</label><select class="select" id="c-org" data-in="crmForm" data-f="org">${orgOptionsHtml(f.org || '')}</select></div>
      <div class="field grow" style="min-width:140px"><label class="label" for="c-owner">Owner</label><select class="select" id="c-owner" data-in="crmForm" data-f="owner">${ownerOptionsHtml(f.owner || '')}</select></div>
    </div>
    <div class="field"><label class="label" for="c-notes">Notes</label><textarea class="textarea" id="c-notes" data-in="crmForm" data-f="notes" rows="3" placeholder="Context, preferences, next steps…">${esc(f.notes || '')}</textarea></div>
  </form>
  <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitClient">${m.edit ? 'Save changes' : 'Add client'}</button></div>`;
}

/* ---------- deal add/edit modal ---------- */
export function dealFormHtml(m, H) {
  const f = S.ui.crmForm || {};
  const err = S.ui.errors.dealTitle;
  const cls = crmClients();
  return `${H(m.edit ? 'Edit deal' : 'New deal', m.edit ? '' : 'Track an opportunity from first contact to close.')}
  <form class="modal-b" data-submit="submitDeal" style="gap:12px">
    <div class="field"><label class="label" for="d-title">Deal</label><input class="input ${err ? 'is-error' : ''}" id="d-title" data-in="crmForm" data-f="title" value="${esc(f.title || '')}" placeholder="e.g. Webshop relaunch" autofocus aria-invalid="${!!err}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:170px"><label class="label" for="d-client">Client</label><select class="select" id="d-client" data-in="crmForm" data-f="client">${cls
        .map(
          c =>
            `<option value="${c.id}" ${f.client === c.id ? 'selected' : ''}>${esc(c.name)}${clientCompany(c, crmOrgs()) ? ' — ' + esc(clientCompany(c, crmOrgs())) : ''}</option>`,
        )
        .join('')}${cls.length ? '' : '<option value="" disabled>No clients yet</option>'}</select></div>
      <div class="field" style="width:140px"><label class="label" for="d-value">Value (EUR)</label><input class="input" id="d-value" type="number" min="0" step="1" data-in="crmForm" data-f="value" value="${esc(f.value || '')}" placeholder="0"></div>
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:170px"><label class="label" for="d-org">Organisation</label><select class="select" id="d-org" data-in="crmForm" data-f="org">${orgOptionsHtml(f.org || '')}</select><span class="hint">Optional and independent of the client — an organisation deal may have no contact.</span></div>
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:150px"><label class="label" for="d-stage">Stage</label><select class="select" id="d-stage" data-in="crmForm" data-f="stage">${Object.values(
        CRM_STAGE,
      )
        .map(s => `<option value="${s.id}" ${f.stage === s.id ? 'selected' : ''}>${s.name}</option>`)
        .join('')}</select></div>
      <div class="field grow" style="min-width:150px"><label class="label" for="d-close">Close date</label><input class="input" id="d-close" type="date" data-in="crmForm" data-f="close" value="${esc(f.close || '')}"></div>
      <div class="field grow" style="min-width:140px"><label class="label" for="d-owner">Owner</label><select class="select" id="d-owner" data-in="crmForm" data-f="owner">${ownerOptionsHtml(f.owner || '')}</select></div>
    </div>
    <div class="field"><label class="label" for="d-notes">Notes</label><textarea class="textarea" id="d-notes" data-in="crmForm" data-f="notes" rows="3" placeholder="Next step, decision makers, competition…">${esc(f.notes || '')}</textarea></div>
  </form>
  <div class="modal-f"><span class="sp"></span>${m.edit ? `<button class="btn btn-ghost" data-a="removeDeal" data-id="${m.edit}">${ic('trash-2', 14)}Remove</button>` : ''}<span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitDeal">${m.edit ? 'Save changes' : 'Add deal'}</button></div>`;
}
