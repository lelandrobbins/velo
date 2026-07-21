import { getDb } from "./connection";

export type LedgerKind = "waiting" | "promise";
export type LedgerAction = "dismissed" | "done" | "pinned";

export interface DbLedgerOverride {
  id: string;
  account_id: string;
  thread_id: string;
  kind: LedgerKind;
  action: LedgerAction;
  due_at: number | null;
  created_at: number;
}

export async function setLedgerOverride(
  accountId: string,
  threadId: string,
  kind: LedgerKind,
  action: LedgerAction,
  dueAt: number | null = null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO ledger_overrides (id, account_id, thread_id, kind, action, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(account_id, thread_id, kind) DO UPDATE SET
       action = $5, due_at = $6, created_at = unixepoch()`,
    [crypto.randomUUID(), accountId, threadId, kind, action, dueAt],
  );
}

export async function getLedgerOverrides(accountId: string): Promise<DbLedgerOverride[]> {
  const db = await getDb();
  return db.select<DbLedgerOverride[]>(
    "SELECT * FROM ledger_overrides WHERE account_id = $1",
    [accountId],
  );
}

export async function clearLedgerOverride(
  accountId: string,
  threadId: string,
  kind: LedgerKind,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM ledger_overrides WHERE account_id = $1 AND thread_id = $2 AND kind = $3",
    [accountId, threadId, kind],
  );
}

export async function getPinnedOverrides(accountId: string): Promise<DbLedgerOverride[]> {
  const db = await getDb();
  return db.select<DbLedgerOverride[]>(
    "SELECT * FROM ledger_overrides WHERE account_id = $1 AND action = 'pinned'",
    [accountId],
  );
}

export async function getPinnedThreadIds(
  accountId: string,
  threadIds: string[],
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  const db = await getDb();
  const placeholders = threadIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.select<{ thread_id: string }[]>(
    `SELECT thread_id FROM ledger_overrides
     WHERE account_id = $1 AND action = 'pinned' AND thread_id IN (${placeholders})`,
    [accountId, ...threadIds],
  );
  return new Set(rows.map((r) => r.thread_id));
}
