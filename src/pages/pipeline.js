/* ---------- CRM · Deals pipeline (route: pipeline) ---------- */
import { esc, fmtDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { client, crmClients, crmDeals, org } from '../core/store.js';
import { CRM_STAGES, eur } from '../core/crm.js';
import { empty } from '../ui/helpers.js';
import { fxc } from '../shell/render.js';
import { crmSummary, STAGE_C } from './crm.js';

/* One deal card: draggable between stage columns (data-drag-deal), click
   opens the edit modal. Reuses the task-board .kcard machinery/styles. */
export function dealCard(d) {
  const c = client(d.client);
  const oc = d.org ? org(d.org) : null;
  return `<div class="kcard${fxc('moved', d.id)}" draggable="true" data-drag-deal="${d.id}" data-a="editDeal" data-id="${d.id}" role="button" tabindex="0" aria-label="${esc(d.title)}, ${eur(d.value)}">
    <div class="top"><div class="title">${esc(d.title)}</div></div>
    ${d.notes ? `<div class="desc faint" style="font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(d.notes)}</div>` : ''}
    <div class="meta">
      <span class="m" data-tip="${esc(c?.name || 'No client')}" style="max-width:120px"><span class="trunc" style="font-size:11.5px;color:var(--text-2)">${esc(c?.name || 'No client')}</span></span>
      ${oc ? `<span class="m" data-tip="Organisation" style="max-width:110px"><span class="trunc" style="font-size:11.5px;color:var(--text-2)">${ic('building-2', 11)} ${esc(oc.name)}</span></span>` : ''}
      ${d.close ? `<span class="m" aria-label="Close date">${ic('calendar', 12)}${fmtDate(d.close)}</span>` : ''}
      <span class="m" style="margin-left:auto;font-weight:600" aria-label="Value">${eur(d.value)}</span>
    </div>
    <div class="hacts"><button class="ibtn ibtn-xs" data-a="editDeal" data-id="${d.id}" data-tip="Edit deal" aria-label="Edit deal">${ic('pencil', 12)}</button><button class="ibtn ibtn-xs" data-a="removeDeal" data-id="${d.id}" data-tip="Remove deal" aria-label="Remove deal">${ic('trash-2', 13)}</button></div>
  </div>`;
}

export function pagePipeline() {
  const ds = crmDeals();
  if (!crmClients().length && !ds.length)
    return `<div class="page wide">
      <div class="ph"><div><h1>Pipeline</h1><p>Deals move Lead → Qualified → Proposal → Won.</p></div></div>
      ${crmSummary()}
      <div class="panel">${empty('briefcase', 'No deals yet', 'Add a deal to start tracking your pipeline, or add a client first.', `<button class="btn btn-primary btn-sm" data-a="newDeal">${ic('plus', 14)}Add deal</button> <button class="btn btn-secondary btn-sm" data-a="newClient">${ic('plus', 14)}Add client</button>`)}</div>
    </div>`;
  return `<div class="page flush">
    <div class="ph" style="padding:24px var(--gutter) 0;margin:0"><div><h1>Pipeline</h1><p>Drag deals between stages · ${ds.length} deal${ds.length === 1 ? '' : 's'}</p></div><div class="acts"><button class="btn btn-primary" data-a="newDeal">${ic('plus', 14)}Add deal</button></div></div>
    <div style="padding:16px var(--gutter) 0">${crmSummary()}</div>
    <div class="board pipeline" data-keep="pipeline">${CRM_STAGES.map(s => {
      const col = ds.filter(d => d.stage === s.id).sort((a, b) => a.created - b.created);
      const sum = col.reduce((v, d) => v + (Number(d.value) || 0), 0);
      return `<section class="bcol" data-drop-stage="${s.id}" aria-label="${s.name}">
      <div class="bcol-h"><i class="stg-dot" style="--c:${STAGE_C[s.id]}"></i><span>${s.name}</span><span class="cnt">${col.length}</span><span class="sum faint" style="margin-left:2px;font-size:11.5px;font-weight:500">${eur(sum)}</span>
        <span class="acts"><button class="ibtn ibtn-xs" data-a="newDeal" data-stage="${s.id}" data-tip="Add deal" aria-label="Add deal to ${s.name}">${ic('plus', 14)}</button></span></div>
      <div class="bcol-b" data-col-body="${s.id}">
        ${col.map(dealCard).join('')}
        <button class="addcard" data-a="newDeal" data-stage="${s.id}">${ic('plus', 14)}Add deal</button>
      </div>
    </section>`;
    }).join('')}</div>
  </div>`;
}
