import { describe, it, expect, vi } from "vitest";
import {
  buildComposeRequest,
  parseMemoSegments,
  memoIsAcceptable,
  composeMemo,
  type ManifestEntry,
} from "./composer";

const entry = (threadId: string, summary: string, needsYou = false): ManifestEntry => ({
  threadId,
  extraction: { summary, needsYou, why: needsYou ? "reply" : null, dates: [], people: [] },
});

describe("parseMemoSegments", () => {
  it("splits text and valid links", () => {
    const { segments, totalLinks, invalidLinks } = parseMemoSegments(
      "Nothing urgent. [Sarah agreed](thread:t1) to the terms.",
      new Set(["t1"]),
    );
    expect(totalLinks).toBe(1);
    expect(invalidLinks).toBe(0);
    expect(segments).toEqual([
      { type: "text", text: "Nothing urgent. " },
      { type: "link", text: "Sarah agreed", threadId: "t1" },
      { type: "text", text: " to the terms." },
    ]);
  });

  it("renders unknown thread IDs as plain text and counts them", () => {
    const { segments, invalidLinks } = parseMemoSegments(
      "See [this](thread:bogus).",
      new Set(["t1"]),
    );
    expect(invalidLinks).toBe(1);
    expect(segments).toEqual([
      { type: "text", text: "See " },
      { type: "text", text: "this" },
      { type: "text", text: "." },
    ]);
  });

  it("handles memos with no links", () => {
    const r = parseMemoSegments("Nothing needs you today.", new Set());
    expect(r.totalLinks).toBe(0);
    expect(r.segments).toEqual([{ type: "text", text: "Nothing needs you today." }]);
  });
});

describe("memoIsAcceptable", () => {
  it("accepts 0 links, rejects >20% invalid", () => {
    expect(memoIsAcceptable(0, 0)).toBe(true);
    expect(memoIsAcceptable(5, 1)).toBe(true);   // exactly 20%
    expect(memoIsAcceptable(4, 1)).toBe(false);  // 25%
  });
});

describe("buildComposeRequest", () => {
  it("includes extraction summaries and feed mentions, never bodies", () => {
    const req = buildComposeRequest(
      [entry("t1", "Sarah agreed to the terms.", true)],
      [{ subject: "Weekly digest", fromName: "Substack", category: "junk" }],
      "Sunday, July 20",
    );
    expect(req.userContent).toContain("t1");
    expect(req.userContent).toContain("Sarah agreed");
    expect(req.userContent).toContain("Weekly digest");
    expect(req.systemPrompt).toContain("[text](thread:THREAD_ID)");
  });
});

describe("composeMemo", () => {
  it("returns memo with parsed segments for valid output", async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue("[Sarah agreed](thread:t1). Nothing else."),
      testConnection: vi.fn(),
    };
    const result = await composeMemo(provider, [entry("t1", "s")], [], "Sunday");
    expect(result).not.toBeNull();
    expect(result!.segments[0]).toEqual({ type: "link", text: "Sarah agreed", threadId: "t1" });
  });

  it("returns null when too many links are invalid", async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue("[a](thread:bad1) and [b](thread:bad2)."),
      testConnection: vi.fn(),
    };
    const result = await composeMemo(provider, [entry("t1", "s")], [], "Sunday");
    expect(result).toBeNull();
  });
});
