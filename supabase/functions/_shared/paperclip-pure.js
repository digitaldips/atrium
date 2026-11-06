/* =====================================================================
   PAPERCLIP BRIDGE PURE LAYER — allowlist + mappers + builders.
   Shared by the paperclip-bridge edge function (Deno) and the Atrium UI
   (src/core/paperclip.js); node-tested in test/paperclip.test.js.
   Data-in/data-out only: no fetch, no DOM, no env reads.
   ===================================================================== */

/* ---------- allowlist (the ONLY paths the bridge forwards) ----------
   Short forms: the UI asks for /agents, /approvals, /budgets, /costs,
   /activity, /models/:type, POST /approvals/:id/approve|reject. The
   caller NEVER names a company — the bridge pins env PAPERCLIP_COMPANY_ID
   when expanding to the upstream /api path (upstreamRoute). Non-matching
   method/path ⇒ null ⇒ bridge answers 400. */
export const PC_ROUTES = [
  { id: 'agents', method: 'GET', segs: ['agents'] },
  { id: 'agent-models', method: 'GET', segs: ['models', ':type'] },
  { id: 'approvals', method: 'GET', segs: ['approvals'] },
  { id: 'budgets', method: 'GET', segs: ['budgets'] },
  { id: 'costs', method: 'GET', segs: ['costs'] },
  { id: 'activity', method: 'GET', segs: ['activity'] },
  { id: 'approve', method: 'POST', segs: ['approvals', ':id', 'approve'] },
  { id: 'reject', method: 'POST', segs: ['approvals', ':id', 'reject'] },
];

/* Short route id → upstream /api path, with the company pinned by env. */
const UPSTREAM = {
  agents: c => `/api/companies/${c}/agents`,
  approvals: c => `/api/companies/${c}/approvals`,
  budgets: c => `/api/companies/${c}/budgets/overview`,
  costs: c => `/api/companies/${c}/costs/summary`,
  activity: c => `/api/companies/${c}/activity`,
};

export function upstreamRoute(id, params = {}, companyId = '') {
  if (!UUID_RE.test(String(companyId || ''))) return null;
  if (id === 'agent-models' && SLUG_RE.test(String(params.type || ''))) {
    return `/api/companies/${companyId}/adapters/${params.type}/models`;
  }
  if ((id === 'approve' || id === 'reject') && UUID_RE.test(String(params.id || ''))) {
    return `/api/approvals/${params.id}/${id}`;
  }
  return UPSTREAM[id]?.(companyId) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9_]{0,40}$/i;

/* Resolve (method, path-after-the-function-mount) against the allowlist.
   The path must already be split into RAW segments; each is decoded once
   here so %2e%2e-style tricks fail the same way literal '..' does. */
export function resolveBridgeRoute(method, path) {
  if (typeof path !== 'string') return null;
  const segs = path.split('/').filter(s => s !== '');
  if (!segs.length) return null;
  for (const route of PC_ROUTES) {
    if (route.method !== method || route.segs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const want = route.segs[i];
      let got = segs[i];
      try {
        got = decodeURIComponent(got);
      } catch {
        ok = false; // malformed escape — never guess
      }
      if (!ok) break;
      if (want === ':companyId') params.companyId = got;
      else if (want === ':id') {
        if (!UUID_RE.test(got)) {
          ok = false;
          break;
        }
        params.id = got;
      } else if (want === ':type') {
        if (!SLUG_RE.test(got)) {
          ok = false;
          break;
        }
        params.type = got;
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { id: route.id, params };
  }
  return null;
}

/* Only allowlisted upstream query params survive; everything else is
   dropped. Returns '' or an encoded 'k=v' string. */
const QUERY_RULES = {
  approvals: { status: v => (/^[a-z_]{1,30}$/.test(v) ? v : null) },
  activity: { limit: v => (/^\d{1,4}$/.test(v) ? String(Math.min(200, parseInt(v, 10))) : null) },
};

export function sanitizeQuery(routeId, query = {}) {
  const rules = QUERY_RULES[routeId] || {};
  const out = [];
  for (const [k, check] of Object.entries(rules)) {
    const v = check(String(query[k] ?? ''));
    if (v !== null) out.push(`${k}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

/* ---------- approve/deny request builders ---------- */
export function buildApprovalAction(id, decision, note) {
  if (!UUID_RE.test(String(id || '')) || (decision !== 'approve' && decision !== 'reject')) return null;
  return {
    method: 'POST',
    path: `/api/approvals/${id}/${decision}`,
    body: decision === 'reject' && note ? { decisionNote: String(note) } : {},
  };
}

/* ---------- settled-state fetch contract ----------
   A tab state is { status: 'idle'|'loading'|'ok'|'empty'|'error', ... }.
   loading/ok/empty/error are TERMINAL for fetching; only an explicit
   re-arm (Retry / after a mutation) resets to idle. This is the guard
   that keeps render→fetch loops dead. */
export function shouldFetch(state) {
  return !!state && state.status === 'idle';
}

export function freshTab() {
  return { status: 'idle', items: [], error: null };
}

export const PC_TABS = ['agents', 'approvals', 'activity', 'budget'];

/* ---------- response → view-model mappers ----------
   Every field degrades to '' / '—' / 'unknown' rather than throwing;
   strings are passed through UNMANGLED so the UI's esc() is the single
   escaping point (never double-escape, never skip). */

const str = v => (v == null ? '' : String(v));
const int0 = v => (Number.isFinite(v) ? v : 0);

export function fmtCents(cents) {
  if (!Number.isFinite(cents) || cents < 0) return '—';
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Budget of 0 means "no budget set" upstream — render '—', never a fake $0.00. */
export const fmtBudget = cents => (Number.isFinite(cents) && cents > 0 ? fmtCents(cents) : '—');

export function mapAgent(row) {
  if (!row || typeof row !== 'object') {
    return { id: '', name: '', role: '', adapter: '', status: 'unknown', errorReason: '', budgetText: '—', spentText: '—', lastHeartbeatAt: '' };
  }
  return {
    id: str(row.id),
    name: str(row.name),
    role: str(row.role),
    adapter: str(row.adapterType),
    status: str(row.status) || 'unknown',
    errorReason: str(row.errorReason),
    budgetText: fmtBudget(row.budgetMonthlyCents),
    spentText: fmtCents(row.spentMonthlyCents),
    lastHeartbeatAt: str(row.lastHeartbeatAt),
  };
}

export function mapApproval(row) {
  if (!row || typeof row !== 'object') {
    return { id: '', type: '', status: 'pending', summary: '', requestedByAgentId: '', createdAt: '' };
  }
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const summary = str(payload.title) || str(payload.name) || str(payload.reason) || `${str(row.type)} request`;
  return {
    id: str(row.id),
    type: str(row.type),
    status: str(row.status) || 'pending',
    summary,
    requestedByAgentId: str(row.requestedByAgentId),
    createdAt: str(row.createdAt),
  };
}

export function mapActivity(row) {
  if (!row || typeof row !== 'object') {
    return { id: '', action: '', actorType: 'system', entityType: '', entityId: '', createdAt: '' };
  }
  return {
    id: str(row.id),
    action: str(row.action),
    actorType: str(row.actorType) || 'system',
    entityType: str(row.entityType),
    entityId: str(row.entityId),
    createdAt: str(row.createdAt),
  };
}

export function mapBudgets(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    policies: Array.isArray(b.policies) ? b.policies : [],
    incidents: Array.isArray(b.activeIncidents) ? b.activeIncidents : [],
    pausedAgents: int0(b.pausedAgentCount),
    pendingApprovals: int0(b.pendingApprovalCount),
  };
}

export function mapCosts(body) {
  const c = body && typeof body === 'object' ? body : {};
  return {
    spendText: fmtCents(c.spendCents),
    budgetText: fmtBudget(c.budgetCents),
    utilization: int0(c.utilizationPercent),
  };
}
