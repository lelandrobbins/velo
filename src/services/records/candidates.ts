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

/** Every address in a raw recipient header ("Name <a@x>, b@y" → [a@x, b@y]). */
export function extractAddresses(raw: string | null): string[] {
  if (!raw) return [];
  return (raw.match(/[^\s<>,"']+@[^\s<>,"']+/g) ?? []).map((a) => a.toLowerCase());
}

/** Lowercased set of every address the owner has ever sent mail to. */
async function getOwnerRecipients(accountId: string, ownerEmail: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ to_addresses: string | null; cc_addresses: string | null }[]>(
    `SELECT to_addresses, cc_addresses FROM messages
     WHERE account_id = $1 AND LOWER(from_address) = $2`,
    [accountId, ownerEmail.toLowerCase()],
  );
  const recipients = new Set<string>();
  for (const r of rows) {
    for (const addr of extractAddresses(r.to_addresses)) recipients.add(addr);
    for (const addr of extractAddresses(r.cc_addresses)) recipients.add(addr);
  }
  return recipients;
}

/**
 * Threads since the vault floor whose subject matches a record cue AND whose
 * latest sender is either feed-classified or someone the owner has never
 * written to. The never-written-to test is the human gate: transactional
 * senders the noise classifier can't recognize (auto-confirm@amazon.com,
 * bank statement aliases) still qualify, while genuine correspondents — the
 * accountant who sends invoices — never reach extraction (decision revised
 * from feed-only on 2026-07-21 after the strict gate missed 138/201 real
 * receipt threads on a live mailbox).
 */
export async function getRecordCandidates(
  accountId: string,
  ownerEmail: string,
  floor: number,
): Promise<RecordCandidate[]> {
  const db = await getDb();
  const recipients = await getOwnerRecipients(accountId, ownerEmail);
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
    .filter((r) => {
      if (!matchesRecordCues(r.subject)) return false;
      const isFeed =
        classifyThread({
          fromAddress: r.from_address,
          subject: r.subject,
          listUnsubscribe: r.list_unsubscribe,
        }) === "feed";
      const neverWrittenTo =
        r.from_address !== null && !recipients.has(r.from_address.toLowerCase());
      return isFeed || neverWrittenTo;
    })
    .map((r) => ({
      threadId: r.thread_id,
      subject: r.subject,
      lastMessageAt: r.last_message_at ?? 0,
      messageCount: r.message_count,
    }));
}
