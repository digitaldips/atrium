/* ---------- PAPERCLIP AGENTS actions ---------- */
import { A } from './actions.js';
import { S } from '../core/store.js';
import { toast } from '../ui/toast.js';
import { render } from '../shell/render.js';
import { decideApproval, loadPcTab, retryPcTab } from '../core/paperclip.js';

/* Two-click explicit confirm: arm stores the pending decision, the second
   click executes it, Cancel disarms. */
const armed = () => S.ui.pcConfirm || null;
const disarm = () => {
  S.ui.pcConfirm = null;
};

A.pcArmApprove = el => {
  S.ui.pcConfirm = { id: el.dataset.id, decision: 'approve' };
  render();
};
A.pcArmDeny = el => {
  S.ui.pcConfirm = { id: el.dataset.id, decision: 'deny' };
  render();
};
A.pcConfirmReset = () => {
  disarm();
  render();
};

async function decide(el, decision) {
  const id = el.dataset.id;
  if (!id) return;
  const c = armed();
  if (!c || c.id !== id || c.decision !== decision) return; // only the confirm click executes
  disarm();
  try {
    await decideApproval(id, decision);
    toast(decision === 'approve' ? 'Approved — Paperclip executed the decision.' : 'Denied — Paperclip recorded the decision.', { kind: 'info' });
  } catch (err) {
    toast(err instanceof Error ? err.message : 'The decision failed.', { kind: 'err' });
    loadPcTab('approvals');
  }
}
A.pcApprove = el => decide(el, 'approve');
A.pcDeny = el => decide(el, 'deny');

/* The one re-arm for a settled tab (error/empty). */
A.pcRetry = el => {
  disarm();
  retryPcTab(el.dataset.tab || S.ui.params.tab || 'agents');
};
