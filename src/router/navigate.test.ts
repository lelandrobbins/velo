import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the router module before importing navigate functions
const mockNavigate = vi.fn();
const mockState = {
  location: { pathname: "/mail/inbox", search: {} },
  matches: [] as Array<{ routeId: string; params: Record<string, string> }>,
};

vi.mock("./index", () => ({
  router: {
    navigate: (...args: unknown[]) => mockNavigate(...args),
    get state() {
      return mockState;
    },
  },
}));

import {
  navigateToLabel,
  navigateToThread,
  navigateToSettings,
  navigateBack,
  getActiveLabel,
  getSelectedThreadId,
} from "./navigate";

describe("navigate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.location = { pathname: "/mail/inbox", search: {} };
    mockState.matches = [];
  });

  describe("navigateToLabel", () => {
    it("should navigate to system labels via /mail/$label", () => {
      navigateToLabel("inbox");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "inbox" },
        search: {},
      });
    });

    it("should navigate to starred", () => {
      navigateToLabel("starred");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "starred" },
        search: {},
      });
    });

    it("should navigate to vault as a system label", () => {
      navigateToLabel("vault");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "vault" },
        search: {},
      });
    });

    it("should navigate to settings", () => {
      navigateToLabel("settings");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/settings/$tab",
        params: { tab: "general" },
      });
    });

    it("should navigate to custom labels via /label/$labelId", () => {
      navigateToLabel("Label_123");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/label/$labelId",
        params: { labelId: "Label_123" },
      });
    });

    it("should navigate to custom label with thread", () => {
      navigateToLabel("Label_123", { threadId: "t-1" });
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/label/$labelId/thread/$threadId",
        params: { labelId: "Label_123", threadId: "t-1" },
      });
    });

  });

  describe("navigateToThread", () => {
    it("should append thread to /mail/$label route", () => {
      mockState.location.pathname = "/mail/inbox";
      navigateToThread("thread-abc");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label/thread/$threadId",
        params: { label: "inbox", threadId: "thread-abc" },
        search: {},
      });
    });

    it("should append thread to /label/$labelId route", () => {
      mockState.location.pathname = "/label/Label_5";
      navigateToThread("thread-abc");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/label/$labelId/thread/$threadId",
        params: { labelId: "Label_5", threadId: "thread-abc" },
        search: {},
      });
    });

    it("should fallback to inbox when on unknown route", () => {
      mockState.location.pathname = "/settings/general";
      navigateToThread("thread-abc");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label/thread/$threadId",
        params: { label: "inbox", threadId: "thread-abc" },
      });
    });

    it("should preserve search params when navigating to thread", () => {
      mockState.location.pathname = "/mail/inbox";
      mockState.location.search = { q: "hello" };
      navigateToThread("thread-abc");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label/thread/$threadId",
        params: { label: "inbox", threadId: "thread-abc" },
        search: { q: "hello" },
      });
    });
  });

  describe("navigateToSettings", () => {
    it("should navigate to settings with default tab", () => {
      navigateToSettings();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/settings/$tab",
        params: { tab: "general" },
      });
    });

    it("should navigate to settings with specific tab", () => {
      navigateToSettings("ai");
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/settings/$tab",
        params: { tab: "ai" },
      });
    });
  });

  describe("navigateBack", () => {
    it("should go to parent /mail/$label from /mail/$label/thread/$threadId", () => {
      mockState.location.pathname = "/mail/inbox/thread/t-1";
      mockState.location.search = {};
      navigateBack();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "inbox" },
        search: {},
      });
    });

    it("should go to parent /label/$labelId from thread route", () => {
      mockState.location.pathname = "/label/Label_5/thread/t-1";
      mockState.location.search = {};
      navigateBack();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/label/$labelId",
        params: { labelId: "Label_5" },
        search: {},
      });
    });

    it("should go to inbox when not on a thread route", () => {
      mockState.location.pathname = "/attachments";
      navigateBack();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "inbox" },
      });
    });

    it("should preserve search params when navigating back", () => {
      mockState.location.pathname = "/mail/inbox/thread/t-1";
      mockState.location.search = { q: "hello" };
      navigateBack();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/mail/$label",
        params: { label: "inbox" },
        search: { q: "hello" },
      });
    });
  });

  describe("getActiveLabel", () => {
    it("should return label from mail route", () => {
      mockState.matches = [
        { routeId: "/mail/$label", params: { label: "starred" } },
      ];
      expect(getActiveLabel()).toBe("starred");
    });

    it("should return label from mail thread route", () => {
      mockState.matches = [
        { routeId: "/mail/$label/thread/$threadId", params: { label: "sent", threadId: "t-1" } },
      ];
      expect(getActiveLabel()).toBe("sent");
    });

    it("should return labelId from custom label route", () => {
      mockState.matches = [
        { routeId: "/label/$labelId", params: { labelId: "Label_42" } },
      ];
      expect(getActiveLabel()).toBe("Label_42");
    });

    it("should return 'settings' from settings route", () => {
      mockState.matches = [
        { routeId: "/settings/$tab", params: { tab: "general" } },
      ];
      expect(getActiveLabel()).toBe("settings");
    });

    it("should return 'inbox' as fallback", () => {
      mockState.matches = [];
      expect(getActiveLabel()).toBe("inbox");
    });
  });

  describe("getSelectedThreadId", () => {
    it("should return threadId from route params", () => {
      mockState.matches = [
        { routeId: "/mail/$label/thread/$threadId", params: { label: "inbox", threadId: "t-42" } },
      ];
      expect(getSelectedThreadId()).toBe("t-42");
    });

    it("should return null when no thread in route", () => {
      mockState.matches = [
        { routeId: "/mail/$label", params: { label: "inbox" } },
      ];
      expect(getSelectedThreadId()).toBeNull();
    });

    it("should return null when no matches", () => {
      mockState.matches = [];
      expect(getSelectedThreadId()).toBeNull();
    });
  });
});
