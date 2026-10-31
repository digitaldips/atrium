/* ---------------- AUTH ---------------- */
/* Google-only: the only auth surface is the Atrium brand + a Google
   sign-in button (Operance Workspace contract, see workspace-api.js).
   Email/password, signup and forgot/reset surfaces are gone. */
import { esc } from '../core/utils.js';
import { LOGO, ic } from '../core/icons.js';
import { D, S } from '../core/store.js';
import { effectiveDark } from '../core/theme.js';
import { TEMPLATES } from '../overlays/modals.js';

/* The four-colour Google "G", inline so the button needs no asset. */
const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`;

export function authShell(inner, topRight = '') {
  return `<div class="auth"><div class="auth-top"><span class="brand">${LOGO(22)}</span><div class="row">${topRight}<button class="ibtn" data-a="toggleDark" data-tip="Toggle theme" aria-label="Toggle theme">${ic(effectiveDark() ? 'sun' : 'moon', 16)}</button></div></div>
    <div class="auth-c">${inner}</div>
    <div class="auth-foot" style="padding:18px;font-size:12px" ><span class="faint">© 2026 Atrium · Terms · Privacy</span></div></div>`;
}
export function renderAuth() {
  const s = S.ui.auth;
  const e = S.ui.errors;
  if (s === 'onboarding') return renderOnboarding();
  if (s === 'login')
    return authShell(
      `<div class="auth-card${S.ui.fx.auth ? ' fx-auth' : ''}">
    <div style="display:flex;justify-content:center">${LOGO(30)}</div><h1>Welcome back</h1><p class="sub">Sign in to ${esc(D().ws.name)}</p>
    ${e.login ? `<div class="alert danger" role="alert">${ic('circle-alert', 15)}<span>${e.login}</span></div>` : ''}
    <button class="btn btn-secondary btn-lg btn-block" data-a="doGoogleSignIn" id="google-btn">${GOOGLE_G}Continue with Google</button>
    <p class="hint" style="text-align:center">Sign in with your @operanceai.com account</p></div>`,
    );
  return '';
}

/* ---------------- ONBOARDING ---------------- */
export function renderOnboarding() {
  const st = S.ui.onb;
  const o = S.ui.onbData;
  const N = 6;
  const nav = (next = 'Continue', skip = false) =>
    `<div class="row" style="margin-top:6px">${st > 0 && st < 5 ? `<button class="btn btn-ghost" data-a="onbBack">${ic('arrow-left', 14)}Back</button>` : ''}<span class="sp"></span>${skip ? `<button class="btn btn-ghost" data-a="onbNext" data-skip="1">Skip for now</button>` : ''}<button class="btn btn-primary btn-lg" data-a="onbNext" id="onb-next">${next}${ic('arrow-right', 15)}</button></div>`;
  const opt = (k, v, icon, n, s) =>
    `<button class="opt ${o[k] === v ? 'on' : ''}" role="radio" aria-checked="${o[k] === v}" data-a="onbSet" data-k="${k}" data-v="${v}">${ic(icon, 18)}<b>${n}</b>${s ? `<span>${s}</span>` : ''}</button>`;
  let body;
  if (st === 0)
    body = `<h1>What are you working on?</h1><p class="sub">We'll tailor templates and views to fit. You can change this later.</p><div class="opts" role="radiogroup">${[
      ['product', 'target', 'Product', 'Roadmaps & launches'],
      ['design', 'palette', 'Design', 'Reviews & handoff'],
      ['marketing', 'megaphone', 'Marketing', 'Campaigns & content'],
      ['engineering', 'code', 'Engineering', 'Sprints & releases'],
      ['personal', 'user', 'Personal', 'Goals & side projects'],
      ['other', 'sparkles', 'Other', 'Something else'],
    ]
      .map(x => opt('use', ...x))
      .join('')}</div>${nav()}`;
  if (st === 1) {
    const e = S.ui.errors.ws;
    body = `<h1>Create your workspace</h1><p class="sub">A workspace is where your team's projects live.</p>
    <div class="field"><label class="label" for="o-ws">Workspace name</label><input class="input input-lg ${e ? 'is-error' : ''}" id="o-ws" data-in="onbWs" value="${esc(o.ws)}" placeholder="e.g. Atrium" autofocus>${e ? `<span class="err">${ic('circle-alert', 12)}${e}</span>` : ''}</div>
    <div class="field"><label class="label" for="o-url">Workspace URL</label><div class="row" style="gap:0"><span class="input input-lg" style="width:auto;background:var(--surface-2);border-right:0;border-radius:6px 0 0 6px;display:flex;align-items:center;color:var(--text-2)">atrium.app/</span><input class="input input-lg" id="o-url" value="${esc(o.url || '')}" data-in="onbUrl" style="border-radius:0 6px 6px 0" placeholder="atrium"></div>${o.url ? `<span class="hint" style="color:var(--green);display:flex;gap:4px;align-items:center">${ic('check', 12)}atrium.app/${esc(o.url)} is available</span>` : ''}</div>${nav()}`;
  }
  if (st === 2)
    body = `<h1>How does your team work?</h1><p class="sub">We'll set your default project view.</p><div class="opts" role="radiogroup" style="grid-template-columns:repeat(2,minmax(0,1fr))">${[
      ['kanban', 'square-kanban', 'Boards', 'Move cards through stages'],
      ['list', 'list-checks', 'Lists', 'Checklists and priorities'],
      ['timeline', 'chart-gantt', 'Timelines', 'Plan with dates & dependencies'],
      ['table', 'table-2', 'Tables', 'Spreadsheet-style tracking'],
    ]
      .map(x => opt('team', ...x))
      .join('')}</div>
    <div class="field"><span class="label">Team size</span><div class="seg" style="width:fit-content">${['Just me', '2-10', '11-50', '51-200', '200+'].map(s => `<button class="${o.size === s ? 'on' : ''}" data-a="onbSet" data-k="size" data-v="${s}">${s}</button>`).join('')}</div></div>${nav()}`;
  if (st === 3)
    body = `<h1>Create your first project</h1><p class="sub">Start from a template or a blank project.</p><div class="field"><label class="label" for="o-proj">Project name</label><input class="input input-lg" id="o-proj" data-in="onbProj" value="${esc(o.proj)}" autofocus></div><div class="tmpls" role="radiogroup">${TEMPLATES.filter(
      t => t.id !== 'blank',
    )
      .map(t => opt('tmpl', t.id, t.icon, t.name, t.tasks.length + ' starter tasks'))
      .join('')}</div>${nav()}`;
  if (st === 4)
    body = `<h1>Invite your team</h1><p class="sub">Atrium works best with your teammates. They'll get an email invite.</p><div class="col" style="gap:8px">${[0, 1, 2].map(i => `<input class="input input-lg" id="o-inv-${i}" placeholder="teammate@company.com" type="email" value="${esc((o.invites || '').split(',')[i] || '')}" data-in="onbInv" data-i="${i}" aria-label="Teammate email ${i + 1}">`).join('')}</div><button class="btn btn-ghost btn-sm" style="align-self:flex-start" data-a="copyInviteLink">${ic('link', 13)}Copy invite link instead</button>${nav('Send invites', true)}`;
  if (st === 5) {
    const n = (o.invites || '').split(',').filter(x => x.includes('@')).length;
    body = `<div style="display:flex;justify-content:center"><span class="ftype ready-badge" style="--c:var(--green);width:48px;height:48px;border-radius:12px">${ic('circle-check', 22)}</span></div><h1>Your workspace is ready</h1><p class="sub">Here's what we set up for you.</p>
    <div class="panel">${[
      ['building-2', `Workspace “${esc(o.ws || 'My Workspace')}”`, 'atrium.app/' + esc(o.url || 'workspace')],
      [
        TEMPLATES.find(t => t.id === o.tmpl)?.icon || 'folder',
        `Project “${esc(o.proj)}”`,
        `${TEMPLATES.find(t => t.id === o.tmpl)?.tasks.length || 0} starter tasks · ${{ kanban: 'Board', list: 'List', timeline: 'Timeline', table: 'Table' }[o.team]} view`,
      ],
      [
        'user-plus',
        n ? `${n} invite${n > 1 ? 's' : ''} sent` : 'No invites yet',
        n ? "They'll appear in Members once they join" : 'Invite people any time from the sidebar',
      ],
    ]
      .map(
        ([i, t, s]) =>
          `<div class="row ready-row" style="padding:12px 14px;border-top:1px solid var(--divider);gap:12px"><span class="ftype" style="--c:var(--accent)">${ic(i, 14)}</span><div class="grow"><div style="font-weight:500">${t}</div><div class="faint" style="font-size:12px">${s}</div></div><span class="ok" style="color:var(--green);display:inline-flex">${ic('check', 15)}</span></div>`,
      )
      .join('')}</div>
    <button class="btn btn-primary btn-lg btn-block" data-a="onbFinish">Open workspace${ic('arrow-right', 15)}</button>`;
  }
  return authShell(
    `<div class="auth-card onb${S.ui.fx.step ? ' fx-step' : ''}" style="max-width:${st === 5 ? 440 : 560}px">
    <div class="steps" aria-label="Step ${st + 1} of ${N}">${Array.from({ length: N }, (_, i) => `<i class="${i <= st ? 'on' : ''} ${i === st ? 'cur' : ''}"></i>`).join('')}</div>
    <div class="faint" style="text-align:center;font-size:12px">Step ${st + 1} of ${N}</div>
    ${body}</div>`,
    `<button class="btn btn-ghost btn-sm" data-a="onbExit">Exit setup</button>`,
  );
}
