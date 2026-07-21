# The Records Vault — Design Spec

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan
**Milestone:** 5 of 6 (chief-of-staff roadmap)

## Product Vision (context)

The chief-of-staff model: email is state, not a stream. The vault is the
records slice of that state — receipts, confirmations, statements, and
bookings extracted into a queryable archive so "where's that confirmation
number" is a question you ask, not a search you run.

Roadmap: 1. Heavy prune ✅ · 2. Noise triage ✅ · 3. The Brief ✅ ·
4. The Ledger ✅ · **5. Records vault (this spec)** · 6. The Desk.

Decisions locked during brainstorming (2026-07-21):

- **Lookup-first.** The daily driver is "find the document" (confirmation
  numbers, receipts, statement notices). Aggregate questions ("total spent
  on flights") are out of scope; amounts are stored as display strings,
  not normalized money.
- **Four record kinds**: purchases & receipts, travel & reservations,
  accounts & statements, appointments & official.
- **Read-path overlay, no inbox mutation.** Classification as a record
  changes nothing about where the message lives (usually the Feed). This
  preserves the milestone-2 no-auto-archive decision; the "never shown"
  part of the vision is satisfied by the Feed already hiding this mail
  from Focus.
- **Vault page = ask box + browsable list.** Natural-language ask backed
  by Claude, with a deterministic filterable record list as the fallback
  and receipt trail.
- **90-day floor, grow forward.** First run stamps `now − 90 days`; the
  vault indexes from the floor onward, forever. Older mail stays findable
  only via regular search.
- **Email body + attachment metadata only.** Attachment filenames are
  recorded so lookup can surface "the email with statement.pdf attached";
  no PDF content parsing in this milestone.
- **Bodies sent to Claude as-is.** Same trust posture as the Brief and
  Ledger. Reference numbers are precisely what extraction is for;
  redaction would gut the feature. (This closes the "sensitive-content
  redaction — revisit with Records" note from the Brief spec: decision is
  no redaction.)

## Goal

Ship the vault: automatic record extraction from feed-classified mail
since the floor, materialized into an FTS-indexed local table, surfaced
in a dedicated view (`g v`) with a natural-language ask box whose answers
cite only real records with validated links to source threads.
Provider-agnostic AI via `services/ai`, one migration, no inbox changes.

## Detection Semantics

### Candidate selection (deterministic, free)

Per account, threads with `last_message_at >= floor`, excluding
TRASH/SPAM/DRAFT, where the latest message is **feed-classified**
(List-Unsubscribe header or automated sender via
`triage/noiseClassifier`) **and** the subject matches a record cue list
(`services/records/candidates.ts`): receipt, invoice, order, payment,
statement, billing, renewal, confirmation, confirm, booking, reservation,
itinerary, ticket, boarding, appointment, registration, e-ticket,
shipped, delivery, tracking, policy. Human mail never goes to
extraction — a small-business invoice from a human sender is a known
miss, accepted for cost control and privacy conservatism.

**Amendment (2026-07-21, post-smoke-test):** the feed-only gate missed
138 of 201 real receipt threads on a live mailbox — transactional
senders like `auto-confirm@amazon.com` carry no List-Unsubscribe and no
automated local-part, so the noise classifier calls them signal. The
gate is now: record cue **and** (feed-classified **or** the latest
sender is someone the owner has never sent mail to). The
never-written-to test preserves the original intent — genuine human
correspondents stay excluded — while transactional mail the classifier
can't recognize qualifies.

### Extraction (one cached Claude call per candidate thread)

Thread-level, so Claude sees an order thread's confirmation + shipping +
delivery together and emits distinct records with full context. Input:
subject + truncated bodies via the Brief's `truncateThreadBodies` +
attachment filenames per message. Output (JSON, defensive parsing + one
retry, exactly like the Ledger):

```json
{
  "records": [
    {
      "kind": "purchase",
      "vendor": "Fully",
      "title": "Standing desk order",
      "recordDate": "2026-06-14",
      "amount": "$729.00",
      "referenceNumbers": [{ "label": "Order #", "value": "F-118272" }],
      "details": "Jarvis standing desk, walnut, delivered June 20.",
      "sourceMessageDate": 1749900000000
    }
  ]
}
```

- `records` may be empty — "matched cues but isn't actually a record" is
  a valid outcome and is **cached**, so duds are never re-paid for.
- `recordDate` is the event date (order/flight/statement date), not the
  email date. `sourceMessageDate` ties each record to the message it came
  from.
- Cache: `ai_cache` row `(accountId, threadId, "records_extract_v1")`
  storing `{stateKey, records, suppressed}` with the Brief's stateKey
  convention (`lastMessageAt:messageCount`). A thread is re-extracted
  only when it changes; on re-extraction the `suppressed` list (see
  Overturn below) is carried forward from the old cache row.

### Materialization

After a successful extraction (cache write), the thread's rows in the
`records` table are deleted and rewritten from the extraction, skipping
suppressed entries, and `records_fts` is updated in the same operation.
Unlike `messages_fts` there are no triggers — all writes go through one
service function (`services/records/records.ts`), which keeps the FTS
sync explicit and testable.

### Storage (migration 25)

- **`records`**: `id`, `account_id`, `thread_id`, `kind`
  (`purchase`|`travel`|`statement`|`appointment`), `vendor`, `title`,
  `record_date` (nullable epoch ms), `amount` (nullable display string),
  `reference_numbers` (JSON `[{label, value}]`), `details`,
  `attachment_names` (JSON `string[]`), `source_message_date`,
  `created_at`. Index on `(account_id, thread_id)` — rewrite unit — and
  `(account_id, record_date)` for the list.
- **`records_fts`**: plain FTS5 table (own content, not contentless —
  contentless tables restrict row deletes, which delete-and-rewrite
  needs) over `record_id`, `vendor`, `title`, `details`,
  `reference_text` (flattened labels + values), maintained by
  `records.ts` alongside the `records` rows. Record text is small;
  the duplication is negligible.
- **Floor**: per-account settings key `records_vault_floor:{accountId}`
  (epoch ms), stamped on the manager's first pass for that account,
  never moved.

### Overturn ("Not a record")

Row-level action on the vault list. Appends the record's fingerprint
(`kind` + `sourceMessageDate`) to the cache row's `suppressed` list and
deletes the row + FTS entry. Suppression survives re-extraction (carried
forward), so overturned records never resurrect. This is the vault's
one-keystroke overturn per the trust framework.

## Ask Flow (`services/records/ask.ts`)

Two-stage, mirroring the Brief's manifest-validated compose. Ephemeral —
answers are not cached; each ask costs two provider calls on demand.

1. **Query planning.** Question + today's date → Claude → JSON
   `{ftsQueries: string[], kinds?: string[], dateFrom?: "YYYY-MM-DD",
   dateTo?: "YYYY-MM-DD"}`. Validated defensively; each query string is
   sanitized into quoted FTS5 phrase/term syntax (no raw operator
   pass-through).
2. **Retrieval (deterministic).** Each query runs against `records_fts`
   joined with the structured filters; hits are unioned, ranked by FTS
   rank + recency, top 12 taken with all fields.
3. **Answer.** Claude gets the question + the 12 records (id, kind,
   vendor, title, date, amount, reference numbers, details, attachment
   names) and answers concisely citing record ids. The prompt instructs:
   if the records don't answer the question, say so — never invent.
   Citations are validated against the manifest of the 12 ids; an id
   outside the set renders as plain text, never a link (the Brief's
   link-token rule). Cited records render as source cards linking to
   their threads.
4. **Zero hits** → no stage-2 call; the UI states nothing matched and
   points at the browsable list.

## UX

### Vault view

- Route `/mail/vault` (MailLayout swap pattern like Brief/Home/Ledger),
  sidebar entry below Ledger (icon: lucide `Vault`), shortcut `g`
  then `v`, command-palette entry.
- **Ask box** at top: Enter asks, answer card + source cards render
  below it; Esc/clear returns to the list. Asking never blocks the list.
- **Record list**: newest-first by `record_date` (fallback
  `source_message_date`), filter chips All / Purchases / Travel /
  Statements / Appointments. Row: kind icon, vendor, title, record date,
  amount when present, reference numbers as click-to-copy chips,
  paperclip + filename when attachments exist. Click opens the source
  thread (BriefPage store-hydration pattern). Overflow action: "Not a
  record".
- Header shows the receipt trail: "214 records since Apr 22" (count +
  floor date).
- **States**: no AI provider → same setup pointer as the Brief (the
  vault is empty by construction without extraction). Backfill running →
  subtle "indexing…" line, never a blocking spinner. Empty with provider
  configured → "No records yet — they'll appear as receipts and
  confirmations arrive."

## Architecture

`services/records/`:

- `candidates.ts` — floor + feed-classification + cue-list filter over
  thread/message rows.
- `extractor.ts` — schema + validation + cached
  `extractThreadRecords` (mirrors Ledger extractor; reuses
  `truncateThreadBodies`, `parseModelJson`, `threadStateKey`;
  carries `suppressed` forward).
- `records.ts` — db service: atomic delete-and-rewrite per thread with
  FTS sync; list/filter/count queries; suppression delete.
- `ask.ts` — query planning, FTS sanitization, retrieval + ranking,
  answer request with citation manifest.
- `recordsManager.ts` — lifecycle clone of `ledgerManager`: started from
  App.tsx, debounced pass on `velo-sync-done`, serialized, dirty re-run;
  stamps the floor on first pass; processes candidates in batches of ~20
  per pass so the 90-day backfill spreads across sync cycles; emits
  `velo-records-updated`.

`components/vault/VaultPage.tsx` (+ small ask-answer and record-row
subcomponents). `db` access stays inside `services/records/records.ts`
(no separate `db/` file needed; the table has a single consumer).

Same global constraints as Brief/Ledger: no provider-specific APIs,
plain completions via `getActiveProvider()`, defensive JSON, opening the
view never waits on a model call (list reads are pure SQL; only the ask
box calls the provider, explicitly, on Enter).

## Error Handling

Extraction failure (provider error, twice-invalid JSON) → no cache
write, thread retried next pass; the manager logs and continues.
Provider absent → manager passes are no-ops; the page still renders the
materialized list. Ask stage-1 invalid JSON → one retry, then a visible
"couldn't understand that question" state. FTS query errors are caught
per-query; a failed query contributes zero hits rather than failing the
ask.

## Verification

- Unit (pure, mock provider): candidates (cue matching, floor cutoff,
  feed-only gating, trash/spam exclusion); extractor (validation,
  stateKey cache hit/miss, empty-`records` caching, suppression
  carry-forward, no-cache-on-failure); records db service
  (delete-and-rewrite atomicity, FTS stays in sync, suppression
  filtering, counts); ask (plan validation, FTS sanitization incl.
  operator injection, ranking, manifest citation filtering, zero-hit
  short-circuit).
- Component: VaultPage renders list from mocked queries; chips filter;
  ask flow renders answer + source cards; "Not a record" removes the
  row.
- Full suite green, `tsc --noEmit` clean.
- Manual smoke: real mailbox — backfill populates plausible records over
  a few sync cycles; a known confirmation number is findable via the ask
  box with a working source link; click-to-copy; overturn survives
  re-sync; `g v` navigation; Ollama smoke test.

## Out of Scope

- PDF/attachment content parsing (filenames only; revisit if statements
  prove opaque without it)
- Aggregate/analytical answers, currency normalization, spend categories
- Any inbox mutation (auto-archive, labels) driven by record status
- Cross-account unified vault (per active account, like Brief/Ledger)
- Brief integration (the Brief mentions obligations, not records; a
  "records filed this week" Brief line is Desk-era material)
- Backfill beyond the 90-day floor, or user-adjustable floor
- Caching/conversation memory for ask answers (each ask is fresh)
