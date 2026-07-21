import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ledger", () => ({ getLedger: vi.fn() }));
import { getLedger } from "./ledger";
import { getObligationLines } from "./obligationLines";

const NOW = 1_800_000_000_000;
const entry = (o: Record<string, unknown>) => ({
  threadId: "t1", kind: "waiting" as const, subject: "Venue",
  counterparty: "Alice", detail: "confirm venue", ageDays: 6,
  sinceAt: NOW - 6 * 86_400_000, dueAt: null, pinned: false, ...o,
});

beforeEach(() => vi.clearAllMocks());

describe("getObligationLines", () => {
  it("formats waiting and promise lines, oldest first, cap 5", async () => {
    vi.mocked(getLedger).mockResolvedValue({
      waitingOn: [entry({})],
      promises: [entry({ threadId: "t2", kind: "promise", counterparty: "Sarah", detail: "send deck", dueAt: Date.parse("2026-07-25"), sinceAt: NOW - 9 * 86_400_000, ageDays: 9 })],
    });
    const lines = await getObligationLines("a1", NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.threadId).toBe("t2"); // older first
    expect(lines[0]!.line).toContain("you promised Sarah: send deck");
    expect(lines[0]!.line).toContain("due 2026-07-25");
    expect(lines[1]!.line).toBe("waiting on Alice for 6 days (confirm venue)");
    expect(lines[0]!.hashKey).toContain("oblig:promise:t2:9");
  });

  it("caps at 5", async () => {
    vi.mocked(getLedger).mockResolvedValue({
      waitingOn: Array.from({ length: 7 }, (_, i) => entry({ threadId: `t${i}`, sinceAt: i })),
      promises: [],
    });
    const lines = await getObligationLines("a1", NOW);
    expect(lines).toHaveLength(5);
  });
});
