**Repo AI Handoff — Quick Guide**

This file helps AI coding agents get productive fast in the Rezept-Organizer codebase.

**Big Picture**:

- **Type**: Single-page client-side web app (no build step). Serve `index.html` and the `js/` modules.
- **State**: App uses one central state object persisted in localStorage. All UI modules read from that state and mutate it via `window.app` helpers.

**Key files / entry points**:

- App shell & router: [js/app.js](js/app.js#L1-L200) — exposes `window.app` (`getState`, `setState`, `update`, `persist`, `navigate`) and mounts view renderers.
- Persistence & normalization: [js/storage.js](js/storage.js#L1-L40) and [js/storage.js](js/storage.js#L549-L620) — constants `STORAGE_KEY` (`einkauf_rezepte_v1`), `loadState()` and `saveState()` with recovery and quarantine behaviour.
- Feature logic: [js/recipes/recipesLogic.js](js/recipes/recipesLogic.js#L1-L200) — example of business logic that reads/writes `state` and exposes `window.recipesLogic`.
- Views: `js/recipes/recipesView.js`, `js/inventory.js`, `js/shopping.js` — renderer functions are attached to `window` and invoked from `app.render()`.

**Project-specific conventions** (do not assume standard module imports):

- Global modules: Code exposes functionality on `window.*` (e.g., `window.recipesLogic`, `window.ui`, `window.models`). Prefer calling those instead of importing.
- Central state: Treat the state object as the single source-of-truth. Use `window.app.update(mutator)` to perform changes; this clones, mutates and commits via `saveState()`.
- Persistence guarantees: `saveState()` writes both `STORAGE_KEY` and a recovery key. If state parsing fails, `loadState()` attempts recovery and may quarantine raw data.
- Render contract: Renderer functions follow signature `(container, state, persist)` and are registered as `window.render<Thing>View` (see [js/app.js](js/app.js#L1-L200)).

**Examples / common symbols**:

- Read current state: `window.app.getState()`
- Update safely: `window.app.update(state => { /* mutate clone */ })`
- Force save/repair: `saveState(state)` and `loadState()` are in [js/storage.js](js/storage.js#L549-L620).
- Shopping & planning helpers: `window.recipesLogic.reconcileShoppingWithPlan(...)` (see [js/recipes/recipesLogic.js](js/recipes/recipesLogic.js#L1-L200)).

**PWA / runtime notes**:

- Service worker registration is conditional on `window.APP_META.isProd` (see [js/app.js](js/app.js#L1-L200)). In dev the SW is unregistered to avoid caching during development.

**Developer workflow (discoverable)**:

- No project build found. To test changes open `index.html` in a browser or run a simple static server from the repo root (e.g. `npx http-server .` or `npx serve .`).
- To observe persistence and recovery behaviours, use devtools -> Application -> Local Storage and inspect `einkauf_rezepte_v1` and `einkauf_rezepte_v1__recovery`.

**When editing code** (practical tips for an AI):

- Prefer `window.app.update(...)` over manual localStorage writes so normalization and UI re-rendering run consistently.
- If you add new cross-module helpers, expose them on `window` (follow existing pattern) and update callers that expect `window.<name>`.
- Follow the existing state shape. Use `ensureStateShape()` and `migrate*()` helpers in [js/storage.js](js/storage.js#L1-L200) for compatibility.

**Where to look for feature examples**:

- Recipe rendering & modals: [js/recipes/recipesView.js](js/recipes/recipesView.js#L1-L200) and [js/recipes/recipesModals.js](js/recipes/recipesModals.js#L1-L200).
- State transformation and pantry normalization: [js/storage.js](js/storage.js#L1-L200) and [js/storage.js](js/storage.js#L120-L260).
- Business logic examples: [js/recipes/recipesLogic.js](js/recipes/recipesLogic.js#L1-L200).

If anything here is unclear or you want additional examples (tests, add-on conventions, or CI hooks), tell me which areas to expand.
