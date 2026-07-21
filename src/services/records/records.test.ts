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
  countThreadRecords,
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
  it("runs delete-then-insert as sequential autocommit statements (no BEGIN)", async () => {
    await replaceThreadRecords("a1", "t1", [fields]);
    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain("DELETE FROM records_fts");
    expect(sqls[1]).toContain("DELETE FROM records");
    expect(sqls[2]).toContain("INSERT INTO records");
    expect(sqls[3]).toContain("INSERT INTO records_fts");
    // JS-side BEGIN/COMMIT is unsound on tauri-plugin-sql's pooled
    // connections — statements can land on different connections.
    expect(sqls).not.toContain("BEGIN TRANSACTION");
    expect(sqls).not.toContain("COMMIT");
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
    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls).toEqual([
      expect.stringContaining("DELETE FROM records_fts"),
      expect.stringContaining("DELETE FROM records"),
    ]);
  });

  it("propagates a failing insert so the caller can skip its cache write and retry", async () => {
    mockExecute.mockImplementation((sql: string) => {
      if (sql.startsWith("INSERT INTO records (")) {
        return Promise.reject(new Error("insert failed"));
      }
      return Promise.resolve(undefined);
    });

    await expect(replaceThreadRecords("a1", "t1", [fields])).rejects.toThrow("insert failed");
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

describe("countThreadRecords", () => {
  it("counts a single thread's rows", async () => {
    mockSelect.mockResolvedValue([{ count: 2 }]);
    expect(await countThreadRecords("a1", "t1")).toBe(2);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("thread_id = $2");
    expect(params).toEqual(["a1", "t1"]);
    mockSelect.mockResolvedValue([]);
    expect(await countThreadRecords("a1", "t1")).toBe(0);
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
