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
import { S, D, flushPendingSync, lastSyncError, setSyncHandlers, startWorkspace } from './core/store.js';
import { A } from './actions/actions.js';
import { ROUTE_NAMES, render, go } from './shell/render.js';
import { toast } from './ui/toast.js';
import { sb, supabaseConfigured } from './core/supabase.js';
import { isAuthedSession, resolveAuthRoute } from './core/workspace-api.js';

/* Boot: a real Supabase session gates the app. Signed in -> load the
   workspace document from Postgres (bootstrap from seed on first login),
   else show the login screen. #onboarding is a session-only route: an
   unauthenticated visitor lands on login no matter the hash. */
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
  const authRoutes = ['login', 'onboarding'];
  const session = supabaseConfigured ? (await sb.auth.getSession()).data?.session : null;
  if (isAuthedSession(session)) {
    const routeHash = h && ROUTE_NAMES[h] ? h : null;
    if ((await startWorkspace(session)) === 'login') {
      /* Fail closed: server unreachable and no trusted cache of our own. */
      S.ui.auth = 'login';
      S.ui.errors = { login: lastSyncError() };
      render();
      return;
    }
    S.ui.route = routeHash || S.prefs.home || 'home';
  } else {
    S.ui.auth = resolveAuthRoute(authRoutes.includes(h) ? h : 'login', null);
  }
  render();
}
init();

/* Flush the pending debounced sync when the tab is hidden or closing so
   the last edit inside the 500ms window still reaches the server. */
window.addEventListener('pagehide', flushPendingSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSync();
});

/* Sync failures surface as toasts; the S.ui.offline flag drives in-app states.
   Edits keep applying locally (see mutate()) and converge once reachable. */
setSyncHandlers({
  onError: () =>
    toast("Changes couldn't reach the server — your edits are kept on this device and will sync when you're back online.", { kind: 'err', ms: 6000 }),
  onRecover: () => toast('Back online — changes synced.'),
});
// Dev-only handle for debugging and screenshot tooling; stripped from production builds.
if (import.meta.env.DEV) window.__atrium = { S, D, A, go, render, sb };
