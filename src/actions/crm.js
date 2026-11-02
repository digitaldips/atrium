/* ---------- CRM actions: clients + deals (all via mutate/save) ---------- */
import { $, uid } from '../core/utils.js';
import { D, S, client, crmClients, deal } from '../core/store.js';
import { CRM_STAGE, DEFAULT_STAGE, eur, isValidTransition, sanitizeDealValue } from '../core/crm.js';
import { mutate, toast } from '../ui/toast.js';
import { fxSet, go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { A, IN, confirmDlg, restore, snapshot } from './actions.js';

/* CRM entries use task:null/project:null activity rows — actHtml renders
   those as plain "<who> <verb> <extra>" lines without task links. */
const crmAct = (verb, extra) => D().activity.unshift({ id: uid('a'), by: D().me, verb, task: null, project: null, at: Date.now(), extra: extra || '' });

/* ---------- clients ---------- */
A.newClient = () => {
  S.ui.crmForm = { name: '', email: '', phone: '', status: 'lead', notes: '', orgs: [], owner: D().me };
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
    orgs: Array.isArray(c.orgs) ? [...c.orgs] : [],
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
  f.orgs = [...new Set([...document.querySelectorAll('.modal .orgcheck:checked')].map(x => x.value))];
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
        Object.assign(c, { name: f.name, email: f.email, phone: f.phone, status: f.status, notes: f.notes, orgs: f.orgs, owner: f.owner || null });
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
        orgs: f.orgs,
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
    type: 'project',
    value: '',
    monthly: '',
    months: '',
    stage: stage || DEFAULT_STAGE,
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
    type: d.type === 'retainer' ? 'retainer' : 'project',
    value: d.value == null ? '' : String(d.value),
    monthly: d.monthly == null ? '' : String(d.monthly),
    months: d.months == null ? '' : String(d.months),
    stage: d.stage || DEFAULT_STAGE,
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
  f.type = $('#d-type')?.value === 'retainer' ? 'retainer' : 'project';
  f.value = $('#d-value')?.value || '';
  f.monthly = $('#d-monthly')?.value || '';
  f.months = $('#d-months')?.value || '';
  f.stage = $('#d-stage')?.value || DEFAULT_STAGE;
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
  /* Deal-type math: deal.value ALWAYS stores the EXPECTED value —
     project: the projectwaarde; retainer: monthly × months. Projects
     carry monthly/months = null, retainers store both. */
  let value = 0;
  let monthly = null;
  let months = null;
  if (f.type === 'retainer') {
    monthly = sanitizeDealValue(f.monthly);
    const n = Math.floor(Number(f.months));
    months = Number.isFinite(n) && n >= 1 ? n : 0;
    value = monthly > 0 && months >= 1 ? Math.round(monthly * months) : 0;
    if (monthly <= 0) S.ui.errors.dealMonthly = 'Give the monthly amount above €0';
    if (months < 1) S.ui.errors.dealMonths = 'Set a duration of at least 1 month';
  } else {
    value = sanitizeDealValue(f.value);
    if (value <= 0) S.ui.errors.dealValue = 'Give the project a value above €0';
  }
  if (S.ui.errors.dealMonthly || S.ui.errors.dealMonths || S.ui.errors.dealValue) {
    render();
    ($('#d-monthly') || $('#d-months') || $('#d-value'))?.focus();
    return;
  }
  const stage = CRM_STAGE[f.stage] ? f.stage : DEFAULT_STAGE;
  const close = f.close || null;
  const actExtra = f.type === 'retainer' ? `“${f.title}” (retainer ${eur(monthly)}/mnd × ${months})` : `“${f.title}” (${eur(value)})`;
  if (m.edit) {
    const d = deal(m.edit);
    if (!d) return;
    const prevStage = d.stage;
    if (
      mutate(() => {
        Object.assign(d, {
          title: f.title,
          client: f.client,
          value,
          type: f.type,
          monthly,
          months,
          stage,
          close,
          notes: f.notes,
          org: f.org || null,
          owner: f.owner || null,
        });
        /* Gewonnen = afgerond/opgeleverd: stamp entry time. Re-entering
           won (won → something → won) refreshes the stamp. */
        if (stage === 'won' && prevStage !== 'won') d.wonAt = Date.now();
        crmAct('updated deal', actExtra);
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
        type: f.type,
        monthly,
        months,
        stage,
        close,
        notes: f.notes,
        org: f.org || null,
        owner: f.owner || null,
        created: Date.now(),
      };
      if (stage === 'won') d.wonAt = Date.now(); /* logged directly as Gewonnen = afgerond */
      D().deals.push(d);
      crmAct('added deal', actExtra);
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
    /* Gewonnen = afgerond/opgeleverd: stamp entry time. isValidTransition
       guarantees this is a fresh entry (same-stage moves return early), so
       re-entering won after a reopen refreshes the stamp. */
    if (stage === 'won') d.wonAt = Date.now();
    crmAct('moved deal', `“${d.title}” to ${CRM_STAGE[stage].name}`);
  });
  toast(`Moved “${d.title}” to ${CRM_STAGE[stage].name}`, { ms: 2200 });
}
A.moveDeal = (id, stage) => moveDeal(id, stage);

/* ---------- form + page inputs ---------- */
/* Deal-form fields that feed the live expected/weighted line (and the
   type/stage-dependent blocks): re-render so the math follows every
   keystroke or select change — focus + caret survive the render loop. */
const DEAL_LIVE_FIELDS = ['type', 'stage', 'value', 'monthly', 'months'];
const DEAL_ERR_KEY = { value: 'dealValue', monthly: 'dealMonthly', months: 'dealMonths' };
IN.crmForm = el => {
  const f = S.ui.crmForm;
  if (!f) return;
  f[el.dataset.f] = el.value;
  const key = el.dataset.f === 'name' ? 'crmName' : el.dataset.f === 'title' ? 'dealTitle' : null;
  if (key && S.ui.errors[key] && el.value.trim()) {
    S.ui.errors[key] = null;
    render();
    return;
  }
  const errKey = DEAL_ERR_KEY[el.dataset.f];
  if (errKey && S.ui.errors[errKey] && Number(el.value) > 0) S.ui.errors[errKey] = null;
  if (DEAL_LIVE_FIELDS.includes(el.dataset.f)) render();
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
