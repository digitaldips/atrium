/* Unit tests for the MCP/Agentic pure layer (supabase/functions/_shared/mcp-pure.js).
   Data-in/data-out only: no network, no DOM, no store imports. crypto.subtle
   is the node/Deno global, so PKCE hashing is exercised for real. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_SCOPES,
  validScopes,
  scopeList,
  scopeShort,
  validRedirect,
  sha256Hex,
  verifyPkce,
  validateTaskInput,
  TOOLS,
  requiredScope,
  toolDefs,
  readTask,
  rpcOk,
  rpcErr,
  mcpServerUrl,
  claudeConnectLine,
  grantSummary,
} from '../supabase/functions/_shared/mcp-pure.js';

const b64url = async s => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
};

/* ---------- scopes ---------- */

test('MCP_SCOPES is the fixed grant vocabulary', () => {
  assert.deepEqual(MCP_SCOPES, ['tasks:read', 'tasks:write', 'docs:read', 'chat:read']);
});

test('validScopes accepts space-separated known scopes and rejects junk', () => {
  assert.equal(validScopes('tasks:read docs:read'), true);
  assert.equal(validScopes('tasks:read'), true);
  assert.equal(validScopes(''), false);
  assert.equal(validScopes('admin'), false);
  assert.equal(validScopes('tasks:read tasks:write extra:scope'), false);
  assert.equal(validScopes('x'.repeat(200)), false);
});

test('scopeList keeps only known scopes and dedupes', () => {
  assert.deepEqual(scopeList(['tasks:read', 'bogus', 'tasks:read', 'docs:read']), ['tasks:read', 'docs:read']);
});

test('scopeShort renders human labels for known scopes only', () => {
  assert.deepEqual(scopeShort(['tasks:read', 'tasks:write']), ['Tasks — read', 'Tasks — write']);
  assert.deepEqual(scopeShort(['nonsense']), []);
});

/* ---------- redirect URIs ---------- */

test('validRedirect allows https and loopback http only', () => {
  assert.equal(validRedirect('https://claude.ai/api/mcp/callback'), true);
  assert.equal(validRedirect('http://localhost:8020/callback'), true);
  assert.equal(validRedirect('http://127.0.0.1:9000/cb'), true);
  assert.equal(validRedirect('http://evil.example.com/cb'), false);
  assert.equal(validRedirect('https://h/cb#frag'), false);
  assert.equal(validRedirect('https://user:pass@h/cb'), false);
  assert.equal(validRedirect('not a url'), false);
  assert.equal(validRedirect('https://h/cb?code=x'), false);
  assert.equal(validRedirect(''), false);
  assert.equal(validRedirect('https://h/' + 'x'.repeat(2100)), false);
});

/* ---------- PKCE ---------- */

test('verifyPkce validates a real S256 challenge and rejects a wrong verifier', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p0r_wC1JeFGhf9dz'; // RFC 7636 appendix B
  const challenge = '4MgqGxJwK4S5nfV4Q8ZGYe7HkLmGZ4cAG_2H6vVxqGI';
  // compute the real challenge for this verifier instead of trusting the constant
  const real = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  assert.equal(await verifyPkce(verifier, real), true);
  assert.equal(await verifyPkce(verifier, challenge), false); // mismatched challenge
  assert.equal(await verifyPkce('short', real), false); // verifier length out of RFC range
  assert.equal(await verifyPkce(verifier + ' ', real), false); // unreserved-chars only
  assert.equal(await verifyPkce(verifier, ''), false);
});

test('sha256Hex hashes tokens to a 64-char hex digest', async () => {
  const h = await sha256Hex('atrium-mcp-a-test');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await b64url('atrium-mcp-a-test'));
});

/* ---------- task validation + projection ---------- */

test('validateTaskInput enforces Atrium title/description/priority/status', () => {
  assert.equal(validateTaskInput({ title: 'Fix leak' }), true);
  assert.equal(validateTaskInput({ title: 'Fix leak', priority: 'high', status: 'todo', description: 'd' }), true);
  assert.equal(validateTaskInput({ title: '' }), false);
  assert.equal(validateTaskInput({ title: ' ' }), false);
  assert.equal(validateTaskInput({ title: 'x'.repeat(501) }), false);
  assert.equal(validateTaskInput({ title: 'ok', description: 'd'.repeat(50001) }), false);
  assert.equal(validateTaskInput({ title: 'ok', priority: 'asap' }), false);
  assert.equal(validateTaskInput({ title: 'ok', status: 'doing' }), false);
});

test('requiredScope maps tools to their gate', () => {
  assert.equal(requiredScope('list_projects'), 'tasks:read');
  assert.equal(requiredScope('get_task'), 'tasks:read');
  assert.equal(requiredScope('create_task'), 'tasks:write');
  assert.equal(requiredScope('update_task'), 'tasks:write');
  assert.equal(requiredScope('list_docs'), 'docs:read');
  assert.equal(requiredScope('get_doc'), 'docs:read');
  assert.equal(requiredScope('list_channels'), 'chat:read');
  assert.equal(requiredScope('list_messages'), 'chat:read');
});

test('toolDefs returns every tool and filters by granted scopes', () => {
  assert.equal(TOOLS.length, 9);
  const names = toolDefs(['tasks:read', 'tasks:write', 'docs:read', 'chat:read']).map(t => t.name);
  assert.deepEqual(
    names,
    TOOLS.map(t => t.name),
  );
  const read = toolDefs(['tasks:read']).map(t => t.name);
  assert.deepEqual(read, ['list_projects', 'list_tasks', 'get_task']);
  assert.deepEqual(
    toolDefs(['docs:read']).map(t => t.name),
    ['list_docs', 'get_doc'],
  );
  assert.deepEqual(
    toolDefs(['chat:read']).map(t => t.name),
    ['list_channels', 'list_messages'],
  );
  assert.deepEqual(toolDefs([]), []);
  // every schema declares its properties
  for (const t of toolDefs(MCP_SCOPES)) assert.ok(t.inputSchema && t.inputSchema.type === 'object', t.name);
});

test('readTask projects a doc task to the public MCP shape with a version token', () => {
  const t = {
    id: 't1',
    key: 'OP-3',
    project: 'p1',
    title: 'Roof <b>x</b>',
    desc: 'd',
    status: 'todo',
    priority: 'high',
    due: '2026-11-10',
    created: 1000,
    updated: 2000,
  };
  const r = readTask(t);
  assert.equal(r.version, 2000); // updated epoch-ms rides as the optimistic-concurrency token
  assert.equal(r.title, 'Roof <b>x</b>'); // data, not sanitized markup — consumers treat it as text
  assert.equal(r.project_id, 'p1');
  assert.equal(readTask({}).version, 0);
});

/* ---------- JSON-RPC framing ---------- */

test('rpcOk/rpcErr build the JSON-RPC envelopes', () => {
  assert.deepEqual(rpcOk(7, { tools: [] }), { jsonrpc: '2.0', id: 7, result: { tools: [] } });
  const e = rpcErr(1, -32000, 'no');
  assert.deepEqual(e, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no' } });
});

/* ---------- settings helpers ---------- */

test('mcpServerUrl and claudeConnectLine build from the stack base', () => {
  assert.equal(mcpServerUrl('https://atrium-supabase.ship.digitaldips.xyz/'), 'https://atrium-supabase.ship.digitaldips.xyz/functions/v1/mcp');
  assert.equal(claudeConnectLine('https://x/functions/v1/mcp'), 'claude mcp add --transport http atrium https://x/functions/v1/mcp');
});

/* ---------- grant rendering (settings rows) ---------- */

const NOW = Date.parse('2026-11-05T12:00:00Z');

test('grantSummary renders a grant row: name, scope labels, granted-ago', () => {
  assert.deepEqual(grantSummary({ id: 'g1', client_name: 'Claude', scopes: ['tasks:read', 'tasks:write'], created_at: '2026-11-05T11:45:00Z' }, NOW), {
    id: 'g1',
    name: 'Claude',
    labels: ['Tasks — read', 'Tasks — write'],
    agoText: '15m ago',
  });
  assert.equal(grantSummary({ client_name: 'C', scopes: [], created_at: '2026-11-05T09:30:00Z' }, NOW).agoText, '2h ago');
  assert.equal(grantSummary({ client_name: 'C', scopes: [], created_at: '2026-11-02T12:00:00Z' }, NOW).agoText, '3d ago');
});

test('grantSummary survives junk and unknown scopes honestly', () => {
  assert.equal(grantSummary(null), null);
  assert.equal(grantSummary({}), null);
  assert.deepEqual(grantSummary({ client_name: 'X', scopes: 'junk', created_at: 'nope' }, NOW), { id: null, name: 'X', labels: [], agoText: '' });
  assert.deepEqual(grantSummary({ client_name: 'X', scopes: ['future:scope'], created_at: '2026-11-05T11:59:30Z' }, NOW).labels, ['future:scope']);
});
