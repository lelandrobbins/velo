import { describe, it, expect, vi } from "vitest";
import {
  buildComposeRequest,
  parseMemoSegments,
  parseMemoBlocks,
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
      [],
    );
    expect(req.userContent).toContain("t1");
    expect(req.userContent).toContain("Sarah agreed");
    expect(req.userContent).toContain("Weekly digest");
    expect(req.systemPrompt).toContain("[text](thread:THREAD_ID)");
  });
});

describe("obligations in compose input", () => {
  it("includes obligation lines and validates their thread links", async () => {
    const req = buildComposeRequest([entry("t1", "s")], [], "Sunday", [
      { threadId: "ob1", line: "waiting on Alex for 6 days", hashKey: "oblig:waiting:ob1:6:" },
    ]);
    expect(req.userContent).toContain("Obligations (id :: fact):");
    expect(req.userContent).toContain("- id=ob1 :: waiting on Alex for 6 days");
    expect(req.systemPrompt).toContain("Obligations may be woven in");

    const provider = {
      complete: vi.fn().mockResolvedValue("[Still waiting on Alex](thread:ob1)."),
      testConnection: vi.fn(),
    };
    const result = await composeMemo(provider, [entry("t1", "s")], [], "Sunday", [
      { threadId: "ob1", line: "waiting on Alex for 6 days", hashKey: "k" },
    ]);
    expect(result).not.toBeNull();
    expect(result!.blocks[0]).toMatchObject({
      type: "paragraph",
      segments: [expect.objectContaining({ type: "link", threadId: "ob1" }), expect.anything()],
    });
  });
});

describe("parseMemoSegments — inline bold", () => {
  it("splits **bold** runs into bold segments", () => {
    const { segments } = parseMemoSegments("Meet **Sarah** at noon.", new Set());
    expect(segments).toEqual([
      { type: "text", text: "Meet " },
      { type: "bold", text: "Sarah" },
      { type: "text", text: " at noon." },
    ]);
  });

  it("keeps bold parsing out of link text", () => {
    const { segments } = parseMemoSegments("See [the **plan**](thread:t1).", new Set(["t1"]));
    expect(segments).toEqual([
      { type: "text", text: "See " },
      { type: "link", text: "the **plan**", threadId: "t1" },
      { type: "text", text: "." },
    ]);
  });
});

describe("parseMemoBlocks", () => {
  it("splits paragraphs on blank lines and joins wrapped lines", () => {
    const { blocks } = parseMemoBlocks("First paragraph\ncontinues here.\n\nSecond paragraph.", new Set());
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      segments: [{ type: "text", text: "First paragraph continues here." }],
    });
  });

  it("groups consecutive bullets into one list block", () => {
    const memo = "Today:\n- [Reply to Sarah](thread:t1)\n- Review the doc\n\nThat is all.";
    const { blocks, totalLinks, invalidLinks } = parseMemoBlocks(memo, new Set(["t1"]));
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({
      type: "list",
      items: [
        [{ type: "link", text: "Reply to Sarah", threadId: "t1" }],
        [{ type: "text", text: "Review the doc" }],
      ],
    });
    expect(totalLinks).toBe(1);
    expect(invalidLinks).toBe(0);
  });

  it("renders heading lines as bold paragraphs", () => {
    const { blocks } = parseMemoBlocks("## Coming up\nCall at noon.", new Set());
    expect(blocks[0]).toEqual({
      type: "paragraph",
      segments: [{ type: "bold", text: "Coming up" }],
    });
  });

  it("counts invalid links across all blocks", () => {
    const memo = "[a](thread:bad)\n\n- [b](thread:t1)\n- [c](thread:bad2)";
    const { totalLinks, invalidLinks } = parseMemoBlocks(memo, new Set(["t1"]));
    expect(totalLinks).toBe(3);
    expect(invalidLinks).toBe(2);
  });
});

describe("composeMemo", () => {
  it("returns memo with parsed blocks for valid output", async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue("[Sarah agreed](thread:t1). Nothing else."),
      testConnection: vi.fn(),
    };
    const result = await composeMemo(provider, [entry("t1", "s")], [], "Sunday", []);
    expect(result).not.toBeNull();
    expect(result!.blocks[0]).toEqual({
      type: "paragraph",
      segments: [
        { type: "link", text: "Sarah agreed", threadId: "t1" },
        { type: "text", text: ". Nothing else." },
      ],
    });
  });

  it("returns null when too many links are invalid", async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue("[a](thread:bad1) and [b](thread:bad2)."),
      testConnection: vi.fn(),
    };
    const result = await composeMemo(provider, [entry("t1", "s")], [], "Sunday", []);
    expect(result).toBeNull();
  });
});
