import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));

import { getRecordCandidates, matchesRecordCues, extractAddresses } from "./candidates";

const FLOOR = 1_790_000_000_000;
const OWNER = "me@x.com";

/** First select = owner-sent recipient headers; second = candidate threads. */
function mockQueries(sentRows: { to_addresses: string | null; cc_addresses: string | null }[], threadRows: unknown[]) {
  mockSelect.mockImplementation((sql: string) =>
    Promise.resolve((sql as string).includes("to_addresses") ? sentRows : threadRows),
  );
}

function row(overrides: Record<string, unknown>) {
  return {
    thread_id: "t1",
    subject: "Your receipt from Fully",
    last_message_at: FLOOR + 1000,
    message_count: 1,
    from_address: "noreply@fully.com",
    list_unsubscribe: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("matchesRecordCues", () => {
  it("matches record cues case-insensitively", () => {
    expect(matchesRecordCues("Your RECEIPT from Fully")).toBe(true);
    expect(matchesRecordCues("Itinerary for your trip")).toBe(true);
    expect(matchesRecordCues("Appointment confirmed")).toBe(true);
  });

  it("rejects non-record subjects and null", () => {
    expect(matchesRecordCues("Weekly digest: new posts")).toBe(false);
    expect(matchesRecordCues(null)).toBe(false);
  });
});

describe("extractAddresses", () => {
  it("pulls every address out of raw recipient headers", () => {
    expect(extractAddresses('"Chen, Alice" <alice@example.com>, bob@y.com')).toEqual([
      "alice@example.com",
      "bob@y.com",
    ]);
    expect(extractAddresses(null)).toEqual([]);
  });
});

describe("getRecordCandidates", () => {
  it("keeps feed-classified threads with record cues", async () => {
    mockQueries([], [row({})]);
    const result = await getRecordCandidates("a1", OWNER, FLOOR);
    expect(result).toEqual([
      { threadId: "t1", subject: "Your receipt from Fully", lastMessageAt: FLOOR + 1000, messageCount: 1 },
    ]);
  });

  it("keeps cue threads from senders the owner never wrote to, even when signal-classified", async () => {
    // auto-confirm@amazon.com: no List-Unsubscribe, no automated prefix — the
    // noise classifier calls it signal, but it's transactional mail
    mockQueries([], [row({ thread_id: "t2", from_address: "auto-confirm@amazon.com" })]);
    expect((await getRecordCandidates("a1", OWNER, FLOOR)).map((c) => c.threadId)).toEqual(["t2"]);
  });

  it("drops cue threads from senders the owner has emailed (human correspondence)", async () => {
    mockQueries(
      [{ to_addresses: '"Accountant" <alice@example.com>', cc_addresses: null }],
      [row({ thread_id: "t2", from_address: "alice@example.com", subject: "Invoice for May" })],
    );
    expect(await getRecordCandidates("a1", OWNER, FLOOR)).toEqual([]);
  });

  it("matches emailed senders case-insensitively and via cc", async () => {
    mockQueries(
      [{ to_addresses: null, cc_addresses: "Bob <BOB@example.com>" }],
      [row({ thread_id: "t2", from_address: "bob@example.com" })],
    );
    expect(await getRecordCandidates("a1", OWNER, FLOOR)).toEqual([]);
  });

  it("keeps feed-classified cue threads even from emailed senders", async () => {
    mockQueries(
      [{ to_addresses: "noreply@fully.com", cc_addresses: null }],
      [row({})],
    );
    expect((await getRecordCandidates("a1", OWNER, FLOOR)).map((c) => c.threadId)).toEqual(["t1"]);
  });

  it("drops threads without record cues regardless of sender", async () => {
    mockQueries([], [
      row({ thread_id: "t3", subject: "New features this week", list_unsubscribe: "<mailto:u@x>" }),
      row({ thread_id: "t4", subject: "Hey, quick question", from_address: "stranger@example.com" }),
    ]);
    expect(await getRecordCandidates("a1", OWNER, FLOOR)).toEqual([]);
  });

  it("passes floor, account, and owner into the queries and excludes trash/spam/draft in SQL", async () => {
    mockQueries([], []);
    await getRecordCandidates("a1", OWNER, FLOOR);
    const sentCall = mockSelect.mock.calls.find(([sql]) => (sql as string).includes("to_addresses"))!;
    expect(sentCall[1]).toEqual(["a1", OWNER]);
    const threadCall = mockSelect.mock.calls.find(([sql]) => (sql as string).includes("FROM threads"))!;
    expect(threadCall[0]).toContain("last_message_at >= $2");
    expect(threadCall[0]).toContain("'TRASH', 'SPAM', 'DRAFT'");
    expect(threadCall[0]).toContain("JOIN messages");
    expect(threadCall[1]).toEqual(["a1", FLOOR]);
  });

  it("defaults null last_message_at to 0", async () => {
    mockQueries([], [row({ last_message_at: null })]);
    const result = await getRecordCandidates("a1", OWNER, FLOOR);
    expect(result[0]!.lastMessageAt).toBe(0);
  });
});
