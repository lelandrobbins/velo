# Heavy Prune — Design Spec

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Milestone:** 1 of 4

## Product Vision (context)

This fork of Velo is being reshaped into a minimal, signal-first email client:

> Open it → an AI daily brief tells you what matters; below it, a clean list of
> real mail; noise (automated notifications, calendar invites/updates) was
> auto-archived into a Feed you can scan whenever; your curated labels are one
> keystroke away.

Roadmap (each milestone gets its own spec → plan → build cycle):

1. **Heavy prune** (this spec) — remove feature surface that doesn't serve the vision
2. **Noise triage engine** — deterministic + Claude classification, auto-archive, Feed view
3. **AI daily brief** — Claude-generated digest as the home screen header
4. **Label navigation UX** — keyboard-first topic switching and triage-into-label flows

The AI layer uses the existing Claude provider with a user-supplied Anthropic
API key. Noise, per the user: automated notifications, calendar invites and
invite updates (managed from the calendar itself, never from mail), and
general UI clutter.

## Goal

Delete all features that don't serve the vision, leaving a lean core to build
milestones 2–4 on. Delete means delete — no hidden settings toggles, no dead
code kept "just in case." Reversibility comes from git (one commit per
feature removed).

## What Is Removed

| Feature | Main surface (representative, not exhaustive) |
|---|---|
| Tasks | `components/tasks/`, `stores/taskStore`, `services/tasks/`, AI task extraction, `/tasks` route, `t` and `g k` shortcuts, TaskSidebar |
| Calendar page | `components/calendar/`, `services/google/calendar.ts`, `services/calendar/`, `/calendar` route, CalendarReauthBanner |
| Bundles | `services/bundles/`, bundle checker in App startup, bundle-rules settings UI |
| Quick steps | `services/quickSteps/`, QuickStepEditor settings UI |
| Split-inbox category tabs | CategoryTabs, `services/ai/categorizationManager`, `services/categorization/` rule engine, backfill service, `category` search param + `g p/u/o/c/n` shortcuts |
| Attachment library page | `components/attachments/` (the page), `/attachments` route, `g a` shortcut |
| Smart folders | `stores/smartFolderStore`, SmartFolderEditor, `services/db/smartFolders`, sidebar section |
| Help center | `components/help/`, `/help` routes, `constants/helpContent.ts`, HelpTooltip usages |
| AI features | Smart replies, AI compose panel, text transform, writing-style auto-drafts, smart labels (`services/smartLabels/`), Ask Inbox, task extraction |

Removal includes each feature's settings sections, keyboard shortcuts,
command-palette entries, help cards, sidebar entries, context-menu items, and
App.tsx startup/cleanup hooks.

## What Is Kept

- **Mail core:** Gmail + IMAP sync, threading, offline queue with optimistic
  actions, drafts
- **Organization:** labels + label editor, thread→label drag and drop, snooze,
  follow-up reminders, mute, pin
- **Finding things:** FTS5 search, search operators, command palette
- **Composer:** TipTap editor, signatures, templates, scheduled send, undo
  send, send-as aliases
- **Safety:** phishing detection, SPF/DKIM/DMARC display, image blocking,
  unsubscribe manager (it fights noise)
- **Platform:** notifications + VIP filtering, tray, badge, deep links, global
  shortcut, themes, font scaling, customizable shortcuts
- **AI plumbing (headless for now):** `services/ai/providerManager`,
  `providers/claudeProvider` (and sibling providers), `db/aiCache`, API-key
  settings UI. No feature uses them after this milestone; milestones 2–3 do.
  The other AI service modules (aiService feature functions, askInbox,
  writingStyleService, taskExtraction, categorizationManager) are removed.

## Mechanics

- **Code:** delete files and excise references (routes in
  `src/router/routeTree.tsx` lazy-load removed pages; shortcuts in
  `constants/shortcuts.ts`; startup checkers in App.tsx; settings nav).
- **Database:** tables and the version-tracked migration chain are untouched.
  Dead tables are harmless; editing past migrations would corrupt existing
  installs. The `services/db/` query modules for removed features are deleted
  along with their callers.
- **Rust backend:** untouched — no removed feature lives in `src-tauri/`.
- **Dependencies:** after code removal, prune package.json deps that became
  unused. Known keepers: `@dnd-kit` (thread→label drag), TipTap (composer).
- **Commits:** one commit per feature, conventional-commit style
  (`refactor!: remove tasks feature`), so any single removal is revertible.

## Verification

Per feature-removal commit:

1. `npx tsc --noEmit` — clean (strict mode with noUnused* will surface orphans)
2. `npm run test` — green (delete the removed feature's tests; fix any kept
   tests that referenced removed modules)
3. App boots to inbox and completes a sync

Final pass after all removals:

- Grep for references to removed modules/routes/shortcuts/events
- Check for now-unused exports and dependencies
- Manual smoke test: sync, open thread, compose + send, search, label
  operations, snooze, settings pages all function

## Out of Scope

- Any new features (Feed, brief, label nav) — milestones 2–4
- DB schema cleanup / dropping dead tables
- Visual redesign of remaining UI (the brief milestone will reshape the home
  screen)
- Landing page (`landing/`) and docs site content
