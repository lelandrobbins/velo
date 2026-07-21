import { getDb } from "@/services/db/connection";
import { classifyThread } from "@/services/triage/noiseClassifier";

/** Subject substrings that mark automated mail as a potential record. */
export const RECORD_SUBJECT_CUES = [
  "receipt",
  "invoice",
  "order",
  "payment",
  "statement",
  "billing",
  "renewal",
  "confirmation",
  "confirm",
  "booking",
  "reservation",
  "itinerary",
  "ticket",
  "boarding",
  "appointment",
  "registration",
  "e-ticket",
  "shipped",
  "delivery",
  "tracking",
  "policy",
];

export interface RecordCandidate {
  threadId: string;
  subject: string | null;
  lastMessageAt: number;
  messageCount: number;
}

interface CandidateRow {
  thread_id: string;
  subject: string | null;
  last_message_at: number | null;
  message_count: number;
  from_address: string | null;
  list_unsubscribe: string | null;
}

export function matchesRecordCues(subject: string | null): boolean {
  if (!subject) return false;
  const s = subject.toLowerCase();
  return RECORD_SUBJECT_CUES.some((cue) => s.includes(cue));
}

/**
 * Feed-classified threads since the vault floor whose subject matches a
 * record cue. Human (signal) mail never reaches extraction — a known miss
 * for e.g. a human-sent invoice, accepted for cost and privacy conservatism.
 */
export async function getRecordCandidates(
  accountId: string,
  floor: number,
): Promise<RecordCandidate[]> {
  const db = await getDb();
  const rows = await db.select<CandidateRow[]>(
    `SELECT t.id AS thread_id, t.subject, t.last_message_at, t.message_count,
            m.from_address, m.list_unsubscribe
     FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1
       AND t.last_message_at >= $2
       AND NOT EXISTS (SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = t.account_id AND tl.thread_id = t.id
           AND tl.label_id IN ('TRASH', 'SPAM', 'DRAFT'))
     ORDER BY t.last_message_at DESC`,
    [accountId, floor],
  );

  return rows
    .filter(
      (r) =>
        classifyThread({
          fromAddress: r.from_address,
          subject: r.subject,
          listUnsubscribe: r.list_unsubscribe,
        }) === "feed" && matchesRecordCues(r.subject),
    )
    .map((r) => ({
      threadId: r.thread_id,
      subject: r.subject,
      lastMessageAt: r.last_message_at ?? 0,
      messageCount: r.message_count,
    }));
}
