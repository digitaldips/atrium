# Atrium

A calm, structured project management workspace: members and teams, home dashboard, inbox, my tasks,
projects with board / list / table / calendar / timeline / files views, activity and settings.

Real auth and persistence are provided by a self-hosted [Supabase](https://supabase.com) stack:
email/password sign-in gates the app, and the whole workspace document persists to Postgres
(`public.workspaces.data`, jsonb) with row-level security. Supabase is the source of truth when a
session exists; the browser's localStorage cache is the offline fallback.

Built with plain JavaScript ES modules and CSS, bundled by [Vite](https://vite.dev). There is no
UI framework; the only runtime dependency is `@supabase/supabase-js`.

![Atrium home dashboard](docs/preview.png)

## Getting started

Requires Node.js 18 or newer (`.nvmrc` pins 22).

```bash
npm install
npm run dev       # http://localhost:5173 with hot reload
npm run build     # production build in dist/
npm run preview   # serve the production build locally
npm run test      # node --test: the data layer, against a fake client (no network)
npm run lint      # ESLint
npm run format    # Prettier
```

The build reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env` (gitignored — see
`.env.example`). Without them the app runs in local-only mode: no backend, no auth gate.

## Supabase backend

- **Schema:** `supabase/migrations/0001_atrium_init.sql` creates `public.workspaces` (one row per
  owner — `owner_id` references `auth.users` with a unique index, `data jsonb`, `updated_at`
  trigger) and `public.workspace_members`. RLS is enabled on both: owners get full access to their
  workspace and manage its members; members can select workspaces they belong to and their own
  membership.
- **Boot:** a session loads the owner's workspace document; a missing row is bootstrapped from seed
  data and upserted immediately. No session shows the login screen.
- **Sync:** every `save()` keeps the localStorage write (cache) and, when signed in, schedules a
  debounced (~500ms) upsert of the same `{data, prefs, views}` payload by `owner_id`. Sync failures
  set the offline flag and surface a toast; the app keeps working from the cache.
- **Auth:** `signInWithPassword` / `signUp` (autoconfirm is enabled on the stack, so signup signs
  you in directly) / `signOut`. Social login and forgot/reset flows are intentionally absent — the
  stack has no SMTP.

## Project structure

```
index.html              HTML entry; loads src/main.js
public/favicon.svg      brand mark
vite.config.js          Vite config, including the Lucide icon-subset plugin
eslint.config.js        lint rules (ESLint flat config); formatting by Prettier (.prettierrc.json)
.github/workflows/      CI: lint, format check, build
docs/preview.png        README screenshot
supabase/migrations/    0001 workspaces + members (RLS, ACLs), 0002 user_integrations (service-role only),
                        0003 oauth state columns, 0004 notes attachment storage (private 'atrium' bucket + owner-scoped RLS)
test/                   node --test suite for the pure data layer (fake client, no network)
src/
  main.js               entry: imports styles and modules, then boots behind the auth gate
  styles/
    index.css           imports every stylesheet in cascade order
    tokens.css          colours, spacing, type, radius, the shared --gutter
    base.css  components.css  shell.css  panels.css  overlays.css  states.css  motion.css  responsive.css
    views/              list, board, table, calendar, timeline, projects & files
    pages/              settings, auth & onboarding
  core/                 utilities, constants, icons, store (state + lookups), theme,
                        supabase.js (client wrapper) + workspace-api.js (pure data layer),
                        crm.js / links.js / notes.js (pure doc-layer modules),
                        sanitize.js (DOMPurify profiles for mail and notes HTML)
  data/seed.js          seed workspace data used on first login
  ui/                   shared render helpers, toasts, the select dropdown
  shell/                render loop and router, sidebar/topbar layout, skeletons, view engine
  components/           task list renderer
  pages/                one module per route (including notes.js: two-pane Notes + WYSIWYG)
  views/                project views: board, table, calendar, timeline, files, overview
  overlays/             task drawer, modals, popovers, context menu, command palette
  features/             teams, subtasks, archive (rendering)
  actions/              user actions, event wiring, keyboard shortcuts, drag and drop
```

### Layers

Dependencies point downward:

1. `core/` and `data/` depend on nothing else in the app. `workspace-api.js` is pure — every
   function takes the client as an argument — so `test/` exercises it without a network;
   `supabase.js` is the only module allowed to create the real client.
2. `ui/`, `shell/`, `components/`, `pages/`, `views/`, `overlays/` and `features/` render HTML from state.
3. `actions/` change state and re-render. Each action module registers its handlers on the
   shared action table (`A`) when it loads, so `main.js` imports them after `actions/actions.js`.

## Conventions

- **Rendering:** each page or view is a function that returns an HTML string from the store
  (`S`). `render()` rebuilds the shell and keeps focus and scroll positions.
- **Interactions:** elements declare `data-a="actionName"`. `actions/events.js` delegates the
  click to `A.actionName`. Inputs use `data-in`, blur handlers use `data-blur`.
- **Layout:** every page edge uses `var(--gutter)`, so the breadcrumb, page header, toolbar,
  list, table and board start on the same line.
- **Dropdowns:** write a normal `<select class="select">`. `ui/select.js` renders it as the
  design-system menu and keeps the native element as the source of truth.
- **Icons:** call `ic('name')` with any [Lucide](https://lucide.dev) icon name. The
  `virtual:icons` plugin bundles only the icons the source uses.

## Google integration notes

Atrium connects to one Google account per signed-in user (Gmail read/send/modify

- Calendar read/write, granted via Settings → Integrations). Two model notes:

* **CRM links are workspace-shared.** `links[]` rows (client ↔ mail/event/task)
  live in the shared workspace document, while each member reads their own
  Gmail — Gmail message ids are global, so on a multi-member workspace the same
  message can only be linked to one client workspace-wide. Atrium is currently
  single-user; revisit per-account link scoping before inviting members.
* **Mail HTML is rendered, not trusted.** Message bodies pass through
  DOMPurify (`src/core/sanitize.js`) — the only door for Gmail HTML into the
  DOM. Everything else (senders, subjects, snippets, label names) is escaped.

## Notes

Notes are rich-text documents that live inside the workspace document
(`doc.notes[]`, same model as clients/deals/links — no extra tables):

- **Editor:** a dependency-free `contenteditable` surface with a toolbar
  (bold/italic/underline/strikethrough, H2/H3, lists, quote, code block,
  link, remove formatting, undo/redo) built on `document.execCommand`.
  `execCommand` is deprecated but universally supported; if editing needs
  outgrow it, the upgrade path is swapping the editor pane for Tiptap or
  ProseMirror behind the same `note.html` shape — no data migration needed.
- **Sanitization:** note HTML passes DOMPurify on every save and again on
  every render (`sanitizeNoteHtml`, same FORBID posture as mail bodies).
  Pasted HTML is sanitized at paste time too, so pasted markup never
  live-renders raw.
- **Autosave:** every keystroke updates the in-memory doc with sanitized
  HTML (renders are always lossless); persistence runs through the normal
  debounced `save()` pipeline on a ~1 s debounce, flushed on note switch
  and tab hide.
- **Attachments:** files up to 10 MB upload to the private `atrium`
  Storage bucket via supabase-js with the signed-in user's JWT. Object
  paths are `<userId>/<noteId>/<filename>`; a single storage.objects RLS
  policy scopes every operation (select/insert/update/delete, signed URLs
  included) to the caller's own uid prefix, and downloads go through
  short-expiry (5 min) signed URLs. The repo migration
  `supabase/migrations/0004_notes_storage.sql` creates the bucket
  idempotently for fresh clones.
- **Integration:** the global search page matches note titles and text;
  the Home dashboard shows a Pinned notes panel whenever a note is pinned.

## Continuous integration

Every push and pull request runs lint, the format check and a production build
(`.github/workflows/ci.yml`).

## Deploy

`vercel.json` builds with Vite and serves `dist/`.
