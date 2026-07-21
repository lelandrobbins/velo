import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbThread } from "@/services/db/threads";

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
  setAiCache: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  getThreadsForAccount: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(),
  getActiveProvider: vi.fn(),
}));

import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getThreadsForAccount } from "@/services/db/threads";
import { isAiAvailable, getActiveProvider } from "@/services/ai/providerManager";
import { generateBrief, getCachedBrief, computeFiledToday, BRIEF_THREAD_ID, MEMO_TYPE } from "./briefManager";

const NOW_ISH = Date.now();

function row(overrides: Partial<DbThread>): DbThread {
  return {
    id: "t1", account_id: "a1", subject: "Hello", snippet: null,
    last_message_at: NOW_ISH, message_count: 1, is_read: 0, is_starred: 0,
    is_important: 0, has_attachments: 0, is_snoozed: 0, snooze_until: null,
    is_pinned: 0, is_muted: 0, from_name: "Alice", from_address: "alice@example.com",
    list_unsubscribe: null,
    ...overrides,
  };
}

const extractionJson = JSON.stringify({
  summary: "Alice asked about lunch.", needsYou: true, why: "reply", dates: [], people: ["Alice"],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateBrief", () => {
  it("returns null without calling anything when AI is unavailable", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    expect(await generateBrief("a1")).toBeNull();
    expect(vi.mocked(getThreadsForAccount)).not.toHaveBeenCalled();
  });

  it("produces a deterministic empty brief with no provider call when focus is empty", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(getThreadsForAccount).mockResolvedValue([
      row({ id: "f1", list_unsubscribe: "<u>" }), // feed only
    ]);
    const brief = await generateBrief("a1");
    expect(brief).not.toBeNull();
    expect(brief!.empty).toBe(true);
    expect(brief!.memo).toContain("Nothing needs you");
    expect(vi.mocked(getActiveProvider)).not.toHaveBeenCalled();
    expect(vi.mocked(setAiCache)).toHaveBeenCalledWith(
      "a1", BRIEF_THREAD_ID, MEMO_TYPE, expect.any(String),
    );
  });

  it("skips regeneration when manifest hash matches cached brief (not forced)", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    const focusRow = row({});
    vi.mocked(getThreadsForAccount).mockResolvedValue([focusRow]);
    // First generation to learn the hash
    vi.mocked(getAiCache).mockImplementation(async (_a, threadId, type) => {
      if (threadId === focusRow.id) return JSON.stringify({ stateKey: `${focusRow.last_message_at}:1`, extraction: JSON.parse(extractionJson) });
      if (threadId === BRIEF_THREAD_ID && type === MEMO_TYPE) return null;
      return null;
    });
    vi.mocked(getActiveProvider).mockResolvedValue({
      complete: vi.fn().mockResolvedValue(`[Alice asked about lunch](thread:${focusRow.id}).`),
      testConnection: vi.fn(),
    });
    const first = await generateBrief("a1");
    expect(first).not.toBeNull();

    // Second run: cached memo has the same manifest hash → no compose call
    const storedBrief = vi.mocked(setAiCache).mock.calls.find((c) => c[1] === BRIEF_THREAD_ID)![3];
    vi.mocked(getAiCache).mockImplementation(async (_a, threadId, type) => {
      if (threadId === focusRow.id) return JSON.stringify({ stateKey: `${focusRow.last_message_at}:1`, extraction: JSON.parse(extractionJson) });
      if (threadId === BRIEF_THREAD_ID && type === MEMO_TYPE) return storedBrief;
      return null;
    });
    const composeSpy = vi.fn();
    vi.mocked(getActiveProvider).mockResolvedValue({ complete: composeSpy, testConnection: vi.fn() });
    const second = await generateBrief("a1");
    expect(second!.memo).toBe(first!.memo);
    expect(composeSpy).not.toHaveBeenCalled();
  });

  it("regenerates despite matching hash when forced", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    const focusRow = row({});
    const cachedExtract = JSON.stringify({ stateKey: `${focusRow.last_message_at}:1`, extraction: JSON.parse(extractionJson) });
    vi.mocked(getThreadsForAccount).mockResolvedValue([focusRow]);
    const complete = vi.fn().mockResolvedValue(`[Alice](thread:${focusRow.id}) pinged you.`);
    vi.mocked(getActiveProvider).mockResolvedValue({ complete, testConnection: vi.fn() });
    vi.mocked(getAiCache).mockImplementation(async (_a, threadId) =>
      threadId === focusRow.id ? cachedExtract : null,
    );
    const brief = await generateBrief("a1", { force: true });
    expect(brief).not.toBeNull();
    expect(complete).toHaveBeenCalledTimes(1); // compose only; extraction was cached
  });
});

describe("getCachedBrief", () => {
  it("round-trips the stored brief", async () => {
    const stored = { memo: "m", segments: [], generatedAt: 1, manifestHash: "h", empty: false };
    vi.mocked(getAiCache).mockResolvedValue(JSON.stringify(stored));
    expect(await getCachedBrief("a1")).toEqual(stored);
  });

  it("returns null for missing or corrupt cache", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    expect(await getCachedBrief("a1")).toBeNull();
    vi.mocked(getAiCache).mockResolvedValue("not json");
    expect(await getCachedBrief("a1")).toBeNull();
  });
});

describe("computeFiledToday", () => {
  it("counts today's feed arrivals by category", async () => {
    vi.mocked(getThreadsForAccount).mockResolvedValue([
      row({ id: "j", list_unsubscribe: "<u>", subject: "50% off!" }),
      row({ id: "c", from_address: "calendar-notification@google.com", subject: "Invitation: standup" }),
      row({ id: "human" }),
    ]);
    expect(await computeFiledToday("a1")).toEqual({ calendar: 1, fyi: 0, junk: 1 });
  });
});
