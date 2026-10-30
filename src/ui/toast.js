/* ---------- toasts ---------- */
import { $, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { save } from '../core/store.js';
import { render } from '../shell/render.js';

export function toast(msg, opt = {}) {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const icon = opt.kind === 'err' ? ic('circle-alert', 15, 'bad') : opt.kind === 'info' ? ic('info', 15) : ic('circle-check', 15, 'ok');
  el.innerHTML = `${icon}<span class="grow">${esc(msg)}</span>${opt.action ? `<button class="ta">${esc(opt.action)}</button>` : ''}<button class="ibtn ibtn-xs" aria-label="Dismiss" style="color:inherit;opacity:.6">${ic('x', 13)}</button>`;
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 160);
  };
  if (opt.action)
    el.querySelector('.ta').onclick = () => {
      opt.onAction?.();
      kill();
    };
  el.querySelector('.ibtn').onclick = kill;
  host.appendChild(el);
  setTimeout(kill, opt.ms || 4200);
}
/* Every edit applies locally and is queued for sync: while the server is
   unreachable, save() keeps the localStorage cache current and the
   debounced write-through sync converges once the connection is back.
   Writes are never refused while flagged offline. */
export function mutate(fn) {
  fn();
  save();
  render();
  return true;
}
