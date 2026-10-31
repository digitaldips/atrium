/* ---------- GOOGLE INTEGRATION actions ---------- */
import { A } from './actions.js';
import { S } from '../core/store.js';
import { render } from '../shell/render.js';
import { toast } from '../ui/toast.js';
import { connectGoogle, disconnectGoogle, ensureGmail, ensureGoogleCalendar, loadGoogleStatus } from '../core/google.js';
import { currentCalWindow } from '../views/calendar.js';

const errToast = e => toast(e?.message || 'Something went wrong.', { kind: 'err' });

A.googleConnect = async () => {
  try {
    await connectGoogle(); // navigates to accounts.google.com
  } catch (e) {
    errToast(e);
  }
};

A.googleDisconnect = async () => {
  try {
    await disconnectGoogle();
    toast('Google disconnected. Gmail and Calendar are no longer shown.');
  } catch (e) {
    errToast(e);
  }
};

A.googleStatusRetry = async () => {
  await loadGoogleStatus();
};

/* inbox: pick / deselect a gmail message (preview pane) */
A.gsel = el => {
  const id = el.dataset.id || '';
  S.ui.gsel = id || null;
  render();
};

/* inbox: retry after a failed gmail fetch */
A.gRetry = () => {
  S.ui.gState = 'idle';
  ensureGmail();
};

/* calendar: retry after a failed events fetch (resets the terminal error
   state and recomputes the window) */
A.gCalRetry = () => {
  S.ui.gevState = 'idle';
  S.ui.gevKey = null;
  ensureGoogleCalendar(currentCalWindow());
};
