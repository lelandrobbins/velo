import { getDb } from "@/services/db/connection";
import { isAutomatedAddress } from "@/services/triage/noiseClassifier";

export const WINDOW_DAYS = 30;
export const CANDIDATE_CAP = 100;

export interface LedgerCandidate {
  threadId: string;
  subject: string | null;
  counterpartyAddress: string | null;
  counterpartyName: string | null;
  ownerLastSentAt: number;
  ownerSpokeLast: boolean;
  lastMessageAt: number;
  messageCount: number;
}

interface CandidateRow {
  thread_id: string;
  subject: string | null;
  last_message_at: number | null;
  message_count: number;
  owner_last_sent_at: number;
  last_from_address: string | null;
  counterparty_address: string | null;
  fallback_to_addresses: string | null;
  counterparty_name: string | null;
}

/** First recipient address from a raw To header ("Name <a@x>, b@y" → "a@x"). */
export function extractFirstAddress(raw: string | null): string | null {
  if (!raw) return null;
  const bracket = raw.match(/<([^>]+)>/);
  if (bracket?.[1]) return bracket[1].trim() || null;
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

/**
 * Threads where the account owner sent >= 1 message within the window,
 * excluding trash/spam/draft threads, newest first, capped. The latest
 * non-owner sender is the counterparty; when the owner has the only
 * messages, the owner's last recipient is used instead.
 */
export async function getLedgerCandidates(
  accountId: string,
  ownerEmail: string,
  now: number,
): Promise<LedgerCandidate[]> {
  const cutoff = now - WINDOW_DAYS * 24 * 3_600_000;
  const db = await getDb();
  const owner = ownerEmail.toLowerCase();

  const rows = await db.select<CandidateRow[]>(
    `SELECT t.id AS thread_id, t.subject, t.last_message_at, t.message_count,
       (SELECT MAX(m.date) FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
           AND LOWER(m.from_address) = $2) AS owner_last_sent_at,
       (SELECT m.from_address FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
         ORDER BY m.date DESC LIMIT 1) AS last_from_address,
       (SELECT m.from_address FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
           AND LOWER(m.from_address) != $2
         ORDER BY m.date DESC LIMIT 1) AS counterparty_address,
       (SELECT m.to_addresses FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
           AND LOWER(m.from_address) = $2
         ORDER BY m.date DESC LIMIT 1) AS fallback_to_addresses,
       (SELECT m.from_name FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
           AND LOWER(m.from_address) != $2
         ORDER BY m.date DESC LIMIT 1) AS counterparty_name
     FROM threads t
     WHERE t.account_id = $1
       AND EXISTS (SELECT 1 FROM messages m
         WHERE m.account_id = t.account_id AND m.thread_id = t.id
           AND LOWER(m.from_address) = $2 AND m.date >= $3)
       AND NOT EXISTS (SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = t.account_id AND tl.thread_id = t.id
           AND tl.label_id IN ('TRASH', 'SPAM', 'DRAFT'))
     ORDER BY t.last_message_at DESC
     LIMIT $4`,
    [accountId, owner, cutoff, CANDIDATE_CAP],
  );

  return rows
    .map((r) => ({
      ...r,
      counterpartyAddress:
        r.counterparty_address ?? extractFirstAddress(r.fallback_to_addresses),
    }))
    .filter(
      (r) =>
        r.counterpartyAddress !== null &&
        !isAutomatedAddress(r.counterpartyAddress),
    )
    .map((r) => ({
      threadId: r.thread_id,
      subject: r.subject,
      counterpartyAddress: r.counterpartyAddress,
      counterpartyName: r.counterparty_name,
      ownerLastSentAt: r.owner_last_sent_at,
      ownerSpokeLast: (r.last_from_address ?? "").toLowerCase() === owner,
      lastMessageAt: r.last_message_at ?? 0,
      messageCount: r.message_count,
    }));
}
