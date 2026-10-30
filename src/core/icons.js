/* ---------- icons: inlined Lucide subset (src/00-icons.js), rendered to inline svg ---------- */
import { ICONS } from 'virtual:icons';
import { esc } from './utils.js';

export const _icCache = {};
export function ic(name, size = 16, cls = '') {
  const k = name + '|' + size + '|' + cls;
  if (_icCache[k]) return _icCache[k];
  const inner = ICONS[name] || '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (_icCache[k] =
    `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}
/* Atrium brand: an open-apex 'A' (the atrium roof) with a skylight dot in
   the counter. The wordmark follows the theme's text colour; the app icon
   is the white glyph on a dark tile. */
const ATRIUM_GLYPH = (stroke, fill) =>
  `<g fill="none" stroke="${stroke}" stroke-width="22" stroke-linecap="round"><path d="M62 254 L150 90"/><path d="M182 90 L270 254"/><path d="M104 198 H228"/></g><circle cx="166" cy="134" r="15" fill="${fill}"/>`;
export const LOGO = (h = 22) =>
  `<span style="display:inline-flex;align-items:center;gap:7px"><svg class="logo" height="${h}" width="${h}" viewBox="0 0 332 332" role="img" aria-label="Atrium">${ATRIUM_GLYPH('currentColor', 'currentColor')}</svg><span style="font-weight:600;letter-spacing:-0.01em;font-size:${Math.max(11, Math.round(h * 0.66))}px">Atrium</span></span>`;
export const MARK = (px = 22) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 332 332" aria-hidden="true"><rect width="332" height="332" fill="#000"/>${ATRIUM_GLYPH('#fff', '#fff')}</svg>`;
export function wsLogo(w, px = 22) {
  return w && w.brand
    ? `<span class="ws-logo brand" style="width:${px}px;height:${px}px">${MARK(px)}</span>`
    : `<span class="ws-logo" style="--c:${w.c};width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.46))}px">${esc(w.name[0])}</span>`;
}
