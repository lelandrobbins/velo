# Records Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-extract receipts/confirmations/statements/appointments from feed-classified mail into an FTS-indexed local vault, browsable and queryable via a natural-language ask box at `/mail/vault` (`g` then `v`).

**Architecture:** Sibling pipeline to the Ledger: deterministic candidate filter → cached per-thread Claude extraction (`ai_cache`, type `records_extract_v1`) → materialized `records` table + `records_fts` FTS5 index (migration 25). The ask box is two-stage like the Brief: Claude plans FTS queries, deterministic retrieval fetches top 12, Claude answers citing only manifest-validated record ids.

**Tech Stack:** TypeScript strict, Vitest + jsdom + Testing Library, SQLite via Tauri SQL plugin, provider-agnostic AI via `services/ai` (`getActiveProvider()`), TanStack Router, Zustand, Tailwind v4, lucide-react.

**Spec:** `docs/superpowers/specs/2026-07-21-records-vault-design.md` — read it first.

## Global Constraints

- TypeScript strict mode: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` all on. Index access returns `T | undefined` — handle it.
- Path alias `@/*` → `src/*`. Vitest globals on (no imports needed for `describe`/`it`/`expect`, but existing tests import them anyway — match the file you're writing).
- No provider-specific AI APIs: only `AiProviderClient.complete(AiCompletionRequest)` via `getActiveProvider()` / `isAiAvailable()` from `@/services/ai/providerManager`.
- Opening the vault view must never wait on a model call. Only the ask box (on Enter) calls the provider.
- Human mail never goes to extraction: candidates must be feed-classified per `triage/noiseClassifier`.
- All model JSON is parsed defensively (`parseModelJson` + validator + one retry with "Return ONLY the JSON object.").
- Cache convention: `ai_cache` content embeds a `stateKey` (`` `${last_message_at}:${message_count}` `` via `threadStateKey`); mismatch = stale.
- Extraction failure → no cache write (thread retried next pass).
- Kind values everywhere: `"purchase" | "travel" | "statement" | "appointment"`.
- The 90-day floor is per-account settings key `records_vault_floor:{accountId}` (epoch ms as string), stamped once, never moved.
- Commit after every task with a conventional-commit message.
- Verify with `npx vitest run <file>` per task; `npm run test` + `npx tsc --noEmit` must be green at the end of every task.

---

### Task 1: Migration 25 — `records` + `records_fts`

**Files:**
- Modify: `src/services/db/migrations.ts` (append after the version-24 entry, ~line 794)

**Interfaces:**
- Produces: tables `records` and `records_fts` used by Task 3's SQL. Column names exactly as below.

- [ ] **Step 1: Append the migration**

In `src/services/db/migrations.ts`, after the closing `}` of the `version: 24` entry (before the final `];`), add:

```typescript
  {
    version: 25,
    description: "Records vault: records table + FTS5 index",
    sql: `
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('purchase', 'travel', 'statement', 'appointment')),
        vendor TEXT,
        title TEXT NOT NULL,
        record_date INTEGER,
        amount TEXT,
        reference_numbers TEXT NOT NULL DEFAULT '[]',
        details TEXT,
        attachment_names TEXT NOT NULL DEFAULT '[]',
        source_message_date INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_records_thread ON records(account_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_records_date ON records(account_id, record_date);

      -- Plain FTS5 (own content, NOT contentless: contentless tables restrict
      -- row deletes, which the delete-and-rewrite materialization needs).
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        record_id UNINDEXED,
        vendor,
        title,
        details,
        reference_text
      );
    `,
  },
```

- [ ] **Step 2: Verify suite + types stay green**

Run: `npm run test` → all pass. Run: `npx tsc --noEmit` → no output.

- [ ] **Step 3: Commit**

```bash
git add src/services/db/migrations.ts
git commit -m "feat(vault): migration 25 - records table and FTS5 index"
```

---

### Task 2: Candidate selection — `services/records/candidates.ts`

**Files:**
- Create: `src/services/records/candidates.ts`
- Test: `src/services/records/candidates.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `@/services/db/connection`; `classifyThread` from `@/services/triage/noiseClassifier`.
- Produces: `interface RecordCandidate { threadId: string; subject: string | null; lastMessageAt: number; messageCount: number }`; `getRecordCandidates(accountId: string, floor: number): Promise<RecordCandidate[]>`; `matchesRecordCues(subject: string | null): boolean`; `RECORD_SUBJECT_CUES: string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/services/records/candidates.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));

import { getRecordCandidates, matchesRecordCues } from "./candidates";

const FLOOR = 1_790_000_000_000;

function row(overrides: Record<string, unknown>) {
  return {
    thread_id: "t1",
    subject: "Your receipt from Fully",
    last_message_at: FLOOR + 1000,
    message_count: 1,
    from_address: "noreply@fully.com",
    list_unsubscribe: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("matchesRecordCues", () => {
  it("matches record cues case-insensitively", () => {
    expect(matchesRecordCues("Your RECEIPT from Fully")).toBe(true);
    expect(matchesRecordCues("Itinerary for your trip")).toBe(true);
    expect(matchesRecordCues("Appointment confirmed")).toBe(true);
  });

  it("rejects non-record subjects and null", () => {
    expect(matchesRecordCues("Weekly digest: new posts")).toBe(false);
    expect(matchesRecordCues(null)).toBe(false);
  });
});

describe("getRecordCandidates", () => {
  it("keeps feed-classified threads with record cues", async () => {
    mockSelect.mockResolvedValue([row({})]);
    const result = await getRecordCandidates("a1", FLOOR);
    expect(result).toEqual([
      { threadId: "t1", subject: "Your receipt from Fully", lastMessageAt: FLOOR + 1000, messageCount: 1 },
    ]);
  });

  it("drops signal-classified (human) threads even with cues", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t2", from_address: "alice@example.com" }),
    ]);
    expect(await getRecordCandidates("a1", FLOOR)).toEqual([]);
  });

  it("drops feed threads without record cues", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t3", subject: "New features this week", list_unsubscribe: "<mailto:u@x>" }),
    ]);
    expect(await getRecordCandidates("a1", FLOOR)).toEqual([]);
  });

  it("keeps List-Unsubscribe threads with cues from non-automated addresses", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t4", from_address: "hello@shop.com", list_unsubscribe: "<mailto:u@x>" }),
    ]);
    expect((await getRecordCandidates("a1", FLOOR)).map((c) => c.threadId)).toEqual(["t4"]);
  });

  it("passes floor and account into the query and excludes trash/spam/draft in SQL", async () => {
    mockSelect.mockResolvedValue([]);
    await getRecordCandidates("a1", FLOOR);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("last_message_at >= $2");
    expect(sql).toContain("'TRASH', 'SPAM', 'DRAFT'");
    expect(params).toEqual(["a1", FLOOR]);
  });

  it("defaults null last_message_at to 0", async () => {
    mockSelect.mockResolvedValue([row({ last_message_at: null })]);
    const result = await getRecordCandidates("a1", FLOOR);
    expect(result[0]!.lastMessageAt).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/records/candidates.test.ts`
Expected: FAIL — cannot resolve `./candidates`.

- [ ] **Step 3: Write the implementation**

Create `src/services/records/candidates.ts`:

```typescript
import { getDb } from "@/services/db/connection";
import { classifyThread } from "@/services/triage/noiseClassifier";

/** Subject substrings that mark automated mail as a potential record. */
export const RECORD_SUBJECT_CUES = [
  "receipt",
  "invoice",
  "order",
  "payment",
  "statement",
  "billing",
  "renewal",
  "confirmation",
  "confirm",
  "booking",
  "reservation",
  "itinerary",
  "ticket",
  "boarding",
  "appointment",
  "registration",
  "e-ticket",
  "shipped",
  "delivery",
  "tracking",
  "policy",
];

export interface RecordCandidate {
  threadId: string;
  subject: string | null;
  lastMessageAt: number;
  messageCount: number;
}

interface CandidateRow {
  thread_id: string;
  subject: string | null;
  last_message_at: number | null;
  message_count: number;
  from_address: string | null;
  list_unsubscribe: string | null;
}

export function matchesRecordCues(subject: string | null): boolean {
  if (!subject) return false;
  const s = subject.toLowerCase();
  return RECORD_SUBJECT_CUES.some((cue) => s.includes(cue));
}

/**
 * Feed-classified threads since the vault floor whose subject matches a
 * record cue. Human (signal) mail never reaches extraction — a known miss
 * for e.g. a human-sent invoice, accepted for cost and privacy conservatism.
 */
export async function getRecordCandidates(
  accountId: string,
  floor: number,
): Promise<RecordCandidate[]> {
  const db = await getDb();
  const rows = await db.select<CandidateRow[]>(
    `SELECT t.id AS thread_id, t.subject, t.last_message_at, t.message_count,
            t.from_address, t.list_unsubscribe
     FROM threads t
     WHERE t.account_id = $1
       AND t.last_message_at >= $2
       AND NOT EXISTS (SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = t.account_id AND tl.thread_id = t.id
           AND tl.label_id IN ('TRASH', 'SPAM', 'DRAFT'))
     ORDER BY t.last_message_at DESC`,
    [accountId, floor],
  );

  return rows
    .filter(
      (r) =>
        classifyThread({
          fromAddress: r.from_address,
          subject: r.subject,
          listUnsubscribe: r.list_unsubscribe,
        }) === "feed" && matchesRecordCues(r.subject),
    )
    .map((r) => ({
      threadId: r.thread_id,
      subject: r.subject,
      lastMessageAt: r.last_message_at ?? 0,
      messageCount: r.message_count,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/records/candidates.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/records/candidates.ts src/services/records/candidates.test.ts
git commit -m "feat(vault): deterministic record candidate selection"
```

---

### Task 3: Records db service — `services/records/records.ts`

**Files:**
- Create: `src/services/records/records.ts`
- Test: `src/services/records/records.test.ts`

**Interfaces:**
- Consumes: `getDb()`; tables from Task 1.
- Produces (Tasks 4/6/7 depend on these exact names):
  - `type RecordKind = "purchase" | "travel" | "statement" | "appointment"`, `const RECORD_KINDS: RecordKind[]`
  - `interface ReferenceNumber { label: string; value: string }`
  - `interface RecordFields { kind: RecordKind; vendor: string | null; title: string; recordDate: number | null; amount: string | null; referenceNumbers: ReferenceNumber[]; details: string | null; attachmentNames: string[]; sourceMessageDate: number }`
  - `interface DbRecord { id: string; account_id: string; thread_id: string; kind: RecordKind; vendor: string | null; title: string; record_date: number | null; amount: string | null; reference_numbers: string; details: string | null; attachment_names: string; source_message_date: number; created_at: number }`
  - `replaceThreadRecords(accountId: string, threadId: string, records: RecordFields[]): Promise<void>`
  - `deleteRecord(accountId: string, recordId: string): Promise<void>`
  - `listRecords(accountId: string, kinds?: RecordKind[]): Promise<DbRecord[]>`
  - `countRecords(accountId: string): Promise<number>`
  - `interface RecordSearchOpts { kinds?: RecordKind[] | null; dateFrom?: number | null; dateTo?: number | null; limit?: number }`
  - `searchRecords(accountId: string, ftsQuery: string, opts?: RecordSearchOpts): Promise<DbRecord[]>`

- [ ] **Step 1: Write the failing test**

Create `src/services/records/records.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect, execute: mockExecute })),
}));

import {
  replaceThreadRecords,
  deleteRecord,
  listRecords,
  countRecords,
  searchRecords,
  type RecordFields,
} from "./records";

const fields: RecordFields = {
  kind: "purchase",
  vendor: "Fully",
  title: "Standing desk order",
  recordDate: 1_780_000_000_000,
  amount: "$729.00",
  referenceNumbers: [{ label: "Order #", value: "F-118272" }],
  details: "Jarvis desk, walnut",
  attachmentNames: ["invoice.pdf"],
  sourceMessageDate: 1_780_000_100_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockResolvedValue([]);
  mockExecute.mockResolvedValue(undefined);
});

describe("replaceThreadRecords", () => {
  it("deletes old FTS rows and record rows before inserting", async () => {
    await replaceThreadRecords("a1", "t1", [fields]);
    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain("DELETE FROM records_fts");
    expect(sqls[1]).toContain("DELETE FROM records");
    expect(sqls[2]).toContain("INSERT INTO records");
    expect(sqls[3]).toContain("INSERT INTO records_fts");
  });

  it("serializes JSON fields and flattens reference text for FTS", async () => {
    await replaceThreadRecords("a1", "t1", [fields]);
    const insertParams = mockExecute.mock.calls[2]![1] as unknown[];
    expect(insertParams).toContain('[{"label":"Order #","value":"F-118272"}]');
    expect(insertParams).toContain('["invoice.pdf"]');
    const ftsParams = mockExecute.mock.calls[3]![1] as unknown[];
    expect(ftsParams).toContain("Order # F-118272");
  });

  it("with no records only clears", async () => {
    await replaceThreadRecords("a1", "t1", []);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});

describe("deleteRecord", () => {
  it("removes the FTS row and the record row", async () => {
    await deleteRecord("a1", "r1");
    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain("DELETE FROM records_fts WHERE record_id = $1");
    expect(sqls[1]).toContain("DELETE FROM records WHERE account_id = $1 AND id = $2");
  });
});

describe("listRecords", () => {
  it("orders by record date falling back to source date, newest first", async () => {
    await listRecords("a1");
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("COALESCE(record_date, source_message_date) DESC");
    expect(params).toEqual(["a1"]);
  });

  it("filters by kinds when given", async () => {
    await listRecords("a1", ["travel", "statement"]);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("kind IN ($2, $3)");
    expect(params).toEqual(["a1", "travel", "statement"]);
  });
});

describe("countRecords", () => {
  it("returns the count, defaulting to 0", async () => {
    mockSelect.mockResolvedValue([{ count: 3 }]);
    expect(await countRecords("a1")).toBe(3);
    mockSelect.mockResolvedValue([]);
    expect(await countRecords("a1")).toBe(0);
  });
});

describe("searchRecords", () => {
  it("joins FTS with records, matches, ranks, and caps", async () => {
    await searchRecords("a1", '"desk"');
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("records_fts MATCH $2");
    expect(sql).toContain("JOIN records r ON r.id = f.record_id");
    expect(sql).toContain("ORDER BY f.rank");
    expect(params).toEqual(["a1", '"desk"', 12]);
  });

  it("applies kind and date filters with correct param order", async () => {
    await searchRecords("a1", '"desk"', {
      kinds: ["purchase"],
      dateFrom: 100,
      dateTo: 200,
      limit: 5,
    });
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("r.kind IN ($3)");
    expect(sql).toContain(">= $4");
    expect(sql).toContain("<= $5");
    expect(params).toEqual(["a1", '"desk"', "purchase", 100, 200, 5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/records/records.test.ts`
Expected: FAIL — cannot resolve `./records`.

- [ ] **Step 3: Write the implementation**

Create `src/services/records/records.ts`:

```typescript
import { getDb } from "@/services/db/connection";

export type RecordKind = "purchase" | "travel" | "statement" | "appointment";
export const RECORD_KINDS: RecordKind[] = ["purchase", "travel", "statement", "appointment"];

export interface ReferenceNumber {
  label: string;
  value: string;
}

/** Camel-case shape used to write records (from extraction). */
export interface RecordFields {
  kind: RecordKind;
  vendor: string | null;
  title: string;
  recordDate: number | null;
  amount: string | null;
  referenceNumbers: ReferenceNumber[];
  details: string | null;
  attachmentNames: string[];
  sourceMessageDate: number;
}

/** Raw row shape as read from SQLite. */
export interface DbRecord {
  id: string;
  account_id: string;
  thread_id: string;
  kind: RecordKind;
  vendor: string | null;
  title: string;
  record_date: number | null;
  amount: string | null;
  reference_numbers: string;
  details: string | null;
  attachment_names: string;
  source_message_date: number;
  created_at: number;
}

/**
 * Replace a thread's records and keep records_fts in sync. All record
 * writes flow through here (single consumer), which is why records_fts
 * needs no triggers.
 */
export async function replaceThreadRecords(
  accountId: string,
  threadId: string,
  records: RecordFields[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM records_fts WHERE record_id IN
       (SELECT id FROM records WHERE account_id = $1 AND thread_id = $2)`,
    [accountId, threadId],
  );
  await db.execute(
    "DELETE FROM records WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  for (const r of records) {
    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO records (id, account_id, thread_id, kind, vendor, title,
         record_date, amount, reference_numbers, details, attachment_names,
         source_message_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        accountId,
        threadId,
        r.kind,
        r.vendor,
        r.title,
        r.recordDate,
        r.amount,
        JSON.stringify(r.referenceNumbers),
        r.details,
        JSON.stringify(r.attachmentNames),
        r.sourceMessageDate,
      ],
    );
    const referenceText = r.referenceNumbers.map((n) => `${n.label} ${n.value}`).join(" ");
    await db.execute(
      `INSERT INTO records_fts (record_id, vendor, title, details, reference_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, r.vendor ?? "", r.title, r.details ?? "", referenceText],
    );
  }
}

export async function deleteRecord(accountId: string, recordId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM records_fts WHERE record_id = $1", [recordId]);
  await db.execute("DELETE FROM records WHERE account_id = $1 AND id = $2", [
    accountId,
    recordId,
  ]);
}

export async function listRecords(
  accountId: string,
  kinds?: RecordKind[],
): Promise<DbRecord[]> {
  const db = await getDb();
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map((_, i) => `$${i + 2}`).join(", ");
    return db.select<DbRecord[]>(
      `SELECT * FROM records WHERE account_id = $1 AND kind IN (${placeholders})
       ORDER BY COALESCE(record_date, source_message_date) DESC`,
      [accountId, ...kinds],
    );
  }
  return db.select<DbRecord[]>(
    `SELECT * FROM records WHERE account_id = $1
     ORDER BY COALESCE(record_date, source_message_date) DESC`,
    [accountId],
  );
}

export async function countRecords(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM records WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.count ?? 0;
}

export interface RecordSearchOpts {
  kinds?: RecordKind[] | null;
  dateFrom?: number | null;
  dateTo?: number | null;
  limit?: number;
}

/** ftsQuery must already be sanitized (see ask.sanitizeFtsQuery). */
export async function searchRecords(
  accountId: string,
  ftsQuery: string,
  opts: RecordSearchOpts = {},
): Promise<DbRecord[]> {
  const db = await getDb();
  const params: unknown[] = [accountId, ftsQuery];
  let filters = "";
  if (opts.kinds && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map((k) => {
      params.push(k);
      return `$${params.length}`;
    });
    filters += ` AND r.kind IN (${placeholders.join(", ")})`;
  }
  if (opts.dateFrom != null) {
    params.push(opts.dateFrom);
    filters += ` AND COALESCE(r.record_date, r.source_message_date) >= $${params.length}`;
  }
  if (opts.dateTo != null) {
    params.push(opts.dateTo);
    filters += ` AND COALESCE(r.record_date, r.source_message_date) <= $${params.length}`;
  }
  params.push(opts.limit ?? 12);
  return db.select<DbRecord[]>(
    `SELECT r.* FROM records_fts f
     JOIN records r ON r.id = f.record_id
     WHERE records_fts MATCH $2 AND r.account_id = $1${filters}
     ORDER BY f.rank, COALESCE(r.record_date, r.source_message_date) DESC
     LIMIT $${params.length}`,
    params,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/records/records.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/records/records.ts src/services/records/records.test.ts
git commit -m "feat(vault): records db service with FTS-synced writes"
```

---

### Task 4: Extraction — `services/records/extractor.ts`

**Files:**
- Create: `src/services/records/extractor.ts`
- Test: `src/services/records/extractor.test.ts`

**Interfaces:**
- Consumes: `AiProviderClient`, `AiCompletionRequest` from `@/services/ai/types`; `getAiCache`/`setAiCache` from `@/services/db/aiCache`; `getMessagesForThread`, `DbMessage` from `@/services/db/messages`; `getAttachmentsForMessage` from `@/services/db/attachments`; `truncateThreadBodies` from `@/services/brief/extractor`; `parseModelJson` from `@/services/brief/briefSchema`; `threadStateKey` from `@/services/brief/briefWindow`; `RecordCandidate` (Task 2); `replaceThreadRecords`, `deleteRecord`, `RECORD_KINDS`, `DbRecord`, `RecordKind`, `ReferenceNumber` (Task 3).
- Produces (Tasks 5/7 depend on these exact names):
  - `const RECORDS_EXTRACT_TYPE = "records_extract_v1"`
  - `interface ExtractedRecord { kind: RecordKind; vendor: string | null; title: string; recordDate: string | null; amount: string | null; referenceNumbers: ReferenceNumber[]; details: string | null; sourceMessageDate: number }`
  - `interface RecordsCacheEntry { stateKey: string; records: ExtractedRecord[]; suppressed: string[] }`
  - `recordFingerprint(kind: string, sourceMessageDate: number): string`
  - `validateRecordsExtraction(value: unknown): ExtractedRecord[] | null`
  - `extractThreadRecords(provider: AiProviderClient, accountId: string, candidate: RecordCandidate): Promise<{ records: ExtractedRecord[]; suppressed: string[] } | null>` — extracts, caches, **and materializes** via `replaceThreadRecords`.
  - `suppressRecord(accountId: string, record: DbRecord): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/services/records/extractor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "@/services/db/messages";
import type { DbRecord } from "./records";

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
  setAiCache: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(),
}));
vi.mock("@/services/db/attachments", () => ({
  getAttachmentsForMessage: vi.fn(() => Promise.resolve([])),
}));
vi.mock("./records", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./records")>()),
  replaceThreadRecords: vi.fn(),
  deleteRecord: vi.fn(),
}));

import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { getAttachmentsForMessage } from "@/services/db/attachments";
import { replaceThreadRecords, deleteRecord } from "./records";
import {
  validateRecordsExtraction,
  extractThreadRecords,
  suppressRecord,
  recordFingerprint,
  RECORDS_EXTRACT_TYPE,
} from "./extractor";

const candidate = {
  threadId: "t1",
  subject: "Your receipt from Fully",
  lastMessageAt: 5000,
  messageCount: 1,
};

const goodRecord = {
  kind: "purchase",
  vendor: "Fully",
  title: "Standing desk order",
  recordDate: "2026-06-14",
  amount: "$729.00",
  referenceNumbers: [{ label: "Order #", value: "F-118272" }],
  details: "Jarvis desk",
  sourceMessageDate: 5000,
};
const goodJson = JSON.stringify({ records: [goodRecord] });

function msg(overrides: Partial<DbMessage>): DbMessage {
  return {
    id: "m1", account_id: "a1", thread_id: "t1",
    from_address: "noreply@fully.com", from_name: "Fully",
    to_addresses: "me@x.com", cc_addresses: null, bcc_addresses: null,
    reply_to: null, subject: "Your receipt from Fully", snippet: "s",
    date: 5000, is_read: 1, is_starred: 0, body_html: null,
    body_text: "Order F-118272 total $729.00", body_cached: 1, raw_size: null,
    internal_date: null, list_unsubscribe: null, list_unsubscribe_post: null,
    auth_results: null, message_id_header: null, references_header: null,
    in_reply_to_header: null, imap_uid: null, imap_folder: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAttachmentsForMessage).mockResolvedValue([]);
});

describe("recordFingerprint", () => {
  it("combines kind and source date", () => {
    expect(recordFingerprint("purchase", 5000)).toBe("purchase:5000");
  });
});

describe("validateRecordsExtraction", () => {
  it("accepts a valid records array and normalizes optionals", () => {
    const v = validateRecordsExtraction({
      records: [{ kind: "travel", title: "Flight to Denver", sourceMessageDate: 1 }],
    });
    expect(v).toEqual([
      {
        kind: "travel", vendor: null, title: "Flight to Denver", recordDate: null,
        amount: null, referenceNumbers: [], details: null, sourceMessageDate: 1,
      },
    ]);
  });

  it("accepts an empty records array", () => {
    expect(validateRecordsExtraction({ records: [] })).toEqual([]);
  });

  it("drops entries with bad kind, missing title, or missing source date", () => {
    const v = validateRecordsExtraction({
      records: [
        { kind: "junkfood", title: "x", sourceMessageDate: 1 },
        { kind: "purchase", sourceMessageDate: 1 },
        { kind: "purchase", title: "x" },
        goodRecord,
      ],
    });
    expect(v).toHaveLength(1);
    expect(v![0]!.title).toBe("Standing desk order");
  });

  it("rejects non-objects and missing records array", () => {
    expect(validateRecordsExtraction(null)).toBeNull();
    expect(validateRecordsExtraction({ notRecords: [] })).toBeNull();
  });
});

describe("extractThreadRecords", () => {
  it("returns cached records when the stateKey matches, without provider calls", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:1", records: [goodRecord], suppressed: [] }),
    );
    const provider = { complete: vi.fn() };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toHaveLength(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(vi.mocked(replaceThreadRecords)).not.toHaveBeenCalled();
  });

  it("extracts, caches, and materializes on a stale stateKey", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:0", records: [], suppressed: ["travel:1"] }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toHaveLength(1);
    // suppressed list carried forward into the new cache row
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.stateKey).toBe("5000:1");
    expect(cached.suppressed).toEqual(["travel:1"]);
    // materialized with parsed recordDate epoch
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written).toHaveLength(1);
    expect(written[0]!.recordDate).toBe(Date.parse("2026-06-14"));
  });

  it("skips materializing suppressed fingerprints", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:0", records: [], suppressed: ["purchase:5000"] }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    await extractThreadRecords(provider, "a1", candidate);
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written).toEqual([]);
  });

  it("coerces a hallucinated sourceMessageDate to lastMessageAt", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const bad = JSON.stringify({ records: [{ ...goodRecord, sourceMessageDate: 999999 }] });
    const provider = { complete: vi.fn(() => Promise.resolve(bad)) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records[0]!.sourceMessageDate).toBe(5000);
  });

  it("retries once on invalid JSON and gives up without caching", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve("not json")) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setAiCache)).not.toHaveBeenCalled();
    expect(vi.mocked(replaceThreadRecords)).not.toHaveBeenCalled();
  });

  it("caches an empty extraction so duds are never re-paid for", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve('{"records": []}')) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toEqual([]);
    expect(vi.mocked(setAiCache)).toHaveBeenCalledWith(
      "a1", "t1", RECORDS_EXTRACT_TYPE, expect.stringContaining('"records":[]'),
    );
  });

  it("includes attachment filenames in the extraction request", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    vi.mocked(getAttachmentsForMessage).mockResolvedValue([
      { id: "at1", message_id: "m1", account_id: "a1", filename: "invoice.pdf",
        mime_type: "application/pdf", size: 100, gmail_attachment_id: null,
        content_id: null, is_inline: 0, local_path: null },
    ]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    await extractThreadRecords(provider, "a1", candidate);
    const req = provider.complete.mock.calls[0]![0] as { userContent: string };
    expect(req.userContent).toContain("invoice.pdf");
    // and materialized rows carry the source message's attachment names
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written[0]!.attachmentNames).toEqual(["invoice.pdf"]);
  });
});

describe("suppressRecord", () => {
  const row: DbRecord = {
    id: "r1", account_id: "a1", thread_id: "t1", kind: "purchase",
    vendor: "Fully", title: "Standing desk order", record_date: null,
    amount: null, reference_numbers: "[]", details: null,
    attachment_names: "[]", source_message_date: 5000, created_at: 1,
  };

  it("appends the fingerprint to the cache row and deletes the record", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:1", records: [goodRecord], suppressed: [] }),
    );
    await suppressRecord("a1", row);
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.suppressed).toEqual(["purchase:5000"]);
    expect(cached.stateKey).toBe("5000:1");
    expect(vi.mocked(deleteRecord)).toHaveBeenCalledWith("a1", "r1");
  });

  it("records suppression even when no cache row exists", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    await suppressRecord("a1", row);
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.suppressed).toEqual(["purchase:5000"]);
    expect(vi.mocked(deleteRecord)).toHaveBeenCalledWith("a1", "r1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/records/extractor.test.ts`
Expected: FAIL — cannot resolve `./extractor`.

- [ ] **Step 3: Write the implementation**

Create `src/services/records/extractor.ts`:

```typescript
import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { getAttachmentsForMessage } from "@/services/db/attachments";
import { truncateThreadBodies } from "@/services/brief/extractor";
import { parseModelJson } from "@/services/brief/briefSchema";
import { threadStateKey } from "@/services/brief/briefWindow";
import type { RecordCandidate } from "./candidates";
import {
  replaceThreadRecords,
  deleteRecord,
  RECORD_KINDS,
  type DbRecord,
  type RecordKind,
  type ReferenceNumber,
} from "./records";

export const RECORDS_EXTRACT_TYPE = "records_extract_v1";

export interface ExtractedRecord {
  kind: RecordKind;
  vendor: string | null;
  title: string;
  /** Event date as YYYY-MM-DD (order/flight/statement date), not the email date. */
  recordDate: string | null;
  amount: string | null;
  referenceNumbers: ReferenceNumber[];
  details: string | null;
  sourceMessageDate: number;
}

export interface RecordsCacheEntry {
  stateKey: string;
  records: ExtractedRecord[];
  /** Fingerprints overturned via "Not a record" — carried across re-extractions. */
  suppressed: string[];
}

export function recordFingerprint(kind: string, sourceMessageDate: number): string {
  return `${kind}:${sourceMessageDate}`;
}

export function validateRecordsExtraction(value: unknown): ExtractedRecord[] | null {
  if (typeof value !== "object" || value === null) return null;
  const arr = (value as Record<string, unknown>)["records"];
  if (!Array.isArray(arr)) return null;

  const out: ExtractedRecord[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (typeof kind !== "string" || !(RECORD_KINDS as string[]).includes(kind)) continue;
    const title = o["title"];
    if (typeof title !== "string" || title.length === 0) continue;
    const sourceMessageDate = o["sourceMessageDate"];
    if (typeof sourceMessageDate !== "number") continue;

    const referenceNumbers: ReferenceNumber[] = [];
    if (Array.isArray(o["referenceNumbers"])) {
      for (const ref of o["referenceNumbers"]) {
        if (
          typeof ref === "object" &&
          ref !== null &&
          typeof (ref as Record<string, unknown>)["label"] === "string" &&
          typeof (ref as Record<string, unknown>)["value"] === "string"
        ) {
          referenceNumbers.push({
            label: (ref as { label: string }).label,
            value: (ref as { value: string }).value,
          });
        }
      }
    }

    out.push({
      kind: kind as RecordKind,
      vendor: typeof o["vendor"] === "string" ? o["vendor"] : null,
      title,
      recordDate: typeof o["recordDate"] === "string" ? o["recordDate"] : null,
      amount: typeof o["amount"] === "string" ? o["amount"] : null,
      referenceNumbers,
      details: typeof o["details"] === "string" ? o["details"] : null,
      sourceMessageDate,
    });
  }
  return out;
}

export function buildRecordsRequest(
  subject: string | null,
  parts: { from: string; date: number; body: string }[],
  attachmentNamesByDate: Map<number, string[]>,
): AiCompletionRequest {
  const conversation = parts
    .map((p) => {
      const atts = attachmentNamesByDate.get(p.date);
      const attLine = atts && atts.length > 0 ? `\nAttachments: ${atts.join(", ")}` : "";
      return `[msg ${p.date}] From: ${p.from}${attLine}\n${p.body}`;
    })
    .join("\n---\n");
  return {
    systemPrompt: [
      "You extract records from automated email for a personal archive.",
      "A record is a receipt, order/shipping notice, invoice, travel or event",
      "reservation, bank/bill/insurance statement notice, or appointment/",
      "registration confirmation. Marketing and promotional mail yields NO records.",
      'Return ONLY a JSON object: {"records": [{',
      '"kind": "purchase" | "travel" | "statement" | "appointment",',
      '"vendor": "company or sender name, else null",',
      '"title": "short description, e.g. Standing desk order",',
      '"recordDate": "the event date YYYY-MM-DD (order/flight/statement date), else null",',
      '"amount": "display amount with currency symbol, e.g. $729.00, else null",',
      '"referenceNumbers": [{"label": "Order #", "value": "F-118272"}],',
      '"details": "1 short sentence of specifics, else null",',
      '"sourceMessageDate": the [msg N] number of the message the record came from}]}',
      "Distinct real-world items get distinct records; an order and its shipping",
      'notice are ONE record (keep the richest details). Return {"records": []}',
      "when nothing qualifies. Never invent facts. No prose outside the JSON.",
    ].join("\n"),
    userContent: `Subject: ${subject ?? "(no subject)"}\n\n${conversation}`,
    maxTokens: 800,
  };
}

function parseRecordDate(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Cached, materializing extraction. On a fresh stateKey returns the cache.
 * On a stale one: one provider call (plus one retry), cache write carrying
 * the suppressed list forward, then delete-and-rewrite of the thread's rows
 * in the records table (skipping suppressed fingerprints).
 */
export async function extractThreadRecords(
  provider: AiProviderClient,
  accountId: string,
  candidate: RecordCandidate,
): Promise<{ records: ExtractedRecord[]; suppressed: string[] } | null> {
  const stateKey = threadStateKey({
    last_message_at: candidate.lastMessageAt,
    message_count: candidate.messageCount,
  });

  let priorSuppressed: string[] = [];
  const cachedRaw = await getAiCache(accountId, candidate.threadId, RECORDS_EXTRACT_TYPE);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as RecordsCacheEntry;
      if (Array.isArray(cached.suppressed)) {
        priorSuppressed = cached.suppressed.filter((s): s is string => typeof s === "string");
      }
      if (cached.stateKey === stateKey) {
        const valid = validateRecordsExtraction({ records: cached.records });
        if (valid) return { records: valid, suppressed: priorSuppressed };
      }
    } catch {
      // fall through to re-extract
    }
  }

  const messages = await getMessagesForThread(accountId, candidate.threadId);
  const parts = truncateThreadBodies(messages);
  const attachmentNamesByDate = new Map<number, string[]>();
  for (const m of messages) {
    const atts = await getAttachmentsForMessage(accountId, m.id);
    const names = atts
      .filter((a) => a.is_inline === 0 && a.filename)
      .map((a) => a.filename!);
    if (names.length > 0) {
      attachmentNamesByDate.set(m.date, [
        ...(attachmentNamesByDate.get(m.date) ?? []),
        ...names,
      ]);
    }
  }
  const request = buildRecordsRequest(candidate.subject, parts, attachmentNamesByDate);

  let records = validateRecordsExtraction(parseModelJson(await provider.complete(request)));
  if (!records) {
    // One retry with an explicit nudge — local models are sloppier than Claude
    records = validateRecordsExtraction(
      parseModelJson(
        await provider.complete({
          ...request,
          userContent: `${request.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!records) return null;

  // Pin hallucinated source dates to a real message so fingerprints stay stable
  const validDates = new Set(parts.map((p) => p.date));
  for (const r of records) {
    if (!validDates.has(r.sourceMessageDate)) r.sourceMessageDate = candidate.lastMessageAt;
  }

  await setAiCache(
    accountId,
    candidate.threadId,
    RECORDS_EXTRACT_TYPE,
    JSON.stringify({ stateKey, records, suppressed: priorSuppressed } satisfies RecordsCacheEntry),
  );

  const kept = records.filter(
    (r) => !priorSuppressed.includes(recordFingerprint(r.kind, r.sourceMessageDate)),
  );
  await replaceThreadRecords(
    accountId,
    candidate.threadId,
    kept.map((r) => ({
      kind: r.kind,
      vendor: r.vendor,
      title: r.title,
      recordDate: parseRecordDate(r.recordDate),
      amount: r.amount,
      referenceNumbers: r.referenceNumbers,
      details: r.details,
      attachmentNames: attachmentNamesByDate.get(r.sourceMessageDate) ?? [],
      sourceMessageDate: r.sourceMessageDate,
    })),
  );

  return { records, suppressed: priorSuppressed };
}

/**
 * "Not a record": append the fingerprint to the cache row's suppressed list
 * (so re-extraction never resurrects it) and delete the materialized row.
 */
export async function suppressRecord(accountId: string, record: DbRecord): Promise<void> {
  const fingerprint = recordFingerprint(record.kind, record.source_message_date);
  const raw = await getAiCache(accountId, record.thread_id, RECORDS_EXTRACT_TYPE);
  let entry: RecordsCacheEntry = { stateKey: "", records: [], suppressed: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RecordsCacheEntry;
      entry = {
        stateKey: typeof parsed.stateKey === "string" ? parsed.stateKey : "",
        records: Array.isArray(parsed.records) ? parsed.records : [],
        suppressed: Array.isArray(parsed.suppressed) ? parsed.suppressed : [],
      };
    } catch {
      // unparseable cache — still record the suppression in a fresh entry
    }
  }
  if (!entry.suppressed.includes(fingerprint)) entry.suppressed.push(fingerprint);
  await setAiCache(accountId, record.thread_id, RECORDS_EXTRACT_TYPE, JSON.stringify(entry));
  await deleteRecord(accountId, record.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/records/extractor.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/records/extractor.ts src/services/records/extractor.test.ts
git commit -m "feat(vault): cached record extraction with suppression carry-forward"
```

---

### Task 5: Manager — `services/records/recordsManager.ts`

**Files:**
- Create: `src/services/records/recordsManager.ts`
- Test: `src/services/records/recordsManager.test.ts`

**Interfaces:**
- Consumes: `getSetting`/`setSetting` from `@/services/db/settings`; `getAiCache` from `@/services/db/aiCache`; `getActiveProvider`/`isAiAvailable` from `@/services/ai/providerManager`; `threadStateKey` from `@/services/brief/briefWindow`; `getRecordCandidates` (Task 2); `extractThreadRecords`, `RECORDS_EXTRACT_TYPE` (Task 4).
- Produces (Task 7 depends on these exact names):
  - `const RECORDS_BATCH_SIZE = 20`
  - `getVaultFloor(accountId: string): Promise<number | null>`
  - `ensureVaultFloor(accountId: string, now: number): Promise<number>`
  - `refreshRecordExtractions(accountId: string): Promise<number>`
  - `startRecordsManager(getAccountId: () => string | null): void`
  - `stopRecordsManager(): void`
  - Emits window event `"velo-records-updated"` after each pass.

- [ ] **Step 1: Write the failing test**

Create `src/services/records/recordsManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("@/services/db/aiCache", () => ({ getAiCache: vi.fn() }));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(() => Promise.resolve(true)),
  getActiveProvider: vi.fn(() => Promise.resolve({ complete: vi.fn() })),
}));
vi.mock("./candidates", () => ({ getRecordCandidates: vi.fn() }));
vi.mock("./extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extractor")>()),
  extractThreadRecords: vi.fn(() => Promise.resolve({ records: [], suppressed: [] })),
}));

import { getSetting, setSetting } from "@/services/db/settings";
import { getAiCache } from "@/services/db/aiCache";
import { isAiAvailable } from "@/services/ai/providerManager";
import { getRecordCandidates } from "./candidates";
import { extractThreadRecords } from "./extractor";
import {
  ensureVaultFloor,
  getVaultFloor,
  refreshRecordExtractions,
  RECORDS_BATCH_SIZE,
} from "./recordsManager";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

function candidate(i: number) {
  return { threadId: `t${i}`, subject: "Receipt", lastMessageAt: NOW - i, messageCount: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAiAvailable).mockResolvedValue(true);
  vi.mocked(getSetting).mockResolvedValue(String(NOW - 90 * DAY));
  vi.mocked(getAiCache).mockResolvedValue(null);
  vi.mocked(getRecordCandidates).mockResolvedValue([]);
  vi.mocked(extractThreadRecords).mockResolvedValue({ records: [], suppressed: [] });
});

describe("vault floor", () => {
  it("reads an existing floor", async () => {
    expect(await getVaultFloor("a1")).toBe(NOW - 90 * DAY);
    expect(vi.mocked(getSetting)).toHaveBeenCalledWith("records_vault_floor:a1");
  });

  it("returns null for missing or malformed floors", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await getVaultFloor("a1")).toBeNull();
    vi.mocked(getSetting).mockResolvedValue("not-a-number");
    expect(await getVaultFloor("a1")).toBeNull();
  });

  it("stamps now - 90 days exactly once", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    const floor = await ensureVaultFloor("a1", NOW);
    expect(floor).toBe(NOW - 90 * DAY);
    expect(vi.mocked(setSetting)).toHaveBeenCalledWith(
      "records_vault_floor:a1",
      String(NOW - 90 * DAY),
    );
  });

  it("never moves an existing floor", async () => {
    const floor = await ensureVaultFloor("a1", NOW + 5 * DAY);
    expect(floor).toBe(NOW - 90 * DAY);
    expect(vi.mocked(setSetting)).not.toHaveBeenCalled();
  });
});

describe("refreshRecordExtractions", () => {
  it("does nothing without AI", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    expect(await refreshRecordExtractions("a1")).toBe(0);
    expect(vi.mocked(getRecordCandidates)).not.toHaveBeenCalled();
  });

  it("extracts only stale candidates", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue([candidate(1), candidate(2)]);
    // t1 fresh, t2 stale
    vi.mocked(getAiCache).mockImplementation((_a, threadId) =>
      Promise.resolve(
        threadId === "t1"
          ? JSON.stringify({ stateKey: `${NOW - 1}:1`, records: [], suppressed: [] })
          : null,
      ),
    );
    expect(await refreshRecordExtractions("a1")).toBe(1);
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledTimes(1);
  });

  it("caps a pass at RECORDS_BATCH_SIZE stale threads", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue(
      Array.from({ length: RECORDS_BATCH_SIZE + 15 }, (_, i) => candidate(i)),
    );
    await refreshRecordExtractions("a1");
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledTimes(RECORDS_BATCH_SIZE);
  });

  it("counts only successful extractions", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue([candidate(1), candidate(2)]);
    vi.mocked(extractThreadRecords)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ records: [], suppressed: [] });
    expect(await refreshRecordExtractions("a1")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/records/recordsManager.test.ts`
Expected: FAIL — cannot resolve `./recordsManager`.

- [ ] **Step 3: Write the implementation**

Create `src/services/records/recordsManager.ts`:

```typescript
import { getSetting, setSetting } from "@/services/db/settings";
import { getAiCache } from "@/services/db/aiCache";
import { getActiveProvider, isAiAvailable } from "@/services/ai/providerManager";
import { threadStateKey } from "@/services/brief/briefWindow";
import { getRecordCandidates } from "./candidates";
import { extractThreadRecords, RECORDS_EXTRACT_TYPE } from "./extractor";

const SYNC_DEBOUNCE_MS = 2000;
const FLOOR_DAYS = 90;

/** Per pass, so the 90-day backfill spreads across sync cycles. */
export const RECORDS_BATCH_SIZE = 20;

function floorKey(accountId: string): string {
  return `records_vault_floor:${accountId}`;
}

export async function getVaultFloor(accountId: string): Promise<number | null> {
  const raw = await getSetting(floorKey(accountId));
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stamp now − 90 days on first call for the account; never move it after. */
export async function ensureVaultFloor(accountId: string, now: number): Promise<number> {
  const existing = await getVaultFloor(accountId);
  if (existing !== null) return existing;
  const floor = now - FLOOR_DAYS * 24 * 3_600_000;
  await setSetting(floorKey(accountId), String(floor));
  return floor;
}

/** Extract records for up to RECORDS_BATCH_SIZE stale candidates. */
export async function refreshRecordExtractions(accountId: string): Promise<number> {
  if (!(await isAiAvailable())) return 0;

  const floor = await ensureVaultFloor(accountId, Date.now());
  const candidates = await getRecordCandidates(accountId, floor);

  const stale = [];
  for (const c of candidates) {
    if (stale.length >= RECORDS_BATCH_SIZE) break;
    const raw = await getAiCache(accountId, c.threadId, RECORDS_EXTRACT_TYPE);
    const expected = threadStateKey({
      last_message_at: c.lastMessageAt,
      message_count: c.messageCount,
    });
    let fresh = false;
    if (raw) {
      try {
        fresh = (JSON.parse(raw) as { stateKey: string }).stateKey === expected;
      } catch {
        fresh = false;
      }
    }
    if (!fresh) stale.push(c);
  }
  if (stale.length === 0) return 0;

  const provider = await getActiveProvider();
  let refreshed = 0;
  for (const c of stale) {
    const result = await extractThreadRecords(provider, accountId, c);
    if (result) refreshed++;
  }
  return refreshed;
}

// ---------------------------------------------------------------------------
// Sync-triggered pass (serialized, debounced, dirty-rerun — ledgerManager's
// trigger pattern)
// ---------------------------------------------------------------------------

let syncHandler: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let dirty = false;

async function runPass(getAccountId: () => string | null): Promise<void> {
  const accountId = getAccountId();
  if (!accountId) return;
  if (inFlight) {
    dirty = true;
    return;
  }
  inFlight = true;
  try {
    await refreshRecordExtractions(accountId);
    window.dispatchEvent(new Event("velo-records-updated"));
  } catch (err) {
    console.error("Records pass failed:", err);
  } finally {
    inFlight = false;
    if (dirty) {
      dirty = false;
      void runPass(getAccountId);
    }
  }
}

export function startRecordsManager(getAccountId: () => string | null): void {
  stopRecordsManager();
  syncHandler = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runPass(getAccountId);
    }, SYNC_DEBOUNCE_MS);
  };
  window.addEventListener("velo-sync-done", syncHandler);
}

export function stopRecordsManager(): void {
  if (syncHandler) {
    window.removeEventListener("velo-sync-done", syncHandler);
    syncHandler = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/records/recordsManager.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/records/recordsManager.ts src/services/records/recordsManager.test.ts
git commit -m "feat(vault): sync-triggered records manager with 90-day floor"
```

---

### Task 6: Ask flow — `services/records/ask.ts`

**Files:**
- Create: `src/services/records/ask.ts`
- Test: `src/services/records/ask.test.ts`

**Interfaces:**
- Consumes: `AiCompletionRequest` from `@/services/ai/types`; `getActiveProvider` from `@/services/ai/providerManager`; `parseModelJson` from `@/services/brief/briefSchema`; `searchRecords`, `RECORD_KINDS`, `DbRecord`, `RecordKind` (Task 3).
- Produces (Task 7 depends on these exact names):
  - `const ASK_RESULT_CAP = 12`
  - `interface AskPlan { ftsQueries: string[]; kinds: RecordKind[] | null; dateFrom: number | null; dateTo: number | null }`
  - `validateAskPlan(value: unknown): AskPlan | null`
  - `sanitizeFtsQuery(q: string): string`
  - `extractCitations(answer: string, validIds: Set<string>): { text: string; citedIds: string[] }`
  - `type AskOutcome = { status: "answered"; answer: string; sources: DbRecord[] } | { status: "no-match" } | { status: "bad-question" }`
  - `askVault(accountId: string, question: string): Promise<AskOutcome>`

- [ ] **Step 1: Write the failing test**

Create `src/services/records/ask.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbRecord } from "./records";

const mockComplete = vi.fn();
vi.mock("@/services/ai/providerManager", () => ({
  getActiveProvider: vi.fn(() => Promise.resolve({ complete: mockComplete })),
}));
vi.mock("./records", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./records")>()),
  searchRecords: vi.fn(),
}));

import { searchRecords } from "./records";
import {
  validateAskPlan,
  sanitizeFtsQuery,
  extractCitations,
  askVault,
  ASK_RESULT_CAP,
} from "./ask";

function rec(id: string): DbRecord {
  return {
    id, account_id: "a1", thread_id: `th-${id}`, kind: "purchase",
    vendor: "Fully", title: "Standing desk order", record_date: null,
    amount: "$729.00", reference_numbers: '[{"label":"Order #","value":"F-118272"}]',
    details: null, attachment_names: "[]", source_message_date: 1, created_at: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchRecords).mockResolvedValue([]);
});

describe("validateAskPlan", () => {
  it("accepts a full plan and parses dates to epochs", () => {
    const plan = validateAskPlan({
      ftsQueries: ["standing desk"], kinds: ["purchase"],
      dateFrom: "2026-01-01", dateTo: "2026-06-30",
    });
    expect(plan).toEqual({
      ftsQueries: ["standing desk"], kinds: ["purchase"],
      dateFrom: Date.parse("2026-01-01"), dateTo: Date.parse("2026-06-30"),
    });
  });

  it("normalizes missing optionals and filters bad kinds", () => {
    const plan = validateAskPlan({ ftsQueries: ["desk"], kinds: ["purchase", "nope"] });
    expect(plan).toEqual({ ftsQueries: ["desk"], kinds: ["purchase"], dateFrom: null, dateTo: null });
  });

  it("rejects missing or empty ftsQueries", () => {
    expect(validateAskPlan({ ftsQueries: [] })).toBeNull();
    expect(validateAskPlan({ kinds: ["purchase"] })).toBeNull();
    expect(validateAskPlan("nope")).toBeNull();
  });
});

describe("sanitizeFtsQuery", () => {
  it("quotes each token to neutralize FTS5 operators", () => {
    expect(sanitizeFtsQuery("standing desk")).toBe('"standing" "desk"');
    expect(sanitizeFtsQuery('desk OR (evil* NEAR "x")')).toBe(
      '"desk" "OR" "(evil*" "NEAR" "x)"',
    );
  });

  it("strips embedded double quotes and empty tokens", () => {
    expect(sanitizeFtsQuery('  "" f-118272 ')).toBe('"f-118272"');
    expect(sanitizeFtsQuery("   ")).toBe("");
  });
});

describe("extractCitations", () => {
  it("collects valid ids in order, deduped, and strips all tokens", () => {
    const { text, citedIds } = extractCitations(
      "Your desk order [[r1]] was $729 [[r1]], see also [[bogus]].",
      new Set(["r1", "r2"]),
    );
    expect(citedIds).toEqual(["r1"]);
    expect(text).not.toContain("[[");
    expect(text).toContain("Your desk order");
  });
});

describe("askVault", () => {
  it("plans, retrieves, answers, and returns cited sources", async () => {
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ ftsQueries: ["standing desk"] }))
      .mockResolvedValueOnce("Order F-118272, $729.00. [[r1]]");
    vi.mocked(searchRecords).mockResolvedValue([rec("r1"), rec("r2")]);
    const result = await askVault("a1", "what was my desk order number?");
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.sources.map((s) => s.id)).toEqual(["r1"]);
      expect(result.answer).toContain("F-118272");
    }
    expect(vi.mocked(searchRecords)).toHaveBeenCalledWith(
      "a1", '"standing" "desk"',
      { kinds: null, dateFrom: null, dateTo: null, limit: ASK_RESULT_CAP },
    );
  });

  it("returns no-match on zero hits without a second provider call", async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({ ftsQueries: ["desk"] }));
    const result = await askVault("a1", "where is it?");
    expect(result).toEqual({ status: "no-match" });
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("retries an invalid plan once, then returns bad-question", async () => {
    mockComplete.mockResolvedValue("not json");
    const result = await askVault("a1", "???");
    expect(result).toEqual({ status: "bad-question" });
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  it("unions hits across queries, dedupes, and survives a failing query", async () => {
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ ftsQueries: ["a", "b", "c"] }))
      .mockResolvedValueOnce("Answer [[r1]] [[r2]]");
    vi.mocked(searchRecords)
      .mockResolvedValueOnce([rec("r1")])
      .mockRejectedValueOnce(new Error("fts syntax"))
      .mockResolvedValueOnce([rec("r1"), rec("r2")]);
    const result = await askVault("a1", "q");
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.sources.map((s) => s.id)).toEqual(["r1", "r2"]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/records/ask.test.ts`
Expected: FAIL — cannot resolve `./ask`.

- [ ] **Step 3: Write the implementation**

Create `src/services/records/ask.ts`:

```typescript
import type { AiCompletionRequest } from "@/services/ai/types";
import { getActiveProvider } from "@/services/ai/providerManager";
import { parseModelJson } from "@/services/brief/briefSchema";
import { searchRecords, RECORD_KINDS, type DbRecord, type RecordKind } from "./records";

export const ASK_RESULT_CAP = 12;

export interface AskPlan {
  ftsQueries: string[];
  kinds: RecordKind[] | null;
  dateFrom: number | null;
  dateTo: number | null;
}

export type AskOutcome =
  | { status: "answered"; answer: string; sources: DbRecord[] }
  | { status: "no-match" }
  | { status: "bad-question" };

function parsePlanDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function validateAskPlan(value: unknown): AskPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o["ftsQueries"])) return null;
  const ftsQueries = o["ftsQueries"].filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0,
  );
  if (ftsQueries.length === 0) return null;

  let kinds: RecordKind[] | null = null;
  if (Array.isArray(o["kinds"])) {
    const filtered = o["kinds"].filter(
      (k): k is RecordKind =>
        typeof k === "string" && (RECORD_KINDS as string[]).includes(k),
    );
    kinds = filtered.length > 0 ? filtered : null;
  }

  return {
    ftsQueries,
    kinds,
    dateFrom: parsePlanDate(o["dateFrom"]),
    dateTo: parsePlanDate(o["dateTo"]),
  };
}

/**
 * Neutralize FTS5 syntax: every whitespace token becomes a quoted string,
 * so operators (OR, NEAR, *, -) and column filters can't pass through.
 */
export function sanitizeFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ");
}

export function buildPlanRequest(question: string, todayIso: string): AiCompletionRequest {
  return {
    systemPrompt: [
      "You translate a question about the user's email records archive into",
      "search queries. Records are receipts, orders, invoices, travel and event",
      "reservations, statement notices, and appointment confirmations, with",
      "kinds: purchase, travel, statement, appointment.",
      "Return ONLY a JSON object:",
      '{"ftsQueries": ["2-4 short keyword queries, distinct phrasings"],',
      ' "kinds": ["subset of the four kinds"] or null,',
      ' "dateFrom": "YYYY-MM-DD" or null, "dateTo": "YYYY-MM-DD" or null}',
      `Today is ${todayIso}. No prose outside the JSON.`,
    ].join("\n"),
    userContent: question,
    maxTokens: 300,
  };
}

export function buildAnswerRequest(question: string, records: DbRecord[]): AiCompletionRequest {
  const lines = records.map((r) => {
    const refs = r.reference_numbers !== "[]" ? ` refs=${r.reference_numbers}` : "";
    const atts = r.attachment_names !== "[]" ? ` attachments=${r.attachment_names}` : "";
    const date = r.record_date
      ? new Date(r.record_date).toISOString().slice(0, 10)
      : new Date(r.source_message_date).toISOString().slice(0, 10);
    return `- id=${r.id} :: [${r.kind}] ${r.vendor ?? "?"} — ${r.title} (${date})${
      r.amount ? ` ${r.amount}` : ""
    }${refs}${atts}${r.details ? ` :: ${r.details}` : ""}`;
  });
  return {
    systemPrompt: [
      "You answer a question using ONLY the provided email records.",
      "Cite records inline with [[id]] tokens right after facts drawn from them.",
      "If the records do not answer the question, say so plainly.",
      "Never invent details. Keep the answer to 1-3 sentences.",
    ].join("\n"),
    userContent: `Question: ${question}\n\nRecords:\n${lines.join("\n")}`,
    maxTokens: 400,
  };
}

/** Valid ids become sources; every [[...]] token is stripped from the text. */
export function extractCitations(
  answer: string,
  validIds: Set<string>,
): { text: string; citedIds: string[] } {
  const citedIds: string[] = [];
  for (const match of answer.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const id = match[1]!.trim();
    if (validIds.has(id) && !citedIds.includes(id)) citedIds.push(id);
  }
  const text = answer.replace(/\s*\[\[[^\]]+\]\]/g, "").replace(/ {2,}/g, " ").trim();
  return { text, citedIds };
}

/**
 * Two-stage ask: Claude plans FTS queries, deterministic retrieval fetches
 * the top hits, Claude answers citing only manifest-validated record ids.
 * Ephemeral — nothing is cached; two provider calls per ask.
 */
export async function askVault(accountId: string, question: string): Promise<AskOutcome> {
  const provider = await getActiveProvider();
  const planRequest = buildPlanRequest(question, new Date().toISOString().slice(0, 10));

  let plan = validateAskPlan(parseModelJson(await provider.complete(planRequest)));
  if (!plan) {
    plan = validateAskPlan(
      parseModelJson(
        await provider.complete({
          ...planRequest,
          userContent: `${planRequest.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!plan) return { status: "bad-question" };

  const seen = new Map<string, DbRecord>();
  for (const q of plan.ftsQueries) {
    const sanitized = sanitizeFtsQuery(q);
    if (!sanitized) continue;
    try {
      const hits = await searchRecords(accountId, sanitized, {
        kinds: plan.kinds,
        dateFrom: plan.dateFrom,
        dateTo: plan.dateTo,
        limit: ASK_RESULT_CAP,
      });
      for (const h of hits) if (!seen.has(h.id)) seen.set(h.id, h);
    } catch {
      // a failed query contributes zero hits rather than failing the ask
    }
  }
  const candidates = [...seen.values()].slice(0, ASK_RESULT_CAP);
  if (candidates.length === 0) return { status: "no-match" };

  const answerRaw = await provider.complete(buildAnswerRequest(question, candidates));
  const { text, citedIds } = extractCitations(
    answerRaw,
    new Set(candidates.map((r) => r.id)),
  );
  const byId = new Map(candidates.map((r) => [r.id, r]));
  return {
    status: "answered",
    answer: text,
    sources: citedIds.map((id) => byId.get(id)!),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/records/ask.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/records/ask.ts src/services/records/ask.test.ts
git commit -m "feat(vault): two-stage ask flow with manifest-validated citations"
```

---

### Task 7: Vault page + app wiring

**Files:**
- Create: `src/components/vault/VaultPage.tsx`
- Test: `src/components/vault/VaultPage.test.tsx`
- Modify: `src/components/layout/MailLayout.tsx` (VIEW_COMPONENTS map, ~line 12)
- Modify: `src/components/layout/Sidebar.tsx` (ALL_NAV_ITEMS ~line 40, TOP_IDS ~line 201)
- Modify: `src/constants/shortcuts.ts` (Navigation items, after `nav.goLedger` ~line 20)
- Modify: `src/hooks/useKeyboardShortcuts.ts` (switch, after `nav.goLedger` case ~line 231)
- Modify: `src/components/search/CommandPalette.tsx` (nav commands, after `go-ledger` ~line 45)
- Modify: `src/App.tsx` (manager start/stop, next to ledger manager ~lines 48, 305, 343)

**Interfaces:**
- Consumes: `listRecords`, `countRecords`, `RECORD_KINDS`, `DbRecord`, `RecordKind`, `ReferenceNumber` (Task 3); `suppressRecord` (Task 4); `getVaultFloor`, `startRecordsManager`, `stopRecordsManager` (Task 5); `askVault`, `AskOutcome` (Task 6); `isAiAvailable` from `@/services/ai/providerManager`; `navigateToThread`, `navigateToSettings`, `navigateToLabel` from `@/router/navigate`; `getThreadById`, `getThreadLabelIds` from `@/services/db/threads`; stores + `EmptyState` as in `LedgerPage.tsx`.
- Produces: `VaultPage({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> })` registered for label `"vault"`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/vault/VaultPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPage } from "./VaultPage";
import { useAccountStore } from "@/stores/accountStore";
import type { DbRecord } from "@/services/records/records";

const purchase: DbRecord = {
  id: "r1", account_id: "acc-1", thread_id: "t1", kind: "purchase",
  vendor: "Fully", title: "Standing desk order", record_date: 1_780_000_000_000,
  amount: "$729.00", reference_numbers: '[{"label":"Order #","value":"F-118272"}]',
  details: "Jarvis desk", attachment_names: '["invoice.pdf"]',
  source_message_date: 1_780_000_000_000, created_at: 1,
};

vi.mock("@/services/records/records", () => ({
  RECORD_KINDS: ["purchase", "travel", "statement", "appointment"],
  listRecords: vi.fn(() => Promise.resolve([purchase])),
  countRecords: vi.fn(() => Promise.resolve(1)),
}));
vi.mock("@/services/records/extractor", () => ({ suppressRecord: vi.fn() }));
vi.mock("@/services/records/recordsManager", () => ({
  getVaultFloor: vi.fn(() => Promise.resolve(1_772_000_000_000)),
}));
vi.mock("@/services/records/ask", () => ({
  askVault: vi.fn(() =>
    Promise.resolve({ status: "answered", answer: "Order F-118272.", sources: [purchase] }),
  ),
}));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(() => Promise.resolve(undefined)),
  getThreadLabelIds: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  navigateToSettings: vi.fn(),
  navigateToLabel: vi.fn(),
}));

import { listRecords } from "@/services/records/records";
import { suppressRecord } from "@/services/records/extractor";
import { askVault } from "@/services/records/ask";
import { isAiAvailable } from "@/services/ai/providerManager";

describe("VaultPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    useAccountStore.setState({
      accounts: [{ id: "acc-1", email: "me@x.com", displayName: null, avatarUrl: null, isActive: true }],
      activeAccountId: "acc-1",
    });
  });

  it("renders records with vendor, title, amount, and copyable references", async () => {
    render(<VaultPage />);
    expect(await screen.findByText("Standing desk order")).toBeInTheDocument();
    expect(screen.getByText("$729.00")).toBeInTheDocument();
    expect(screen.getByText("Order # F-118272")).toBeInTheDocument();
  });

  it("filters by kind when a chip is clicked", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    await waitFor(() => {
      expect(vi.mocked(listRecords)).toHaveBeenLastCalledWith("acc-1", ["travel"]);
    });
  });

  it("asks the vault on Enter and renders the answer with sources", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    const box = screen.getByPlaceholderText(/ask your archive/i);
    fireEvent.change(box, { target: { value: "desk order number?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Order F-118272.")).toBeInTheDocument();
    expect(vi.mocked(askVault)).toHaveBeenCalledWith("acc-1", "desk order number?");
  });

  it("suppresses a record via Not a record", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    fireEvent.click(screen.getByTitle("Not a record"));
    await waitFor(() => {
      expect(vi.mocked(suppressRecord)).toHaveBeenCalledWith(
        "acc-1", expect.objectContaining({ id: "r1" }),
      );
    });
  });

  it("shows the AI setup pointer when no provider is configured", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    render(<VaultPage />);
    expect(await screen.findByText(/add an ai provider/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/vault/VaultPage.test.tsx`
Expected: FAIL — cannot resolve `./VaultPage`.

- [ ] **Step 3: Write the component**

Create `src/components/vault/VaultPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  Vault,
  ShoppingBag,
  Plane,
  FileText,
  CalendarCheck,
  Paperclip,
  Copy,
  X,
  Search,
} from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { GenericEmptyIllustration } from "../ui/illustrations";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToThread, navigateToSettings } from "@/router/navigate";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import { isAiAvailable } from "@/services/ai/providerManager";
import {
  listRecords,
  countRecords,
  type DbRecord,
  type RecordKind,
  type ReferenceNumber,
} from "@/services/records/records";
import { suppressRecord } from "@/services/records/extractor";
import { getVaultFloor } from "@/services/records/recordsManager";
import { askVault, type AskOutcome } from "@/services/records/ask";

const KIND_ICONS: Record<RecordKind, typeof ShoppingBag> = {
  purchase: ShoppingBag,
  travel: Plane,
  statement: FileText,
  appointment: CalendarCheck,
};

const KIND_CHIPS: { value: RecordKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "purchase", label: "Purchases" },
  { value: "travel", label: "Travel" },
  { value: "statement", label: "Statements" },
  { value: "appointment", label: "Appointments" },
];

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function recordDateLabel(r: DbRecord): string {
  const t = r.record_date ?? r.source_message_date;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The Records Vault — receipts, confirmations, statements, and appointments
 * extracted from feed mail. Ask box on top (explicit provider call on Enter);
 * deterministic browsable list below. List reads are pure SQL — opening the
 * view never waits on a model.
 */
export function VaultPage({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> }) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);

  const [records, setRecords] = useState<DbRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [floor, setFloor] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<RecordKind | "all">("all");
  const [loaded, setLoaded] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskOutcome | null>(null);

  const reload = useCallback(async () => {
    if (!activeAccountId) return;
    const requested = activeAccountId;
    const kinds = kindFilter === "all" ? undefined : [kindFilter];
    const [rows, count, vaultFloor] = await Promise.all([
      listRecords(requested, kinds),
      countRecords(requested),
      getVaultFloor(requested),
    ]);
    if (useAccountStore.getState().activeAccountId !== requested) return;
    setRecords(rows);
    setTotal(count);
    setFloor(vaultFloor);
    setLoaded(true);
  }, [activeAccountId, kindFilter]);

  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    void isAiAvailable().then(setAiReady);
  }, []);

  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener("velo-records-updated", handler);
    return () => window.removeEventListener("velo-records-updated", handler);
  }, [reload]);

  // Clear stale thread list so global shortcuts can't act on invisible rows
  useEffect(() => {
    const { selectedThreadIds, threadMap } = useThreadStore.getState();
    if (selectedThreadIds.size > 0) useThreadStore.getState().clearMultiSelect();
    if (threadMap.size > 0) useThreadStore.getState().setThreads([]);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    if (!activeAccountId) return;
    const { threadMap, setThreads } = useThreadStore.getState();
    if (threadMap.has(threadId)) {
      setThreads([threadMap.get(threadId)!]);
    } else {
      const dbThread = await getThreadById(activeAccountId, threadId);
      if (!dbThread) return;
      const labelIds = await getThreadLabelIds(activeAccountId, threadId);
      setThreads([{
        id: dbThread.id,
        accountId: dbThread.account_id,
        subject: dbThread.subject,
        snippet: dbThread.snippet,
        lastMessageAt: dbThread.last_message_at ?? 0,
        messageCount: dbThread.message_count,
        isRead: dbThread.is_read === 1,
        isStarred: dbThread.is_starred === 1,
        isPinned: dbThread.is_pinned === 1,
        isMuted: dbThread.is_muted === 1,
        hasAttachments: dbThread.has_attachments === 1,
        labelIds,
        fromName: dbThread.from_name,
        fromAddress: dbThread.from_address,
        listUnsubscribe: dbThread.list_unsubscribe,
      }]);
    }
    navigateToThread(threadId);
  }, [activeAccountId]);

  const ask = useCallback(async () => {
    if (!activeAccountId || !question.trim() || asking) return;
    setAsking(true);
    setAskResult(null);
    try {
      setAskResult(await askVault(activeAccountId, question.trim()));
    } catch (err) {
      console.error("Ask failed:", err);
      setAskResult({ status: "bad-question" });
    } finally {
      setAsking(false);
    }
  }, [activeAccountId, question, asking]);

  const notARecord = useCallback(async (r: DbRecord) => {
    if (!activeAccountId) return;
    await suppressRecord(activeAccountId, r);
    void reload();
  }, [activeAccountId, reload]);

  const copyRef = useCallback((value: string) => {
    void navigator.clipboard.writeText(value);
  }, []);

  const floorLabel = floor
    ? new Date(floor).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  const renderRow = (r: DbRecord) => {
    const Icon = KIND_ICONS[r.kind] ?? FileText;
    const refs = parseJsonArray<ReferenceNumber>(r.reference_numbers);
    const attachments = parseJsonArray<string>(r.attachment_names);
    return (
      <div
        key={r.id}
        className="px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover transition-colors group flex items-center gap-3"
      >
        <Icon size={16} className="text-text-tertiary shrink-0" />
        <button onClick={() => void openThread(r.thread_id)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">
              {r.vendor ? `${r.vendor} — ${r.title}` : r.title}
            </span>
            {r.amount && (
              <span className="text-xs text-text-secondary shrink-0">{r.amount}</span>
            )}
            <span className="text-xs text-text-tertiary shrink-0">{recordDateLabel(r)}</span>
            {attachments.length > 0 && (
              <span title={attachments.join(", ")} className="shrink-0">
                <Paperclip size={12} className="text-text-tertiary" />
              </span>
            )}
          </div>
          {r.details && (
            <div className="text-xs text-text-secondary truncate">{r.details}</div>
          )}
        </button>
        <div className="shrink-0 flex items-center gap-1">
          {refs.map((ref) => (
            <button
              key={`${ref.label}-${ref.value}`}
              onClick={() => copyRef(ref.value)}
              title={`Copy ${ref.value}`}
              className="hidden md:flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-text-secondary bg-bg-tertiary rounded hover:text-accent transition-colors"
            >
              <Copy size={10} />
              {ref.label} {ref.value}
            </button>
          ))}
          <button
            onClick={() => void notARecord(r)}
            title="Not a record"
            className="p-1.5 text-text-secondary hover:text-danger rounded transition-colors opacity-0 group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  };

  const renderAskResult = () => {
    if (!askResult) return null;
    if (askResult.status === "no-match") {
      return (
        <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Nothing in the vault matched that — try the list below.
        </div>
      );
    }
    if (askResult.status === "bad-question") {
      return (
        <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Couldn't understand that question — try rephrasing it.
        </div>
      );
    }
    return (
      <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-accent-light/40 border border-border-secondary">
        <p className="text-sm text-text-primary">{askResult.answer}</p>
        {askResult.sources.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {askResult.sources.map((s) => (
              <button
                key={s.id}
                onClick={() => void openThread(s.thread_id)}
                className="text-left text-xs text-accent hover:underline truncate"
              >
                {s.vendor ? `${s.vendor} — ${s.title}` : s.title} · {recordDateLabel(s)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={listRef}
      className={`flex flex-col bg-bg-secondary/50 glass-panel ${
        readingPanePosition === "right"
          ? "min-w-[240px] shrink-0"
          : readingPanePosition === "bottom"
            ? "w-full border-b border-border-primary h-[40%] min-h-[200px]"
            : "w-full flex-1"
      }`}
      style={readingPanePosition === "right" && width ? { width } : undefined}
    >
      <div className="px-5 py-4 border-b border-border-primary">
        <h1 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Vault size={16} />
          Vault
        </h1>
        <p className="text-xs text-text-tertiary mt-0.5">
          {total} record{total === 1 ? "" : "s"}
          {floorLabel ? ` since ${floorLabel}` : ""}
        </p>
      </div>

      {aiReady === false ? (
        <div className="m-4 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Add an AI provider key in{" "}
          <button onClick={() => navigateToSettings("ai")} className="text-accent hover:underline">
            Settings
          </button>{" "}
          and Velo will start filing receipts, confirmations, and statements here.
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary/60 border border-border-secondary focus-within:border-accent transition-colors">
              <Search size={14} className="text-text-tertiary shrink-0" />
              <input
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  if (e.target.value === "") setAskResult(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void ask();
                  if (e.key === "Escape") {
                    setQuestion("");
                    setAskResult(null);
                  }
                }}
                placeholder="Ask your archive — “what's my United confirmation number?”"
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
              {asking && <span className="text-xs text-text-tertiary shrink-0">thinking…</span>}
            </div>
          </div>
          {renderAskResult()}
          <div className="px-4 py-2 flex items-center gap-1.5 flex-wrap">
            {KIND_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setKindFilter(chip.value)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  kindFilter === chip.value
                    ? "bg-accent text-white border-accent"
                    : "text-text-secondary border-border-secondary hover:bg-bg-hover"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto">
        {loaded && records.length === 0 && aiReady !== false ? (
          <EmptyState
            illustration={GenericEmptyIllustration}
            title="No records yet"
            subtitle={
              total === 0
                ? "Indexing your mail — records appear over the next few sync cycles."
                : "Nothing matches this filter."
            }
          />
        ) : (
          records.map(renderRow)
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/vault/VaultPage.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the app**

In `src/components/layout/MailLayout.tsx`, add the import and map entry:

```typescript
import { VaultPage } from "@/components/vault/VaultPage";
```

```typescript
const VIEW_COMPONENTS: Record<string, typeof EmailList> = {
  brief: BriefPage,
  home: HomePage,
  ledger: LedgerPage,
  vault: VaultPage,
};
```

In `src/components/layout/Sidebar.tsx`, add `Vault` to the lucide import, then in `ALL_NAV_ITEMS` after the ledger entry:

```typescript
  { id: "vault", label: "Vault", icon: Vault },
```

and extend TOP_IDS (~line 201):

```typescript
    const TOP_IDS = ["brief", "home", "ledger", "vault"];
```

In `src/constants/shortcuts.ts`, after the `nav.goLedger` line:

```typescript
    { id: "nav.goVault", keys: "g then v", desc: "Go to Vault" },
```

In `src/hooks/useKeyboardShortcuts.ts`, after the `nav.goLedger` case:

```typescript
    case "nav.goVault":
      navigateToLabel("vault");
      break;
```

In `src/components/search/CommandPalette.tsx`, after the `go-ledger` entry:

```typescript
    { id: "go-vault", label: "Go to Vault", shortcut: "g v", category: "Navigation", action: () => { navigateToLabel("vault"); onClose(); } },
```

In `src/App.tsx`: add next to the ledger manager import (~line 48):

```typescript
import { startRecordsManager, stopRecordsManager } from "./services/records/recordsManager";
```

after `startLedgerManager(...)` (~line 305):

```typescript
        startRecordsManager(() => useAccountStore.getState().activeAccountId);
```

and next to `stopLedgerManager()` in the cleanup (~line 343):

```typescript
      stopRecordsManager();
```

- [ ] **Step 6: Full verification**

Run: `npm run test` → all pass. Run: `npx tsc --noEmit` → no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/vault/ src/components/layout/MailLayout.tsx src/components/layout/Sidebar.tsx src/constants/shortcuts.ts src/hooks/useKeyboardShortcuts.ts src/components/search/CommandPalette.tsx src/App.tsx
git commit -m "feat(vault): vault page with ask box, record list, and app wiring"
```

---

### Task 8: Documentation + final verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update CLAUDE.md**

Make these edits (match the surrounding prose style; each is a small in-place addition):

1. **`ai/` service bullet**: after "the Ledger pipeline (`services/ledger/`), which drives obligation extraction and nudge drafting", add: ", and the Vault pipeline (`services/records/`), which drives record extraction and archive Q&A". (The `db/` "24 service files" count stays — records queries live in `services/records/records.ts`, not `db/`.)
2. **Add a `records/` service bullet** after the `ledger/` bullet:
   `- `records/` — Records Vault pipeline (`candidates`, `records`, `extractor`, `recordsManager`, `ask`): deterministic feed+cue candidate filter since a per-account 90-day floor (`records_vault_floor:{accountId}` setting) → cached `records_extract_v1` extractions in `ai_cache` (suppression list carried across re-extractions) → materialized `records` table + `records_fts` FTS5 index; two-stage ask flow answers questions citing manifest-validated record ids.`
3. **Component organization**: change "12 groups" to "13 groups" and add after the `ledger/` line:
   `- `vault/` — VaultPage (records archive at `/mail/vault`: natural-language ask box + filterable record list with click-to-copy reference numbers and "Not a record" overturn; `g v`)`
4. **Startup sequence step 6**: append to the Brief/Ledger manager sentence: `+ startRecordsManager() (sync-triggered, debounced record extraction, ~20 threads/pass)`.
5. **Keyboard shortcuts table**: add row `| `g` then `v` | Go to Vault |` after the `g then l` row.
6. **Database section**: change "24 migrations" to "25 migrations" and "36 total" to "38 total"; add to the key-tables list: `` `records` (extracted vault records, delete-and-rewritten per thread), `records_fts` (FTS5 over vendor/title/details/reference text, synced by `services/records/records.ts` — no triggers) ``.
7. **Cross-component communication**: add `velo-records-updated` to the custom window events list.
8. **Key Gotchas**, AI providers bullet: after "by the Ledger pipeline (`services/ledger/`) for obligation extraction", add ", and by the Vault pipeline (`services/records/`) for record extraction and archive Q&A".
9. **Testing section**: update the test-file count ("117 test files") to the new total — run `find src -name "*.test.ts" -o -name "*.test.tsx" | wc -l` and use that number, adjusting the per-area counts (services +5, components +1).

- [ ] **Step 2: Final verification**

Run: `npm run test` → all pass. Run: `npx tsc --noEmit` → no output.
Run: `git log --oneline main..HEAD` → one commit per task, conventional messages.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the records vault (milestone 5)"
```

---

## Manual smoke checklist (post-implementation, real mailbox)

Not automatable — run `npm run tauri dev` with the user:

1. Backfill populates plausible records over a few sync cycles (watch the count in the Vault header climb).
2. A known confirmation/order number is findable via the ask box, with a working source link to the thread.
3. Click-to-copy on a reference chip puts the value on the clipboard.
4. "Not a record" removes a row and it stays gone after the next sync.
5. `g v`, sidebar entry, and command palette all reach the vault.
6. With the AI key removed, the vault shows the setup pointer and the list still renders.
7. Ollama smoke test (provider-agnostic check).
```
