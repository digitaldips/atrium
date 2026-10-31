/* =====================================================================
   NOTES ACTIONS · autosave, WYSIWYG toolbar, attachments (storage)
   =====================================================================
   The editor keeps note.html in memory current on EVERY keystroke
   (already sanitized) so any render is lossless; persistence runs through
   the existing save() pipeline on a ~1s autosave debounce, flushed on
   note switch, page hide and tab hide. Attachments use the supabase-js
   storage API with the signed-in user's JWT — no edge function. The
   'atrium' bucket is private; paths are <userId>/<noteId>/<file> so the
   storage RLS policies can scope every operation to the owner's prefix. */
import { $, esc, uid } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, noteById, save } from '../core/store.js';
import { UNTITLED, attachmentRefFor, makeNote, noteApplyBody, noteSafeLinkUrl, noteTitleFromHtml, removeNote } from '../core/notes.js';
import { sanitizeNoteHtml } from '../core/sanitize.js';
import { sb, getCurrentUser } from '../core/supabase.js';
import { mutate, toast } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { A, IN, confirmDlg, restore, snapshot } from './actions.js';

export const NOTE_BUCKET = 'atrium';
const AUTOSAVE_MS = 1000;

/* ---------- honest storage error copy (pass the server's words through) ---------- */
const storageErr = e => (e && (e.message || e.error_description || e.msg)) || 'something went wrong. Try again.';
const needStorage = () => {
  if (S.ui.offline) {
    toast("Upload failed — you're offline.", { kind: 'err' });
    return false;
  }
  if (!sb) {
    toast("Attachments need a connection to Atrium's storage.", { kind: 'err' });
    return false;
  }
  if (!getCurrentUser()) {
    toast('Sign in to attach files.', { kind: 'err' });
    return false;
  }
  return true;
};

/* ---------- autosave (~1s debounce through save()) ---------- */
const draft = { t: null };

/* The autosave commits ONLY the editor body, resolved by note id from the
   live DOM (#note-editor). It must never read another element: the title
   <input> once rode this same commit and its empty innerHTML wiped the
   body on the ~1s tick — a title carries no body. */
function commitLive(id) {
  const ed = $('#note-editor');
  if (!ed || ed.dataset.id !== id) return false;
  const n = noteById(id);
  if (!n) return false;
  noteApplyBody(n, sanitizeNoteHtml(ed.innerHTML));
  return true;
}

function setSavedLabel(txt) {
  const el = $('#note-saved');
  if (el) el.textContent = txt;
}

/* Every edit path commits to memory synchronously (input, paste, toolbar,
   drop), so memory is always current and lossless; this timer only
   persists through save(). It takes the NOTE ID, never an element. */
function scheduleAutosave(id) {
  clearTimeout(draft.t);
  draft.t = setTimeout(() => {
    draft.t = null;
    commitLive(id); /* belt: a no-op unless the live editor belongs to this note */
    saveDoc();
  }, AUTOSAVE_MS);
}

function saveDoc() {
  save();
  setSavedLabel('Saved');
}

/* Flush a pending autosave right now: note switch, pagehide, tab hide. */
export function flushNoteDraft() {
  if (!draft.t) return;
  clearTimeout(draft.t);
  draft.t = null;
  const ed = $('#note-editor');
  if (ed && commitLive(ed.dataset.id)) save();
}
window.addEventListener('pagehide', flushNoteDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushNoteDraft();
});

/* ---------- editor input (contenteditable + title) ---------- */
function updateCounts(ed) {
  const text = (ed.textContent || '').replace(/\u00a0/g, ' ').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const el = $('#note-count');
  if (el) el.textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${text.length} ${text.length === 1 ? 'character' : 'characters'}`;
}

IN.noteBody = el => {
  if (!el.dataset.id) return;
  commitLive(el.dataset.id);
  updateCounts(el);
  setSavedLabel('Saving…');
  scheduleAutosave(el.dataset.id);
};

IN.noteTitle = el => {
  const n = noteById(el.dataset.id);
  if (!n) return;
  n.title = el.value;
  n.updated = Date.now();
  save();
  /* Live-update the list row without a render — no caret loss, no focus
     churn; the row timestamp catches up on the next render. */
  const row = document.querySelector(`[data-rowtitle="${CSS.escape(el.dataset.id)}"]`);
  if (row) row.textContent = n.title || noteTitleFromHtml(n.html) || UNTITLED;
  setSavedLabel('Saving…');
  /* Title edits ride the SAME autosave timer as the body — but the timer
     commits the EDITOR by note id, never this input, so a title keystroke
     can never wipe the body. */
  scheduleAutosave(el.dataset.id);
};

/* ---------- notes-page search (list pane) ---------- */
IN.noteQ = el => {
  S.ui.notesQ = el.value;
  render();
};
A.noteQClear = () => {
  S.ui.notesQ = '';
  render();
  setTimeout(() => $('#note-search')?.focus(), 0);
};

/* ---------- selection / create / pin / delete ---------- */
A.noteSel = el => {
  flushNoteDraft();
  S.ui.noteSel = el.dataset.id || '';
  render();
};

A.noteNew = () => {
  flushNoteDraft();
  const now = Date.now();
  const n = makeNote({ id: uid('n'), title: '', html: '', created: now, updated: now, pinned: false, attachments: [] });
  mutate(() => {
    D().notes.push(n);
    if (S.ui.notesQ) S.ui.notesQ = ''; // the new note must be visible, not swallowed by an active filter
    S.ui.noteSel = n.id;
  });
  setTimeout(() => $('#note-title')?.focus(), 0);
};

A.notePin = el => {
  const n = noteById(el.dataset.id);
  if (!n) return;
  flushNoteDraft(); // the mutate below re-renders the editor from n.html
  mutate(() => {
    n.pinned = !n.pinned;
  });
  toast(n.pinned ? 'Pinned to the top of the list' : 'Unpinned', { ms: 1800 });
};

A.noteDelete = el => {
  const n = noteById(el.dataset.id);
  if (!n) return;
  confirmDlg({
    title: 'Delete note?',
    body: `“${esc(n.title || noteTitleFromHtml(n.html) || UNTITLED)}” will be deleted. Its attachments in storage are removed with it.`,
    ok: 'Delete note',
    danger: true,
    run: async () => {
      const atts = [...(n.attachments || [])];
      if (atts.length) {
        if (!sb) {
          toast("Attachments need a connection to Atrium's storage — the note was not deleted.", { kind: 'err' });
          return;
        }
        const { error } = await sb.storage.from(NOTE_BUCKET).remove(atts.map(a => a.path));
        /* Objects already gone (deleted elsewhere) are fine; anything else
           is honest: nothing is deleted until storage agrees. */
        if (error && !/not found|not_found/i.test(error.message || '')) {
          toast(`Delete failed — ${storageErr(error)}`, { kind: 'err' });
          return;
        }
      }
      clearTimeout(draft.t);
      draft.t = null;
      const snap = snapshot();
      if (
        mutate(() => {
          D().notes = removeNote(D().notes, el.dataset.id);
          if (S.ui.noteSel === el.dataset.id) S.ui.noteSel = '';
        })
      )
        toast('Note deleted', { action: 'Undo', onAction: () => restore(snap) });
    },
  });
};

/* ---------- WYSIWYG toolbar (data-ncmd, mousedown keeps the selection) ---------- */
const NOTE_CMDS = {
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

function afterNoteCmd(ed) {
  commitLive(ed.dataset.id);
  updateCounts(ed);
  setSavedLabel('Saving…');
  scheduleAutosave(ed.dataset.id);
}

document.addEventListener('mousedown', e => {
  const b = e.target.closest('[data-ncmd]');
  if (!b) return;
  e.preventDefault();
  const ed = $('#note-editor');
  if (!ed) return;
  const c = b.dataset.ncmd;
  ed.focus();
  if (c === 'noteLink') return noteLinkBar(ed);
  if (c === 'unlink') {
    document.execCommand('unlink', false, null);
    return afterNoteCmd(ed);
  }
  const [cmd, arg] = NOTE_CMDS[c] || [];
  if (!cmd) return;
  document.execCommand(cmd, false, arg || null);
  afterNoteCmd(ed);
});

/* ---------- link insertion (URL prompt, http/https allowlist) ---------- */
/* A small popover inside the editor pane — deliberately NOT a modal, so
   no render happens while it is open and the captured selection Range
   stays valid across the prompt. URL passes noteSafeLinkUrl (http/https
   only, no credentials); the sanitizer would strip anything else at
   save/render time anyway. */
function noteLinkBar(ed) {
  document.getElementById('note-linkbar')?.remove();
  const sel = document.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const startEl = range ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) : null;
  const anchor = startEl?.closest?.('a') || null;
  const wrap = ed.parentElement;
  if (!wrap) return;
  const bar = document.createElement('div');
  bar.id = 'note-linkbar';
  bar.className = 'note-linkbar';
  bar.innerHTML = `${ic('link', 14)}<input class="input" id="note-link-url" placeholder="https://…" aria-label="Link URL" value="${esc(anchor?.getAttribute('href') || '')}">
    <button type="button" class="btn btn-primary btn-sm" data-lk="add">${anchor ? 'Update link' : 'Add link'}</button>
    ${anchor ? '<button type="button" class="btn btn-secondary btn-sm" data-lk="rm">Remove link</button>' : ''}
    <button type="button" class="ibtn ibtn-sm" data-lk="x" aria-label="Cancel link">${ic('x', 14)}</button>`;
  wrap.insertBefore(bar, ed);
  const input = bar.querySelector('#note-link-url');
  input.focus();
  input.select();
  const restoreSel = () => {
    ed.focus();
    if (range) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
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
      return afterNoteCmd(ed);
    }
    if (op === 'add') {
      const url = noteSafeLinkUrl(input.value);
      if (!url) {
        toast('Use a full URL starting with https://', { kind: 'info' });
        return;
      }
      restoreSel();
      if (anchor) anchor.setAttribute('href', url);
      else if (range && !range.collapsed) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
      bar.remove();
      afterNoteCmd(ed);
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

/* Cmd/Ctrl+K inside the editor opens the link bar (keyboard.js routes it
   here instead of the command palette). */
A.noteLinkCmd = () => {
  const ed = $('#note-editor');
  if (ed) noteLinkBar(ed);
};

/* ---------- paste: sanitize AT PASTE TIME too ---------- */
/* The browser live-renders whatever a paste inserts, so save-time
   sanitization alone cannot stop an onerror inside pasted markup from
   executing for a moment. Intercepting the paste event and inserting only
   the sanitized html closes that window; save-time sanitization stays as
   the backstop (paste-time is a belt, not a replacement). Plain-text
   pastes (no text/html on the clipboard) keep the default insertion. */
document.addEventListener('paste', e => {
  const ed = e.target.closest?.('#note-editor');
  if (!ed) return;
  const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
  if (!html) return;
  e.preventDefault();
  const clean = sanitizeNoteHtml(html);
  if (clean) document.execCommand('insertHTML', false, clean);
  else document.execCommand('insertText', false, e.clipboardData.getData('text/plain') || '');
  afterNoteCmd(ed);
});

/* ---------- drop: sanitize AT DROP TIME (same gate as paste) ---------- */
/* Rich-HTML drags (text/html from another window or app) land on a
   contenteditable through the browser's default insertion unless the drop
   is prevented — and the global drag-drop handler deliberately ignores
   non-file drops outside its own dropzones. So the editor gets its own
   listener mirroring the paste interceptor: preventDefault, then insert
   ONLY the sanitized html. Plain drags (no text/html) keep the default
   insertion; a dropped FILE goes through the real attachment upload. */
document.addEventListener('drop', e => {
  const ed = e.target.closest?.('#note-editor');
  if (!ed) return;
  const files = e.dataTransfer?.files;
  if (files && files.length) {
    e.preventDefault();
    const n = noteById(ed.dataset.id);
    if (n) uploadNoteFiles(n, files);
    return;
  }
  const html = e.dataTransfer ? e.dataTransfer.getData('text/html') : '';
  if (!html) return;
  e.preventDefault();
  const clean = sanitizeNoteHtml(html);
  if (clean) document.execCommand('insertHTML', false, clean);
  else document.execCommand('insertText', false, e.dataTransfer.getData('text/plain') || '');
  afterNoteCmd(ed);
});

/* ---------- attachments: upload / download / remove ---------- */
/* The upload flow is shared by the file input and the editor drop handler
   (a file dropped on the body uploads as an attachment). */
async function uploadNoteFiles(n, files) {
  if (!files.length) return;
  if (!needStorage()) return;
  const userId = getCurrentUser();
  for (const file of files) {
    const ref = attachmentRefFor(file, userId, n.id);
    if (!ref) {
      toast(`“${file.name}” is over the 10 MB limit and was not uploaded.`, { kind: 'err' });
      continue;
    }
    S.ui.noteUp = (S.ui.noteUp || 0) + 1;
    render();
    try {
      const { error } = await sb.storage.from(NOTE_BUCKET).upload(ref.path, file, { upsert: true });
      S.ui.noteUp = Math.max(0, (S.ui.noteUp || 1) - 1);
      if (error) {
        toast(`Upload failed — ${storageErr(error)}`, { kind: 'err' });
        render();
        continue;
      }
      mutate(() => {
        n.updated = Date.now();
        /* Re-uploading a name replaces both object (upsert) and ref. */
        n.attachments = [...(n.attachments || []).filter(a => a.name !== ref.name), ref];
      });
      toast(`Uploaded ${ref.name}`);
    } catch (err) {
      S.ui.noteUp = Math.max(0, (S.ui.noteUp || 1) - 1);
      toast(`Upload failed — ${storageErr(err)}`, { kind: 'err' });
      render();
    }
  }
}

IN.noteUpload = async el => {
  const n = noteById(el.dataset.id);
  const files = [...(el.files || [])];
  el.value = '';
  if (!n || !files.length) return;
  await uploadNoteFiles(n, files);
};

A.noteAttachDl = async el => {
  const n = noteById(el.dataset.id);
  const ref = (n?.attachments || []).find(a => a.path === el.dataset.path);
  if (!ref) return;
  if (!sb) {
    toast("Attachments need a connection to Atrium's storage.", { kind: 'err' });
    return;
  }
  /* Short-expiry signed URL (5 min), minted with the user's own JWT —
     storage RLS only signs objects under the caller's uid prefix. */
  const { data, error } = await sb.storage.from(NOTE_BUCKET).createSignedUrl(ref.path, 300);
  if (error || !data?.signedUrl) {
    toast(`Download failed — ${storageErr(error)}`, { kind: 'err' });
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener');
};

A.noteAttachRm = async el => {
  const n = noteById(el.dataset.id);
  const ref = (n?.attachments || []).find(a => a.path === el.dataset.path);
  if (!ref) return;
  if (!sb) {
    toast("Attachments need a connection to Atrium's storage.", { kind: 'err' });
    return;
  }
  const { error } = await sb.storage.from(NOTE_BUCKET).remove([ref.path]);
  /* 'not found' = already gone elsewhere: the ref must still go. */
  if (error && !/not found|not_found/i.test(error.message || '')) {
    toast(`Delete failed — ${storageErr(error)}`, { kind: 'err' });
    return;
  }
  mutate(() => {
    n.attachments = (n.attachments || []).filter(a => a.path !== ref.path);
    n.updated = Date.now();
  });
  toast(`Removed ${ref.name}`);
};

/* Open a note from search / Home pinned surface. */
A.noteOpen = el => {
  flushNoteDraft();
  S.ui.noteSel = el.dataset.id || '';
  go('notes');
};
