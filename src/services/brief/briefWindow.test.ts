import { describe, it, expect } from "vitest";
import {
  selectFocusWindow,
  selectFeedItems,
  threadStateKey,
  manifestHash,
  FOCUS_WINDOW_CAP,
} from "./briefWindow";
import type { DbThread } from "@/services/db/threads";

const NOW = 1_800_000_000_000; // fixed "now" in ms
const HOUR = 3_600_000;

function row(overrides: Partial<DbThread>): DbThread {
  return {
    id: "t1",
    account_id: "a1",
    subject: "Lunch?",
    snippet: null,
    last_message_at: NOW - HOUR,
    message_count: 1,
    is_read: 0,
    is_starred: 0,
    is_important: 0,
    has_attachments: 0,
    is_snoozed: 0,
    snooze_until: null,
    is_pinned: 0,
    is_muted: 0,
    from_name: "Alice",
    from_address: "alice@example.com",
    list_unsubscribe: null,
    ...overrides,
  };
}

describe("selectFocusWindow", () => {
  it("keeps unread signal threads regardless of age", () => {
    const old = row({ id: "old", is_read: 0, last_message_at: NOW - 100 * HOUR });
    expect(selectFocusWindow([old], NOW).map((t) => t.id)).toEqual(["old"]);
  });

  it("keeps read signal threads only within 48h", () => {
    const recent = row({ id: "recent", is_read: 1, last_message_at: NOW - 47 * HOUR });
    const stale = row({ id: "stale", is_read: 1, last_message_at: NOW - 49 * HOUR });
    expect(selectFocusWindow([recent, stale], NOW).map((t) => t.id)).toEqual(["recent"]);
  });

  it("excludes feed-classified threads", () => {
    const feed = row({ id: "feed", list_unsubscribe: "<https://u>" });
    expect(selectFocusWindow([feed], NOW)).toEqual([]);
  });

  it("caps at FOCUS_WINDOW_CAP, newest first", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ id: `t${i}`, last_message_at: NOW - i * HOUR }),
    );
    const win = selectFocusWindow(rows, NOW);
    expect(win).toHaveLength(FOCUS_WINDOW_CAP);
    expect(win[0]!.id).toBe("t0");
  });
});

describe("selectFeedItems", () => {
  it("keeps only feed threads from the last 24h, cap 20", () => {
    const rows = [
      row({ id: "f-new", list_unsubscribe: "<u>", last_message_at: NOW - HOUR }),
      row({ id: "f-old", list_unsubscribe: "<u>", last_message_at: NOW - 30 * HOUR }),
      row({ id: "human", last_message_at: NOW - HOUR }),
    ];
    expect(selectFeedItems(rows, NOW).map((t) => t.id)).toEqual(["f-new"]);
  });
});

describe("threadStateKey / manifestHash", () => {
  it("stateKey changes when the thread changes", () => {
    expect(threadStateKey({ last_message_at: 5, message_count: 2 })).toBe("5:2");
    expect(threadStateKey({ last_message_at: null, message_count: 2 })).toBe("0:2");
  });

  it("manifestHash is order-independent and content-sensitive", () => {
    const a = [{ threadId: "x", stateKey: "1:1" }, { threadId: "y", stateKey: "2:1" }];
    const b = [...a].reverse();
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(manifestHash(a)).not.toBe(manifestHash([{ threadId: "x", stateKey: "1:2" }]));
  });
});
