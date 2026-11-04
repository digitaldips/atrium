/* =====================================================================
   GRANOLA · pure import layer for the Docs module (Orbit integration T1)
   Granola has no public API — import runs from an export file the user
   uploads (.md single note, or .json export). This module parses YAML
   frontmatter (title, date subset), converts markdown → HTML with a
   small pure converter (everything raw is ESCAPED first, so imported
   markup can never inject tags), sniffs the export shape and produces a
   sourceId-dedupe plan {creates, updates}. The ACTION (src/actions/
   docs.js) applies the plan through supabase-js and runs every html
   through docsSanitize (DOMPurify) before any insert — this module
   emits raw HTML text only. Data-in/data-out; runs in plain node.
   ===================================================================== */
import { docTextFromHtml } from './docs.js';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB — honest client-side cap, checked before parsing

/* ---------- esc (5-entity map, same contract as the app's esc()) ---------- */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

/* ---------- YAML frontmatter subset (title, date, id) ---------- */
/* Lines between a leading `---` fence and the next `---` (or the first
   line that is not `key: value`). Values are trimmed; matching surrounding
   quotes are stripped. No nesting — Granola exports are flat. */
export function parseFrontmatter(md) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return { attrs: {}, body: text };
  const attrs = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      i++;
      break;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) break;
    let v = kv[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    attrs[kv[1]] = v;
  }
  return { attrs, body: lines.slice(i).join('\n') };
}

/* ---------- markdown → HTML (pure) ---------- */
/* Blocks: fenced code, ATX headings, blockquote, ul/ol, hr, paragraphs.
   Inline: `code`, **bold**, *italic*, [text](url) with an http/https/
   mailto allowlist (unsafe schemes drop the link markup, keeping the
   text). ALL raw text is escaped BEFORE any tag is added, so pasted
   HTML in an export renders as text, never markup. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, hrefRaw) => {
    const url = hrefRaw.replace(/&amp;/g, '&');
    return SAFE_HREF.test(url) ? `<a href="${esc(url)}">${t}</a>` : t;
  });
  return out;
}

export function markdownToHtml(md) {
  const lines = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out = [];
  const buf = [];
  const flushP = () => {
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
    buf.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^```/.test(t)) {
      flushP();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; /* skip the closing fence (or run past EOF) */
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t) && !buf.length) {
      out.push('<hr>');
      i++;
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushP();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(t)) {
      flushP();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        q.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    if (/^[-*+]\s+/.test(t)) {
      flushP();
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      flushP();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map(x => `<li>${inline(x)}</li>`).join('')}</ol>`);
      continue;
    }
    if (!t) {
      flushP();
      i++;
      continue;
    }
    buf.push(t);
    i++;
  }
  flushP();
  return out.join('');
}

/* ---------- sourceId + source tag (dedupe key, AC7) ---------- */
/* The Granola doc's own id when the export carries one; otherwise a
   stable slug of title+date — the SAME export always maps to the SAME
   sourceId, so a re-import updates in place instead of duplicating. */
export function granolaSourceId(title, date) {
  const slug = s =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const base = [slug(title), slug(date)].filter(Boolean).join('-');
  return base || 'untitled';
}

export function granolaSource(sourceId) {
  return sourceId ? { kind: 'granola', sourceId: String(sourceId) } : null;
}

/* ---------- one .md doc → page payload ---------- */
function firstTitleOf(body) {
  const h = String(body ?? '').match(/^#{1,6}\s+(.+)$/m);
  const line =
    (h
      ? h[1]
      : String(body ?? '')
          .split('\n')
          .map(l => l.trim())
          .find(Boolean)) || '';
  return line
    .replace(/^#+\s*/, '')
    .slice(0, 120)
    .trim();
}

export function parseGranolaDoc(mdText) {
  const { attrs, body } = parseFrontmatter(mdText);
  const title = String(attrs.title || '').trim() || firstTitleOf(body) || 'Untitled';
  const date = String(attrs.date || '').trim() || null;
  const sourceId = attrs.id != null && String(attrs.id).trim() ? String(attrs.id).trim() : granolaSourceId(title, date);
  return { title, date, markdown: body, html: markdownToHtml(body), sourceId };
}

/* ---------- export sniffing (.md text or .json) ---------- */
/* JSON: an array, a {docs:[…]} wrapper or a single object → items. Item
   fields are read loosely (content/markdown/notes/text) because export
   shapes drift; each item becomes {title, date, markdown, html, sourceId}.
   Plain markdown text is one doc. Junk returns [] (honest empty). */
function itemToDoc(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const markdown = String(item.content ?? item.markdown ?? item.notes ?? item.text ?? '');
  const title = String(item.title ?? '').trim();
  const date = item.date == null ? null : String(item.date);
  const sourceId = item.id != null && String(item.id).trim() ? String(item.id).trim() : granolaSourceId(title, date);
  return {
    title: title || firstTitleOf(markdown) || 'Untitled',
    date,
    markdown,
    html: markdownToHtml(markdown),
    sourceId,
  };
}

export function parseGranolaExport(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let j;
    try {
      j = JSON.parse(trimmed);
    } catch {
      return [];
    }
    const items = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray(j.docs) ? j.docs : [j];
    return items.map(itemToDoc).filter(Boolean);
  }
  return [parseGranolaDoc(raw)];
}

/* ---------- dedupe plan (AC7) ---------- */
/* items (parsed export) + existing pages (docs_pages rows) →
   {creates, updates}. An existing page whose source.sourceId matches an
   item's sourceId is UPDATED IN PLACE (no dup rows); everything else is
   a create. Position/workspace/parent are the action's concern. */
export function granolaImportPlan(items, existingPages) {
  const bySource = new Map();
  for (const p of existingPages || []) {
    const s = p && p.source;
    if (s && typeof s === 'object' && s.kind === 'granola' && s.sourceId) bySource.set(String(s.sourceId), p);
  }
  const creates = [];
  const updates = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object' || !it.sourceId) continue;
    const html = markdownToHtml(it.markdown ?? '');
    const row = {
      title: String(it.title ?? ''),
      html,
      content_text: docTextFromHtml(html),
      source: granolaSource(it.sourceId),
    };
    const prev = bySource.get(String(it.sourceId));
    if (prev) updates.push({ id: prev.id, kind: 'import', ...row });
    else creates.push(row);
  }
  return { creates, updates };
}
