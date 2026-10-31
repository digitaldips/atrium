/* ---------- GOOGLE INTEGRATION actions ---------- */
import { A, IN, KEY, confirmDlg } from './actions.js';
import { $, esc, iso, addD, parse } from '../core/utils.js';
import { S } from '../core/store.js';
import { render } from '../shell/render.js';
import { toast } from '../ui/toast.js';
import { openModal, closeModal } from '../overlays/modals.js';
import { eventDateKey } from '../../supabase/functions/_shared/google-pure.js';
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
    await sendGmail({ to: f.to, cc: f.cc, subject: f.subject, body: f.body, threadId: f.threadId, inReplyTo: f.inReplyTo, references: f.references });
    closeModal();
    toast('Message sent');
    refetchGmailList();
    ensureGmail();
  } catch (e) {
    f.sending = false;
    f.error = e?.message || 'Sending failed.';
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

/* ---------- Google Calendar CRUD ---------- */
function gEvForm(mode, ev, date) {
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
    sending: false,
    error: null,
  };
}
IN.gEvForm = el => {
  S.ui.gEvForm[el.dataset.f] = el.dataset.f === 'allDay' ? el.checked : el.value;
  /* Only the All-day toggle changes the form's shape (time fields). */
  if (el.dataset.f === 'allDay') render();
};
A.gEventNew = el => {
  if (!googleStatus().connected) return;
  S.ui.gEvForm = gEvForm('create', null, el.dataset.date);
  S.ui.errors = {};
  openModal({ type: 'geventForm' });
};
A.gEventEdit = el => {
  const ev = (S.ui.gevs || []).find(x => x.id === el.dataset.id);
  if (!ev) return;
  S.ui.gEvForm = gEvForm('edit', ev);
  S.ui.pop = null;
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
  const payload = f.allDay
    ? {
        title: f.title,
        start: { date: f.date },
        end: { date: iso(addD(parse(f.date), 1)) }, // Google end dates are exclusive
        location: f.location,
        description: f.description,
        attendees,
      }
    : {
        title: f.title,
        start: { dateTime: withLocalOffset(f.date, f.start) },
        end: { dateTime: withLocalOffset(f.date, f.end) },
        location: f.location,
        description: f.description,
        attendees,
      };
  f.sending = true;
  f.error = null;
  render();
  try {
    if (f.mode === 'edit') await updateGEvent(f.id, payload);
    else await createGEvent(payload);
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
        await deleteGEvent(id);
        toast('Event deleted — attendees notified');
        refetchCalendarWindow(currentCalWindow());
      } catch (e) {
        errToast(e);
      }
    },
  });
};
