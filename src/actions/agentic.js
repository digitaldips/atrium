/* ---------- AGENTIC (MCP) actions ---------- */
import { A, copy } from './actions.js';
import { S } from '../core/store.js';
import { toast } from '../ui/toast.js';
import { mcpUrl, claudeConnectLine, revokeAgenticGrant, submitAgenticConsent, loadAgenticGrants } from '../core/agentic.js';

A.agenticCopyUrl = el => copy(el.dataset.text || mcpUrl(), 'MCP server URL copied');
A.agenticCopyCommand = el => copy(el.dataset.text || claudeConnectLine(mcpUrl()), 'Command copied');
A.agenticRetry = () => {
  /* the errored state is terminal by design — Retry is the one re-arm */
  S.ui.agentic = { loaded: false, grants: [] };
  loadAgenticGrants();
};
A.agenticRevoke = async el => {
  const id = el.dataset.id;
  if (!id) return;
  try {
    await revokeAgenticGrant(id);
    toast('Access revoked — the client is disconnected.', { kind: 'info' });
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Revoke failed.', { kind: 'err' });
  }
};
A.agenticApprove = () => submitAgenticConsent(true);
A.agenticDeny = () => submitAgenticConsent(false);
