/* ---------------- MODALS ---------------- */
import { $$, MOD, ago, esc, fmtDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { PCOLORS, PICONS } from '../core/constants.js';
import { D, S, mem, pColor, proj, task, teamsList } from '../core/store.js';
import { FT, av, filePrev, lbl, prPill, stPill } from '../ui/helpers.js';
import { focusKey, render } from '../shell/render.js';
import { teamModal } from '../features/teams.js';
import { clientDetailHtml, clientFormHtml, dealFormHtml } from '../pages/crm.js';
import { resolveEnabledCalendars, busyBarLayout } from '../../supabase/functions/_shared/google-pure.js';

export function openModal(m) {
  S.ui.modalOpeners = S.ui.modalOpeners || [];
  S.ui.modalOpeners[S.ui.modals.length] = S.ui.popOpener && S.ui.pop ? S.ui.popOpener : focusKey(document.activeElement);
  S.ui.modals.push(m);
  S.ui.pop = null;
  render();
  setTimeout(() => {
    const all = $$('.modal');
    const last = all[all.length - 1];
    const af = last?.querySelector('[autofocus]');
    (af || last?.querySelector('input,textarea,button'))?.focus();
  }, 30);
}
export function closeModal() {
  S.ui.modals.pop();
  S.ui.pop = null;
  render();
}
export function modalHtml(m) {
  const H = (title, sub = '') =>
    `<div class="modal-h"><div><h2 id="mt-${m.type}">${title}</h2>${sub ? `<div class="muted" style="font-size:12.5px;margin-top:2px">${sub}</div>` : ''}</div><button class="ibtn ibtn-sm" data-a="closeModal" aria-label="Close">${ic('x', 16)}</button></div>`;
  const wrap = (cls, inner) => `<div class="modal ${cls}" role="dialog" aria-modal="true" aria-labelledby="mt-${m.type}">${inner}</div>`;
  switch (m.type) {
    case 'task':
      return wrap('', taskModal(m, H));
    case 'project':
      return wrap('', projectModal(m, H));
    case 'share':
      return wrap('', shareModal(m, H));
    case 'invite':
      return wrap('', inviteModal(m, H));
    case 'confirm':
      return wrap('sm', confirmModal(m, H));
    case 'prompt':
      return wrap(
        'sm',
        `${H(m.title)}<form class="modal-b" data-submit="promptSubmit"><div class="field"><label class="label" for="prompt-in">${esc(m.label)}</label><input class="input" id="prompt-in" value="${esc(m.value || '')}" autofocus></div></form><div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="promptSubmit">${esc(m.ok || 'Save')}</button></div>`,
      );
    case 'shortcuts':
      return wrap('lg', shortcutsModal(H));
    case 'team':
      return wrap('', teamModal(m, H));
    case 'client':
      return wrap('', clientDetailHtml(m, H));
    case 'clientForm':
      return wrap('', clientFormHtml(m, H));
    case 'dealForm':
      return wrap('', dealFormHtml(m, H));
    case 'filePreview':
      return wrap('lg', filePreviewModal(m, H));
    case 'saveView':
      return wrap(
        'sm',
        `${H('Save view', 'Save the current filters as a tab on this project.')}<form class="modal-b" data-submit="saveViewSubmit"><div class="field"><label class="label" for="sv-name">View name</label><input class="input" id="sv-name" placeholder="e.g. Design review queue" autofocus></div><div class="field"><label class="label" for="sv-type">Layout</label><select class="select" id="sv-type"><option value="list">List</option><option value="board">Board</option><option value="table">Table</option></select></div>${m.nf ? `<div class="hint">${m.nf} filter${m.nf > 1 ? 's' : ''} will be saved with this view.</div>` : '<div class="alert info">' + ic('info', 14) + '<span>No filters are active — the view will show all tasks. You can add filters after saving.</span></div>'}</form><div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="saveViewSubmit">Save view</button></div>`,
      );
    case 'compose':
      return wrap('', composeModal(m, H));
    case 'geventForm':
      return wrap('', gEventModal(m, H));
  }
  return '';
}
export function formChip(pop, html, label) {
  return `<button class="pillbtn bordered" data-a="pop" data-pop="${pop}" data-id="__form" ${pop === 'date' ? `data-field="${label}"` : ''} aria-label="${esc(label)}">${html}</button>`;
}
export function taskModal(m, H) {
  const f = S.ui.form;
  const p = proj(f.project);
  const err = S.ui.errors.title;
  return `${H(m.edit ? 'Edit task' : 'New task', m.edit ? `<span class="mono">${task(m.edit)?.key}</span>` : '')}
  <form class="modal-b" data-submit="submitTask" style="gap:12px">
    <div class="field"><label class="sr" for="f-title">Task name</label><input class="input input-lg ${err ? 'is-error' : ''}" id="f-title" data-in="form" data-f="title" value="${esc(f.title)}" placeholder="Task name" autofocus aria-invalid="${!!err}" aria-describedby="f-title-err" style="font-size:15px;font-weight:500">${err ? `<span class="err" id="f-title-err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
    <div class="field"><label class="sr" for="f-desc">Description</label><textarea class="textarea" id="f-desc" data-in="form" data-f="desc" placeholder="Add a description… (optional)" rows="3">${esc(f.desc)}</textarea></div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      ${formChip('project', `<span class="pdot" style="--c:${pColor(p)}"></span>${esc(p?.name || 'Project')}`, 'Project')}
      ${formChip('status', stPill(f.status), 'Status')}
      ${formChip('assignee', `${av(f.assignee, 'sm', false)}${esc(mem(f.assignee)?.name || 'Assignee')}`, 'Assignee')}
      ${formChip('priority', prPill(f.priority), 'Priority')}
      ${formChip('date', `${ic('calendar', 13)}${f.due ? 'Due ' + fmtDate(f.due) : 'Due date'}`, 'due')}
      ${formChip('date', `${ic('calendar-arrow-up', 13)}${f.start ? 'Starts ' + fmtDate(f.start) : 'Start date'}`, 'start')}
      ${formChip('labels', f.labels.length ? f.labels.map(lbl).join('') : `${ic('tag', 13)}Labels`, 'Labels')}
      ${formChip('recur', `${ic('repeat', 13)}${f.recur || 'Repeat'}`, 'Repeat')}
    </div>
    <div class="field"><span class="label">Subtasks</span>
      ${f.subtasks.map((s, i) => `<div class="subt" style="padding:0 4px">${ic('circle', 13)}<span class="s">${esc(s.title)}</span><button type="button" class="ibtn ibtn-xs x" style="opacity:1" data-a="formRmSub" data-i="${i}" aria-label="Remove">${ic('x', 12)}</button></div>`).join('')}
      <div class="inwrap">${ic('plus', 14)}<input class="input" id="f-sub" data-key-enter="formAddSub" placeholder="Add a subtask and press Enter"></div></div>
    <div class="field"><span class="label">Attachments</span>
      ${f.files.length ? `<div class="col" style="gap:4px">${f.files.map((x, i) => `<div class="upl" style="padding:6px 10px"><span class="ftype" style="--c:${FT[x.type].c};width:22px;height:22px">${ic(FT[x.type].i, 12)}</span><span class="grow trunc">${esc(x.name)}</span><span class="faint" style="font-size:11.5px">${x.size}</span><button type="button" class="ibtn ibtn-xs" data-a="formRmFile" data-i="${i}" aria-label="Remove">${ic('x', 12)}</button></div>`).join('')}</div>` : ''}
      <label class="dropzone" style="padding:10px">${ic('paperclip', 14)}<span>Attach files</span><input type="file" multiple hidden data-in="formFiles"></label></div>
  </form>
  <div class="modal-f">${m.edit ? '' : `<label class="row" style="gap:8px;font-size:12.5px;color:var(--text-2);cursor:pointer"><input type="checkbox" class="toggle" id="f-more" data-in="formMore" ${f.more ? 'checked' : ''}>Create more</label>`}<span class="sp"></span>
    <span class="faint hide-m" style="font-size:11.5px"><kbd>${MOD}</kbd> <kbd>↵</kbd></span>
    <button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitTask" id="f-submit">${m.edit ? 'Save changes' : 'Create task'}</button></div>`;
}
export const TEMPLATES = [
  { id: 'blank', name: 'Blank project', icon: 'file', desc: 'Start from scratch', tasks: [] },
  {
    id: 'product',
    name: 'Product Development',
    icon: 'target',
    desc: 'Discovery to launch',
    tasks: ['Define problem statement', 'User research plan', 'Write PRD', 'Design exploration', 'Build MVP', 'Beta launch'],
  },
  {
    id: 'web',
    name: 'Website',
    icon: 'globe',
    desc: 'IA, design, build, launch',
    tasks: ['Sitemap & information architecture', 'Wireframes', 'Visual design', 'Build page templates', 'Content migration', 'QA & launch'],
  },
  {
    id: 'mkt',
    name: 'Marketing Campaign',
    icon: 'megaphone',
    desc: 'Brief, assets, channels',
    tasks: ['Campaign brief', 'Audience research', 'Creative assets', 'Channel plan', 'Launch campaign', 'Performance report'],
  },
  {
    id: 'design',
    name: 'Design Project',
    icon: 'palette',
    desc: 'Discovery to handoff',
    tasks: ['Discovery workshop', 'Moodboard', 'Concept directions', 'Refinement', 'Developer handoff'],
  },
  {
    id: 'software',
    name: 'Software Development',
    icon: 'code',
    desc: 'Spec, build, ship',
    tasks: ['Technical spec', 'Set up repo & CI', 'Implement core API', 'Write tests', 'Code review', 'Deploy to staging'],
  },
  {
    id: 'personal',
    name: 'Personal Project',
    icon: 'heart',
    desc: 'Plan your own goals',
    tasks: ['Brain dump ideas', 'Pick top 3 priorities', 'Schedule focus time', 'Weekly review'],
  },
];
export function projectModal(m, H) {
  const f = S.ui.pform;
  const err = S.ui.errors.pname;
  return `${H(m.edit ? 'Project settings' : 'New project', m.edit ? '' : 'Projects hold tasks, files, and conversations for one body of work.')}
  <form class="modal-b" data-submit="submitProject">
    <div class="row" style="gap:10px;align-items:flex-start">
      <button type="button" class="picon lg" style="--c:${PCOLORS[f.color]};cursor:default;flex-shrink:0;margin-top:22px" aria-hidden="true" tabindex="-1">${ic(f.icon, 18)}</button>
      <div class="field grow"><label class="label" for="p-name">Project name</label><input class="input ${err ? 'is-error' : ''}" id="p-name" data-in="pform" data-f="name" value="${esc(f.name)}" placeholder="e.g. Website Redesign" autofocus aria-invalid="${!!err}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
    </div>
    <div class="field"><label class="label" for="p-desc">Description</label><textarea class="textarea" id="p-desc" data-in="pform" data-f="desc" rows="2" placeholder="What is this project about?">${esc(f.desc)}</textarea></div>
    <div class="row" style="gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:220px"><span class="label">Icon</span><div class="iconpick" role="radiogroup" aria-label="Icon">${PICONS.map(i => `<button type="button" role="radio" aria-checked="${f.icon === i}" class="${f.icon === i ? 'on' : ''}" data-a="pformSet" data-f="icon" data-v="${i}" aria-label="${i}">${ic(i, 15)}</button>`).join('')}</div></div>
      <div class="field"><span class="label">Color</span><div class="swatches" role="radiogroup" aria-label="Color" style="max-width:140px">${Object.entries(
        PCOLORS,
      )
        .map(
          ([k, v]) =>
            `<button type="button" role="radio" aria-checked="${f.color === k}" class="sw ${f.color === k ? 'on' : ''}" style="--c:${v};width:22px;height:22px" data-a="pformSet" data-f="color" data-v="${k}" aria-label="${k}">${f.color === k ? ic('check', 12) : ''}</button>`,
        )
        .join('')}</div></div>
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:150px"><label class="label" for="p-team">Team</label><select class="select" id="p-team" data-in="pform" data-f="team">${teamsList()
        .map(t => `<option value="${t.id}" ${f.team === t.id ? 'selected' : ''}>${t.name}</option>`)
        .join('')}</select></div>
      <div class="field" style="flex:1;min-width:150px"><label class="label" for="p-lead">Lead</label><select class="select" id="p-lead" data-in="pform" data-f="lead">${D()
        .members.filter(x => x.status === 'active')
        .map(x => `<option value="${x.id}" ${f.lead === x.id ? 'selected' : ''}>${esc(x.name)}</option>`)
        .join('')}</select></div>
      <div class="field" style="flex:1;min-width:150px"><label class="label" for="p-due">Target date</label><input type="date" class="input" id="p-due" data-in="pform" data-f="due" value="${f.due || ''}"></div>
    </div>
    ${m.edit ? '' : `<div class="field"><span class="label">Template</span><div class="tmpls" role="radiogroup">${TEMPLATES.map(t => `<button type="button" role="radio" aria-checked="${f.tmpl === t.id}" class="opt ${f.tmpl === t.id ? 'on' : ''}" data-a="pformSet" data-f="tmpl" data-v="${t.id}" style="padding:10px">${ic(t.icon, 16)}<b style="font-size:12.5px">${t.name}</b><span>${t.tasks.length ? t.tasks.length + ' starter tasks' : t.desc}</span></button>`).join('')}</div></div>`}
  </form>
  <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitProject">${m.edit ? 'Save changes' : 'Create project'}</button></div>`;
}
export const PERMS = ['Can view', 'Can comment', 'Can edit', 'Full access'];
export function shareModal(m, H) {
  const p = proj(m.id);
  p.perms = p.perms || {};
  p.access = p.access || 'workspace';
  return `${H(`Share “${esc(p.name)}”`)}
  <div class="modal-b">
    <form class="row" style="gap:6px" data-submit="shareInvite"><div class="grow"><label class="sr" for="share-in">Invite by email</label><input class="input" id="share-in" placeholder="Add people by name or email" value="${esc(S.ui.shareQ || '')}" data-in="shareQ" autofocus></div>
      <select class="select" id="share-perm" style="width:132px" aria-label="Permission">${PERMS.map(x => `<option ${x === 'Can edit' ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="btn btn-primary" data-a="shareInvite" type="button">Invite</button></form>
    ${
      S.ui.shareQ
        ? `<div class="panel" style="padding:4px">${
            D()
              .members.filter(
                x => !p.members.includes(x.id) && (x.name.toLowerCase().includes(S.ui.shareQ.toLowerCase()) || x.email.includes(S.ui.shareQ.toLowerCase())),
              )
              .map(
                x =>
                  `<button class="mi" data-a="shareAdd" data-id="${p.id}" data-mid="${x.id}">${av(x.id, 'sm', false)}${esc(x.name)}<span class="r">${esc(x.email)}</span></button>`,
              )
              .join('') ||
            `<div class="mi faint" style="cursor:default">${S.ui.shareQ.includes('@') ? `Press Invite to send an invitation to ${esc(S.ui.shareQ)}` : 'No matching members — enter an email to invite someone new'}</div>`
          }</div>`
        : ''
    }
    <div><div class="eyebrow" style="margin-bottom:4px">People with access</div>
      ${p.members
        .map(id => {
          const x = mem(id);
          if (!x) return '';
          const perm = id === p.lead ? 'Full access' : p.perms[id] || (x.role === 'Guest' ? 'Can comment' : 'Can edit');
          return `<div class="row" style="height:44px">${av(id, 'md', false)}<div class="grow"><div style="font-weight:500;font-size:13px">${esc(x.name)}${id === D().me ? ' <span class="faint" style="font-weight:400">(you)</span>' : ''}</div><div class="faint" style="font-size:11.5px">${esc(x.email)}${id === p.lead ? ' · Project lead' : ''}</div></div>
          ${id === p.lead ? `<span class="muted" style="font-size:12.5px;padding-right:8px">Full access</span>` : `<select class="select" style="width:auto;height:26px;font-size:12px;border-color:transparent;background-color:transparent" data-in="sharePerm" data-id="${p.id}" data-mid="${id}" aria-label="Permission for ${esc(x.name)}">${PERMS.map(q => `<option ${q === perm ? 'selected' : ''}>${q}</option>`).join('')}<option value="__remove">Remove access</option></select>`}</div>`;
        })
        .join('')}
    </div>
    <div style="border-top:1px solid var(--divider);padding-top:12px"><div class="eyebrow" style="margin-bottom:8px">General access</div>
      <div class="row" style="gap:10px"><span class="ftype" style="--c:var(--text-2)">${ic(p.access === 'private' ? 'lock' : 'building-2', 14)}</span><div class="grow"><select class="select" style="height:28px;width:auto;border-color:transparent;padding-left:4px;font-weight:500" data-in="shareAccess" data-id="${p.id}" aria-label="General access"><option value="private" ${p.access === 'private' ? 'selected' : ''}>Only people invited</option><option value="workspace" ${p.access === 'workspace' ? 'selected' : ''}>Everyone at ${esc(D().ws.name)}</option></select><div class="faint" style="font-size:11.5px;padding-left:4px">${p.access === 'private' ? 'Only people listed above can open this project.' : 'Anyone in the workspace can view and comment.'}</div></div></div></div>
  </div>
  <div class="modal-f"><button class="btn btn-secondary" data-a="copyLink" data-pid="${p.id}">${ic('link', 14)}Copy link</button><span class="sp"></span><button class="btn btn-primary" data-a="closeModal">Done</button></div>`;
}
export function inviteModal(m, H) {
  const err = S.ui.errors.invite;
  return `${H('Invite to ' + esc(D().ws.name), 'Invited people get an email with a link to join.')}
  <form class="modal-b" data-submit="submitInvite">
    <div class="field"><label class="label" for="inv-emails">Email addresses</label><textarea class="textarea ${err ? 'is-error' : ''}" id="inv-emails" placeholder="name@company.com, another@company.com" rows="3" autofocus>${esc(S.ui.inviteDraft || '')}</textarea>${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : '<span class="hint">Separate multiple addresses with commas.</span>'}</div>
    <div class="row" style="gap:12px"><div class="field grow"><label class="label" for="inv-role">Role</label><select class="select" id="inv-role">${['Member', 'Admin', 'Guest'].map(r => `<option>${r}</option>`).join('')}</select></div>
    <div class="field grow"><label class="label" for="inv-team">Team</label><select class="select" id="inv-team">${teamsList()
      .map(t => `<option value="${t.id}">${t.name}</option>`)
      .join('')}</select></div></div>
    <div class="alert info">${ic('info', 14)}<span><b>Guests</b> can only see projects they're added to and can't create projects.</span></div>
  </form>
  <div class="modal-f"><button class="btn btn-ghost" data-a="copyInviteLink">${ic('link', 14)}Copy invite link</button><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitInvite" id="inv-submit">Send invites</button></div>`;
}
export function confirmModal(m) {
  const needs = m.typeName;
  const ok = !needs || (S.ui.confirmText || '') === needs;
  return `<div class="modal-b" style="padding-top:18px;gap:10px">
    <div class="row" style="gap:12px;align-items:flex-start"><span class="ftype" style="--c:${m.danger ? 'var(--red)' : 'var(--amber)'};width:34px;height:34px;border-radius:9px">${ic(m.icon || (m.danger ? 'trash-2' : 'archive'), 17)}</span>
    <div class="grow"><h2 id="mt-confirm" style="font-size:15px;font-weight:600;margin:4px 0 6px">${esc(m.title)}</h2><p class="muted" style="margin:0;font-size:13px;line-height:1.55">${m.body}</p></div></div>
    ${needs ? `<div class="field" style="margin-top:6px"><label class="label" for="confirm-in" style="font-weight:400;color:var(--text-2)">Type <b style="color:var(--text);font-weight:600">${esc(needs)}</b> to confirm</label><input class="input" id="confirm-in" data-in="confirmText" autocomplete="off" autofocus value="${esc(S.ui.confirmText || '')}"></div>` : ''}
  </div>
  <div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal" ${needs ? '' : 'autofocus'}>Cancel</button><button class="btn ${m.danger ? 'btn-danger' : 'btn-primary'}" data-a="confirmOk" ${ok ? '' : 'disabled'}>${esc(m.ok)}</button></div>`;
}
export const SHORTCUTS = [
  [
    'General',
    [
      ['Command menu', [MOD, 'K']],
      ['Search', ['/']],
      ['Keyboard shortcuts', ['?']],
      ['Toggle sidebar', ['[']],
      ['Toggle dark mode', [MOD, 'Shift', 'L']],
      ['Close panel or dialog', ['Esc']],
    ],
  ],
  [
    'Create',
    [
      ['New task', ['N']],
      ['New project', ['P']],
      ['Submit form', [MOD, '↵']],
      ['Send comment', [MOD, '↵']],
    ],
  ],
  [
    'Navigate',
    [
      ['Go to Home', ['G', 'H']],
      ['Go to My Tasks', ['G', 'T']],
      ['Go to Projects', ['G', 'P']],
      ['Go to Inbox', ['G', 'I']],
      ['Go to Calendar', ['G', 'C']],
      ['Go to Settings', ['G', 'S']],
    ],
  ],
  [
    'Command menu',
    [
      ['Move selection', ['↑', '↓']],
      ['Run command', ['↵']],
      ['Search mode', ['Tab']],
    ],
  ],
];
export function shortcutsModal(H) {
  return `${H('Keyboard shortcuts')}<div class="modal-b" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:22px">${SHORTCUTS.map(([g, list]) => `<div><div class="eyebrow" style="margin-bottom:6px">${g}</div>${list.map(([n, k]) => `<div class="row" style="height:30px;font-size:13px;border-bottom:1px solid var(--divider)"><span class="grow">${n}</span>${k.map((x, i) => `${i && k[0] === 'G' ? '<span class="faint" style="font-size:11px">then</span>' : ''}<kbd>${x}</kbd>`).join('')}</div>`).join('')}</div>`).join('')}</div>`;
}
export function filePreviewModal(m, H) {
  const f = m.file;
  const t = FT[f.type] || FT.other;
  return `${H(esc(f.name), `${t.n} · ${f.size} · Uploaded by ${esc(mem(f.by)?.name || 'you')} ${ago(f.at)}`)}
  <div class="modal-b"><div style="border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden">${filePrev(f).replace('class="fprev"', 'class="fprev" style="aspect-ratio:16/9"')}</div>
  ${m.tid ? `<div class="row faint" style="font-size:12.5px">${ic('link', 13)}Attached to <button class="link" data-a="openTask" data-id="${m.tid}">${esc(task(m.tid)?.title)}</button></div>` : ''}</div>
  <div class="modal-f"><button class="btn btn-secondary" data-a="copyLink" data-fid="${f.id}">${ic('link', 14)}Copy link</button><span class="sp"></span><button class="btn btn-primary" data-a="closeModal">Close</button></div>`;
}

/* ---------- Gmail compose / reply (FULL client + drafts) ---------- */
export function composeModal(m, H) {
  const f = S.ui.gform;
  const draftId = S.ui.compose?.draftId || '';
  return `${H(m.reply ? 'Reply' : draftId ? 'Draft' : 'New message', draftId ? 'Saved as a Gmail draft — Send sends the draft, Save updates it.' : 'Sent from your connected Gmail account.')}
  <form class="modal-b" data-submit="gSend" style="gap:10px">
    <div class="field"><label class="label" for="g-to">To</label><input class="input" id="g-to" data-in="gForm" data-f="to" value="${esc(f.to)}" placeholder="name@company.com, another@company.com" autofocus></div>
    <div class="field"><label class="label" for="g-cc">Cc</label><input class="input" id="g-cc" data-in="gForm" data-f="cc" value="${esc(f.cc)}" placeholder="Optional"></div>
    <div class="field"><label class="label" for="g-subject">Subject</label><input class="input" id="g-subject" data-in="gForm" data-f="subject" value="${esc(f.subject)}" placeholder="Subject"></div>
    <div class="field grow"><label class="label" for="g-body">Message</label><textarea class="textarea" id="g-body" data-in="gForm" data-f="body" rows="9" placeholder="Write your message…">${esc(f.body)}</textarea></div>
    ${f.error ? `<div class="alert danger">${ic('triangle-alert', 14)}<span>${esc(f.error)}</span></div>` : ''}
  </form>
  <div class="modal-f"><span class="faint hide-m" style="font-size:11.5px"><kbd>${MOD}</kbd> <kbd>↵</kbd></span><span class="sp"></span><button class="btn btn-secondary" data-a="gSaveDraft" ${f.saving ? 'disabled aria-busy="true"' : ''}>${ic('file', 14)}${draftId ? 'Update draft' : 'Save draft'}</button><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="gSend" ${f.sending ? 'disabled aria-busy="true"' : ''}>${f.sending ? 'Sending…' : m.reply ? 'Send reply' : 'Send'}</button></div>`;
}

/* ---------- Google Calendar event create / edit (edit shares this modal) ---------- */

/* Busy strip for the selected day (S.ui.gbusy, filled by ensureFreebusy):
   merged busy blocks positioned across the local 00:00–24:00 line, plus
   an honest empty state ("No busy blocks on this day") and a real error
   state — the strip never invents availability. */
function busyStrip(f) {
  const st = S.ui.gbusy || { state: 'idle', day: null, blocks: [] };
  if (!f.date || st.state === 'idle' || st.day !== f.date) return `<div class="faint" style="font-size:11.5px">Busy times load with the date…</div>`;
  if (st.state === 'loading') return `<div class="row muted" style="font-size:12px" role="status">${ic('refresh-cw', 12)}Checking busy times…</div>`;
  if (st.state === 'error')
    return `<div class="alert danger" style="padding:8px 10px">${ic('triangle-alert', 13)}<span style="font-size:12px">${esc(st.error || 'Could not load busy times.')}</span></div>`;
  if (st.state === 'empty') return `<div class="faint" style="font-size:12px">${ic('circle-check', 12)} No busy blocks on this day.</div>`;
  const [y, m, d] = f.date.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  /* F5: the strip divides by the TRUE local day span — 23 h on a
     spring-forward day, 25 h on fall-back — the same window busyOnDay
     clipped the blocks to. A fixed 86400e3 drifts on DST-shifted days.
     The text list below stays the fallback source of truth. */
  const dayEnd = new Date(y, m - 1, d + 1).getTime();
  const fmt = ms => {
    const t = new Date(ms);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  };
  const bars = busyBarLayout(st.blocks, dayStart, dayEnd)
    .map(
      b =>
        `<span aria-hidden="true" style="position:absolute;left:${b.left.toFixed(2)}%;width:${Math.max(0.6, b.width).toFixed(2)}%;top:0;bottom:0;background:var(--red);opacity:.35;border-radius:4px"></span>`,
    )
    .join('');
  const list = st.blocks.map(b => `${fmt(b.s)} – ${fmt(b.e)}`).join(' · ');
  return `<div style="margin-top:2px"><div style="position:relative;height:10px;background:var(--surface-2);border:1px solid var(--divider);border-radius:6px;overflow:hidden" aria-label="Busy times">${bars}</div><div class="faint" style="font-size:11.5px;margin-top:4px">${ic('clock', 11)} Busy: ${esc(list)}</div></div>`;
}

export function gEventModal(m, H) {
  const f = S.ui.gEvForm;
  const editing = f.mode === 'edit';
  /* Writable ENABLED calendars only — the endpoint re-validates against
     the calendarList (unknown / read-only → honest 400/403). */
  const calItems = (S.ui.gcalList && S.ui.gcalList.items) || [];
  const enabled = resolveEnabledCalendars(Array.isArray(S.prefs.calendarIds) ? S.prefs.calendarIds : ['primary'], calItems);
  const writable = calItems.filter(c => enabled.includes(c.id) && (c.primary || c.accessRole === 'owner' || c.accessRole === 'writer'));
  const calField = writable.length
    ? `<div class="field" style="min-width:170px"><label class="label" for="g-ev-cal">Calendar</label><select class="select" id="g-ev-cal" data-in="gEvForm" data-f="calendarId">${writable
        .map(c => `<option value="${esc(c.id)}" ${f.calendarId === c.id ? 'selected' : ''}>${esc(c.summary)}${c.primary ? ' (default)' : ''}</option>`)
        .join('')}</select></div>`
    : '';
  return `${H(editing ? 'Edit event' : 'New event', editing ? 'Changes are saved to your Google Calendar and attendees are notified.' : 'Saved to your Google Calendar — attendees receive an invitation.')}
  <form class="modal-b" data-submit="gEvSubmit" style="gap:10px">
    <div class="field"><label class="label" for="g-ev-title">Title</label><input class="input" id="g-ev-title" data-in="gEvForm" data-f="title" value="${esc(f.title)}" placeholder="Event title" autofocus></div>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start">
      <div class="field" style="flex:1;min-width:150px"><label class="label" for="g-ev-date">Date</label><input type="date" class="input" id="g-ev-date" data-in="gEvForm" data-f="date" value="${esc(f.date)}">${busyStrip(f)}</div>
      ${calField}
    </div>
    <label class="row" style="gap:6px;font-size:12.5px;color:var(--text-2);cursor:pointer"><input type="checkbox" class="toggle" data-in="gEvForm" data-f="allDay" ${f.allDay ? 'checked' : ''}>All day</label>
    <div class="row" style="gap:10px;${f.allDay ? 'display:none' : ''}">
      <div class="field" style="width:130px"><label class="label" for="g-ev-start">Starts</label><input type="time" class="input" id="g-ev-start" data-in="gEvForm" data-f="start" value="${esc(f.start)}"></div>
      <div class="field" style="width:130px"><label class="label" for="g-ev-end">Ends</label><input type="time" class="input" id="g-ev-end" data-in="gEvForm" data-f="end" value="${esc(f.end)}"></div>
    </div>
    <div class="field"><label class="label" for="g-ev-location">Location</label><input class="input" id="g-ev-location" data-in="gEvForm" data-f="location" value="${esc(f.location)}" placeholder="Optional"></div>
    <div class="field"><label class="label" for="g-ev-attendees">Attendees</label><input class="input" id="g-ev-attendees" data-in="gEvForm" data-f="attendees" value="${esc(f.attendees)}" placeholder="name@company.com, another@company.com"><span class="hint">Comma-separated. Google emails an invitation to everyone.</span></div>
    <div class="field"><label class="label" for="g-ev-desc">Description</label><textarea class="textarea" id="g-ev-desc" data-in="gEvForm" data-f="description" rows="3" placeholder="Optional">${esc(f.description)}</textarea></div>
    ${f.error ? `<div class="alert danger">${ic('triangle-alert', 14)}<span>${esc(f.error)}</span></div>` : ''}
  </form>
  <div class="modal-f">${editing ? `<button class="btn btn-danger-ghost" data-a="gEventDelete" data-id="${esc(f.id)}">${ic('trash-2', 14)}Delete</button>` : ''}<span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="gEvSubmit" ${f.sending ? 'disabled aria-busy="true"' : ''}>${f.sending ? 'Saving…' : editing ? 'Save changes' : 'Create event'}</button></div>`;
}
