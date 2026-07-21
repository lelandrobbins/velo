import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();
vi.mock("./connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect, execute: mockExecute })),
}));

import {
  setLedgerOverride,
  getLedgerOverrides,
  clearLedgerOverride,
  getPinnedThreadIds,
} from "./ledgerOverrides";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ledgerOverrides", () => {
  it("setLedgerOverride upserts on (account, thread, kind)", async () => {
    mockExecute.mockResolvedValue(undefined);
    await setLedgerOverride("a1", "t1", "waiting", "dismissed");
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO ledger_overrides");
    expect(sql).toContain("ON CONFLICT(account_id, thread_id, kind)");
    expect(params).toEqual(expect.arrayContaining(["a1", "t1", "waiting", "dismissed", null]));
  });

  it("setLedgerOverride stores due_at for pins", async () => {
    mockExecute.mockResolvedValue(undefined);
    await setLedgerOverride("a1", "t1", "waiting", "pinned", 1234);
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual(expect.arrayContaining(["pinned", 1234]));
  });

  it("getLedgerOverrides selects by account", async () => {
    mockSelect.mockResolvedValue([]);
    await getLedgerOverrides("a1");
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM ledger_overrides");
    expect(params).toEqual(["a1"]);
  });

  it("clearLedgerOverride deletes the row", async () => {
    mockExecute.mockResolvedValue(undefined);
    await clearLedgerOverride("a1", "t1", "promise");
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM ledger_overrides");
    expect(params).toEqual(["a1", "t1", "promise"]);
  });

  it("getPinnedThreadIds returns matching set", async () => {
    mockSelect.mockResolvedValue([{ thread_id: "t2" }]);
    const result = await getPinnedThreadIds("a1", ["t1", "t2"]);
    expect(result).toEqual(new Set(["t2"]));
  });

  it("getPinnedThreadIds short-circuits on empty input", async () => {
    const result = await getPinnedThreadIds("a1", []);
    expect(result).toEqual(new Set());
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
