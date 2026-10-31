/* =====================================================================
   LINKS · pure data layer for CRM ↔ mail / event / task linkage
   Every function is data-in/data-out (no DOM, no store, no network) so
   the dedupe, auto-link matcher and prefill builders run in plain node
   tests and anywhere in the app. Rendering and mutations live in
   pages/actions.

   Link rows live INSIDE the workspace document (doc.links, same model as
   clients/deals — no new Postgres tables). One row:
     { id, clientId, kind: 'mail'|'event'|'task',
       ref,        gmail message id / Google event id / Atrium task id
       title,      subject / summary / task title (stored snapshot)
       when,       epoch ms (message date / event start / link creation)
       snippet }   short text snapshot for list rendering
   Uniqueness: kind+ref across ALL clients (a gmail message, event or task
   links to at most ONE client — moving a link removes the old row).
   ===================================================================== */

export const LINK_KINDS = ['mail', 'event', 'task'];

/* ---------- zero-loss doc initializer ---------- */
/* Extends the ensureCrmData pattern: the workspace document predating the
   linkage feature has no links[]. This initializer runs on hydrate AND
   bootstrap AND the trusted-cache bind and ONLY guarantees links exists —
   existing arrays are kept by reference, every other key is untouched,
   corrupt non-array values are reset to empty. Idempotent. Task-side
   convenience refs (task.gmail / task.event) are deliberately NOT
   normalized here: missing refs are simply falsy at render time, so there
   is nothing to lose and nothing to invent. */
export function ensureDocShape(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.links)) doc.links = [];
  return doc;
}

/* ---------- row factory ---------- */
/* Normalizes one link row; null when the row would be meaningless (unknown
   kind, no client, no ref). Callers supply the id. */
export function makeLinkRow(input) {
  const r = input && typeof input === 'object' ? input : null;
  if (!r || !LINK_KINDS.includes(r.kind)) return null;
  const clientId = typeof r.clientId === 'string' ? r.clientId.trim() : '';
  const ref = typeof r.ref === 'string' ? r.ref.trim() : '';
  if (!clientId || !ref) return null;
  const when = Number(r.when);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : 'lk',
    clientId,
    kind: r.kind,
    ref,
    title: typeof r.title === 'string' ? r.title : '',
    when: Number.isFinite(when) ? when : 0,
    snippet: typeof r.snippet === 'string' ? r.snippet : '',
  };
}

/* ---------- dedupe + lookups ---------- */
/* Insert-or-replace by kind+ref: an existing row for the SAME ref (any
   client) is removed first, so the new row is the only one — moving a
   link to another client replaces the old row, and the same
   clientId+kind+ref can never duplicate (the row is refreshed in place).
   Pure: returns a new array; the input is never mutated; a null row
   changes nothing. */
export function upsertLink(links, row) {
  const norm = makeLinkRow(row);
  if (!norm) return Array.isArray(links) ? links : [];
  const kept = (Array.isArray(links) ? links : []).filter(l => !(l && l.kind === norm.kind && l.ref === norm.ref));
  return [...kept, norm];
}

/* Remove every row matching kind+ref. Pure: new array. */
export function removeLink(links, kind, ref) {
  return (Array.isArray(links) ? links : []).filter(l => !(l && l.kind === kind && l.ref === ref));
}

export function findLink(links, kind, ref) {
  return (Array.isArray(links) ? links : []).find(l => l && l.kind === kind && l.ref === ref) || null;
}

/* Rows for one client, newest first (missing `when` sorts last). */
export function linksForClient(links, clientId, kind = null) {
  return (Array.isArray(links) ? links : [])
    .filter(l => l && l.clientId === clientId && (!kind || l.kind === kind))
    .sort((a, b) => (Number(b.when) || 0) - (Number(a.when) || 0));
}

/* The client a task is linked to (via its links[] row), or null. */
export function linkedClientIdForTask(links, taskId) {
  const row = findLink(links, 'task', taskId);
  return row ? row.clientId : null;
}

/* ---------- AC2: auto-link matcher (pure rule) ---------- */
/* A client email matches when it equals the message's from-address
   EXACTLY, case-insensitive and whitespace-trimmed. No fuzzy, no domain
   matching: client emails are data the user typed — only a certain match
   may suggest a link, and the suggestion is never applied silently. */
export function matchClientByEmail(clients, email) {
  const addr = String(email || '')
    .trim()
    .toLowerCase();
  if (!addr) return null;
  return (
    (Array.isArray(clients) ? clients : []).find(
      c =>
        c &&
        String(c.email || '')
          .trim()
          .toLowerCase() === addr,
    ) || null
  );
}

/* The auto-link suggestion for one fetched message: the matched client +
   the basis (the exact client email that matched), or null when the
   message has no exact match OR is already linked (any client — kind+ref
   is unique). The UI renders this as a one-click confirm badge; nothing
   is stored until the user confirms. */
export function mailSuggestion(links, clients, msg) {
  if (!msg || !msg.id) return null;
  if (findLink(links, 'mail', msg.id)) return null;
  const c = matchClientByEmail(clients, msg.email);
  if (!c) return null;
  return {
    clientId: c.id,
    client: c,
    matchedEmail: String(c.email || '')
      .trim()
      .toLowerCase(),
  };
}

/* ---------- AC4: task-from-mail prefill builder ---------- */
/* Prefill for the task form: title = subject ('(no subject)' falls back to
   the sender), notes = snippet + webLink, and the gmail ref the created
   task stores as task.gmail = { id, webLink, subject }. linkClientId is
   the auto-linked client (or an explicit one) — the created task also
   gets its links[] row via this client. */
export function taskFromMail(m, clientId = null) {
  const src = m && typeof m === 'object' ? m : {};
  const id = typeof src.id === 'string' ? src.id : '';
  const subject = typeof src.subject === 'string' && src.subject ? src.subject : '(no subject)';
  const from = typeof src.from === 'string' && src.from ? src.from : 'Gmail';
  const webLink = typeof src.webLink === 'string' ? src.webLink : '';
  const snippet = typeof src.snippet === 'string' ? src.snippet : '';
  const notes = [snippet, webLink].filter(Boolean).join('\n\n');
  return {
    title: subject === '(no subject)' ? `Email from ${from}` : subject,
    notes,
    gmail: { id, webLink, subject },
    linkClientId: clientId || null,
  };
}

/* ---------- AC5: mail-from-task prefill builder ---------- */
/* Prefill for the compose modal: to = the linked client's email (when the
   task has one), subject = the task title, body = a small template with
   the task details plus the webLink back to the task. Pure: the caller
   builds the webLink (it needs the workspace URL + task key). */
export function mailFromTask(t, clientEmail = '', taskUrl = '') {
  const task = t && typeof t === 'object' ? t : {};
  const title = typeof task.title === 'string' && task.title ? task.title : 'Untitled task';
  const status = typeof task.status === 'string' && task.status ? task.status : 'todo';
  const due = task.due ? String(task.due) : '';
  const lines = [`Hi,`, '', `About the Atrium task "${title}":`, `- Status: ${status}${due ? `\n- Due: ${due}` : ''}`];
  if (taskUrl) lines.push('', taskUrl);
  lines.push('', '— sent from Atrium');
  return { to: String(clientEmail || '').trim(), subject: title, body: lines.join('\n') };
}

/* ---------- AC5: event-from-task prefill builder ---------- */
/* Prefill for the Google-event modal: title = task title, date = the
   task's due date when present (else empty — the user picks), notes
   referencing the task. Attendees stay EMPTY: creating the event must
   never silently email invitations. The caller stamps form.taskLink so
   the created event writes back task.event = { id, summary } + the link
   row. */
export function eventFromTask(t, clientId = null) {
  const task = t && typeof t === 'object' ? t : {};
  const title = typeof task.title === 'string' && task.title ? task.title : 'Untitled task';
  const due = task.due && /^\d{4}-\d{2}-\d{2}$/.test(String(task.due)) ? String(task.due) : '';
  return {
    title,
    date: due,
    allDay: false,
    description: `Scheduled from the Atrium task "${title}".`,
    attendees: '',
    linkClientId: clientId || null,
  };
}
