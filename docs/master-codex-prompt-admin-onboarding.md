# Research and master looping Codex prompt: private admin guided onboarding

Prepared August 10, 2026 after inspecting the current repository and reviewing current accessibility, product-guidance, React Joyride, Driver.js, and Codex guidance.

## Decision in one paragraph

Implement guided onboarding only inside the authenticated private admin application under `/admin`. Use React Joyride 3.x for the anchored popover/dialog behavior, keep each tour short and route-scoped, auto-start only one first-use “Admin foundations” tour, and make every tour replayable with a persistent **Guide this page** action. Persist versioned tour progress on the server against the authenticated session’s existing `principal_id`; do not make `localStorage` the source of truth. The public acquisition site, contact flow, and secure-document uploader are explicitly out of scope.

## Scope clarification: “backend,” not the public frontend

In this document, “backend application” means the private operational application at `/admin`, as distinct from the public marketing and seller-facing routes. A visual bubble must still be rendered by React in the browser, but the feature is private-admin-only and its eligibility/progress is owned by the authenticated server-side identity.

The implementation must not add onboarding UI, tour anchors, onboarding API calls, or onboarding storage behavior to any of these public routes:

- `/`
- `/about`
- `/criteria`
- `/why-sell-to-me`
- `/process`
- `/faq`
- `/contact`
- `/privacy`
- `/thank-you`
- `/secure-documents`

## What the repository already provides

The repository is a good fit for a small, native-feeling guided-tour layer. Important current facts are:

- The private app is a React 18 and React Router application, with Vite and Tailwind CSS.
- `src/App.jsx` lazy-loads `AdminLayout` and `DashboardPage`, so a tour dependency can remain in the private-admin chunk rather than becoming part of the initial public experience.
- `src/pages/DashboardPage.jsx` owns the authenticated admin shell and the route-aware workspaces: Overview, CRM, Command Center, Deal Hunter, Follow-Ups, Operations, and New Record.
- `src/content/adminSectionMeta.js` already contains concise workflow guidance for every admin section. Tour copy should reuse those priorities instead of inventing a second set of operating instructions.
- `AdminSectionNav` is sticky on larger viewports and horizontally scrollable on small screens. Tour positioning must therefore be tested at both desktop and mobile widths.
- Admin content is frequently asynchronous. CRM results, Command Center data, Deal Hunter review data, CIM history, Follow-Ups, and Operations may render after fetches complete. A tour must wait for stable wrapper targets or skip a missing optional target without trapping the user.
- Authentication already produces durable `admin_sessions` with `principal_id`, `username`, and `role`. The admin identity intentionally maps to `admin:primary`; viewer identities use normalized viewer principals. That `principal_id`, taken only from the authenticated session, is the right owner key for onboarding state.
- Both SQLite and Supabase storage adapters are first-class. Any durable onboarding progress must have additive schema support and equivalent adapter behavior in `server/storage/sqlite.js`, `server/storage/supabase.js`, `supabase/schema.sql`, and a forward Supabase migration.
- `requireAdminAccess` authorizes both administrators and read-only viewers. Onboarding progress is a self-scoped preference, so both roles may read and update only their own progress. Role filtering must prevent viewer tours from describing or targeting admin-only controls.
- The repository already uses Node tests, Vitest and Testing Library, Playwright, ESLint with accessibility rules, and a production build gate.
- There is no existing tour, coach-mark, onboarding, or first-use state system. The only browser storage found is unrelated public attribution data in `sessionStorage`.

## Research conclusions

### 1. These bubbles are interactive dialogs, not simple ARIA tooltips

The product may call them “tooltips,” “coach marks,” or “bubbles,” but a multi-step bubble containing Back, Next, Skip, and Close buttons is not the WAI-ARIA tooltip pattern. The W3C tooltip pattern is non-interactive, does not receive focus, remains associated with the trigger, and is dismissible with Escape. The W3C specifically points interactive popup content toward a dialog pattern. See the [W3C tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) and [W3C modal-dialog technique](https://w3c.github.io/wcag/techniques/html/H102.html).

That distinction matters. The implementation should preserve React Joyride’s dialog semantics, move focus into the bubble, trap focus while it is modal, support Escape, and restore focus when the bubble closes. It must not replace the component’s `alertdialog`/dialog behavior with `role="tooltip"` merely because “tooltip” is the product nickname.

### 2. Guidance must be brief, optional, contextual, and non-critical

The U.S. Web Design System recommends tooltips only for brief, non-critical supporting information; necessary task instructions should remain visible in the underlying interface. It also calls for keyboard access, Escape dismissal, adequate contrast, viewport-safe placement, and testing at 200% zoom. See the [USWDS tooltip guidance](https://designsystem.digital.gov/components/tooltip/) and [USWDS accessibility test checklist](https://designsystem.digital.gov/components/tooltip/accessibility-tests/).

For this app, that means the bubbles should explain a good operating sequence and why a workspace is useful, but must not become the only place a user can discover a safety rule, send requirement, status meaning, or recovery step. Existing headings, labels, read-only banners, confirmation flows, and operational guidance remain authoritative.

### 3. Prefer one short orientation plus on-demand contextual micro-tours

Long, cross-application tours force users to absorb controls before they have a task or relevant data. The better product shape here is:

1. One short first-use foundations tour on Overview.
2. Separate route-scoped tours that teach a concrete workspace.
3. No automatic route changes during a tour.
4. A persistent and obvious way to replay the guide for the current page.

This follows the general usability principle that help should be concise, task-focused, and available in context. Nielsen Norman Group’s help-and-documentation heuristic recommends presenting help at the moment it is needed and focusing it on concrete tasks. See [NN/g’s Help and Documentation heuristic](https://www.nngroup.com/articles/help-and-documentation/).

### 4. React Joyride 3.x is the best library fit

The current React Joyride project is MIT-licensed, supports React 16.8 through React 19, and is therefore compatible with this repository’s React 18 stack. Its current package metadata identifies version 3.2.0, React/React DOM peer support through 19, and an ESM build. See the [React Joyride repository](https://github.com/gilbarbara/react-joyride) and [current package metadata](https://raw.githubusercontent.com/gilbarbara/react-joyride/main/package.json).

The fit is stronger than basic compatibility:

- It has explicit tour states for waiting, running, paused, finished, and skipped.
- It supports an uncontrolled mode with `initialStepIndex`, which is appropriate for resuming server-persisted progress without manually reimplementing the whole state machine.
- It supports asynchronous `before` hooks and a `targetWaitTimeout` for delayed admin content.
- It exposes start, end, step, target-not-found, and error events for bounded persistence.
- It supports stable selectors, elements, refs, or functions as targets.
- Its accessibility behavior includes an `alertdialog`, `aria-modal`, focus trapping, Escape handling, a button-based beacon, and focus restoration. See [React Joyride accessibility](https://react-joyride.com/docs/accessibility), [how it works](https://react-joyride.com/docs/how-it-works), [step options](https://react-joyride.com/docs/step), and [events](https://react-joyride.com/docs/events).
- It supports custom tooltip and beacon components while providing the correct event/button props that must be spread onto custom controls. See [React Joyride custom components](https://react-joyride.com/docs/custom-components).

Use the v3 API and documentation. Many search results and code examples on the web still describe the older v2 callback API.

### 5. Driver.js is a credible alternative, but not the preferred one here

Driver.js is MIT-licensed, framework-neutral, dependency-free, approximately 5 KB, and supports tours, highlights, hints, progress, missing-element waits, and keyboard control. See the [Driver.js overview](https://driverjs.com/) and [configuration reference](https://driverjs.com/docs/configuration).

It would be a good choice for a framework-neutral or bundle-size-dominated application. In this repository, React Joyride wins because the admin app is already React, the tour will be lazy-loaded with that private route, static copy is safer and easier to express as JSX, React lifecycle integration is simpler to test, and the accessibility/focus behavior is documented in more implementation-specific detail.

### 6. Do not build positioning and focus management from scratch

A custom implementation looks small until it must handle sticky headers, horizontal mobile navigation, collision/flip behavior, portals, nested stacking contexts, target disappearance, scroll positioning, focus trapping, Escape, focus restoration, screen readers, reduced motion, and resize/reflow. Building those pieces locally would create more accessibility and regression risk than the feature warrants.

### 7. Persist progress by authenticated principal, not browser

The private application already has durable server-side principal identities. Server persistence gives the intended behavior across devices, browsers, and renewed sessions, and it avoids showing the “new user” tour again merely because storage was cleared on one device.

The browser must never submit or select the principal whose progress it changes. The API must derive `principal_id` and role from `requireAdminAccess(request)`. Do not put onboarding progress in `admin_sessions.metadata`, because sessions expire, sign-out-everywhere revokes them, and multiple sessions belong to the same principal.

`localStorage` may not be the source of truth. A short-lived in-memory guard is appropriate to prevent duplicate starts during a React render/session, but durable eligibility, skipped state, completion, and resume position belong in the database.

### 8. Version tours deliberately

Each tour needs a stable key and an integer content/structure version. A completed version must not replay automatically. When its steps or meaning change materially, increment that tour’s version; absence of progress for the new `(principal_id, tour_key, tour_version)` makes the user eligible again.

Do not bump versions for punctuation, styling, or harmless wording changes. Otherwise users will be retrained unnecessarily.

### 9. Tour state should be small and privacy-conscious

Persist only what is needed to control the experience:

- principal ID;
- tour key and version;
- status;
- last completed static step ID;
- started, updated, completed, and skipped timestamps.

Do not store page contents, CRM IDs, company names, contact information, target text, arbitrary selectors, email content, URLs, or a high-volume event stream. The progress table is an onboarding preference, not a new behavioral-surveillance system.

### 10. Codex needs an evidence-based completion loop

Current Codex guidance recommends specifying the goal, relevant context, constraints, and “done when” criteria; for multi-step work it recommends planning, testing, running the relevant checks, and reviewing the diff before accepting the result. Long-running work should name an outcome, constraints, and verification. See [Codex best practices](https://learn.chatgpt.com/guides/best-practices), [Prompting Codex](https://learn.chatgpt.com/docs/prompting#prompting-codex), and [Long-running work](https://learn.chatgpt.com/docs/long-running-work).

The prompt below therefore includes a bounded inspect → specify → test → implement → verify → review → continue loop and explicit exit gates. The loop is persistence toward a measurable outcome, not permission to deploy, touch production data, or make unrelated changes.

## Recommended product behavior

### Automatic behavior

- Auto-start only `admin-foundations` version 1.
- Start it only after all of these are true:
  - the current session is authenticated;
  - onboarding progress loaded successfully;
  - the active section is Overview;
  - the stable Overview targets are mounted;
  - the current version has no `completed` or `skipped` progress;
  - the current browser session has not already attempted to auto-start it.
- Do not redirect a user who signed directly into another `/admin/...` route merely to show onboarding.
- Never auto-start a section-specific tour.
- Never start a tour while another admin dialog/drawer is open.
- If the progress endpoint is unavailable, keep the admin application fully usable, do not fall back to repeated automatic tours, and keep an explicit manual guide available.

### Manual behavior

- Add a persistent **Guide this page** button to the authenticated admin page-header action area.
- The button starts or replays the eligible tour for the current route from its first step.
- On Overview it starts `admin-foundations`.
- On a CRM record it starts `crm-detail`; on the CRM index it starts `crm-index`.
- A manual replay must not downgrade a saved `completed` state to `in_progress` or `skipped`. A previously skipped user who manually reaches the end may be upgraded to `completed`.
- The action must be visible to viewers and admins, but the selected steps and copy must be appropriate for the current role.

### Suggested tour registry

Keep the first release small. Each step should answer “what is this?”, “why should I care?”, and “what should I do next?” in roughly one or two short sentences.

| Tour key | Route/scope | Suggested steps | Roles | Auto-start |
| --- | --- | --- | --- | --- |
| `admin-foundations` v1 | `/admin` Overview | Welcome; navigation; daily priority cards; focused workspaces; replay/help | admin, viewer | Yes, once |
| `crm-index` v1 | `/admin/crm` | Search/filter/sort; results and counts; open a deal room | admin, viewer | No |
| `crm-detail` v1 | `/admin/crm/:submissionId` | Record workflow; next action/diligence; communications/documents; save discipline | admin, viewer with read-only copy | No |
| `command-center` v1 | `/admin/command-center` | Action queue; source health; pipeline stages and decisions | admin, viewer with read-only copy | No |
| `deal-hunter` v1 | `/admin/deal-hunter` | Refresh/source state; scoring/review buckets; CIM workflow; history/follow-ups | admin, viewer with write/send steps omitted | No |
| `follow-ups` v1 | `/admin/follow-ups` | Priority/filter queue; open context; recommended next action; human-reviewed email controls | admin, viewer with compose/send omitted | No |
| `operations` v1 | `/admin/operations` | Readiness; failures/history; backup/storage health | admin only | No |
| `new-record` v1 | `/admin/new-record` | Minimum viable intake; economics can wait; ownership and next action | admin only | No |

Do not create one long tour that navigates through all eight routes. Route-scoped tours are easier to understand, more resilient to asynchronous content, and simpler to resume and test.

### Copy priorities grounded in the current app

Tour copy should reinforce, not replace, the existing `adminSectionMeta` guidance:

- Overview: start with overdue work and action items, then open a focused workspace.
- CRM: use filters for discovery; open a record for editing, documents, diligence, or advancement.
- CRM detail: save material changes before leaving the record.
- Command Center: work the global action queue first, then review the pipeline by stage.
- Deal Hunter: verify source freshness before acting, then work approvals and follow-ups.
- Follow-Ups: prioritize overdue conversations and delivery problems over weak engagement signals.
- Operations: resolve red states first; treat amber as degraded or awaiting verification.
- New Record: capture the opportunity, contact, owner, and next concrete action; complete financial detail when it becomes available.

Do not place customer-specific or live record data inside the static tour definitions.

## Recommended technical shape

### Dependency

- Add the current compatible React Joyride 3.x release and commit the lockfile.
- Verify the installed package’s peer requirements against React 18 before editing production code.
- Use v3 imports, events, statuses, options, and custom-component props; do not paste v2 callback examples.
- Keep the import inside the already-lazy private-admin dependency graph.

### Stable shared metadata

Create a small data-only registry, for example `shared/adminOnboarding.js`, containing:

- tour key;
- current integer version;
- eligible roles;
- route/section identity;
- ordered stable step IDs.

Do not put React nodes or DOM selectors in the shared server/client metadata. Put display copy and target functions/selectors in a client-only module such as `src/content/adminOnboardingTours.jsx`.

The server uses the data-only registry to reject unknown tour keys, unsupported versions, ineligible roles, invalid statuses, and unknown step IDs. The client uses the same metadata to map saved progress to the current tour.

### Durable schema

Use an additive table equivalent to:

```sql
create table admin_onboarding_progress (
  principal_id text not null,
  tour_key text not null,
  tour_version integer not null,
  status text not null,
  last_completed_step_id text,
  started_at timestamp not null,
  updated_at timestamp not null,
  completed_at timestamp,
  skipped_at timestamp,
  primary key (principal_id, tour_key, tour_version)
);
```

Enforce or validate these status values: `in_progress`, `completed`, and `skipped`. Absence of a row means `not_started`.

Required invariants:

- `principal_id` is always taken from the current authenticated session.
- Tour key/version/role/step IDs are validated against the bounded registry.
- `completed` is never downgraded for the same version.
- `skipped` may become `completed` after an explicit manual replay, but automatic logic must not restart it.
- `completed_at` is set only for completed state.
- `skipped_at` is set only for skipped state.
- A status update and its timestamp changes are one atomic upsert.
- Listing progress is bounded to the known tour registry; do not expose progress for other principals.
- SQLite and Supabase return the same normalized shape.
- Supabase RLS/service-role isolation follows the repository’s existing server-only table rules.

Do not store this in `admin_sessions.metadata` and do not create a general-purpose user-profile system for this feature.

### API

Add a narrow authenticated API, following current route conventions:

```text
GET   /api/admin/onboarding
PATCH /api/admin/onboarding/:tourKey
```

Both routes require `requireAdminAccess`. The GET returns only the current principal’s bounded progress. The PATCH accepts a bounded body like:

```json
{
  "tourVersion": 1,
  "status": "in_progress",
  "lastCompletedStepId": "overview-priorities"
}
```

The body must not accept `principalId`, `username`, `role`, timestamps, or arbitrary metadata. Derive identity and role on the server. Return a normalized saved record.

Prefer explicit `400` responses for invalid tour keys, versions, statuses, or step IDs; `401` for missing authentication; and `403` when the current role is not eligible for a known tour. Do not leak another principal’s state.

An onboarding progress write is allowed for viewers because it changes only that viewer’s self-scoped preference, not CRM or operational data. Keep all existing business mutations admin-only.

### Server service and storage methods

Keep route handlers thin. Put validation/transition behavior in a focused service such as `server/services/adminOnboarding.js`, with storage methods similar to:

```text
listAdminOnboardingProgress(principalId)
upsertAdminOnboardingProgress(record)
```

Use repository-standard timestamp and normalization conventions. Do not add audit events that include step-by-step browsing behavior; the progress row itself is sufficient for this low-risk preference.

### Client controller

Create a focused admin component/controller rather than adding all tour logic directly to the already-large `DashboardPage.jsx`. A reasonable decomposition is:

```text
src/components/admin/AdminOnboarding.jsx
src/components/admin/AdminTourTooltip.jsx
src/content/adminOnboardingTours.jsx
shared/adminOnboarding.js
```

`DashboardPage` should provide only the information the controller needs, such as authentication, role, active section, CRM detail/list state, and relevant content-ready signals.

Use React Joyride’s uncontrolled mode unless inspection proves a concrete reason not to. Resume an interrupted `in_progress` tour by mapping `last_completed_step_id` to `initialStepIndex`. Use `before` hooks and bounded target waiting for async UI. Do not drive `stepIndex` from an effect that reacts to unrelated app state; current Joyride guidance warns that this can desynchronize its lifecycle and keyboard/overlay behavior.

Persist only meaningful transitions:

- `tour:start` for a genuinely new automatic/manual run that is not a replay of a terminal state;
- `step:after` with the static step ID just completed;
- `tour:end` as `completed` or `skipped`.

Do not PATCH for every render, scroll event, tooltip open, focus change, or target poll. Keep persistence failures non-blocking to the underlying admin work, surface a concise guide-specific error if useful, and prevent an infinite retry/render loop.

### Target anchors

Add explicit, stable attributes to wrapper elements, for example:

```jsx
data-admin-tour="section-navigation"
data-admin-tour="page-guidance"
data-admin-tour="overview-priorities"
data-admin-tour="workspace-launcher"
data-admin-tour="crm-filters"
data-admin-tour="crm-results"
```

Use stable wrapper targets that exist for loading, empty, error, and populated states. Do not target generated Tailwind classes, translated/copy text, `nth-child`, record IDs, or a particular customer row. A product-tour selector is a UI contract; name it accordingly and cover it with tests.

Targets inside `DealHunterWorkspace`, `FollowUpsWorkspace`, `OperationsCenter`, `CrmNavigation`, and CRM detail should be placed in those components rather than reached through brittle descendants from `DashboardPage`.

### Tour interaction rules

- Use an overlay for guided steps and block interaction with the highlighted target. The tour teaches; it must not click or activate destructive/business actions.
- Provide Back, Next/Done, Skip, and Close behavior with clear labels.
- Configure the close control to end/skip the tour rather than silently advancing to another step.
- Display progress such as “Next (2 of 4).”
- Keep bubbles compact and use automatic placement/collision handling.
- Set the tour z-index above the admin topbar, sticky navigation, and ordinary drawers; do not use an unbounded arbitrary maximum.
- Do not open a tour on top of an existing drawer, modal, confirmation, email composer, or corrected-recipient workflow.
- Missing targets should not leave an overlay or body-scroll lock behind. In development/test, make the failure diagnosable without logging sensitive page content.
- A tour must never submit a form, navigate to an external URL, send an email, refresh a data source, update a CRM record, or trigger any business mutation.

### Custom styling

Use a custom Joyride tooltip only if needed to match the existing moss/pine/clay/parchment admin design. If customized:

- spread `tooltipProps` on the container;
- spread Joyride’s supplied Back, Primary, Skip, and Close props on the actual buttons;
- keep its dialog semantics and focus behavior;
- render static React content, not unsanitized HTML;
- use existing CSS variables and focus-visible conventions;
- use a viewport-safe width such as `min(22rem, calc(100vw - 2rem))`;
- keep text contrast at least 4.5:1 and component/adjacent contrast at least 3:1;
- ensure the arrow and spotlight do not obscure the target or current control labels.

Respect `prefers-reduced-motion`. Use zero-duration tour scrolling when reduction is requested, avoid a continuously pulsing custom beacon, and do not add smooth-scrolling effects that override the preference. Test reflow at 200% zoom and mobile widths.

### Role behavior

Administrators may see all eligible tours. Viewers must not see Operations or New Record guides and must not receive steps that describe editing, sending email, importing sources, approving CIM requests, changing dispositions, or other hidden/forbidden actions.

Do not merely hide a forbidden step’s target while leaving its copy in the tour. Filter both targets and copy before the tour starts, and ensure progress counts reflect the filtered list.

### Resilience and performance

- Keep the admin application usable if the onboarding GET or PATCH fails.
- Fetch progress once after successful authentication, not on every section render.
- Do not refetch all progress after every step; update a small local cache from the PATCH response.
- Abort or ignore stale progress requests on unmount/logout.
- Do not start a tour after logout, during auth loading, or after a stale response for a previous session.
- Clean up Joyride event subscriptions under React Strict Mode.
- Avoid a second global state framework; current React state/context is sufficient.
- Keep tour code in the private lazy chunk and verify the public routes do not render or fetch it.

## Copy/paste master implementation prompt

For a persistent Codex run, start Goal mode with `/goal` when that surface supports it, then paste the prompt below as the goal. The execution loop is also self-contained if Goal mode is unavailable.

---

You are working in the existing Uckele Group repository. Implement a production-quality guided onboarding system made of small anchored popover bubbles for new users of the authenticated private admin application.

The outcome is an accessible, versioned, role-aware tour system that helps admins and read-only viewers learn the application’s highest-value workflows without blocking ordinary work. Auto-start one short Admin Foundations tour once for a new authenticated principal on `/admin`; provide short, route-scoped guides for the current admin page through a persistent “Guide this page” action; and persist progress on the server so completion follows the authenticated principal across sessions and devices.

This feature is only for the private admin application under `/admin`. Do not add any onboarding UI, anchors, API calls, or tour state to the public acquisition site, contact flow, Thank You page, privacy/FAQ pages, or `/secure-documents`. The bubbles render in the private React admin UI, while eligibility and progress are owned by the authenticated server-side principal.

Implement the feature completely: dependency and lockfile, shared tour metadata, additive SQLite and Supabase schema, storage parity, server service and API, admin React controller and accessible bubble UI, stable targets, role-specific copy, tests, and documentation. Do not stop at research, a plan, a static mockup, or one happy-path tour.

### Architecture and behavior to preserve

Verify these statements against the current code before relying on them:

- `src/App.jsx` lazy-loads the `/admin` application.
- `src/pages/DashboardPage.jsx` owns authentication state, role, active admin section, the page header, navigation, and route-level workspace composition.
- `src/content/adminSectionMeta.js` contains the current workflow descriptions and priority guidance; reuse its meaning in tour copy.
- `src/components/admin/CrmNavigation.jsx`, `DealHunterWorkspace.jsx`, `FollowUpsWorkspace.jsx`, and `OperationsCenter.jsx` own important target areas.
- `server/services/auth.js` and `admin_sessions` expose a durable authenticated `principal_id`; administrators map to the intended primary admin principal and viewers have identity-specific principals.
- `requireAdminAccess` admits both admin and viewer sessions; existing business mutations remain admin-only.
- `server/storage/sqlite.js`, `server/storage/supabase.js`, `supabase/schema.sql`, and forward migrations must stay behaviorally equivalent.
- The repository’s Node, Vitest/Testing Library, Playwright, lint, and build conventions are the verification framework. Extend them instead of creating a parallel harness.

Preserve unrelated worktree changes. The repository may already be dirty. Do not modify, delete, stage, or overwrite user-owned files outside this feature.

### Product requirements

1. Add a short `admin-foundations` versioned tour for Overview with no more than five steps: welcome/orientation, section navigation, daily priority cards, focused workspace launcher, and the persistent replay/help action.
2. Auto-start only the current version of `admin-foundations`, and only after authentication, progress loading, Overview route activation, and stable target mounting. Never redirect a deep-linked admin route just to show a tour.
3. Persist completion and skip state. A completed or skipped current version must not auto-start again. An interrupted `in_progress` tour may resume from the next step after its last completed stable step ID.
4. Add a persistent, keyboard-accessible “Guide this page” action to the authenticated admin page header. It always allows a manual start/replay of the tour for the current route.
5. Add separate, short, route-scoped tours for CRM index, CRM detail, Command Center, Deal Hunter, Follow-Ups, Operations, and New Record. Do not build one cross-route tour and do not automatically start these section tours.
6. Filter tour availability, steps, targets, copy, and progress counts by role before a tour starts. Viewers receive only read-only guidance. Operations and New Record guides are admin-only.
7. Keep every bubble concise and action-oriented. Explain what the area is, why it matters, and what workflow priority to use. Reuse the meaning of `adminSectionMeta`; do not create conflicting operational rules.
8. The tour is guidance only. It must never invoke a business action, submit a form, follow an external link, send email, refresh sources, approve outreach, mutate CRM data, or open on top of another modal/drawer/confirmation.
9. The underlying interface remains authoritative and fully usable without the tour. Do not move required safety, compliance, status, or recovery instructions exclusively into bubbles.
10. If onboarding persistence is unavailable, the admin app continues to work. Suppress repeated automatic attempts for that browser session and retain an explicit manual guide when safely possible.

### Library decision

Use the current compatible React Joyride 3.x release. Verify the installed version and peer dependencies before implementation and commit `package.json` plus `package-lock.json`. Use the current v3 API; do not copy v2 examples.

Prefer Joyride’s uncontrolled mode. Use `initialStepIndex` to resume progress, static step IDs for persistence, bounded `before` hooks/target waiting for async content, and official v3 events/statuses for progress transitions. Do not drive a controlled `stepIndex` from effects tied to unrelated application state unless a concrete testable requirement makes that unavoidable.

Keep the dependency within the private admin lazy-loading graph. Do not implement custom popover positioning, collision handling, focus trapping, or scroll management from scratch.

### Shared tour contract

Create a data-only registry in a neutral module such as `shared/adminOnboarding.js`. For each tour define a stable key, positive integer current version, eligible roles, route/section identity, and ordered stable step IDs.

Keep React nodes, copy, and target selectors/functions in a client-only module such as `src/content/adminOnboardingTours.jsx`. The server and client must share the data-only identity/version/role/step contract so unknown tour keys, stale/future versions, ineligible roles, invalid statuses, and unknown step IDs are rejected deterministically.

Suggested initial keys and scopes:

- `admin-foundations`: Overview; admin and viewer; only automatic tour.
- `crm-index`: CRM index; admin and viewer.
- `crm-detail`: CRM record route; admin and viewer with role-aware copy.
- `command-center`: admin and viewer with role-aware copy.
- `deal-hunter`: admin and viewer, omitting write/send/import steps for viewers.
- `follow-ups`: admin and viewer, omitting compose/send actions for viewers.
- `operations`: admin only.
- `new-record`: admin only.

### Persistence and transition invariants

Add an `admin_onboarding_progress` table or equivalently narrow schema with this logical key:

```text
(principal_id, tour_key, tour_version)
```

Store only:

- `principal_id`;
- `tour_key`;
- `tour_version`;
- `status` in `in_progress | completed | skipped`;
- nullable `last_completed_step_id`;
- `started_at`;
- `updated_at`;
- nullable `completed_at`;
- nullable `skipped_at`.

Absence means `not_started`. Derive `principal_id` and role exclusively from the authenticated session. Never accept them from a request body or query. Do not store CRM/customer data, arbitrary selectors, target text, URLs, page content, or high-volume event telemetry.

Enforce these transitions atomically:

- `completed` is never downgraded for the same tour version.
- `skipped` is terminal for automatic eligibility but may become `completed` when the user later finishes an explicit manual replay.
- Manual replay of a completed tour is ephemeral and must not turn it back into `in_progress` or `skipped`.
- `completed_at` is populated only on completion.
- `skipped_at` is populated only on skip.
- An older version does not satisfy the current version.
- The last completed step ID must be valid for that exact tour/version and current role contract.

Do not store onboarding in session metadata and do not use `localStorage` as durable authority. An in-memory one-attempt guard is appropriate to prevent duplicate automatic starts during a mounted browser session.

Implement equivalent SQLite and Supabase behavior, an additive forward Supabase migration, the complete `supabase/schema.sql` representation, indexes/constraints that support the exact lookup/upsert path, service-role-only access, and the repository’s existing RLS isolation posture.

### API and authorization

Add:

```text
GET   /api/admin/onboarding
PATCH /api/admin/onboarding/:tourKey
```

Both routes require `requireAdminAccess`. GET returns only the current principal’s bounded progress. PATCH accepts only the current tour version, a validated status, and an optional validated last completed step ID. It must not accept identity, role, timestamps, or arbitrary metadata.

Use thin routes and a focused server service for validation and transition rules. Use normalized adapter output. Return clear bounded errors: unauthenticated, role-ineligible, unknown tour, unsupported version, invalid status, or invalid step. Never reveal whether another principal has progress.

Viewer writes are allowed only to that viewer’s own onboarding preference rows. This exception must not loosen any existing admin-only business route.

### Client integration

Keep tour orchestration out of the body of the already-large `DashboardPage.jsx` as much as possible. Create focused components/modules, for example:

```text
src/components/admin/AdminOnboarding.jsx
src/components/admin/AdminTourTooltip.jsx
src/content/adminOnboardingTours.jsx
shared/adminOnboarding.js
server/services/adminOnboarding.js
```

Mount the controller only after an authenticated admin/viewer session exists. Pass it only the active route/section, role, CRM index/detail state, content-ready signals, and callbacks it truly needs.

Fetch progress once per authenticated session and update a small local cache from PATCH results. Handle logout/unmount and stale responses. Do not create a refetch or render loop.

Persist only meaningful lifecycle changes: a genuinely new start, a completed stable step, and final completed/skipped status. Do not write for scrolls, focus, every render, beacon open, or target polling. A persistence error must not leave the overlay, focus trap, or body scroll locked.

For automatic eligibility, require all of: authenticated session, loaded progress, Overview active, current foundations version not completed/skipped, stable targets present, no conflicting modal/drawer, and no prior auto-start attempt in this mounted browser session.

### Stable targets

Add explicit `data-admin-tour` markers to stable semantic wrappers. Do not target Tailwind implementation classes, text content, `nth-child`, generated IDs, or a specific CRM/customer row.

Targets must exist across loading, empty, populated, and recoverable error states wherever possible. Put anchors in the component that owns the UI. Use wrappers for CRM filters/results, Command Center queue/source/pipeline, Deal Hunter source/review/approval/history, Follow-Ups filters/queue/detail entry, Operations readiness/history/storage, New Record form sections, and the authenticated page-header guide action.

Missing optional targets must advance/skip cleanly, release overlay/focus/scroll state, and be diagnosable in development/tests without logging sensitive content. A tour may be marked completed only if at least one intended step was actually displayed; do not silently “complete” a wholly broken target set.

### Accessibility and interaction requirements

Treat a multi-button tour bubble as an interactive dialog, not an ARIA tooltip. Preserve Joyride’s `alertdialog`/dialog semantics, `aria-modal`, focus trap, Escape behavior, and focus restoration. Do not disable the focus trap globally.

If you create a custom tooltip component:

- spread `tooltipProps` on its root;
- spread all supplied Joyride button props on the actual Back, Next/Done, Skip, and Close buttons;
- provide an accessible title and concise body;
- render static React content, never unsanitized HTML;
- retain visible focus indicators;
- make button order and labels predictable;
- configure Close to end/skip rather than silently advance;
- show progress such as “Next (2 of 4).”

Use an overlay and block interaction with the highlighted target during a guided step. The tour may explain a send, delete, import, archive, source-refresh, or approval control, but it must never let the instructional overlay activate that control.

Use collision-aware placement, a mobile-safe bubble width, and a z-index above the app’s sticky header/navigation and ordinary dialogs. Verify no clipping at 320px width, representative desktop widths, and 200% zoom.

Respect `prefers-reduced-motion`: use immediate/zero-duration tour scrolling when requested, avoid a continuously pulsing custom beacon, and ensure motion is not required to discover or understand a step.

Keyboard behavior must include Tab/Shift+Tab within the dialog, Escape dismissal, usable Back/Next/Skip/Close controls, restoration of focus to the trigger or sensible prior element, and no keyboard trap after completion, skip, missing target, API failure, route change, or unmount.

### Copy requirements

Keep copy brief, concrete, and free of customer data. Ground it in current application behavior:

- Overview: overdue and action items first, then focused workspace selection.
- CRM: filters for discovery, deal room for editing/diligence/documents, save material changes before leaving.
- Command Center: global action queue first, then pipeline stages; verify source state.
- Deal Hunter: refresh/check source freshness before decisions, then approvals and follow-ups.
- Follow-Ups: overdue conversations and delivery problems before weak engagement; admins review every send.
- Operations: red states first, amber states as degraded/awaiting verification.
- New Record: opportunity/contact/owner/next action first; incomplete economics can be added later.

Viewer copy must describe inspection and read-only workflows only. Do not expose hidden admin-only capabilities through tour text.

### Looping execution contract

This is a persistent implementation task. Do not interpret one plan, installed dependency, one working bubble, one schema adapter, or one green unit test as completion. Continue through vertical slices until every applicable definition-of-done item and exit gate is satisfied.

At the beginning:

1. Read repository instructions such as `AGENTS.md` if present, inspect `git status`, and identify unrelated/user-owned changes that must be preserved.
2. Read this entire goal, then inspect the referenced auth, routes, storage adapters, admin layout/page, workspace components, CSS, and existing tests before editing.
3. Verify the current React Joyride v3 package/API and React compatibility. Do not implement against remembered v2 props.
4. Run a narrow baseline covering auth/session principals, storage initialization/migration, admin API behavior, Dashboard authentication/rendering, and current Playwright admin navigation. Record pre-existing failures separately.
5. Create and maintain a plan by vertical slice. Keep exactly one item in progress and update statuses only from code/test evidence.

For every vertical slice, repeat:

1. **Reconcile:** Re-read the outcome, current plan, `git diff`, relevant source/tests, and latest verification evidence. Select the smallest remaining end-to-end slice that produces user-visible value or proves a persistence/accessibility invariant.
2. **Specify:** Before production edits, state the slice’s acceptance cases, negative cases, auth boundary, role behavior, persistence transition, missing-target behavior, and SQLite/Supabase impact.
3. **Test first where practical:** Add or update focused failing tests for the behavior and important negative cases. Do not cover only a happy path.
4. **Implement:** Make the smallest coherent change using repository conventions. Avoid broad Dashboard rewrites, a new global-state framework, a custom positioning engine, and unrelated cleanup.
5. **Run targeted gates:** Immediately run the closest backend, UI, and/or browser tests. Fix root causes; do not weaken assertions, add arbitrary waits, skip tests, swallow errors, or simply broaden timeouts.
6. **Adversarial review:** Inspect identity spoofing, cross-principal reads/writes, viewer leakage, stale sessions, multi-tab updates, terminal-state downgrade, version mismatch, missing targets, empty/loading states, route changes, API failure, Strict Mode duplicate subscriptions, duplicate auto-starts, modal conflicts, focus/scroll cleanup, reduced motion, mobile clipping, and accidental business actions.
7. **Integrate:** Run adjacent regressions, confirm adapter parity, inspect the actual diff for duplicated concepts, unused code, brittle selectors, sensitive logs, unbounded input/output, public-route leakage, and unintended bundle impact.
8. **Update and continue:** Mark a slice complete only from passing evidence, update the plan, choose the next incomplete slice, and continue without waiting for another instruction.

If the same test, target strategy, or implementation approach fails three times, stop rerunning it unchanged. Inspect the DOM lifecycle, Joyride v3 contract, logs, test fixtures, route state, and surrounding code; state a root-cause hypothesis; change the approach; and add a regression test when fixed.

Implement in this vertical order unless repository inspection proves a safer dependency order:

1. shared tour identity/version/role/step contract and validation tests;
2. SQLite schema/storage and migration coverage;
3. Supabase schema/migration/storage parity and isolation coverage;
4. server onboarding service, state transitions, and authenticated API tests;
5. client progress controller and role/eligibility tests;
6. accessible Joyride bubble, meaningful-event persistence, resume/skip/replay behavior;
7. stable Overview targets and automatic Admin Foundations tour;
8. persistent Guide this page action and route-scoped admin/viewer tours;
9. loading/empty/error/missing-target resilience, responsive styling, and reduced motion;
10. Playwright keyboard/mobile/reload tests and documentation.

After functional slices pass, run an optimization/resilience loop:

1. Confirm progress is fetched once per authenticated session rather than once per route/render.
2. Confirm PATCH writes occur only on meaningful lifecycle transitions and cannot form an event/render loop.
3. Confirm the tour dependency remains in the private lazy admin graph and public routes render no guide DOM or onboarding requests.
4. Confirm target lookup uses stable contracts and does not query large record lists or customer-specific nodes.
5. Confirm missing targets and persistence failures always release focus, overlay, scroll, and subscriptions.
6. Confirm role filtering occurs before progress calculation and display so counts and labels remain truthful.
7. Re-run correctness/accessibility tests after optimization; do not trade away identity isolation, role safety, or keyboard behavior for fewer lines or faster animation.

Before declaring completion, run the closure loop:

1. Search the feature diff for `TODO`, `FIXME`, placeholder copy, deprecated Joyride v2 props, raw `innerHTML`, arbitrary user selectors, `localStorage` authority, disabled tests, console-only persistence, and accidental public-route integration.
2. Trace a new admin end to end: authenticate → GET no current foundations state → Overview targets ready → one automatic tour → step progress → completion → reload/new session → no automatic replay → manual replay still works.
3. Trace interruption: start → complete one step → reload → resume after the last completed step → skip → future reload does not auto-start → manual replay can finish and upgrade to completed.
4. Trace a viewer end to end: self-scoped progress works; no Operations/New Record tours; no edit/send/import/approval targets or copy; existing business mutations remain forbidden.
5. Trace failure paths: onboarding GET fails, PATCH fails, target never appears, route changes, logout occurs, modal is open, component unmounts, two tabs update, reduced motion is enabled, and viewport is narrow. The admin app must remain usable and no trap/overlay remains.
6. Verify a public route and `/secure-documents`: no guide button, bubble, tour anchors, onboarding request, or auto-start behavior.
7. Run `git diff --check`, `npm run lint`, focused Node tests, focused Vitest tests, `npm run check`, the new focused Playwright spec against a fresh build, and then `npm run test:browser` when browser prerequisites are available.
8. Review the production build output and actual browser behavior at desktop, mobile, keyboard-only, 200% zoom, and reduced motion. Do not rely exclusively on jsdom snapshots for positioning/focus claims.
9. Re-read every definition-of-done item and map it to a file, test, or manual verification result. If a gate fails, return to the implementation loop instead of producing a final handoff.

Do not deploy, run production migrations, modify live Supabase data, use production credentials, send emails, trigger Deal Hunter sources, or perform real CRM mutations while building/testing this feature. Use local storage providers, mocks, route interception, fixtures, and test identities. External production configuration is not required for completing safe code and tests.

You may stop only when either all implementation and verification gates are satisfied and the final handoff is complete, or a genuinely external permission/decision would materially change the design and no safe independent slice remains. If blocked externally, finish every safe slice first and report the exact blocker without claiming completion.

### Required tests

Add proportionate coverage for at least:

#### Storage and server

- SQLite creates and reopens the additive progress table without damaging existing auth/session data.
- Supabase schema/migration contains equivalent columns, key, constraints/indexes, RLS, and service-role access.
- Storage list/upsert shapes match across adapters.
- GET/PATCH reject unauthenticated access.
- A request cannot select or spoof another principal.
- An admin and viewer see only their own progress.
- Unknown keys, invalid versions/statuses/steps, and ineligible-role tours are rejected.
- Completion cannot be downgraded; skipped can be upgraded only by the intended completion path.
- Older tour versions do not suppress the current version.
- Repeated identical updates are safe/idempotent enough for retries and do not create duplicate rows.

#### React/UI

- The foundations tour is eligible only after auth + progress + Overview target readiness.
- It attempts automatic start only once per mounted browser session.
- Completed/skipped current versions do not auto-start.
- In-progress state maps a stable last-completed step ID to the correct uncontrolled `initialStepIndex`.
- Manual replay remains available after completion and does not downgrade terminal progress.
- Viewer tour lists/steps omit admin-only routes and actions.
- Guide this page chooses the correct tour for Overview, CRM index, CRM detail, and other sections.
- Loading, empty, and error wrappers retain stable target anchors.
- GET/PATCH failures do not block the admin page or cause repeated requests.
- Event subscriptions are cleaned up and do not double-write under Strict Mode.

#### Browser/accessibility

- A mocked authenticated new admin sees the foundations dialog once, can use Next/Back/Skip/Done, and completion is persisted.
- Reload with completed progress does not reopen it; Guide this page can replay it.
- Keyboard Tab/Shift+Tab remain within an open dialog; Escape closes it; focus returns sensibly; no overlay/focus trap remains.
- A mobile viewport keeps the bubble, controls, spotlight, sticky nav, and target in view without horizontal overflow.
- Missing/delayed targets use bounded waiting and fail gracefully.
- A viewer never sees admin-only tour options or copy.
- At least one public route makes no onboarding API request and renders no guided-tour UI.
- Reduced-motion behavior uses no smooth tour scroll and remains fully understandable.

Use deterministic mocked endpoints and fake identities. Do not make browser tests depend on production data, a live provider, or arbitrary sleep.

### Definition of done

The feature is complete only when all applicable statements are true:

- New authenticated principals receive one concise Admin Foundations tour on Overview.
- Completion, skip, version, and resume progress persist by authenticated `principal_id` across sessions/devices.
- Identity comes only from the server session; cross-principal access is impossible through the API.
- Viewers receive only appropriate read-only guidance.
- Every admin route has a concise manual Guide this page experience, with admin-only routes correctly excluded for viewers.
- Tours use stable route/component-owned anchors and survive loading/empty/error states without trapping users.
- Dialog semantics, focus management, Escape, focus restoration, progress, contrast, mobile reflow, zoom, and reduced motion are verified.
- No tour can activate a business mutation.
- The admin application remains usable when onboarding persistence or a target fails.
- No public route or secure-document flow renders or calls the onboarding feature.
- SQLite and Supabase schemas/adapters are equivalent and additive.
- Relevant targeted tests, full non-browser checks, production build, and browser tests pass, or any environment-only unavailable browser gate is reported precisely with all available alternatives completed.
- The final handoff lists changed files, migration/configuration implications, exact test commands/results, manual accessibility/browser checks, and any genuinely remaining risk. Do not claim deployment or production migration.

---

## Suggested verification commands for the implementation run

Codex should confirm exact file/test names after creating them, but the expected shape is:

```bash
node --test test/adminAuth.test.js test/sqliteAuthMigration.test.js test/supabaseSecurity.test.js test/adminOnboarding.test.js
npx vitest run test-ui/AdminOnboarding.test.jsx test-ui/DashboardAuth.test.jsx
npm run lint
npm run check
npm run build
npx playwright test test-browser/admin-onboarding.spec.js
npm run test:browser
git diff --check
```

Do not repeatedly run the full suite after every small edit. Use the closest test during each slice, then run the full closure gates once integration is coherent.

## Expected implementation files

These are a guide, not a mandate; Codex should confirm repository conventions first:

```text
package.json
package-lock.json
shared/adminOnboarding.js
server/services/adminOnboarding.js
server/storage/sqlite.js
server/storage/supabase.js
server/app.js
supabase/schema.sql
supabase/migrations/<timestamp>_admin_onboarding.sql
src/components/admin/AdminOnboarding.jsx
src/components/admin/AdminTourTooltip.jsx
src/content/adminOnboardingTours.jsx
src/pages/DashboardPage.jsx
src/components/admin/CrmNavigation.jsx
src/components/admin/DealHunterWorkspace.jsx
src/components/admin/FollowUpsWorkspace.jsx
src/components/admin/OperationsCenter.jsx
src/index.css
test/adminOnboarding.test.js
test/supabaseSecurity.test.js
test-ui/AdminOnboarding.test.jsx
test-browser/admin-onboarding.spec.js
README.md or docs/backend-setup.md
```

Avoid expanding `DashboardPage.jsx` with a second monolithic subsystem. Add only stable anchors and the narrow controller integration it needs.

## Final recommendation

This should be implemented as a small private-admin learning system, not a public-site tooltip feature and not a generic analytics platform. React Joyride supplies the difficult interaction mechanics; the repository supplies authentication, role semantics, workflow copy, persistence adapters, and test infrastructure. The highest-value design choice is restraint: one automatic foundations tour, short on-demand page guides, versioned per-principal state, and no tour-driven business actions.
