import type { AiCompletionRequest } from "@/services/ai/types";
import { getActiveProvider } from "@/services/ai/providerManager";
import { parseModelJson } from "@/services/brief/briefSchema";
import { searchRecords, RECORD_KINDS, type DbRecord, type RecordKind } from "./records";

export const ASK_RESULT_CAP = 12;

export interface AskPlan {
  ftsQueries: string[];
  kinds: RecordKind[] | null;
  dateFrom: number | null;
  dateTo: number | null;
}

export type AskOutcome =
  | { status: "answered"; answer: string; sources: DbRecord[] }
  | { status: "no-match" }
  | { status: "bad-question" };

function parsePlanDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function validateAskPlan(value: unknown): AskPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o["ftsQueries"])) return null;
  const ftsQueries = o["ftsQueries"].filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0,
  );
  if (ftsQueries.length === 0) return null;

  let kinds: RecordKind[] | null = null;
  if (Array.isArray(o["kinds"])) {
    const filtered = o["kinds"].filter(
      (k): k is RecordKind =>
        typeof k === "string" && (RECORD_KINDS as string[]).includes(k),
    );
    kinds = filtered.length > 0 ? filtered : null;
  }

  return {
    ftsQueries,
    kinds,
    dateFrom: parsePlanDate(o["dateFrom"]),
    dateTo: parsePlanDate(o["dateTo"]),
  };
}

/**
 * Neutralize FTS5 syntax: every whitespace token becomes a quoted string,
 * so operators (OR, NEAR, *, -) and column filters can't pass through.
 */
export function sanitizeFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ");
}

export function buildPlanRequest(question: string, todayIso: string): AiCompletionRequest {
  return {
    systemPrompt: [
      "You translate a question about the user's email records archive into",
      "search queries. Records are receipts, orders, invoices, travel and event",
      "reservations, statement notices, and appointment confirmations, with",
      "kinds: purchase, travel, statement, appointment.",
      "Return ONLY a JSON object:",
      '{"ftsQueries": ["2-4 short keyword queries, distinct phrasings"],',
      ' "kinds": ["subset of the four kinds"] or null,',
      ' "dateFrom": "YYYY-MM-DD" or null, "dateTo": "YYYY-MM-DD" or null}',
      `Today is ${todayIso}. No prose outside the JSON.`,
    ].join("\n"),
    userContent: question,
    maxTokens: 300,
  };
}

export function buildAnswerRequest(question: string, records: DbRecord[]): AiCompletionRequest {
  const lines = records.map((r) => {
    const refs = r.reference_numbers !== "[]" ? ` refs=${r.reference_numbers}` : "";
    const atts = r.attachment_names !== "[]" ? ` attachments=${r.attachment_names}` : "";
    const date = r.record_date
      ? new Date(r.record_date).toISOString().slice(0, 10)
      : new Date(r.source_message_date).toISOString().slice(0, 10);
    return `- id=${r.id} :: [${r.kind}] ${r.vendor ?? "?"} — ${r.title} (${date})${
      r.amount ? ` ${r.amount}` : ""
    }${refs}${atts}${r.details ? ` :: ${r.details}` : ""}`;
  });
  return {
    systemPrompt: [
      "You answer a question using ONLY the provided email records.",
      "Cite records inline with [[id]] tokens right after facts drawn from them.",
      "If the records do not answer the question, say so plainly.",
      "Never invent details. Keep the answer to 1-3 sentences.",
    ].join("\n"),
    userContent: `Question: ${question}\n\nRecords:\n${lines.join("\n")}`,
    maxTokens: 400,
  };
}

/** Valid ids become sources; every [[...]] token is stripped from the text. */
export function extractCitations(
  answer: string,
  validIds: Set<string>,
): { text: string; citedIds: string[] } {
  const citedIds: string[] = [];
  for (const match of answer.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const id = match[1]!.trim();
    if (validIds.has(id) && !citedIds.includes(id)) citedIds.push(id);
  }
  const text = answer.replace(/\s*\[\[[^\]]+\]\]/g, "").replace(/ {2,}/g, " ").trim();
  return { text, citedIds };
}

/**
 * Two-stage ask: Claude plans FTS queries, deterministic retrieval fetches
 * the top hits, Claude answers citing only manifest-validated record ids.
 * Ephemeral — nothing is cached; two provider calls per ask.
 */
export async function askVault(accountId: string, question: string): Promise<AskOutcome> {
  const provider = await getActiveProvider();
  const planRequest = buildPlanRequest(question, new Date().toISOString().slice(0, 10));

  let plan = validateAskPlan(parseModelJson(await provider.complete(planRequest)));
  if (!plan) {
    plan = validateAskPlan(
      parseModelJson(
        await provider.complete({
          ...planRequest,
          userContent: `${planRequest.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!plan) return { status: "bad-question" };

  const seen = new Map<string, DbRecord>();
  for (const q of plan.ftsQueries) {
    const sanitized = sanitizeFtsQuery(q);
    if (!sanitized) continue;
    try {
      const hits = await searchRecords(accountId, sanitized, {
        kinds: plan.kinds,
        dateFrom: plan.dateFrom,
        dateTo: plan.dateTo,
        limit: ASK_RESULT_CAP,
      });
      for (const h of hits) if (!seen.has(h.id)) seen.set(h.id, h);
    } catch {
      // a failed query contributes zero hits rather than failing the ask
    }
  }
  const candidates = [...seen.values()].slice(0, ASK_RESULT_CAP);
  if (candidates.length === 0) return { status: "no-match" };

  const answerRaw = await provider.complete(buildAnswerRequest(question, candidates));
  const { text, citedIds } = extractCitations(
    answerRaw,
    new Set(candidates.map((r) => r.id)),
  );
  const byId = new Map(candidates.map((r) => [r.id, r]));
  return {
    status: "answered",
    answer: text,
    sources: citedIds.map((id) => byId.get(id)!),
  };
}
