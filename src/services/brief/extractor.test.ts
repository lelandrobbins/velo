import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "@/services/db/messages";
import type { DbThread } from "@/services/db/threads";

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
  setAiCache: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(),
}));

import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { truncateThreadBodies, extractThread, EXTRACT_TYPE } from "./extractor";

function msg(overrides: Partial<DbMessage>): DbMessage {
  return {
    id: "m1", account_id: "a1", thread_id: "t1",
    from_address: "alice@example.com", from_name: "Alice",
    to_addresses: null, cc_addresses: null, bcc_addresses: null, reply_to: null,
    subject: "Hi", snippet: "snippet", date: 1000, is_read: 1, is_starred: 0,
    body_html: null, body_text: "hello", body_cached: 1, raw_size: null,
    internal_date: null, list_unsubscribe: null, list_unsubscribe_post: null,
    auth_results: null, message_id_header: null, references_header: null,
    in_reply_to_header: null, imap_uid: null, imap_folder: null,
    ...overrides,
  };
}

const thread: DbThread = {
  id: "t1", account_id: "a1", subject: "Contract", snippet: null,
  last_message_at: 5000, message_count: 2, is_read: 0, is_starred: 0,
  is_important: 0, has_attachments: 0, is_snoozed: 0, snooze_until: null,
  is_pinned: 0, is_muted: 0, from_name: "Alice", from_address: "alice@example.com",
  list_unsubscribe: null,
};

const goodJson = JSON.stringify({
  summary: "Sarah agreed.", needsYou: true, why: "pick a date", dates: [], people: ["Sarah"],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("truncateThreadBodies", () => {
  it("truncates each message and the thread total, newest win", () => {
    const messages = [
      msg({ id: "m1", date: 1, body_text: "a".repeat(6000) }),
      msg({ id: "m2", date: 2, body_text: "b".repeat(6000) }),
      msg({ id: "m3", date: 3, body_text: "c".repeat(6000) }),
    ];
    const parts = truncateThreadBodies(messages);
    // 3 × 2000-char messages = 6000 < 8000 total: all survive, per-message capped
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.body.length).toBeLessThanOrEqual(2000);
    // oldest-first order preserved
    expect(parts[0]!.body[0]).toBe("a");
  });

  it("drops oldest messages when total budget is exceeded", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      msg({ id: `m${i}`, date: i, body_text: "x".repeat(2000) }),
    );
    const parts = truncateThreadBodies(messages);
    expect(parts).toHaveLength(4); // 4 × 2000 = 8000 budget; the 2 oldest dropped
    expect(parts[0]!.date).toBe(2);
  });

  it("falls back to snippet when body_text is null", () => {
    const parts = truncateThreadBodies([msg({ body_text: null, snippet: "snip" })]);
    expect(parts[0]!.body).toBe("snip");
  });
});

describe("extractThread", () => {
  it("returns cached extraction when stateKey matches, without calling the provider", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:2", extraction: JSON.parse(goodJson) }),
    );
    const provider = { complete: vi.fn(), testConnection: vi.fn() };
    const result = await extractThread(provider, "a1", thread);
    expect(result!.summary).toBe("Sarah agreed.");
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("re-extracts and caches when stateKey differs", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:1", extraction: JSON.parse(goodJson) }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn().mockResolvedValue(goodJson), testConnection: vi.fn() };
    const result = await extractThread(provider, "a1", thread);
    expect(result!.needsYou).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setAiCache)).toHaveBeenCalledWith(
      "a1", "t1", EXTRACT_TYPE,
      expect.stringContaining('"stateKey":"5000:2"'),
    );
  });

  it("retries once with a JSON nudge on unparseable output", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = {
      complete: vi.fn().mockResolvedValueOnce("Sure! Here's my analysis...").mockResolvedValueOnce(goodJson),
      testConnection: vi.fn(),
    };
    const result = await extractThread(provider, "a1", thread);
    expect(result).not.toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("returns null (and does not cache) when both attempts fail", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn().mockResolvedValue("nope"), testConnection: vi.fn() };
    const result = await extractThread(provider, "a1", thread);
    expect(result).toBeNull();
    expect(vi.mocked(setAiCache)).not.toHaveBeenCalled();
  });
});
