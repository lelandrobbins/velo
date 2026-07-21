// src/services/ledger/candidates.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));

import { getLedgerCandidates, CANDIDATE_CAP } from "./candidates";

const NOW = 1_800_000_000_000;

function row(overrides: Record<string, unknown>) {
  return {
    thread_id: "t1",
    subject: "Venue",
    last_message_at: NOW - 1000,
    message_count: 2,
    owner_last_sent_at: NOW - 1000,
    last_from_address: "me@x.com",
    counterparty_address: "alice@example.com",
    counterparty_name: "Alice",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("getLedgerCandidates", () => {
  it("maps rows and computes ownerSpokeLast from the latest sender", async () => {
    mockSelect.mockResolvedValue([
      row({}),
      row({ thread_id: "t2", last_from_address: "alice@example.com" }),
    ]);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result).toHaveLength(2);
    expect(result[0]!.ownerSpokeLast).toBe(true);
    expect(result[1]!.ownerSpokeLast).toBe(false);
  });

  it("matches owner email case-insensitively", async () => {
    mockSelect.mockResolvedValue([row({ last_from_address: "Me@X.com" })]);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result[0]!.ownerSpokeLast).toBe(true);
  });

  it("drops automated counterparties", async () => {
    mockSelect.mockResolvedValue([
      row({}),
      row({ thread_id: "t3", counterparty_address: "noreply@github.com" }),
      row({ thread_id: "t4", counterparty_address: null }),
    ]);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result.map((c) => c.threadId)).toEqual(["t1"]);
  });

  it("passes the 30-day cutoff and cap into the query", async () => {
    mockSelect.mockResolvedValue([]);
    await getLedgerCandidates("a1", "me@x.com", NOW);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("LIMIT");
    expect(params).toContain(NOW - 30 * 24 * 3_600_000);
    expect(params).toContain(CANDIDATE_CAP);
  });
});
