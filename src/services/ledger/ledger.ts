import { getDb } from "@/services/db/connection";
import { getAiCache } from "@/services/db/aiCache";
import { getLedgerOverrides, getPinnedOverrides } from "@/services/db/ledgerOverrides";
import { threadStateKey } from "@/services/brief/briefWindow";
import { getLedgerCandidates, type LedgerCandidate } from "./candidates";
import { validateObligationExtraction, LEDGER_EXTRACT_TYPE, type ObligationExtraction } from "./extractor";

const DAY_MS = 24 * 3_600_000;

export interface LedgerEntry {
  threadId: string;
  kind: "waiting" | "promise";
  subject: string | null;
  counterparty: string | null;
  detail: string | null;
  ageDays: number;
  sinceAt: number;
  dueAt: number | null;
  pinned: boolean;
}

export async function getOwnerEmail(accountId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ email: string }[]>(
    "SELECT email FROM accounts WHERE id = $1",
    [accountId],
  );
  return rows[0]?.email ?? null;
}

async function getCachedExtraction(
  accountId: string,
  candidate: LedgerCandidate,
): Promise<ObligationExtraction | null> {
  const raw = await getAiCache(accountId, candidate.threadId, LEDGER_EXTRACT_TYPE);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as { stateKey: string; extraction: unknown };
    const expected = threadStateKey({
      last_message_at: candidate.lastMessageAt,
      message_count: candidate.messageCount,
    });
    if (cached.stateKey !== expected) return null;
    return validateObligationExtraction(cached.extraction);
  } catch {
    return null;
  }
}

function parseDue(promises: { what: string; due: string | null }[]): number | null {
  const times = promises
    .map((p) => (p.due ? Date.parse(p.due) : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Derive the current ledger. Reads only cached extractions — never calls a
 * provider — so this is instant and safe to run on every view load.
 */
export async function getLedger(
  accountId: string,
  now: number,
): Promise<{ waitingOn: LedgerEntry[]; promises: LedgerEntry[] }> {
  const ownerEmail = (await getOwnerEmail(accountId)) ?? "";
  const candidates = await getLedgerCandidates(accountId, ownerEmail, now);
  const overrides = await getLedgerOverrides(accountId);
  const pinned = await getPinnedOverrides(accountId);

  const overrideFor = (threadId: string, kind: "waiting" | "promise") =>
    overrides.find((o) => o.thread_id === threadId && o.kind === kind);

  const waitingOn: LedgerEntry[] = [];
  const promises: LedgerEntry[] = [];
  const candidateById = new Map(candidates.map((c) => [c.threadId, c]));

  for (const c of candidates) {
    const extraction = await getCachedExtraction(accountId, c);
    if (!extraction) continue;

    const counterparty = extraction.counterparty ?? c.counterpartyName ?? c.counterpartyAddress;

    const waitingOverride = overrideFor(c.threadId, "waiting");
    if (
      c.ownerSpokeLast &&
      extraction.expectsReply &&
      waitingOverride?.action !== "dismissed"
    ) {
      waitingOn.push({
        threadId: c.threadId,
        kind: "waiting",
        subject: c.subject,
        counterparty,
        detail: extraction.why,
        ageDays: Math.floor((now - c.ownerLastSentAt) / DAY_MS),
        sinceAt: c.ownerLastSentAt,
        dueAt: waitingOverride?.action === "pinned" ? waitingOverride.due_at : null,
        pinned: waitingOverride?.action === "pinned",
      });
    }

    const promiseOverride = overrideFor(c.threadId, "promise");
    if (
      extraction.promises.length > 0 &&
      promiseOverride?.action !== "dismissed" &&
      promiseOverride?.action !== "done"
    ) {
      promises.push({
        threadId: c.threadId,
        kind: "promise",
        subject: c.subject,
        counterparty,
        detail: extraction.promises.map((p) => p.what).join("; "),
        ageDays: Math.floor((now - c.ownerLastSentAt) / DAY_MS),
        sinceAt: c.ownerLastSentAt,
        dueAt: parseDue(extraction.promises),
        pinned: false,
      });
    }
  }

  // Pinned overrides force waiting entries even without extractions
  for (const pin of pinned) {
    if (pin.kind !== "waiting") continue;
    if (waitingOn.some((e) => e.threadId === pin.thread_id)) continue;
    const c = candidateById.get(pin.thread_id);
    if (c && !c.ownerSpokeLast) continue; // reply arrived — pin resolved
    waitingOn.push({
      threadId: pin.thread_id,
      kind: "waiting",
      subject: c?.subject ?? null,
      counterparty: c?.counterpartyName ?? c?.counterpartyAddress ?? null,
      detail: null,
      ageDays: Math.floor((now - (c?.ownerLastSentAt ?? pin.created_at * 1000)) / DAY_MS),
      sinceAt: c?.ownerLastSentAt ?? pin.created_at * 1000,
      dueAt: pin.due_at,
      pinned: true,
    });
  }

  waitingOn.sort((a, b) => a.sinceAt - b.sinceAt);
  promises.sort((a, b) => a.sinceAt - b.sinceAt);
  return { waitingOn, promises };
}
