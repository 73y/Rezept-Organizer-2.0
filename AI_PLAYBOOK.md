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

## 3. Folder Structure (Hard Rule)

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

## 4. Script Load Order (Critical)

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

## 5. Versioning Policy (Must Never Be Wrong)

- **Version lives in:** `js/appMeta.js` → `version` + `buildId`
- **Bump on every change set**, even small fixes.
- **`buildId` format:** `YYYYMMDDHHmmss` (UTC or local, consistent)
- **Version must be visible in UI** (Header + Settings footer).

### After every PR merge + deploy, the AI must ask:
> "Do you see version vX.Y.Z in the app (Header / Settings) after reload?"

### Version bump checklist:
- [ ] `js/appMeta.js` — `version` + `buildId`
- [ ] `service-worker.js` — comment build stamp at line 1
- [ ] Confirm `APP_SHELL` in SW includes all new/changed files

---

## 6. Service Worker / Cache Policy

- **Cache name** must include both `version` and `buildId` to prevent mixing.
  Format: `einkauf-rezepte-pwa-${version}-${buildId}`
- **On `install`:** pre-cache `APP_SHELL` and call `self.skipWaiting()`.
- **On `activate`:** delete all caches not matching current `CACHE_NAME`.
- **`APP_SHELL` must list every JS file** including all `js/shopping/*` sub-modules.
- `service-worker.js` itself **must stay in root** — `importScripts("./js/appMeta.js")` reads from root.

### "Version not updating" fallback checklist (for users):
1. Hard reload (`Ctrl+Shift+R` / `Cmd+Shift+R`)
2. DevTools → Application → Storage → Clear site data
3. DevTools → Application → Service Workers → Unregister
4. Normal reload

---

## 7. Default Git Workflow

```
Branch naming: <type>/<topic>-vX.Y.Z
  e.g.  feat/barcode-overlay-v0.6.12
        fix/sw-cache-miss-v0.6.13
        chore/update-playbook-v0.6.14
```

### Flow (always in this order):
1. `git checkout main && git pull origin main`
2. `git checkout -b <branch-name>`
3. Make changes → `git add <specific files>` → commit (small, clear messages)
4. `git push -u origin <branch-name>`
5. Open PR to `main`
6. **STOP — do not merge.** Report to user and wait.
7. Merge only when user says **"merge now"** or **"push now"**.

### Commit message format:
```
<type>(<scope>): <short description>

Optional body with bullet points if needed.
```
Types: `feat`, `fix`, `chore`, `refactor`, `docs`

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

*Last updated: 2026-02-26 — v0.6.11*
