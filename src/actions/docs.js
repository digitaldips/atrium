/* =====================================================================
   DOCS ACTIONS · CRUD, autosave (version-checked), realtime co-editing,
   version snapshots, search, Granola import (Orbit integration T1)
   =====================================================================
   Pages persist to docs_pages/docs_versions (migration 0005) through
   supabase-js — the workspace document is untouched. The editor keeps
   DC.sel current on EVERY keystroke (already sanitized) so any render is
   lossless; persistence runs on a ~1s autosave debounce through a
   VERSION-CHECKED update (.eq('version', expected)): the Postgres trigger
   bumps the version on every content change, so a stale writer updates
   zero rows, adopts the fresh row and re-bases (one retry, LWW).
   Live co-editing: one Supabase Realtime channel per page — broadcast
   carries keystrokes to other tabs (applied only when the local editor
   is not focused), presence shows who is on the page.
   Fetch orchestrators all gate through shouldFetchState ('idle' only;
   'ok'/'error' are terminal until an action resets them) — pages call
   ensure* on every render, so an ungated fetch would loop forever. */
import { $, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { DOC_UNTITLED, docTextFromHtml, makeDocPage, nextDocPosition, shouldFetchState, shouldSnapshot } from '../core/docs.js';
import { MAX_IMPORT_BYTES, granolaImportPlan, parseGranolaExport } from '../core/granola.js';
import { docsSanitize } from '../core/sanitize.js';
import { sb, getCurrentUser } from '../core/supabase.js';
import { errMessage, loadWorkspaceDoc } from '../core/workspace-api.js';
import { toast } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { A, IN, confirmDlg } from './actions.js';
import { closeModal, openModal } from '../overlays/modals.js';

export const DOCS_TABLE = 'docs_pages';
export const VERSIONS_TABLE = 'docs_versions';
const AUTOSAVE_MS = 1000; // same cadence as notes
const BROADCAST_MS = 250; // remote-tab edit throttle

/* Session-only cache of Postgres rows. Dies with the page load — S and
   the workspace doc stay out of it (zero doc keys). */
export const DC = {
  rows: [],
  rowsState: 'idle',
  rowsError: '',
  sel: null,
  selState: 'idle',
  selError: '',
  selId: '',
  newestSnapshotAt: null,
  versions: null /* { pageId, rows } */,
  versionsState: 'idle',
  versionsError: '',
  preview: '',
  trash: [],
  trashState: 'idle',
  trashError: '',
  search: null /* { q, rows, state, error } */,
  granola: undefined /* undefined = unchecked, null = check failed, {count,lastAt} */,
  granolaState: 'idle',
  presence: [],
};

export const getCurrentUserId = () => getCurrentUser();

function needDocs() {
  if (S.ui.offline) {
    toast("You're offline — pages need a connection.", { kind: 'err' });
    return false;
  }
  if (!sb) {
    toast("Docs need a connection to Atrium's database.", { kind: 'err' });
    return false;
  }
  if (!getCurrentUser()) {
    toast('Sign in to use Docs.', { kind: 'err' });
    return false;
  }
  return true;
}

/* The workspace row's id (docs_pages.workspace_id). Stashed at hydrate;
   a lazy fallback covers a trusted-cache boot that skipped hydration. */
export async function ensureWsId() {
  if (S.ui.wsId) return S.ui.wsId;
  if (!sb || !getCurrentUser()) return null;
  try {
    const row = await loadWorkspaceDoc(sb, getCurrentUser());
    if (row?.id) S.ui.wsId = row.id;
  } catch {
    /* surfaced by the caller's error path */
  }
  return S.ui.wsId || null;
}

function invalidateDocsRows() {
  DC.rowsState = 'idle';
  DC.rowsError = '';
}

/* ---------- tree rows (AC1) ---------- */
export async function ensureDocsRows() {
  if (!sb) {
    DC.rowsState = 'error';
    DC.rowsError = "Docs need a connection to Atrium's database.";
    return;
  }
  if (!shouldFetchState(DC.rowsState)) return;
  DC.rowsState = 'loading';
  render();
  try {
    const wsId = await ensureWsId();
    if (!wsId) throw new Error('No workspace found for this account.');
    const { data, error } = await sb
      .from(DOCS_TABLE)
      .select('id, parent_id, title, icon, position, version, source, created_at, updated_at, deleted_at')
      .eq('workspace_id', wsId)
      .is('deleted_at', null)
      .order('position');
    if (error) throw error;
    DC.rows = (data || []).map(makeDocPage).filter(Boolean);
    DC.rowsState = 'ok';
  } catch (e) {
    DC.rowsState = 'error';
    DC.rowsError = errMessage(e, 'Could not load pages.');
  }
  render();
}

/* ---------- selected page (full row incl. content) ---------- */
export async function ensureDocSel(id) {
  if (!id) {
    DC.sel = null;
    DC.selId = '';
    DC.selState = 'idle';
    syncDocChannel(''); /* leaving the editor closes the page's live channel */
    return;
  }
  if (DC.selId === id && DC.selState !== 'idle') return; /* loading/ok/error are settled for this id */
  DC.selId = id;
  DC.selState = 'loading';
  DC.selError = '';
  DC.newestSnapshotAt = null;
  render();
  try {
    const { data, error } = await sb.from(DOCS_TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    /* Stale response: a newer selection won the race — this fetch must not
       mount the wrong page (keystrokes would autosave onto it). */
    if (DC.selId !== id) return;
    DC.sel = data ? makeDocPage(data) : null;
    DC.selState = 'ok';
    syncDocChannel(id);
    if (DC.sel) {
      const { data: v, error: verr } = await sb.from(VERSIONS_TABLE).select('created_at').eq('page_id', id).order('created_at', { ascending: false }).limit(1);
      if (!verr && v && v[0]) DC.newestSnapshotAt = new Date(v[0].created_at).getTime();
    }
  } catch (e) {
    DC.selState = 'error';
    DC.selError = errMessage(e, 'Could not load this page.');
  }
  render();
}

/* ---------- autosave (version-checked, AC3+AC4) ---------- */
const draft = { t: null };

/* The autosave commits ONLY the editor body, resolved by page id from the
   live DOM (#doc-editor). It must never read another element (the notes
   lesson: a title carries no body). */
function commitLive(id) {
  const ed = $('#doc-editor');
  if (!ed || ed.dataset.id !== id) return false;
  const p = DC.sel;
  if (!p || p.id !== id) return false;
  const clean = docsSanitize(ed.innerHTML);
  if (p.content_html === clean) return false;
  p.content_html = clean;
  return true;
}

function setSavedLabel(txt) {
  const el = $('#doc-saved');
  if (el) el.textContent = txt;
}

function scheduleAutosave(id) {
  clearTimeout(draft.t);
  draft.t = setTimeout(() => {
    draft.t = null;
    saveDocPage(id);
  }, AUTOSAVE_MS);
}

/* One save: optimistic version check, stale-writer re-base (one retry),
   auto snapshot per the Orbit ≥10-min rule when content really changed. */
async function saveDocPage(id) {
  const p = DC.sel;
  if (!p || p.id !== id || !sb || !getCurrentUser()) return;
  setSavedLabel('Saving…');
  const expected = Number(p.version) || 0;
  const body = { title: p.title, content_html: p.content_html, content_text: docTextFromHtml(p.content_html) };
  const adopt = row => {
    const fixed = makeDocPage(row);
    if (!fixed) return false;
    Object.assign(p, fixed);
    return true;
  };
  try {
    let { data, error } = await sb.from(DOCS_TABLE).update(body).eq('id', id).eq('version', expected).select();
    if (error) throw error;
    if (!data || !data.length) {
      /* Stale writer: adopt the fresh row, then re-base our edit on top. */
      const fresh = await sb.from(DOCS_TABLE).select('*').eq('id', id).maybeSingle();
      if (fresh.error) throw fresh.error;
      if (!fresh.data) {
        setSavedLabel('Deleted elsewhere');
        return;
      }
      /* Re-base = the LOCAL edit rides on top of the fresh version: capture
         the editor's content before adopting the fresh row, or the retry
         would echo the fresh values back and silently discard the edit. */
      const local = { title: p.title, content_html: p.content_html, content_text: docTextFromHtml(p.content_html) };
      adopt(fresh.data);
      const retry = await sb
        .from(DOCS_TABLE)
        .update(local)
        .eq('id', id)
        .eq('version', Number(p.version) || 0)
        .select();
      if (retry.error) throw retry.error;
      if (!retry.data || !retry.data.length) {
        setSavedLabel('Conflict');
        toast('This page is being edited elsewhere — reopen it to sync.', { kind: 'err' });
        return;
      }
      data = retry.data;
      toast('Saved on top of another edit to this page.', { kind: 'info' });
    }
    const changed = (Number(data[0].version) || 0) > expected;
    adopt(data[0]);
    setSavedLabel('Saved');
    if (changed && shouldSnapshot(Date.now(), DC.newestSnapshotAt)) {
      const { error: verr } = await sb.from(VERSIONS_TABLE).insert({
        workspace_id: p.workspace_id,
        page_id: id,
        title: p.title,
        content_html: p.content_html,
        kind: 'auto',
        created_by: getCurrentUser(),
      });
      if (!verr) DC.newestSnapshotAt = Date.now();
    }
  } catch (e) {
    setSavedLabel('Save failed');
    toast(`Save failed — ${errMessage(e)}`, { kind: 'err' });
  }
}

/* Flush a pending autosave right now: page switch, pagehide, tab hide. */
export function flushDocDraft() {
  if (!draft.t) return;
  clearTimeout(draft.t);
  draft.t = null;
  const ed = $('#doc-editor');
  if (ed && ed.dataset.id && DC.sel && DC.sel.id === ed.dataset.id) saveDocPage(ed.dataset.id);
}
window.addEventListener('pagehide', flushDocDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDocDraft();
});

/* ---------- editor input ---------- */
function updateCounts(ed) {
  const text = (ed.textContent || '').replace(/\u00a0/g, ' ').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const el = $('#doc-count');
  if (el) el.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
}

IN.docsBody = el => {
  if (!el.dataset.id) return;
  commitLive(el.dataset.id);
  updateCounts(el);
  setSavedLabel('Saving…');
  scheduleAutosave(el.dataset.id);
  broadcastEdit(el.dataset.id);
};

IN.docsTitle = el => {
  const p = DC.sel;
  if (!p || p.id !== el.dataset.id) return;
  p.title = el.value;
  /* Live-update the tree row without a render — no caret loss. */
  const row = document.querySelector(`[data-dtitle="${CSS.escape(el.dataset.id)}"]`);
  if (row) row.textContent = p.title || DOC_UNTITLED;
  setSavedLabel('Saving…');
  /* Title edits ride the SAME autosave timer as the body — the timer
     commits the EDITOR by page id, never this input. */
  scheduleAutosave(el.dataset.id);
};

/* ---------- realtime co-editing (AC4) ---------- */
let chan = null;
let chanPageId = '';
let myKey = '';
let lastBc = 0;
let bcT = null;

export function syncDocChannel(id) {
  if (!sb) return;
  myKey = myKey || (getCurrentUser() || 'anon') + ':' + Math.random().toString(36).slice(2, 8);
  if (chan && chanPageId === id) return;
  if (chan) {
    const old = chan;
    chan = null;
    sb.removeChannel(old);
  }
  chanPageId = id || '';
  if (!id) return;
  chan = sb
    .channel('docs:page:' + id, { config: { presence: { key: myKey } } })
    .on('presence', { event: 'sync' }, () => {
      DC.presence = chan
        ? Object.values(chan.presenceState())
            .flat()
            .map(v => v && v.name)
            .filter(Boolean)
        : [];
      updatePresenceDom();
    })
    .on('broadcast', { event: 'edit' }, msg => {
      const p = (msg && msg.payload) || {};
      if (p.from === myKey) return;
      applyRemoteEdit(id, p);
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED' && chan) chan.track({ name: S.prefs.name || 'You' });
    });
}

function updatePresenceDom() {
  const el = $('#doc-presence');
  if (el) el.textContent = DC.presence.length ? `${DC.presence.join(', ')} ${DC.presence.length === 1 ? 'is' : 'are'} here` : '';
}

/* Remote keystrokes apply only while the local editor is NOT focused
   (a focused editor reconciles through the version-checked save path). */
function applyRemoteEdit(pageId, p) {
  const ed = $('#doc-editor');
  if (!ed || ed.dataset.id !== pageId || !DC.sel || DC.sel.id !== pageId) return;
  if (document.activeElement === ed) return;
  /* A blurred editor can still hold an UNSAVED draft (1s autosave debounce):
     a broadcast here must not overwrite the keystrokes the timer will save. */
  if (draft.t) return;
  const clean = docsSanitize(typeof p.html === 'string' ? p.html : '');
  ed.innerHTML = clean;
  DC.sel.content_html = clean;
  setSavedLabel('Updated');
}

function broadcastEdit(id) {
  if (!chan || chanPageId !== id) return;
  const send = () => {
    if (chan && chanPageId === id) chan.send({ type: 'broadcast', event: 'edit', payload: { html: $('#doc-editor')?.innerHTML || '', from: myKey } });
  };
  clearTimeout(bcT);
  const now = Date.now();
  if (now - lastBc > BROADCAST_MS) {
    lastBc = now;
    send();
  } else
    bcT = setTimeout(() => {
      lastBc = Date.now();
      send();
    }, BROADCAST_MS);
}

/* ---------- WYSIWYG toolbar (data-dcmd, mirrors notes) ---------- */
const DOCS_CMDS = {
  bold: ['bold'],
  italic: ['italic'],
  underline: ['underline'],
  strike: ['strikeThrough'],
  h2: ['formatBlock', '<h2>'],
  h3: ['formatBlock', '<h3>'],
  ul: ['insertUnorderedList'],
  ol: ['insertOrderedList'],
  quote: ['formatBlock', '<blockquote>'],
  code: ['formatBlock', '<pre>'],
  removefmt: ['removeFormat'],
  undo: ['undo'],
  redo: ['redo'],
};

function afterDocCmd(ed) {
  commitLive(ed.dataset.id);
  updateCounts(ed);
  setSavedLabel('Saving…');
  scheduleAutosave(ed.dataset.id);
  broadcastEdit(ed.dataset.id);
}

document.addEventListener('mousedown', e => {
  const b = e.target.closest('[data-dcmd]');
  if (!b) return;
  e.preventDefault();
  const ed = $('#doc-editor');
  if (!ed) return;
  const c = b.dataset.dcmd;
  ed.focus();
  if (c === 'docLink') return docLinkBar(ed);
  if (c === 'unlink') {
    document.execCommand('unlink', false, null);
    return afterDocCmd(ed);
  }
  const [cmd, arg] = DOCS_CMDS[c] || [];
  if (!cmd) return;
  document.execCommand(cmd, false, arg || null);
  afterDocCmd(ed);
});

/* ---------- link insertion (same pattern as notes: popover, allowlist) ---------- */
function docLinkBar(ed) {
  document.getElementById('doc-linkbar')?.remove();
  const sel = document.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const startEl = range ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) : null;
  const anchor = startEl?.closest?.('a') || null;
  const wrap = ed.parentElement;
  if (!wrap) return;
  const bar = document.createElement('div');
  bar.id = 'doc-linkbar';
  bar.className = 'note-linkbar';
  bar.innerHTML = `${ic('link', 14)}<input class="input" id="doc-link-url" placeholder="https://…" aria-label="Link URL" value="${esc(anchor?.getAttribute('href') || '')}">
    <button type="button" class="btn btn-primary btn-sm" data-lk="add">${anchor ? 'Update link' : 'Add link'}</button>
    ${anchor ? '<button type="button" class="btn btn-secondary btn-sm" data-lk="rm">Remove link</button>' : ''}
    <button type="button" class="ibtn ibtn-sm" data-lk="x" aria-label="Cancel link">${ic('x', 14)}</button>`;
  wrap.insertBefore(bar, ed);
  const input = bar.querySelector('#doc-link-url');
  input.focus();
  input.select();
  const restoreSel = () => {
    ed.focus();
    if (range) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
  const safeUrl = v => {
    const s = String(v || '').trim();
    return /^(https?:\/\/|mailto:)/i.test(s) ? s : '';
  };
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-lk]');
    if (!b) return;
    const op = b.dataset.lk;
    if (op === 'x') {
      bar.remove();
      ed.focus();
      return;
    }
    if (op === 'rm') {
      restoreSel();
      document.execCommand('unlink', false, null);
      bar.remove();
      return afterDocCmd(ed);
    }
    if (op === 'add') {
      const url = safeUrl(input.value);
      if (!url) {
        toast('Use a full URL starting with https://', { kind: 'info' });
        return;
      }
      restoreSel();
      if (anchor) anchor.setAttribute('href', url);
      else if (range && !range.collapsed) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
      bar.remove();
      afterDocCmd(ed);
    }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      bar.remove();
      ed.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      bar.querySelector('[data-lk="add"]')?.click();
    }
  });
}

/* ---------- paste + drop: sanitize AT PASTE/DROP TIME (same gate as notes) ---------- */
document.addEventListener('paste', e => {
  const ed = e.target.closest?.('#doc-editor');
  if (!ed) return;
  const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
  if (!html) return;
  e.preventDefault();
  const clean = docsSanitize(html);
  if (clean) document.execCommand('insertHTML', false, clean);
  else document.execCommand('insertText', false, e.clipboardData.getData('text/plain') || '');
  afterDocCmd(ed);
});
document.addEventListener('drop', e => {
  const ed = e.target.closest?.('#doc-editor');
  if (!ed) return;
  const html = e.dataTransfer ? e.dataTransfer.getData('text/html') : '';
  if (!html) return;
  e.preventDefault();
  const clean = docsSanitize(html);
  if (clean) document.execCommand('insertHTML', false, clean);
  else document.execCommand('insertText', false, e.dataTransfer.getData('text/plain') || '');
  afterDocCmd(ed);
});

/* ---------- CRUD (AC1) ---------- */
async function insertPage(parentId) {
  if (!needDocs()) return null;
  const wsId = await ensureWsId();
  if (!wsId) {
    toast("Can't reach the server.", { kind: 'err' });
    return null;
  }
  const position = nextDocPosition(DC.rows, parentId);
  const { data, error } = await sb
    .from(DOCS_TABLE)
    .insert({ workspace_id: wsId, parent_id: parentId || null, position, title: '' })
    .select()
    .single();
  if (error) {
    toast(`Could not create the page — ${errMessage(error)}`, { kind: 'err' });
    return null;
  }
  return makeDocPage(data);
}

A.docsNew = async () => {
  flushDocDraft();
  const page = await insertPage(null);
  if (!page) return;
  invalidateDocsRows();
  goDocs(page.id);
  setTimeout(() => $('#doc-title')?.focus(), 0);
};

A.docsNewChild = async el => {
  flushDocDraft();
  const page = await insertPage(el.dataset.id || null);
  if (!page) return;
  invalidateDocsRows();
  S.ui.docsOpen[el.dataset.id] = true;
  goDocs(page.id);
  setTimeout(() => $('#doc-title')?.focus(), 0);
};

A.docsSel = el => {
  flushDocDraft();
  goDocs(el.dataset.id || '');
};

function goDocs(id) {
  go('docs', { id: id || '' });
}

A.docsToggle = el => {
  S.ui.docsOpen[el.dataset.id] = !S.ui.docsOpen[el.dataset.id];
  render();
};

A.docsTrash = el => {
  const id = el.dataset.id;
  const row = DC.rows.find(r => r.id === id) || (DC.sel && DC.sel.id === id ? DC.sel : null);
  confirmDlg({
    title: 'Move page to trash?',
    body: `“${esc(row?.title || DOC_UNTITLED)}” moves to trash. You can restore it from there.`,
    ok: 'Move to trash',
    danger: true,
    run: async () => {
      if (!needDocs()) return;
      const { error } = await sb.from(DOCS_TABLE).update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) return toast(`Could not trash the page — ${errMessage(error)}`, { kind: 'err' });
      invalidateDocsRows();
      DC.trashState = 'idle';
      if (DC.selId === id) {
        DC.sel = null;
        DC.selId = '';
        DC.selState = 'idle';
        goDocs('');
      } else render();
      toast('Page moved to trash');
    },
  });
};

A.docsRestore = async el => {
  if (!needDocs()) return;
  const { error } = await sb.from(DOCS_TABLE).update({ deleted_at: null }).eq('id', el.dataset.id);
  if (error) return toast(`Could not restore the page — ${errMessage(error)}`, { kind: 'err' });
  invalidateDocsRows();
  DC.trashState = 'idle';
  render();
  toast('Page restored');
};

A.docsMove = el => {
  openModal({ type: 'docsMove', id: el.dataset.id });
};

A.docsMoveGo = async el => {
  if (!needDocs()) return;
  const id = el.dataset.id;
  const parentVal = $('#docs-move-parent')?.value ?? '';
  const parentId = parentVal || null;
  const position = nextDocPosition(DC.rows, parentId);
  const { error } = await sb.from(DOCS_TABLE).update({ parent_id: parentId, position }).eq('id', id);
  if (error) return toast(`Could not move the page — ${errMessage(error)}`, { kind: 'err' });
  closeModal();
  invalidateDocsRows();
  render();
  toast('Page moved');
};

/* ---------- version history (AC5) ---------- */
A.docsVersions = () => {
  if (!DC.sel) return;
  if (S.ui.docs.versionsOpen) {
    S.ui.docs.versionsOpen = false;
    DC.versions = null;
    DC.preview = '';
    return render();
  }
  S.ui.docs.versionsOpen = true;
  DC.versions = null;
  DC.versionsState = 'idle';
  DC.preview = '';
  render();
  ensureDocVersions();
};

export async function ensureDocVersions() {
  if (!DC.sel || !S.ui.docs.versionsOpen || !sb) return;
  const pageId = DC.sel.id;
  if (DC.versions && DC.versions.pageId === pageId && DC.versionsState !== 'idle') return;
  DC.versions = { pageId, rows: [] };
  DC.versionsState = 'loading';
  render();
  try {
    const { data, error } = await sb
      .from(VERSIONS_TABLE)
      .select('id, page_id, title, content_html, kind, created_by, created_at')
      .eq('page_id', pageId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    DC.versions = { pageId, rows: data || [] };
    DC.versionsState = 'ok';
  } catch (e) {
    DC.versionsState = 'error';
    DC.versionsError = errMessage(e, 'Could not load versions.');
  }
  render();
}

A.docsVersionPreview = el => {
  DC.preview = DC.preview === el.dataset.id ? '' : el.dataset.id;
  render();
};

A.docsVersionRestore = el => {
  const v = (DC.versions?.rows || []).find(x => x.id === el.dataset.id);
  const p = DC.sel;
  if (!v || !p || !needDocs()) return;
  confirmDlg({
    title: 'Restore this version?',
    body: 'The current content is snapshotted first (kind “restore”), then this version is written back.',
    ok: 'Restore version',
    run: async () => {
      const snap = await sb.from(VERSIONS_TABLE).insert({
        workspace_id: p.workspace_id,
        page_id: p.id,
        title: p.title,
        content_html: p.content_html,
        kind: 'restore',
        created_by: getCurrentUser(),
      });
      if (snap.error) return toast(`Could not snapshot the current content — ${errMessage(snap.error)}`, { kind: 'err' });
      const title = typeof v.title === 'string' ? v.title : '';
      const html = docsSanitize(typeof v.content_html === 'string' ? v.content_html : '');
      const { data, error } = await sb
        .from(DOCS_TABLE)
        .update({ title, content_html: html, content_text: docTextFromHtml(html) })
        .eq('id', p.id)
        .eq('version', Number(p.version) || 0)
        .select();
      if (error || !data || !data.length) return toast('Restore failed — the page changed meanwhile. Try again.', { kind: 'err' });
      const fixed = makeDocPage(data[0]);
      if (fixed) Object.assign(p, fixed);
      DC.newestSnapshotAt = Date.now();
      DC.preview = '';
      invalidateDocsRows();
      DC.versionsState = 'idle'; /* re-arm: the restore snapshot must appear in the panel */
      render();
      ensureDocVersions();
      toast('Version restored');
    },
  });
};

/* ---------- search (AC6, tsvector) ---------- */
let searchT = null;

IN.docsQ = el => {
  S.ui.docs.q = el.value;
  DC.search = null; /* re-arm for the new query */
  render();
  clearTimeout(searchT);
  searchT = setTimeout(runDocsSearch, 300);
};

export async function runDocsSearch() {
  const q = (S.ui.docs.q || '').trim();
  if (!q || !sb) {
    DC.search = null;
    return;
  }
  if (DC.search && DC.search.q === q && DC.search.state !== 'idle') return;
  DC.search = { q, rows: [], state: 'loading' };
  render();
  try {
    const wsId = await ensureWsId();
    /* Stale response: the user typed a new query while this one was in flight. */
    if ((S.ui.docs.q || '').trim() !== q) return;
    const { data, error } = await sb
      .from(DOCS_TABLE)
      .select('id, title, content_text, updated_at')
      .eq('workspace_id', wsId)
      .is('deleted_at', null)
      .textSearch('search', q, { type: 'websearch', config: 'english' })
      .limit(20);
    if (error) throw error;
    DC.search = { q, rows: data || [], state: 'ok' };
  } catch (e) {
    DC.search = { q, rows: [], state: 'error', error: errMessage(e, 'Search failed.') };
  }
  render();
}

A.docsQClear = () => {
  S.ui.docs.q = '';
  DC.search = null;
  clearTimeout(searchT);
  render();
  setTimeout(() => $('#doc-search')?.focus(), 0);
};

A.docsSearchRetry = () => {
  DC.search = null;
  runDocsSearch();
};

/* ---------- trash (AC1) ---------- */
A.docsTrashToggle = () => {
  S.ui.docs.trash = !S.ui.docs.trash;
  DC.trashState = 'idle';
  DC.trash = [];
  DC.trashError = '';
  render();
};

export async function ensureDocsTrash() {
  if (!S.ui.docs.trash || !sb) return;
  if (!shouldFetchState(DC.trashState)) return;
  DC.trashState = 'loading';
  render();
  try {
    const wsId = await ensureWsId();
    const { data, error } = await sb
      .from(DOCS_TABLE)
      .select('id, parent_id, title, icon, position, created_at, updated_at, deleted_at')
      .eq('workspace_id', wsId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    DC.trash = (data || []).map(makeDocPage).filter(Boolean);
    DC.trashState = 'ok';
  } catch (e) {
    DC.trashState = 'error';
    DC.trashError = errMessage(e, 'Could not load the trash.');
  }
  render();
}

/* ---------- Granola import + connection (AC7) ---------- */
export async function ensureGranolaStatus() {
  if (!sb || DC.granolaState !== 'idle') return; /* ok/error are terminal until A.docsImport re-arms */
  DC.granolaState = 'loading';
  try {
    const wsId = await ensureWsId();
    const c = await sb
      .from(DOCS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId)
      .is('deleted_at', null)
      .eq('source->>kind', 'granola');
    if (c.error) throw c.error;
    const v = await sb
      .from(VERSIONS_TABLE)
      .select('created_at')
      .eq('workspace_id', wsId)
      .eq('kind', 'import')
      .order('created_at', { ascending: false })
      .limit(1);
    if (v.error) throw v.error;
    DC.granola = { count: c.count || 0, lastAt: v.data && v.data[0] ? new Date(v.data[0].created_at).getTime() : null };
    DC.granolaState = 'ok';
  } catch {
    DC.granola = null;
    DC.granolaState = 'error';
  }
  render();
}

A.docsImport = async () => {
  if (!needDocs()) return;
  DC.granola = undefined;
  DC.granolaState = 'idle';
  await ensureGranolaStatus();
  openModal({ type: 'docsImport', granola: DC.granola });
};

IN.docsImportFile = async el => {
  const file = el.files && el.files[0];
  el.value = '';
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    toast(`“${esc(file.name)}” is over the 10 MB import limit and was not imported.`, { kind: 'err' });
    return;
  }
  if (!needDocs()) return;
  const wsId = await ensureWsId();
  if (!wsId) {
    toast("Can't reach the server.", { kind: 'err' });
    return;
  }
  let items;
  try {
    items = parseGranolaExport(await file.text(), Date.now());
  } catch {
    items = [];
  }
  if (!items.length) {
    toast('No pages found in that file — is it a Granola export (.md or .json)?', { kind: 'err' });
    return;
  }
  const plan = granolaImportPlan(items, DC.rows, Date.now());
  const me = getCurrentUser();
  let failures = 0;
  for (const c of plan.creates) {
    const html = docsSanitize(c.html);
    const ins = await sb
      .from(DOCS_TABLE)
      .insert({
        workspace_id: wsId,
        parent_id: null,
        position: nextDocPosition(DC.rows, null),
        title: c.title,
        content_html: html,
        content_text: c.content_text,
        source: c.source,
      })
      .select()
      .single();
    if (ins.error || !ins.data) {
      failures++;
      continue;
    }
    DC.rows.push(makeDocPage(ins.data)); /* later creates position against it */
    await sb.from(VERSIONS_TABLE).insert({ workspace_id: wsId, page_id: ins.data.id, title: c.title, content_html: html, kind: 'import', created_by: me });
  }
  for (const u of plan.updates) {
    const html = docsSanitize(u.html);
    const cur = DC.rows.find(r => r.id === u.id);
    const up = await sb
      .from(DOCS_TABLE)
      .update({ title: u.title, content_html: html, content_text: u.content_text })
      .eq('id', u.id)
      .eq('version', (cur && Number(cur.version)) || 0)
      .select();
    if (up.error || !up.data || !up.data.length) {
      failures++;
      continue;
    }
    await sb.from(VERSIONS_TABLE).insert({ workspace_id: wsId, page_id: u.id, title: u.title, content_html: html, kind: 'import', created_by: me });
  }
  closeModal();
  invalidateDocsRows();
  /* A re-imported page that is OPEN right now must re-fetch on the next
     render, or its editor autosaves the pre-import content over the import. */
  if (DC.selId && plan.updates.some(u => u.id === DC.selId)) {
    DC.selState = 'idle';
    DC.newestSnapshotAt = null;
  }
  DC.granola = undefined;
  DC.granolaState = 'idle';
  render();
  if (failures) toast(`Import finished with ${failures} page(s) skipped (they changed elsewhere — re-run the import).`, { kind: 'err' });
  else
    toast(
      `Imported ${plan.creates.length} new page${plan.creates.length === 1 ? '' : 's'}${plan.updates.length ? `, updated ${plan.updates.length} in place` : ''}.`,
    );
};

/* ---------- retry actions (reset exactly one fetch) ---------- */
A.docsRetry = () => {
  invalidateDocsRows();
  render();
};
A.docsTrashRetry = () => {
  DC.trashState = 'idle';
  render();
};
A.docsVersionsRetry = () => {
  DC.versionsState = 'idle';
  DC.versions = null;
  render();
  ensureDocVersions();
};
A.docsSelRetry = () => {
  DC.selState = 'idle';
  ensureDocSel(DC.selId);
};
