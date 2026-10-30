/* =====================================================================
   ENTRY: styles, then every module in dependency order (several register
   global listeners or add handlers to the action table when they load), then boot.
   ===================================================================== */
import './styles/index.css';
import './core/utils.js';
import './core/icons.js';
import './core/constants.js';
import './data/seed.js';
import './core/store.js';
import './ui/helpers.js';
import './core/theme.js';
import './ui/toast.js';
import './ui/select.js';
import './shell/render.js';
import './shell/layout.js';
import './shell/skeletons.js';
import './shell/view-engine.js';
import './components/task-list.js';
import './pages/home.js';
import './pages/overview.js';
import './pages/my-tasks.js';
import './pages/tasks.js';
import './pages/inbox.js';
import './pages/notifications.js';
import './pages/favorites.js';
import './pages/projects.js';
import './pages/members.js';
import './pages/activity.js';
import './pages/search.js';
import './pages/errors.js';
import './pages/project.js';
import './views/project-overview.js';
import './views/board.js';
import './views/table.js';
import './views/calendar.js';
import './views/timeline.js';
import './views/files.js';
import './overlays/drawer.js';
import './overlays/modals.js';
import './overlays/popovers.js';
import './overlays/context-menu.js';
import './overlays/palette.js';
import './pages/settings.js';
import './pages/auth.js';
import './pages/design-system.js';
import './actions/actions.js';
import './actions/events.js';
import './actions/keyboard.js';
import './actions/drag-drop.js';
import './features/teams.js';
import './features/subtasks.js';
import './features/archive.js';
import './actions/teams.js';
import './actions/subtasks.js';
import './actions/archive.js';
import { S, D, hydrateWorkspace, setSyncHandlers } from './core/store.js';
import { A } from './actions/actions.js';
import { ROUTE_NAMES, render, go } from './shell/render.js';
import { toast } from './ui/toast.js';
import { sb, supabaseConfigured } from './core/supabase.js';
import { isAuthedSession } from './core/workspace-api.js';

/* Boot: a real Supabase session gates the app. Signed in -> load the
   workspace document from Postgres (bootstrap from seed on first login),
   else show the login screen. */
async function init() {
  document.documentElement.lang = 'en';
  if (!document.getElementById('sr-live')) {
    const l = document.createElement('div');
    l.id = 'sr-live';
    l.className = 'sr';
    l.setAttribute('aria-live', 'polite');
    document.body.appendChild(l);
  }
  const h = (location.hash || '').slice(1);
  const authRoutes = ['login', 'signup', 'onboarding'];
  const session = supabaseConfigured ? (await sb.auth.getSession()).data?.session : null;
  if (isAuthedSession(session)) {
    const routeHash = h && ROUTE_NAMES[h] ? h : null;
    await hydrateWorkspace(session);
    S.ui.route = routeHash || S.prefs.home || 'home';
  } else {
    S.ui.auth = authRoutes.includes(h) ? h : 'login';
  }
  render();
}
init();

/* Sync failures surface as toasts; the S.ui.offline flag drives in-app states. */
setSyncHandlers({
  onError: () => toast("Changes couldn't reach the server — you're offline. Edits stay on this device.", { kind: 'err', ms: 6000 }),
  onRecover: () => toast('Back online — changes synced.'),
});

// Dev-only handle for debugging and screenshot tooling; stripped from production builds.
if (import.meta.env.DEV) window.__atrium = { S, D, A, go, render, sb };
