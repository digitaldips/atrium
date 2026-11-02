/* ---------- CRM · Deals pipeline (route: pipeline) ---------- */
import { esc, fmtDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { client, crmClients, crmDeals, org } from '../core/store.js';
import { CRM_STAGES, eur } from '../core/crm.js';
import { expectedValue, stageKans, weightedValue } from '../core/forecast.js';
import { empty, av } from '../ui/helpers.js';
import { fxc } from '../shell/render.js';
import { crmSummary, STAGE_C } from './crm.js';

/* One deal card: draggable between stage columns (data-drag-deal), click
   opens the edit modal. Reuses the task-board .kcard machinery/styles.
   Type icon: briefcase = project, repeat = retainer. Shows the expected
   value AND the weighted value (expected × stage kans). */
export function dealCard(d) {
  const c = client(d.client);
  const oc = d.org ? org(d.org) : null;
  const isRet = d.type === 'retainer';
  const w = weightedValue(d);
  /* At kans 1.0 (Zeker/Gewonnen) weighted == expected — showing both is the
     same price twice. The gewogen chip only earns its line below 100%. */
  const belowCertain = stageKans(d.stage) < 1;
  return `<div class="kcard${fxc('moved', d.id)}" draggable="true" data-drag-deal="${d.id}" data-a="editDeal" data-id="${d.id}" role="button" tabindex="0" aria-label="${esc(d.title)}, ${eur(expectedValue(d))}">
    <div class="top"><div class="title">${esc(d.title)}</div><span class="m faint" data-tip="${isRet ? 'Retainer — bedrag per maand × looptijd' : 'Project — vaste projectwaarde'}">${ic(isRet ? 'repeat' : 'briefcase', 12)}</span></div>
    ${d.notes ? `<div class="desc faint" style="font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(d.notes)}</div>` : ''}
    <div class="meta">
      <span class="m" data-tip="${esc(c?.name || 'No client')}" style="flex:1;min-width:0"><span class="trunc" style="font-size:11.5px;color:var(--text-2)">${esc(c?.name || 'No client')}</span></span>
      <span class="m" style="font-weight:600" aria-label="Expected value, weighted ${eur(w)}">${eur(expectedValue(d))}</span>
    </div>
    <div class="meta" style="margin-top:4px">
      ${oc ? `<span class="m" data-tip="Organisation" style="flex:1;min-width:0"><span class="trunc" style="font-size:11.5px;color:var(--text-2)">${ic('building-2', 11)} ${esc(oc.name)}</span></span>` : ''}
      ${d.close ? `<span class="m" aria-label="Close date" style="white-space:nowrap">${ic('calendar', 12)}${fmtDate(d.close)}</span>` : ''}
      ${d.owner ? `<span class="m" data-tip="Owner">${av(d.owner, 'sm')}</span>` : ''}
      ${belowCertain ? `<span class="m faint" style="margin-left:auto;font-weight:500" aria-label="Weighted value" data-tip="Gewogen = verwachte waarde × kans">${eur(w)} gewogen</span>` : ''}
    </div>
    <div class="hacts"><button class="ibtn ibtn-xs" data-a="editDeal" data-id="${d.id}" data-tip="Edit deal" aria-label="Edit deal">${ic('pencil', 12)}</button><button class="ibtn ibtn-xs" data-a="removeDeal" data-id="${d.id}" data-tip="Remove deal" aria-label="Remove deal">${ic('trash-2', 13)}</button></div>
  </div>`;
}

export function pagePipeline() {
  const ds = crmDeals();
  if (!crmClients().length && !ds.length)
    return `<div class="page wide">
      <div class="ph"><div><h1>Pipeline</h1><p>Deals move Long shot → Mogelijk → Waarschijnlijk → Zeker → Gewonnen.</p></div></div>
      ${crmSummary()}
      <div class="panel">${empty('briefcase', 'No deals yet', 'Add a deal to start tracking your pipeline, or add a client first.', `<button class="btn btn-primary btn-sm" data-a="newDeal">${ic('plus', 14)}Add deal</button> <button class="btn btn-secondary btn-sm" data-a="newClient">${ic('plus', 14)}Add client</button>`)}</div>
    </div>`;
  return `<div class="page flush">
    <div class="ph" style="padding:24px var(--gutter) 0;margin:0"><div><h1>Pipeline</h1><p>Drag deals between stages · ${ds.length} deal${ds.length === 1 ? '' : 's'}</p></div><div class="acts"><button class="btn btn-primary" data-a="newDeal">${ic('plus', 14)}Add deal</button></div></div>
    <div style="padding:16px var(--gutter) 0">${crmSummary()}</div>
    <div class="board pipeline" data-keep="pipeline">${CRM_STAGES.map(s => {
      const col = ds.filter(d => d.stage === s.id).sort((a, b) => a.created - b.created);
      const sum = col.reduce((v, d) => v + (Number(d.value) || 0), 0);
      const tip = `${s.betekenis} — Fase: ${s.fase} · Focus: ${s.focus}`;
      return `<section class="bcol" data-drop-stage="${s.id}" aria-label="${s.name} (kans ${Math.round(s.kans * 100)}%)">
      <div class="bcol-h"><i class="stg-dot" style="--c:${STAGE_C[s.id]}" data-tip="${esc(tip)}"></i><span data-tip="${esc(tip)}">${s.name}</span><span class="cnt">${col.length}</span><span class="sum faint" style="margin-left:2px;font-size:11.5px;font-weight:500" data-tip="Verwachte waarde · kans ${Math.round(s.kans * 100)}%">${eur(sum)}</span>
        <span class="acts"><button class="ibtn ibtn-xs" data-a="newDeal" data-stage="${s.id}" data-tip="Add deal" aria-label="Add deal to ${s.name}">${ic('plus', 14)}</button></span></div>
      <div class="bcol-b" data-col-body="${s.id}">
        ${col.map(dealCard).join('')}
        <button class="addcard" data-a="newDeal" data-stage="${s.id}">${ic('plus', 14)}Add deal</button>
      </div>
    </section>`;
    }).join('')}</div>
  </div>`;
}
