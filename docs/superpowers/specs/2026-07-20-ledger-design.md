# The Ledger — Design Spec

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Milestone:** 4 of 6 (chief-of-staff roadmap)

## Product Vision (context)

The chief-of-staff model: email is state, not a stream. The Ledger is the
obligations slice of that state — the two lists everyone otherwise tracks
anxiously in their head:

- **Waiting on** — you sent something expecting an answer and silence has
  followed ("waiting on Alex Chen — 6 days")
- **You promised** — commitments you made in sent mail ("send the deck by
  Friday") that aren't fulfilled yet

Roadmap: 1. Heavy prune ✅ · 2. Noise triage ✅ · 3. The Brief ✅ ·
**4. The Ledger (this spec)** · 5. Records vault · 6. The Desk.

Decisions locked during brainstorming (2026-07-20):

- **Both directions in v1** (waiting-on and promises).
- **Brief section + own view**: the memo weaves in top obligations; a full
  Ledger view (sidebar entry, `g l`) shows both lists with actions.
- **Actions**: nudge (Claude-drafted follow-up opens in composer), dismiss
  (remembered), mark done, and absorption of the manual follow-up-reminders
  feature (a manual "remind me" becomes a pinned ledger entry with a due
  date).
- **30-day rolling window, sync-triggered**, one cached extraction per
  candidate thread (same cost model and provider abstraction as the Brief).
- **Architecture B**: sibling pipeline to the Brief — deterministic candidate
  filter → cached per-thread Claude extraction → entries **derived at read
  time** from candidates × extractions × live reply-state. Only user actions
  are stored (`ledger_overrides`). Derived state cannot drift from the
  mailbox.

## Goal

Ship the Ledger: automatic waiting-on and promise tracking derived from the
last 30 days of sent mail, surfaced in a dedicated view and woven into the
Brief, with nudge/dismiss/done actions and deterministic auto-resolution.
Provider-agnostic AI via `services/ai` (Claude default, Ollama must work),
storage in `ai_cache` plus one new table, no other migrations.

## Detection Semantics

### Candidate selection (deterministic, free)

From threads with activity in the last 30 days, per account:

- **Waiting-on candidates**: threads where the **latest message is from the
  account owner** (normalized email match), with at least one human
  counterparty — recipient's local part must not match the automated-sender
  patterns from `triage/noiseClassifier` (no-reply, notifications, etc.),
  and the thread must not be in TRASH or SPAM. Drafts excluded.
- **Promise candidates**: threads where the account owner **sent any message
  within the window** (not necessarily last — "thanks, waiting on that
  deck!" from the counterparty must not hide your promise), same
  counterparty/label exclusions.

Cap: 100 candidate threads per account per pass (newest first); log nothing —
if the cap binds, the oldest obligations age out first, consistent with the
30-day philosophy.

### Extraction (one cached Claude call per candidate)

One extraction covers both directions for a thread. Input: subject +
truncated bodies via the Brief's `truncateThreadBodies` (2,000/message,
8,000/thread, newest win) — reused, not duplicated. Output (JSON, defensive
parsing + one retry, exactly like the Brief):

```json
{
  "expectsReply": true,
  "why": "you asked Alex to confirm the venue",
  "counterparty": "Alex Chen",
  "promises": [{ "what": "send the revised deck", "due": "2026-07-25" }]
}
```

- `expectsReply` judges the owner's **latest** message: does it call for an
  answer? (FYI-only sends, "thanks!", sign-offs → false.)
- `promises` lists commitments the owner made **anywhere in the thread that
  remain unfulfilled as of the full thread state** — the model sees the
  whole conversation, so a promise already delivered in-thread is simply
  not listed on re-extraction.
- Cache: `ai_cache` row `(accountId, threadId, "ledger_extract_v1")` storing
  `{stateKey, extraction}` with the Brief's stateKey convention
  (`lastMessageAt:messageCount`). A thread is re-extracted only when it
  changes.

### Derivation (read time, deterministic)

- **Waiting-on entry** exists when: waiting-on candidate ∧ cached
  `expectsReply` ∧ **no counterparty message after the owner's last
  message** (the follow-up feature's reply-check SQL pattern) ∧ no
  `dismissed` override. Age = days since the owner's last message.
- **Promise entry** exists when: promise candidate ∧ cached `promises`
  non-empty ∧ no `done`/`dismissed` override for the thread. Age = days
  since the owner's message; `due` shown when present, overdue highlighted.
- **Pinned entry** (absorbed manual follow-ups): an override row of kind
  `pinned` with `due_at` forces a waiting-on entry for the thread regardless
  of extraction, auto-resolving on reply like any other. When `due_at`
  passes without resolution, fire the existing follow-up notification.
- Auto-resolution is never AI-dependent: replies resolve waiting-ons; a
  fresh extraction (triggered by any thread change) re-judges promises;
  overrides resolve anything manually.

### Overrides table (the only new storage)

Migration 20: `ledger_overrides (id, account_id, thread_id, kind
'waiting'|'promise', action 'dismissed'|'done'|'pinned', due_at nullable,
created_at)` — unique on `(account_id, thread_id, kind)`, upsert on
conflict (last action wins; `pinned` applies to kind `waiting` only).
v1 granularity is per-thread-per-kind: dismissing a promise entry dismisses
all promises in that thread (acceptable; revisit if multi-promise threads
prove common). `follow_up_reminders` joins the dormant-tables list; the
FollowUpDialog UI remains and now writes `pinned` overrides.

## UX

### Ledger view

- Route `/mail/ledger` (system label "ledger", same MailLayout swap pattern
  as Brief/Home), sidebar entry below Brief (icon: `ListChecks`), shortcut
  `g` then `l`, command-palette entry.
- Two sections: **Waiting on** and **You promised**, each row: counterparty
  (or promise text), thread subject, age ("6 days" / "due Friday" with
  overdue in warning color), sorted oldest-first (most-neglected on top).
- Rows click through to the thread (store-hydration pattern from BriefPage).
  Keyboard: `j`/`k` navigate, `Enter` opens, `n` nudge, `d` dismiss,
  `e` mark done. Row actions also visible on hover.
- Empty state: "Nobody owes you anything, and you owe nobody. Clean slate."
- Counts refresh on `velo-sync-done` and after any action.

### Nudge

`n` (or the row button) calls the active provider with a small prompt (the
thread's extraction summary + counterparty + age) to draft a 2-3 sentence
follow-up, then opens the composer as a **reply in that thread** with the
draft pre-filled. Nothing sends automatically. Provider failure → composer
opens with an empty body (never blocks the action).

### Brief integration

- The compose input gains an obligations block (deterministic lines, cap 5,
  oldest first):
  `Obligations (id :: fact):`
  `- id=T1 :: waiting on Alex Chen for 6 days (venue confirmation)`
  `- id=T2 :: you promised Sarah the revised deck, due 2026-07-25`
- Obligation thread IDs join the link-validation manifest so the memo can
  link them. The system prompt gains one line: obligations may be woven in
  where they matter; don't enumerate all of them (the Ledger view exists).
- The Brief's manifest hash covers the obligations block, so obligation
  changes regenerate the memo; unchanged obligations stay free.

## Architecture

`services/ledger/`:

- `candidates.ts` — pure candidate selection over `DbThread`/message rows
  (both kinds), window and cap logic.
- `extractor.ts` — schema + validation + cached `extractThreadObligations`
  (mirrors Brief extractor; reuses `truncateThreadBodies`, `parseModelJson`,
  `threadStateKey`).
- `ledger.ts` — derivation: `getLedger(accountId): { waitingOn: Entry[],
  promises: Entry[] }`; override reads/writes; resolution checks.
- `ledgerManager.ts` — sync-triggered pass (debounced, serialized, dirty
  re-run — the Brief manager's trigger pattern) that refreshes extractions
  for changed candidates and emits `velo-ledger-updated`; due-date
  notification check for pinned entries.
- `nudge.ts` — the follow-up draft prompt + composer handoff.

`components/ledger/LedgerPage.tsx` — the view. `db/ledgerOverrides.ts` — the
new table's queries. Brief touch-points: `composer.ts` gains an obligations
parameter to `buildComposeRequest`; `briefManager` fetches ledger lines and
includes their IDs in the manifest hash + valid-link set.

Same global constraints as the Brief: no provider-specific APIs, plain
completions, defensive JSON, `getActiveProvider()`, opening the view never
waits on a model call (cached extractions + derivation are instant; a pass
with no AI available simply shows deterministic pins and stale entries).

## Verification

- Unit (pure, mock provider): candidate selection (owner-last vs
  owner-in-window, automated-counterparty exclusion, cap, window edges);
  extraction cache stateKey behavior incl. no-cache-on-failure; derivation
  (reply resolves waiting-on, override precedence, pinned forcing, ages);
  obligations block builder + manifest-ID merging; nudge prompt builder.
- Component: LedgerPage renders both sections from mocked derivation;
  dismiss removes the row and writes the override; nudge opens composer.
- Full suite green, `tsc --noEmit` clean.
- Manual smoke: real mailbox pass — verify waiting-on list matches
  intuition, dismiss survives re-sync, nudge drafts open in composer, Brief
  mentions the oldest obligation with a working link, `g l` navigation,
  manual follow-up dialog creates a pinned entry, Ollama smoke test.

## Out of Scope

- Per-promise granularity within a thread (per-thread-per-kind in v1)
- Cross-account unified ledger (per active account, like the Brief)
- Auto-sending nudges, scheduled nudges, or SLA policies
- Counterparty-page / relationship view (later milestone material)
- Per-sender triage overrides (separate deferred feature; the
  `ledger_overrides` dismissal signal is deliberately shaped so a future
  feedback feature can consume it)
- Records/documents extraction (milestone 5)
