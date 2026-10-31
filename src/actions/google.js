/* ---------- GOOGLE INTEGRATION actions ---------- */
import { A, IN, KEY, confirmDlg } from './actions.js';
import { $, esc, iso, addD, parse, uid } from '../core/utils.js';
import { D, S, task } from '../core/store.js';
import { linkedClientIdForTask, makeLinkRow, upsertLink } from '../core/links.js';
import { render } from '../shell/render.js';
import { toast, mutate } from '../ui/toast.js';
import { openModal, closeModal } from '../overlays/modals.js';
import { eventDateKey, bulkSelectionWarning, draftSendPlan } from '../../supabase/functions/_shared/google-pure.js';
import {
  connectGoogle,
  googleStatus,
  gAttachmentFetch,
  refetchGmailList,
  disconnectGoogle,
  ensureGmail,
  ensureGmailMessage,
  ensureGmailThread,
  ensureGoogleCalendar,
  loadGoogleStatus,
  modifyGmail,
  moreGmailSearch,
  runGmailSearch,
  clearGmailSearch,
  sendGmail,
  trashGmail,
  createGEvent,
  updateGEvent,
  deleteGEvent,
  refetchCalendarWindow,
} from '../core/google.js';
import { currentCalWindow } from '../views/calendar.js';
import {
  batchGmailDelete,
  batchGmailModify,
  batchGmailTrash,
  createGLabel,
  deleteGLabel,
  deleteGmailDraft,
  ensureCalendarList,
  ensureFreebusy,
  ensureGmailDrafts,
  fetchGmailDraft,
  resetGmailDrafts,
  saveGmailDraft,
  sendGmailDraft,
  toggleCalendarEnabled,
} from '../core/google.js';

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

/* inbox: pick / deselect a gmail message (preview pane). Selecting either
   kind of row owns the preview: a gmail pick clears a notif selection so
   the merged 'all' view can never show a stale notif preview. Selecting
   arms the deep read (format=full body, attachments, thread context). */
A.gsel = el => {
  const id = el.dataset.id || '';
  S.ui.gsel = id || null;
  S.ui.inboxSel = null;
  render();
  if (id) ensureGmailMessage(id);
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

/* ---------- Gmail search (gmail category only) ---------- */

/* ---------- Gmail search (gmail category only) ---------- */
IN.gSearchQ = el => {
  S.ui.gSearchQ = el.value;
  render();
};
A.gSearchRun = el => {
  const q = el?.dataset?.q != null ? el.dataset.q : ($('#g-search-in')?.value ?? S.ui.gSearchQ ?? '');
  if (S.ui.gSearchQ && q === S.ui.gSearchQ && S.ui.gSearch?.state === 'ok') return; // same query, settled
  runGmailSearch(q);
};
KEY.gSearchRun = el => A.gSearchRun(el);
A.gSearchBack = () => {
  clearGmailSearch();
};
A.gSearchMore = () => {
  moreGmailSearch();
};

/* ---------- Gmail message view ---------- */
A.gmsgToggle = el => {
  const open = (S.ui.gOpen = S.ui.gOpen || new Set());
  const id = el.dataset.id;
  open.has(id) ? open.delete(id) : open.add(id);
  render();
};
A.gMsgRetry = el => {
  const id = el.dataset.id;
  if (S.ui.gmsg && S.ui.gmsg[id]) S.ui.gmsg[id] = { state: 'idle', msg: null };
  ensureGmailMessage(id);
};
A.gThreadRetry = el => {
  const tid = el.dataset.tid;
  if (S.ui.gthread && S.ui.gthread[tid]) S.ui.gthread[tid] = { state: 'idle', messages: [] };
  ensureGmailThread(tid);
};

/* Attachment download: base64 → Blob client-side (no raw HTML serving),
   10MB cap mirrored from the endpoint with an honest error. */
A.gAttach = async el => {
  const { msgId, attachmentId, filename, size } = el.dataset;
  if (Number(size) > 10 * 1024 * 1024) {
    toast(`"${filename}" is larger than the 10 MB download limit.`, { kind: 'err' });
    return;
  }
  try {
    el.classList.add('is-loading');
    const body = await gAttachmentFetch(msgId, attachmentId);
    const bin = atob(body.data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: el.dataset.mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    errToast(e);
  } finally {
    el.classList.remove('is-loading');
  }
};

/* ---------- Gmail compose / reply ---------- */
IN.gForm = el => {
  S.ui.gform[el.dataset.f] = el.value;
  /* Values live in the DOM and are re-read on submit — no render per
     keystroke; only a cleared error needs the form repainted. */
  if (S.ui.gform.error) {
    S.ui.gform.error = null;
    render();
  }
};
A.gCompose = () => {
  S.ui.gform = { to: '', cc: '', subject: '', body: '', threadId: '', inReplyTo: '', references: '', sending: false, error: null };
  S.ui.compose = { draftId: null };
  openModal({ type: 'compose' });
};
A.gReply = el => {
  const deep = S.ui.gmsg && S.ui.gmsg[S.ui.gsel || el.dataset.id];
  const msg = deep && deep.msg;
  if (!msg) {
    errToast(new Error('The message is still loading — try again in a moment.'));
    return;
  }
  const subject = msg.subject && msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject}`;
  S.ui.gform = {
    to: msg.replyTo || msg.email || '',
    cc: '',
    subject,
    body: '',
    threadId: msg.threadId || msg.id,
    inReplyTo: msg.messageId || '',
    references: [msg.references, msg.messageId].filter(Boolean).join(' '),
    sending: false,
    error: null,
  };
  S.ui.compose = { draftId: null };
  openModal({ type: 'compose', reply: true });
};
A.gSend = async () => {
  const f = S.ui.gform;
  if (f.sending) return;
  f.to = ($('#g-to')?.value ?? f.to).trim();
  f.cc = ($('#g-cc')?.value ?? f.cc).trim();
  f.subject = $('#g-subject')?.value ?? f.subject;
  f.body = $('#g-body')?.value ?? f.body;
  const bad = f.to
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  if (!f.to.trim()) f.error = 'Add at least one recipient.';
  else if (bad.length) f.error = `"${bad[0]}" is not a valid email address.`;
  else if (!f.body.trim()) f.error = 'Write a message before sending.';
  if (f.error) {
    render();
    return;
  }
  f.sending = true;
  f.error = null;
  render();
  try {
    /* Draft-aware send (F2): a compose opened from the drafts list sends
       the DRAFT itself — but the stored draft went stale the moment the
       form was edited, so the plan is update-then-send: PATCH the draft
       with the CURRENT edited form first (the same save path), THEN send
       the draft (Gmail semantics: sending a draft removes it). A failed
       update surfaces in this catch — the stale draft never goes out
       under a 'Message sent' toast. A fresh compose/reply keeps the
       direct messages/send path. */
    const plan = draftSendPlan(S.ui.compose?.draftId || '');
    if (plan.updateThenSend) {
      await saveGmailDraft({ to: f.to, cc: f.cc, subject: f.subject, body: f.body, threadId: f.threadId });
      await sendGmailDraft(S.ui.compose?.draftId || plan.draftId);
    } else {
      await sendGmail({ to: f.to, cc: f.cc, subject: f.subject, body: f.body, threadId: f.threadId, inReplyTo: f.inReplyTo, references: f.references });
    }
    closeModal();
    toast('Message sent');
    refetchGmailList();
    ensureGmail();
    if (S.ui.gview === 'drafts') ensureGmailDrafts();
  } catch (e) {
    f.sending = false;
    f.error = e?.message || 'Sending failed.';
    render();
  }
};
A.gSaveDraft = async () => {
  const f = S.ui.gform;
  if (f.saving) return;
  f.to = ($('#g-to')?.value ?? f.to).trim();
  f.cc = ($('#g-cc')?.value ?? f.cc).trim();
  f.subject = $('#g-subject')?.value ?? f.subject;
  f.body = $('#g-body')?.value ?? f.body;
  /* A draft may be empty of recipients — but not empty of everything. */
  if (!f.to && !f.cc && !f.subject && !f.body) {
    f.error = 'Nothing to save yet — write something first.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const id = await saveGmailDraft({ to: f.to, cc: f.cc, subject: f.subject, body: f.body, threadId: f.threadId });
    f.saving = false;
    closeModal();
    toast('Draft saved', { action: 'View drafts', onAction: () => A.gDraftsChip() });
    if (S.ui.gview === 'drafts') ensureGmailDrafts();
    return id;
  } catch (e) {
    f.saving = false;
    f.error = e?.message || 'Saving the draft failed.';
    render();
  }
};

/* ---------- Gmail per-message actions ---------- */
A.gMarkUnread = async el => {
  const id = el.dataset.id || S.ui.gsel;
  try {
    await modifyGmail(id, { unread: true });
    toast('Marked as unread');
  } catch (e) {
    errToast(e);
  }
};
A.gArchive = async el => {
  const id = el.dataset.id || S.ui.gsel;
  try {
    await modifyGmail(id, { archive: true });
    S.ui.gsel = null;
    refetchGmailList();
    ensureGmail();
    toast('Archived', { action: 'Open Gmail', onAction: () => window.open('https://mail.google.com', '_blank', 'noopener') });
  } catch (e) {
    errToast(e);
  }
};
A.gTrash = el => {
  const id = el.dataset.id || S.ui.gsel;
  const row = (S.ui.gSearch?.msgs || []).concat(S.ui.gmsgs || []).find(m => m.id === id);
  const run = async () => {
    try {
      await trashGmail(id);
      S.ui.gsel = null;
      refetchGmailList();
      ensureGmail();
      toast(`Moved "${row?.subject || 'message'}" to Trash`, {
        action: 'Undo',
        onAction: async () => {
          try {
            await trashGmail(id, true);
            refetchGmailList();
            ensureGmail();
          } catch (e) {
            errToast(e);
          }
        },
      });
    } catch (e) {
      errToast(e);
    }
  };
  confirmDlg({
    title: 'Move to Trash?',
    body: `<b>${esc(row?.subject || 'This message')}</b> will move to your Gmail Trash. You can restore it there for 30 days.`,
    ok: 'Move to Trash',
    danger: true,
    icon: 'trash-2',
    run,
  });
};

/* ---------- Gmail star toggle (rows + message view) ---------- */
A.gStar = async el => {
  const id = el.dataset.id || S.ui.gsel;
  const m = (S.ui.gmsgs || []).find(x => x.id === id) || ((S.ui.gSearch && S.ui.gSearch.msgs) || []).find(x => x.id === id);
  try {
    await modifyGmail(id, m && m.starred ? { removeLabelIds: ['STARRED'] } : { addLabelIds: ['STARRED'] });
  } catch (e) {
    errToast(e);
  }
};

/* ---------- Gmail chips: view + label filters ---------- */

/* Selecting a chip re-arms the list fetch (gState='idle' → the next
   render fetches with the new label param). The preview selection resets
   with the list so a stale message never stays open across filters. */
function armMailList() {
  S.ui.gState = 'idle';
  S.ui.gsel = null;
  S.ui.gSearchQ = '';
  S.ui.gSearch = { state: 'idle', msgs: [], nextPageToken: '', error: null };
  render();
}
A.gMailChip = () => {
  S.ui.gview = 'mail';
  S.ui.glabel = '';
  armMailList();
};
A.gLabelChip = el => {
  const id = el.dataset.id || '';
  if (!id) return;
  S.ui.gview = 'mail';
  S.ui.glabel = id;
  armMailList();
};
A.gDraftsChip = () => {
  S.ui.gview = 'drafts';
  S.ui.gsel = null;
  /* F4: the drafts view has no bulk rows — a selection carried over from
     the mail list would sit invisible above the drafts, so it clears with
     an honest toast. Also the manual Retry for a failed drafts fetch: the
     reset re-arms exactly one fetch (F1 settled-state guard). */
  if (S.ui.gselSet && S.ui.gselSet.size) {
    S.ui.gselSet = new Set();
    toast('Selection cleared — the drafts view has no bulk actions.');
  }
  resetGmailDrafts();
  render();
  ensureGmailDrafts();
};
A.gLabelNew = () => {
  openModal({
    type: 'prompt',
    title: 'New label',
    label: 'Label name',
    ok: 'Create label',
    run: async v => {
      if (!v) return;
      try {
        await createGLabel(v);
        toast(`Label "${v}" created`);
      } catch (e) {
        errToast(e);
      }
    },
  });
};
A.gLabelDelete = el => {
  const id = el.dataset.id;
  const name = el.dataset.tip?.match(/“(.*)”/)?.[1] || id;
  confirmDlg({
    title: `Delete label "${name}"?`,
    body: 'The label is removed from your Gmail. Messages keep every other label — the mail itself is never deleted.',
    ok: 'Delete label',
    danger: true,
    icon: 'tag',
    run: async () => {
      try {
        await deleteGLabel(id);
        if (S.ui.glabel === id) {
          S.ui.glabel = '';
          armMailList();
        }
        toast('Label deleted');
      } catch (e) {
        errToast(e);
      }
    },
  });
};

/* ---------- Gmail bulk ops (gselSet) ---------- */
A.gSelRow = el => {
  const id = el.dataset.id;
  const sel = (S.ui.gselSet = S.ui.gselSet || new Set());
  sel.has(id) ? sel.delete(id) : sel.add(id);
  render();
};
A.gBulkClear = () => {
  S.ui.gselSet = new Set();
  render();
};
A.gBulk = el => {
  const op = el.dataset.op;
  const ids = [...(S.ui.gselSet || new Set())];
  if (!ids.length) return;
  /* F4: the server clamps at 50 — over the clamp the action is refused
     honestly (the bar is disabled too); never a silent truncation. */
  const over = bulkSelectionWarning(ids.length);
  if (over) {
    toast(over, { kind: 'err' });
    return;
  }
  const finish = n => {
    S.ui.gselSet = new Set();
    refetchGmailList();
    ensureGmail();
    toast(`${n} message${n === 1 ? '' : 's'} updated`);
  };
  const runModify = async ops => {
    try {
      const n = await batchGmailModify(ids, ops);
      finish(n);
    } catch (e) {
      errToast(e);
    }
  };
  if (op === 'read') return runModify({ unread: false });
  if (op === 'unread') return runModify({ unread: true });
  if (op === 'archive') return runModify({ archive: true });
  if (op === 'trash')
    return confirmDlg({
      title: `Move ${ids.length} message${ids.length > 1 ? 's' : ''} to Trash?`,
      body: 'They move to your Gmail Trash and stay recoverable there for 30 days.',
      ok: `Trash ${ids.length}`,
      danger: true,
      icon: 'trash-2',
      run: async () => {
        try {
          const n = await batchGmailTrash(ids);
          finish(n);
        } catch (e) {
          errToast(e);
        }
      },
    });
  if (op === 'delete')
    return confirmDlg({
      title: `Delete ${ids.length} message${ids.length > 1 ? 's' : ''} forever?`,
      body: '<b>This is permanent.</b> Gmail has no undo for deleting forever — the messages are gone from every folder, not just the inbox.',
      ok: `Delete ${ids.length} forever`,
      typeName: 'DELETE',
      danger: true,
      icon: 'trash-2',
      run: async () => {
        try {
          const n = await batchGmailDelete(ids);
          S.ui.gselSet = new Set();
          refetchGmailList();
          ensureGmail();
          toast(`${n} message${n === 1 ? '' : 's'} deleted forever`);
        } catch (e) {
          errToast(e);
        }
      },
    });
};

/* ---------- Gmail drafts ---------- */
A.gDraftOpen = async el => {
  const id = el.dataset.id;
  if (!id) return;
  S.ui.gsel = null;
  render();
  try {
    const draft = await fetchGmailDraft(id);
    if (!draft) throw new Error('The draft could not be loaded.');
    S.ui.gform = {
      to: draft.to || '',
      cc: draft.cc || '',
      subject: draft.subject === '(no subject)' ? '' : draft.subject || '',
      body: draft.body?.body || '',
      threadId: draft.threadId || '',
      inReplyTo: '',
      references: '',
      sending: false,
      error: null,
    };
    S.ui.compose = { draftId: draft.id || id };
    openModal({ type: 'compose' });
  } catch (e) {
    errToast(e);
  }
};
A.gDraftDelete = el => {
  const id = el.dataset.id;
  confirmDlg({
    title: 'Delete draft?',
    body: 'The draft is removed from your Gmail. This cannot be undone.',
    ok: 'Delete draft',
    danger: true,
    icon: 'trash-2',
    run: async () => {
      try {
        await deleteGmailDraft(id);
        ensureGmailDrafts();
        toast('Draft deleted');
      } catch (e) {
        errToast(e);
      }
    },
  });
};

/* ---------- Google Calendar CRUD ---------- */
export function gEvForm(mode, ev, date) {
  const allDay = ev ? !!ev.start?.date : true;
  const dateKey = ev ? eventDateKey(ev) : date;
  const timed = ev && ev.start?.dateTime;
  return {
    mode,
    id: ev ? ev.id : '',
    title: ev ? ev.summary || '' : '',
    allDay,
    date: dateKey || '',
    start: timed ? String(ev.start.dateTime).slice(11, 16) : '09:00',
    end: timed && ev.end?.dateTime ? String(ev.end.dateTime).slice(11, 16) : '10:00',
    location: ev ? ev.location || '' : '',
    description: ev ? ev.description || '' : '',
    attendees: ev ? (ev.attendees || []).join(', ') : '',
    calendarId: ev ? ev.calendarId || '' : '',
    sending: false,
    error: null,
  };
}
IN.gEvForm = el => {
  S.ui.gEvForm[el.dataset.f] = el.dataset.f === 'allDay' ? el.checked : el.value;
  /* Only the All-day toggle changes the form's shape (time fields); a
     date change re-arms the busy strip for that day. */
  if (el.dataset.f === 'allDay') render();
  else if (el.dataset.f === 'date' && el.value) ensureFreebusy(el.value);
};
A.gEventNew = el => {
  if (!googleStatus().connected) return;
  ensureCalendarList(); // picker source (no-op once cached)
  S.ui.gEvForm = gEvForm('create', null, el.dataset.date);
  S.ui.errors = {};
  if (el.dataset.date) ensureFreebusy(el.dataset.date);
  openModal({ type: 'geventForm' });
};
A.gEventEdit = el => {
  const ev = (S.ui.gevs || []).find(x => x.id === el.dataset.id);
  if (!ev) return;
  ensureCalendarList();
  S.ui.gEvForm = gEvForm('edit', ev);
  S.ui.pop = null;
  if (S.ui.gEvForm.date) ensureFreebusy(S.ui.gEvForm.date);
  openModal({ type: 'geventForm' });
};
A.gEvCancel = () => {
  closeModal();
};
function withLocalOffset(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return '';
  const dt = new Date(y, mo - 1, d, h, mi);
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const b = String(Math.abs(off) % 60).padStart(2, '0');
  return `${dateStr}T${timeStr}:00${sign}${a}:${b}`;
}
A.gEvSubmit = async () => {
  const f = S.ui.gEvForm;
  if (f.sending) return;
  f.title = ($('#g-ev-title')?.value ?? f.title).trim();
  f.date = $('#g-ev-date')?.value ?? f.date;
  f.start = $('#g-ev-start')?.value ?? f.start;
  f.end = $('#g-ev-end')?.value ?? f.end;
  if (!f.title) f.error = 'Give the event a title.';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) f.error = 'Pick a date.';
  else if (!f.allDay) {
    if (!f.start || !f.end) f.error = 'Pick a start and end time.';
    else if (f.end <= f.start) f.error = 'The end time must be after the start time.';
  }
  if (f.error) {
    render();
    return;
  }
  const attendees = f.attendees
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const bad = attendees.filter(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  if (bad.length) {
    f.error = `"${bad[0]}" is not a valid email address.`;
    render();
    return;
  }
  const payload = {
    ...(f.allDay
      ? {
          start: { date: f.date },
          end: { date: iso(addD(parse(f.date), 1)) }, // Google end dates are exclusive
        }
      : {
          start: { dateTime: withLocalOffset(f.date, f.start) },
          end: { dateTime: withLocalOffset(f.date, f.end) },
        }),
    title: f.title,
    location: f.location,
    description: f.description,
    attendees,
    calendarId: f.calendarId || '',
  };
  f.sending = true;
  f.error = null;
  render();
  try {
    let ev;
    if (f.mode === 'edit') ev = await updateGEvent(f.id, payload);
    else ev = await createGEvent(payload);
    /* AC5 bridge: a meeting created FROM a task writes back the task's
       convenience ref (task.event = { id, summary }) and — when the task
       is linked to a client — the links[] row for the event. The id stored
       is the one Google returned (the same id the popover resolves). */
    if (f.mode !== 'edit' && f.taskLink) {
      const t = task(f.taskLink.taskId);
      if (t && ev && ev.id) {
        const startMs = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : ev.start?.date ? Date.parse(`${ev.start.date}T00:00:00`) : Date.now();
        mutate(() => {
          t.event = { id: ev.id, summary: ev.summary || f.title };
          const cid = linkedClientIdForTask(D().links, t.id);
          if (cid) {
            D().links = upsertLink(
              D().links,
              makeLinkRow({ id: uid('lk'), clientId: cid, kind: 'event', ref: ev.id, title: ev.summary || f.title, when: startMs, snippet: f.location || '' }),
            );
          }
        });
      }
    }
    closeModal();
    toast(f.mode === 'edit' ? 'Event updated — attendees notified' : 'Event created — attendees notified');
    refetchCalendarWindow(currentCalWindow());
  } catch (e) {
    f.sending = false;
    f.error = e?.message || 'Saving the event failed.';
    render();
  }
};
A.gEventDelete = el => {
  const id = el.dataset.id;
  const ev = (S.ui.gevs || []).find(x => x.id === id);
  S.ui.pop = null;
  confirmDlg({
    title: `Delete "${ev?.summary || 'this event'}"?`,
    body: 'The event will be removed from your Google Calendar and every attendee will be notified by Google.',
    ok: 'Delete event',
    danger: true,
    icon: 'trash-2',
    run: async () => {
      try {
        await deleteGEvent(id, ev?.calendarId || '');
        toast('Event deleted — attendees notified');
        refetchCalendarWindow(currentCalWindow());
      } catch (e) {
        errToast(e);
      }
    },
  });
};

/* ---------- calendar picker (Calendar page header + Settings) ---------- */

/* Toggles one calendar in the persisted enabled set (prefs.calendarIds).
   mutate() runs the write + save (write-through sync) + render; the
   changed set re-arms the window fetch via toggleCalendarEnabled. */
A.gCalToggle = el => {
  const id = el.dataset.id;
  if (!id) return;
  mutate(() => toggleCalendarEnabled(id));
};
