/* =====================================================================
   MAIL · pure data layer for the shared Mail module (Orbit integration T3)
   Data-in/data-out only (no DOM, no store, no network) so the seed
   builder, the zero-loss doc initializer, folder filtering/unread counts,
   search, thread actions and the reply/compose/draft builders run in
   plain node tests. doc.mail = { folders, threads } lives INSIDE the
   workspace document (shared workspace state — mail is not per-user, no
   new Postgres tables); persistence rides the normal save() path.
   Shape ported from Orbit's apps/web/src/mock/seed/mail.ts: folders
   {id,name,icon,custom}, threads {id,folderId,subject,snippet,unread,
   starred,hasAttachment,updatedAt,messages[]}; messages {id,from{name,
   email},to[],body,createdAt,attachments?} — epoch-ms timestamps (Atrium
   ago() takes ms; Orbit used ISO strings). CRM linkage reuses
   links.js findLink/mailSuggestion via mailThreadContact.
   ===================================================================== */

const H = 3600e3,
  D = 86400e3;

/* ---------- AC2/AC6: seed builder (Orbit shape, Operance context) ---------- */
/* Fictional senders in the Operance construction world; one thread per
   folder so the rail counts mean something on a fresh doc. Attachments
   are DISPLAY-ONLY refs ({filename,size}) on the hasAttachment threads. */
export function buildMailSeed(now, me = {}) {
  const from = { name: me.name || 'You', email: me.email || '' };
  const at = ms => now - ms;
  const msg = (id, from_, to, body, createdAt, attachments) => ({
    id,
    from: from_,
    to,
    body,
    createdAt,
    ...(attachments && attachments.length ? { attachments } : {}),
  });
  return {
    folders: [
      { id: 'f_inbox', name: 'Inbox', icon: 'inbox' },
      { id: 'f_starred', name: 'Starred', icon: 'star' },
      { id: 'f_sent', name: 'Sent', icon: 'send' },
      { id: 'f_drafts', name: 'Drafts', icon: 'note' },
      { id: 'f_archive', name: 'Archive', icon: 'archive' },
      { id: 'f_trash', name: 'Trash', icon: 'trash' },
      { id: 'f_clients', name: 'Clients', icon: 'folder', custom: true },
      { id: 'f_suppliers', name: 'Suppliers', icon: 'folder', custom: true },
      { id: 'f_invoices', name: 'Invoices', icon: 'folder', custom: true },
    ],
    threads: [
      {
        id: 'm_1',
        folderId: 'f_inbox',
        subject: 'Re: Site camera offline after the storm',
        snippet: 'We are still seeing the camera drop offline every hour. Can someone take another look?',
        unread: true,
        starred: true,
        hasAttachment: false,
        updatedAt: at(1 * H),
        messages: [
          msg(
            'mm_1',
            { name: 'Marco van den Berg', email: 'marco@vandenbergbv.nl' },
            ['site@operanceai.com'],
            "Hi team,\n\nAfter last night's storm our site camera on Tower B started dropping offline every hour. It recovers for a while and then drops again.\n\nCould you take a look?\n\nMarco",
            at(5 * H),
          ),
          msg(
            'mm_2',
            from,
            ['marco@vandenbergbv.nl'],
            "Hi Marco,\n\nThanks for the report — we tracked this to the camera reconnecting after the site router restart. A firmware fix is rolling out today.\n\nI'll follow up as soon as it's live.",
            at(3 * H),
          ),
          msg(
            'mm_3',
            { name: 'Marco van den Berg', email: 'marco@vandenbergbv.nl' },
            [from.email || 'site@operanceai.com'],
            'We are still seeing the camera drop offline every hour. Can someone take another look?\n\nMarco',
            at(1 * H),
          ),
        ],
      },
      {
        id: 'm_2',
        folderId: 'f_inbox',
        subject: 'Invoice #2043 — August scaffolding hire',
        snippet: 'Your invoice for August is attached. Payment is due within 14 days.',
        unread: true,
        starred: false,
        hasAttachment: true,
        updatedAt: at(4 * H),
        messages: [
          msg(
            'mm_4',
            { name: 'Bouwmateriaal Billing', email: 'facturen@bouwmateriaal.nl' },
            ['admin@operanceai.com'],
            'Dear customer,\n\nYour invoice for August is attached. Payment is due within 14 days.\n\nKind regards,\nBilling team',
            at(4 * H),
            [{ filename: 'invoice-2043.pdf', size: 86016 }],
          ),
        ],
      },
      {
        id: 'm_3',
        folderId: 'f_inbox',
        subject: 'Delivery delay: steel profiles for Tower B',
        snippet: 'A backlog at the rolling mill pushes our delivery to Thursday next week…',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(1 * D),
        messages: [
          msg(
            'mm_5',
            { name: 'Staalhandel Planning', email: 'planning@staalhandel.nl' },
            ['admin@operanceai.com'],
            'A backlog at the rolling mill pushes our delivery of steel profiles to Thursday next week. We apologise for the delay and have reserved priority slots for your follow-up order.\n\nPlanning team',
            at(1 * D),
          ),
        ],
      },
      {
        id: 'm_4',
        folderId: 'f_inbox',
        subject: 'Partnership inquiry — prefab modules',
        snippet: 'Hello! I represent a prefab manufacturer and would love to explore a collaboration…',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(2 * D),
        messages: [
          msg(
            'mm_6',
            { name: 'Sam de Vries', email: 'sam@prefabbouw.nl' },
            ['hello@operanceai.com'],
            'Hello!\n\nI represent a prefab manufacturer and would love to explore a collaboration on modular builds. Would you have 30 minutes this week for a quick call?\n\nBest,\nSam',
            at(2 * D),
          ),
        ],
      },
      {
        id: 'm_5',
        folderId: 'f_inbox',
        subject: 'Re: Candidate intro — site supervisor',
        snippet: 'Thanks! Attaching the CV. They are available for interviews from next week.',
        unread: false,
        starred: true,
        hasAttachment: true,
        updatedAt: at(3 * D),
        messages: [
          msg(
            'mm_7',
            { name: 'Anna Recruiter', email: 'anna@bouwbanen.nl' },
            [from.email || 'hr@operanceai.com'],
            'Thanks! Attaching the CV. They are available for interviews from next week.\n\nAnna',
            at(3 * D),
            [{ filename: 'cv-site-supervisor.pdf', size: 212992 }],
          ),
        ],
      },
      {
        id: 'm_6',
        folderId: 'f_sent',
        subject: 'Site closed Friday — crane inspection',
        snippet: 'We will close the Tower B site this Friday between 07:00 and 12:00 for the crane inspection…',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(2 * D),
        messages: [
          msg(
            'mm_8',
            from,
            ['klanten@vandenbergbv.nl'],
            'Hi everyone,\n\nWe will close the Tower B site this Friday between 07:00 and 12:00 for the periodic crane inspection. Expect no site access during that window.\n\n' +
              (from.name || 'You'),
            at(2 * D),
          ),
        ],
      },
      {
        id: 'm_7',
        folderId: 'f_sent',
        subject: 'Re: Invoice #2019 — July materials',
        snippet: 'Confirming payment went out this morning. Reference: TX-88412.',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(6 * D),
        messages: [
          msg(
            'mm_9',
            from,
            ['facturen@bouwmateriaal.nl'],
            'Hi,\n\nConfirming payment went out this morning. Reference: TX-88412.\n\n' + (from.name || 'You'),
            at(6 * D),
          ),
        ],
      },
      {
        id: 'm_8',
        folderId: 'f_drafts',
        subject: 'Q4 handover summary — Tower B',
        snippet: 'Draft — Here is where we landed for Q4: crane inspection, facade panels, handover planning…',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(1 * D),
        messages: [
          msg(
            'mm_10',
            from,
            [],
            'Here is where we landed for Q4: crane inspection, facade panels, and the handover planning for Tower B. Still need the final numbers from…',
            at(1 * D),
          ),
        ],
      },
      {
        id: 'm_9',
        folderId: 'f_archive',
        subject: 'Welcome to Operance',
        snippet: 'Your workspace has been provisioned and is ready to use.',
        unread: false,
        starred: false,
        hasAttachment: false,
        updatedAt: at(30 * D),
        messages: [
          msg(
            'mm_11',
            { name: 'Operance', email: 'noreply@operanceai.com' },
            [from.email || 'you@operanceai.com'],
            'Your workspace has been provisioned and is ready to use. Start by adding your first project and clients.',
            at(30 * D),
          ),
        ],
      },
    ],
  };
}

/* ---------- AC2: zero-loss doc initializer ---------- */
/* The ensureCrmData/ensureDocShape contract: runs on ALL THREE ingest
   paths (hydrate loaded-branch, bootstrap branch, trusted-cache bind) and
   ONLY guarantees doc.mail exists with folder/thread arrays — an existing
   mail object is kept BY REFERENCE (its threads are shared workspace
   state, possibly mutated by another surface), missing sub-keys are
   filled, junk sub-keys are reset, every other doc key is untouched.
   Idempotent. */
export function ensureMailData(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  if (!doc.mail || typeof doc.mail !== 'object' || Array.isArray(doc.mail)) doc.mail = buildMailSeed(Date.now(), currentMe(doc));
  if (!Array.isArray(doc.mail.folders)) doc.mail.folders = buildMailSeed(Date.now(), currentMe(doc)).folders;
  if (!Array.isArray(doc.mail.threads)) doc.mail.threads = buildMailSeed(Date.now(), currentMe(doc)).threads;
  return doc;
}
const currentMe = doc => {
  const m = Array.isArray(doc?.members) ? doc.members.find(x => x && x.id === doc.me) : null;
  return m || {};
};

/* ---------- AC1/AC4: folder filtering + counts (Orbit semantics) ---------- */
/* Threads in a folder, newest first. "Starred" is virtual: it filters on
   the star flag instead of folderId. */
export function threadsInFolder(threads, folderId) {
  const list = (Array.isArray(threads) ? threads : []).filter(t => t && (folderId === 'f_starred' ? t.starred : t.folderId === folderId));
  return list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

export function folderUnreadCount(threads, folderId) {
  return threadsInFolder(threads, folderId).filter(t => t.unread).length;
}

/* ---------- AC4: search — literal case-insensitive match on subject,
   snippet and every message body (no wildcards) ---------- */
export function mailSearchFilter(threads, q) {
  const needle = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return [];
  return (Array.isArray(threads) ? threads : []).filter(
    t =>
      t &&
      (String(t.subject ?? '')
        .toLowerCase()
        .includes(needle) ||
        String(t.snippet ?? '')
          .toLowerCase()
          .includes(needle) ||
        (Array.isArray(t.messages) ? t.messages : []).some(m =>
          String(m?.body ?? '')
            .toLowerCase()
            .includes(needle),
        )),
  );
}

/* ---------- AC3: thread actions (pure list edits — never mutate input) ---------- */
export function mailPatchThread(threads, id, patch) {
  return (Array.isArray(threads) ? threads : []).map(t => (t && t.id === id ? { ...t, ...(patch && typeof patch === 'object' ? patch : {}) } : t));
}
export const mailMoveThread = (threads, id, folderId) => mailPatchThread(threads, id, { folderId });
export const mailSetRead = (threads, id, read) => mailPatchThread(threads, id, { unread: !read });
export function mailToggleStar(threads, id) {
  const t = (Array.isArray(threads) ? threads : []).find(x => x && x.id === id);
  return t ? mailPatchThread(threads, id, { starred: !t.starred }) : Array.isArray(threads) ? threads.slice() : [];
}
export function removeMailThread(threads, id) {
  return (Array.isArray(threads) ? threads : []).filter(t => t && t.id !== id);
}

/* ---------- AC3: reply builder — appends a from-me message to the thread
   AND returns the mock-send copy for Sent (null when the thread already
   lives there). to = the last message's sender (the counterpart). ---------- */
export function appendMailReply(thread, reply) {
  if (!thread || typeof thread !== 'object') return { thread, sent: null };
  const last = Array.isArray(thread.messages) && thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
  const to = last && last.from && typeof last.from.email === 'string' ? [last.from.email] : [];
  const body = typeof reply?.body === 'string' ? reply.body : '';
  const r = {
    id: reply?.id || 'mm',
    from: reply?.from || { name: 'You', email: '' },
    to,
    body,
    createdAt: Number(reply?.now) || Date.now(),
    attachments: [],
  };
  const updated = {
    ...thread,
    snippet: body.slice(0, 90),
    unread: false,
    updatedAt: r.createdAt,
    messages: [...(Array.isArray(thread.messages) ? thread.messages : []), r],
  };
  /* Mock send also writes Sent — except a reply inside Sent itself. */
  const sent =
    thread.folderId === 'f_sent'
      ? null
      : makeMailThread({ id: reply?.sentId || 'm', folderId: 'f_sent', subject: thread.subject, to: to[0] || '', from: r.from, body, now: r.createdAt });
  return { thread: updated, sent };
}

/* ---------- AC3: compose/draft thread builder ---------- */
export function makeMailThread({ id, folderId, subject, to, from, body, now }) {
  const f = from && typeof from === 'object' ? from : { name: 'You', email: '' };
  const toList = String(to ?? '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const text = typeof body === 'string' ? body : '';
  return {
    id,
    folderId: folderId || 'f_sent',
    subject: typeof subject === 'string' && subject.trim() ? subject.trim() : '(no subject)',
    snippet: text.slice(0, 90),
    unread: false,
    starred: false,
    hasAttachment: false,
    updatedAt: Number(now) || Date.now(),
    messages: [
      {
        id: id ? id.replace(/^m/, 'mm') + '_' + (Number(now) || Date.now()) : 'mm',
        from: f,
        to: toList,
        body: text,
        createdAt: Number(now) || Date.now(),
        attachments: [],
      },
    ],
  };
}

/* ---------- AC5: CRM linkage contact ---------- */
/* The pseudo-message mailSuggestion() consumes: ref = the THREAD id
   (links[] rows are kind+ref unique; one thread links to one client) and
   email = the last message's from-address. A thread whose last sender is
   me (my own sent mail / replies) suggests nothing — null. */
export function mailThreadContact(thread, meEmail = '') {
  if (!thread || !thread.id || !Array.isArray(thread.messages) || !thread.messages.length) return null;
  const last = thread.messages[thread.messages.length - 1];
  const email = last && last.from && typeof last.from.email === 'string' ? last.from.email : '';
  if (!email) return null;
  if (meEmail && email.trim().toLowerCase() === String(meEmail).trim().toLowerCase()) return null;
  return { id: thread.id, email };
}
