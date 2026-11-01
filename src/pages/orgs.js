/* ---------- ORGANISATIONS (route: orgs list · org detail) ----------
   Orgs are workspace-doc containers (doc.orgs) grouping contacts, deals
   and notes. The list is a rollup (contacts / open pipeline / industry);
   the detail page stacks the four read-only rollup sections. Creating
   happens through the forms (prefilled where opened from an org), the
   auto-suggest is SUGGEST + one-click confirm on the Clients page. */
import { ago, esc, fmtDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, client, crmClients, crmDeals, crmLinks, crmOrgs, org } from '../core/store.js';
import { orgActivityFor, orgClients, orgDealsFor, orgListRow, orgNotesFor } from '../core/orgs.js';
import { dealTotals, eur } from '../core/crm.js';
import { UNTITLED, noteTitleFromHtml } from '../core/notes.js';
import { crmAv, stagePill } from './crm.js';
import { empty } from '../ui/helpers.js';

/* ---------- AC2: organisations list ---------- */
export function pageOrgs() {
  const u = S.ui;
  const q = (u.orgQ || '').toLowerCase();
  const orgs = crmOrgs();
  const rows = orgs
    .map(o => orgListRow(o, { clients: crmClients(), deals: crmDeals() }))
    .filter(r => !q || [r.org.name, r.org.domain, r.org.industry].some(x => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.org.name || '').localeCompare(b.org.name || ''));
  let body;
  if (!orgs.length)
    body = `<div class="panel">${empty('building-2', 'No organisations yet', 'Group the contacts, deals and notes of one company under a single organisation.', `<button class="btn btn-primary btn-sm" data-a="newOrg">${ic('plus', 14)}Add organisation</button>`)}</div>`;
  else if (!rows.length)
    body = `<div class="panel">${empty('search-x', 'No results found', 'No organisations match your search. Try a different term.', `<button class="btn btn-secondary btn-sm" data-a="orgQClear">Clear search</button>`)}</div>`;
  else
    body = `<div class="panel" style="overflow-x:auto"><table class="perm-t" style="min-width:680px"><thead><tr><th style="padding-left:14px">Organisation</th><th style="text-align:left">Contacts</th><th style="text-align:left">Open pipeline</th><th style="text-align:left">Industry</th><th></th></tr></thead><tbody>
    ${rows
      .map(
        r =>
          `<tr style="cursor:pointer" data-a="openOrg" data-id="${esc(r.org.id)}"><td style="padding-left:14px"><span style="font-weight:500;display:block">${esc(r.org.name)}</span><span class="faint" style="font-size:11.5px">${esc(r.org.domain || 'No domain')}</span></td><td style="text-align:left" class="num">${r.contacts}</td><td style="text-align:left" class="num muted">${eur(r.openValue)}</td><td style="text-align:left"><span class="faint" style="font-size:12.5px">${esc(r.industry || '—')}</span></td><td><button class="ibtn ibtn-sm" data-a="editOrg" data-id="${esc(r.org.id)}" aria-label="Edit organisation">${ic('ellipsis', 14)}</button></td></tr>`,
      )
      .join('')}
    </tbody></table></div>`;
  return `<div class="page wide">
    <div class="ph"><div><h1>Organisations</h1><p>${orgs.length} organisation${orgs.length === 1 ? '' : 's'} · companies that group your contacts, deals and notes</p></div><div class="acts"><button class="btn btn-primary" data-a="newOrg">${ic('plus', 14)}Add organisation</button></div></div>
    <div class="row" style="margin-bottom:16px;gap:8px;flex-wrap:wrap">
      <div class="inwrap">${ic('search', 13)}<input class="input search-sm" id="org-q" data-in="orgQ" placeholder="Search organisations" value="${esc(u.orgQ || '')}" aria-label="Search organisations"></div>
    </div>
    ${body}
  </div>`;
}

/* ---------- AC3: organisation detail (read-only rollups + prefilled forms) ---------- */
export function pageOrg() {
  const o = org(S.ui.params.id);
  if (!o)
    return `<div class="page wide"><div class="panel">${empty('building-2', 'Organisation not found', 'It may have been removed.', `<button class="btn btn-secondary btn-sm" data-a="go" data-r="orgs">${ic('building-2', 14)}All organisations</button>`)}</div></div>`;
  const contacts = orgClients(o.id, crmClients());
  const dealRows = orgDealsFor(o.id, crmDeals(), crmClients());
  const notes = orgNotesFor(o.id, D().notes || []);
  const activity = orgActivityFor(o.id, crmLinks(), crmClients());
  const t = dealTotals(dealRows.map(r => r.deal));
  const clientName = id => client(id)?.name || '';
  const contactsHtml = contacts.length
    ? `<div class="panel" style="padding:4px;box-shadow:none">${contacts
        .map(
          c =>
            `<div class="mini" style="min-height:44px" role="button" tabindex="0" data-a="openClient" data-id="${esc(c.id)}">${crmAv(c)}<div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(c.name)}</div><div class="faint" style="font-size:11.5px">${esc(c.company || c.email || '')}</div></div><span class="faint num" style="font-size:11.5px;flex-shrink:0">${esc(c.email || '')}</span></div>`,
        )
        .join('')}</div>`
    : `<div class="faint" style="font-size:12.5px">No contacts attached yet.</div>`;
  const dealsHtml = dealRows.length
    ? `<div class="panel" style="padding:4px;box-shadow:none">${dealRows
        .map(r => {
          const d = r.deal;
          return `<div class="mini" style="min-height:44px" role="button" tabindex="0" data-a="editDeal" data-id="${esc(d.id)}"><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(d.title)}</div><div class="faint" style="font-size:11.5px">${d.close ? 'Close ' + fmtDate(d.close) : 'No close date'}</div></div>${r.derived ? `<span class="lblbadge sys" style="flex-shrink:0" title="Derived from the deal's contact — the deal itself has no organisation set">${ic('building-2', 11)}via ${esc(clientName(d.client))}</span>` : ''}<span class="num" style="font-weight:600;font-size:12.5px">${eur(d.value)}</span>${stagePill(d.stage)}</div>`;
        })
        .join('')}</div>`
    : `<div class="faint" style="font-size:12.5px">No deals yet — direct deals carry this organisation, deals of its contacts count in derived.</div>`;
  const notesHtml = notes.length
    ? `<div class="panel" style="padding:4px;box-shadow:none">${notes
        .map(
          n =>
            `<div class="mini" style="min-height:44px" role="button" tabindex="0" data-a="noteOpen" data-id="${esc(n.id)}"><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(n.title || noteTitleFromHtml(n.html) || UNTITLED)}</div></div><span class="faint num" style="font-size:11.5px;flex-shrink:0">${ago(n.updated)}</span></div>`,
        )
        .join('')}</div>`
    : `<div class="faint" style="font-size:12.5px">No notes attached to this organisation yet.</div>`;
  const activityHtml = activity.length
    ? `<div class="panel" style="padding:4px;box-shadow:none">${activity
        .map(l =>
          l.kind === 'mail'
            ? `<div class="mini" role="button" tabindex="0" data-a="gOpenMail" data-id="${esc(l.ref)}"><span class="ftype" style="--c:var(--red)">${ic('mail', 14)}</span><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(l.title || '(no subject)')}</div><div class="faint" style="font-size:11.5px"><span class="trunc" style="display:inline-block;max-width:100%">${esc(l.snippet || '')}</span></div></div><span class="faint" style="font-size:11.5px;flex-shrink:0">${esc(l.clientName || '')}</span><span class="faint num" style="font-size:11.5px;flex-shrink:0">${l.when ? fmtDate(new Date(l.when)) : ''}</span></div>`
            : `<div class="mini" role="button" tabindex="0" data-a="pop" data-pop="gevent" data-id="${esc(l.ref)}"><span class="ftype" style="--c:#1A73E8">${ic('calendar-days', 14)}</span><div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(l.title || '(untitled event)')}</div></div><span class="faint" style="font-size:11.5px;flex-shrink:0">${esc(l.clientName || '')}</span><span class="faint num" style="font-size:11.5px;flex-shrink:0">${l.when ? fmtDate(new Date(l.when)) : ''}</span></div>`,
        )
        .join('')}</div>
        <div class="faint" style="font-size:11.5px;margin-top:6px">Rolled up from the mail and meetings linked to this organisation's contacts. Read-only — unlink from the contact or the inbox.</div>`
    : `<div class="faint" style="font-size:12.5px">No linked mail or meetings yet — link them from the inbox or a contact.</div>`;
  const section = (label, extra, inner) =>
    `<div><div class="row" style="margin-bottom:6px"><div class="eyebrow">${label}</div><span class="sp"></span>${extra || ''}</div>${inner}</div>`;
  return `<div class="page wide">
    <div class="ph"><div><h1>${esc(o.name)}</h1><p>${o.domain ? `${ic('globe', 12)} ${esc(o.domain)}` : 'No domain yet'}${o.industry ? ` · ${esc(o.industry)}` : ''}</p></div><div class="acts"><button class="btn btn-danger-ghost" data-a="removeOrg" data-id="${esc(o.id)}">${ic('trash-2', 14)}Remove</button><button class="btn btn-secondary" data-a="editOrg" data-id="${esc(o.id)}">${ic('pencil', 14)}Edit</button></div></div>
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><span class="k">Contacts</span><span class="v">${contacts.length}</span><span class="d">${contacts.length === 1 ? 'client' : 'clients'} attached</span></div>
      <div class="stat"><span class="k">Open pipeline</span><span class="v">${eur(t.openValue)}</span><span class="d">${t.openCount} open deal${t.openCount === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="k">Won</span><span class="v">${eur(t.wonValue)}</span><span class="d">${t.wonCount} won</span></div>
      <div class="stat"><span class="k">Notes</span><span class="v">${notes.length}</span><span class="d">attached</span></div>
    </div>
    ${section(`Contacts · ${contacts.length}`, `<button class="btn btn-ghost btn-sm" data-a="orgNewClient" data-id="${esc(o.id)}">${ic('plus', 13)}Add contact</button>`, contactsHtml)}
    ${section(`Deals · ${eur(t.openValue)} open · ${eur(t.wonValue)} won`, `<button class="btn btn-ghost btn-sm" data-a="orgNewDeal" data-id="${esc(o.id)}">${ic('plus', 13)}Add deal</button>`, dealsHtml)}
    ${section(`Notes · ${notes.length}`, `<button class="btn btn-ghost btn-sm" data-a="orgNoteNew" data-id="${esc(o.id)}">${ic('plus', 13)}Add note</button>`, notesHtml)}
    ${section(`Activity · ${activity.length}`, '', activityHtml)}
  </div>`;
}

/* ---------- AC2: organisation add/edit modal ---------- */
export function orgFormHtml(m, H) {
  const f = S.ui.orgForm || {};
  const err = S.ui.errors.orgName;
  return `${H(m.edit ? 'Edit organisation' : 'New organisation', m.edit ? '' : 'A company that groups contacts, deals and notes.')}
  <form class="modal-b" data-submit="submitOrg" style="gap:12px">
    <div class="field"><label class="label" for="o-name">Name</label><input class="input ${err ? 'is-error' : ''}" id="o-name" data-in="orgForm" data-f="name" value="${esc(f.name || '')}" placeholder="e.g. Noorderlicht Group" autofocus aria-invalid="${!!err}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field grow" style="min-width:180px"><label class="label" for="o-domain">Domain</label><input class="input" id="o-domain" data-in="orgForm" data-f="domain" value="${esc(f.domain || '')}" placeholder="company.com — matches client email domains"><span class="hint">Used to suggest contacts whose email ends in this domain. Exact match only.</span></div>
      <div class="field grow" style="min-width:150px"><label class="label" for="o-industry">Industry</label><input class="input" id="o-industry" data-in="orgForm" data-f="industry" value="${esc(f.industry || '')}" placeholder="Optional"></div>
    </div>
    <div class="field"><label class="label" for="o-notes">Notes</label><textarea class="textarea" id="o-notes" data-in="orgForm" data-f="notes" rows="3" placeholder="Context about the organisation…">${esc(f.notes || '')}</textarea></div>
  </form>
  <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitOrg">${m.edit ? 'Save changes' : 'Add organisation'}</button></div>`;
}
