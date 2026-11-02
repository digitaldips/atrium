/* =====================================================================
   CRM · pure data layer for clients + deals
   Every function is data-in/data-out (no DOM, no store, no network) so
   the migration, stage math and formatting run in plain node tests and
   anywhere in the app. Rendering and mutations live in pages/actions.
   ===================================================================== */

/* ---------- vocabulary ---------- */
/* The sales methodology (Wesley's 4-category kans model) as fixed data.
   The kanban board renders columns in exactly this sequence, drag-drop
   writes one of these ids back onto the deal, and every stage carries the
   kans + the verbatim Dutch betekenis/fase/focus from the methodology
   table — surfaced as tooltips and hints in the pipeline and forms.
   'zeker' deals STAY in the open pipeline at 100%: a signed contract or
   running retainer is real, live money, not history. Dragging a deal to
   won (Gewonnen) means afgerond/opgeleverd and stamps deal.wonAt. */
export const CRM_STAGES = [
  {
    id: 'longshot',
    name: 'Long shot',
    kans: 0.01,
    betekenis: 'Dreamklant of koude lead: interessant, maar (nog) geen echt contact',
    fase: 'Geïdentificeerd / eerste contact',
    focus: 'Ingang zoeken, warm maken via netwerk/content',
  },
  {
    id: 'mogelijk',
    name: 'Mogelijk',
    kans: 0.25,
    betekenis: 'In gesprek, behoefte verkend, maar nog geen voorstel of duidelijk budget',
    fase: 'Kennismaking / verkenning',
    focus: 'Behoefte scherp krijgen, voorstel voorbereiden',
  },
  {
    id: 'waarschijnlijk',
    name: 'Waarschijnlijk',
    kans: 0.5,
    betekenis: 'Concrete behoefte, budget en beslisser bekend; voorstel ligt er of is in onderhandeling',
    fase: 'Offerte/SOW uitgebracht',
    focus: 'Opvolgen, bezwaren wegnemen, closen',
  },
  {
    id: 'zeker',
    name: 'Zeker',
    kans: 1,
    betekenis: 'Getekend of bestaande klant met lopende opdracht/retainer',
    fase: 'Opdracht/contract rond',
    focus: 'Leveren, uitbreiden, referentie vragen',
  },
  {
    id: 'won',
    name: 'Gewonnen',
    kans: 1,
    betekenis: 'Deal afgerond: de opdracht is binnengehaald en opgeleverd',
    fase: 'Afgerond / opgeleverd',
    focus: 'Leveren, tevredenheid borgen, referentie vragen',
  },
  {
    id: 'lost',
    name: 'Verloren',
    kans: 0,
    betekenis: 'Geen opdracht gekregen',
    fase: 'Afgebroken',
    focus: 'Bewaar de les voor de volgende deal',
  },
];
export const CRM_STAGE = Object.fromEntries(CRM_STAGES.map(s => [s.id, s]));
/* New deals start at the bottom of the methodology funnel. */
export const DEFAULT_STAGE = 'longshot';
/* Stage ids used by docs created before the methodology shipped. Only
   these three strings remap — anything else is left untouched. */
const LEGACY_STAGE = { lead: 'mogelijk', qualified: 'mogelijk', proposal: 'waarschijnlijk' };

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
   untouched, corrupt non-array values are reset to empty. Idempotent.
   Deals carrying a pre-methodology stage id (lead/qualified/proposal) are
   remapped onto the closest methodology category in a NEW deal object
   that keeps every other field — untouched deals keep their reference and
   the array stays by reference unless a remap actually happened. */
export function ensureCrmData(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.clients)) doc.clients = [];
  /* T11 multi-org: client.orgs (array of org ids) is the source of truth.
     Legacy single `org` strings MOVE into orgs (key removed, value kept —
     equivalence: every legacy value ends up in the migrated array). Junk
     values drop to []. Idempotent; existing orgs arrays pass untouched. */
  for (const c of doc.clients) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.org === 'string' && c.org) {
      c.orgs = Array.isArray(c.orgs) ? (c.orgs.includes(c.org) ? c.orgs : [c.org, ...c.orgs]) : [c.org];
    } else if (!Array.isArray(c.orgs)) {
      c.orgs = [];
    }
    if ('org' in c) delete c.org;
  }
  if (!Array.isArray(doc.deals)) {
    doc.deals = [];
    return doc;
  }
  let dirty = false;
  const deals = doc.deals.map(d => {
    if (!d || typeof d !== 'object') return d;
    const to = LEGACY_STAGE[d.stage];
    if (!to) return d;
    dirty = true;
    return { ...d, stage: to };
  });
  if (dirty) doc.deals = deals;
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
  /* Membership orgs joined; legacy pre-org company strings render only as a
     read-only fallback and are never written anymore (preserve-on-edit). */
  const names = (Array.isArray(c.orgs) ? c.orgs : [])
    .map(id => (orgs || []).find(x => x && x.id === id))
    .filter(Boolean)
    .map(o => o.name);
  if (names.length) return names.join(' · ');
  return c.company || '';
}
