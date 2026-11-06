/* Unit tests for the Paperclip bridge pure layer (supabase/functions/_shared/paperclip-pure.js).
   Data-in/data-out only: no network, no DOM, no store imports. Covers the bridge
   allowlist exactness, response→view-model mappers (incl. null/empty upstream
   fields and hostile strings), approve/deny request builders, upstream query
   sanitization, and the shouldFetch settled-state contract (AC5/AC6). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PC_ROUTES,
  resolveBridgeRoute,
  upstreamRoute,
  sanitizeQuery,
  buildApprovalAction,
  shouldFetch,
  freshTab,
  PC_TABS,
  mapAgent,
  mapApproval,
  mapActivity,
  mapBudgets,
  mapCosts,
  fmtCents,
} from '../supabase/functions/_shared/paperclip-pure.js';

const UUID = 'cd64ed32-4999-496d-a205-84b73d7b5dd3';
const CO = '7b332c82-e1db-4de0-b16f-f17040882f08';

/* ---------- allowlist ---------- */
test('allowlist contains exactly the recon routes', () => {
  const ids = PC_ROUTES.map(r => r.id).sort();
  assert.deepEqual(ids, ['activity', 'agent-models', 'agents', 'approvals', 'approve', 'budgets', 'costs', 'reject']);
  for (const r of PC_ROUTES) {
    assert.ok(['GET', 'POST'].includes(r.method));
    assert.ok(Array.isArray(r.segs) && r.segs.length >= 1);
  }
});

test('resolves every short bridge path the UI calls (company never travels from the caller)', () => {
  assert.equal(resolveBridgeRoute('GET', 'agents').id, 'agents');
  assert.equal(resolveBridgeRoute('GET', 'approvals').id, 'approvals');
  assert.equal(resolveBridgeRoute('GET', 'budgets').id, 'budgets');
  assert.equal(resolveBridgeRoute('GET', 'costs').id, 'costs');
  assert.equal(resolveBridgeRoute('GET', 'activity').id, 'activity');
  assert.equal(resolveBridgeRoute('GET', 'models/claude_local').id, 'agent-models');
  assert.equal(resolveBridgeRoute('POST', `approvals/${UUID}/approve`).id, 'approve');
  assert.equal(resolveBridgeRoute('POST', `approvals/${UUID}/reject`).id, 'reject');
});

test('captures path params', () => {
  const m = resolveBridgeRoute('GET', 'models/claude_local');
  assert.equal(m.params.type, 'claude_local');
  const r = resolveBridgeRoute('POST', `approvals/${UUID}/approve`);
  assert.equal(r.params.id, UUID);
});

test('expands short routes to pinned upstream /api paths', () => {
  assert.equal(upstreamRoute('agents', {}, CO), `/api/companies/${CO}/agents`);
  assert.equal(upstreamRoute('approvals', {}, CO), `/api/companies/${CO}/approvals`);
  assert.equal(upstreamRoute('budgets', {}, CO), `/api/companies/${CO}/budgets/overview`);
  assert.equal(upstreamRoute('costs', {}, CO), `/api/companies/${CO}/costs/summary`);
  assert.equal(upstreamRoute('activity', {}, CO), `/api/companies/${CO}/activity`);
  assert.equal(upstreamRoute('agent-models', { type: 'claude_local' }, CO), `/api/companies/${CO}/adapters/claude_local/models`);
  assert.equal(upstreamRoute('approve', { id: UUID }, CO), `/api/approvals/${UUID}/approve`);
  assert.equal(upstreamRoute('reject', { id: UUID }, CO), `/api/approvals/${UUID}/reject`);
  /* a non-uuid company id in env must never reach upstream */
  assert.equal(upstreamRoute('agents', {}, 'garbage'), null);
  assert.equal(upstreamRoute('nope', {}, CO), null);
});

test('rejects non-allowlisted methods and paths (incl. full paperclip shapes — caller never picks a company)', () => {
  assert.equal(resolveBridgeRoute('DELETE', 'agents'), null);
  assert.equal(resolveBridgeRoute('GET', 'foo'), null);
  assert.equal(resolveBridgeRoute('GET', ''), null);
  assert.equal(resolveBridgeRoute('GET', `companies/${CO}/agents`), null);
  assert.equal(resolveBridgeRoute('GET', 'agents/extra'), null);
  assert.equal(resolveBridgeRoute('GET', `companies/${CO}/secrets`), null);
  assert.equal(resolveBridgeRoute('POST', 'agents'), null);
  assert.equal(resolveBridgeRoute('GET', `companies/${CO}/adapters/claude_local/models`), null);
});

test('rejects traversal and prefix tricks', () => {
  assert.equal(resolveBridgeRoute('GET', 'approvals/../secrets'), null);
  assert.equal(resolveBridgeRoute('GET', 'companies/x/../../etc'), null);
  assert.equal(resolveBridgeRoute('GET', 'models/%2e%2e/secrets'), null);
  assert.equal(resolveBridgeRoute('GET', 'approvals/..%2fsecrets/approve'), null);
  assert.equal(resolveBridgeRoute('POST', `approvals/${UUID}/approve/../../secrets`), null);
});

test('rejects malformed ids and types (no free-text segments)', () => {
  assert.equal(resolveBridgeRoute('POST', 'approvals/not-a-uuid/approve'), null);
  assert.equal(resolveBridgeRoute('POST', "approvals/' OR 1=1--/approve"), null);
  assert.equal(resolveBridgeRoute('GET', 'models/<script>'), null);
  assert.equal(resolveBridgeRoute('GET', 'models/claude local'), null);
});

/* ---------- upstream query sanitization ---------- */
test('sanitizes query params per route', () => {
  assert.equal(sanitizeQuery('approvals', { status: 'pending' }), 'status=pending');
  assert.equal(sanitizeQuery('approvals', { status: 'pending', evil: '<>' }), 'status=pending');
  assert.equal(sanitizeQuery('approvals', { status: 'DROP TABLE x' }), '');
  assert.equal(sanitizeQuery('activity', { limit: '25' }), 'limit=25');
  assert.equal(sanitizeQuery('activity', { limit: '9999' }), 'limit=200');
  assert.equal(sanitizeQuery('activity', { limit: 'abc;rm' }), '');
  assert.equal(sanitizeQuery('agents', { limit: '5' }), '');
  assert.equal(sanitizeQuery('approve', {}), '');
});

/* ---------- approve/deny request builders ---------- */
test('builds approve/deny requests through paperclip routes', () => {
  assert.deepEqual(buildApprovalAction(UUID, 'approve'), {
    method: 'POST',
    path: `/api/approvals/${UUID}/approve`,
    body: {},
  });
  assert.deepEqual(buildApprovalAction(UUID, 'reject', 'not needed'), {
    method: 'POST',
    path: `/api/approvals/${UUID}/reject`,
    body: { decisionNote: 'not needed' },
  });
  assert.equal(buildApprovalAction(UUID, 'postpone'), null);
  assert.equal(buildApprovalAction('../../secrets', 'approve'), null);
  assert.equal(buildApprovalAction('', 'approve'), null);
});

/* ---------- settled-state fetch contract ---------- */
test('shouldFetch: only an idle (unsettled) tab fetches', () => {
  for (const status of ['idle']) assert.equal(shouldFetch({ status }), true, status);
  for (const status of ['loading', 'ok', 'empty', 'error']) assert.equal(shouldFetch({ status }), false, status);
  assert.equal(shouldFetch(null), false);
  assert.equal(shouldFetch({}), false);
});

test('freshTab starts idle with empty items', () => {
  const t = freshTab();
  assert.equal(t.status, 'idle');
  assert.deepEqual(t.items, []);
  assert.equal(t.error, null);
});

test('PC_TABS is the fixed four-tab surface', () => {
  assert.deepEqual(PC_TABS, ['agents', 'approvals', 'activity', 'budget']);
});

/* ---------- mappers ---------- */
test('mapAgent: full row', () => {
  const vm = mapAgent({
    id: UUID,
    name: 'Chief of staff',
    role: 'ceo',
    title: null,
    status: 'error',
    errorReason: 'Claude run failed: Not logged in',
    adapterType: 'claude_local',
    budgetMonthlyCents: 5000,
    spentMonthlyCents: 1234,
    lastHeartbeatAt: '2026-08-10T21:37:26.215Z',
  });
  assert.deepEqual(vm, {
    id: UUID,
    name: 'Chief of staff',
    role: 'ceo',
    adapter: 'claude_local',
    status: 'error',
    errorReason: 'Claude run failed: Not logged in',
    budgetText: '$50.00',
    spentText: '$12.34',
    lastHeartbeatAt: '2026-08-10T21:37:26.215Z',
  });
});

test('mapAgent: null/empty/hostile fields never throw and stay esc-able strings', () => {
  const vm = mapAgent({ id: UUID, name: '<script>alert(1)</script>', status: null });
  assert.equal(vm.name, '<script>alert(1)</script>');
  assert.equal(vm.role, '');
  assert.equal(vm.adapter, '');
  assert.equal(vm.status, 'unknown');
  assert.equal(vm.errorReason, '');
  assert.equal(vm.budgetText, '—');
  assert.equal(vm.spentText, '—');
  assert.equal(vm.lastHeartbeatAt, '');
  assert.doesNotThrow(() => mapAgent(null));
  assert.deepEqual(mapAgent(null), {
    id: '',
    name: '',
    role: '',
    adapter: '',
    status: 'unknown',
    errorReason: '',
    budgetText: '—',
    spentText: '—',
    lastHeartbeatAt: '',
  });
});

test('mapApproval: full + sparse rows', () => {
  const vm = mapApproval({
    id: UUID,
    type: 'hire_agent',
    status: 'pending',
    requestedByAgentId: CO,
    payload: { title: 'Hire a writer', role: 'writer' },
    createdAt: '2026-11-06T10:00:00.000Z',
  });
  assert.equal(vm.id, UUID);
  assert.equal(vm.type, 'hire_agent');
  assert.equal(vm.status, 'pending');
  assert.equal(vm.summary, 'Hire a writer');
  assert.equal(vm.createdAt, '2026-11-06T10:00:00.000Z');
  const sparse = mapApproval({ id: UUID, type: 'request_board_approval', status: 'pending', payload: {} });
  assert.equal(sparse.summary, 'request_board_approval request');
  assert.equal(sparse.requestedByAgentId, '');
  assert.doesNotThrow(() => mapApproval(null));
  const hostile = mapApproval({ id: UUID, type: 'x', status: 'pending', payload: { title: '</textarea><img src=x onerror=alert(1)>' } });
  assert.equal(hostile.summary, '</textarea><img src=x onerror=alert(1)>');
});

test('mapActivity: full + nulls', () => {
  const vm = mapActivity({
    id: UUID,
    action: 'agent.key_created',
    actorType: 'user',
    entityType: 'agent',
    entityId: CO,
    createdAt: '2026-08-10T21:42:07.305Z',
  });
  assert.equal(vm.action, 'agent.key_created');
  assert.equal(vm.actorType, 'user');
  assert.equal(vm.entityType, 'agent');
  assert.equal(vm.createdAt, '2026-08-10T21:42:07.305Z');
  const sparse = mapActivity({ id: UUID });
  assert.equal(sparse.action, '');
  assert.equal(sparse.actorType, 'system');
  assert.equal(sparse.entityType, '');
  assert.doesNotThrow(() => mapActivity(null));
});

test('mapBudgets / mapCosts: sparse upstream bodies stay honest', () => {
  assert.deepEqual(mapBudgets({ policies: [], activeIncidents: [], pausedAgentCount: 0, pendingApprovalCount: 0 }), {
    policies: [],
    incidents: [],
    pausedAgents: 0,
    pendingApprovals: 0,
  });
  const b = mapBudgets({ policies: [{ id: 'p1', scope: 'company', monthlyLimitCents: 10000, spentCents: 2500 }], activeIncidents: null });
  assert.equal(b.policies.length, 1);
  assert.equal(b.incidents.length, 0);
  assert.doesNotThrow(() => mapBudgets(null));
  assert.deepEqual(mapCosts({ spendCents: 123456, budgetCents: 0, utilizationPercent: 0 }), {
    spendText: '$1,234.56',
    budgetText: '—',
    utilization: 0,
  });
  assert.doesNotThrow(() => mapCosts(null));
});

test('fmtCents: money rendering incl. null/zero', () => {
  assert.equal(fmtCents(0), '$0.00');
  assert.equal(fmtCents(123456), '$1,234.56');
  assert.equal(fmtCents(5), '$0.05');
  assert.equal(fmtCents(null), '—');
  assert.equal(fmtCents(undefined), '—');
  assert.equal(fmtCents(-3), '—');
});
