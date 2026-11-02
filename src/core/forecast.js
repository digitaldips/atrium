/* =====================================================================
   FORECAST · pure engine for the sales methodology
   Every function is data-in/data-out (no DOM, no store, no network, no
   wall clock — the month window is ALWAYS passed in as `now`) so the
   kans math, deal-type math, month bucketing and rollups run in plain
   node tests and anywhere in the app. Rendering lives in pages.

   Methodology (Wesley's table, see core/crm.js for the stage data):
     - 4 open categories: longshot 1%, mogelijk 25%, waarschijnlijk 50%,
       zeker 100%. 'zeker' deals STAY in the open pipeline at 100%.
     - Deal types: project ('Projectwaarde' = total) and retainer
       ('Bedrag per maand' × 'Looptijd (mnd)').
     - Expected value: project → value; retainer → monthly × months.
       deal.value ALWAYS stores the expected value (the form computes it).
     - Weighted value = expected × kans. The sum over open deals is the
       'Realistische pipeline'.
   ===================================================================== */

import { CRM_STAGES, CRM_STAGE, sanitizeDealValue } from './crm.js';
import { orgClients, orgDealsFor } from './orgs.js';

/* ---------- kans + openness ---------- */

/* The methodology kans of a stage; unknown stages carry 0 so corrupt
   data never inflates the forecast. */
export const stageKans = s => (CRM_STAGE[s] ? CRM_STAGE[s].kans : 0);

/* Open = everything not yet won and not lost (same rule as dealTotals:
   unknown stages count as open so a corrupt stage never hides money). */
export const isOpenDeal = d => !!d && typeof d === 'object' && d.stage !== 'won' && d.stage !== 'lost';

/* ---------- deal types: expected + weighted value ---------- */

/* Expected value of one deal. Project → the stored projectwaarde;
   retainer → bedrag per maand × looptijd, rounded (inputs are whole
   euros; Math.round guards float noise). Anything missing or junk → 0,
   never NaN. */
export function expectedValue(d) {
  const deal = d && typeof d === 'object' ? d : {};
  if (deal.type === 'retainer') {
    const monthly = Number(deal.monthly);
    const months = Math.floor(Number(deal.months));
    if (!Number.isFinite(monthly) || !Number.isFinite(months)) return 0;
    /* Floor months EXACTLY like the submit path (form line and stored value
       must agree), and clamp absurd products to 0 — Infinity would serialize
       to null in the doc. */
    if (monthly <= 0 || months < 1) return 0;
    const raw = monthly * months;
    return Number.isFinite(raw) ? Math.round(raw) : 0;
  }
  return sanitizeDealValue(deal.value);
}

/* Weighted value = expected × stage kans, rounded to whole euros so
   sums stay exact (0.01 of an odd amount would otherwise leave float
   dust in every bucket). */
export function weightedValue(d) {
  const deal = d && typeof d === 'object' ? d : {};
  return Math.round(expectedValue(deal) * stageKans(deal.stage));
}

/* 'Realistische pipeline': Σ weighted over the OPEN deals. */
export function realisticPipeline(deals) {
  return (Array.isArray(deals) ? deals : []).reduce((s, d) => s + (isOpenDeal(d) ? weightedValue(d) : 0), 0);
}

/* ---------- month windows ---------- */

/* Shared formatting: "Nov 2026" — one shape everywhere. */
const MONTH_FMT = new Intl.DateTimeFormat('en-IE', { month: 'short', year: 'numeric' });
const pad2 = n => String(n).padStart(2, '0');
const monthKeyOf = (y, m) => `${y}-${pad2(m + 1)}`; /* m is 0-based */

/* Parse any accepted `now` (Date | timestamp | 'YYYY-MM-DD') into the
   local { y, m } of its month. An unparseable now → null: callers then
   render an EMPTY month window instead of inventing dates. */
function windowOf(now) {
  let t;
  if (now instanceof Date) t = now;
  else if (typeof now === 'number') t = new Date(now);
  else t = new Date(`${String(now ?? '').slice(0, 10)}T00:00:00`);
  return Number.isFinite(t.getTime()) ? { y: t.getFullYear(), m: t.getMonth() } : null;
}

/* The deal's close month key ('YYYY-MM'), '' when there is no usable
   close value (absent, non-string, or not even date-shaped). */
const closeKeyOf = d => {
  const s = d && typeof d === 'object' ? String(d.close ?? '') : '';
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
};

/* ---------- forecast by month (AC3) ---------- */

/* Bucket OPEN deals by close month over the window [now, now + months).
   Returns { months, unscheduled, outside }:
     - months[]   ascending, each { key, label, count, expected, weighted }
     - unscheduled: open deals with NO close month (count/expected/weighted)
     - outside:     open deals DATED outside the window (past or beyond) —
       kept visible so the table always reconciles with the headline.
   A retainer counts its full expected value in its close month (the math
   stays simple and consistent — monthly spreading is out of scope). */
export function forecastByMonth(deals, months, now) {
  const list = Array.isArray(deals) ? deals : [];
  const n = Math.max(0, Math.floor(Number(months)) || 0);
  const win = windowOf(now);
  const out = [];
  const byKey = new Map();
  if (win) {
    for (let i = 0; i < n; i++) {
      const d = new Date(win.y, win.m + i, 1);
      const bucket = { key: monthKeyOf(d.getFullYear(), d.getMonth()), label: MONTH_FMT.format(d), count: 0, expected: 0, weighted: 0 };
      out.push(bucket);
      byKey.set(bucket.key, bucket);
    }
  }
  const unscheduled = { count: 0, expected: 0, weighted: 0 };
  const outside = { count: 0, expected: 0, weighted: 0 };
  for (const d of list) {
    if (!isOpenDeal(d)) continue;
    const expected = expectedValue(d);
    const weighted = weightedValue(d);
    const key = closeKeyOf(d);
    const target = (key && byKey.get(key)) || (key ? outside : unscheduled);
    target.count += 1;
    target.expected += expected;
    target.weighted += weighted;
  }
  return { months: out, unscheduled, outside };
}

/* ---------- won history (AC3) ---------- */

/* 'Gewonnen' deals by wonAt month over the window (now - months, now].
   Ascending, oldest first: [{ key, label, count, value }]. Deals without
   a wonAt stamp (legacy rows) are never placed; non-won stages never
   count even if a stale wonAt is present. */
export function wonByMonth(deals, months, now) {
  const list = Array.isArray(deals) ? deals : [];
  const n = Math.max(0, Math.floor(Number(months)) || 0);
  const win = windowOf(now);
  const out = [];
  const byKey = new Map();
  if (win) {
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(win.y, win.m - i, 1);
      const bucket = { key: monthKeyOf(d.getFullYear(), d.getMonth()), label: MONTH_FMT.format(d), count: 0, value: 0 };
      out.push(bucket);
      byKey.set(bucket.key, bucket);
    }
  }
  for (const d of list) {
    if (!d || typeof d !== 'object' || d.stage !== 'won') continue;
    const at = Number(d.wonAt);
    if (!Number.isFinite(at)) continue;
    const w = new Date(at);
    const bucket = byKey.get(monthKeyOf(w.getFullYear(), w.getMonth()));
    if (!bucket) continue; /* won before the window */
    bucket.count += 1;
    bucket.value += expectedValue(d);
  }
  return out;
}

/* ---------- stage breakdown (AC3) ---------- */

/* One row per methodology stage in fixed order (4 categories + won +
   lost), each { id, name, kans, count, expected, weighted }. Deals with
   an unknown stage get an honest trailing 'Onbekend' row (kans 0) so the
   breakdown reconciles with the totals — absent when there are none. */
export function stageBreakdown(deals) {
  const list = Array.isArray(deals) ? deals : [];
  const out = CRM_STAGES.map(s => ({ id: s.id, name: s.name, kans: s.kans, count: 0, expected: 0, weighted: 0 }));
  const byId = new Map(out.map(r => [r.id, r]));
  let unknown = null;
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const row = byId.get(d.stage);
    const expected = expectedValue(d);
    const weighted = weightedValue(d);
    if (!row) {
      unknown = unknown || { id: 'unknown', name: 'Onbekend', kans: 0, count: 0, expected: 0, weighted: 0 };
      unknown.count += 1;
      unknown.expected += expected;
      unknown.weighted += weighted;
      continue;
    }
    row.count += 1;
    row.expected += expected;
    row.weighted += weighted;
  }
  return unknown ? [...out, unknown] : out;
}

/* ---------- per-organisation rollup (AC3) ---------- */

/* One row per organisation: open pipeline (direct + derived deals, same
   classification as the org detail page), contacts + open deal counts.
   Sorted by open weighted value descending, ties by name. Rows are
   fresh objects; junk org rows are dropped. */
export function orgRollup(orgs, deals, clients) {
  const orgList = (Array.isArray(orgs) ? orgs : []).filter(o => o && typeof o === 'object' && o.id);
  return orgList
    .map(o => {
      const rows = orgDealsFor(o.id, deals, clients).filter(r => isOpenDeal(r.deal));
      return {
        org: o,
        contacts: orgClients(o.id, clients).length,
        deals: rows.length,
        openExpected: rows.reduce((s, r) => s + expectedValue(r.deal), 0),
        openWeighted: rows.reduce((s, r) => s + weightedValue(r.deal), 0),
      };
    })
    .sort((a, b) => b.openWeighted - a.openWeighted || String(a.org.name || '').localeCompare(String(b.org.name || '')));
}

/* ---------- win rate (AC3) ---------- */

/* gewonnen / (gewonnen + verloren) as a 0..1 ratio; 0 when nothing has
   closed yet (no zero-division). */
export function winRate(deals) {
  let won = 0;
  let lost = 0;
  for (const d of Array.isArray(deals) ? deals : []) {
    if (!d || typeof d !== 'object') continue;
    if (d.stage === 'won') won += 1;
    else if (d.stage === 'lost') lost += 1;
  }
  const closed = won + lost;
  return { won, lost, rate: closed ? won / closed : 0 };
}
