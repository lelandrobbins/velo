import { describe, it, expect, vi, beforeEach } from "vitest";

const mockComplete = vi.fn();
vi.mock("@/services/ai/providerManager", () => ({
  getActiveProvider: vi.fn(() => Promise.resolve({ complete: mockComplete, testConnection: vi.fn() })),
}));
const mockOpenComposer = vi.fn();
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => ({ openComposer: mockOpenComposer }) },
}));

import { draftNudge } from "./nudge";

const entry = {
  threadId: "t1", kind: "waiting" as const, subject: "Venue",
  counterparty: "Alice Chen", detail: "asked to confirm",
  ageDays: 6, sinceAt: 1, dueAt: null, pinned: false,
};

beforeEach(() => vi.clearAllMocks());

describe("draftNudge", () => {
  it("opens the composer as a reply with the drafted body", async () => {
    mockComplete.mockResolvedValue("Hi Alice — circling back on the venue.");
    await draftNudge(entry);
    expect(mockOpenComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "reply",
        threadId: "t1",
        subject: "Re: Venue",
        bodyHtml: expect.stringContaining("circling back"),
      }),
    );
  });

  it("opens an empty composer when the provider fails", async () => {
    mockComplete.mockRejectedValue(new Error("401"));
    await draftNudge(entry);
    expect(mockOpenComposer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "reply", threadId: "t1", bodyHtml: "" }),
    );
  });

  it("escapes HTML-significant characters in the drafted body", async () => {
    mockComplete.mockResolvedValue("Cost is <$500, ok?");
    await draftNudge(entry);
    const call = mockOpenComposer.mock.calls[0]![0];
    expect(call.bodyHtml).toContain("&lt;$500");
    expect(call.bodyHtml).not.toContain("<$500");
  });
});
