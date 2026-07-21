import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn(function () {
    return { messages: { create: mockCreate } };
  });
  return { default: MockAnthropic };
});

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import Anthropic from "@anthropic-ai/sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createClaudeProvider, clearClaudeProvider } from "./claudeProvider";

describe("claudeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearClaudeProvider();
  });

  it("routes requests through the Tauri HTTP plugin, not the webview fetch", () => {
    // Browser (CORS) requests are rejected for Anthropic orgs with custom
    // retention settings — the client must use the Rust-side fetch.
    createClaudeProvider("sk-test", "claude-haiku-4-5-20251001");

    expect(Anthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        dangerouslyAllowBrowser: true,
        fetch: tauriFetch,
      }),
    );
  });

  it("testConnection returns true on success and false on API error", async () => {
    const provider = createClaudeProvider("sk-test", "claude-haiku-4-5-20251001");

    mockCreate.mockResolvedValueOnce({ content: [] });
    await expect(provider.testConnection()).resolves.toBe(true);

    mockCreate.mockRejectedValueOnce(new Error("401"));
    await expect(provider.testConnection()).resolves.toBe(false);
  });
});
