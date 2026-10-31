/* ---------- store ---------- */
import { TODAY, diffD, iso, parse, uid } from './utils.js';
import { PCOLORS, TEAMS_SEED } from './constants.js';
import { seed } from '../data/seed.js';
import { ensureCrmData } from './crm.js';
import { ensureDocShape } from './links.js';
import { ensureNotes } from './notes.js';
import { sb, getCurrentUser, setCurrentUser } from './supabase.js';
import { ensureGooglePrefs } from '../../supabase/functions/_shared/google-pure.js';
import {
  applyUserIdentity,
  buildDocPayload,
  cachePayloadForUser,
  isAuthedSession,
  isTrustedCache,
  loadWorkspaceDoc,
  makeDebouncedSync,
  markSyncFailure,
  needsBootstrap,
  pushDocUpdate,
  upsertWorkspaceDoc,
  workspaceRowToDoc,
} from './workspace-api.js';

export const STORE_KEY = 'atrium.v1';
export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: '(GMT-07:00) Pacific Time',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: 'Tanjim Islam',
  title: 'Head of Product',
  calendarIds: ['primary'],
};
/* ---------- offline cache (localStorage) ---------- */
/* Invariant: the cache at STORE_KEY belongs to exactly one account — the
   uid stamped by save() from getCurrentUser(). It is trusted only when
   that uid matches the signed-in user (isTrustedCache); a cache from
   another account, or from before uid binding, is discarded at
   boot/login (bindCacheToUser) and never rendered or synced. */
export function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && j.data && j.data.tasks) return j;
    }
  } catch {
    /* storage blocked or corrupt: start from seed data */
  }
  return null;
}
export const saved = load();
export const S = {
  data: saved?.data || seed(),
  prefs: Object.assign({}, DEFAULT_PREFS, saved?.prefs || {}),
  views: saved?.views || {},
  ui: {
    fx: {},
    auth: null,
    authStep: 'login',
    onb: 0,
    onbData: { use: 'product', team: 'kanban', size: '2-10', ws: '', proj: 'Website Launch', tmpl: 'web', invites: '' },
    route: 'home',
    params: {},
    history: [],
    collapsed: !!saved?.collapsed,
    mnav: false,
    expanded: { p1: true },
    drawer: null,
    drawerFull: false,
    drawerTab: 'comments',
    modals: [],
    pop: null,
    palette: null,
    loading: false,
    offline: false,
    sel: new Set(),
    composer: null,
    editCell: null,
    openTasks: {},
    collapsedGroups: {},
    calDate: iso(TODAY),
    calMode: 'month',
    tlZoom: 'week',
    tlGroup: 'status',
    fileView: 'grid',
    projView: 'grid',
    homeTab: 'upcoming',
    inboxCat: 'all',
    inboxUnread: false,
    inboxSel: null,
    gselSet: new Set(),
    gview: 'mail',
    glabel: '',
    compose: { draftId: null },
    notifFilter: 'all',
    settings: 'appearance',
    searchQ: '',
    searchCat: 'all',
    myView: 'list',
    membersTab: 'members',
    collapsedCols: {},
    errors: {},
    drafts: {},
  },
};
export let _saveT;
/* Sync status toasts are set from main.js so core/ stays dependency-free
   (core may not import ui/). */
let syncHandlers = {};
export function setSyncHandlers(h) {
  syncHandlers = { ...syncHandlers, ...h };
}
/* Write-through sync: the localStorage write stays the offline cache; when
   a session exists, the same {data,prefs,views} payload is debounced
   (500ms, separate timer) into public.workspaces by owner_id. Supabase is
   the source of truth, localStorage the cache. */
export const syncDoc = makeDebouncedSync(async () => {
  const wasOffline = S.ui.offline;
  const res = await pushDocUpdate(sb, getCurrentUser(), S, D().ws?.name);
  if (res === 'failed' && !wasOffline) syncHandlers.onError?.();
  else if (res === 'ok' && wasOffline) syncHandlers.onRecover?.();
}, 500);
export function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify(cachePayloadForUser(getCurrentUser(), { data: S.data, prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed })),
      );
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  }, 150);
  syncDoc.schedule();
}

/* ---------- cache-uid binding ---------- */
/* The cache S was initialised from at module load. bindCacheToUser is
   called once a real session user is known (boot and explicit login):
   the in-memory state is trusted only when the cache was written by that
   same user; otherwise S is reset to seed and the foreign cache dropped. */
export function bindCacheToUser(userId) {
  if (isTrustedCache(saved, userId)) {
    ensureCrmData(S.data);
    ensureDocShape(S.data); // links[] (CRM linkage) — zero-loss, same contract
    ensureNotes(S.data); // notes[] (Notes module) — zero-loss, same contract
    ensureGooglePrefs(S.prefs);
    return true;
  }
  S.data = seed();
  S.views = {};
  S.prefs = { ...DEFAULT_PREFS };
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage blocked */
  }
  return false;
}
/* Flush the pending debounced sync right now (pagehide/tab-close). With a
   signed-in user it pushes the latest doc (best effort — the fetch is
   fired, not awaited); without one the timer is dropped cleanly. */
export function flushPendingSync() {
  if (!getCurrentUser()) {
    syncDoc.cancel();
    return;
  }
  syncDoc.flush();
}

/* ---------- server hydration (session -> workspace doc) ---------- */
/* Load the owner's workspace document from Postgres. Missing row:
   bootstrap from seed (with the account's real identity) and upsert
   immediately. Unreachable server: keep the localStorage cache and flag
   offline. Returns 'loaded' | 'bootstrapped' | 'offline' | 'local'. */
let lastHydrateError = null;
export const lastSyncError = () => lastHydrateError;
export async function hydrateWorkspace(session) {
  if (!sb || !isAuthedSession(session)) return 'local';
  setCurrentUser(session.user.id);
  try {
    const row = await loadWorkspaceDoc(sb, session.user.id);
    if (needsBootstrap(row)) {
      S.data = seed();
      S.views = {};
      S.prefs = { ...DEFAULT_PREFS };
      applyUserIdentity(S, session.user);
      ensureCrmData(S.data);
      ensureDocShape(S.data);
      ensureNotes(S.data);
      ensureGooglePrefs(S.prefs);
      await upsertWorkspaceDoc(sb, session.user.id, buildDocPayload(S.data, S.prefs, S.views), D().ws?.name);
      save();
      return 'bootstrapped';
    }
    const doc = workspaceRowToDoc(row);
    S.data = doc.data;
    S.prefs = Object.assign({}, DEFAULT_PREFS, doc.prefs || {});
    S.views = doc.views || {};
    /* CRM migration: docs created before the CRM feature lack clients/deals.
       ensureCrmData only fills missing arrays — existing content is untouched
       (zero-loss), and save() below persists the initialized doc. Same
       pattern for prefs.calendarIds (multi-calendar feature), links[]
       (CRM linkage: mail/event/task rows) and notes[] (Notes module). */
    ensureCrmData(S.data);
    ensureDocShape(S.data);
    ensureNotes(S.data);
    ensureGooglePrefs(S.prefs);
    save();
    return 'loaded';
  } catch (err) {
    lastHydrateError = markSyncFailure(S, err);
    return 'offline';
  }
}

/* ---------- session -> workspace, shared by boot and explicit login ---------- */
/* Binds the localStorage cache to this user, then loads (or bootstraps)
   the server doc. Returns 'app' when the user may enter, or 'login' when
   we fail closed: the server was unreachable AND there is no trusted
   same-uid cache, so there is nothing of the user's own to work on —
   entering on seed data would let ~30 write paths build a doc that the
   debounced sync would later push over their real server document. */
export async function startWorkspace(session) {
  if (!sb || !isAuthedSession(session)) return 'login';
  const trusted = bindCacheToUser(session.user.id);
  const outcome = await hydrateWorkspace(session);
  if (outcome !== 'offline') return 'app';
  if (trusted) return 'app'; /* the cache is this user's own doc: enter offline */
  /* Fail closed: stay on the login screen with an honest error. */
  syncDoc.cancel();
  setCurrentUser(null);
  S.ui.offline = false;
  S.data = seed();
  S.views = {};
  S.prefs = { ...DEFAULT_PREFS };
  return 'login';
}

/* ---------- lookups ---------- */
export const D = () => S.data;
export const me = () => D().members.find(m => m.id === D().me);
export const mem = id => D().members.find(m => m.id === id);
export const proj = id => D().projects.find(p => p.id === id);
export const task = id => D().tasks.find(t => t.id === id);
export const pColor = p => PCOLORS[p?.color] || PCOLORS.slate;
export const visibleProjects = () =>
  D()
    .projOrder.map(proj)
    .filter(Boolean)
    .filter(p => !p.archived);
export const canSee = p => !p.private || p.members.includes(D().me);
export const tasksOf = pid => D().tasks.filter(t => t.project === pid && !t.archived);
export const allTasks = () => D().tasks.filter(t => !t.archived && canSee(proj(t.project)));
export const isOver = t => t.due && t.status !== 'done' && diffD(parse(t.due), TODAY) < 0;
export const commentsOf = tid => D().comments.filter(c => c.task === tid);
/* ---------- CRM lookups (arrays exist after ensureCrmData; || [] is belt-and-braces) ---------- */
export const crmClients = () => D().clients || [];
export const crmDeals = () => D().deals || [];
export const crmLinks = () => D().links || [];
export const noteById = id => (D().notes || []).find(n => n && n.id === id);
export const client = id => crmClients().find(c => c.id === id);
export const deal = id => crmDeals().find(d => d.id === id);
export function progressOf(pid) {
  const ts = tasksOf(pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}
export function taskProg(t) {
  if (t.status === 'done') return 100;
  if (t.subtasks.length) return Math.round((t.subtasks.filter(s => s.done).length / t.subtasks.length) * 100);
  return { backlog: 0, todo: 5, progress: 45, review: 80 }[t.status] || 0;
}

/* ---------- activity + notification helpers ---------- */
export function logAct(verb, t, extra = '') {
  D().activity.unshift({ id: uid('a'), by: D().me, verb, task: t?.id || null, project: t?.project || null, at: Date.now(), extra });
  if (t) t.updated = Date.now();
}

/* ---------- teams (workspace data, seeded on first use) ---------- */
export const NO_TEAM = { id: '', name: 'No team', icon: 'users', c: '#8A867E', desc: '' };
export function teamsList() {
  const d = D();
  if (!d.teams) d.teams = TEAMS_SEED.map(t => ({ ...t }));
  return d.teams;
}
export function team(id) {
  return teamsList().find(t => t.id === id) || null;
}
export const TM = new Proxy({}, { get: (_, k) => team(k) || NO_TEAM });
