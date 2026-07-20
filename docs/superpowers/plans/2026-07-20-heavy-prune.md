# Heavy Prune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove nine feature areas (help center, tasks, calendar, bundles, quick steps, split-inbox categorization, attachment library page, smart folders, AI features) from the velo fork, leaving a lean mail core, per the approved spec at `docs/superpowers/specs/2026-07-20-heavy-prune-design.md`.

**Architecture:** Pure deletion milestone. Each task deletes one feature's files and excises its references from shared files (App.tsx, routeTree.tsx, shortcuts.ts, useKeyboardShortcuts.ts, Sidebar, EmailList, SettingsPage, CommandPalette, ContextMenuPortal, sync.ts, backgroundCheckers.ts). TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is the orphan detector: after deleting files, `npx tsc --noEmit` reports every dangling import and unused symbol — fix all of them, then run tests.

**Tech Stack:** TypeScript strict, Vitest, TanStack Router, Zustand, Tauri v2 (Rust side untouched).

## Global Constraints

- **DB is untouched:** never edit `src/services/db/migrations.ts` or any migration SQL. Dead tables stay. Delete only the query modules listed per task, and only when their callers are gone.
- **AI plumbing survives:** never delete `src/services/ai/providerManager.ts`, `src/services/ai/providerFactory.ts`, `src/services/ai/errors.ts`, `src/services/ai/types.ts`, `src/services/ai/providers/` (all providers incl. copilot/ollama), `src/services/db/aiCache.ts`, or the provider/API-key section of Settings.
- **Rust untouched:** no changes under `src-tauri/`.
- **One commit per task**, message format `refactor!: remove <feature>` — each independently revertible.
- **Removal checklist per feature** (apply in every task): component/service/store/db files, tests, route in `src/router/routeTree.tsx`, shortcuts in `src/constants/shortcuts.ts` + handler in `src/hooks/useKeyboardShortcuts.ts`, CommandPalette entries, Sidebar/EmailList/SettingsPage sections, ContextMenu items, App.tsx startup/cleanup, entries in `src/test/mocks/entities.mock.ts` and `src/test/mocks/index.ts`.
- **When excising from a shared file:** grep the file for the feature's symbols first (anchors given per task); remove imports, JSX, state, handlers, and settings sections for the feature only — do not reformat or "improve" surrounding code.
- **Verification per task** (steps repeated in each task): `npx tsc --noEmit` → no output; `npx vitest run` → all green (feature's own tests were deleted; fix kept tests that referenced removed modules by deleting only the removed-feature cases).

---

### Task 1: Remove help center

**Files:**
- Delete: `src/components/help/` (entire dir), `src/constants/helpContent.ts`, `src/constants/helpContent.test.ts`
- Modify: `src/router/routeTree.tsx` (HelpPage lazy import + `/help` routes), `src/components/composer/Composer.tsx` and `src/components/email/ThreadView.tsx` (HelpTooltip usages), plus any hits from the grep in Step 2

**Interfaces:**
- Consumes: nothing from other tasks (run first so later tasks never touch help cards)
- Produces: a codebase with no `@/components/help` or `@/constants/helpContent` imports; `/help` route gone

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/components/help src/constants/helpContent.ts src/constants/helpContent.test.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "components/help\|helpContent\|HelpTooltip\|HelpPage\|/help" src --include="*.ts*" | grep -v node_modules
```

- [ ] **Step 3: Excise references**

Known sites: `src/router/routeTree.tsx` (remove the `HelpPage` lazy import and the help route definitions, including them from the route tree assembly at the bottom), `src/components/composer/Composer.tsx` and `src/components/email/ThreadView.tsx` (remove `HelpTooltip` import and each `<HelpTooltip …>` element — keep the wrapped children if the tooltip wraps content). Also check `src/components/search/CommandPalette.tsx` and Settings for "Help" navigation entries and remove them. If a shortcut opens help (`?` opens ShortcutsHelp — that stays; only `/help`-page navigation goes).

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit` — Expected: no output. Fix every reported orphan (unused imports the removal created).

- [ ] **Step 5: Verify tests**

Run: `npx vitest run` — Expected: all pass. If a kept test referenced help content, delete just that test case.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove help center"
```

---

### Task 2: Remove tasks feature

**Files:**
- Delete: `src/components/tasks/` (TasksPage, TaskItem+test, TaskQuickAdd, TaskSidebar, AiTaskExtractDialog), `src/stores/taskStore.ts`, `src/stores/taskStore.test.ts`, `src/services/tasks/` (taskManager+test), `src/services/db/tasks.ts`, `src/services/db/tasks.test.ts`
- Modify: `src/router/routeTree.tsx` (TasksPage lazy import + `/tasks` route), `src/App.tsx`, `src/hooks/useKeyboardShortcuts.ts` + `src/constants/shortcuts.ts` (`t` create-task, `g k` go-to-tasks), `src/components/email/ThreadView.tsx` + `src/components/email/ActionBar.tsx` (AiTaskExtractDialog / create-task action), `src/components/layout/Sidebar.tsx` + `src/components/layout/MailLayout.tsx` (Tasks nav / TaskSidebar), `src/components/search/CommandPalette.tsx`, `src/test/mocks/entities.mock.ts` + `src/test/mocks/index.ts` (task mocks)
- Note: `src/services/ai/taskExtraction.ts` loses its last caller here but is deleted in Task 9 with the rest of the AI features.

**Interfaces:**
- Consumes: Task 1 complete (no help cards to update)
- Produces: no `taskStore`, `services/tasks`, `db/tasks`, or `components/tasks` imports anywhere; `t`/`g k` shortcuts gone from `SHORTCUTS` constant

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/components/tasks src/stores/taskStore.ts src/stores/taskStore.test.ts src/services/tasks src/services/db/tasks.ts src/services/db/tasks.test.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "taskStore\|components/tasks\|services/tasks\|db/tasks\|TaskSidebar\|TasksPage\|AiTaskExtractDialog\|task_tags" src --include="*.ts*"
```

- [ ] **Step 3: Excise references**

In `routeTree.tsx`: remove `TasksPage` lazy import and `/tasks` route. In `constants/shortcuts.ts`: remove the `t` (create task from email) and `g k` (go to tasks) definitions. In `useKeyboardShortcuts.ts`: remove their handlers and any `taskStore` usage; delete the matching cases in `useKeyboardShortcuts.test.ts`. In `ThreadView.tsx`/`ActionBar.tsx`: remove the create-task button/dialog wiring. In `Sidebar.tsx`: remove the Tasks nav item. In `MailLayout.tsx`: remove TaskSidebar if rendered there. In `CommandPalette.tsx`: remove task commands. In `test/mocks/`: remove task entity mocks and their exports.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output; fix orphans.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove tasks feature"
```

---

### Task 3: Remove calendar (page, providers, CalDav)

**Files:**
- Delete: `src/components/calendar/` (entire dir), `src/services/calendar/` (entire dir — googleCalendarProvider, caldavProvider, icalHelper, autoDiscovery, providerFactory, types, tests), `src/services/google/` (calendar.ts), `src/components/accounts/AddCalDavAccount.tsx`, `src/components/settings/CalDavSettings.tsx`, `src/services/db/calendarEvents.ts` + test, `src/services/db/calendars.ts` + test
- Modify: `src/router/routeTree.tsx` (CalendarPage lazy import + `/calendar` route), `src/components/layout/Sidebar.tsx` (Calendar nav), `src/components/accounts/AddAccount.tsx` or account-flow entry that offers CalDav, `src/components/settings/SettingsPage.tsx` (CalDav section), `src/App.tsx` (calendar init/reauth if present), `src/components/search/CommandPalette.tsx`, `src/test/mocks/` (calendar mocks)

**Interfaces:**
- Consumes: Tasks 1–2 complete
- Produces: no `components/calendar`, `services/calendar`, `services/google`, `db/calendars`, `db/calendarEvents`, or CalDav imports anywhere

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/components/calendar src/services/calendar src/services/google src/components/accounts/AddCalDavAccount.tsx src/components/settings/CalDavSettings.tsx src/services/db/calendarEvents.ts src/services/db/calendarEvents.test.ts src/services/db/calendars.ts src/services/db/calendars.test.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "calendar\|Calendar\|caldav\|CalDav" src --include="*.ts*" | grep -viE "calendar_invite|text/calendar" | grep -v node_modules
```

(Do not remove MIME/`text/calendar` handling in mail parsing if any exists — that is message rendering, not the calendar feature.)

- [ ] **Step 3: Excise references** — routeTree (CalendarPage import + route), Sidebar nav item, account-add flow's CalDav option, SettingsPage CalDav section, CommandPalette calendar commands, App.tsx calendar/reauth wiring, mocks.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove calendar feature"
```

---

### Task 4: Remove bundles

**Files:**
- Delete: `src/services/bundles/` (bundleManager.ts), `src/services/db/bundleRules.ts`, `src/services/db/bundleRules.test.ts`
- Modify: `src/App.tsx` (bundleManager import at ~line 39; `startBundleChecker`/`stopBundleChecker` calls around line 330 and unmount cleanup), `src/services/gmail/sync.ts` (bundle-hold block at ~lines 99–107: the `getBundleRule`/`holdThread`/`getNextDeliveryTime` dynamic import and its surrounding conditional), `src/services/gmail/sync.test.ts` (bundle cases), `src/components/layout/EmailList.tsx` (bundled-thread rendering), `src/components/settings/SettingsPage.tsx` (bundle rules section), `src/services/backgroundCheckers.ts` if bundle checker is registered there

**Interfaces:**
- Consumes: Tasks 1–3 complete
- Produces: sync pipeline with no bundle-hold step; no `services/bundles` or `db/bundleRules` imports

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/services/bundles src/services/db/bundleRules.ts src/services/db/bundleRules.test.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "bundle\|Bundle" src --include="*.ts*" | grep -v node_modules
```

- [ ] **Step 3: Excise references** — App.tsx checker start/stop + import; sync.ts hold-for-bundle block (delete the whole conditional, keep surrounding thread-upsert logic intact); sync.test.ts bundle cases; EmailList bundled-thread UI; SettingsPage bundle section; backgroundCheckers entry.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green (sync tests still cover normal thread flow).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove bundles"
```

---

### Task 5: Remove quick steps

**Files:**
- Delete: `src/services/quickSteps/` (executor+test, defaults, types), `src/services/db/quickSteps.ts` + test, `src/components/settings/QuickStepEditor.tsx`
- Modify: `src/components/settings/SettingsPage.tsx` (quick steps section + editor import), `src/components/ui/ContextMenuPortal.tsx` (quick-step menu items), `src/test/mocks/entities.mock.ts` + `src/test/mocks/index.ts` (quick step mocks), `src/hooks/useKeyboardShortcuts.ts` if quick-step shortcuts are dispatched there

**Interfaces:**
- Consumes: Tasks 1–4 complete
- Produces: no `services/quickSteps` or `db/quickSteps` imports; context menu without quick-step entries

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/services/quickSteps src/services/db/quickSteps.ts src/services/db/quickSteps.test.ts src/components/settings/QuickStepEditor.tsx
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "quickStep\|QuickStep\|quick_steps" src --include="*.ts*"
```

- [ ] **Step 3: Excise references** — SettingsPage section, ContextMenuPortal items, mocks, any shortcut dispatch.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove quick steps"
```

---

### Task 6: Remove split-inbox categorization

**Files:**
- Delete: `src/components/email/CategoryTabs.tsx` + `CategoryTabs.test.tsx`, `src/services/categorization/` (ruleEngine+test, backfillService+test), `src/services/ai/categorizationManager.ts`, `src/services/db/threadCategories.ts`
- Modify: `src/router/routeTree.tsx` (`VALID_CATEGORIES`, `category` search param in `validateMailSearch`), `src/App.tsx` (backfill block at ~lines 407–412), `src/services/gmail/sync.ts` (rule categorization block ~lines 71–98 and fire-and-forget AI categorization ~lines 426–429), `src/services/gmail/sync.test.ts`, `src/components/layout/EmailList.tsx` (CategoryTabs render + category filtering), `src/constants/shortcuts.ts` + `src/hooks/useKeyboardShortcuts.ts` (`g p/u/o/c/n` go-to-category), `src/components/search/CommandPalette.tsx` and `src/components/search/SearchBar.tsx` (category navigation), `src/stores/threadStore.ts` if it tracks category state, `src/test/mocks/`

**Interfaces:**
- Consumes: Tasks 1–5 complete
- Produces: mail list is a single stream (read-filter aside); `MailSearch` type has no `category`; sync has no categorization step. **Task 9 relies on `categorizationManager` already being gone.**

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/components/email/CategoryTabs.tsx src/components/email/CategoryTabs.test.tsx src/services/categorization src/services/ai/categorizationManager.ts src/services/db/threadCategories.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "categor\|Categor" src --include="*.ts*" | grep -v node_modules
```

- [ ] **Step 3: Excise references** — routeTree `VALID_CATEGORIES`/`category` param; App.tsx backfill; sync.ts both categorization blocks (keep the rest of thread upsert); EmailList tabs + filter; the five `g <x>` category shortcuts and handlers (keep `g i/s/t/d/a`-style non-category ones that survive — `g a` dies in Task 7, `g k` died in Task 2); CommandPalette/SearchBar category nav; threadStore category state; mocks; sync.test.ts category cases.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove split-inbox categorization"
```

---

### Task 7: Remove attachment library page

**Files:**
- Delete: `src/components/attachments/` (AttachmentLibrary+test, AttachmentGridItem, AttachmentListItem)
- Modify: `src/router/routeTree.tsx` (AttachmentLibrary lazy import + `/attachments` route), `src/constants/shortcuts.ts` + `src/hooks/useKeyboardShortcuts.ts` (`g a`), `src/components/layout/Sidebar.tsx` (Attachments nav), `src/components/search/CommandPalette.tsx`
- Keep: `src/services/attachments/` (cache + pre-cache), `src/components/email/AttachmentList.tsx`, `src/components/email/InlineAttachmentPreview.tsx`, `src/services/db/attachments.ts` — inline attachments still work.

**Interfaces:**
- Consumes: Tasks 1–6 complete
- Produces: no `components/attachments` imports; attachment services still consumed by `components/email/*`

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/components/attachments
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "components/attachments\|AttachmentLibrary\|AttachmentGridItem\|AttachmentListItem" src --include="*.ts*"
```

- [ ] **Step 3: Excise references** — routeTree import + route, `g a` shortcut + handler, Sidebar nav item, CommandPalette entry.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove attachment library page"
```

---

### Task 8: Remove smart folders

**Files:**
- Delete: `src/stores/smartFolderStore.ts` + test, `src/components/settings/SmartFolderEditor.tsx`, `src/services/db/smartFolders.ts` + test, `src/services/search/smartFolderQuery.ts` + test
- Modify: `src/components/layout/Sidebar.tsx` (smart folders section), `src/components/layout/EmailList.tsx` (smart-folder view mode), `src/components/search/SearchBar.tsx` ("save as smart folder"), `src/components/settings/SettingsPage.tsx` (section + editor import), `src/router/routeTree.tsx` (smart-folder route/search param if present), `src/test/mocks/`

**Interfaces:**
- Consumes: Tasks 1–7 complete
- Produces: sidebar shows only real labels + system folders; no `smartFolder*` symbols anywhere

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/stores/smartFolderStore.ts src/stores/smartFolderStore.test.ts src/components/settings/SmartFolderEditor.tsx src/services/db/smartFolders.ts src/services/db/smartFolders.test.ts src/services/search/smartFolderQuery.ts src/services/search/smartFolderQuery.test.ts
```

- [ ] **Step 2: Find every remaining reference**

```bash
grep -rn "smartFolder\|SmartFolder\|smart_folder\|__LAST_7_DAYS__\|__LAST_30_DAYS__\|__TODAY__" src --include="*.ts*"
```

- [ ] **Step 3: Excise references** — Sidebar section, EmailList view mode, SearchBar save action, SettingsPage section, routeTree param, mocks.

- [ ] **Step 4: Verify types** — `npx tsc --noEmit`, expect no output.

- [ ] **Step 5: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: remove smart folders"
```

---

### Task 9: Remove AI features (keep plumbing)

**Files:**
- Delete: `src/services/ai/aiService.ts` + test, `src/services/ai/askInbox.ts`, `src/services/ai/taskExtraction.ts` + test, `src/services/ai/writingStyleService.ts` + test, `src/services/ai/prompts.ts` (feature prompts — verify nothing kept imports it first), `src/services/smartLabels/` (entire dir), `src/services/db/smartLabelRules.ts` + test, `src/services/db/writingStyleProfiles.ts` + test, `src/components/search/AskInbox.tsx`, `src/components/email/SmartReplySuggestions.tsx`, `src/components/email/ThreadSummary.tsx`, `src/components/composer/AiAssistPanel.tsx`, `src/components/settings/SmartLabelEditor.tsx` + test
- Keep (Global Constraints): providerManager, providerFactory, providers/*, errors.ts, types.ts, db/aiCache.ts, API-key settings UI
- Modify: `src/components/email/ThreadView.tsx` (ThreadSummary, SmartReplySuggestions), `src/components/email/InlineReply.tsx` (smart replies / AI assist), `src/components/composer/Composer.tsx` (AiAssistPanel toggle), `src/components/search/CommandPalette.tsx` + `src/App.tsx` + `src/hooks/useKeyboardShortcuts.ts` (`velo-toggle-ask-inbox` event, Ask Inbox wiring), `src/services/gmail/sync.ts` (smartLabelManager block at ~line 413, writing-style hooks if any), `src/components/settings/SettingsPage.tsx` (smart labels section, writing-style section, per-feature AI toggles — keep provider/API-key config), `src/components/layout/Sidebar.tsx` (smart-label indicators if any), `src/test/mocks/`

**Interfaces:**
- Consumes: Task 6 already removed `categorizationManager` (the other `services/ai` feature module)
- Produces: `src/services/ai/` contains exactly providerManager, providerFactory, errors, types, providers/, and their tests; no component imports any AI feature

- [ ] **Step 1: Confirm prompts.ts is only used by deleted modules**

```bash
grep -rn "ai/prompts\|from \"./prompts\"\|from './prompts'" src --include="*.ts*"
```
Expected: hits only in files being deleted this task. If a kept file imports it, keep `prompts.ts` and strip it to what the kept file needs.

- [ ] **Step 2: Delete the files**

```bash
git rm -r src/services/ai/aiService.ts src/services/ai/aiService.test.ts src/services/ai/askInbox.ts src/services/ai/taskExtraction.ts src/services/ai/taskExtraction.test.ts src/services/ai/writingStyleService.ts src/services/ai/writingStyleService.test.ts src/services/ai/prompts.ts src/services/smartLabels src/services/db/smartLabelRules.ts src/services/db/smartLabelRules.test.ts src/services/db/writingStyleProfiles.ts src/services/db/writingStyleProfiles.test.ts src/components/search/AskInbox.tsx src/components/email/SmartReplySuggestions.tsx src/components/email/ThreadSummary.tsx src/components/composer/AiAssistPanel.tsx src/components/settings/SmartLabelEditor.tsx src/components/settings/SmartLabelEditor.test.tsx
```

- [ ] **Step 3: Find every remaining reference**

```bash
grep -rn "aiService\|askInbox\|AskInbox\|taskExtraction\|writingStyle\|smartLabel\|SmartLabel\|SmartReply\|ThreadSummary\|AiAssist\|velo-toggle-ask-inbox" src --include="*.ts*"
```

- [ ] **Step 4: Excise references** — ThreadView summary + smart replies; InlineReply AI affordances; Composer AiAssistPanel; CommandPalette/App/useKeyboardShortcuts Ask-Inbox event wiring; sync.ts smartLabelManager block; SettingsPage feature sections (provider/API-key section stays); mocks.

- [ ] **Step 5: Verify types** — `npx tsc --noEmit`, expect no output. Then confirm the plumbing survived:

```bash
ls src/services/ai src/services/ai/providers
```
Expected: `errors.ts`, `providerFactory.ts`(+test), `providerManager.ts`(+test), `types.ts`, `providers/` (claude, openai, gemini, copilot+test, ollama+test).

- [ ] **Step 6: Verify tests** — `npx vitest run`, expect green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor!: remove AI features, keep provider plumbing"
```

---

### Task 10: Final sweep — dead deps, orphan grep, smoke test

**Files:**
- Modify: `package.json` (+ lockfile via npm), possibly small orphan cleanups anywhere in `src/`

**Interfaces:**
- Consumes: Tasks 1–9 complete
- Produces: milestone done — lean build, verified app

- [ ] **Step 1: Orphan sweep**

```bash
grep -rn "components/tasks\|components/calendar\|components/help\|components/attachments\|services/bundles\|services/quickSteps\|services/smartLabels\|services/categorization\|smartFolder\|helpContent\|bundleRules\|threadCategories\|CategoryTabs" src --include="*.ts*"
```
Expected: no hits. Fix any stragglers.

- [ ] **Step 2: Find now-unused dependencies**

```bash
npx depcheck --ignores="@types/*,tailwindcss,@tailwindcss/*,vite,vitest,jsdom,@vitejs/*"
```
Review each reported unused dependency. Known keepers regardless of depcheck output: `@dnd-kit/*` (thread→label drag), TipTap packages (composer), Tauri plugins. Likely removable if reported: calendar/ical libs, any tasks-only or AI-feature-only libs. For each confirmed-unused dep:

```bash
npm uninstall <pkg>
```

- [ ] **Step 3: Full verification**

```bash
npx tsc --noEmit && npx vitest run && npx vite build
```
Expected: clean types, green tests, successful production build of both pages (index + splashscreen).

- [ ] **Step 4: Manual smoke test (with the user)**

Run `npm run tauri dev`. Verify: app boots to inbox; sync completes; open a thread; compose and send; search; apply/remove a label; snooze; open every remaining Settings section; `?` shows shortcuts help without removed keys; sidebar shows no dead nav items.

- [ ] **Step 5: Update docs to match reality**

Edit `CLAUDE.md`: remove the pruned features from the architecture notes, component groups, shortcuts table, and gotchas (keep DB table list as-is — tables still exist — but annotate removed features' tables as dormant). Edit `docs/keyboard-shortcuts.md` and `docs/architecture.md` similarly. Delete the `/document-feature` reference if the help center's workflow no longer applies.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: prune dead deps and update docs after feature removal"
```

---

## Post-plan notes

- If any task's grep turns up a reference in a file this plan didn't list, excise it there too — the greps are the source of truth, the file lists are the map.
- If a removal breaks a *kept* feature's test in a way that isn't just a dangling import (i.e., behavioral coupling), stop and surface it rather than rewriting the kept feature.
