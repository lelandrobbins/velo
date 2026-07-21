import { getLedger, type LedgerEntry } from "./ledger";

export interface ObligationLine {
  threadId: string;
  line: string;
  hashKey: string;
}

const CAP = 5;

function formatLine(e: LedgerEntry): string {
  if (e.kind === "waiting") {
    const who = e.counterparty ?? "a reply";
    return `waiting on ${who} for ${e.ageDays} days${e.detail ? ` (${e.detail})` : ""}`;
  }
  const who = e.counterparty ?? "someone";
  const due = e.dueAt ? `, due ${new Date(e.dueAt).toISOString().slice(0, 10)}` : "";
  return `you promised ${who}: ${e.detail ?? "a follow-up"}${due}`;
}

/** Top obligations for the Brief's compose input, oldest first, capped. */
export async function getObligationLines(
  accountId: string,
  now: number,
): Promise<ObligationLine[]> {
  const { waitingOn, promises } = await getLedger(accountId, now);
  return [...waitingOn, ...promises]
    .sort((a, b) => a.sinceAt - b.sinceAt)
    .slice(0, CAP)
    .map((e) => ({
      threadId: e.threadId,
      line: formatLine(e),
      hashKey: `oblig:${e.kind}:${e.threadId}:${e.ageDays}:${e.dueAt ?? ""}`,
    }));
}
