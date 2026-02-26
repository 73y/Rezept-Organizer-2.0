# AI_PLAYBOOK.md — Single Source of Truth

> **PROMPT ARROW** — Paste this at the top of any future AI prompt:
> ```
> IMPORTANT: Read ./AI_PLAYBOOK.md first and follow it as the single source of truth.
> If anything conflicts, AI_PLAYBOOK.md wins.
> ```

---

## 1. Project Snapshot

| Key | Value |
|-----|-------|
| **Project** | Rezeptorganizer (PWA) |
| **Stack** | Vanilla HTML / CSS / JS + Service Worker + GitHub Pages |
| **Goal** | Stable releases with no mixed-cache issues |
| **Repo** | `d:\alles\Development\AI-Programming\Rezept-Organizer-2.0` |
| **Main branch** | `main` |

---

## 2. Non-Negotiable Rules

1. **This file is the single source of truth.** If a task prompt conflicts with this playbook, this playbook wins.
2. **Small, frequent commits.** One logical change per commit. Never batch unrelated changes.
3. **No push / merge** unless the task explicitly instructs "push now" or "merge now".
4. **No unrelated refactors.** Scope changes to exactly what was requested.
5. **Never skip hooks** (`--no-verify`) or force-push to `main` unless explicitly instructed.
6. **Do not paste large code blocks in chat.** All edits happen directly in the repo.

---

## 3. Modes & Permissions (Hard Rule)

### Default Mode (Execution Mode)
- Default is EXECUTION mode:
  - Implement ONLY what the current task asks for.
  - Minimal scope; no extra refactors; no "nice-to-have" changes.
  - Keep commits small and focused.

### Plan / Audit Mode (Only if explicitly enabled)
- Plan/Audit Mode is ONLY allowed if the user writes: `PLAN MODE: ON`
- In Plan/Audit Mode you may:
  - Do a broad audit, map responsibilities, identify risks/duplications.
  - Propose a step-by-step plan + test checklist BEFORE coding (if asked).
- If `PLAN MODE: ON` is NOT present, do NOT spend tokens on broad planning.

### Multi-Agent / Parallel Work (Only if explicitly enabled)
- Multi-agent / parallel coding is ONLY allowed if the user writes: `MULTI-AGENT: ON`
- If not enabled:
  - Work sequentially in one coherent change set.
  - Do not split work across parallel threads/agents.

### Override Rule
- The user can override these rules only by explicitly writing the keywords above in the task prompt.

---

## 4. Folder Structure (Hard Rule)

```
/                        ← repo root
├── index.html
├── styles.css
├── service-worker.js    ← MUST stay in ROOT, never move
├── manifest.webmanifest
├── offline.html
├── AI_PLAYBOOK.md
├── js/
│   ├── appMeta.js
│   ├── storage.js
│   ├── models.js
│   ├── utils.js
│   ├── ui.js
│   ├── audit.js
│   ├── actions.js
│   ├── baseIngredients.js
│   ├── ingredients.js
│   ├── dashboard.js
│   ├── stats.js
│   ├── inventory.js
│   ├── settings.js
│   ├── purchaselog.js
│   ├── cookhistory.js
│   ├── app.js
│   ├── shopping.js      ← stub only, no logic
│   ├── shopping/
│   │   ├── openFoodFacts.js
│   │   ├── receiptParsing.js
│   │   ├── receiptData.js
│   │   ├── shoppingCore.js
│   │   ├── receiptScanning.js
│   │   ├── receiptModals.js
│   │   ├── shoppingScanner.js
│   │   └── shoppingView.js
│   └── recipes/
│       ├── recipesLogic.js
│       ├── recipesModals.js
│       └── recipesView.js
└── icons/
```

---

## 5. Script Load Order (Critical)

**Source of truth: `index.html` `<script>` loader array.**

Current order (must be maintained):

```
js/storage.js
js/models.js
js/utils.js
js/ui.js
js/audit.js
js/actions.js
js/baseIngredients.js
js/ingredients.js
js/recipes/recipesLogic.js
js/recipes/recipesModals.js
js/recipes/recipesView.js
js/shopping/openFoodFacts.js     (1)
js/shopping/receiptParsing.js    (2)
js/shopping/receiptData.js       (3)
js/shopping/shoppingCore.js      (4)
js/shopping/receiptScanning.js   (5)
js/shopping/receiptModals.js     (6)
js/shopping/shoppingScanner.js   (7)
js/shopping/shoppingView.js      (8)
js/shopping.js                   (stub)
js/dashboard.js
js/stats.js
js/inventory.js
js/settings.js
js/purchaselog.js
js/cookhistory.js
js/app.js
```

**Rules:**
- Each sub-module must only reference `window.*` symbols from modules loaded before it.
- `js/shopping.js` is a comment-only stub — never reintroduce logic there.
- Any new sub-module goes into its sub-folder and must be added to both `index.html` and `service-worker.js` `APP_SHELL`.

---

## 6. Versioning & Service Worker (Must Never Be Wrong)

### App version
- Source of truth: `js/appMeta.js`
- Every change set = version bump (even tiny fixes).
- **`buildId` format:** `YYYYMMDDHHmmss` (UTC or local, consistent)
- Version must be visible in UI (Header + Settings and/or Footer).

### Version bump checklist:
- [ ] `js/appMeta.js` — `version` + `buildId`
- [ ] `service-worker.js` — comment build stamp at line 1
- [ ] Confirm `APP_SHELL` in SW includes all new/changed files

### Service Worker / Cache
- Every release must bump `service-worker.js` buildId/cacheVersion.
- **Cache name** must include both `version` and `buildId` to prevent mixing.
  Format: `einkauf-rezepte-pwa-${version}-${buildId}`
- **On `install`:** pre-cache `APP_SHELL` and call `self.skipWaiting()`.
- **On `activate`:** delete all caches not matching current `CACHE_NAME`.
- **`APP_SHELL` must list every JS file** including all `js/shopping/*` sub-modules.
- `service-worker.js` itself **must stay in root** — `importScripts("./js/appMeta.js")` reads from root.

### Mandatory post-merge check (ask the user every time)
Ask: "Do you see version vX.Y.Z in the app (Header/Settings) after reload?"

If not visible — fallback checklist:
1. Hard reload (`Ctrl+Shift+R` / `Cmd+Shift+R`)
2. DevTools → Application → Storage → Clear site data
3. DevTools → Application → Service Workers → Unregister
4. Normal reload

---

## 7. Git Workflow (Hard Rule)

### Before starting ANY new task
1. Fetch and update `main`.
2. Check for any existing work branch from a previous task that is not merged:
   - If it should be completed: push it (if needed), open a PR to `main`, and merge it **only** if the current task explicitly allows merging.
   - If auth/token blocks automatic PR creation/merge: provide the exact PR creation link and **STOP**.
3. Only after the repo is clean (or a PR link is provided as instructed), create a NEW branch from updated `main`.

### Branch naming
Use: `<type>/<topic>-vX.Y.Z`
Examples:
```
fix/skip-loop-v0.6.8
refactor/shopping-extract-4-5-v0.6.10
feat/quick-confirm-v0.6.12
chore/update-playbook-v0.6.13
```

### Commit policy
- Make small, frequent commits (at least after each sub-step).
- Commit messages must be specific (what + where).
- Never mix unrelated changes in one commit.

### Commit message format
```
<type>(<scope>): <short description>

Optional body with bullet points if needed.
```
Types: `feat`, `fix`, `chore`, `refactor`, `docs`

### PR / Merge rule
- Always push the branch and open a PR to `main`.
- **STOP after opening the PR.** Do not merge.
- Merge only if the task prompt explicitly says **"merge now"**.
- If merge is blocked (token expired / no gh CLI), provide the exact PR link and STOP.

---

## 8. Required Final Report Format (AI must produce this at end of every task)

```
## Task Report

**Branch:** <branch-name>

**Commits:**
- <hash> — <message>
- <hash> — <message>

**Files changed:**
- path/to/file — what changed

**Version bumped:** vX.Y.Z (buildId: YYYYMMDDHHmmss)
- Visible in: Header / Settings footer

**SW cache bump:**
- New cache name: einkauf-rezepte-pwa-vX.Y.Z-YYYYMMDDHHmmss
- APP_SHELL updated: yes/no

**Smoke test checklist:**
- [ ] App loads without console errors
- [ ] Shopping list renders correctly
- [ ] Version vX.Y.Z visible in Header/Settings
- [ ] SW registered in DevTools > Application

**Reminder:** After deploy, please confirm:
"Do you see version vX.Y.Z in the app (Header/Settings) after reload?"
```

---

*Last updated: 2026-02-26 — v0.6.11 (added Modes & Permissions as §3)*
