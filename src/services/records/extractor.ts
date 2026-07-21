import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getMessagesForThread } from "@/services/db/messages";
import { getAttachmentsForMessage } from "@/services/db/attachments";
import { truncateThreadBodies } from "@/services/brief/extractor";
import { parseModelJson } from "@/services/brief/briefSchema";
import { threadStateKey } from "@/services/brief/briefWindow";
import type { RecordCandidate } from "./candidates";
import {
  replaceThreadRecords,
  deleteRecord,
  RECORD_KINDS,
  type DbRecord,
  type RecordKind,
  type ReferenceNumber,
} from "./records";

export const RECORDS_EXTRACT_TYPE = "records_extract_v1";

export interface ExtractedRecord {
  kind: RecordKind;
  vendor: string | null;
  title: string;
  /** Event date as YYYY-MM-DD (order/flight/statement date), not the email date. */
  recordDate: string | null;
  amount: string | null;
  referenceNumbers: ReferenceNumber[];
  details: string | null;
  sourceMessageDate: number;
}

export interface RecordsCacheEntry {
  stateKey: string;
  records: ExtractedRecord[];
  /** Fingerprints overturned via "Not a record" — carried across re-extractions. */
  suppressed: string[];
}

export function recordFingerprint(kind: string, sourceMessageDate: number): string {
  return `${kind}:${sourceMessageDate}`;
}

export function validateRecordsExtraction(value: unknown): ExtractedRecord[] | null {
  if (typeof value !== "object" || value === null) return null;
  const arr = (value as Record<string, unknown>)["records"];
  if (!Array.isArray(arr)) return null;

  const out: ExtractedRecord[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (typeof kind !== "string" || !(RECORD_KINDS as string[]).includes(kind)) continue;
    const title = o["title"];
    if (typeof title !== "string" || title.length === 0) continue;
    const sourceMessageDate = o["sourceMessageDate"];
    if (typeof sourceMessageDate !== "number") continue;

    const referenceNumbers: ReferenceNumber[] = [];
    if (Array.isArray(o["referenceNumbers"])) {
      for (const ref of o["referenceNumbers"]) {
        if (
          typeof ref === "object" &&
          ref !== null &&
          typeof (ref as Record<string, unknown>)["label"] === "string" &&
          typeof (ref as Record<string, unknown>)["value"] === "string"
        ) {
          referenceNumbers.push({
            label: (ref as { label: string }).label,
            value: (ref as { value: string }).value,
          });
        }
      }
    }

    out.push({
      kind: kind as RecordKind,
      vendor: typeof o["vendor"] === "string" ? o["vendor"] : null,
      title,
      recordDate: typeof o["recordDate"] === "string" ? o["recordDate"] : null,
      amount: typeof o["amount"] === "string" ? o["amount"] : null,
      referenceNumbers,
      details: typeof o["details"] === "string" ? o["details"] : null,
      sourceMessageDate,
    });
  }
  return out;
}

export function buildRecordsRequest(
  subject: string | null,
  parts: { from: string; date: number; body: string }[],
  attachmentNamesByDate: Map<number, string[]>,
): AiCompletionRequest {
  const conversation = parts
    .map((p) => {
      const atts = attachmentNamesByDate.get(p.date);
      const attLine = atts && atts.length > 0 ? `\nAttachments: ${atts.join(", ")}` : "";
      return `[msg ${p.date}] From: ${p.from}${attLine}\n${p.body}`;
    })
    .join("\n---\n");
  return {
    systemPrompt: [
      "You extract records from automated email for a personal archive.",
      "A record is a receipt, order/shipping notice, invoice, travel or event",
      "reservation, bank/bill/insurance statement notice, or appointment/",
      "registration confirmation. Marketing and promotional mail yields NO records.",
      'Return ONLY a JSON object: {"records": [{',
      '"kind": "purchase" | "travel" | "statement" | "appointment",',
      '"vendor": "company or sender name, else null",',
      '"title": "short description, e.g. Standing desk order",',
      '"recordDate": "the event date YYYY-MM-DD (order/flight/statement date), else null",',
      '"amount": "display amount with currency symbol, e.g. $729.00, else null",',
      '"referenceNumbers": [{"label": "Order #", "value": "F-118272"}],',
      '"details": "1 short sentence of specifics, else null",',
      '"sourceMessageDate": the [msg N] number of the message the record came from}]}',
      "Distinct real-world items get distinct records; an order and its shipping",
      'notice are ONE record (keep the richest details). Return {"records": []}',
      "when nothing qualifies. Never invent facts. No prose outside the JSON.",
    ].join("\n"),
    userContent: `Subject: ${subject ?? "(no subject)"}\n\n${conversation}`,
    maxTokens: 800,
  };
}

function parseRecordDate(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Cached, materializing extraction. On a fresh stateKey returns the cache.
 * On a stale one: one provider call (plus one retry), cache write carrying
 * the suppressed list forward, then delete-and-rewrite of the thread's rows
 * in the records table (skipping suppressed fingerprints).
 */
export async function extractThreadRecords(
  provider: AiProviderClient,
  accountId: string,
  candidate: RecordCandidate,
): Promise<{ records: ExtractedRecord[]; suppressed: string[] } | null> {
  const stateKey = threadStateKey({
    last_message_at: candidate.lastMessageAt,
    message_count: candidate.messageCount,
  });

  let priorSuppressed: string[] = [];
  const cachedRaw = await getAiCache(accountId, candidate.threadId, RECORDS_EXTRACT_TYPE);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as RecordsCacheEntry;
      if (Array.isArray(cached.suppressed)) {
        priorSuppressed = cached.suppressed.filter((s): s is string => typeof s === "string");
      }
      if (cached.stateKey === stateKey) {
        const valid = validateRecordsExtraction({ records: cached.records });
        if (valid) return { records: valid, suppressed: priorSuppressed };
      }
    } catch {
      // fall through to re-extract
    }
  }

  const messages = await getMessagesForThread(accountId, candidate.threadId);
  const parts = truncateThreadBodies(messages);
  const attachmentNamesByDate = new Map<number, string[]>();
  for (const m of messages) {
    const atts = await getAttachmentsForMessage(accountId, m.id);
    const names = atts
      .filter((a) => a.is_inline === 0 && a.filename)
      .map((a) => a.filename!);
    if (names.length > 0) {
      attachmentNamesByDate.set(m.date, [
        ...(attachmentNamesByDate.get(m.date) ?? []),
        ...names,
      ]);
    }
  }
  const request = buildRecordsRequest(candidate.subject, parts, attachmentNamesByDate);

  let records = validateRecordsExtraction(parseModelJson(await provider.complete(request)));
  if (!records) {
    // One retry with an explicit nudge — local models are sloppier than Claude
    records = validateRecordsExtraction(
      parseModelJson(
        await provider.complete({
          ...request,
          userContent: `${request.userContent}\n\nReturn ONLY the JSON object.`,
        }),
      ),
    );
  }
  if (!records) return null;

  // Pin hallucinated source dates to a real message so fingerprints stay stable
  const validDates = new Set(parts.map((p) => p.date));
  for (const r of records) {
    if (!validDates.has(r.sourceMessageDate)) r.sourceMessageDate = candidate.lastMessageAt;
  }

  await setAiCache(
    accountId,
    candidate.threadId,
    RECORDS_EXTRACT_TYPE,
    JSON.stringify({ stateKey, records, suppressed: priorSuppressed } satisfies RecordsCacheEntry),
  );

  const kept = records.filter(
    (r) => !priorSuppressed.includes(recordFingerprint(r.kind, r.sourceMessageDate)),
  );
  await replaceThreadRecords(
    accountId,
    candidate.threadId,
    kept.map((r) => ({
      kind: r.kind,
      vendor: r.vendor,
      title: r.title,
      recordDate: parseRecordDate(r.recordDate),
      amount: r.amount,
      referenceNumbers: r.referenceNumbers,
      details: r.details,
      attachmentNames: attachmentNamesByDate.get(r.sourceMessageDate) ?? [],
      sourceMessageDate: r.sourceMessageDate,
    })),
  );

  return { records, suppressed: priorSuppressed };
}

/**
 * "Not a record": append the fingerprint to the cache row's suppressed list
 * (so re-extraction never resurrects it) and delete the materialized row.
 */
export async function suppressRecord(accountId: string, record: DbRecord): Promise<void> {
  const fingerprint = recordFingerprint(record.kind, record.source_message_date);
  const raw = await getAiCache(accountId, record.thread_id, RECORDS_EXTRACT_TYPE);
  let entry: RecordsCacheEntry = { stateKey: "", records: [], suppressed: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RecordsCacheEntry;
      entry = {
        stateKey: typeof parsed.stateKey === "string" ? parsed.stateKey : "",
        records: Array.isArray(parsed.records) ? parsed.records : [],
        suppressed: Array.isArray(parsed.suppressed) ? parsed.suppressed : [],
      };
    } catch {
      // unparseable cache — still record the suppression in a fresh entry
    }
  }
  if (!entry.suppressed.includes(fingerprint)) entry.suppressed.push(fingerprint);
  await setAiCache(accountId, record.thread_id, RECORDS_EXTRACT_TYPE, JSON.stringify(entry));
  await deleteRecord(accountId, record.id);
}
