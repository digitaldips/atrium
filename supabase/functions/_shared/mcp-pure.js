/* =====================================================================
   MCP/AGENTIC PURE HELPERS (node tests + Deno edge function + frontend)
   Data-in/data-out only: no network, no DOM, no store imports. Crypto via
   the global crypto.subtle (node ≥18 and Deno both expose it).
   ===================================================================== */

/* ---------- scopes ---------- */
export const MCP_SCOPES = ['tasks:read', 'tasks:write', 'docs:read', 'chat:read'];
export const SCOPE_LABELS = {
  'tasks:read': 'Tasks — read',
  'tasks:write': 'Tasks — write',
  'docs:read': 'Docs — read',
  'chat:read': 'Chat — read',
};
const SCOPE_SET = new Set(MCP_SCOPES);

export function validScopes(scopeStr) {
  if (typeof scopeStr !== 'string' || !scopeStr || scopeStr.length >= 128) return false;
  return scopeStr.split(' ').every(s => SCOPE_SET.has(s));
}

export function scopeList(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(s => SCOPE_SET.has(s)))];
}

export function scopeShort(scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes.filter(s => SCOPE_SET.has(s)).map(s => SCOPE_LABELS[s]);
}

/* ---------- redirect URIs (RFC 8252 native-app rules) ---------- */
export function validRedirect(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return false;
  if (u.username || u.password || u.hash) return false;
  for (const k of ['code', 'state', 'iss', 'error']) if (u.searchParams.has(k)) return false;
  return true;
}

/* ---------- PKCE (S256) + token hashing ---------- */
export async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

const b64urlBytes = d => {
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return b64urlBytes(d) === challenge;
}

/* ---------- task validation (Atrium vocab) ---------- */
const STATUSES = new Set(['backlog', 'todo', 'progress', 'review', 'done']);
const PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none']);

export function validateTaskInput({ title, description, priority, status } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 500) return false;
  if (description != null && (typeof description !== 'string' || description.length > 50000)) return false;
  if (priority != null && !PRIORITIES.has(priority)) return false;
  if (status != null && !STATUSES.has(status)) return false;
  return true;
}

/* ---------- tools ---------- */
const arg = (desc, type = 'string') => ({ type, description: desc });
export const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the projects in the approved workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tasks',
    description: 'List live tasks, optionally filtered by project and a title/description query.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: arg('Limit to one project id. Omit to search all.'),
        query: arg('Match task title or description, or a task key such as OP-12.'),
        limit: arg('Maximum number of tasks, 1 to 100. Default 50.', 'number'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Read one live task by id or key.',
    inputSchema: { type: 'object', properties: { task_id: arg('Task id, or its key such as OP-12.') }, required: ['task_id'], additionalProperties: false },
  },
  {
    name: 'create_task',
    description: 'Create a task in a project of the approved workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: arg('Project id to create the task in.'),
        title: arg('Task title (1 to 500 characters).'),
        description: arg('Optional description.'),
        status: arg("Optional status: backlog, todo, progress, review or done. Default 'todo'."),
        priority: arg('Optional priority: urgent, high, medium, low or none.'),
      },
      required: ['project_id', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description: 'Update a task using its current version (optimistic concurrency).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: arg('Task id, or its key such as OP-12.'),
        expected_version: arg('The version the task carried when you read it (get_task/list_tasks).', 'number'),
        title: arg('New title.'),
        description: arg('New description.'),
        status: arg('New status.'),
        priority: arg('New priority.'),
      },
      required: ['task_id', 'expected_version'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_docs',
    description: 'List documents in the workspace (trashed excluded).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_doc',
    description: 'Read one document.',
    inputSchema: { type: 'object', properties: { doc_id: arg('Document id.') }, required: ['doc_id'], additionalProperties: false },
  },
  {
    name: 'list_channels',
    description: 'List chat channels the connected user is a member of.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_messages',
    description: 'Read the latest messages from one channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: arg('Channel id.'),
        limit: arg('Maximum messages, 1 to 100. Default 50.', 'number'),
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
];

export function requiredScope(name) {
  switch (name) {
    case 'create_task':
    case 'update_task':
      return 'tasks:write';
    case 'list_docs':
    case 'get_doc':
      return 'docs:read';
    case 'list_channels':
    case 'list_messages':
      return 'chat:read';
    default:
      return 'tasks:read';
  }
}

export function toolDefs(scopes) {
  const set = new Set(Array.isArray(scopes) ? scopes : []);
  return TOOLS.filter(t => set.has(requiredScope(t.name)));
}

/* ---------- projections ---------- */
/* The optimistic-concurrency token is the task's `updated` epoch-ms: the app
   bumps it on every edit (applyPatch) and MCP writes bump it too, so a stale
   caller's expected_version no longer matches. */
export function readTask(t) {
  return {
    id: t.id,
    key: t.key || null,
    project_id: t.project,
    title: t.title || '',
    description: t.desc || '',
    status: t.status || 'todo',
    priority: t.priority || 'none',
    assignee: t.assignee || null,
    due: t.due || null,
    created: t.created || null,
    updated: t.updated || null,
    version: Number(t.updated || 0),
  };
}

/* ---------- JSON-RPC framing ---------- */
export function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}
export function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/* ---------- settings helpers ---------- */
export function mcpServerUrl(base) {
  return `${String(base || '').replace(/\/+$/, '')}/functions/v1/mcp`;
}
export function claudeConnectLine(url) {
  return `claude mcp add --transport http atrium ${url}`;
}

/* One authorized-client grant → what the Agentic settings row renders.
   Unknown scopes render as themselves (honest), junk grants render empty. */
export function grantSummary(g, now = Date.now()) {
  if (!g || !g.client_name) return null;
  const labels = (Array.isArray(g.scopes) ? g.scopes : []).map(s => SCOPE_LABELS[s] || s);
  const created = Date.parse(g.created_at || '') || 0;
  const age = created ? Math.max(0, now - created) : 0;
  const mins = Math.floor(age / 60000);
  const agoText = !created
    ? ''
    : mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins}m ago`
        : mins < 1440
          ? `${Math.floor(mins / 60)}h ago`
          : `${Math.floor(mins / 1440)}d ago`;
  return { id: g.id || null, name: String(g.client_name), labels, agoText };
}
