import Anthropic from "@anthropic-ai/sdk";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

// Requests must not look like browser traffic: Anthropic rejects browser
// (CORS) requests for orgs with custom retention settings. Three parts:
// Rust-side fetch (no webview network stack), an empty Origin so the plugin
// strips the header it would otherwise force-append (requires the crate's
// unsafe-headers feature, see src-tauri/Cargo.toml), and a null defaultHeader
// removing the browser opt-in header the SDK adds for dangerouslyAllowBrowser
// (which is still required to construct the client inside a webview).
const fetchWithoutOrigin: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Origin", "");
  return fetch(input, { ...init, headers });
};

const factory = createProviderFactory(
  (apiKey) =>
    new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
      fetch: fetchWithoutOrigin,
      defaultHeaders: { "anthropic-dangerous-direct-browser-access": null },
    }),
);

export function createClaudeProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userContent }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text ?? "";
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.messages.create({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return true;
      } catch (err) {
        console.error("Claude testConnection failed:", err);
        return false;
      }
    },
  };
}

export function clearClaudeProvider(): void {
  factory.clear();
}
