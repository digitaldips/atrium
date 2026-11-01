/* =====================================================================
   ORGS · pure data layer for organisations (workspace-doc side)
   Every function is data-in/data-out (no DOM, no store, no network) so
   the initializer, domain matcher, rollups and cascade-unlink run in
   plain node tests and anywhere in the app. Rendering and mutations
   live in pages/actions.

   Org rows live INSIDE the workspace document (doc.orgs, same model as
   clients/deals/notes/links — no new Postgres tables). One row:
     { id, name, domain, industry, notes, created }
   domain is the auto-suggest key: a client whose email domain EQUALS an
   org's domain (after normalization, case-insensitive, exact — no
   subdomain/partial games) may be suggested for attachment. Suggestions
   are SUGGEST + one-click confirm, never silent.

   clients[] / deals[] / notes[] gain an OPTIONAL `org` field (org id or
   null; absent means unattached). This module never adds that field on
   its own — only user actions do — so existing rows are never rewritten.
   Deleting an organisation only UNLINKS (org=null); items are never
   deleted by the cascade.
   ===================================================================== */

import { dealTotals } from './crm.js';

/* ---------- zero-loss doc initializer ---------- */
/* Same contract as ensureCrmData/ensureDocShape/ensureNotes: the workspace
   document predating Organisations has no orgs[]. This initializer runs on
   hydrate AND bootstrap AND the trusted-cache bind. Rows come from the
   server document, so every row passes through makeOrg — the hydration
   trust boundary: corrupt field values are coerced honestly, junk
   non-object rows are dropped and the domain is normalized. Well-formed
   rows are kept BY REFERENCE and byte-identical (zero-loss: only genuine
   repairs change bytes), which also keeps the pass idempotent. */
export function ensureOrgsData(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.orgs)) {
    doc.orgs = [];
    return doc;
  }
  let dirty = false;
  const rows = doc.orgs.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      dirty = true;
      return null; /* a junk row cannot be repaired — drop it, don't crash the page */
    }
    /* Spread order keeps the row's own key order and any extra fields;
       makeOrg only overrides the six known fields. */
    const fixed = { ...row, ...makeOrg(row) };
    if (JSON.stringify(fixed) !== JSON.stringify(row)) {
      dirty = true;
      return fixed;
    }
    return row;
  });
  if (!dirty) return doc;
  doc.orgs = rows.filter(Boolean);
  return doc;
}

/* ---------- row factory ---------- */
/* Normalizes one org row; null when the input is not an object. The
   caller supplies the id for new orgs; a rehydrated org keeps its own. */
export function makeOrg(input) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!o) return null;
  const created = Number(o.created);
  return {
    id: typeof o.id === 'string' ? o.id : '',
    name: typeof o.name === 'string' ? o.name : String(o.name ?? ''),
    domain: normalizeDomain(o.domain),
    industry: typeof o.industry === 'string' ? o.industry : String(o.industry ?? ''),
    notes: typeof o.notes === 'string' ? o.notes : String(o.notes ?? ''),
    created: Number.isFinite(created) ? created : 0,
  };
}

/* ---------- domain normalization + exact matcher (AC4) ---------- */
/* One canonical shape for the auto-suggest key: protocol, credentials,
   port, path, query, hash, leading @ and www. are stripped, case and
   whitespace folded. Matching afterwards is plain string equality —
   'mail.example.com' is NOT 'example.com' and never will be. */
export function normalizeDomain(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); /* protocol */
  s = s.replace(/^@+/, ''); /* mailto-style paste */
  s = s.split(/[/?#]/)[0]; /* path / query / hash */
  s = s.split('@').pop(); /* leftover credentials (user@host) */
  s = s.split(':')[0]; /* port */
  if (s.startsWith('www.')) s = s.slice(4);
  s = s.replace(/\.+$/, ''); /* trailing dot (FQDN paste) */
  return s;
}

/* The email's own domain, '' when the address carries none. Pure. */
export function emailDomainOf(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  if (at < 0) return '';
  return normalizeDomain(s.slice(at + 1));
}

/* The org whose domain EQUALS the email's domain — exact, case-insensitive
   after normalization. No fuzzy, no subdomain, no suffix matching: client
   emails are data the user typed; only a certain match may be suggested,
   and the suggestion is never applied silently (same contract as
   matchClientByEmail in links.js). */
export function matchOrgByDomain(orgs, email) {
  const dom = emailDomainOf(email);
  if (!dom) return null;
  return (
    (Array.isArray(orgs) ? orgs : []).find(o => {
      const d = normalizeDomain(o?.domain);
      return d && d === dom;
    }) || null
  );
}

/* The auto-suggest suggestion for one client: the matched org + the basis
   (the domain both sides share), or null when there is no exact match OR
   the client is already attached to an org (same org → nothing to suggest;
   a different org → the client/deal form is the honest place to move it).
   The UI renders this as a one-click confirm strip; nothing is stored
   until the user confirms. */
export function orgSuggestionFor(clientRow, orgs) {
  if (!clientRow || typeof clientRow !== 'object') return null;
  if (clientRow.org) return null;
  const org = matchOrgByDomain(orgs, clientRow.email);
  if (!org) return null;
  return {
    clientId: clientRow.id,
    client: clientRow,
    org,
    matchedDomain: normalizeDomain(org.domain),
  };
}

/* Suggestions for the whole client list (the Clients page strip). Pure:
   a new array of { clientId, client, org, matchedDomain }. */
export function orgSuggestionsForClients(clients, orgs) {
  return (Array.isArray(clients) ? clients : []).map(c => orgSuggestionFor(c, orgs)).filter(Boolean);
}

/* ---------- AC3: rollups (contacts / deals / notes / activity) ---------- */

/* Contacts of one org. Pure: filtered copy in input order. */
export function orgClients(orgId, clients) {
  return (Array.isArray(clients) ? clients : []).filter(c => c && typeof c === 'object' && c.org === orgId);
}

/* Deals of one org with the direct-vs-derived distinction:
   - direct  = deal.org === orgId (an org deal may have no contact at all)
   - derived = deal.org is absent/null AND deal.client is a client of the
     org (the deal implies the org via its contact)
   An explicit org ref ALWAYS wins: a deal marked with another org never
   appears here even when its client belongs to this org. Rows are
   { deal, derived } — never the deals themselves, so callers can mark
   derived rows visually. Pure. */
export function orgDealsFor(orgId, deals, clients) {
  const contactIds = new Set(orgClients(orgId, clients).map(c => c.id));
  const out = [];
  for (const d of Array.isArray(deals) ? deals : []) {
    if (!d || typeof d !== 'object') continue;
    if (d.org === orgId) out.push({ deal: d, derived: false });
    else if (!d.org && contactIds.has(d.client)) out.push({ deal: d, derived: true });
  }
  return out;
}

/* Notes attached to one org. Pure: filtered copy in input order. */
export function orgNotesFor(orgId, notes) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && typeof n === 'object' && n.org === orgId);
}

/* Activity rollup: mail + event links[] rows of the org's CONTACTS (the
   org itself has no inbox) — newest first, each row annotated with the
   owning client's name for the read-only view. Rows are shallow copies
   ({...l}), so the doc-side links[] array is never mutated. Task links
   are deliberately excluded here: they are work items, not activity. */
export function orgActivityFor(orgId, links, clients) {
  const byClient = new Map(orgClients(orgId, clients).map(c => [c.id, c]));
  return (Array.isArray(links) ? links : [])
    .filter(l => l && byClient.has(l.clientId) && (l.kind === 'mail' || l.kind === 'event'))
    .map(l => ({ ...l, clientName: byClient.get(l.clientId)?.name || '' }))
    .sort((a, b) => (Number(b.when) || 0) - (Number(a.when) || 0));
}

/* One row of the Organisations list: contacts count + open-pipeline value
   (direct + derived deals, same classification as the detail page) +
   industry. `ctx` = { clients, deals }. Pure. */
export function orgListRow(org, ctx) {
  const o = org && typeof org === 'object' ? org : {};
  const clients = ctx && Array.isArray(ctx.clients) ? ctx.clients : [];
  const deals = ctx && Array.isArray(ctx.deals) ? ctx.deals : [];
  const contacts = orgClients(o.id, clients);
  const dealRows = orgDealsFor(o.id, deals, clients);
  const t = dealTotals(dealRows.map(r => r.deal));
  return { org: o, contacts: contacts.length, openValue: t.openValue, openCount: t.openCount, industry: typeof o.industry === 'string' ? o.industry : '' };
}

/* ---------- AC1: cascade-unlink (delete an org = unlink only) ---------- */
/* Clearing the org reference on every client/deal/note that pointed at
   it. NOTHING is deleted: the items stay in their arrays with org=null
   (absent and null mean the same: unattached). The org row itself is
   removed by the caller (A.removeOrg). Mutates in place — callers wrap
   it in mutate(); the toast confirm copy must state that items are
   never deleted. Returns the unlink counts for that copy. */
export function orgCascadeUnlink(doc, orgId) {
  const counts = { clients: 0, deals: 0, notes: 0 };
  if (!doc || typeof doc !== 'object' || !orgId) return counts;
  for (const c of Array.isArray(doc.clients) ? doc.clients : []) {
    if (c && typeof c === 'object' && c.org === orgId) {
      c.org = null;
      counts.clients++;
    }
  }
  for (const d of Array.isArray(doc.deals) ? doc.deals : []) {
    if (d && typeof d === 'object' && d.org === orgId) {
      d.org = null;
      counts.deals++;
    }
  }
  for (const n of Array.isArray(doc.notes) ? doc.notes : []) {
    if (n && typeof n === 'object' && n.org === orgId) {
      n.org = null;
      counts.notes++;
    }
  }
  return counts;
}
