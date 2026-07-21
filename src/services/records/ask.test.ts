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
