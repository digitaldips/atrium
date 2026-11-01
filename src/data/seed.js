/* ---------- seed data ---------- */
/* The FRESH workspace document: the minimal doc every new account
   bootstraps from (store.js bootstrap branch → applyUserIdentity then
   applies the real Google name + email to the me member before the first
   render). No sample/demo content — every content array starts empty and
   each page shows its own honest empty state. The structural fields stay
   because pages and actions read them: the ws shape (name/url/c/brand in
   settings, layout, copied links, wsLogo), the me member, projOrder,
   teams (an empty array is truthy, so teamsList() never injects team
   seeds and the NO_TEAM fallback renders), workspaces, savedViews/
   recentSearches/sessions/invoices (read with map/filter on []), and the
   tfa/notifPrefs defaults the settings toggles bind to. */
export function seed() {
  return {
    ws: { name: 'My workspace', url: 'my-workspace', c: '#1D1C1A', brand: true },
    workspaces: [],
    me: 'm1',
    members: [
      /* The account owner. name/email are neutral placeholders until the
         bootstrap applies the account identity (applyUserIdentity). */
      { id: 'm1', name: 'You', email: '', role: 'Owner', team: '', title: '', c: '#5A67D8', status: 'active', last: 0, tz: '' },
    ],
    clients: [],
    deals: [],
    links: [],
    notes: [],
    orgs: [],
    projects: [],
    tasks: [],
    comments: [],
    activity: [],
    notifs: [],
    files: [],
    events: [],
    projOrder: [],
    teams: [],
    savedViews: [],
    recentSearches: [],
    sessions: [],
    invoices: [],
    tfa: false,
    notifPrefs: {
      email_mention: true,
      email_assign: true,
      email_digest: true,
      email_comment: false,
      push_mention: true,
      push_assign: true,
      push_comment: true,
      push_due: true,
      mention_all: true,
      assign_self: true,
    },
  };
}
