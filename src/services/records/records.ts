import { getDb } from "@/services/db/connection";

export type RecordKind = "purchase" | "travel" | "statement" | "appointment";
export const RECORD_KINDS: RecordKind[] = ["purchase", "travel", "statement", "appointment"];

export interface ReferenceNumber {
  label: string;
  value: string;
}

/** Camel-case shape used to write records (from extraction). */
export interface RecordFields {
  kind: RecordKind;
  vendor: string | null;
  title: string;
  recordDate: number | null;
  amount: string | null;
  referenceNumbers: ReferenceNumber[];
  details: string | null;
  attachmentNames: string[];
  sourceMessageDate: number;
}

/** Raw row shape as read from SQLite. */
export interface DbRecord {
  id: string;
  account_id: string;
  thread_id: string;
  kind: RecordKind;
  vendor: string | null;
  title: string;
  record_date: number | null;
  amount: string | null;
  reference_numbers: string;
  details: string | null;
  attachment_names: string;
  source_message_date: number;
  created_at: number;
}

/**
 * Replace a thread's records and keep records_fts in sync. All record
 * writes flow through here (single consumer), which is why records_fts
 * needs no triggers.
 */
export async function replaceThreadRecords(
  accountId: string,
  threadId: string,
  records: RecordFields[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM records_fts WHERE record_id IN
       (SELECT id FROM records WHERE account_id = $1 AND thread_id = $2)`,
    [accountId, threadId],
  );
  await db.execute(
    "DELETE FROM records WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  for (const r of records) {
    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO records (id, account_id, thread_id, kind, vendor, title,
         record_date, amount, reference_numbers, details, attachment_names,
         source_message_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        accountId,
        threadId,
        r.kind,
        r.vendor,
        r.title,
        r.recordDate,
        r.amount,
        JSON.stringify(r.referenceNumbers),
        r.details,
        JSON.stringify(r.attachmentNames),
        r.sourceMessageDate,
      ],
    );
    const referenceText = r.referenceNumbers.map((n) => `${n.label} ${n.value}`).join(" ");
    await db.execute(
      `INSERT INTO records_fts (record_id, vendor, title, details, reference_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, r.vendor ?? "", r.title, r.details ?? "", referenceText],
    );
  }
}

export async function deleteRecord(accountId: string, recordId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM records_fts WHERE record_id = $1", [recordId]);
  await db.execute("DELETE FROM records WHERE account_id = $1 AND id = $2", [
    accountId,
    recordId,
  ]);
}

export async function listRecords(
  accountId: string,
  kinds?: RecordKind[],
): Promise<DbRecord[]> {
  const db = await getDb();
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map((_, i) => `$${i + 2}`).join(", ");
    return db.select<DbRecord[]>(
      `SELECT * FROM records WHERE account_id = $1 AND kind IN (${placeholders})
       ORDER BY COALESCE(record_date, source_message_date) DESC`,
      [accountId, ...kinds],
    );
  }
  return db.select<DbRecord[]>(
    `SELECT * FROM records WHERE account_id = $1
     ORDER BY COALESCE(record_date, source_message_date) DESC`,
    [accountId],
  );
}

export async function countRecords(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM records WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.count ?? 0;
}

export interface RecordSearchOpts {
  kinds?: RecordKind[] | null;
  dateFrom?: number | null;
  dateTo?: number | null;
  limit?: number;
}

/** ftsQuery must already be sanitized (see ask.sanitizeFtsQuery). */
export async function searchRecords(
  accountId: string,
  ftsQuery: string,
  opts: RecordSearchOpts = {},
): Promise<DbRecord[]> {
  const db = await getDb();
  const params: unknown[] = [accountId, ftsQuery];
  let filters = "";
  if (opts.kinds && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map((k) => {
      params.push(k);
      return `$${params.length}`;
    });
    filters += ` AND r.kind IN (${placeholders.join(", ")})`;
  }
  if (opts.dateFrom != null) {
    params.push(opts.dateFrom);
    filters += ` AND COALESCE(r.record_date, r.source_message_date) >= $${params.length}`;
  }
  if (opts.dateTo != null) {
    params.push(opts.dateTo);
    filters += ` AND COALESCE(r.record_date, r.source_message_date) <= $${params.length}`;
  }
  params.push(opts.limit ?? 12);
  return db.select<DbRecord[]>(
    `SELECT r.* FROM records_fts f
     JOIN records r ON r.id = f.record_id
     WHERE records_fts MATCH $2 AND r.account_id = $1${filters}
     ORDER BY f.rank, COALESCE(r.record_date, r.source_message_date) DESC
     LIMIT $${params.length}`,
    params,
  );
}
