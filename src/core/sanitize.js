/* =====================================================================
   HTML SANITIZATION · the ONLY door for untrusted HTML into the app
   =====================================================================
   Email bodies arrive as arbitrary attacker-controlled HTML (any sender
   can mail the connected account). They are rendered ONLY through
   DOMPurify.sanitize — never innerHTML raw, never escaped-and-injected
   into an attribute. DOMPurify is the app's single new runtime
   dependency for this (AC6); every other rendered string keeps esc().
   Hardening beyond DOMPurify's defaults:
     - anchors are forced to target="_blank" rel="noopener noreferrer
       nofollow" (canonical DOMPurify afterSanitizeAttributes recipe),
     - every style attribute is dropped (CSS url() = exfil/tracking
       vector) via uponSanitizeAttribute,
     - remote <img> hosts are not restricted beyond https/data-image:
       senders can embed remote images (Gmail shows them too); scripts
       and event handlers are never in the HTML profile,
     - <style> tags and style attributes cannot survive the html profile
       + FORBID list, so no CSS-injection paint confusion.
   DOMPurify needs a DOM, so this module is browser-only (it is NOT
   imported by node tests or the Deno functions).
   ===================================================================== */
import DOMPurify from 'dompurify';

const FORBID_TAGS = [
  'style',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'audio',
  'video',
  'source',
  'track',
  'base',
  'meta',
  'link',
];

/* Drop every style attribute before the sanitizer walks on. */
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'style') data.keepAttr = false;
});

/* Kept links open sandboxed, never in-app, never referrer-leaking.
   AREA (image-map hotspots in mail HTML) gets the identical hardening:
   its href is a navigation vector exactly like an anchor's. */
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' || node.tagName === 'AREA') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const URI_RE = /^(?:mailto:|(?:https?|tel):|^data:image\/(?:png|jpe?g|gif|webp);|^#)/i;

/* Shared profile: both mail bodies and note bodies pass exactly this
   posture (html profile + FORBID list + attribute strip + URI allowlist).
   Notes get the same door as mail, nothing looser: scripts and event
   handlers never survive the html profile, <style>/form/iframe et al are
   FORBIDDEN, style attributes are dropped by the hook, and hrefs may
   only be http/https/mailto/tel/data-image/fragment. */
const SANITIZE_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR: ['style', 'background', 'srcset'],
  ALLOWED_URI_REGEXP: URI_RE,
};

export function sanitizeMailHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}

/* Notes profile — identical posture, own export so the notes render/save
   paths read explicitly. The saved html is sanitized AGAIN here (defense
   in depth: the doc could hold bytes written by an older client, a sync
   or a bug — render never trusts it). */
export function sanitizeNoteHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}

/* Docs profile — identical posture, own export so the Docs render/save
   paths read explicitly (docs_pages.content_html is never trusted raw,
   at save AND at render — same contract as notes). */
export function docsSanitize(html) {
  if (typeof html !== 'string' || !html) return '';
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}
