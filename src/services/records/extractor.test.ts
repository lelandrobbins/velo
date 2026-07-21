import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "@/services/db/messages";
import type { DbRecord } from "./records";

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(),
  setAiCache: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(),
}));
vi.mock("@/services/db/attachments", () => ({
  getAttachmentsForMessage: vi.fn(() => Promise.resolve([])),
}));
vi.mock("./records", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./records")>()),
  replaceThreadRecords: vi.fn(),
  deleteRecord: vi.fn(),
}));

import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { getAttachmentsForMessage } from "@/services/db/attachments";
import { replaceThreadRecords, deleteRecord } from "./records";
import {
  validateRecordsExtraction,
  extractThreadRecords,
  suppressRecord,
  recordFingerprint,
  RECORDS_EXTRACT_TYPE,
} from "./extractor";

const candidate = {
  threadId: "t1",
  subject: "Your receipt from Fully",
  lastMessageAt: 5000,
  messageCount: 1,
};

const goodRecord = {
  kind: "purchase",
  vendor: "Fully",
  title: "Standing desk order",
  recordDate: "2026-06-14",
  amount: "$729.00",
  referenceNumbers: [{ label: "Order #", value: "F-118272" }],
  details: "Jarvis desk",
  sourceMessageDate: 5000,
};
const goodJson = JSON.stringify({ records: [goodRecord] });

function msg(overrides: Partial<DbMessage>): DbMessage {
  return {
    id: "m1", account_id: "a1", thread_id: "t1",
    from_address: "noreply@fully.com", from_name: "Fully",
    to_addresses: "me@x.com", cc_addresses: null, bcc_addresses: null,
    reply_to: null, subject: "Your receipt from Fully", snippet: "s",
    date: 5000, is_read: 1, is_starred: 0, body_html: null,
    body_text: "Order F-118272 total $729.00", body_cached: 1, raw_size: null,
    internal_date: null, list_unsubscribe: null, list_unsubscribe_post: null,
    auth_results: null, message_id_header: null, references_header: null,
    in_reply_to_header: null, imap_uid: null, imap_folder: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAttachmentsForMessage).mockResolvedValue([]);
});

describe("recordFingerprint", () => {
  it("combines kind and source date", () => {
    expect(recordFingerprint("purchase", 5000)).toBe("purchase:5000");
  });
});

describe("validateRecordsExtraction", () => {
  it("accepts a valid records array and normalizes optionals", () => {
    const v = validateRecordsExtraction({
      records: [{ kind: "travel", title: "Flight to Denver", sourceMessageDate: 1 }],
    });
    expect(v).toEqual([
      {
        kind: "travel", vendor: null, title: "Flight to Denver", recordDate: null,
        amount: null, referenceNumbers: [], details: null, sourceMessageDate: 1,
      },
    ]);
  });

  it("accepts an empty records array", () => {
    expect(validateRecordsExtraction({ records: [] })).toEqual([]);
  });

  it("drops entries with bad kind, missing title, or missing source date", () => {
    const v = validateRecordsExtraction({
      records: [
        { kind: "junkfood", title: "x", sourceMessageDate: 1 },
        { kind: "purchase", sourceMessageDate: 1 },
        { kind: "purchase", title: "x" },
        goodRecord,
      ],
    });
    expect(v).toHaveLength(1);
    expect(v![0]!.title).toBe("Standing desk order");
  });

  it("rejects non-objects and missing records array", () => {
    expect(validateRecordsExtraction(null)).toBeNull();
    expect(validateRecordsExtraction({ notRecords: [] })).toBeNull();
  });
});

describe("extractThreadRecords", () => {
  it("returns cached records when the stateKey matches, without provider calls", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:1", records: [goodRecord], suppressed: [] }),
    );
    const provider = { complete: vi.fn() };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toHaveLength(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(vi.mocked(replaceThreadRecords)).not.toHaveBeenCalled();
  });

  it("extracts, caches, and materializes on a stale stateKey", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:0", records: [], suppressed: ["travel:1"] }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toHaveLength(1);
    // suppressed list carried forward into the new cache row
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.stateKey).toBe("5000:1");
    expect(cached.suppressed).toEqual(["travel:1"]);
    // materialized with parsed recordDate epoch
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written).toHaveLength(1);
    expect(written[0]!.recordDate).toBe(Date.parse("2026-06-14"));
  });

  it("skips materializing suppressed fingerprints", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "old:0", records: [], suppressed: ["purchase:5000"] }),
    );
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    await extractThreadRecords(provider, "a1", candidate);
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written).toEqual([]);
  });

  it("coerces a hallucinated sourceMessageDate to lastMessageAt", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const bad = JSON.stringify({ records: [{ ...goodRecord, sourceMessageDate: 999999 }] });
    const provider = { complete: vi.fn(() => Promise.resolve(bad)) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records[0]!.sourceMessageDate).toBe(5000);
  });

  it("retries once on invalid JSON and gives up without caching", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve("not json")) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setAiCache)).not.toHaveBeenCalled();
    expect(vi.mocked(replaceThreadRecords)).not.toHaveBeenCalled();
  });

  it("caches an empty extraction so duds are never re-paid for", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    const provider = { complete: vi.fn(() => Promise.resolve('{"records": []}')) };
    const result = await extractThreadRecords(provider, "a1", candidate);
    expect(result!.records).toEqual([]);
    expect(vi.mocked(setAiCache)).toHaveBeenCalledWith(
      "a1", "t1", RECORDS_EXTRACT_TYPE, expect.stringContaining('"records":[]'),
    );
  });

  it("includes attachment filenames in the extraction request", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(getMessagesForThread).mockResolvedValue([msg({})]);
    vi.mocked(getAttachmentsForMessage).mockResolvedValue([
      { id: "at1", message_id: "m1", account_id: "a1", filename: "invoice.pdf",
        mime_type: "application/pdf", size: 100, gmail_attachment_id: null,
        content_id: null, is_inline: 0, local_path: null },
    ]);
    const provider = { complete: vi.fn(() => Promise.resolve(goodJson)) };
    await extractThreadRecords(provider, "a1", candidate);
    const req = provider.complete.mock.calls[0]![0] as { userContent: string };
    expect(req.userContent).toContain("invoice.pdf");
    // and materialized rows carry the source message's attachment names
    const [, , written] = vi.mocked(replaceThreadRecords).mock.calls[0]!;
    expect(written[0]!.attachmentNames).toEqual(["invoice.pdf"]);
  });
});

describe("suppressRecord", () => {
  const row: DbRecord = {
    id: "r1", account_id: "a1", thread_id: "t1", kind: "purchase",
    vendor: "Fully", title: "Standing desk order", record_date: null,
    amount: null, reference_numbers: "[]", details: null,
    attachment_names: "[]", source_message_date: 5000, created_at: 1,
  };

  it("appends the fingerprint to the cache row and deletes the record", async () => {
    vi.mocked(getAiCache).mockResolvedValue(
      JSON.stringify({ stateKey: "5000:1", records: [goodRecord], suppressed: [] }),
    );
    await suppressRecord("a1", row);
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.suppressed).toEqual(["purchase:5000"]);
    expect(cached.stateKey).toBe("5000:1");
    expect(vi.mocked(deleteRecord)).toHaveBeenCalledWith("a1", "r1");
  });

  it("records suppression even when no cache row exists", async () => {
    vi.mocked(getAiCache).mockResolvedValue(null);
    await suppressRecord("a1", row);
    const cached = JSON.parse(vi.mocked(setAiCache).mock.calls[0]![3] as string);
    expect(cached.suppressed).toEqual(["purchase:5000"]);
    expect(vi.mocked(deleteRecord)).toHaveBeenCalledWith("a1", "r1");
  });
});
