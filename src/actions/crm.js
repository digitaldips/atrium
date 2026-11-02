/* ---------- CRM actions: clients + deals (all via mutate/save) ---------- */
import { $, uid } from '../core/utils.js';
import { D, S, client, crmClients, deal } from '../core/store.js';
import { CRM_STAGE, eur, isValidTransition, sanitizeDealValue } from '../core/crm.js';
import { mutate, toast } from '../ui/toast.js';
import { fxSet, go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { A, IN, confirmDlg, restore, snapshot } from './actions.js';

/* CRM entries use task:null/project:null activity rows — actHtml renders
   those as plain "<who> <verb> <extra>" lines without task links. */
const crmAct = (verb, extra) => D().activity.unshift({ id: uid('a'), by: D().me, verb, task: null, project: null, at: Date.now(), extra: extra || '' });

/* ---------- clients ---------- */
A.newClient = () => {
  S.ui.crmForm = { name: '', email: '', phone: '', status: 'lead', notes: '', org: '', owner: D().me };
  S.ui.errors = {};
  S.ui.pop = null;
  openModal({ type: 'clientForm' });
};
A.editClient = el => {
  const c = client(el.dataset.id);
  if (!c) return;
  S.ui.pop = null;
  S.ui.crmForm = {
    name: c.name,
    org: c.org || '',
    owner: c.owner || '',
    email: c.email || '',
    phone: c.phone || '',
    status: c.status || 'lead',
    notes: c.notes || '',
  };
  S.ui.errors = {};
  openModal({ type: 'clientForm', edit: c.id });
};
A.openClient = el => openModal({ type: 'client', id: el.dataset.id });
/* Leave the client modal behind when jumping to the pipeline. */
A.openPipeline = () => {
  S.ui.modals = [];
  go('pipeline');
};

A.submitClient = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.crmForm;
  f.name = ($('#c-name')?.value || '').trim();
  f.email = ($('#c-email')?.value || '').trim();
  f.phone = ($('#c-phone')?.value || '').trim();
  f.status = $('#c-status')?.value || 'lead';
  f.notes = ($('#c-notes')?.value || '').trim();
  f.org = $('#c-org')?.value || '';
  f.owner = $('#c-owner')?.value || '';
  if (!f.name) {
    S.ui.errors.crmName = 'Give the client a name';
    render();
    $('#c-name')?.focus();
    return;
  }
  if (m.edit) {
    const c = client(m.edit);
    if (!c) return;
    if (
      mutate(() => {
        Object.assign(c, { name: f.name, email: f.email, phone: f.phone, status: f.status, notes: f.notes, org: f.org || null, owner: f.owner || null });
        crmAct('updated client', `“${c.name}”`);
      })
    ) {
      S.ui.modals.pop();
      render();
      toast('Client updated');
    }
    return;
  }
  let c;
  if (
    !mutate(() => {
      c = {
        id: uid('cl'),
        name: f.name,
        email: f.email,
        phone: f.phone,
        status: f.status,
        notes: f.notes,
        org: f.org || null,
        owner: f.owner || null,
        created: Date.now(),
      };
      D().clients.push(c);
      crmAct('added client', `“${c.name}”`);
    })
  )
    return;
  S.ui.modals.pop();
  render();
  toast(`Added ${c.name}`);
};

A.removeClient = el => {
  const c = client(el.dataset.id);
  if (!c) return;
  S.ui.pop = null;
  const n = D().deals.filter(d => d.client === c.id).length;
  confirmDlg({
    title: `Remove ${c.name}?`,
    body: `This removes the client${n ? ` and their <b>${n} deal${n === 1 ? '' : 's'}</b>` : ''} from the CRM. You can undo right after.`,
    ok: 'Remove client',
    danger: true,
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          D().deals = D().deals.filter(d => d.client !== c.id);
          D().clients = D().clients.filter(x => x !== c);
          /* CRM linkage: a removed client takes its links[] rows with it —
             no dangling clientIds. */
          D().links = (D().links || []).filter(l => l.clientId !== c.id);
          crmAct('removed client', `“${c.name}”`);
        })
      ) {
        S.ui.modals = S.ui.modals.filter(m => !((m.type === 'client' && m.id === c.id) || m.type === 'clientForm' || m.type === 'confirm'));
        render();
        toast(`Removed ${c.name}`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};

/* ---------- deals ---------- */
A.newDeal = el => {
  const stage = el.dataset.stage;
  S.ui.crmForm = {
    title: '',
    client: el.dataset.client || crmClients()[0]?.id || '',
    value: '',
    stage: stage || 'lead',
    close: '',
    notes: '',
    org: '',
    owner: D().me,
  };
  S.ui.errors = {};
  S.ui.pop = null;
  openModal({ type: 'dealForm' });
};
A.editDeal = el => {
  const d = deal(el.dataset.id);
  if (!d) return;
  S.ui.pop = null;
  S.ui.crmForm = {
    title: d.title,
    client: d.client,
    value: d.value == null ? '' : String(d.value),
    stage: d.stage || 'lead',
    close: d.close || '',
    notes: d.notes || '',
    org: d.org || '',
    owner: d.owner || '',
  };
  S.ui.errors = {};
  openModal({ type: 'dealForm', edit: d.id });
};

A.submitDeal = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.crmForm;
  f.title = ($('#d-title')?.value || '').trim();
  f.client = $('#d-client')?.value || '';
  f.value = $('#d-value')?.value || '';
  f.stage = $('#d-stage')?.value || 'lead';
  f.close = $('#d-close')?.value || '';
  f.notes = ($('#d-notes')?.value || '').trim();
  f.org = $('#d-org')?.value || '';
  f.owner = $('#d-owner')?.value || '';
  if (!f.title) {
    S.ui.errors.dealTitle = 'Give the deal a name';
    render();
    $('#d-title')?.focus();
    return;
  }
  if (!f.client) {
    S.ui.errors.dealTitle = 'Add a client first';
    render();
    return;
  }
  const value = sanitizeDealValue(f.value);
  const stage = CRM_STAGE[f.stage] ? f.stage : 'lead';
  const close = f.close || null;
  if (m.edit) {
    const d = deal(m.edit);
    if (!d) return;
    if (
      mutate(() => {
        Object.assign(d, { title: f.title, client: f.client, value, stage, close, notes: f.notes, org: f.org || null, owner: f.owner || null });
        crmAct('updated deal', `“${d.title}” (${eur(value)})`);
      })
    ) {
      S.ui.modals.pop();
      render();
      toast('Deal updated');
    }
    return;
  }
  let d;
  if (
    !mutate(() => {
      d = {
        id: uid('d'),
        title: f.title,
        client: f.client,
        value,
        stage,
        close,
        notes: f.notes,
        org: f.org || null,
        owner: f.owner || null,
        created: Date.now(),
      };
      D().deals.push(d);
      crmAct('added deal', `“${d.title}” (${eur(value)})`);
    })
  )
    return;
  S.ui.modals.pop();
  render();
  toast(`Added “${d.title}”`);
};

A.removeDeal = el => {
  const d = deal(el.dataset.id);
  if (!d) return;
  S.ui.pop = null;
  confirmDlg({
    title: `Remove “${d.title}”?`,
    body: 'This removes the deal from the pipeline. You can undo right after.',
    ok: 'Remove deal',
    danger: true,
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          D().deals = D().deals.filter(x => x !== d);
          crmAct('removed deal', `“${d.title}”`);
        })
      ) {
        S.ui.modals = S.ui.modals.filter(m => !(m.type === 'dealForm' || m.type === 'confirm'));
        render();
        toast(`Removed “${d.title}”`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};

/* Stage move (drag-drop calls this directly; also on the A table). */
export function moveDeal(id, stage) {
  const d = deal(id);
  if (!d) return;
  if (d.stage === stage) return;
  if (!isValidTransition(d.stage, stage)) {
    toast('That pipeline stage is unknown', { kind: 'err', ms: 2200 });
    return;
  }
  if (d.stage === stage) return;
  fxSet({ moved: d.id });
  mutate(() => {
    d.stage = stage;
    crmAct('moved deal', `“${d.title}” to ${CRM_STAGE[stage].name}`);
  });
  toast(`Moved “${d.title}” to ${CRM_STAGE[stage].name}`, { ms: 2200 });
}
A.moveDeal = (id, stage) => moveDeal(id, stage);

/* ---------- form + page inputs ---------- */
IN.crmForm = el => {
  const f = S.ui.crmForm;
  if (!f) return;
  f[el.dataset.f] = el.value;
  const key = el.dataset.f === 'name' ? 'crmName' : el.dataset.f === 'title' ? 'dealTitle' : null;
  if (key && S.ui.errors[key] && el.value.trim()) {
    S.ui.errors[key] = null;
    render();
  }
};
IN.crmQ = el => {
  S.ui.crmQ = el.value;
  render();
};
IN.crmStatus = el => {
  S.ui.crmStatus = el.value;
  render();
};
A.clearCrmFilters = () => {
  S.ui.crmQ = '';
  S.ui.crmStatus = 'all';
  S.ui.crmOrg = 'all';
  render();
};
