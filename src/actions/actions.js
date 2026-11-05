/* =====================================================================
   ACTIONS · INPUT HANDLERS · DRAG & DROP · KEYBOARD · INIT
   ===================================================================== */
import { $, $$, TODAY, addD, dOff, esc, fmtDate, iso, parse, uid } from '../core/utils.js';
import { PR, PSTAT, ST } from '../core/constants.js';
import { seed } from '../data/seed.js';
import {
  D,
  DEFAULT_PREFS,
  S,
  STORE_KEY,
  allTasks,
  canSee,
  client,
  commentsOf,
  logAct,
  me,
  mem,
  proj,
  save,
  syncDoc,
  task,
  tasksOf,
  visibleProjects,
} from '../core/store.js';
import { makeLinkRow, upsertLink, descToText } from '../core/links.js';
import { sb, getCurrentUser, setCurrentUser } from '../core/supabase.js';
import {
  buildDocPayload,
  errMessage,
  findAuthUserId,
  markSyncFailure,
  pushDocUpdate,
  signInWithGoogle,
  signOutUser,
  upsertWorkspaceDoc,
} from '../core/workspace-api.js';
import { makeInviteEntry, splitInviteEmails, upgradeLegacyMember } from '../core/team.js';
import { fileType, fsize } from '../ui/helpers.js';
import { effectiveDark } from '../core/theme.js';
import { mutate, toast } from '../ui/toast.js';
import { autosize, focusKey, fxSet, go, render } from '../shell/render.js';
import { viewOf } from '../shell/view-engine.js';
import { TEMPLATES, closeModal, openModal } from '../overlays/modals.js';
import { closePop, openPop, tgt } from '../overlays/popovers.js';
import { strengthMeter } from '../pages/settings.js';

export const A = {},
  IN = {},
  KEY = {},
  DBL = {},
  BLUR = {};

/* ---------- task mutations ---------- */
export function nextKey(p) {
  p.seq = (p.seq || 200) + 1;
  return p.key + '-' + p.seq;
}
export function createTask(f) {
  const p = proj(f.project) || visibleProjects().find(canSee);
  if (!p) return null;
  const maxO = Math.max(0, ...D().tasks.map(t => t.order));
  const t = Object.assign(
    {
      project: p.id,
      title: 'Untitled',
      status: 'todo',
      assignee: null,
      priority: 'none',
      due: null,
      start: null,
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      estimate: null,
      created: Date.now(),
      updated: Date.now(),
      order: maxO + 1,
      fav: false,
      recur: null,
    },
    f,
    { project: p.id },
  );
  t.id = f.id || uid('t');
  t.key = f.key || nextKey(p);
  D().tasks.push(t);
  fxSet({ added: t.id });
  logAct('created', t);
  return t;
}
export const RECUR_DAYS = { Daily: 1, Weekly: 7, 'Every 2 weeks': 14, Monthly: 30 };
export function applyPatch(t, patch) {
  const msgs = [];
  for (const k of Object.keys(patch)) {
    const old = t[k],
      nv = patch[k];
    if (JSON.stringify(old) === JSON.stringify(nv)) continue;
    t[k] = nv;
    if (k === 'status') {
      if (nv === 'done') {
        t.completedAt = Date.now();
        t.prevStatus = old;
        logAct('completed', t);
        fxSet({ done: t.id });
      } else logAct('moved', t, `from ${ST[old].name} to ${ST[nv].name}`);
      if (nv === 'done' && t.recur && t.due) {
        const nd = iso(addD(parse(t.due), RECUR_DAYS[t.recur] || 7));
        const n = createTask({
          ...JSON.parse(JSON.stringify(t)),
          id: undefined,
          key: undefined,
          status: 'todo',
          due: nd,
          start: nd,
          subtasks: t.subtasks.map(s => ({ ...s, done: false })),
          completedAt: null,
          attachments: [],
        });
        delete n.prevStatus;
        msgs.push(`Next “${t.title}” scheduled for ${fmtDate(nd)}`);
      }
    } else if (k === 'assignee') logAct('assigned', t, nv ? `to ${mem(nv)?.name}` : '(unassigned)');
    else if (k === 'priority') logAct('changed priority of', t, `to ${PR[nv].name}`);
    else if (k === 'due') logAct('changed due date of', t, nv ? `to ${fmtDate(nv)}` : '(cleared)');
    else if (k === 'start') logAct('changed start date of', t, nv ? `to ${fmtDate(nv)}` : '(cleared)');
    else if (k === 'project') {
      const p = proj(nv);
      t.key = nextKey(p);
      logAct('moved', t, `to ${p.name}`);
    } else if (k === 'labels') logAct('updated labels on', t);
    else if (k === 'title') logAct('renamed', t, `to “${nv}”`);
    else if (k === 'recur') logAct('set repeat on', t, nv ? nv.toLowerCase() : 'off');
    else if (k === 'estimate') logAct('estimated', t, nv || 'none');
    else if (k === 'deps') logAct('updated dependencies of', t);
    t.updated = Date.now();
  }
  return msgs;
}
export function updateTask(id, patch) {
  if (id === '__form') {
    Object.assign(S.ui.form, patch);
    render();
    return;
  }
  const t = task(id);
  if (!t) return;
  let msgs = [];
  if (
    mutate(() => {
      msgs = applyPatch(t, patch);
    })
  )
    msgs.forEach(m => toast(m, { kind: 'info' }));
}
export function confirmDlg(o) {
  S.ui.confirmText = '';
  openModal({ type: 'confirm', ...o });
}
export function snapshot() {
  return JSON.stringify(S.data);
}
export function restore(snap) {
  S.data = JSON.parse(snap);
  save();
  render();
}
export async function copy(text, msg = 'Link copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast("Copy isn't available here — " + text, { kind: 'info', ms: 6000 });
  }
}
export function loadingBtn(id, ms, fn) {
  const b = document.getElementById(id);
  if (b) {
    b.classList.add('is-loading');
    b.setAttribute('aria-busy', 'true');
  }
  setTimeout(fn, ms);
}
export function curProjectId() {
  if (S.ui.route === 'project') return S.ui.params.id;
  return null;
}
export function projectFromKey(key) {
  if (!key) return null;
  if (key.startsWith('p:')) return key.slice(2);
  if (key.startsWith('sv:')) return D().savedViews.find(v => v.id === key.slice(3))?.project;
  return null;
}

/* ---------- navigation ---------- */
A.go = el => {
  const r = el.dataset.r;
  const p = {};
  if (el.dataset.id) p.id = el.dataset.id;
  if (el.dataset.tab) p.tab = el.dataset.tab;
  else if (r === 'project') p.tab = S.prefs.defaultTab || 'board';
  if (el.dataset.sec) p.sec = el.dataset.sec;
  S.ui.palette = null;
  const tabOnly = r === 'project' && S.ui.route === 'project' && S.ui.params.id === p.id;
  go(r, p, { tab: tabOnly });
};
A.back = () => {
  const h = S.ui.history.pop();
  if (h) go(h.route, h.params, { back: true });
  else go('home');
};
A.reload = () => render();
A.openProject = el => go('project', { id: el.dataset.id, tab: S.prefs.defaultTab || 'board' });
A.set = el => {
  const k = el.dataset.k;
  let v = el.dataset.v;
  if (/Tab$|Cat$|Mode$|View$/.test(k)) fxSet({ tabs: true });
  if (k === 'inboxSel' && !v) v = null;
  S.ui[k] = v;
  if (k === 'membersTab' || k === 'searchCat') S.ui.pop = null;
  render();
};
A.toggleSide = () => {
  S.ui.collapsed = !S.ui.collapsed;
  save();
  render();
};
A.openMnav = () => {
  S.ui.mnav = true;
  render();
};
A.closeMnav = () => {
  S.ui.mnav = false;
  render();
};
A.toggleExpand = el => {
  S.ui.expanded[el.dataset.id] = !S.ui.expanded[el.dataset.id];
  render();
};
A.goTasks = el => {
  const f = el.dataset.f;
  const v = viewOf('tasks');
  v.mode = 'list';
  v.filters =
    f === 'open'
      ? [{ f: 'status', op: 'not', v: ['done'] }]
      : f === 'done'
        ? [
            { f: 'status', op: 'is', v: ['done'] },
            { f: 'updated', op: 'is', v: ['7'] },
          ]
        : f === 'overdue'
          ? [{ f: 'due', op: 'is', v: ['overdue'] }]
          : [];
  go('tasks');
};
A.goFilteredList = el => {
  const v = viewOf('p:' + el.dataset.id);
  v.filters = [{ f: 'status', op: 'is', v: [el.dataset.st] }];
  v.group = 'status';
  go('project', { id: el.dataset.id, tab: 'list' }, { tab: true });
};

/* ---------- theme ---------- */
A.setTheme = el => {
  S.prefs.theme = el.dataset.v;
  save();
  render();
};
A.toggleDark = () => {
  S.prefs.theme = effectiveDark() ? 'light' : 'dark';
  save();
  S.ui.palette = null;
  render();
  toast(effectiveDark() ? 'Dark mode on' : 'Light mode on', { kind: 'info', ms: 1800 });
};
A.setPref = el => {
  S.prefs[el.dataset.k] = el.dataset.v;
  save();
  render();
};

/* ---------- popovers ---------- */
A.pop = el => {
  const d = el.dataset;
  /* Client-modal meeting rows close the modal first; capture the trigger
     rect pre-render so openPop still anchors to the row. */
  let rect;
  if (d.closemodal) {
    rect = el.getBoundingClientRect();
    closeModal();
  }
  const p = S.ui.pop;
  if (p && p.type === d.pop && p.id === d.id && p.key === d.key && p.i == (d.i != null ? +d.i : undefined) && p.field === d.field) {
    closePop();
    return;
  }
  openPop(el, rect ? { rect } : {});
};
A.ctxBtn = el => {
  const r = el.getBoundingClientRect();
  const d = el.dataset;
  const p = S.ui.pop;
  if (p && p.type === 'ctx' && p.id === d.id && p.ctx === d.ctx) {
    closePop();
    return;
  }
  S.ui.pop = { type: 'ctx', ctx: d.ctx, id: d.id, key: d.key, vid: d.vid, x: r.left, y: r.bottom + 4, top: r.top, w: r.width };
  render();
};
A.popPick = el => {
  const p = S.ui.pop;
  let v = el.dataset.v;
  if (p.type === 'subassignee' || (p.type === 'date' && p.field === 'subdue')) {
    const t = task(p.id);
    const sb = t?.subtasks[p.i];
    if (!sb) return;
    const k = p.type === 'subassignee' ? 'assignee' : 'due';
    v = v || null;
    S.ui.pop = null;
    mutate(() => {
      sb[k] = v;
      logAct(
        k === 'assignee' ? 'assigned a subtask on' : 'set a subtask due date on',
        t,
        k === 'assignee' ? (v ? `to ${mem(v).name}` : '(unassigned)') : v ? fmtDate(v) : '(cleared)',
      );
    });
    return;
  }
  if (p.type === 'pstatus') {
    const pr = proj(p.id);
    mutate(() => {
      pr.status = v;
      D().activity.unshift({
        id: uid('a'),
        by: D().me,
        verb: 'changed status of project',
        task: null,
        project: pr.id,
        at: Date.now(),
        extra: 'to ' + PSTAT[v].name,
      });
    });
    S.ui.pop = null;
    render();
    toast(`${pr.name} marked ${PSTAT[v].name}`);
    return;
  }
  if (p.type === 'role') {
    const m = mem(p.id);
    mutate(() => {
      m.role = v;
    });
    S.ui.pop = null;
    render();
    toast(`${m.name} is now ${v === 'Admin' ? 'an' : 'a'} ${v}`);
    return;
  }
  const field = { status: 'status', priority: 'priority', assignee: 'assignee', project: 'project', recur: 'recur', estimate: 'estimate', date: p.field }[
    p.type
  ];
  if (!field) return;
  if (field === 'assignee' && !v) v = null;
  if (field === 'recur' && v === 'Does not repeat') v = null;
  if ((field === 'estimate' || field === 'due' || field === 'start') && !v) v = null;
  S.ui.pop = null;
  const patch = { [field]: v };
  if (field === 'due' && v && p.id !== '__form') {
    const t = task(p.id);
    if (t.start && t.start > v) patch.start = v;
  }
  updateTask(p.id, patch);
};
A.popToggleLabel = el => {
  const p = S.ui.pop;
  const t = tgt(p);
  const v = el.dataset.v;
  const labels = t.labels.includes(v) ? t.labels.filter(x => x !== v) : [...t.labels, v];
  updateTask(p.id, { labels });
};
A.popToggleDep = el => {
  const p = S.ui.pop;
  const t = task(p.id);
  const v = el.dataset.v;
  updateTask(p.id, { deps: t.deps.includes(v) ? t.deps.filter(x => x !== v) : [...t.deps, v] });
};
A.popMonth = el => {
  const p = S.ui.pop;
  const m = parse(p.m);
  p.m = iso(new Date(m.getFullYear(), m.getMonth() + +el.dataset.d, 1));
  render();
};
IN.popQ = el => {
  if (S.ui.pop) {
    S.ui.pop.q = el.value;
    render();
  }
};
export const ctxTo = type => () => {
  S.ui.pop = { ...S.ui.pop, type, q: '' };
  if (type === 'date') S.ui.pop.m = iso(TODAY);
  render();
};
A.ctxStatus = ctxTo('status');
A.ctxAssign = ctxTo('assignee');
A.ctxPrio = ctxTo('priority');
A.ctxMove = ctxTo('project');
A.ctxRole = ctxTo('role');

/* ---------- tasks ---------- */
A.openTask = el => {
  const id = el.dataset.id;
  if (!task(id)) return;
  if (!canSee(proj(task(id).project))) {
    toast("You don't have access to that task", { kind: 'err' });
    return;
  }
  /* Capture the opener key BEFORE closeModal()'s render detaches el. */
  const opener = el.isConnected ? focusKey(el) : S.ui.drawerOpener;
  closeModal();
  if (!S.ui.drawer || !document.activeElement?.closest?.('.drawer')) S.ui.drawerOpener = opener;
  S.ui.drawer = id;
  S.ui.drawerFull = S.prefs.openTasks === 'full' || (S.ui.drawerFull && S.ui.drawer === id);
  S.ui.pop = null;
  S.ui.palette = null;
  S.ui.modals = [];
  S.ui.mention = null;
  S.ui.subOpen = null;
  S.ui.drawerTab = S.ui.drawerTab || 'comments';
  render();
  const dr = $('.drawer');
  if (dr && !dr.contains(document.activeElement)) dr.focus({ preventScroll: true });
};
A.closeDrawer = () => {
  S.ui.drawer = null;
  S.ui.drawerFull = false;
  S.ui.subOpen = null;
  render();
};
A.skipToContent = () => {
  const c = $('#main-content');
  c?.focus();
};
A.projUp = el => A._projMove(el, -1);
A.projDown = el => A._projMove(el, 1);
A._projMove = (el, d) => {
  const vis = visibleProjects().map(p => p.id);
  const i = vis.indexOf(el.dataset.id);
  const j = i + d;
  if (j < 0 || j >= vis.length) return;
  const o = D().projOrder;
  const a = o.indexOf(vis[i]),
    b = o.indexOf(vis[j]);
  [o[a], o[b]] = [o[b], o[a]];
  S.ui.pop = null;
  save();
  render();
  toast(`Moved ${proj(el.dataset.id).name} ${d < 0 ? 'up' : 'down'}`, { ms: 1600 });
};
A.toggleDrawerFull = () => {
  S.ui.drawerFull = !S.ui.drawerFull;
  render();
};
A.toggleDone = el => {
  const t = task(el.dataset.id);
  if (!t) return;
  const wasDone = t.status === 'done';
  S.ui.pop = null;
  updateTask(t.id, { status: wasDone ? (t.prevStatus && t.prevStatus !== 'done' ? t.prevStatus : 'todo') : 'done' });
  if (!wasDone && !S.ui.offline) toast(`Completed “${t.title}”`, { action: 'Undo', onAction: () => updateTask(t.id, { status: t.prevStatus || 'todo' }) });
};
A.toggleFavTask = el => {
  const t = task(el.dataset.id);
  mutate(() => {
    t.fav = !t.fav;
  });
  S.ui.pop = null;
  toast(t.fav ? 'Added to favorites' : 'Removed from favorites', { ms: 1800 });
  render();
};
A.toggleFavProj = el => {
  const p = proj(el.dataset.id);
  mutate(() => {
    p.fav = !p.fav;
  });
  S.ui.pop = null;
  render();
  toast(p.fav ? `Added ${p.name} to favorites` : 'Removed from favorites', { ms: 1800 });
};
A.copyLink = el => {
  S.ui.pop = null;
  render();
  const d = el.dataset;
  const path =
    d.id && task(d.id)
      ? `task/${task(d.id).key}`
      : d.pid
        ? `project/${proj(d.pid).key.toLowerCase()}`
        : d.fid
          ? `file/${d.fid}`
          : d.id && proj(d.id)
            ? `project/${proj(d.id).key.toLowerCase()}`
            : '';
  copy(`https://atrium.app/${D().ws.url}/${path}`);
};
A.copyText = el => copy(el.dataset.text, 'Copied to clipboard');
A.copyEmail = el => {
  S.ui.pop = null;
  render();
  copy(mem(el.dataset.id).email, 'Email copied');
};
A.dupTask = el => {
  const t = task(el.dataset.id);
  S.ui.pop = null;
  let n;
  mutate(() => {
    n = createTask({ ...JSON.parse(JSON.stringify(t)), id: uid('t'), key: undefined, title: t.title + ' (copy)', created: Date.now(), fav: false });
    n.key = nextKey(proj(n.project));
  });
  toast('Task duplicated', { action: 'Open', onAction: () => A.openTask({ dataset: { id: n.id } }) });
};
A.archiveTask = el => {
  const t = task(el.dataset.id);
  const snap = snapshot();
  S.ui.pop = null;
  if (S.ui.drawer === t.id) S.ui.drawer = null;
  mutate(() => {
    t.archived = true;
    t.archivedAt = Date.now();
    logAct('archived', t);
  });
  toast(`Archived “${t.title}”`, { action: 'Undo', onAction: () => restore(snap) });
};
export function deleteTasks(ids) {
  const set = new Set(ids);
  D().tasks = D().tasks.filter(t => !set.has(t.id));
  D().tasks.forEach(t => (t.deps = t.deps.filter(d => !set.has(d))));
  D().comments = D().comments.filter(c => !set.has(c.task));
  if (set.has(S.ui.drawer)) S.ui.drawer = null;
  ids.forEach(i => S.ui.sel.delete(i));
}
A.delTask = el => {
  const t = task(el.dataset.id);
  S.ui.pop = null;
  if (!t) return;
  const run = () => {
    const snap = snapshot();
    if (mutate(() => deleteTasks([t.id]))) toast(`Deleted “${t.title}”`, { action: 'Undo', onAction: () => restore(snap) });
  };
  if (S.prefs.confirmDel === false && !el.dataset.demo) return run();
  confirmDlg({
    title: 'Delete task?',
    body: `<b>${esc(t.title)}</b>${t.subtasks.length ? `, its ${t.subtasks.length} subtasks,` : ''} and ${commentsOf(t.id).length} comment${commentsOf(t.id).length === 1 ? '' : 's'} will be permanently deleted.`,
    ok: 'Delete task',
    danger: true,
    run,
  });
};
A.editTask = el => {
  const t = task(el.dataset.id);
  if (!t) return;
  S.ui.form = {
    title: t.title,
    desc: descToText(t.desc || ''),
    project: t.project,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    due: t.due,
    start: t.start,
    labels: [...t.labels],
    subtasks: t.subtasks.map(s => ({ ...s })),
    files: [],
    recur: t.recur,
    more: false,
  };
  S.ui.errors = {};
  openModal({ type: 'task', edit: t.id });
};
A.newTask = el => {
  const d = el?.dataset || {};
  const pid =
    d.project ||
    curProjectId() ||
    projectFromKey(S.ui.composer?.ctx) ||
    (S.ui.drawer && task(S.ui.drawer)?.project) ||
    visibleProjects().find(p => canSee(p) && p.status !== 'complete')?.id;
  const p = proj(pid);
  S.ui.form = {
    title: '',
    desc: '',
    project: p && canSee(p) ? pid : '',
    status: 'todo',
    assignee: d.assignee || D().me,
    priority: 'medium',
    due: d.due || null,
    start: null,
    labels: [],
    subtasks: [],
    files: [],
    recur: null,
    more: S.ui.form?.more || false,
  };
  S.ui.errors = {};
  openModal({ type: 'task' });
};
IN.form = el => {
  S.ui.form[el.dataset.f] = el.value;
  if (el.dataset.f === 'title' && S.ui.errors.title && el.value.trim()) {
    S.ui.errors.title = null;
    render();
  }
};
IN.formMore = el => {
  S.ui.form.more = el.checked;
};
IN.formFiles = el => {
  [...el.files].forEach(f => S.ui.form.files.push({ name: f.name, size: fsize(f.size), type: fileType(f.name) }));
  render();
};
KEY.formAddSub = el => {
  const v = el.value.trim();
  if (!v) return;
  S.ui.form.subtasks.push({ id: uid('s'), title: v, done: false });
  render();
  setTimeout(() => $('#f-sub')?.focus(), 0);
};
A.formRmSub = el => {
  S.ui.form.subtasks.splice(+el.dataset.i, 1);
  render();
};
A.formRmFile = el => {
  S.ui.form.files.splice(+el.dataset.i, 1);
  render();
};
A.submitTask = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.form;
  const title = ($('#f-title')?.value ?? f.title).trim();
  f.title = title;
  f.desc = $('#f-desc')?.value ?? f.desc;
  if (!title) {
    S.ui.errors.title = 'Give the task a name';
    render();
    $('#f-title')?.focus();
    return;
  }
  if (!proj(f.project)) {
    S.ui.errors.project = 'Create a project first — tasks live in projects';
    render();
    return;
  }
  S.ui.errors = {};
  const files = f.files.map(x => ({ id: uid('a'), name: x.name, type: x.type, size: x.size, by: D().me, at: Date.now() }));
  const base = {
    title,
    project: f.project,
    status: f.status,
    assignee: f.assignee,
    priority: f.priority,
    due: f.due,
    start: f.start && f.due && f.start > f.due ? f.due : f.start,
    labels: f.labels,
    recur: f.recur,
    subtasks: f.subtasks,
  };
  if (m.edit) {
    const t = task(m.edit);
    if (
      !mutate(() => {
        applyPatch(t, base);
        if (f.desc !== descToText(t.desc || '')) t.desc = f.desc ? `<p>${esc(f.desc)}</p>` : '';
        t.attachments.push(...files);
      })
    )
      return;
    S.ui.modals.pop();
    render();
    toast('Changes saved');
    return;
  }
  let t;
  if (
    !mutate(() => {
      t = createTask({ ...base, desc: f.desc ? `<p>${esc(f.desc)}</p>` : '', attachments: files });
      files.forEach(x => D().files.unshift({ ...x, project: t.project, task: t.id }));
      /* AC4 bridge: a task created from a Gmail message stores the
         denormalized convenience ref (task.gmail = { id, webLink, subject })
         and — when the message is/was linked to a client — the task's
         links[] row. The links[] row is the source of truth. */
      if (f.gmail && f.gmail.id) t.gmail = { id: f.gmail.id, webLink: f.gmail.webLink || '', subject: f.gmail.subject || '' };
      if (f.linkClient && client(f.linkClient)) {
        D().links = upsertLink(
          D().links,
          makeLinkRow({ id: uid('lk'), clientId: f.linkClient, kind: 'task', ref: t.id, title: t.title, when: Date.now(), snippet: '' }),
        );
      }
    })
  )
    return;
  if (f.more) {
    Object.assign(f, { title: '', desc: '', subtasks: [], files: [], gmail: null, linkClient: null });
    render();
    setTimeout(() => $('#f-title')?.focus(), 0);
    toast(`Created ${t.key}`, { ms: 2000 });
    return;
  }
  S.ui.modals.pop();
  fxSet({ added: t.id });
  render();
  toast(`Created ${t.key} in ${proj(t.project).name}`, { action: 'Open', onAction: () => A.openTask({ dataset: { id: t.id } }) });
};

/* inline composer */
A.startComposer = el => {
  S.ui.composer = { ctx: el.dataset.ctx, group: el.dataset.group, gb: JSON.parse(el.dataset.gb || '{}') };
  S.ui.pop = null;
  render();
  setTimeout(() => $('#composer-in')?.focus(), 0);
};
A.cancelComposer = () => {
  S.ui.composer = null;
  render();
};
KEY.commitComposer = () => A.commitComposer();
A.commitComposer = () => {
  const c = S.ui.composer;
  const el = $('#composer-in');
  const v = el?.value.trim();
  if (!c) return;
  if (!v) {
    A.cancelComposer();
    return;
  }
  const f = { title: v, ...c.gb };
  f.project = f.project || projectFromKey(c.ctx) || curProjectId() || 'p1';
  if (c.ctx === 'mytasks') f.assignee = D().me;
  mutate(() => createTask(f));
  setTimeout(() => $('#composer-in')?.focus(), 0);
};
KEY.commitTitle = el => DBL._commitTitle(el);
DBL.editTitle = el => {
  const row = el.closest('[data-task-row]');
  if (!row) return;
  S.ui.drawer = null;
  S.ui.editCell = { id: row.dataset.taskRow, f: 'title' };
  render();
  const i = $('#edit-title');
  if (i) {
    i.focus();
    i.select();
  }
};
DBL._commitTitle = el => {
  const c = S.ui.editCell;
  if (!c) return;
  S.ui.editCell = null;
  const v = el.value.trim();
  if (v && v !== task(c.id).title) updateTask(c.id, { title: v });
  else render();
};
DBL.editCell = el => {
  S.ui.drawer = null;
  S.ui.editCell = { id: el.dataset.id || el.closest('[data-id]').dataset.id, f: el.dataset.f };
  render();
  const i = $('#edit-cell');
  if (i) {
    i.focus();
    i.select();
  }
};
A.editCell = el => DBL.editCell(el);
KEY.commitCell = el => {
  const c = S.ui.editCell;
  if (!c) return;
  S.ui.editCell = null;
  const v = el.value.trim();
  if (c.f === 'title' && !v) {
    render();
    return;
  }
  updateTask(c.id, { [c.f]: v || null });
};
BLUR.commitCell = el => KEY.commitCell(el);
BLUR.commitTitle = el => DBL._commitTitle(el);
BLUR.commitDrawerTitle = el => {
  const t = task(el.dataset.id);
  const v = el.value.trim();
  if (t && v && v !== t.title) updateTask(t.id, { title: v });
};
KEY.blur = el => el.blur();

/* subtasks */
A.toggleSub = el => {
  const t = task(el.dataset.id);
  const s = t.subtasks.find(x => x.id === el.dataset.sid);
  if (!s.done) fxSet({ done: s.id });
  mutate(() => {
    s.done = !s.done;
    logAct(s.done ? 'completed subtask on' : 'reopened subtask on', t, `“${s.title}”`);
  });
};
A.rmSub = el => {
  const t = task(el.dataset.id);
  mutate(() => {
    t.subtasks = t.subtasks.filter(x => x.id !== el.dataset.sid);
  });
};
KEY.addSub = el => {
  const t = task(el.dataset.id);
  const v = el.value.trim();
  if (!v) return;
  const nid = uid('s');
  fxSet({ added: nid });
  mutate(() => {
    t.subtasks.push({ id: nid, title: v, done: false });
    logAct('added subtask to', t, `“${v}”`);
  });
  setTimeout(() => $('#d-sub')?.focus(), 0);
};
A.expandRow = el => {
  S.ui.openTasks[el.dataset.id] = !S.ui.openTasks[el.dataset.id];
  render();
};

/* attachments */
A.rmAttach = el => {
  const t = task(el.dataset.id);
  const f = t.attachments.find(a => a.id === el.dataset.aid);
  mutate(() => {
    t.attachments = t.attachments.filter(a => a.id !== el.dataset.aid);
    logAct('removed a file from', t);
  });
  toast(`Removed ${f.name}`);
};
A.filePreview = el => {
  const t = task(el.dataset.tid);
  const f = t.attachments.find(a => a.id === el.dataset.aid);
  openModal({ type: 'filePreview', file: f, tid: t.id });
};
A.previewFile = el => {
  const f = D().files.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  if (f) openModal({ type: 'filePreview', file: f, tid: f.task });
};
export function handleFiles(files, ctx) {
  if (!files || !files.length) return;
  if (S.ui.offline) {
    toast("Upload failed — you're offline.", { kind: 'err', action: 'Try again', onAction: () => {} });
    return;
  }
  S.ui.uploads = S.ui.uploads || [];
  [...files].forEach(file => {
    const up = { id: uid('u'), name: file.name, size: fsize(file.size), project: ctx.project, task: ctx.task, pct: 0 };
    S.ui.uploads.push(up);
    const iv = setInterval(() => {
      up.pct = Math.min(100, up.pct + 9 + Math.round(Math.random() * 22));
      const bar = document.getElementById('upbar-' + up.id),
        pc = document.getElementById('upct-' + up.id);
      if (bar) bar.style.setProperty('--p', up.pct / 100);
      if (pc) pc.textContent = up.pct + '%';
      if (up.pct >= 100) {
        clearInterval(iv);
        S.ui.uploads = S.ui.uploads.filter(x => x !== up);
        const rec = { id: uid('f'), name: up.name, type: fileType(up.name), size: up.size, by: D().me, at: Date.now() };
        D().files.unshift({ ...rec, project: up.project, task: up.task || null });
        if (up.task) {
          const t = task(up.task);
          t.attachments.push(rec);
          logAct('added a file to', t, up.name);
        }
        save();
        render();
        toast(`Uploaded ${up.name}`);
      }
    }, 220);
  });
  render();
}
IN.uploadFiles = el => {
  handleFiles(el.files, { project: el.dataset.project, task: el.dataset.task });
  el.value = '';
};

/* comments */
IN.draft = el => {
  const id = el.dataset.id;
  S.ui.drafts[id] = el.value;
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(?:^|\s)@([A-Za-z]*)$/);
  const prev = JSON.stringify(S.ui.mention);
  S.ui.mention = m ? { tid: id, q: m[1] } : null;
  if (prev !== JSON.stringify(S.ui.mention)) render();
  if (el.dataset.autosize != null) autosize(el);
};
A.pickMention = el => {
  const id = el.dataset.id;
  const d = S.ui.drafts[id] || '';
  S.ui.drafts[id] = d.replace(/@([A-Za-z]*)$/, '@' + el.dataset.name + ' ');
  S.ui.mention = null;
  render();
  const ta = $('#d-cmt');
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
};
A.insertAt = el => {
  const id = el.dataset.id;
  const d = S.ui.drafts[id] || '';
  S.ui.drafts[id] = d + (d && !d.endsWith(' ') ? ' @' : '@');
  S.ui.mention = { tid: id, q: '' };
  render();
  const ta = $('#d-cmt');
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
};
KEY.postComment = el => A.postComment(el);
A.postComment = el => {
  const id = el.dataset.id;
  const txt = (S.ui.drafts[id] || '').trim();
  if (!txt) {
    $('#d-cmt, #inbox-reply')?.focus();
    return;
  }
  const t = task(id);
  if (
    mutate(() => {
      D().comments.push({ id: uid('c'), task: id, by: D().me, at: Date.now(), text: txt, re: {} });
      logAct('commented on', t);
      S.ui.drafts[id] = '';
      S.ui.mention = null;
      S.ui.drawerTab = 'comments';
    })
  ) {
    if (S.ui.route === 'inbox') toast('Reply posted');
  }
};
A.delComment = el => {
  const c = D().comments.find(x => x.id === el.dataset.id);
  const snap = snapshot();
  mutate(() => {
    D().comments = D().comments.filter(x => x !== c);
  });
  toast('Comment deleted', { action: 'Undo', onAction: () => restore(snap) });
};
A.react = el => {
  const c = D().comments.find(x => x.id === el.dataset.id);
  const e = el.dataset.e;
  S.ui.pop = null;
  mutate(() => {
    c.re = c.re || {};
    const l = c.re[e] || [];
    c.re[e] = l.includes(D().me) ? l.filter(x => x !== D().me) : [...l, D().me];
  });
};

/* rich text description */
document.addEventListener('mousedown', e => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  e.preventDefault();
  const [cmd, arg] = b.dataset.cmd.split(':');
  if (cmd === 'createLink') {
    const s = String(getSelection());
    if (/^https?:\/\//.test(s)) document.execCommand('createLink', false, s);
    else toast('Select a URL starting with https:// to turn it into a link', { kind: 'info' });
  } else document.execCommand(cmd, false, arg ? `<${arg}>` : null);
  const ed = $('#d-desc');
  if (ed) {
    const t = task(ed.dataset.rte);
    t.desc = ed.innerHTML;
    save();
  }
});
document.addEventListener('input', e => {
  const ed = e.target.closest?.('[data-rte]');
  if (!ed) return;
  const t = task(ed.dataset.rte);
  if (t) {
    t.desc = ed.innerHTML;
    t.updated = Date.now();
    save();
  }
});

/* selection & bulk */
A.selRow = el => {
  const id = el.dataset.id;
  S.ui.sel.has(id) ? S.ui.sel.delete(id) : S.ui.sel.add(id);
  render();
};
A.selAll = el => {
  const ids = $$('[data-task-row]', el.closest('.tlist')).map(r => r.dataset.taskRow);
  const all = ids.every(i => S.ui.sel.has(i));
  ids.forEach(i => (all ? S.ui.sel.delete(i) : S.ui.sel.add(i)));
  render();
};
A.clearSel = () => {
  S.ui.sel.clear();
  render();
};
A.bulkSet = el => {
  const f = el.dataset.f;
  let v = el.dataset.v || null;
  const ids = [...S.ui.sel];
  S.ui.pop = null;
  if (mutate(() => ids.forEach(id => applyPatch(task(id), { [f]: v })))) toast(`Updated ${ids.length} task${ids.length > 1 ? 's' : ''}`);
};
A.bulkDelete = () => {
  const ids = [...S.ui.sel];
  confirmDlg({
    title: `Delete ${ids.length} task${ids.length > 1 ? 's' : ''}?`,
    body: 'The selected tasks, their subtasks, and comments will be permanently deleted.',
    ok: `Delete ${ids.length} task${ids.length > 1 ? 's' : ''}`,
    danger: true,
    run: () => {
      const snap = snapshot();
      if (mutate(() => deleteTasks(ids))) toast(`Deleted ${ids.length} tasks`, { action: 'Undo', onAction: () => restore(snap) });
    },
  });
};

/* views: sort, group, filters, columns */
A.sortBy = el => {
  const v = viewOf(el.dataset.key);
  const f = el.dataset.f;
  if (S.ui.justResized) return;
  v.sort = v.sort.f === f ? { f, dir: -v.sort.dir } : { f, dir: 1 };
  save();
  render();
};
A.setSort = el => {
  const v = viewOf(el.dataset.key);
  v.sort = { f: el.dataset.v, dir: v.sort.dir || 1 };
  S.ui.pop = null;
  save();
  render();
};
A.setSortDir = el => {
  viewOf(el.dataset.key).sort.dir = +el.dataset.v;
  save();
  render();
};
A.setGroup = el => {
  viewOf(el.dataset.key).group = el.dataset.v;
  S.ui.pop = null;
  save();
  render();
};
A.toggleGroup = el => {
  const gk = el.dataset.gk;
  S.ui.collapsedGroups[gk] = el.getAttribute('aria-expanded') === 'true';
  render();
};
A.setViewMode = el => {
  viewOf(el.dataset.key).mode = el.dataset.v;
  save();
  render();
};
A.toggleCol2 = el => {
  const v = viewOf(el.dataset.key);
  const c = el.dataset.v;
  v.hidden = v.hidden.includes(c) ? v.hidden.filter(x => x !== c) : [...v.hidden, c];
  save();
  render();
};
A.resetCols = el => {
  viewOf(el.dataset.key).colW = {};
  S.ui.pop = null;
  save();
  render();
};
IN.viewQ = el => {
  viewOf(el.dataset.key).q = el.value;
  render();
};
A.addFilter = el => {
  const v = viewOf(el.dataset.key);
  v.filters.push({ f: el.dataset.f, op: 'is', v: [] });
  if (S.ui.pop?.type === 'filter') S.ui.pop.edit = v.filters.length - 1;
  else {
    const r = el.getBoundingClientRect();
    S.ui.pop = { type: 'filter', key: el.dataset.key, x: r.left, y: r.bottom + 4, edit: v.filters.length - 1 };
  }
  save();
  render();
};
A.fEdit = el => {
  const p = S.ui.pop;
  p.edit = p.edit === +el.dataset.i ? null : +el.dataset.i;
  render();
};
A.fToggleVal = el => {
  const f = viewOf(el.dataset.key).filters[+el.dataset.i];
  const x = el.dataset.v;
  f.v = f.v.includes(x) ? f.v.filter(y => y !== x) : [...f.v, x];
  save();
  render();
};
A.rmFilter = el => {
  const v = viewOf(el.dataset.key);
  v.filters.splice(+el.dataset.i, 1);
  if (S.ui.pop && S.ui.pop.type === 'fvals') S.ui.pop = null;
  if (S.ui.pop?.type === 'filter') S.ui.pop.edit = null;
  save();
  render();
};
A.clearFilters = el => {
  const v = viewOf(el.dataset.key);
  v.filters = [];
  v.q = '';
  S.ui.pop = null;
  save();
  render();
};
IN.fField = el => {
  const f = viewOf(el.dataset.key).filters[+el.dataset.i];
  f.f = el.value;
  f.v = [];
  S.ui.pop.edit = +el.dataset.i;
  save();
  render();
};
IN.fOp = el => {
  viewOf(el.dataset.key).filters[+el.dataset.i].op = el.value;
  save();
  render();
};
A.saveView = el => {
  const k = 'p:' + el.dataset.id;
  openModal({ type: 'saveView', pid: el.dataset.id, nf: viewOf(k).filters.length });
};
A.saveViewSubmit = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const name = $('#sv-name').value.trim() || 'Untitled view';
  const type = $('#sv-type').value;
  const sv = { id: uid('v'), project: m.pid, name, type, filters: JSON.parse(JSON.stringify(viewOf('p:' + m.pid).filters)) };
  D().savedViews.push(sv);
  save();
  S.ui.modals.pop();
  go('project', { id: m.pid, tab: 'v:' + sv.id }, { tab: true });
  toast(`Saved view “${name}”`);
};
A.renameView = el => {
  const v = D().savedViews.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  openModal({
    type: 'prompt',
    title: 'Rename view',
    label: 'View name',
    value: v.name,
    run: val => {
      if (val) {
        v.name = val;
        save();
      }
    },
  });
};
A.delView = el => {
  const v = D().savedViews.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  D().savedViews = D().savedViews.filter(x => x !== v);
  save();
  if (S.ui.params.tab === 'v:' + v.id) go('project', { id: v.project, tab: 'list' }, { tab: true });
  else render();
  toast(`Deleted view “${v.name}”`);
};

/* board column menu */
A.toggleCol = el => {
  delete S.ui.collapsedCols[el.dataset.ck];
  render();
};
A.colCollapse = el => {
  S.ui.collapsedCols[S.ui.pop.key + ':' + el.dataset.id] = true;
  S.ui.pop = null;
  render();
};
A.colAdd = el => {
  const key = S.ui.pop.key;
  const pid = projectFromKey(key);
  S.ui.pop = null;
  A.startComposer({ dataset: { ctx: key, group: el.dataset.id, gb: JSON.stringify({ status: el.dataset.id, ...(pid ? { project: pid } : {}) }) } });
};
export function colTasks(key, st) {
  const pid = projectFromKey(key);
  return (pid ? tasksOf(pid) : allTasks()).filter(t => t.status === st);
}
A.colDoneAll = el => {
  const ts = colTasks(S.ui.pop.key, el.dataset.id);
  S.ui.pop = null;
  if (!ts.length) {
    render();
    return;
  }
  const snap = snapshot();
  if (mutate(() => ts.forEach(t => applyPatch(t, { status: 'done' }))))
    toast(`Marked ${ts.length} tasks as done`, { action: 'Undo', onAction: () => restore(snap) });
};
A.colArchive = () => {
  const ts = colTasks(S.ui.pop.key, 'done');
  S.ui.pop = null;
  const snap = snapshot();
  if (
    mutate(() =>
      ts.forEach(t => {
        t.archived = true;
        t.archivedAt = Date.now();
      }),
    )
  )
    toast(`Archived ${ts.length} completed tasks`, { action: 'Undo', onAction: () => restore(snap) });
};
A.colSortPrio = el => {
  const ts = colTasks(S.ui.pop.key, el.dataset.id).sort((a, b) => PR[b.priority].w - PR[a.priority].w);
  const base = Math.min(...ts.map(t => t.order));
  S.ui.pop = null;
  mutate(() => ts.forEach((t, i) => (t.order = base + i * 0.001)));
};

/* calendar & timeline */
A.calNav = el => {
  const d = +el.dataset.d;
  const cur = parse(S.ui.calDate);
  S.ui.calDate = d === 0 ? iso(TODAY) : S.ui.calMode === 'month' ? iso(new Date(cur.getFullYear(), cur.getMonth() + d, 1)) : iso(addD(cur, d * 7));
  render();
};
A.tlToday = () => {
  const r = $('#tl-right');
  if (r) r.scrollTo({ left: Math.max(0, +$('.tl').dataset.tlToday - 160), behavior: 'smooth' });
};
IN.tlGroup = el => {
  S.ui.tlGroup = el.value;
  render();
};

/* projects */
IN.projQ = el => {
  S.ui.projQ = el.value;
  render();
};
IN.projStatus = el => {
  S.ui.projStatus = el.value;
  render();
};
IN.projSort = el => {
  S.ui.projSort = el.value;
  render();
};
A.clearProjFilters = () => {
  S.ui.projQ = '';
  S.ui.projStatus = 'all';
  render();
};
A.newProject = () => {
  S.ui.pform = { name: '', desc: '', icon: 'folder', color: 'indigo', team: me().team, lead: D().me, due: dOff(30), tmpl: 'blank' };
  S.ui.errors = {};
  S.ui.pop = null;
  openModal({ type: 'project' });
};
A.editProject = el => {
  const p = proj(el.dataset.id);
  S.ui.pop = null;
  S.ui.pform = { name: p.name, desc: p.desc, icon: p.icon, color: p.color, team: p.team, lead: p.lead, due: p.due, tmpl: 'blank' };
  S.ui.errors = {};
  openModal({ type: 'project', edit: p.id });
};
IN.pform = el => {
  S.ui.pform[el.dataset.f] = el.value;
  if (el.dataset.f === 'name' && S.ui.errors.pname && el.value.trim()) {
    S.ui.errors.pname = null;
    render();
  }
};
A.pformSet = el => {
  S.ui.pform[el.dataset.f] = el.dataset.v;
  if (el.dataset.f === 'tmpl') {
    const t = TEMPLATES.find(x => x.id === el.dataset.v);
    if (t && S.ui.pform.icon === 'folder') S.ui.pform.icon = t.icon === 'file' ? 'folder' : t.icon;
  }
  render();
};
export function makeKey(name) {
  let k = name
    .split(/\s+/)
    .map(w => w[0] || '')
    .join('')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
  if (k.length < 2)
    k =
      name
        .replace(/[^A-Za-z]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'PRJ';
  while (D().projects.some(p => p.key === k)) k += 'X';
  return k;
}
export function createProject(f, tmplId) {
  const p = {
    id: uid('p'),
    key: makeKey(f.name),
    name: f.name,
    icon: f.icon,
    color: f.color,
    status: 'planning',
    team: f.team,
    lead: f.lead,
    due: f.due || dOff(30),
    start: dOff(0),
    fav: false,
    members: [...new Set([D().me, f.lead])],
    desc: f.desc || 'No description yet.',
    milestones: [],
    last: 0,
  };
  D().projects.push(p);
  D().projOrder.unshift(p.id);
  D().activity.unshift({ id: uid('a'), by: D().me, verb: 'created project', task: null, project: p.id, at: Date.now(), extra: '' });
  const tm = TEMPLATES.find(t => t.id === tmplId);
  (tm?.tasks || []).forEach((title, i) =>
    createTask({
      project: p.id,
      title,
      status: i === 0 ? 'todo' : 'backlog',
      assignee: i === 0 ? D().me : null,
      priority: i === 0 ? 'high' : 'medium',
      due: dOff(5 + i * 5),
      start: dOff(i * 5),
    }),
  );
  return p;
}
A.submitProject = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.pform;
  f.name = ($('#p-name')?.value || '').trim();
  f.desc = $('#p-desc')?.value || '';
  if (!f.name) {
    S.ui.errors.pname = 'Give the project a name';
    render();
    $('#p-name')?.focus();
    return;
  }
  if (m.edit) {
    const p = proj(m.edit);
    if (
      mutate(() =>
        Object.assign(p, {
          name: f.name,
          desc: f.desc,
          icon: f.icon,
          color: f.color,
          team: f.team,
          lead: f.lead,
          due: f.due,
          members: [...new Set([...p.members, f.lead])],
        }),
      )
    ) {
      S.ui.modals.pop();
      render();
      toast('Project updated');
    }
    return;
  }
  let p;
  if (
    !mutate(() => {
      p = createProject(f, f.tmpl);
    })
  )
    return;
  S.ui.modals.pop();
  go('project', { id: p.id, tab: f.tmpl === 'blank' ? 'overview' : S.prefs.defaultTab || 'board' });
  toast(`Created ${p.name}${tasksOf(p.id).length ? ` with ${tasksOf(p.id).length} starter tasks` : ''}`);
};
A.dupProject = el => {
  const p = proj(el.dataset.id);
  S.ui.pop = null;
  let n;
  mutate(() => {
    n = createProject({ ...p, name: p.name + ' copy' }, 'blank');
    tasksOf(p.id).forEach(t => createTask({ ...JSON.parse(JSON.stringify(t)), id: uid('t'), key: undefined, project: n.id, status: 'todo' }));
  });
  toast(`Duplicated ${p.name}`, { action: 'Open', onAction: () => go('project', { id: n.id }) });
};
A.archiveProject = el => {
  const p = proj(el.dataset.id);
  S.ui.pop = null;
  confirmDlg({
    title: `Archive ${p.name}?`,
    body: 'The project will be hidden from the sidebar and project lists. Tasks, files, and comments are kept, and you can restore it from Settings → Projects.',
    ok: 'Archive project',
    icon: 'archive',
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          p.archived = true;
          p.archivedAt = Date.now();
        })
      ) {
        if (S.ui.route === 'project' && S.ui.params.id === p.id) go('projects');
        toast(`Archived ${p.name}`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};
A.restoreProject = el => {
  const p = proj(el.dataset.id);
  mutate(() => {
    p.archived = false;
    p.archivedAt = null;
  });
  toast(`Restored ${p.name}`);
};
A.delProject = el => {
  const p = proj(el.dataset.id);
  S.ui.pop = null;
  const n = tasksOf(p.id).length;
  confirmDlg({
    title: `Delete ${p.name}?`,
    body: `This permanently deletes the project and its <b>${n} task${n === 1 ? '' : 's'}</b>, files, and comments for everyone. This can't be undone.`,
    ok: 'Delete project',
    danger: true,
    typeName: p.name,
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          const ids = tasksOf(p.id).map(t => t.id);
          D()
            .tasks.filter(t => t.project === p.id)
            .forEach(t => ids.push(t.id));
          deleteTasks(ids);
          D().projects = D().projects.filter(x => x !== p);
          D().projOrder = D().projOrder.filter(x => x !== p.id);
          D().files = D().files.filter(f => f.project !== p.id);
        })
      ) {
        if (S.ui.route === 'project' && S.ui.params.id === p.id) go('projects');
        toast(`Deleted ${p.name}`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};
A.requestAccess = el => {
  const p = proj(el.dataset.id);
  toast(`Access requested. We'll notify you when ${mem(p?.lead)?.name || 'the owner'} responds.`);
};

/* sharing & invites */
A.share = el => {
  const id = el.dataset.id || curProjectId();
  S.ui.shareQ = '';
  S.ui.pop = null;
  openModal({ type: 'share', id });
};
IN.shareQ = el => {
  S.ui.shareQ = el.value;
  render();
};
A.shareAdd = el => {
  const p = proj(el.dataset.id);
  const m = mem(el.dataset.mid);
  mutate(() => {
    p.members.push(m.id);
  });
  S.ui.shareQ = '';
  render();
  toast(`${m.name} can now edit ${p.name}`);
};
A.shareInvite = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const p = proj(m.id);
  const v = ($('#share-in')?.value || '').trim();
  const perm = $('#share-perm')?.value;
  if (!v) {
    $('#share-in')?.focus();
    return;
  }
  const ex = D().members.find(x => x.email.toLowerCase() === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase());
  if (ex) {
    if (!p.members.includes(ex.id))
      mutate(() => {
        p.members.push(ex.id);
        p.perms = p.perms || {};
        p.perms[ex.id] = perm;
      });
    S.ui.shareQ = '';
    render();
    toast(`Shared with ${ex.name}`);
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(v)) {
    toast('Enter a valid email address, like name@company.com', { kind: 'err' });
    return;
  }
  const nm = v
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  mutate(() => {
    const id = uid('m');
    D().members.push({ id, name: nm, email: v, role: 'Guest', team: p.team, title: 'Guest', c: '#6B7280', status: 'invited', last: null, tz: '—' });
    p.members.push(id);
    p.perms = p.perms || {};
    p.perms[id] = perm;
  });
  S.ui.shareQ = '';
  render();
  toast(`Invitation sent to ${v}`);
};
IN.sharePerm = el => {
  const p = proj(el.dataset.id);
  const mid = el.dataset.mid;
  if (el.value === '__remove') {
    const snap = snapshot();
    mutate(() => {
      p.members = p.members.filter(x => x !== mid);
    });
    toast(`Removed ${mem(mid).name}`, { action: 'Undo', onAction: () => restore(snap) });
  } else {
    mutate(() => {
      p.perms = p.perms || {};
      p.perms[mid] = el.value;
    });
    toast(`${mem(mid).name}: ${el.value}`, { ms: 1800 });
  }
};
IN.shareAccess = el => {
  const p = proj(el.dataset.id);
  mutate(() => {
    p.access = el.value;
  });
};
A.invite = () => {
  /* Member-invites-member is out of scope (T6): only the workspace owner
     adds people — the member branch also keeps shared-doc membership
     writes owner-only. */
  if (S.ui.memberCtx) {
    S.ui.pop = null;
    toast('Only the workspace owner can add members.', { kind: 'err' });
    return;
  }
  S.ui.inviteDraft = '';
  S.ui.errors = {};
  S.ui.pop = null;
  openModal({ type: 'invite' });
};
A.submitInvite = async () => {
  const raw = ($('#inv-emails')?.value || '').trim();
  const team = $('#inv-team')?.value || '';
  S.ui.inviteDraft = raw;
  const list = raw
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const bad = list.filter(e => !EMAIL_RE.test(e));
  if (!list.length) {
    S.ui.errors.invite = 'Enter at least one email address';
    render();
    return;
  }
  if (bad.length) {
    S.ui.errors.invite = `${bad[0]} isn't a valid email address`;
    render();
    return;
  }
  const { fresh, dups, upgrades } = splitInviteEmails(D().members, list);
  if (!fresh.length && !upgrades.length) {
    S.ui.errors.invite = `${dups[0]} is already in this workspace`;
    render();
    return;
  }
  /* Resolve each address against the platform (owner-gated RPC, 0008).
     Unresolved addresses become pending members — promoted by the
     owner's hydrate once the person first signs in. Legacy demo entries
     (no authUserId/pending) are upgraded in place instead. */
  const targets = [];
  for (const email of [...fresh, ...upgrades.map(u => u.email)]) {
    let authUserId = null;
    try {
      authUserId = await findAuthUserId(sb, email);
    } catch (err) {
      toast(`Couldn't check ${esc(email)} — ${errMessage(err)}`, { kind: 'err' });
      return;
    }
    targets.push({ email, authUserId });
  }
  const pending = targets.filter(t => !t.authUserId);
  const commit = async () => {
    const rows = targets.filter(t => t.authUserId).map(t => ({ workspace_id: S.ui.wsId, user_id: t.authUserId }));
    if (rows.length) {
      /* Membership rows first: a doc entry without its RLS row would
         leave the invitee unable to resolve the workspace. A 23505
         duplicate is tolerated — it heals the partial-invite window. */
      const ins = await sb.from('workspace_members').insert(rows).select();
      if (ins.error && ins.error.code !== '23505') {
        toast(`Couldn't add the member(s) — ${errMessage(ins.error)}`, { kind: 'err' });
        return;
      }
    }
    const ok = mutate(() => {
      /* Identity bridge: stamp the owner's own authUserId (chat DMs). */
      const mine = mem(D().me);
      if (mine && !mine.authUserId) mine.authUserId = getCurrentUser();
      targets.forEach(t => {
        const existing = D().members.find(m => m && m.email && m.email.toLowerCase() === t.email.toLowerCase());
        if (existing && !existing.authUserId && !existing.pending) {
          /* Pre-T6 demo residue: upgrade the entry in place (id + role + references stay). */
          upgradeLegacyMember(existing, t.authUserId);
        } else if (!existing) {
          const e = makeInviteEntry({ members: D().members, email: t.email, authUserId: t.authUserId, team });
          if (e) D().members.push(e);
        }
      });
    });
    if (!ok) return;
    S.ui.modals.pop();
    S.ui.errors = {};
    render();
    const added = targets.length - pending.length;
    if (added) toast(`${added} member${added > 1 ? 's' : ''} added to ${esc(D().ws.name)}`);
    if (upgrades.length) toast(`${upgrades.length} existing entr${upgrades.length > 1 ? 'ies' : 'y'} upgraded to full membership.`, { kind: 'info' });
    if (pending.length)
      toast(`${pending.length} pending — ${pending.map(t => esc(t.email)).join(', ')} will be added automatically when they first sign in.`, {
        kind: 'info',
        ms: 6000,
      });
    if (dups.length) toast(`${dups.length} address${dups.length > 1 ? 'es' : ''} already in this workspace — skipped.`, { kind: 'info' });
  };
  if (pending.length) {
    confirmDlg({
      title: 'Not on the platform yet',
      body: `${pending.map(t => `<b>${esc(t.email)}</b>`).join(', ')} ${pending.length > 1 ? 'have' : 'has'} never signed in. Add them as pending? They'll become a member automatically the first time they sign in.`,
      ok: 'Add as pending',
      run: () => commit(),
    });
  } else {
    await commit();
  }
};
A.viewProfile = el => go('member', { id: el.dataset.id });
A.assignToMember = el => {
  S.ui.pop = null;
  A.newTask({ dataset: { assignee: el.dataset.id } });
};
A.removeMember = el => {
  const m = mem(el.dataset.id);
  S.ui.pop = null;
  /* Member removal is out of scope (T6) — and removing a real member's
     doc entry would strand their workspace_members RLS row, leaving them
     with access but no identity. Refuse honestly until removal exists. */
  toast(`Removing members isn't supported yet — ${esc(m.name)} stays a member.`, { kind: 'info' });
};
A.newWorkspace = () => {
  /* A member runs this against the SHARED doc — onboarding would push a
     template doc into their orphan row and then sync it over the shared
     workspace. Workspace creation is owner-only. */
  if (S.ui.memberCtx) {
    S.ui.pop = null;
    toast(`You're a member of ${esc(D().ws.name)} — only the workspace owner can create workspaces.`, { kind: 'err' });
    return;
  }
  S.ui.pop = null;
  S.ui.auth = 'onboarding';
  S.ui.onb = 1;
  S.ui.onbData.ws = '';
  S.ui.onbData.url = '';
  render();
};
IN.memQ = el => {
  S.ui.memQ = el.value;
  render();
};
IN.actWho = el => {
  S.ui.actWho = el.value;
  render();
};

/* files */
IN.fileQ = el => {
  S.ui.fileQ = el.value;
  render();
};
IN.fileType = el => {
  S.ui.fileType = el.value;
  render();
};
IN.fileSort = el => {
  S.ui.fileSort = el.value;
  render();
};
A.renameFile = el => {
  const f = D().files.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  openModal({
    type: 'prompt',
    title: 'Rename file',
    label: 'File name',
    value: f.name,
    run: v => {
      if (v)
        mutate(() => {
          f.name = v;
          f.type = fileType(v);
        });
    },
  });
};
A.dupFile = el => {
  const f = D().files.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  mutate(() => {
    const i = D().files.indexOf(f);
    D().files.splice(i + 1, 0, { ...f, id: uid('f'), name: f.name.replace(/(\.[^.]+)$/, ' copy$1'), at: Date.now(), by: D().me });
  });
  toast('File duplicated');
};
A.delFile = el => {
  const f = D().files.find(x => x.id === el.dataset.id);
  S.ui.pop = null;
  confirmDlg({
    title: 'Delete file?',
    body: `<b>${esc(f.name)}</b> will be removed from the project${f.task ? ' and its task' : ''}.`,
    ok: 'Delete file',
    danger: true,
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          D().files = D().files.filter(x => x !== f);
          if (f.task && task(f.task)) task(f.task).attachments = task(f.task).attachments.filter(a => a.name !== f.name);
        })
      )
        toast(`Deleted ${f.name}`, { action: 'Undo', onAction: () => restore(snap) });
    },
  });
};

/* inbox & notifications */
A.selNotif = el => {
  const n = D().notifs.find(x => x.id === el.dataset.id);
  n.read = true;
  S.ui.inboxSel = n.id;
  S.ui.gsel = null; // one selection at a time across the merged inbox
  save();
  render();
};
A.toggleRead = el => {
  const n = D().notifs.find(x => x.id === el.dataset.id);
  n.read = !n.read;
  save();
  render();
};
A.markAllRead = () => {
  const n = D().notifs.filter(x => !x.read).length;
  D().notifs.forEach(x => (x.read = true));
  save();
  render();
  if (n) toast("You're all caught up.");
};
A.toggleUnreadOnly = () => {
  S.ui.inboxUnread = !S.ui.inboxUnread;
  render();
};
A.openNotif = el => {
  const n = D().notifs.find(x => x.id === el.dataset.id);
  n.read = true;
  save();
  if (n.task) A.openTask({ dataset: { id: n.task } });
  else if (n.project) go('project', { id: n.project, tab: 'overview' });
};

/* search & palette */
A.openPalette = () => {
  S.ui.palOpener = focusKey(document.activeElement);
  S.ui.palette = { q: '', mode: 'cmd', scope: 'all', hl: 0 };
  S.ui.pop = null;
  render();
};
A.openSearch = () => {
  S.ui.palOpener = focusKey(document.activeElement);
  S.ui.palette = { q: '', mode: 'search', scope: 'all', hl: 0 };
  S.ui.pop = null;
  S.ui.mnav = false;
  render();
};
A.closePalette = () => {
  S.ui.palette = null;
  render();
};
A.palScope = el => {
  S.ui.palette.scope = el.dataset.v;
  S.ui.palette.hl = 0;
  render();
  $('#pal-in')?.focus();
};
IN.palQ = el => {
  S.ui.palette.q = el.value;
  S.ui.palette.hl = 0;
  render();
};
A.palRun = el => {
  const it = S.ui.palette?._flat?.[+el.dataset.i];
  if (!it) return;
  S.ui.palette = null;
  render();
  it.run();
};
IN.searchQ = el => {
  S.ui.searchQ = el.value;
  render();
};
A.setSearch = el => {
  S.ui.searchQ = el.dataset.q;
  render();
  $('#search-page-q')?.focus();
};

/* workspace, account, prototype controls */
A.switchWs = el => {
  const w = D().workspaces.find(x => x.id === el.dataset.v);
  S.ui.pop = null;
  D().ws = { name: w.name, url: w.name.toLowerCase().replace(/[^a-z0-9]+/g, ''), c: w.c, brand: !!w.brand };
  save();
  go('home');
  toast(`Switched to ${w.name}`);
};
A.signOut = async () => {
  S.ui.pop = null;
  S.ui.palette = null;
  S.ui.drawer = null;
  S.ui.modals = [];
  /* Persist any pending debounced edit before the cache is dropped: the
     flush runs while the user is still set, so the last <=500ms of edits
     reach the server instead of dying with the cache. */
  try {
    await syncDoc.flush();
  } catch {
    /* best effort: sign-out proceeds */
  }
  syncDoc.cancel();
  try {
    if (sb) await signOutUser(sb);
  } catch {
    /* session already gone server-side: sign out locally anyway */
  }
  setCurrentUser(null);
  S.ui.memberCtx = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage blocked */
  }
  S.data = seed();
  S.views = {};
  S.prefs = { ...DEFAULT_PREFS };
  S.ui.offline = false;
  S.ui.errors = {};
  S.ui.auth = 'login';
  render();
};
A.shortcuts = () => {
  S.ui.pop = null;
  S.ui.palette = null;
  openModal({ type: 'shortcuts' });
};
/* The offline bar's "Try again" button: a REAL recovery attempt — flush the
   pending debounced sync (or push directly) and report the result. No
   faked success: while the server is unreachable the flag stays up. */
A.retryOnline = async el => {
  el?.classList.add('is-loading');
  el?.setAttribute('aria-busy', 'true');
  const res = await pushDocUpdate(sb, getCurrentUser(), S, D().ws?.name);
  el?.classList.remove('is-loading');
  el?.removeAttribute('aria-busy');
  if (res === 'ok') {
    render();
    toast('Reconnected — all changes synced.');
  } else if (res === 'skipped') {
    /* Nothing to sync (no session): the flag was stale, clear it quietly. */
    S.ui.offline = false;
    render();
  } else {
    render();
    toast("Still can't reach the server. Your edits are kept on this device and will sync when you're back online.", { kind: 'err', ms: 5000 });
  }
};
/* Design-system gallery: the destructive dialogs, rendered exactly as in
   the app but wired to a no-op run — confirming changes nothing. */
A.demoDlg = el => {
  const dlg = {
    delProject: { title: 'Delete project?', body: 'This is a design-system preview. Nothing is deleted.', ok: 'Delete project', danger: true, icon: 'trash-2' },
    delTask: { title: 'Delete task?', body: 'This is a design-system preview. Nothing is deleted.', ok: 'Delete task', danger: true, icon: 'trash-2' },
    removeMember: {
      title: 'Remove member?',
      body: 'This is a design-system preview. Nobody is removed.',
      ok: 'Remove member',
      danger: true,
      icon: 'user-minus',
    },
    archiveProject: { title: 'Archive project?', body: 'This is a design-system preview. Nothing is archived.', ok: 'Archive project', icon: 'archive' },
  }[el.dataset.v] || { title: 'Demo', body: 'Design-system preview.', ok: 'Continue' };
  confirmDlg({
    ...dlg,
    run: () => toast('Demo only — nothing was changed', { kind: 'info' }),
  });
};
A.toastInfo = el => toast(el.dataset.msg, { kind: 'info' });
A.demoToast = el => {
  const v = el.dataset.v;
  if (v === 'err') toast("Your changes couldn't be saved.", { kind: 'err', action: 'Try again', onAction: () => toast('Saved') });
  else if (v === 'retry') {
    toast('Retrying…', { kind: 'info', ms: 1200 });
    setTimeout(() => toast('Loaded successfully'), 1300);
  } else toast('Moved “Create homepage wireframes” to Review', { action: 'Undo', onAction: () => toast('Undone', { kind: 'info' }) });
};
A.demoConfirm = () =>
  confirmDlg({
    title: 'Archive Marketing Website?',
    body: 'The project will be hidden from the sidebar. You can restore it any time.',
    ok: 'Archive project',
    icon: 'archive',
    run: () => toast('This was a preview — nothing was archived', { kind: 'info' }),
  });
A.demoLoad = el => {
  el.classList.add('is-loading');
  setTimeout(() => {
    el.classList.remove('is-loading');
    toast('Loaded');
  }, 1400);
};
A.reloadPage = () => {
  S.ui.loading = true;
  render();
  setTimeout(() => {
    S.ui.loading = false;
    render();
  }, 1400);
};

/* modals */
A.closeModal = () => closeModal();
A.closeModalBg = (el, e) => {
  if (e.target === el) closeModal();
};
A.confirmOk = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  if (m.typeName && S.ui.confirmText !== m.typeName) return;
  S.ui.modals.pop();
  S.ui.confirmText = '';
  render();
  m.run && m.run();
};
IN.confirmText = el => {
  S.ui.confirmText = el.value;
  const m = S.ui.modals[S.ui.modals.length - 1];
  const b = $('.modal:last-of-type [data-a="confirmOk"]') || $$('[data-a="confirmOk"]').pop();
  if (b) b.disabled = el.value !== m.typeName;
};
A.promptSubmit = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const v = $('#prompt-in').value.trim();
  S.ui.modals.pop();
  render();
  m.run(v);
};
IN.noop = () => {};

/* settings */
IN.prefToggle = el => {
  S.prefs[el.dataset.k] = el.checked;
  save();
};
IN.npToggle = el => {
  D().notifPrefs[el.dataset.k] = el.checked;
  save();
  toast('Notification preferences saved', { ms: 1500 });
};
IN.prefSel = el => {
  const k = el.dataset.k;
  S.prefs[k] = k === 'weekStart' ? +el.value : el.value;
  save();
  render();
  toast('Preference saved', { ms: 1500 });
};
A.wsColor = el => {
  D().ws.c = el.dataset.v;
  save();
  render();
};
A.saveWorkspace = () => {
  const n = $('#ws-name').value.trim();
  const u = $('#ws-url')
    .value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  if (!n) {
    toast("Workspace name can't be empty", { kind: 'err' });
    return;
  }
  loadingBtn('ws-save', 600, () => {
    if (
      mutate(() => {
        const old = D().ws.name;
        D().ws.name = n;
        D().ws.url = u || D().ws.url;
        const w = D().workspaces.find(x => x.name === old);
        if (w) w.name = n;
      })
    )
      toast('Workspace settings saved');
  });
};
A.delWorkspace = () => {
  /* Deleting "the workspace" while viewing a shared doc would seed and
     sync over the shared workspace for everyone. Owner-only. */
  if (S.ui.memberCtx) {
    toast(`Only the workspace owner can delete ${esc(D().ws.name)}.`, { kind: 'err' });
    return;
  }
  confirmDlg({
    title: `Delete ${D().ws.name}?`,
    body: 'Every project, task, file, and comment in this workspace will be permanently deleted for all members.',
    ok: 'Delete workspace',
    danger: true,
    typeName: D().ws.name,
    run: () => {
      S.ui.memberCtx = null;
      S.data = seed();
      S.views = {};
      save();
      S.ui.auth = 'login';
      render();
      toast('Workspace deleted. Sign in again to start with a fresh, empty workspace.', { kind: 'info', ms: 5000 });
    },
  });
};
A.avColor = el => {
  me().c = el.dataset.v;
  save();
  render();
};
A.saveProfile = () => {
  const n = $('#pf-name').value.trim();
  if (!n) {
    S.ui.errors.pname2 = 'Enter your name';
    render();
    return;
  }
  S.ui.errors.pname2 = null;
  const tt = $('#pf-title').value.trim();
  loadingBtn('pf-save', 600, () => {
    if (
      mutate(() => {
        S.prefs.name = n;
        S.prefs.title = tt;
        me().name = n;
        me().title = tt;
      })
    )
      toast('Profile updated');
  });
};
IN.pwStrength = el => {
  S.ui.pwNew = el.value;
  const m = el.parentElement.querySelector('.row .strength')?.parentElement;
  const tmp = document.createElement('div');
  tmp.innerHTML = strengthMeter(el.value);
  if (m) m.replaceWith(tmp.firstElementChild || document.createTextNode(''));
  else if (tmp.firstElementChild) el.after(tmp.firstElementChild);
};
A.savePassword = () => {
  const e = (S.ui.errors = {});
  const cur = $('#pw-cur').value,
    nw = $('#pw-new').value,
    cf = $('#pw-conf').value;
  S.ui.pwDone = false;
  if (!cur) e.pwCur = 'Enter your current password';
  if (nw.length < 10 || !/[0-9\W]/.test(nw)) e.pwNew = 'Use at least 10 characters, including a number or symbol';
  if (nw !== cf) e.pwConf = "Passwords don't match";
  if (Object.keys(e).length) {
    render();
    return;
  }
  loadingBtn('pw-save', 800, () => {
    S.ui.pwDone = true;
    S.ui.pwNew = '';
    render();
    toast('Password updated');
  });
};
A.revokeSession = el => {
  mutate(() => {
    D().sessions = D().sessions.filter(s => s.id !== el.dataset.id);
  });
  toast('Session signed out');
};
A.revokeAll = () =>
  confirmDlg({
    title: 'Sign out of all other sessions?',
    body: "You'll stay signed in on this device. Other devices will need to sign in again.",
    ok: 'Sign out others',
    danger: true,
    icon: 'log-out',
    run: () => {
      mutate(() => {
        D().sessions = D().sessions.filter(s => s.cur);
      });
      toast('Signed out of other sessions');
    },
  });
A.setup2fa = () => {
  S.ui.tfaSetup = true;
  S.ui.errors = {};
  render();
};
A.cancel2fa = () => {
  S.ui.tfaSetup = false;
  render();
};
A.verify2fa = () => {
  const v = $('#tfa-code').value.trim();
  if (!/^\d{6}$/.test(v)) {
    S.ui.errors.tfa = 'Enter the 6-digit code from your app';
    render();
    return;
  }
  S.ui.errors = {};
  mutate(() => {
    D().tfa = true;
    S.ui.tfaSetup = false;
  });
  toast('Two-factor authentication enabled');
};
A.disable2fa = () =>
  confirmDlg({
    title: 'Turn off two-factor authentication?',
    body: 'Your account will be protected by your password only.',
    ok: 'Turn off',
    danger: true,
    icon: 'shield-off',
    run: () => {
      mutate(() => {
        D().tfa = false;
      });
      toast('Two-factor authentication turned off');
    },
  });
A.changePlan = el => {
  const v = el.dataset.v;
  const price = { Free: 0, Team: 12, Business: 24 }[v];
  confirmDlg({
    title: `${v === 'Free' ? 'Downgrade' : 'Upgrade'} to ${v}?`,
    body: `${D().members.length} members × $${price}/month = <b>$${D().members.length * price}/month</b>, prorated from today and billed to Visa ending 4242.`,
    ok: v === 'Free' ? 'Downgrade' : `Upgrade to ${v}`,
    icon: 'gem',
    run: () => {
      mutate(() => {
        D().plan = v;
      });
      toast(`You're now on the ${v} plan`);
    },
  });
};

/* auth */
/* Google-only sign-in (Operance contract). On success the browser is
   redirected to Google; on return the app boots fresh and the existing
   session boot path (main.js init -> startWorkspace) hydrates or
   bootstraps the workspace, applying the Google identity. A provider
   error (e.g. no Google provider configured on the backend) surfaces in
   the existing login alert slot. */
A.doGoogleSignIn = async () => {
  const e = (S.ui.errors = {});
  if (!sb) {
    e.login = 'This build has no backend configured.';
    render();
    return;
  }
  const btn = $('#google-btn');
  btn?.classList.add('is-loading');
  btn?.setAttribute('aria-busy', 'true');
  try {
    await signInWithGoogle(sb, window.location.origin);
  } catch (err) {
    e.login = err.message;
  } finally {
    /* Runs before the browser navigates away too: the button must not
       stay in a loading state if the redirect is slow or was blocked. */
    btn?.classList.remove('is-loading');
    btn?.removeAttribute('aria-busy');
    if (e.login) render();
  }
};
export const EMAIL_RE = /^\S+@\S+\.\S+$/;

/* onboarding */
A.onbSet = el => {
  S.ui.onbData[el.dataset.k] = el.dataset.v;
  if (el.dataset.k === 'tmpl') {
    const t = TEMPLATES.find(x => x.id === el.dataset.v);
    if (t && !S.ui.onbData.projTouched) S.ui.onbData.proj = t.name === 'Website' ? 'Website Launch' : t.name;
  }
  render();
};
IN.onbWs = el => {
  const o = S.ui.onbData;
  o.ws = el.value;
  if (!o.urlTouched)
    o.url = el.value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  if (S.ui.errors.ws && el.value.trim()) S.ui.errors.ws = null;
  render();
};
IN.onbUrl = el => {
  S.ui.onbData.url = el.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  S.ui.onbData.urlTouched = true;
  render();
};
IN.onbProj = el => {
  S.ui.onbData.proj = el.value;
  S.ui.onbData.projTouched = true;
};
IN.onbInv = el => {
  const a = (S.ui.onbData.invites || '').split(',');
  a[+el.dataset.i] = el.value.trim();
  S.ui.onbData.invites = a.join(',');
};
A.onbBack = () => {
  S.ui.onb = Math.max(0, S.ui.onb - 1);
  render();
};
A.onbNext = el => {
  const o = S.ui.onbData;
  if (S.ui.onb === 1 && !o.ws.trim()) {
    S.ui.errors.ws = 'Name your workspace to continue';
    render();
    $('#o-ws')?.focus();
    return;
  }
  if (S.ui.onb === 3 && !o.proj.trim()) {
    toast('Give your project a name', { kind: 'err' });
    return;
  }
  if (S.ui.onb === 4 && el.dataset.skip) o.invites = '';
  if (S.ui.onb === 4 && !el.dataset.skip) {
    const bad = (o.invites || '').split(',').filter(x => x && !EMAIL_RE.test(x));
    if (bad.length) {
      toast(`${bad[0]} isn't a valid email address`, { kind: 'err' });
      return;
    }
  }
  S.ui.onb++;
  render();
  setTimeout(() => $('.auth input')?.focus(), 20);
};
A.onbExit = () => {
  /* Onboarding is session-gated: with no account, exit goes to login,
     never into the app. */
  if (!sb || !getCurrentUser()) {
    S.ui.auth = 'login';
    render();
    return;
  }
  S.ui.auth = null;
  render();
};
A.onbFinish = async () => {
  /* Session gate: finishing onboarding without a real account must not
     enter the app (and there is no row to upsert the doc into). */
  if (!sb || !getCurrentUser()) {
    S.ui.auth = 'login';
    S.ui.errors = {};
    render();
    return;
  }
  const o = S.ui.onbData;
  let p;
  mutate(() => {
    if (o.ws.trim()) {
      const c = ['#2F2E2A', '#5A67D8', '#23918A', '#C54B78'][D().workspaces.length % 4];
      D().ws = { name: o.ws.trim(), url: o.url || 'workspace', c };
      if (!D().workspaces.some(w => w.name === D().ws.name)) D().workspaces.push({ id: uid('w'), name: D().ws.name, c, plan: 'Free' });
    }
    S.prefs.defaultTab = { kanban: 'board', list: 'list', timeline: 'timeline', table: 'table' }[o.team] || 'board';
    const tm = TEMPLATES.find(t => t.id === o.tmpl) || TEMPLATES[2];
    p = createProject(
      {
        name: o.proj.trim() || tm.name,
        icon: tm.icon === 'file' ? 'folder' : tm.icon,
        color: 'indigo',
        team: me().team,
        lead: D().me,
        desc: `Created during setup from the ${tm.name} template.`,
      },
      tm.id,
    );
    (o.invites || '')
      .split(',')
      .filter(x => EMAIL_RE.test(x))
      .forEach(e =>
        D().members.push({
          id: uid('m'),
          name: e.split('@')[0].replace(/\b\w/g, c => c.toUpperCase()),
          email: e,
          role: 'Member',
          team: me().team,
          title: 'Member',
          c: '#6B7280',
          status: 'invited',
          last: null,
          tz: '—',
        }),
      );
  });
  /* Persist the finished workspace before entering: first upsert of the doc. */
  if (sb && getCurrentUser()) {
    try {
      await upsertWorkspaceDoc(sb, getCurrentUser(), buildDocPayload(S.data, S.prefs, S.views), D().ws.name);
    } catch (err) {
      markSyncFailure(S, err);
      toast("Your workspace couldn't be saved to the server yet — it will sync automatically.", { kind: 'err', ms: 5000 });
    }
  }
  S.ui.auth = null;
  go('project', { id: p.id, tab: S.prefs.defaultTab });
  toast(`Welcome to ${D().ws.name}`);
};
