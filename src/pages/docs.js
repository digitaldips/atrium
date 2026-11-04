/* =====================================================================
   DOCS · page tree + WYSIWYG editor + versions + search + Granola import
   Two-pane like Notes: tree on the left, editor on the right. Page rows
   come from Postgres (docs_pages/docs_versions, migration 0005) through
   the session-only cache DC (src/actions/docs.js) — the workspace
   document gains NO new keys. Every untrusted string is esc()'d;
   content_html renders ONLY through docsSanitize (same sanitizer
   contract as notes, at save AND render). The editor reuses the notes
   toolbar/editor CSS and execCommand vocabulary with data-dcmd so the
   notes handlers never cross wires.
   ===================================================================== */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { DOC_UNTITLED, buildDocTree, descendantIds, docSnippet, docTextFromHtml } from '../core/docs.js';
import { docsSanitize } from '../core/sanitize.js';
import { DC, ensureDocSel, ensureDocsRows, ensureDocsTrash, ensureGranolaStatus, getCurrentUserId } from '../actions/docs.js';
import { empty } from '../ui/helpers.js';

/* Toolbar vocabulary — same commands as notes, data-dcmd attributes. */
const TOOLS = [
  ['bold', 'bold', 'Bold (Ctrl/⌘+B)'],
  ['italic', 'italic', 'Italic (Ctrl/⌘+I)'],
  ['underline', 'underline', 'Underline'],
  ['strike', 'strikethrough', 'Strikethrough'],
  ['sep'],
  ['h2', 'heading-2', 'Heading 2'],
  ['h3', 'heading-3', 'Heading 3'],
  ['sep'],
  ['ul', 'list', 'Bulleted list'],
  ['ol', 'list-ordered', 'Numbered list'],
  ['quote', 'text-quote', 'Quote'],
  ['code', 'code', 'Code block'],
  ['sep'],
  ['docLink', 'link', 'Link (Ctrl/⌘+K)'],
  ['unlink', 'unlink', 'Remove link'],
  ['removefmt', 'remove-formatting', 'Remove formatting'],
  ['sep'],
  ['undo', 'undo-2', 'Undo'],
  ['redo', 'redo-2', 'Redo'],
];

const toolBtn = ([c, i, n]) =>
  c === 'sep'
    ? '<span class="nsep" aria-hidden="true"></span>'
    : `<button type="button" class="ibtn ibtn-sm" data-dcmd="${c}" data-tip="${n}" aria-label="${n}">${ic(i, 14)}</button>`;

const ms = ts => {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : 0;
};

function ensureDocsUi() {
  if (!S.ui.docs) S.ui.docs = { q: '', trash: false, versionsOpen: false };
  if (!S.ui.docsOpen) S.ui.docsOpen = {};
}

export function pageDocs() {
  ensureDocsUi();
  const u = S.ui;
  const q = u.docs.q || '';
  const selId = u.params.id || '';
  /* Fetch orchestrators — every one gates on a settled state, so calling
     them on each render is safe (render → fetch → render terminates). */
  ensureDocsRows();
  ensureDocSel(selId);
  if (u.docs.trash && !q) ensureDocsTrash();
  if (!selId && !q && !u.docs.trash) ensureGranolaStatus();
  return `<div class="page flush">
    <div style="display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);flex:1;min-height:0" class="notes-grid">
      <style>@media(max-width:900px){.notes-grid{grid-template-columns:minmax(0,1fr)!important}.docs-prev{display:${selId ? 'flex' : 'none'}!important;position:fixed;inset:0;z-index:48;background:var(--surface)}}</style>
      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
        <div style="padding:18px var(--gutter) 0" class="row"><h1 style="font-size:var(--fs-xl);margin:0;font-weight:600;letter-spacing:-.015em">Docs</h1><span class="sp"></span>
          <button class="btn btn-ghost btn-sm" data-a="docsImport">${ic('upload', 13)}Granola</button>
          <button class="btn btn-primary btn-sm" data-a="docsNew">${ic('plus', 13)}New page</button></div>
        <div class="row" style="padding:10px var(--gutter);gap:6px;border-bottom:1px solid var(--divider)">
          <input class="input" id="doc-search" data-in="docsQ" placeholder="Search pages" value="${esc(q)}" aria-label="Search pages" style="height:32px;font-size:13px;padding:6px 10px">
          ${q ? `<button class="btn btn-ghost btn-sm" data-a="docsQClear">${ic('x', 13)}Clear</button>` : `<button class="btn btn-ghost btn-sm ${u.docs.trash ? 'btn-primary' : ''}" data-a="docsTrashToggle" aria-pressed="${u.docs.trash ? 'true' : 'false'}">${ic('trash-2', 13)}Trash</button>`}
        </div>
        <div class="inbox-list" data-keep="docs-list">${listArea(q, selId)}</div>
      </div>
      <div class="docs-prev" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">${editorArea(selId)}</div>
    </div>
  </div>`;
}

/* ---------- left pane: tree / search results / trash ---------- */

function listArea(q, selId) {
  if (q) return searchArea(q);
  if (S.ui.docs.trash) return trashArea();
  return treeArea(selId);
}

function fetchState(state, err, retryA) {
  if (state === 'loading')
    return '<div class="row" style="padding:14px var(--gutter);gap:8px" class="muted"><span class="faint" style="font-size:12.5px">Loading…</span></div>';
  if (state === 'error')
    return `<div class="row" style="padding:14px var(--gutter);gap:8px;align-items:center"><span class="muted" style="font-size:12.5px">${esc(err || 'Could not load.')}</span><span class="sp"></span><button class="btn btn-secondary btn-sm" data-a="${retryA}">Retry</button></div>`;
  return '';
}

function treeArea(selId) {
  const st = fetchState(DC.rowsState, DC.rowsError, 'docsRetry');
  if (st && DC.rowsState !== 'ok') return st;
  if (!DC.rows.length)
    return empty(
      'file-text',
      'No pages yet',
      'Create your first page — nest sub-pages, and everything autosaves. Import existing notes from Granola with the button above.',
      `<button class="btn btn-primary btn-sm" data-a="docsNew">${ic('plus', 14)}New page</button>`,
      'sm',
      3,
    );
  return buildDocTree(DC.rows)
    .map(n => treeNode(n, selId))
    .join('');
}

function treeNode(n, selId) {
  const open = !!S.ui.docsOpen[n.id];
  const on = selId === n.id;
  const kids = open && n.children.length ? n.children.map(c => treeNode(c, selId)).join('') : '';
  return `<div>
    <div class="row" style="padding:7px 8px 7px ${10 + n.depth * 16}px;gap:4px;cursor:pointer;border-bottom:1px solid var(--divider);${on ? 'background:var(--surface-2);' : ''}" data-a="docsSel" data-id="${esc(n.id)}" role="button" tabindex="0">
      ${n.children.length ? `<button class="ibtn ibtn-xs" data-a="docsToggle" data-id="${esc(n.id)}" aria-label="Toggle sub-pages" aria-expanded="${open ? 'true' : 'false'}">${ic('chevron-right', 12, 'chev ' + (open ? 'open' : ''))}</button>` : '<span style="width:19px;flex-shrink:0"></span>'}
      <span class="faint" style="flex-shrink:0">${ic(n.icon || 'file-text', 13)}</span>
      <span class="trunc" data-dtitle="${esc(n.id)}" style="font-size:13px;${on ? 'font-weight:600' : ''}">${esc(n.title || DOC_UNTITLED)}</span>
      <span class="sp"></span>
      <span style="display:inline-flex;gap:2px;flex-shrink:0">
        <button class="ibtn ibtn-xs" data-a="docsNewChild" data-id="${esc(n.id)}" data-tip="New sub-page" aria-label="New sub-page under ${esc(n.title || DOC_UNTITLED)}">${ic('file-plus-2', 12)}</button>
        <button class="ibtn ibtn-xs" data-a="docsMove" data-id="${esc(n.id)}" data-tip="Move page" aria-label="Move ${esc(n.title || DOC_UNTITLED)}">${ic('folder-input', 12)}</button>
        <button class="ibtn ibtn-xs" data-a="docsTrash" data-id="${esc(n.id)}" data-tip="Move to trash" aria-label="Trash ${esc(n.title || DOC_UNTITLED)}">${ic('trash-2', 12)}</button>
      </span>
    </div>
    ${kids}
  </div>`;
}

function searchArea(q) {
  const res = DC.search;
  if (!res || res.state === 'loading')
    return '<div class="row" style="padding:14px var(--gutter)"><span class="faint" style="font-size:12.5px">Searching…</span></div>';
  if (res.state === 'error')
    return `<div class="row" style="padding:14px var(--gutter);gap:8px;align-items:center"><span class="muted" style="font-size:12.5px">${esc(res.error)}</span><span class="sp"></span><button class="btn btn-secondary btn-sm" data-a="docsSearchRetry">Retry</button></div>`;
  if (!res.rows.length) return empty('search', 'No pages match', `Nothing matches “${q}”. Search covers titles and page text.`, '', 'sm', 3);
  return res.rows
    .map(r => {
      const snip = docSnippet(r.content_text, q);
      return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer" data-a="docsSel" data-id="${esc(r.id)}" role="button" tabindex="0">
      <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
        <div class="trunc" style="font-weight:600">${esc(r.title || DOC_UNTITLED)}</div>
        <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${snip ? esc(snip) : '<span class="faint">Empty page</span>'}</div>
      </div>
    </div>`;
    })
    .join('');
}

function trashArea() {
  const st = fetchState(DC.trashState, DC.trashError, 'docsTrashRetry');
  if (st && DC.trashState !== 'ok') return st;
  if (!DC.trash.length) return empty('trash-2', 'Trash is empty', 'Pages you trash land here and can be restored any time.', '', 'sm', 3);
  return DC.trash
    .map(
      r => `<div class="row" style="padding:10px var(--gutter);border-bottom:1px solid var(--divider);gap:8px">
      <span class="faint">${ic('file-text', 13)}</span>
      <span class="trunc" style="font-size:13px">${esc(r.title || DOC_UNTITLED)}</span>
      <span class="faint" style="font-size:11.5px;flex-shrink:0">trashed ${r.deleted_at ? ago(ms(r.deleted_at)) : ''}</span>
      <span class="sp"></span>
      <button class="btn btn-secondary btn-sm" data-a="docsRestore" data-id="${esc(r.id)}">${ic('rotate-ccw', 12)}Restore</button>
    </div>`,
    )
    .join('');
}

/* ---------- right pane: editor / empty state ---------- */

function editorArea(selId) {
  if (S.ui.docs.trash && !selId)
    return `<div class="fullstate"><div class="box">${empty('trash-2', 'Trash', 'Restore pages back into the tree from here.', '', '', 2)}</div></div>`;
  if (!selId)
    return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('file-text', 20)}</div><h2 class="es-h">Select a page</h2><p>Pick a page from the tree, or start a new one. Pages autosave as you type.</p></div>${granolaCard(DC.granola)}</div></div>`;
  if (DC.selState === 'loading' || (DC.selId !== selId && DC.selState !== 'idle'))
    return '<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><p class="faint">Loading page…</p></div></div></div>';
  if (DC.selState === 'error')
    return `<div class="fullstate"><div class="box">${empty('circle-alert', 'Could not load this page', DC.selError || 'Check your connection and retry.', '<button class="btn btn-secondary btn-sm" data-a="docsSelRetry">Retry</button>', '', 2)}</div></div>`;
  if (!DC.sel)
    return `<div class="fullstate"><div class="box">${empty('file-text', 'Page not found', 'It may have been deleted in another tab.', '', '', 2)}</div></div>`;
  return docEditor(DC.sel);
}

/* The editor pane. The body renders the page's html THROUGH the sanitizer
   (defense in depth — stored bytes are never trusted at render either). */
function presenceText() {
  return DC.presence.length ? `${DC.presence.join(', ')} ${DC.presence.length === 1 ? 'is' : 'are'} here` : '';
}

function docEditor(p) {
  const text = docTextFromHtml(p.content_html);
  const words = text ? text.split(/\s+/).length : 0;
  const versions = DC.versions && DC.versions.pageId === p.id ? DC.versions.rows : null;
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <span class="av sm" style="--c:var(--accent)" aria-hidden="true">${ic('file-text', 12)}</span><span class="muted" style="font-size:12.5px">Page</span>
      <span id="doc-presence" class="faint" style="font-size:11.5px" role="status">${esc(presenceText())}</span><span class="sp"></span>
      <span id="doc-saved" class="faint" style="font-size:11.5px" role="status">Saved</span>
      <button class="btn btn-secondary btn-sm ${S.ui.docs.versionsOpen ? 'btn-primary' : ''}" data-a="docsVersions" aria-pressed="${S.ui.docs.versionsOpen ? 'true' : 'false'}">${ic('history', 13)}History</button>
      <button class="btn btn-danger-ghost btn-sm" data-a="docsTrash" data-id="${esc(p.id)}">${ic('trash-2', 13)}Trash</button>
    </div>
    <div style="padding:18px 28px 24px;max-width:820px;width:100%;display:flex;flex-direction:column;flex:1;min-height:0">
      <input class="input note-title-in" id="doc-title" data-in="docsTitle" data-id="${esc(p.id)}" value="${esc(p.title)}" placeholder="${DOC_UNTITLED}" aria-label="Page title">
      <div class="note-toolbar" role="toolbar" aria-label="Formatting" aria-controls="doc-editor">${TOOLS.map(toolBtn).join('')}</div>
      <div class="note-editor-wrap"><div class="rte-body note-editor-body" id="doc-editor" contenteditable="true" data-in="docsBody" data-id="${esc(p.id)}" data-ph="Start writing…" role="textbox" aria-multiline="true" aria-label="Page body">${docsSanitize(p.content_html)}</div></div>
      <div class="row note-footer">
        <span id="doc-count" class="faint" style="font-size:11.5px">${words} ${words === 1 ? 'word' : 'words'}</span>
        <span class="sp"></span>
        <span class="faint" style="font-size:11.5px">v${Number(p.version) || 0} · updated ${p.updated_at ? ago(ms(p.updated_at)) : 'just now'}</span>
      </div>
      ${versionsPanel(p, versions)}
    </div>`;
}

/* ---------- version history panel (AC5) ---------- */

const KIND_LABEL = { auto: 'Auto snapshot', restore: 'Before restore', import: 'Import' };

function versionsPanel(p, rows) {
  if (!S.ui.docs.versionsOpen) return '';
  let body;
  if (!rows || DC.versionsState === 'loading') body = '<p class="faint" style="font-size:12px">Loading versions…</p>';
  else if (DC.versionsState === 'error')
    body = `<div class="row" style="gap:8px"><span class="muted" style="font-size:12px">${esc(DC.versionsError || 'Could not load versions.')}</span><button class="btn btn-secondary btn-sm" data-a="docsVersionsRetry">Retry</button></div>`;
  else if (!rows.length)
    body =
      '<p class="faint" style="font-size:12px;margin:0">No snapshots yet. One is taken automatically when the page changes and the newest snapshot is at least 10 minutes old.</p>';
  else
    body = rows
      .map(v => {
        const open = DC.preview === v.id;
        const author = v.created_by === getCurrentUserId() ? esc(S.prefs.name || 'You') : 'Member';
        return `<div class="note-att" style="align-items:flex-start">
        <span class="lblbadge sys" style="flex-shrink:0">${ic('history', 11)}${KIND_LABEL[v.kind] || v.kind}</span>
        <div class="grow" style="min-width:0">
          <div class="trunc" style="font-size:12.5px;font-weight:500">${esc(v.title || DOC_UNTITLED)}</div>
          <div class="faint" style="font-size:11px">${author} · ${v.created_at ? ago(ms(v.created_at)) : ''}</div>
          ${open ? `<div class="doc-vprev" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px;max-height:260px;overflow:auto;font-size:13px">${docsSanitize(v.content_html) || '<span class="faint">Empty snapshot</span>'}</div>` : ''}
        </div>
        <button class="ibtn ibtn-xs" data-a="docsVersionPreview" data-id="${esc(v.id)}" data-tip="${open ? 'Hide preview' : 'Preview'}" aria-label="${open ? 'Hide preview' : 'Preview version'}" aria-expanded="${open ? 'true' : 'false'}">${ic(open ? 'eye' : 'eye', 12)}</button>
        <button class="btn btn-secondary btn-sm" data-a="docsVersionRestore" data-id="${esc(v.id)}">${ic('rotate-ccw', 12)}Restore</button>
      </div>`;
      })
      .join('');
  return `<div class="note-atts" style="margin-top:14px">
    <div class="row" style="margin-bottom:8px"><div class="eyebrow">Version history · ${rows ? rows.length : ''}</div></div>
    ${body}
  </div>`;
}

/* ---------- Granola connection card (AC7) ---------- */
/* Honest status derived from Postgres (no API exists): never connected, or
   last import time + live granola page count. */
export function granolaCard(g) {
  const status = g
    ? g.count > 0
      ? `<span class="lblbadge sys">${ic('check', 11)}</span><span>Connected via export · ${g.count} page${g.count === 1 ? '' : 's'}${g.lastAt ? ` · last import ${ago(g.lastAt)}` : ''}</span>`
      : '<span class="muted">Never connected</span>'
    : g === null
      ? '<span class="muted">Status unavailable — retry from the import dialog</span>'
      : '<span class="faint" style="font-size:12px">Checking connection…</span>';
  return `<div class="note-atts" style="max-width:520px;text-align:left">
    <div class="eyebrow">Granola connection</div>
    <div class="row" style="gap:8px;font-size:12.5px;margin-top:6px">${status}</div>
    <p class="faint" style="font-size:11.5px;margin:6px 0 0">Granola has no public API — the import runs from an export file. In Granola, export your notes (Markdown or JSON), then upload the file here. Re-importing the same export updates your pages in place (deduped by source id).</p>
    <div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-secondary btn-sm" data-a="docsImport">${ic('upload', 13)}Import from Granola…</button></div>
  </div>`;
}

/* ---------- modals (registered in overlays/modals.js) ---------- */

export function docsMoveModal(m, H) {
  const cur = DC.rows.find(r => r.id === m.id);
  const banned = descendantIds(DC.rows, m.id);
  const options = DC.rows.filter(r => r.id !== m.id && !banned.has(r.id));
  return `${H('Move page', esc(cur?.title || DOC_UNTITLED))}
    <div class="modal-b">
      <div class="field"><label class="label" for="docs-move-parent">Parent page</label>
        <select class="input" id="docs-move-parent" autofocus>
          <option value="">Top level (no parent)</option>
          ${options.map(r => `<option value="${esc(r.id)}" ${cur?.parent_id === r.id ? 'selected' : ''}>${esc(r.title || DOC_UNTITLED)}</option>`).join('')}
        </select>
        <p class="faint" style="font-size:11.5px;margin:6px 0 0">The page itself and its sub-pages are not offered as parents (that would loop the tree).</p>
      </div>
    </div>
    <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="docsMoveGo" data-id="${esc(m.id)}">Move</button></div>`;
}

export function docsImportModal(m, H) {
  return `${H('Import from Granola', 'Granola has no public API — import runs from an export file')}
    <div class="modal-b">
      ${granolaCard(m.granola)}
      <div class="field" style="margin-top:14px"><label class="label" for="docs-import-file">Granola export file (.md or .json, up to 10 MB)</label>
        <input class="input" id="docs-import-file" type="file" accept=".md,.json,text/markdown,application/json" data-in="docsImportFile" style="padding-top:7px" autofocus>
      </div>
      <p class="faint" style="font-size:11.5px;margin:6px 0 0">Pages land at the top level of the tree. Each imported page gets a first snapshot (kind “import”).</p>
    </div>
    <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Close</button></div>`;
}
