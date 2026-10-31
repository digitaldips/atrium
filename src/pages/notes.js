/* ---------- NOTES (two-pane list + WYSIWYG editor) ---------- */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, noteById } from '../core/store.js';
import { UNTITLED, noteSnippet, noteTextFromHtml, noteTitleFromHtml, searchNotes, sortNotes } from '../core/notes.js';
import { sanitizeNoteHtml } from '../core/sanitize.js';
import { FT, empty, fileType, fsize } from '../ui/helpers.js';

/* The list label: the stored title, else the note's own first heading/
   paragraph, else the honest fallback. Escaped by the caller template. */
const listTitle = n => n.title || noteTitleFromHtml(n.html) || UNTITLED;

/* Toolbar vocabulary — [ncmd, icon, label]. Links get their own popover
   (URL prompt + scheme allowlist); undo/redo ride the contenteditable's
   native stack. Zero new dependencies: document.execCommand throughout. */
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
  ['noteLink', 'link', 'Link (Ctrl/⌘+K)'],
  ['unlink', 'unlink', 'Remove link'],
  ['removefmt', 'remove-formatting', 'Remove formatting'],
  ['sep'],
  ['undo', 'undo-2', 'Undo'],
  ['redo', 'redo-2', 'Redo'],
];

const toolBtn = ([c, i, n]) =>
  c === 'sep'
    ? '<span class="nsep" aria-hidden="true"></span>'
    : `<button type="button" class="ibtn ibtn-sm" data-ncmd="${c}" data-tip="${n}" aria-label="${n}">${ic(i, 14)}</button>`;

export function pageNotes() {
  const q = S.ui.notesQ || '';
  const notes = sortNotes(searchNotes(D().notes || [], q));
  /* A selection that points at a note which no longer exists (deleted in
     another tab, undo…) degrades to the honest empty state. */
  const sel = noteById(S.ui.noteSel || S.ui.params?.id) || null;
  if (!sel && S.ui.noteSel) S.ui.noteSel = '';
  return `<div class="page flush">
    <div style="display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);flex:1;min-height:0" class="notes-grid">
      <style>@media(max-width:900px){.notes-grid{grid-template-columns:minmax(0,1fr)!important}.notes-prev{display:${sel ? 'flex' : 'none'}!important;position:fixed;inset:0;z-index:48;background:var(--surface)}}</style>
      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
        <div style="padding:18px var(--gutter) 0" class="row"><h1 style="font-size:var(--fs-xl);margin:0;font-weight:600;letter-spacing:-.015em">Notes</h1><span class="sp"></span>
          <button class="btn btn-primary btn-sm" data-a="noteNew">${ic('plus', 13)}New note</button></div>
        <div class="row" style="padding:10px var(--gutter);gap:6px;border-bottom:1px solid var(--divider)">
          <input class="input" id="note-search" data-in="noteQ" placeholder="Search notes" value="${esc(q)}" aria-label="Search notes" style="height:32px;font-size:13px;padding:6px 10px">
          ${q ? `<button class="btn btn-ghost btn-sm" data-a="noteQClear">${ic('x', 13)}Clear</button>` : ''}
        </div>
        <div class="inbox-list" data-keep="notes-list">${notesList(notes, sel, q)}</div>
      </div>
      <div class="notes-prev" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">${sel ? noteEditor(sel) : noteEmptyState()}</div>
    </div>
  </div>`;
}

function notesList(notes, sel, q) {
  if (!notes.length)
    return empty(
      'notebook-pen',
      q ? 'No notes match' : 'No notes yet',
      q
        ? `Nothing matches “${q}”. Try a different word — search covers titles and note text.`
        : 'Capture agendas, drafts and docs here. Click “New note” to start one.',
      q ? '' : `<button class="btn btn-primary btn-sm" data-a="noteNew">${ic('plus', 14)}New note</button>`,
      'sm',
      3,
    );
  return notes
    .map(n => {
      const on = sel && sel.id === n.id;
      const atts = (n.attachments || []).length;
      return `<div class="row" style="align-items:flex-start;gap:10px;padding:12px var(--gutter);border-bottom:1px solid var(--divider);cursor:pointer;position:relative;${on ? 'background:var(--surface-2);' : ''}" data-a="noteSel" data-id="${esc(n.id)}" role="button" tabindex="0">
    <span class="npin" style="margin-top:3px;color:${n.pinned ? 'var(--accent)' : 'var(--text-3)'}" title="${n.pinned ? 'Pinned' : ''}">${ic('pin', 13)}</span>
    <div class="grow" style="font-size:13px;line-height:1.45;min-width:0">
      <div class="row" style="gap:8px"><span class="trunc" data-rowtitle="${esc(n.id)}" style="${on ? '' : 'font-weight:600'}">${esc(listTitle(n))}</span><span class="sp"></span><span class="faint" style="font-size:11.5px;flex-shrink:0">${ago(n.updated)}</span></div>
      <div class="trunc muted" style="font-size:12.5px;margin-top:2px">${esc(noteSnippet(n.html)) || '<span class="faint">Empty note</span>'}</div>
      ${atts ? `<div class="row" style="gap:4px;margin-top:5px"><span class="lblbadge sys">${ic('paperclip', 11)}${atts}</span></div>` : ''}
    </div>
    <button class="ibtn ibtn-xs" data-a="notePin" data-id="${esc(n.id)}" data-tip="${n.pinned ? 'Unpin' : 'Pin to top'}" aria-label="${n.pinned ? 'Unpin note' : 'Pin note'}" style="margin-top:3px;${n.pinned ? 'color:var(--accent)' : ''}">${ic('pin', 13)}</button>
    <button class="ibtn ibtn-xs" data-a="noteDelete" data-id="${esc(n.id)}" data-tip="Delete note" aria-label="Delete note" style="margin-top:3px">${ic('trash-2', 13)}</button>
  </div>`;
    })
    .join('');
}

function noteEmptyState() {
  return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('notebook-pen', 20)}</div><h2 class="es-h">Select a note</h2><p>Pick a note from the list, or start a new one. Notes autosave as you type.</p></div></div></div>`;
}

/* The editor pane. The body renders the note's html THROUGH the sanitizer
   (defense in depth — saved bytes are never trusted at render either). */
function noteEditor(n) {
  const text = noteTextFromHtml(n.html);
  const words = text ? text.split(/\s+/).length : 0;
  return `<div class="row" style="height:46px;padding:0 16px;border-bottom:1px solid var(--border);gap:8px;flex-shrink:0">
      <button class="ibtn ibtn-sm" data-a="noteSel" data-id="" aria-label="Back to list">${ic('arrow-left', 15)}</button>
      <span class="av sm" style="--c:var(--accent)" aria-hidden="true">${ic('notebook-pen', 12)}</span><span class="muted" style="font-size:12.5px">Note</span><span class="sp"></span>
      <span id="note-saved" class="faint" style="font-size:11.5px" role="status">Saved</span>
      <button class="btn btn-secondary btn-sm" data-a="notePin" data-id="${esc(n.id)}">${ic('pin', 13)}${n.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="btn btn-danger-ghost btn-sm" data-a="noteDelete" data-id="${esc(n.id)}">${ic('trash-2', 13)}Delete</button>
    </div>
    <div style="padding:18px 28px 24px;max-width:820px;width:100%;display:flex;flex-direction:column;flex:1;min-height:0">
      <input class="input note-title-in" id="note-title" data-in="noteTitle" data-id="${esc(n.id)}" value="${esc(n.title)}" placeholder="${UNTITLED}" aria-label="Note title">
      <div class="note-toolbar" role="toolbar" aria-label="Formatting" aria-controls="note-editor">${TOOLS.map(toolBtn).join('')}</div>
      <div class="note-editor-wrap"><div class="rte-body note-editor-body" id="note-editor" contenteditable="true" data-in="noteBody" data-id="${esc(n.id)}" data-ph="Start writing…" role="textbox" aria-multiline="true" aria-label="Note body">${sanitizeNoteHtml(n.html)}</div></div>
      <div class="row note-footer">
        <span id="note-count" class="faint" style="font-size:11.5px">${words} ${words === 1 ? 'word' : 'words'} · ${text.length} ${text.length === 1 ? 'character' : 'characters'}</span>
        <span class="sp"></span>
        <span class="faint" style="font-size:11.5px">Updated ${ago(n.updated)}</span>
      </div>
      ${noteAttachments(n)}
    </div>`;
}

/* ---------- attachments (AC4) ---------- */
/* Refs { name, path, size, type } come from the doc; the row only ever
   renders validated shapes (makeNote/ensureNotes drop malformed ones and
   the ref's name is escaped). path is data, never a URL — downloads go
   through a short-expiry signed URL created on demand. */
function noteAttachments(n) {
  const ups = (S.ui.noteUp || 0) > 0;
  return `<div class="note-atts">
    <div class="row" style="margin-bottom:8px">
      <div class="eyebrow">Attachments · ${(n.attachments || []).length}</div>
      <span class="sp"></span>
      ${ups ? '<span class="row muted" style="gap:6px;font-size:12px" role="status">' + ic('refresh-cw', 13) + 'Uploading…</span>' : ''}
      <label class="btn btn-sm btn-ghost" style="cursor:pointer">${ic('upload', 13)}Upload file<input type="file" multiple hidden data-in="noteUpload" data-id="${esc(n.id)}"></label>
    </div>
    ${(n.attachments || [])
      .map(a => {
        const t = FT[fileType(a.name)] || FT.other;
        return `<div class="row note-att">
        <span class="ftype" style="--c:${t.c}">${ic(t.i, 14)}</span>
        <span class="trunc grow">${esc(a.name)}</span>
        <span class="faint" style="font-size:11.5px">${fsize(Number(a.size) || 0)}</span>
        <button class="ibtn ibtn-xs" data-a="noteAttachDl" data-id="${esc(n.id)}" data-path="${esc(a.path)}" data-tip="Download" aria-label="Download ${esc(a.name)}">${ic('download', 13)}</button>
        <button class="ibtn ibtn-xs" data-a="noteAttachRm" data-id="${esc(n.id)}" data-path="${esc(a.path)}" data-tip="Delete attachment" aria-label="Delete ${esc(a.name)}">${ic('trash-2', 13)}</button>
      </div>`;
      })
      .join('')}
    ${(n.attachments || []).length ? '' : `<p class="faint" style="font-size:11.5px;margin:4px 0 0">Files up to 10 MB, stored privately and only visible to you.</p>`}
  </div>`;
}
