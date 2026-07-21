import { getSetting, setSetting } from "@/services/db/settings";
import { getAiCache } from "@/services/db/aiCache";
import { getActiveProvider, isAiAvailable } from "@/services/ai/providerManager";
import { threadStateKey } from "@/services/brief/briefWindow";
import { getRecordCandidates } from "./candidates";
import { extractThreadRecords, ensureThreadMaterialized, RECORDS_EXTRACT_TYPE } from "./extractor";

const SYNC_DEBOUNCE_MS = 2000;
const FLOOR_DAYS = 90;

/** Per pass, so the 90-day backfill spreads across sync cycles. */
export const RECORDS_BATCH_SIZE = 20;

function floorKey(accountId: string): string {
  return `records_vault_floor:${accountId}`;
}

export async function getVaultFloor(accountId: string): Promise<number | null> {
  const raw = await getSetting(floorKey(accountId));
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stamp now − 90 days on first call for the account; never move it after. */
export async function ensureVaultFloor(accountId: string, now: number): Promise<number> {
  const existing = await getVaultFloor(accountId);
  if (existing !== null) return existing;
  const floor = now - FLOOR_DAYS * 24 * 3_600_000;
  await setSetting(floorKey(accountId), String(floor));
  return floor;
}

/** Extract records for up to RECORDS_BATCH_SIZE stale candidates. */
export async function refreshRecordExtractions(accountId: string): Promise<number> {
  if (!(await isAiAvailable())) return 0;

  const floor = await ensureVaultFloor(accountId, Date.now());
  const candidates = await getRecordCandidates(accountId, floor);

  const stale = [];
  const fresh = [];
  for (const c of candidates) {
    const raw = await getAiCache(accountId, c.threadId, RECORDS_EXTRACT_TYPE);
    const expected = threadStateKey({
      last_message_at: c.lastMessageAt,
      message_count: c.messageCount,
    });
    let isFresh = false;
    if (raw) {
      try {
        isFresh = (JSON.parse(raw) as { stateKey: string }).stateKey === expected;
      } catch {
        isFresh = false;
      }
    }
    if (isFresh) fresh.push(c);
    else if (stale.length < RECORDS_BATCH_SIZE) stale.push(c);
  }

  // Heal pass: fresh threads whose table rows went missing (a prior pass's
  // materialization failed after its cache write) — no provider calls.
  let refreshed = 0;
  for (const c of fresh) {
    if (await ensureThreadMaterialized(accountId, c)) refreshed++;
  }
  if (stale.length === 0) return refreshed;

  const provider = await getActiveProvider();
  for (const c of stale) {
    const result = await extractThreadRecords(provider, accountId, c);
    if (result) refreshed++;
  }
  return refreshed;
}

// ---------------------------------------------------------------------------
// Sync-triggered pass (serialized, debounced, dirty-rerun — ledgerManager's
// trigger pattern)
// ---------------------------------------------------------------------------

let syncHandler: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let dirty = false;

async function runPass(getAccountId: () => string | null): Promise<void> {
  const accountId = getAccountId();
  if (!accountId) return;
  if (inFlight) {
    dirty = true;
    return;
  }
  inFlight = true;
  try {
    await refreshRecordExtractions(accountId);
    window.dispatchEvent(new Event("velo-records-updated"));
  } catch (err) {
    console.error("Records pass failed:", err);
  } finally {
    inFlight = false;
    if (dirty) {
      dirty = false;
      void runPass(getAccountId);
    }
  }
}

export function startRecordsManager(getAccountId: () => string | null): void {
  stopRecordsManager();
  syncHandler = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runPass(getAccountId);
    }, SYNC_DEBOUNCE_MS);
  };
  window.addEventListener("velo-sync-done", syncHandler);
}

export function stopRecordsManager(): void {
  if (syncHandler) {
    window.removeEventListener("velo-sync-done", syncHandler);
    syncHandler = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
