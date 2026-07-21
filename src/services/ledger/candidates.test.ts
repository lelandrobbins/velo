// src/services/ledger/candidates.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));

import { getLedgerCandidates, CANDIDATE_CAP, extractFirstAddress } from "./candidates";

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
    fallback_to_addresses: null,
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

  it("passes the 30-day cutoff into the query, bounding both the thread scan and the EXISTS check, with no SQL cap", async () => {
    mockSelect.mockResolvedValue([]);
    await getLedgerCandidates("a1", "me@x.com", NOW);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("t.last_message_at >= $3");
    expect(sql).not.toContain("LIMIT $4");
    expect(params).toEqual(["a1", "me@x.com", NOW - 30 * 24 * 3_600_000]);
  });

  it("caps results after the automated/null counterparty filter, not before", async () => {
    const rows = Array.from({ length: CANDIDATE_CAP + 2 }, (_, i) =>
      row({ thread_id: `t${i}` }),
    );
    // An automated row up front must not consume a slot in the cap.
    rows[0] = row({ thread_id: "automated", counterparty_address: "noreply@github.com" });
    mockSelect.mockResolvedValue(rows);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result).toHaveLength(CANDIDATE_CAP);
    expect(result.some((c) => c.threadId === "automated")).toBe(false);
  });

  it("drops the candidate when counterparty_address is null and the fallback To header is automated", async () => {
    mockSelect.mockResolvedValue([
      row({
        thread_id: "t5",
        counterparty_address: null,
        fallback_to_addresses: "No Reply <noreply@github.com>",
      }),
    ]);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result).toHaveLength(0);
  });

  it("falls back to the parsed To header address when counterparty_address is null", async () => {
    mockSelect.mockResolvedValue([
      row({
        thread_id: "t6",
        counterparty_address: null,
        fallback_to_addresses: "Alice <alice@example.com>",
      }),
    ]);
    const result = await getLedgerCandidates("a1", "me@x.com", NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.counterpartyAddress).toBe("alice@example.com");
  });
});

describe("extractFirstAddress", () => {
  it("returns a bare address unchanged", () => {
    expect(extractFirstAddress("alice@example.com")).toBe("alice@example.com");
  });

  it("extracts the first bracketed address from a multi-recipient header", () => {
    expect(
      extractFirstAddress("Alice Smith <alice@example.com>, Bob <b@y.com>"),
    ).toBe("alice@example.com");
  });

  it("respects first-recipient ordering when the first recipient is bare and a later one is bracketed", () => {
    expect(
      extractFirstAddress("alice@example.com, Bob Jones <bob@example.com>"),
    ).toBe("alice@example.com");
  });

  it("handles a quoted display name containing a comma", () => {
    expect(extractFirstAddress('"Smith, Alice" <a@x.com>')).toBe("a@x.com");
  });

  it("returns null for null or empty input", () => {
    expect(extractFirstAddress(null)).toBeNull();
    expect(extractFirstAddress("")).toBeNull();
  });
});
