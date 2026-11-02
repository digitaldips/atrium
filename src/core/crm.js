/* =====================================================================
   CRM · pure data layer for clients + deals
   Every function is data-in/data-out (no DOM, no store, no network) so
   the migration, stage math and formatting run in plain node tests and
   anywhere in the app. Rendering and mutations live in pages/actions.
   ===================================================================== */

/* ---------- vocabulary ---------- */
/* Fixed pipeline order: the kanban board renders columns in exactly this
   sequence, and drag-drop writes one of these ids back onto the deal. */
export const CRM_STAGES = [
  { id: 'lead', name: 'Lead' },
  { id: 'qualified', name: 'Qualified' },
  { id: 'proposal', name: 'Proposal' },
  { id: 'won', name: 'Won' },
  { id: 'lost', name: 'Lost' },
];
export const CRM_STAGE = Object.fromEntries(CRM_STAGES.map(s => [s.id, s]));

export const CLIENT_STATUSES = [
  { id: 'lead', name: 'Lead' },
  { id: 'active', name: 'Active' },
  { id: 'inactive', name: 'Inactive' },
];
export const CSTATUS = Object.fromEntries(CLIENT_STATUSES.map(s => [s.id, s]));

export const stageIndex = id => CRM_STAGES.findIndex(s => s.id === id);
export const isKnownStage = id => stageIndex(id) >= 0;

/* Any move between two known stages is a valid pipeline move (kanban
   semantics: dragging backwards reopens a deal). Unknown or same-stage
   targets are rejected by the drag-drop handler. */
export function isValidTransition(from, to) {
  return isKnownStage(from) && isKnownStage(to) && from !== to;
}

/* ---------- zero-loss migration ---------- */
/* The workspace document predating the CRM has no clients/deals. This
   initializer runs on hydrate AND bootstrap and ONLY guarantees the two
   arrays exist: existing arrays are kept by reference, every other key is
   untouched, corrupt non-array values are reset to empty. Idempotent. */
export function ensureCrmData(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.clients)) doc.clients = [];
  if (!Array.isArray(doc.deals)) doc.deals = [];
  return doc;
}

/* ---------- summary math (AC4) ---------- */
/* "Open pipeline" = everything not yet won and not lost (unknown stages
   count as open so a corrupt stage never hides money). Values may arrive
   as strings from inputs — coerced defensively. */
export function dealTotals(deals) {
  const t = { openValue: 0, openCount: 0, wonValue: 0, wonCount: 0, lostValue: 0, lostCount: 0, total: 0, count: 0 };
  for (const d of Array.isArray(deals) ? deals : []) {
    const v = Number(d?.value) || 0;
    t.total += v;
    t.count += 1;
    if (d?.stage === 'won') {
      t.wonValue += v;
      t.wonCount += 1;
    } else if (d?.stage === 'lost') {
      t.lostValue += v;
      t.lostCount += 1;
    } else {
      t.openValue += v;
      t.openCount += 1;
    }
  }
  return t;
}

export const activeClientCount = clients => (Array.isArray(clients) ? clients : []).filter(c => c?.status === 'active').length;

/* ---------- EUR formatting ---------- */
/* Whole-euro display for summary strips and cards (values are whole euros
   in practice; decimals round on display only). Cached formatter; the
   en-IE locale gives the calm "€1,250" shape. */
const EUR_FMT = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export function sanitizeDealValue(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function eur(v) {
  const n = Number(v);
  return EUR_FMT.format(Number.isFinite(n) ? Math.round(n) : 0);
}

/* The org is the single company affiliation on a client. Legacy pre-org
   clients carry a free-text `company` string — it renders only as a
   read-only fallback and is never written anymore (preserve-on-edit). */
export function clientCompany(c, orgs) {
  if (!c) return '';
  const o = c.org ? (orgs || []).find(x => x && x.id === c.org) : null;
  return (o && o.name) || c.company || '';
}
