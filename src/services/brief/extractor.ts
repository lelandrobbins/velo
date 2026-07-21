import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread, type DbMessage } from "@/services/db/messages";
import type { DbThread } from "@/services/db/threads";
import { parseModelJson, validateExtraction, type ThreadExtraction } from "./briefSchema";
import { threadStateKey } from "./briefWindow";

export const EXTRACT_TYPE = "brief_extract_v1";

const PER_MESSAGE_CHARS = 2000;
const PER_THREAD_CHARS = 8000;

interface CachedExtraction {
  stateKey: string;
  extraction: ThreadExtraction;
}

export function truncateThreadBodies(
  messages: DbMessage[],
): { from: string; date: number; body: string }[] {
  // Newest messages win the budget; output stays oldest-first for readability
  const newestFirst = [...messages].sort((a, b) => b.date - a.date);
  const kept: { from: string; date: number; body: string }[] = [];
  let budget = PER_THREAD_CHARS;
  for (const m of newestFirst) {
    if (budget <= 0) break;
    const raw = m.body_text ?? m.snippet ?? "";
    const body = raw.slice(0, Math.min(PER_MESSAGE_CHARS, budget));
    if (body.length === 0) continue;
    budget -= body.length;
    kept.push({ from: m.from_name ?? m.from_address ?? "unknown", date: m.date, body });
  }
  return kept.sort((a, b) => a.date - b.date);
}

export function buildExtractionRequest(
  subject: string | null,
  parts: { from: string; date: number; body: string }[],
): AiCompletionRequest {
  const conversation = parts
    .map((p) => `From: ${p.from}\n${p.body}`)
    .join("\n---\n");
  return {
    systemPrompt: [
      "You extract facts from an email thread for a personal assistant.",
      "Return ONLY a JSON object with exactly these fields:",
      '{"summary": "1-2 sentences, newest development first",',
      ' "needsYou": boolean (does the user need to act or respond?),',
      ' "why": "short reason if needsYou, else null",',
      ' "dates": [{"iso": "YYYY-MM-DD", "what": "what happens then"}],',
      ' "people": ["display names of the other participants"]}',
      "Only include dates explicitly mentioned as meaningful (deadlines, events).",
      "Never invent facts. No prose outside the JSON.",
    ].join("\n"),
    userContent: `Subject: ${subject ?? "(no subject)"}\n\n${conversation}`,
    maxTokens: 500,
  };
}

export async function extractThread(
  provider: AiProviderClient,
  accountId: string,
  thread: DbThread,
): Promise<ThreadExtraction | null> {
  const stateKey = threadStateKey(thread);

  const cachedRaw = await getAiCache(accountId, thread.id, EXTRACT_TYPE);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedExtraction;
      if (cached.stateKey === stateKey) {
        const valid = validateExtraction(cached.extraction);
        if (valid) return valid;
      }
    } catch {
      // fall through to re-extract
    }
  }

  const messages = await getMessagesForThread(accountId, thread.id);
  const parts = truncateThreadBodies(messages);
  const request = buildExtractionRequest(thread.subject, parts);

  let extraction = validateExtraction(parseModelJson(await provider.complete(request)));
  if (!extraction) {
    // One retry with an explicit nudge — local models are sloppier than Claude
    extraction = validateExtraction(
      parseModelJson(
        await provider.complete({
          ...request,
          userContent: `${request.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!extraction) return null;

  const toCache: CachedExtraction = { stateKey, extraction };
  await setAiCache(accountId, thread.id, EXTRACT_TYPE, JSON.stringify(toCache));
  return extraction;
}
