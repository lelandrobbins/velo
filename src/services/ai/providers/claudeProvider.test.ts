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

  it("routes requests through the Tauri HTTP plugin without browser markers", () => {
    // Browser requests are rejected for Anthropic orgs with custom retention
    // settings. The client must use the Rust-side fetch AND suppress the
    // browser opt-in header the SDK adds for dangerouslyAllowBrowser — the
    // header alone makes the API apply the browser-CORS policy.
    createClaudeProvider("sk-test", "claude-haiku-4-5-20251001");

    expect(Anthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        dangerouslyAllowBrowser: true,
        fetch: expect.any(Function),
        defaultHeaders: expect.objectContaining({
          "anthropic-dangerous-direct-browser-access": null,
        }),
      }),
    );
  });

  it("sends an empty Origin so the Rust side strips the header entirely", async () => {
    // tauri-plugin-http force-appends the webview origin unless the caller
    // passes Origin: "" (with the unsafe-headers feature enabled), which
    // makes the plugin remove the header before sending.
    createClaudeProvider("sk-test", "claude-haiku-4-5-20251001");

    const ctorArgs = vi.mocked(Anthropic).mock.calls[0]![0] as { fetch: typeof globalThis.fetch };
    vi.mocked(tauriFetch).mockResolvedValueOnce(new Response("{}"));

    await ctorArgs.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-test" },
    });

    expect(tauriFetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(tauriFetch).mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("Origin")).toBe("");
    expect(headers.get("x-api-key")).toBe("sk-test");
  });

  it("testConnection returns true on success and false on API error", async () => {
    const provider = createClaudeProvider("sk-test", "claude-haiku-4-5-20251001");

    mockCreate.mockResolvedValueOnce({ content: [] });
    await expect(provider.testConnection()).resolves.toBe(true);

    mockCreate.mockRejectedValueOnce(new Error("401"));
    await expect(provider.testConnection()).resolves.toBe(false);
  });
});
