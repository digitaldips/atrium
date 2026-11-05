/* =====================================================================
   AGENTIC PAGES — the OAuth consent route + the Settings → Agentic body.
   The consent screen is served by the APP (AC4): an MCP client's authorize
   lands here as #agentic-auth?req=<id>, the user approves, and the edge
   function binds user + grant and hands back the client callback URL.
   ===================================================================== */
import { esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { getCurrentUser } from '../core/supabase.js';
import { srow } from './settings.js';
import { agenticState, consentState, loadAgenticGrants, mcpUrl, claudeConnectLine, scopeShort, startAgenticConsent } from '../core/agentic.js';
import { grantSummary } from '../../supabase/functions/_shared/mcp-pure.js';

/* ---------- consent route (agentic-auth) ---------- */
export function pageAgenticAuth() {
  const req = S.ui.params.req || '';
  if (!req) return pageAgenticShell('Missing request', '<p class="lead">This authorization link is incomplete — start again from your MCP client.</p>');
  const c = consentState();
  if (c.state === 'idle' && getCurrentUser()) startAgenticConsent(req);
  const inner = !getCurrentUser()
    ? `<div class="alert info">${ic('info', 15)}<span>Sign in to review this connection request.</span></div>`
    : c.state === 'loading'
      ? `<div class="alert info">${ic('loader', 15)}<span>Loading the connection request…</span></div>`
      : c.state === 'error'
        ? `<div class="alert danger">${ic('triangle-alert', 15)}<span>${esc(c.error || 'This authorization request is not valid.')}</span></div>`
        : c.state === 'done'
          ? `<div class="alert ok">${ic('circle-check', 15)}<span>Redirecting you back to the app…</span></div>`
          : consentReady(c.data);
  return pageAgenticShell('Authorize a connection', inner);
}

function consentReady(d) {
  return `
    <div class="panel" style="max-width:460px">
      <div class="row" style="gap:10px;margin-bottom:10px">${ic('bot', 18)}<b style="font-size:15px">${esc(d.client_name)}</b><span class="badge">${esc(d.redirect_to)}</span></div>
      <p class="hint" style="margin:0 0 12px"><b>${esc(d.client_name)}</b> wants to connect to your workspace <b>${esc(d.workspace_name)}</b> through the Atrium MCP server. It will receive a token with exactly these permissions:</p>
      <div class="col" style="gap:6px;margin-bottom:14px">${
        scopeShort(d.scopes)
          .map(l => `<div class="row" style="gap:8px;font-size:13.5px">${ic('check', 14)}<span>${esc(l)}</span></div>`)
          .join('') || '<span class="faint" style="font-size:13px">No permissions requested.</span>'
      }</div>
      <p class="hint" style="margin:0 0 14px">You can remove this access any time in Settings → Agentic.</p>
      <div class="row" style="gap:8px">
        <button class="btn btn-primary" data-a="agenticApprove" ${S.ui.agenticSubmitting ? 'disabled' : ''}>${ic('check', 14)}Approve</button>
        <button class="btn btn-secondary" data-a="agenticDeny" ${S.ui.agenticSubmitting ? 'disabled' : ''}>Deny</button>
      </div>
    </div>`;
}

function pageAgenticShell(title, inner) {
  return `<div class="set"><div class="set-body" style="max-width:640px;margin:0 auto"><div class="set-in"><h1>${title}</h1>${inner}</div></div></div>`;
}

/* ---------- Settings → Agentic body ---------- */
export function agenticSettingsBody(H) {
  if (!getCurrentUser())
    return H('Connect AI assistants to your workspace.') + `<div class="alert info">${ic('info', 15)}<span>Sign in to manage agentic connections.</span></div>`;
  const st = agenticState();
  if (!st.loaded && !st.error && !S.ui.agenticLoading) loadAgenticGrants();
  const url = mcpUrl();
  const rows = (st.grants || [])
    .map(g => grantSummary(g))
    .filter(Boolean)
    .map(
      s => `
    <div class="srow">
      <div><div class="t">${esc(s.name)}</div><div class="d">${esc(s.labels.join(' · '))}${s.agoText ? ` · granted ${esc(s.agoText)}` : ''}</div></div>
      <div class="row"><button class="btn btn-danger-ghost btn-sm" data-a="agenticRevoke" data-id="${esc(s.id)}">Revoke</button></div>
    </div>`,
    )
    .join('');
  const clients = st.error
    ? `<div class="alert danger">${ic('triangle-alert', 15)}<span>Couldn't load your authorized clients.</span></div><div style="margin-top:10px"><button class="btn btn-secondary btn-sm" data-a="agenticRetry">Retry</button></div>`
    : st.loaded && rows
      ? `<div class="panel" style="padding:4px">${rows}</div>`
      : st.loaded
        ? `<p class="hint">No authorized clients yet.</p>`
        : `<p class="hint">Checking connections…</p>`;
  return (
    H('Connect AI assistants (Claude, and anything that speaks MCP) to your workspace.') +
    `
    <div class="sblock" style="margin-top:0">
      <h2>MCP server</h2>
      ${srow('Server URL', 'The MCP endpoint AI assistants connect to.', `<div class="row" style="gap:6px"><code class="input" style="width:auto;max-width:340px;overflow:hidden;text-overflow:ellipsis;background:var(--surface-2)">${esc(url)}</code><button class="btn btn-secondary btn-sm" data-a="agenticCopyUrl" data-text="${esc(url)}">${ic('copy', 13)}Copy</button></div>`)}
      ${srow('Connect with Claude', 'Run this once on your machine, then approve the connection in Atrium.', `<div class="row" style="gap:6px"><code class="input" style="width:auto;max-width:340px;overflow:hidden;text-overflow:ellipsis;background:var(--surface-2)">${esc(claudeConnectLine(url))}</code><button class="btn btn-secondary btn-sm" data-a="agenticCopyCommand" data-text="${esc(claudeConnectLine(url))}">${ic('copy', 13)}Copy</button></div>`)}
      <p class="hint" style="margin-top:10px">The assistant requests the permissions it needs; you approve them here with a single consent screen and can revoke at any time. Tokens are stored server-side as hashes and never shown in the browser.</p>
    </div>
    <div class="sblock" style="margin-top:12px">
      <h2>Authorized clients</h2>
      ${clients}
    </div>`
  );
}
