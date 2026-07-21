import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect })),
}));

import { getRecordCandidates, matchesRecordCues } from "./candidates";

const FLOOR = 1_790_000_000_000;

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

describe("getRecordCandidates", () => {
  it("keeps feed-classified threads with record cues", async () => {
    mockSelect.mockResolvedValue([row({})]);
    const result = await getRecordCandidates("a1", FLOOR);
    expect(result).toEqual([
      { threadId: "t1", subject: "Your receipt from Fully", lastMessageAt: FLOOR + 1000, messageCount: 1 },
    ]);
  });

  it("drops signal-classified (human) threads even with cues", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t2", from_address: "alice@example.com" }),
    ]);
    expect(await getRecordCandidates("a1", FLOOR)).toEqual([]);
  });

  it("drops feed threads without record cues", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t3", subject: "New features this week", list_unsubscribe: "<mailto:u@x>" }),
    ]);
    expect(await getRecordCandidates("a1", FLOOR)).toEqual([]);
  });

  it("keeps List-Unsubscribe threads with cues from non-automated addresses", async () => {
    mockSelect.mockResolvedValue([
      row({ thread_id: "t4", from_address: "hello@shop.com", list_unsubscribe: "<mailto:u@x>" }),
    ]);
    expect((await getRecordCandidates("a1", FLOOR)).map((c) => c.threadId)).toEqual(["t4"]);
  });

  it("passes floor and account into the query and excludes trash/spam/draft in SQL", async () => {
    mockSelect.mockResolvedValue([]);
    await getRecordCandidates("a1", FLOOR);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("last_message_at >= $2");
    expect(sql).toContain("'TRASH', 'SPAM', 'DRAFT'");
    expect(sql).toContain("JOIN messages");
    expect(params).toEqual(["a1", FLOOR]);
  });

  it("defaults null last_message_at to 0", async () => {
    mockSelect.mockResolvedValue([row({ last_message_at: null })]);
    const result = await getRecordCandidates("a1", FLOOR);
    expect(result[0]!.lastMessageAt).toBe(0);
  });
});
