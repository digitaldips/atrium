/* ---------- SALES DASHBOARD (route: dashboard) ----------
   The methodology view over the CRM document: realistische pipeline
   (Σ expected × kans over open deals — 'zeker' counts at 100%), forecast
   by close month, won history by wonAt, stage breakdown, per-org rollup
   and win rate. Doc-side ONLY: every number comes from the pure engine
   in core/forecast.js over crmDeals()/crmClients()/crmOrgs() — no fetch
   orchestrator, nothing to guard. Wesley's workspace starts EMPTY, so
   every section carries an honest zero state. */
import { esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { crmClients, crmDeals, crmOrgs } from '../core/store.js';
import { dealTotals, eur } from '../core/crm.js';
import { forecastByMonth, orgRollup, realisticPipeline, stageBreakdown, winRate, wonByMonth } from '../core/forecast.js';
import { STAGE_C } from './crm.js';
import { empty } from '../ui/helpers.js';

const pct = k => `${Math.round((Number(k) || 0) * 100)}%`;

/* Horizontal CSS bar, zero-dependency: width relative to the row set's
   max, floored at 2% so a small but real value stays visible — a ZERO
   value renders no bar at all. */
const fbar = (v, max, c) =>
  `<div class="fbar" role="presentation"><i style="width:${v > 0 && max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0}%;--c:${c}"></i></div>`;

const fbarRow = (left, right, v, max, c) =>
  `<div class="fbar-row"><div class="row" style="gap:8px;justify-content:space-between"><span style="min-width:0"><span class="trunc" style="display:inline-block;max-width:100%;font-weight:500;font-size:13px">${left}</span></span><span class="num" style="flex-shrink:0;font-size:12.5px;font-weight:600">${right}</span></div>${fbar(v, max, c)}</div>`;

const statsStrip = (rp, t, wr) =>
  `<div class="stats" style="margin-bottom:16px">
    <div class="stat"><span class="k">${ic('target', 13)}Realistische pipeline</span><span class="v">${eur(rp)}</span><span class="d">Σ verwachte waarde × kans</span></div>
    <div class="stat"><span class="k">${ic('briefcase', 13)}Open pipeline</span><span class="v">${eur(t.openValue)}</span><span class="d">${t.openCount} open deal${t.openCount === 1 ? '' : 's'}</span></div>
    <div class="stat"><span class="k">${ic('trophy', 13)}Gewonnen</span><span class="v">${eur(t.wonValue)}</span><span class="d">${t.wonCount} afgerond</span></div>
    <div class="stat"><span class="k">${ic('percent', 13)}Win rate</span><span class="v">${pct(wr.rate)}</span><span class="d">${wr.won} gewonnen · ${wr.lost} verloren</span></div>
  </div>`;

export function pageDashboard() {
  const deals = crmDeals();
  const clients = crmClients();
  const orgs = crmOrgs();
  const now = new Date();
  const t = dealTotals(deals);
  const rp = realisticPipeline(deals);
  const wr = winRate(deals);
  const head = `<div class="ph"><div><h1>Dashboard</h1><p>Verwachte waarde × kans per deal — je realistische pipeline</p></div><div class="acts"><button class="btn btn-primary" data-a="newDeal">${ic('plus', 14)}Add deal</button></div></div>`;

  /* Wesley's workspace is EMPTY by default — an honest zero dashboard. */
  if (!deals.length)
    return `<div class="page wide">
      ${head}
      ${statsStrip(rp, t, wr)}
      <div class="panel">${empty('chart-column', 'No deals yet', 'Forecast, won history and stage breakdown fill in as soon as pipeline is added.', `<button class="btn btn-primary btn-sm" data-a="newDeal">${ic('plus', 14)}Add deal</button> <button class="btn btn-secondary btn-sm" data-a="newClient">${ic('plus', 14)}Add client</button>`)}</div>
    </div>`;

  const fc = forecastByMonth(deals, 7, now);
  const won = wonByMonth(deals, 6, now);
  const sb = stageBreakdown(deals);
  const roll = orgRollup(orgs, deals, clients);

  /* --- forecast: current + next 6 months by close month --- */
  const monthRows = fc.months
    .map(
      b =>
        `<tr><td style="padding-left:14px">${b.label}</td><td class="num">${b.count}</td><td class="num muted">${eur(b.expected)}</td><td class="num" style="font-weight:600">${eur(b.weighted)}</td></tr>`,
    )
    .join('');
  const extraRows = [
    fc.unscheduled.count
      ? `<tr class="faint"><td style="padding-left:14px">No close date</td><td class="num">${fc.unscheduled.count}</td><td class="num muted">${eur(fc.unscheduled.expected)}</td><td class="num">${eur(fc.unscheduled.weighted)}</td></tr>`
      : '',
    fc.outside.count
      ? `<tr class="faint"><td style="padding-left:14px">Outside window</td><td class="num">${fc.outside.count}</td><td class="num muted">${eur(fc.outside.expected)}</td><td class="num">${eur(fc.outside.weighted)}</td></tr>`
      : '',
  ].join('');
  const forecastPanel = `<section class="panel">
    <div class="panel-h"><h2>Forecast</h2><div class="acts"><span class="faint" style="font-size:11.5px">gewogen per sluitmaand</span></div></div>
    <div class="panel-b">
      <div style="overflow-x:auto"><table class="perm-t" style="min-width:380px"><thead><tr><th style="padding-left:14px">Month</th><th>Deals</th><th>Expected</th><th>Weighted</th></tr></thead>
        <tbody>${monthRows}</tbody>
        ${extraRows ? `<tbody class="faint">${extraRows}</tbody>` : ''}
      </table></div>
      <div class="hint" style="margin-top:10px">${ic('info', 13)}<span>Een retainer telt zijn volledige verwachte waarde (bedrag per maand × looptijd) in zijn sluitmaand.</span></div>
    </div>
  </section>`;

  /* --- stage breakdown: the 4 categories + won/lost --- */
  const maxStage = Math.max(...sb.map(r => r.expected));
  const stageRows = sb
    .map(r => {
      const c = STAGE_C[r.id] || 'var(--gray)';
      return fbarRow(
        `${esc(r.name)} <span class="faint" style="font-weight:400">· kans ${pct(r.kans)}</span>`,
        `${eur(r.expected)} <span class="faint" style="font-weight:400">· gewogen ${eur(r.weighted)} · ${r.count}×</span>`,
        r.expected,
        maxStage,
        c,
      );
    })
    .join('');
  const stagesPanel = `<section class="panel">
    <div class="panel-h"><h2>Pipeline by stage</h2><div class="acts"><span class="faint" style="font-size:11.5px">expected · gewogen · count</span></div></div>
    <div class="panel-b">${stageRows}</div>
  </section>`;

  /* --- won history: last 6 + current months by wonAt --- */
  const maxWon = Math.max(...won.map(r => r.value));
  const wonRows = won
    .map(r => fbarRow(r.label, `${eur(r.value)} <span class="faint" style="font-weight:400">· ${r.count}×</span>`, r.value, maxWon, 'var(--green)'))
    .join('');
  const wonPanel = `<section class="panel">
    <div class="panel-h"><h2>Gewonnen</h2><div class="acts"><span class="faint" style="font-size:11.5px">last 6 months by wonAt</span></div></div>
    <div class="panel-b">${won.some(r => r.count) ? wonRows : `<div class="faint" style="font-size:12.5px">Nothing won yet — drag a deal to Gewonnen when it is afgerond.</div>`}</div>
  </section>`;

  /* --- per-organisation rollup: top orgs by open weighted pipeline --- */
  const orgRows = roll
    .slice(0, 5)
    .map(
      r =>
        `<div class="mini" style="min-height:44px" role="button" tabindex="0" data-a="openOrg" data-id="${esc(r.org.id)}">${ic('building-2', 14)}<div class="grow" style="min-width:0"><div style="font-weight:500;font-size:13px">${esc(r.org.name)}</div><div class="faint" style="font-size:11.5px">${r.contacts} contact${r.contacts === 1 ? '' : 's'} · ${r.deals} open deal${r.deals === 1 ? '' : 's'}</div></div><span class="num" style="font-weight:600;font-size:12.5px;flex-shrink:0">${eur(r.openWeighted)}</span></div>`,
    )
    .join('');
  const orgsPanel = `<section class="panel">
    <div class="panel-h"><h2>Organisations</h2><div class="acts"><span class="faint" style="font-size:11.5px">open weighted · top ${Math.min(5, roll.length) || 5}</span></div></div>
    <div class="panel-b" style="padding:4px">${orgRows || `<div class="faint" style="font-size:12.5px;padding:10px">No organisations yet — group contacts under an organisation to see pipeline per company.</div>`}</div>
  </section>`;

  return `<div class="page wide">
    ${head}
    ${statsStrip(rp, t, wr)}
    <div class="grid2">
      ${forecastPanel}
      ${stagesPanel}
      ${wonPanel}
      ${orgsPanel}
    </div>
  </div>`;
}
