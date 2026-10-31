/* ---------- CRM LINKAGE actions (links[] rows + bridges) ---------- */
/* Every link mutation goes through mutate() (apply + save + render) on the
   doc-side links[] array. The links[] row is the source of truth;
   task.gmail / task.event are denormalized convenience refs. Auto-link is
   SUGGEST + one-click confirm — nothing is stored silently. */
import { A } from './actions.js';
import { uid } from '../core/utils.js';
import { D, S, client, crmClients, crmLinks, task } from '../core/store.js';
import {
  eventFromTask,
  findLink,
  linkedClientIdForTask,
  mailFromTask,
  mailSuggestion,
  makeLinkRow,
  removeLink,
  taskFromMail,
  upsertLink,
} from '../core/links.js';
import { toast, mutate } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { closePop } from '../overlays/popovers.js';
import { ensureCalendarList, ensureFreebusy, ensureGmailMessage, googleStatus } from '../core/google.js';
import { gEvForm } from './google.js';

/* The mapped message object for an id, wherever it is cached (inbox list,
   search results, or the deep-read cache — the deep msg carries the same
   from/subject/date fields the preview and link rows need). */
function findMsg(id) {
  if (!id) return null;
  return (
    (S.ui.gmsgs || []).find(m => m && m.id === id) ||
    ((S.ui.gSearch && S.ui.gSearch.msgs) || []).find(m => m && m.id === id) ||
    (S.ui.gmsg && S.ui.gmsg[id] && S.ui.gmsg[id].state === 'ok' ? S.ui.gmsg[id].msg : null) ||
    null
  );
}

/* Epoch-ms `when` for an event row (timed start, else the all-day date). */
function eventStartMs(ev) {
  if (!ev || !ev.start) return Date.now();
  if (ev.start.dateTime) return Date.parse(ev.start.dateTime) || Date.now();
  return ev.start.date ? Date.parse(`${ev.start.date}T00:00:00`) || Date.now() : Date.now();
}

function addLinkRow(row) {
  mutate(() => {
    D().links = upsertLink(D().links, row);
  });
}

function dropLinkRow(kind, ref) {
  const row = findLink(crmLinks(), kind, ref);
  const cname = row ? client(row.clientId)?.name || 'client' : 'client';
  mutate(() => {
    D().links = removeLink(D().links, kind, ref);
  });
  toast(`Unlinked from ${cname}`);
}

/* ---------- AC2: one-click confirm of an auto-suggested mail link ---------- */
A.gLinkConfirm = el => {
  const msg = findMsg(el.dataset.id);
  if (!msg) return;
  const sug = mailSuggestion(crmLinks(), crmClients(), msg);
  if (!sug) return; // already linked or no exact match — never act on a stale badge
  addLinkRow(
    makeLinkRow({
      id: uid('lk'),
      clientId: sug.clientId,
      kind: 'mail',
      ref: msg.id,
      title: msg.subject,
      when: msg.date || Date.now(),
      snippet: msg.snippet || '',
    }),
  );
  toast(`Linked to ${sug.client?.name || 'client'} — matches ${sug.matchedEmail} on client email`);
};

/* ---------- AC2: manual link via the searchable client picker ---------- */
/* The picker popover (pop type 'linkclient') carries kind+ref on S.ui.pop;
   picking a client writes the row from the LIVE object (message / event)
   so title/when/snippet are the real values. */
A.linkPick = el => {
  const p = S.ui.pop;
  if (!p || p.type !== 'linkclient') return;
  const clientId = el.dataset.v;
  if (!clientId || !client(clientId)) return;
  if (p.kind === 'mail') {
    const msg = findMsg(p.id);
    if (!msg) {
      toast('The message is still loading — try again in a moment.', { kind: 'err' });
      return;
    }
    addLinkRow(
      makeLinkRow({ id: uid('lk'), clientId, kind: 'mail', ref: msg.id, title: msg.subject, when: msg.date || Date.now(), snippet: msg.snippet || '' }),
    );
    toast(`Linked to ${client(clientId).name}`);
  } else if (p.kind === 'event') {
    const ev = (S.ui.gevs || []).find(x => x && x.id === p.id);
    if (!ev) {
      toast('The event is no longer loaded — reopen it from the calendar.', { kind: 'err' });
      return;
    }
    addLinkRow(
      makeLinkRow({
        id: uid('lk'),
        clientId,
        kind: 'event',
        ref: ev.id,
        title: ev.summary || '(untitled event)',
        when: eventStartMs(ev),
        snippet: ev.location || '',
      }),
    );
    toast(`Linked to ${client(clientId).name}`);
  }
  closePop();
};

/* Unlink (message view, event popover, client detail sections). */
A.linkRemove = el => {
  const kind = el.dataset.kind;
  const ref = el.dataset.id;
  if (!kind || !ref) return;
  S.ui.pop = null;
  dropLinkRow(kind, ref);
};

/* ---------- AC4: mail → task ---------- */
A.gAddTask = el => {
  const msg = findMsg(el.dataset.id);
  if (!msg) {
    toast('The message is still loading — try again in a moment.', { kind: 'err' });
    return;
  }
  const link = findLink(crmLinks(), 'mail', msg.id);
  const sug = link ? null : mailSuggestion(crmLinks(), crmClients(), msg);
  const pre = taskFromMail(msg, link?.clientId || sug?.clientId || null);
  A.newTask({ dataset: {} }); // initializes + opens the standard task form
  Object.assign(S.ui.form, { title: pre.title, desc: pre.notes, gmail: pre.gmail, linkClient: pre.linkClientId });
  render();
};

/* ---------- AC5: task → mail (compose prefill) ---------- */
A.gTaskEmail = el => {
  const t = task(el.dataset.id || S.ui.drawer);
  if (!t) return;
  if (!googleStatus().connected) {
    toast('Connect Google to email from Atrium (Settings → Google).', { kind: 'err' });
    return;
  }
  const cid = linkedClientIdForTask(crmLinks(), t.id);
  const email = cid ? client(cid)?.email || '' : '';
  const url = `https://atrium.app/${D().ws.url}/task/${t.key}`;
  const pre = mailFromTask(t, email, url);
  S.ui.gform = { to: pre.to, cc: '', subject: pre.subject, body: pre.body, threadId: '', inReplyTo: '', references: '', sending: false, error: null };
  S.ui.compose = { draftId: null };
  closePop();
  openModal({ type: 'compose' });
};

/* ---------- AC5: task → meeting (event modal prefill) ---------- */
A.gTaskSchedule = el => {
  const t = task(el.dataset.id || S.ui.drawer);
  if (!t) return;
  if (!googleStatus().connected) {
    toast('Connect Google to schedule from Atrium (Settings → Google).', { kind: 'err' });
    return;
  }
  ensureCalendarList(); // picker source (no-op once cached)
  const cid = linkedClientIdForTask(crmLinks(), t.id);
  const pre = eventFromTask(t, cid);
  S.ui.gEvForm = Object.assign(gEvForm('create', null, pre.date), {
    title: pre.title,
    date: pre.date,
    allDay: pre.allDay,
    description: pre.description,
    attendees: pre.attendees,
    taskLink: { taskId: t.id, taskTitle: t.title },
  });
  S.ui.errors = {};
  if (pre.date) ensureFreebusy(pre.date);
  openModal({ type: 'geventForm' });
};

/* ---------- AC3/AC6: click-through to the linked message ---------- */
/* Opens the Inbox on the Gmail category with the message selected; the
   deep read fetches by id even when the row is not in the current list. */
A.gOpenMail = el => {
  const id = el.dataset.id;
  if (!id) return;
  S.ui.inboxCat = 'gmail';
  S.ui.gview = 'mail';
  S.ui.inboxSel = null;
  S.ui.gsel = id;
  S.ui.gselSet = new Set();
  go('inbox');
  ensureGmailMessage(id);
};
