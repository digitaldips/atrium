/* =====================================================================
   MAIL ACTIONS · shared mock-mail handlers (Orbit integration T3)
   Every mutation rides mutate(fn) (apply + save + render) so the doc.mail
   payload persists through the workspace document's own write-through
   sync — no network, no new tables. Send is a MOCK send: messages are
   stored in the shared workspace and copied to Sent; nothing leaves the
   building (the compose modal says so honestly).
   ===================================================================== */
import { D, S, crmClients, crmLinks, me } from '../core/store.js';
import { uid } from '../core/utils.js';
import { appendMailReply, makeMailThread, mailMoveThread, mailSetRead, mailToggleStar, mailThreadContact, removeMailThread } from '../core/mail.js';
import { mailSuggestion, makeLinkRow } from '../core/links.js';
import { mutate, toast } from '../ui/toast.js';
import { closeModal, openModal } from '../overlays/modals.js';
import { closePop } from '../overlays/popovers.js';
import { render } from '../shell/render.js';
import { A, IN } from './actions.js';

const threads = () => D().mail?.threads || [];
const findThread = id => threads().find(t => t && t.id === id);
const myFrom = () => {
  const m = me();
  return { name: m?.name || 'You', email: m?.email || '' };
};

/* ---------- navigation ---------- */
A.mailFolder = el => {
  S.ui.mailFolder = el.dataset.id || 'f_inbox';
  S.ui.mailSel = null;
  S.ui.mailQ = '';
  render();
};
A.mBack = () => {
  S.ui.mailSel = null;
  render();
};
A.mSearchClear = () => {
  S.ui.mailQ = '';
  render();
};

/* ---------- thread actions ---------- */
A.mSel = el => {
  const id = el.dataset.id;
  if (!findThread(id)) return; // empty-state guard: no crash on a stale row
  mutate(() => {
    S.ui.mailSel = id;
    S.ui.mOpen = new Set(); // the preview opens the newest message card
    D().mail.threads = mailSetRead(D().mail.threads, id, true); // opening a thread marks it read (Orbit semantics)
  });
};
A.mStar = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = mailToggleStar(D().mail.threads, el.dataset.id);
  });
};
A.mUnread = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = mailSetRead(D().mail.threads, el.dataset.id, false);
  });
  toast('Marked as unread');
};
A.mArchive = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = mailMoveThread(D().mail.threads, el.dataset.id, 'f_archive');
  });
  toast('Archived');
};
A.mTrash = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = mailMoveThread(D().mail.threads, el.dataset.id, 'f_trash');
  });
  toast('Moved to Trash — restore any time');
};
/* Trash keeps restore: back to Inbox (the original folder is not tracked — Inbox is the honest default). */
A.mRestore = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = mailMoveThread(D().mail.threads, el.dataset.id, 'f_inbox');
  });
  toast('Restored to Inbox');
};
A.mDelete = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = removeMailThread(D().mail.threads, el.dataset.id);
    if (S.ui.mailSel === el.dataset.id) S.ui.mailSel = null;
  });
  toast('Deleted forever', { kind: 'info' });
};
/* Move to folder — picker popover case 'mailfolder' carries the thread id on S.ui.pop. */
A.mMovePick = el => {
  const p = S.ui.pop;
  const folder = el.dataset.v;
  if (!p || !folder || !findThread(p.id)) return;
  mutate(() => {
    D().mail.threads = mailMoveThread(D().mail.threads, p.id, folder);
  });
  closePop();
  toast(`Moved to ${D().mail.folders.find(f => f.id === folder)?.name || 'folder'}`);
};
A.mMsgToggle = el => {
  S.ui.mOpen = S.ui.mOpen || new Set();
  S.ui.mOpen.has(el.dataset.id) ? S.ui.mOpen.delete(el.dataset.id) : S.ui.mOpen.add(el.dataset.id);
  render();
};

/* ---------- compose / reply / drafts ---------- */
/* Form values live in S.ui.mForm (IN.mForm mirrors keystrokes) but are
   re-read from the DOM on submit — the stored form never goes stale. */
const readForm = () => {
  const f = S.ui.mForm;
  f.to = (document.querySelector('#m-to')?.value ?? f.to).trim();
  f.subject = document.querySelector('#m-subject')?.value ?? f.subject;
  f.body = document.querySelector('#m-body')?.value ?? f.body;
  return f;
};
const validateSend = f => {
  if (!f.body.trim()) return 'Write a message before sending.';
  if (!f.to) return 'Add at least one recipient.';
  return null;
};
A.mCompose = () => {
  S.ui.mForm = { to: '', subject: '', body: '', draftId: null, replyTo: null, sending: false, error: null };
  openModal({ type: 'mailCompose' });
};
A.mReply = el => {
  const t = findThread(S.ui.mailSel || el.dataset.id);
  if (!t) return;
  const last = t.messages?.length ? t.messages[t.messages.length - 1] : null;
  S.ui.mForm = {
    to: last?.from?.email || '',
    subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`,
    body: '',
    draftId: null,
    replyTo: t.id,
    sending: false,
    error: null,
  };
  openModal({ type: 'mailCompose', reply: true });
};
A.mDraftOpen = el => {
  const t = findThread(el.dataset.id);
  if (!t) return;
  const m0 = t.messages?.[0];
  S.ui.mForm = {
    to: (m0?.to || []).join(', '),
    subject: t.subject === '(no subject)' ? '' : t.subject,
    body: m0?.body || '',
    draftId: t.id,
    replyTo: null,
    sending: false,
    error: null,
  };
  S.ui.mailSel = t.id;
  openModal({ type: 'mailCompose' });
};
A.mDraftDelete = el => {
  if (!findThread(el.dataset.id)) return;
  mutate(() => {
    D().mail.threads = removeMailThread(D().mail.threads, el.dataset.id);
    if (S.ui.mailSel === el.dataset.id) S.ui.mailSel = null;
  });
  toast('Draft deleted');
};
A.mSend = () => {
  const f = S.ui.mForm;
  if (f.sending) return;
  readForm();
  const err = validateSend(f);
  if (err) {
    f.error = err;
    render();
    return;
  }
  f.sending = true;
  render();
  mutate(() => {
    if (f.replyTo) {
      /* Reply: append to the thread + the mock-send copy in Sent. */
      const t = findThread(f.replyTo);
      if (t) {
        const { thread, sent } = appendMailReply(t, { id: uid('mm'), from: myFrom(), body: f.body, now: Date.now(), sentId: uid('m') });
        D().mail.threads = threads().map(x => (x.id === t.id ? thread : x));
        if (sent) D().mail.threads = [sent, ...D().mail.threads];
        S.ui.mailSel = t.id;
      }
    } else if (f.draftId) {
      /* Sending a draft: the draft thread becomes the Sent thread (Gmail semantics — sending removes the draft). */
      const id = f.draftId;
      const fresh = makeMailThread({ id, folderId: 'f_sent', subject: f.subject, to: f.to, from: myFrom(), body: f.body, now: Date.now() });
      D().mail.threads = threads().map(x => (x.id === id ? fresh : x));
      S.ui.mailFolder = 'f_sent';
      S.ui.mailSel = id;
    } else {
      const fresh = makeMailThread({ id: uid('m'), folderId: 'f_sent', subject: f.subject, to: f.to, from: myFrom(), body: f.body, now: Date.now() });
      D().mail.threads = [fresh, ...D().mail.threads];
      S.ui.mailSel = fresh.id;
    }
    S.ui.mForm = { to: '', subject: '', body: '', draftId: null, replyTo: null, sending: false, error: null };
    closeModal();
  });
  toast(f.replyTo ? 'Reply sent — saved in the thread and Sent' : 'Sent — saved in Sent (mock send, stored in the workspace)');
};
A.mSaveDraft = () => {
  const f = S.ui.mForm;
  readForm();
  const id = f.draftId || uid('m');
  mutate(() => {
    const fresh = makeMailThread({ id, folderId: 'f_drafts', subject: f.subject, to: f.to, from: myFrom(), body: f.body, now: Date.now() });
    D().mail.threads = f.draftId ? threads().map(x => (x.id === id ? fresh : x)) : [fresh, ...D().mail.threads];
    S.ui.mailSel = id;
    S.ui.mForm = { to: '', subject: '', body: '', draftId: null, replyTo: null, sending: false, error: null };
    closeModal();
  });
  toast(f.draftId ? 'Draft updated' : 'Draft saved to Drafts');
};

/* ---------- CRM linkage (AC5) ---------- */
/* One-click confirm of an exact-address suggestion (reuses mailSuggestion
   against the thread's last sender). Never acts on a stale badge. */
A.mLinkConfirm = el => {
  const t = findThread(el.dataset.id);
  const m = me();
  const contact = mailThreadContact(t, m?.email || '');
  if (!contact) return;
  const sug = mailSuggestion(crmLinks(), crmClients(), contact);
  if (!sug) return;
  mutate(() => {
    D().links = (D().links || []).concat(
      makeLinkRow({ id: uid('lk'), clientId: sug.clientId, kind: 'mail', ref: t.id, title: t.subject, when: Date.now(), snippet: t.snippet || '' }),
    );
  });
  toast(`Linked to ${sug.client?.name || 'client'} — matches ${sug.matchedEmail} on client email`);
};

/* ---------- inputs ---------- */
IN.mForm = el => {
  S.ui.mForm[el.dataset.f] = el.value;
  /* Values live in the DOM and are re-read on submit — no render per keystroke; only a cleared error repaints. */
  if (S.ui.mForm.error) {
    S.ui.mForm.error = null;
    render();
  }
};
IN.mSearch = el => {
  S.ui.mailQ = el.value;
  render();
};
