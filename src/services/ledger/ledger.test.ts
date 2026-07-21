import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));
vi.mock("./candidates", () => ({
  getLedgerCandidates: vi.fn(),
}));
vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
}));
vi.mock("@/services/db/ledgerOverrides", () => ({
  getLedgerOverrides: vi.fn(() => Promise.resolve([])),
  getPinnedOverrides: vi.fn(() => Promise.resolve([])),
}));

import { getLedgerCandidates } from "./candidates";
import { getAiCache } from "@/services/db/aiCache";
import { getLedgerOverrides, getPinnedOverrides } from "@/services/db/ledgerOverrides";
import { getLedger } from "./ledger";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

const cand = (o: Record<string, unknown>) => ({
  threadId: "t1",
  subject: "Venue",
  counterpartyAddress: "alice@example.com",
  counterpartyName: "Alice Chen",
  ownerLastSentAt: NOW - 6 * DAY,
  ownerSpokeLast: true,
  lastMessageAt: NOW - 6 * DAY,
  messageCount: 2,
  ...o,
});

function cache(stateKey: string, extraction: Record<string, unknown>) {
  return JSON.stringify({ stateKey, extraction });
}

const waitingExtraction = {
  expectsReply: true, why: "asked to confirm", counterparty: "Alice Chen", promises: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLedgerOverrides).mockResolvedValue([]);
  vi.mocked(getPinnedOverrides).mockResolvedValue([]);
  // accounts email lookup
  mockSelect.mockResolvedValue([{ email: "me@x.com" }]);
});

describe("getLedger", () => {
  it("derives a waiting-on entry with age from the owner's last send", async () => {
    const c = cand({});
    vi.mocked(getLedgerCandidates).mockResolvedValue([c]);
    vi.mocked(getAiCache).mockResolvedValue(
      cache(`${c.lastMessageAt}:2`, waitingExtraction),
    );
    const { waitingOn, promises } = await getLedger("a1", NOW);
    expect(promises).toHaveLength(0);
    expect(waitingOn).toHaveLength(1);
    expect(waitingOn[0]).toMatchObject({
      threadId: "t1", kind: "waiting", counterparty: "Alice Chen",
      detail: "asked to confirm", ageDays: 6, pinned: false,
    });
  });

  it("no waiting entry when the counterparty spoke last", async () => {
    vi.mocked(getLedgerCandidates).mockResolvedValue([cand({ ownerSpokeLast: false })]);
    vi.mocked(getAiCache).mockResolvedValue(cache(`${NOW - 6 * DAY}:2`, waitingExtraction));
    const { waitingOn } = await getLedger("a1", NOW);
    expect(waitingOn).toHaveLength(0);
  });

  it("promise entries survive counterparty replies and parse due dates", async () => {
    const c = cand({ ownerSpokeLast: false });
    vi.mocked(getLedgerCandidates).mockResolvedValue([c]);
    vi.mocked(getAiCache).mockResolvedValue(
      cache(`${c.lastMessageAt}:2`, {
        expectsReply: false, why: null, counterparty: "Alice Chen",
        promises: [{ what: "send the deck", due: "2026-07-25" }],
      }),
    );
    const { promises } = await getLedger("a1", NOW);
    expect(promises).toHaveLength(1);
    expect(promises[0]!.detail).toBe("send the deck");
    expect(promises[0]!.dueAt).toBe(Date.parse("2026-07-25"));
  });

  it("stale-stateKey caches are ignored (entry drops until re-extraction)", async () => {
    vi.mocked(getLedgerCandidates).mockResolvedValue([cand({})]);
    vi.mocked(getAiCache).mockResolvedValue(cache("old:1", waitingExtraction));
    const { waitingOn } = await getLedger("a1", NOW);
    expect(waitingOn).toHaveLength(0);
  });

  it("dismissed and done overrides hide entries per kind", async () => {
    const c = cand({});
    vi.mocked(getLedgerCandidates).mockResolvedValue([c]);
    vi.mocked(getAiCache).mockResolvedValue(
      cache(`${c.lastMessageAt}:2`, {
        ...waitingExtraction,
        promises: [{ what: "deck", due: null }],
      }),
    );
    vi.mocked(getLedgerOverrides).mockResolvedValue([
      { id: "o1", account_id: "a1", thread_id: "t1", kind: "waiting", action: "dismissed", due_at: null, created_at: 1 },
      { id: "o2", account_id: "a1", thread_id: "t1", kind: "promise", action: "done", due_at: null, created_at: 1 },
    ]);
    const { waitingOn, promises } = await getLedger("a1", NOW);
    expect(waitingOn).toHaveLength(0);
    expect(promises).toHaveLength(0);
  });

  it("pinned overrides force a waiting entry even without an extraction", async () => {
    vi.mocked(getLedgerCandidates).mockResolvedValue([cand({})]);
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getPinnedOverrides).mockResolvedValue([
      { id: "o1", account_id: "a1", thread_id: "t1", kind: "waiting", action: "pinned", due_at: NOW + DAY, created_at: 1 },
    ]);
    const { waitingOn } = await getLedger("a1", NOW);
    expect(waitingOn).toHaveLength(1);
    expect(waitingOn[0]!.pinned).toBe(true);
    expect(waitingOn[0]!.dueAt).toBe(NOW + DAY);
  });

  it("pinned override resolves when the counterparty has replied", async () => {
    vi.mocked(getLedgerCandidates).mockResolvedValue([cand({ ownerSpokeLast: false })]);
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getPinnedOverrides).mockResolvedValue([
      { id: "o1", account_id: "a1", thread_id: "t1", kind: "waiting", action: "pinned", due_at: NOW + DAY, created_at: 1 },
    ]);
    const { waitingOn } = await getLedger("a1", NOW);
    expect(waitingOn).toHaveLength(0);
  });

  it("sorts oldest first", async () => {
    const c1 = cand({ threadId: "young", ownerLastSentAt: NOW - 1 * DAY, lastMessageAt: NOW - 1 * DAY });
    const c2 = cand({ threadId: "old", ownerLastSentAt: NOW - 9 * DAY, lastMessageAt: NOW - 9 * DAY });
    vi.mocked(getLedgerCandidates).mockResolvedValue([c1, c2]);
    vi.mocked(getAiCache).mockImplementation(async (_a, threadId) =>
      cache(`${threadId === "young" ? NOW - 1 * DAY : NOW - 9 * DAY}:2`, waitingExtraction),
    );
    const { waitingOn } = await getLedger("a1", NOW);
    expect(waitingOn.map((e) => e.threadId)).toEqual(["old", "young"]);
  });
});
