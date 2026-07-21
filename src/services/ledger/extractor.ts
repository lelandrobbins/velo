import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { truncateThreadBodies } from "@/services/brief/extractor";
import { parseModelJson } from "@/services/brief/briefSchema";
import { threadStateKey } from "@/services/brief/briefWindow";

export const LEDGER_EXTRACT_TYPE = "ledger_extract_v1";

export interface ObligationExtraction {
  expectsReply: boolean;
  why: string | null;
  counterparty: string | null;
  promises: { what: string; due: string | null }[];
}

interface CachedObligation {
  stateKey: string;
  extraction: ObligationExtraction;
}

export function validateObligationExtraction(value: unknown): ObligationExtraction | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["expectsReply"] !== "boolean") return null;

  const promises: { what: string; due: string | null }[] = [];
  if (Array.isArray(obj["promises"])) {
    for (const p of obj["promises"]) {
      if (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>)["what"] === "string") {
        const due = (p as Record<string, unknown>)["due"];
        promises.push({ what: (p as { what: string }).what, due: typeof due === "string" ? due : null });
      }
    }
  }

  return {
    expectsReply: obj["expectsReply"],
    why: typeof obj["why"] === "string" ? obj["why"] : null,
    counterparty: typeof obj["counterparty"] === "string" ? obj["counterparty"] : null,
    promises,
  };
}

function buildObligationRequest(
  subject: string | null,
  parts: { from: string; date: number; body: string }[],
): AiCompletionRequest {
  const conversation = parts.map((p) => `From: ${p.from}\n${p.body}`).join("\n---\n");
  return {
    systemPrompt: [
      "You analyze an email thread for the account owner's obligations.",
      "The FIRST 'From' name marked (owner) is the user. Return ONLY a JSON object:",
      '{"expectsReply": boolean (does the owner\'s LATEST message call for an answer',
      " from the other person? FYI-only sends, thanks, and sign-offs are false),",
      ' "why": "short reason if expectsReply, else null",',
      ' "counterparty": "display name of the main other participant, else null",',
      ' "promises": [{"what": "commitment the OWNER made anywhere in the thread',
      ' that is still unfulfilled given the full conversation", "due": "YYYY-MM-DD or null"}]}',
      "A promise already delivered later in the thread must NOT be listed.",
      "Never invent facts. No prose outside the JSON.",
    ].join("\n"),
    userContent: `Subject: ${subject ?? "(no subject)"}\n\n${conversation}`,
    maxTokens: 500,
  };
}

export async function extractThreadObligations(
  provider: AiProviderClient,
  accountId: string,
  candidate: { threadId: string; subject: string | null; lastMessageAt: number; messageCount: number },
): Promise<ObligationExtraction | null> {
  const stateKey = threadStateKey({
    last_message_at: candidate.lastMessageAt,
    message_count: candidate.messageCount,
  });

  const cachedRaw = await getAiCache(accountId, candidate.threadId, LEDGER_EXTRACT_TYPE);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedObligation;
      if (cached.stateKey === stateKey) {
        const valid = validateObligationExtraction(cached.extraction);
        if (valid) return valid;
      }
    } catch {
      // fall through to re-extract
    }
  }

  const messages = await getMessagesForThread(accountId, candidate.threadId);
  const parts = truncateThreadBodies(messages);
  const request = buildObligationRequest(candidate.subject, parts);

  let extraction = validateObligationExtraction(parseModelJson(await provider.complete(request)));
  if (!extraction) {
    extraction = validateObligationExtraction(
      parseModelJson(
        await provider.complete({
          ...request,
          userContent: `${request.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!extraction) return null;

  await setAiCache(
    accountId,
    candidate.threadId,
    LEDGER_EXTRACT_TYPE,
    JSON.stringify({ stateKey, extraction } satisfies CachedObligation),
  );
  return extraction;
}
