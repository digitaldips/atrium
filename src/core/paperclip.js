/* =====================================================================
   PAPERCLIP CLIENT — fetch boundary for the Agents surface (route #agents).
   Every call goes through the paperclip-bridge edge function (allowlisted
   proxy to the Paperclip API); the browser never sees a board token.
   Fetch orchestration is gated by the pure shouldFetch settled-state
   contract: loading/ok/empty/error are terminal until an explicit re-arm
   (Retry action or a post-decision re-arm) — no render→fetch loops.
   ===================================================================== */
import { S } from './store.js';
import { sb } from './supabase.js';
import { render } from '../shell/render.js';
import {
  PC_TABS,
  buildApprovalAction,
  freshTab,
  mapActivity,
  mapAgent,
  mapApproval,
  mapBudgets,
  mapCosts,
  shouldFetch,
} from '../../supabase/functions/_shared/paperclip-pure.js';

const FN_BASE = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/paperclip-bridge';

export const PC_TAB_NAMES = [
  ['agents', 'Agents', 'bot'],
  ['approvals', 'Approvals', 'circle-check'],
  ['activity', 'Activity', 'activity'],
  ['budget', 'Budget', 'gauge'],
];

/* The per-tab state store; created on first touch (freshTab() = idle). */
export function pcState() {
  if (!S.ui.pc) {
    S.ui.pc = Object.fromEntries([...PC_TABS, 'models'].map(k => [k, freshTab()]));
  }
  return S.ui.pc;
}

async function sessionToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

async function pcFetch(path, { method = 'GET', body } = {}) {
  const token = await sessionToken();
  if (!token) throw new Error('You are signed out — sign in to view Agents.');
  const res = await fetch(`${FN_BASE()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.message || out.error || `Paperclip bridge returned HTTP ${res.status}.`);
  return out;
}

/* One loader per tab; each settles into ok/empty/error (all terminal).
   The Agents tab also fetches the adapter's model options (pure extra
   slot, never blocks the agent list — its failure is surfaced as a hint). */
export async function loadPcTab(tab) {
  const pc = pcState();
  if (!shouldFetch(pc[tab])) return;
  pc[tab] = { ...freshTab(), status: 'loading' };
  render();
  try {
    if (tab === 'agents') {
      const rows = await pcFetch('/agents');
      const items = (Array.isArray(rows) ? rows : []).map(mapAgent);
      pc.agents = { status: items.length ? 'ok' : 'empty', items, error: null, adapter: items[0]?.adapter || '' };
      if (items.length) loadPcModels(items[0].adapter);
    } else if (tab === 'approvals') {
      const rows = await pcFetch('/approvals?status=pending');
      const items = (Array.isArray(rows) ? rows : []).map(mapApproval);
      pc.approvals = { status: items.length ? 'ok' : 'empty', items, error: null };
    } else if (tab === 'activity') {
      const rows = await pcFetch('/activity?limit=30');
      const items = (Array.isArray(rows) ? rows : []).map(mapActivity);
      pc.activity = { status: items.length ? 'ok' : 'empty', items, error: null };
    } else if (tab === 'budget') {
      const [overview, costs] = await Promise.all([pcFetch('/budgets'), pcFetch('/costs')]);
      const budgets = mapBudgets(overview);
      pc.budget = {
        status: 'ok',
        summary: { ...mapCosts(costs), pausedAgents: budgets.pausedAgents, pendingApprovals: budgets.pendingApprovals },
        policies: budgets.policies,
        incidents: budgets.incidents,
        items: [],
        error: null,
      };
    }
  } catch (err) {
    pc[tab] = { status: 'error', items: [], error: err instanceof Error ? err.message : 'Paperclip is unreachable.' };
  }
  render();
}

/* Model options for the adapter the live agents run on. A separate
   settled slot: failure degrades to an honest hint, not an error state. */
async function loadPcModels(adapter) {
  const pc = pcState();
  if (!shouldFetch(pc.models)) return;
  try {
    const rows = await pcFetch(`/models/${encodeURIComponent(adapter)}`);
    pc.models = { status: 'ok', items: (Array.isArray(rows) ? rows : []).map(m => ({ id: String(m?.id ?? ''), label: String(m?.label ?? m?.id ?? '') })) };
  } catch {
    pc.models = { status: 'error', items: [], error: 'Model options unavailable.' };
  }
  render();
}

/* Approve/deny through Paperclip's engine. buildApprovalAction is the pure
   request builder; on success the touched tabs re-arm exactly once. */
export async function decideApproval(id, decision, note) {
  const req = buildApprovalAction(id, decision, note);
  if (!req) throw new Error('Not a valid approval decision.');
  await pcFetch(req.path.slice('/api'.length), { method: req.method, body: req.body });
  const pc = pcState();
  for (const t of ['approvals', 'activity', 'budget', 'agents']) pc[t] = freshTab();
  await loadPcTab('approvals');
  loadPcTab('activity');
  loadPcTab('budget');
}

/* The one re-arm for a settled (error/empty) tab: the Retry action. */
export function retryPcTab(tab) {
  const pc = pcState();
  if (!PC_TABS.includes(tab)) return;
  pc[tab] = freshTab();
  loadPcTab(tab);
}
