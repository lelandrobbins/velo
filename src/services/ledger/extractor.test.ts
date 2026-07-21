import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "@/services/db/messages";

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
  setAiCache: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(),
}));

import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import {
  validateObligationExtraction,
  extractThreadObligations,
  LEDGER_EXTRACT_TYPE,
} from "./extractor";

const candidate = { threadId: "t1", subject: "Venue", lastMessageAt: 5000, messageCount: 2 };

const goodJson = JSON.stringify({
  expectsReply: true,
  why: "you asked Alex to confirm",
  counterparty: "Alex Chen",
  promises: [{ what: "send the deck", due: "2026-07-25" }],
});

function msg(overrides: Partial<DbMessage>): DbMessage {
  return {
    id: "m1", account_id: "a1", thread_id: "t1",
    from_address: "me@x.com", from_name: "Me",
    to_addresses: "alice@example.com", cc_addresses: null, bcc_addresses: null,
    reply_to: null, subject: "Venue", snippet: "s", date: 1000, is_read: 1,
    is_starred: 0, body_html: null, body_text: "Can you confirm the venue?",
    body_cached: 1, raw_size: null, internal_date: null, list_unsubscribe: null,
    list_unsubscribe_post: null, auth_results: null, message_id_header: null,
    references_header: null, in_reply_to_header: null, imap_uid: null, imap_folder: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("validateObligationExtraction", () => {
  it("accepts a full extraction and normalizes optionals", () => {
    const v = validateObligationExtraction({ expectsReply: false });
    expect(v).toEqual({ expectsReply: false, why: null, counterparty: null, promises: [] });
  });

  it("drops malformed promise entries and null-due is preserved", () => {
    const v = validateObligationExtraction({
      expectsReply: true,
      promises: [{ what: "deck", due: null }, { bad: 1 }, "x"],
    });
    expect(v!.promises).toEqual([{ what: "deck", due: null }]);
  });

  it("rejects wrong shapes", () => {
    expect(validateObligationExtraction(null)).toBeNull();
    expect(validateObligationExtraction({ why: "no expectsReply" })).toBeNull();
  });
});

describe("extractThreadObligations", () => {
  it("returns cached extraction on stateKey match without provider call", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:2", extraction: JSON.parse(goodJson) }),
    );
    const provider = { complete: vi.fn(), testConnection: vi.fn() };
    const result = await extractThreadObligations(provider, "a1", candidate);
    expect(result!.counterparty).toBe("Alex Chen");
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("extracts, validates, and caches on stateKey mismatch", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:1", extraction: JSON.parse(goodJson) }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn().mockResolvedValue(goodJson), testConnection: vi.fn() };
    const result = await extractThreadObligations(provider, "a1", candidate);
    expect(result!.expectsReply).toBe(true);
    expect(vi.mocked(setAiCache)).toHaveBeenCalledWith(
      "a1", "t1", LEDGER_EXTRACT_TYPE,
      expect.stringContaining('"stateKey":"5000:2"'),
    );
  });

  it("retries once with a JSON nudge, and does not cache double failures", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = {
      complete: vi.fn().mockResolvedValueOnce("nope").mockResolvedValueOnce("still nope"),
      testConnection: vi.fn(),
    };
    const result = await extractThreadObligations(provider, "a1", candidate);
    expect(result).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setAiCache)).not.toHaveBeenCalled();
  });
});
