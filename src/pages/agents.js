/* =====================================================================
   AGENTS PAGE (route: agents) — the Paperclip surface inside Atrium.
   One route, four internal tabs: Agents / Approvals / Activity / Budget.
   Every paperclip-originated string renders through esc(); every tab
   settles into an honest loading/ok/empty/error state (terminal until
   the Retry re-arm). Approve/Deny fire Paperclip's real engine via the
   paperclip-bridge — a two-click explicit confirm guards the mutation.
   ===================================================================== */
import { esc, ago } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { empty } from '../ui/helpers.js';
import { PC_TAB_NAMES, loadPcTab, pcState } from '../core/paperclip.js';
import { fmtBudget, fmtCents } from '../../supabase/functions/_shared/paperclip-pure.js';

const STATUS_C = { active: 'var(--ok)', paused: 'var(--warn)', error: 'var(--danger)' };
const dot = status => `<span class="sdot" style="background:${STATUS_C[status] || 'var(--faint)'}"></span>`;

export function pageAgents() {
  const tab = PC_TAB_NAMES.some(([k]) => k === S.ui.params.tab) ? S.ui.params.tab : 'agents';
  const pc = pcState();
  /* First render of a tab kicks off exactly one fetch (shouldFetch gate). */
  loadPcTab(tab);
  const head = `<div class="ph"><div><h1>Agents</h1><p>Your Paperclip agent crew — approvals, activity and budget, live through the bridge.</p></div></div>`;
  const tabs = `<nav class="tabs" aria-label="Agents sections">${PC_TAB_NAMES.map(
    ([k, n, i]) =>
      `<button ${tab === k ? 'aria-current="page"' : ''} class="tab ${tab === k ? 'on' : ''}" data-a="go" data-r="agents" data-tab="${k}">${ic(i, 14)}${n}</button>`,
  ).join('')}</nav>`;
  const body = tab === 'agents' ? agentsBody(pc) : tab === 'approvals' ? approvalsBody(pc) : tab === 'activity' ? activityBody(pc) : budgetBody(pc);
  return `<div class="page wide">${head}${tabs}<div style="margin-top:14px">${body}</div></div>`;
}

/* Shared settled-state renderer: honest loading/error/empty, Retry re-arm. */
function settled(st, { emptyIcon, emptyTitle, emptyText, renderOk }) {
  if (st.status === 'loading') return `<div class="panel"><p class="hint">${ic('loader', 14)} Loading from Paperclip…</p></div>`;
  if (st.status === 'error')
    return `<div class="alert danger">${ic('triangle-alert', 15)}<span>${esc(st.error || 'Paperclip is unreachable.')}</span></div>
      <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" data-a="pcRetry" data-tab="${st._tab}">${ic('rotate-cw', 14)}Retry</button></div>`;
  if (st.status === 'empty') return `<div class="panel">${empty(emptyIcon, emptyTitle, emptyText)}</div>`;
  return renderOk();
}

function agentsBody(pc) {
  const st = { ...pc.agents, _tab: 'agents' };
  const models =
    pc.models.status === 'ok' && pc.models.items.length
      ? `<p class="hint" style="margin:0 0 12px">Model options (${esc(pc.agents.adapter || 'adapter')}): ${pc.models.items.map(m => esc(m.label)).join(' · ')}</p>`
      : pc.models.status === 'error'
        ? `<p class="hint" style="margin:0 0 12px">Model options unavailable.</p>`
        : '';
  return settled(st, {
    emptyIcon: 'bot',
    emptyTitle: 'No agents yet',
    emptyText: 'Agents hired in Paperclip will appear here.',
    renderOk: () =>
      `${models}<div class="panel" style="padding:4px">${pc.agents.items
        .map(
          a => `<div class="srow">
        <div style="min-width:0">
          <div class="t">${dot(a.status)}${esc(a.name)}</div>
          <div class="d">${esc(a.role)} · ${esc(a.adapter)} · budget ${esc(a.budgetText)} · spent ${esc(a.spentText)}${a.lastHeartbeatAt ? ` · heartbeat ${esc(ago(new Date(a.lastHeartbeatAt).getTime()))}` : ''}</div>
          ${a.errorReason ? `<div class="d" style="color:var(--danger)">${ic('triangle-alert', 12)} ${esc(a.errorReason)}</div>` : ''}
        </div>
        <span class="badge" style="text-transform:capitalize">${esc(a.status)}</span>
      </div>`,
        )
        .join('')}</div>`,
  });
}

function approvalsBody(pc) {
  const st = { ...pc.approvals, _tab: 'approvals' };
  const confirm = S.ui.pcConfirm || null;
  return settled(st, {
    emptyIcon: 'circle-check',
    emptyTitle: 'No pending approvals',
    emptyText: 'Paperclip posts approval requests here when agents need a board decision.',
    renderOk: () => `<div class="panel" style="padding:4px">${pc.approvals.items
      .map(a => {
        const armedApprove = confirm && confirm.id === a.id && confirm.decision === 'approve';
        const armedDeny = confirm && confirm.id === a.id && confirm.decision === 'deny';
        return `<div class="srow">
        <div style="min-width:0">
          <div class="t">${esc(a.summary)}</div>
          <div class="d">${esc(a.type)} · ${esc(a.status)}${a.createdAt ? ` · ${esc(ago(new Date(a.createdAt).getTime()))}` : ''}</div>
        </div>
        <div class="row" style="gap:6px">
          ${
            armedApprove
              ? `<button class="btn btn-primary btn-sm" data-a="pcApprove" data-id="${esc(a.id)}">${ic('check', 13)}Confirm</button>`
              : `<button class="btn btn-primary btn-sm" data-a="pcArmApprove" data-id="${esc(a.id)}">${ic('check', 13)}Approve</button>`
          }
          ${
            armedDeny
              ? `<button class="btn btn-danger btn-sm" data-a="pcDeny" data-id="${esc(a.id)}">${ic('x', 13)}Confirm deny</button>`
              : `<button class="btn btn-danger-ghost btn-sm" data-a="pcArmDeny" data-id="${esc(a.id)}">${ic('x', 13)}Deny</button>`
          }
          ${armedApprove || armedDeny ? `<button class="btn btn-secondary btn-sm" data-a="pcConfirmReset" data-id="${esc(a.id)}">Cancel</button>` : ''}
        </div>
      </div>`;
      })
      .join('')}</div>
      <p class="hint" style="margin-top:8px">Approve/Deny run through Paperclip's own engine — its side effects and activity log apply.</p>`,
  });
}

function activityBody(pc) {
  const st = { ...pc.activity, _tab: 'activity' };
  return settled(st, {
    emptyIcon: 'activity',
    emptyTitle: 'No activity yet',
    emptyText: 'Agent actions and decisions log here as they happen in Paperclip.',
    renderOk: () =>
      `<div class="panel" style="padding:4px">${pc.activity.items
        .map(
          a => `<div class="srow">
        <div style="min-width:0">
          <div class="t">${esc(a.action)}</div>
          <div class="d">${esc(a.actorType)}${a.entityType ? ` · ${esc(a.entityType)}` : ''}${a.createdAt ? ` · ${esc(ago(new Date(a.createdAt).getTime()))}` : ''}</div>
        </div>
      </div>`,
        )
        .join('')}</div>`,
  });
}

function budgetBody(pc) {
  const st = { ...pc.budget, _tab: 'budget' };
  return settled(st, {
    emptyIcon: 'gauge',
    emptyTitle: 'No budget data',
    emptyText: 'Budget policies and spend appear once Paperclip tracks them.',
    renderOk: () => {
      const s = pc.budget.summary || {};
      const policyRow = p =>
        `<div class="srow"><div><div class="t">${esc(p.scopeName || p.scopeType || 'policy')}<span class="badge" style="margin-left:8px">${esc(p.status || 'ok')}</span></div><div class="d">${esc(p.metric || 'billed_cents')} / ${esc(p.windowKind || 'window')} · limit ${esc(fmtBudget(p.amount))} · observed ${esc(fmtCents(p.observedAmount))} · ${esc(p.utilizationPercent ?? 0)}%</div></div></div>`;
      return `
      <div class="stats" style="margin-bottom:16px">
        <div class="stat"><span class="k">${ic('coins', 13)}Spend this month</span><span class="v">${esc(s.spendText || '—')}</span><span class="d">all agents</span></div>
        <div class="stat"><span class="k">${ic('wallet', 13)}Budget</span><span class="v">${esc(s.budgetText || '—')}</span><span class="d">company budget</span></div>
        <div class="stat"><span class="k">${ic('percent', 13)}Utilization</span><span class="v">${esc(s.utilization || 0)}%</span><span class="d">of budget</span></div>
        <div class="stat"><span class="k">${ic('pause', 13)}Paused</span><span class="v">${esc(s.pausedAgents || 0)}</span><span class="d">agents by budget incidents</span></div>
      </div>
      <div class="panel" style="padding:4px;margin-bottom:14px">${(pc.budget.policies || []).map(policyRow).join('') || '<p class="hint" style="padding:8px 10px">No budget policies set.</p>'}</div>
      ${
        (pc.budget.incidents || []).length
          ? `<div class="panel" style="padding:4px">${pc.budget.incidents.map(i => `<div class="srow"><div><div class="t">${esc(i.scopeName || i.metric || 'budget incident')} · ${esc(i.status || 'open')}</div><div class="d">${esc(fmtCents(i.amountObserved))} observed of ${esc(fmtCents(i.amountLimit))} · ${esc(i.thresholdType || '')}${i.approvalStatus ? ` · approval ${esc(i.approvalStatus)}` : ''}</div></div></div>`).join('')}</div>`
          : `<p class="hint">No active budget incidents.</p>`
      }`;
    },
  });
}
