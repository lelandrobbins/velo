import { getActiveProvider } from "@/services/ai/providerManager";
import { useComposerStore } from "@/stores/composerStore";
import type { LedgerEntry } from "./ledger";

/**
 * Draft a short follow-up with the active provider and open it in the
 * composer as a reply. Never sends; provider failure opens an empty reply.
 */
export async function draftNudge(entry: LedgerEntry): Promise<void> {
  let body = "";
  try {
    const provider = await getActiveProvider();
    const draft = await provider.complete({
      systemPrompt:
        "You draft a short, friendly follow-up email nudge. 2-3 sentences, no subject line, no signature. Return only the body text.",
      userContent: `You are following up with ${entry.counterparty ?? "the recipient"} about "${entry.subject ?? "your earlier email"}". You have been waiting ${entry.ageDays} days. Context: ${entry.detail ?? "a reply is needed"}.`,
      maxTokens: 200,
    });
    body = draft.trim() ? `<p>${draft.trim()}</p>` : "";
  } catch (err) {
    console.error("Nudge draft failed:", err);
  }

  useComposerStore.getState().openComposer({
    mode: "reply",
    to: [],
    subject: entry.subject ? `Re: ${entry.subject}` : "",
    bodyHtml: body,
    threadId: entry.threadId,
  });
}
