/* ---------- ORGANISATION actions (doc-side orgs[] + AC4 suggest confirm) ---------- */
/* Every org mutation goes through mutate() (apply + save + render) on the
   doc-side orgs[] array. Deleting an org only UNLINKS (org=null) — items
   are never deleted. The auto-suggest is SUGGEST + one-click confirm:
   nothing is stored silently (same contract as the mail auto-link). */
import { $, uid, esc } from '../core/utils.js';
import { D, S, client, crmClients, crmDeals, crmOrgs, org } from '../core/store.js';
import { makeNote } from '../core/notes.js';
import { makeOrg, normalizeDomain, orgCascadeUnlink, orgSuggestionFor } from '../core/orgs.js';
import { flushNoteDraft } from './notes.js';
import { mutate, toast } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { A, IN, confirmDlg, restore, snapshot } from './actions.js';

/* CRM entries use task:null/project:null activity rows (see actions/crm.js). */
const crmAct = (verb, extra) => D().activity.unshift({ id: uid('a'), by: D().me, verb, task: null, project: null, at: Date.now(), extra: extra || '' });

/* ---------- AC2: organisation CRUD ---------- */
A.newOrg = () => {
  S.ui.orgForm = { name: '', domain: '', industry: '', notes: '' };
  S.ui.errors = {};
  S.ui.pop = null;
  openModal({ type: 'orgForm' });
};

A.editOrg = el => {
  const o = org(el.dataset.id);
  if (!o) return;
  S.ui.pop = null;
  S.ui.orgForm = { name: o.name, domain: o.domain || '', industry: o.industry || '', notes: o.notes || '' };
  S.ui.errors = {};
  openModal({ type: 'orgForm', edit: o.id });
};

A.openOrg = el => {
  if (!org(el.dataset.id)) return;
  S.ui.modals = []; /* click-through from the client modal lands on the page */
  go('org', { id: el.dataset.id });
};

A.submitOrg = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.orgForm;
  f.name = ($('#o-name')?.value || '').trim();
  f.domain = ($('#o-domain')?.value || '').trim();
  f.industry = ($('#o-industry')?.value || '').trim();
  f.notes = ($('#o-notes')?.value || '').trim();
  if (!f.name) {
    S.ui.errors.orgName = 'Give the organisation a name';
    render();
    $('#o-name')?.focus();
    return;
  }
  /* The domain is stored normalized (lowercase, no protocol/www/path) —
     it is the exact-match auto-suggest key, and the normalized form is
     what the edit form shows back. */
  const domain = normalizeDomain(f.domain);
  if (m.edit) {
    const o = org(m.edit);
    if (!o) return;
    if (
      mutate(() => {
        Object.assign(o, { name: f.name, domain, industry: f.industry, notes: f.notes });
        crmAct('updated organisation', `“${o.name}”`);
      })
    ) {
      S.ui.modals.pop();
      render();
      toast('Organisation updated');
    }
    return;
  }
  let o;
  if (
    !mutate(() => {
      o = makeOrg({ id: uid('org'), name: f.name, domain, industry: f.industry, notes: f.notes, created: Date.now() });
      D().orgs.push(o);
      crmAct('added organisation', `“${o.name}”`);
    })
  )
    return;
  S.ui.modals.pop();
  render();
  toast(`Added ${o.name}`);
};

A.removeOrg = el => {
  const o = org(el.dataset.id);
  if (!o) return;
  S.ui.pop = null;
  const nC = crmClients().filter(c => c && c.org === o.id).length;
  const nD = crmDeals().filter(d => d && d.org === o.id).length;
  const nN = (D().notes || []).filter(n => n && n.org === o.id).length;
  const parts = [
    nC ? `<b>${nC} contact${nC === 1 ? '' : 's'}</b>` : '',
    nD ? `<b>${nD} deal${nD === 1 ? '' : 's'}</b>` : '',
    nN ? `<b>${nN} note${nN === 1 ? '' : 's'}</b>` : '',
  ].filter(Boolean);
  const tail = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : '';
  confirmDlg({
    title: `Remove ${esc(o.name)}?`,
    body: `The organisation is removed. <b>Nothing else is deleted</b>${tail ? ` — its ${tail} stay` : ''} in Atrium and simply lose the organisation reference. You can undo right after.`,
    ok: 'Remove organisation',
    danger: true,
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          orgCascadeUnlink(D(), o.id); /* items survive with org=null */
          D().orgs = (D().orgs || []).filter(x => x !== o);
          crmAct('removed organisation', `“${o.name}”`);
        })
      ) {
        S.ui.modals = S.ui.modals.filter(m => !(m.type === 'orgForm' || m.type === 'confirm'));
        if (S.ui.crmOrg === o.id) S.ui.crmOrg = ''; /* dead filter id → back to All organisations */
        if (S.ui.route === 'org' && S.ui.params.id === o.id) go('orgs');
        render();
        toast(`Removed ${o.name} — contacts, deals and notes are kept`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};

/* ---------- AC4: suggest + one-click confirm (never silent) ---------- */
/* Confirm: re-derive the suggestion from live state — a stale badge (the
   client got an org meanwhile) must never act silently. */
A.orgAttach = el => {
  const c = client(el.dataset.id);
  if (!c || c.org) return;
  const sug = orgSuggestionFor(c, crmOrgs());
  if (!sug) return;
  mutate(() => {
    c.org = sug.org.id;
  });
  toast(`Attached ${c.name} to ${sug.org.name} — matched ${sug.matchedDomain}`);
};

A.orgAttachDismiss = el => {
  S.ui.orgSugDismissed = S.ui.orgSugDismissed || {};
  S.ui.orgSugDismissed[el.dataset.id] = true;
  render();
};

/* ---------- AC3: prefilled forms opened from an organisation ---------- */
A.orgNewClient = el => {
  const o = org(el.dataset.id);
  S.ui.pop = null;
  S.ui.crmForm = { name: '', email: '', phone: '', status: 'lead', notes: '', org: o?.id || '', owner: D().me };
  S.ui.errors = {};
  openModal({ type: 'clientForm' });
};

A.orgNewDeal = el => {
  const o = org(el.dataset.id);
  S.ui.pop = null;
  S.ui.crmForm = { title: '', client: crmClients()[0]?.id || '', value: '', stage: 'lead', close: '', notes: '', org: o?.id || '' };
  S.ui.errors = {};
  openModal({ type: 'dealForm' });
};

/* A note created from the organisation page carries the org ref and opens
   in the Notes editor (same create path as noteNew, plus the org). */
A.orgNoteNew = el => {
  const o = org(el.dataset.id);
  flushNoteDraft();
  const now = Date.now();
  const n = makeNote({ id: uid('n'), title: '', html: '', created: now, updated: now, pinned: false, attachments: [] });
  n.org = o?.id || null;
  mutate(() => {
    D().notes.push(n);
    if (S.ui.notesQ) S.ui.notesQ = '';
    S.ui.noteSel = n.id;
  });
  go('notes');
  setTimeout(() => $('#note-title')?.focus(), 0);
};

/* ---------- page + form inputs ---------- */
IN.orgQ = el => {
  S.ui.orgQ = el.value;
  render();
};
A.orgQClear = () => {
  S.ui.orgQ = '';
  render();
};
IN.orgForm = el => {
  const f = S.ui.orgForm;
  if (!f) return;
  f[el.dataset.f] = el.value;
  if (el.dataset.f === 'name' && S.ui.errors.orgName && el.value.trim()) {
    S.ui.errors.orgName = null;
    render();
  }
};
IN.crmOrg = el => {
  S.ui.crmOrg = el.value;
  render();
};
