import Anthropic from "@anthropic-ai/sdk";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

// Rust-side fetch: browser (CORS) requests are rejected for Anthropic orgs
// with custom retention settings, so requests must not carry a webview Origin
const factory = createProviderFactory(
  (apiKey) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true, fetch }),
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
