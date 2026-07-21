import { describe, it, expect } from "vitest";
import { parseModelJson, validateExtraction } from "./briefSchema";

describe("parseModelJson", () => {
  it("parses clean JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts the first JSON object embedded in prose", () => {
    expect(parseModelJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it("returns null for garbage", () => {
    expect(parseModelJson("I cannot do that")).toBeNull();
    expect(parseModelJson("")).toBeNull();
  });
});

describe("validateExtraction", () => {
  it("accepts a full extraction", () => {
    const v = validateExtraction({
      summary: "Sarah agreed to the terms.",
      needsYou: true,
      why: "she asked about timing",
      dates: [{ iso: "2026-07-25", what: "deadline" }],
      people: ["Sarah"],
    });
    expect(v).not.toBeNull();
    expect(v!.needsYou).toBe(true);
    expect(v!.dates).toHaveLength(1);
  });

  it("normalizes missing optional fields", () => {
    const v = validateExtraction({ summary: "Hi", needsYou: false });
    expect(v).toEqual({ summary: "Hi", needsYou: false, why: null, dates: [], people: [] });
  });

  it("rejects wrong shapes", () => {
    expect(validateExtraction(null)).toBeNull();
    expect(validateExtraction("text")).toBeNull();
    expect(validateExtraction({ needsYou: true })).toBeNull(); // no summary
    expect(validateExtraction({ summary: 42, needsYou: true })).toBeNull();
  });

  it("drops malformed dates/people entries instead of rejecting", () => {
    const v = validateExtraction({
      summary: "s",
      needsYou: false,
      dates: [{ iso: "2026-01-01", what: "ok" }, { bad: true }, "x"],
      people: ["Ann", 3],
    });
    expect(v!.dates).toEqual([{ iso: "2026-01-01", what: "ok" }]);
    expect(v!.people).toEqual(["Ann"]);
  });
});
