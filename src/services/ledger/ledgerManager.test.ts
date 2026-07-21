import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./candidates", () => ({ getLedgerCandidates: vi.fn() }));
vi.mock("./ledger", () => ({
  getOwnerEmail: vi.fn(() => Promise.resolve("me@x.com")),
  getLedger: vi.fn(() => Promise.resolve({ waitingOn: [], promises: [] })),
}));
vi.mock("./extractor", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./extractor")>();
  return { ...orig, extractThreadObligations: vi.fn() };
});
vi.mock("@/services/db/aiCache", () => ({ getAiCache: vi.fn() }));
vi.mock("@/services/db/ledgerOverrides", () => ({
  getPinnedOverrides: vi.fn(() => Promise.resolve([])),
  setLedgerOverride: vi.fn(),
}));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(),
  getActiveProvider: vi.fn(() => Promise.resolve({ complete: vi.fn(), testConnection: vi.fn() })),
}));
vi.mock("@/services/notifications/notificationManager", () => ({
  notifyFollowUpDue: vi.fn(),
}));

import { getLedgerCandidates } from "./candidates";
import { extractThreadObligations } from "./extractor";
import { getAiCache } from "@/services/db/aiCache";
import { isAiAvailable } from "@/services/ai/providerManager";
import { getLedger } from "./ledger";
import { getPinnedOverrides, setLedgerOverride } from "@/services/db/ledgerOverrides";
import { notifyFollowUpDue } from "@/services/notifications/notificationManager";
import { refreshLedgerExtractions, checkPinnedDue } from "./ledgerManager";

const NOW = 1_800_000_000_000;
const cand = {
  threadId: "t1", subject: "Venue", counterpartyAddress: "a@x.com",
  counterpartyName: "Alice", ownerLastSentAt: NOW, ownerSpokeLast: true,
  lastMessageAt: NOW, messageCount: 2,
};

beforeEach(() => vi.clearAllMocks());

describe("refreshLedgerExtractions", () => {
  it("no-ops when AI is unavailable", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    expect(await refreshLedgerExtractions("a1")).toBe(0);
    expect(vi.mocked(getLedgerCandidates)).not.toHaveBeenCalled();
  });

  it("extracts only candidates with stale or missing caches", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(getLedgerCandidates).mockResolvedValue([
      cand,
      { ...cand, threadId: "t2" },
    ]);
    vi.mocked(getAiCache).mockImplementation(async (_a, threadId) =>
      threadId === "t1"
        ? JSON.stringify({ stateKey: `${NOW}:2`, extraction: {} })
        : null,
    );
    vi.mocked(extractThreadObligations).mockResolvedValue({
      expectsReply: false, why: null, counterparty: null, promises: [],
    });
    const n = await refreshLedgerExtractions("a1");
    expect(n).toBe(1);
    expect(vi.mocked(extractThreadObligations)).toHaveBeenCalledTimes(1);
  });
});

describe("checkPinnedDue", () => {
  it("notifies and clears due on overdue unresolved pins", async () => {
    vi.mocked(getPinnedOverrides).mockResolvedValue([
      { id: "o1", account_id: "a1", thread_id: "t1", kind: "waiting", action: "pinned", due_at: NOW - 1, created_at: 1 },
    ]);
    vi.mocked(getLedger).mockResolvedValue({
      waitingOn: [{ threadId: "t1", kind: "waiting", subject: "Venue", counterparty: "Alice", detail: null, ageDays: 3, sinceAt: 1, dueAt: NOW - 1, pinned: true }],
      promises: [],
    });
    await checkPinnedDue("a1", NOW);
    expect(vi.mocked(notifyFollowUpDue)).toHaveBeenCalledWith("Venue", "t1", "a1");
    expect(vi.mocked(setLedgerOverride)).toHaveBeenCalledWith("a1", "t1", "waiting", "pinned", null);
  });

  it("does not notify resolved or future pins", async () => {
    vi.mocked(getPinnedOverrides).mockResolvedValue([
      { id: "o1", account_id: "a1", thread_id: "gone", kind: "waiting", action: "pinned", due_at: NOW - 1, created_at: 1 },
      { id: "o2", account_id: "a1", thread_id: "future", kind: "waiting", action: "pinned", due_at: NOW + 99999, created_at: 1 },
      { id: "o3", account_id: "a1", thread_id: "promised", kind: "promise", action: "pinned", due_at: NOW - 1, created_at: 1 },
    ]);
    vi.mocked(getLedger).mockResolvedValue({ waitingOn: [], promises: [] });
    await checkPinnedDue("a1", NOW);
    expect(vi.mocked(notifyFollowUpDue)).not.toHaveBeenCalled();
  });
});
