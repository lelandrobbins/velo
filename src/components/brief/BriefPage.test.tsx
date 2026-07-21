import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BriefPage } from "./BriefPage";
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import type { StoredBrief } from "@/services/brief/briefManager";
import type { DbThread } from "@/services/db/threads";

const mockBrief: StoredBrief = {
  memo: "Reply to Alice about the launch.",
  blocks: [
    {
      type: "paragraph",
      segments: [
        { type: "link", text: "Reply to Alice", threadId: "thread-1" },
        { type: "text", text: " about the launch." },
      ],
    },
  ],
  generatedAt: Date.now(),
  manifestHash: "hash-1",
  empty: false,
};

const mockDbThread: DbThread = {
  id: "thread-1",
  account_id: "acc-1",
  subject: "Launch plan",
  snippet: "Sounds good, let's ship it",
  last_message_at: 1700000000000,
  message_count: 3,
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
};

vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/services/brief/briefManager", () => ({
  getCachedBrief: vi.fn(() => Promise.resolve(mockBrief)),
  generateBrief: vi.fn(() => Promise.resolve(null)),
  computeFiledToday: vi.fn(() => Promise.resolve({ calendar: 0, fyi: 0, junk: 0 })),
}));

vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(() => Promise.resolve(mockDbThread)),
  getThreadLabelIds: vi.fn(() => Promise.resolve(["INBOX"])),
}));

vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  navigateToLabel: vi.fn(),
  navigateToSettings: vi.fn(),
}));

vi.mock("@/hooks/useRouteNavigation", () => ({
  useSelectedThreadId: () => null,
}));

describe("BriefPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState({
      threads: [],
      threadMap: new Map(),
      selectedThreadIds: new Set(),
    });
    useAccountStore.setState({
      accounts: [{ id: "acc-1", email: "me@example.com", displayName: null, avatarUrl: null, isActive: true }],
      activeAccountId: "acc-1",
    });
  });

  it("hydrates the clicked memo thread into threadStore's threadMap", async () => {
    render(<BriefPage />);

    const link = await screen.findByText("Reply to Alice");

    expect(useThreadStore.getState().threadMap.has("thread-1")).toBe(false);

    fireEvent.click(link);

    await waitFor(() => {
      expect(useThreadStore.getState().threadMap.has("thread-1")).toBe(true);
    });

    const hydrated = useThreadStore.getState().threadMap.get("thread-1");
    expect(hydrated).toMatchObject({
      id: "thread-1",
      accountId: "acc-1",
      subject: "Launch plan",
      fromName: "Alice",
    });
  });
});
