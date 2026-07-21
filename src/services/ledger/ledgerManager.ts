import { getAiCache } from "@/services/db/aiCache";
import { clearLedgerOverride, getPinnedOverrides, setLedgerOverride } from "@/services/db/ledgerOverrides";
import { getActiveProvider, isAiAvailable } from "@/services/ai/providerManager";
import { notifyFollowUpDue } from "@/services/notifications/notificationManager";
import { threadStateKey } from "@/services/brief/briefWindow";
import { getLedgerCandidates } from "./candidates";
import { extractThreadObligations, LEDGER_EXTRACT_TYPE } from "./extractor";
import { getLedger, getOwnerEmail } from "./ledger";

const SYNC_DEBOUNCE_MS = 2000;

/** Refresh cached obligation extractions for changed candidates. */
export async function refreshLedgerExtractions(accountId: string): Promise<number> {
  if (!(await isAiAvailable())) return 0;

  const ownerEmail = (await getOwnerEmail(accountId)) ?? "";
  const candidates = await getLedgerCandidates(accountId, ownerEmail, Date.now());

  const stale = [];
  for (const c of candidates) {
    const raw = await getAiCache(accountId, c.threadId, LEDGER_EXTRACT_TYPE);
    const expected = threadStateKey({ last_message_at: c.lastMessageAt, message_count: c.messageCount });
    let fresh = false;
    if (raw) {
      try {
        fresh = (JSON.parse(raw) as { stateKey: string }).stateKey === expected;
      } catch {
        fresh = false;
      }
    }
    if (!fresh) stale.push(c);
  }
  if (stale.length === 0) return 0;

  const provider = await getActiveProvider();
  let refreshed = 0;
  for (const c of stale) {
    const result = await extractThreadObligations(provider, accountId, ownerEmail, c);
    if (result) refreshed++;
  }
  return refreshed;
}

/** Clear resolved pins and notify on overdue unresolved ones. */
export async function checkPinnedDue(accountId: string, now: number): Promise<void> {
  const pins = await getPinnedOverrides(accountId);
  const waiting = pins.filter((p) => p.kind === "waiting");
  if (waiting.length === 0) return;

  const { waitingOn } = await getLedger(accountId, now);
  for (const pin of waiting) {
    const entry = waitingOn.find((e) => e.threadId === pin.thread_id);
    if (!entry) {
      // Reply arrived — the pin resolved; clear it regardless of due date
      await clearLedgerOverride(accountId, pin.thread_id, "waiting");
      continue;
    }
    if (pin.due_at !== null && pin.due_at <= now) {
      notifyFollowUpDue(entry.subject ?? "", entry.threadId, accountId);
      await setLedgerOverride(accountId, pin.thread_id, "waiting", "pinned", null);
    }
  }
}

// ---------------------------------------------------------------------------
// Sync-triggered pass (serialized, debounced, dirty-rerun)
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
    await refreshLedgerExtractions(accountId);
    await checkPinnedDue(accountId, Date.now());
    window.dispatchEvent(new Event("velo-ledger-updated"));
  } catch (err) {
    console.error("Ledger pass failed:", err);
  } finally {
    inFlight = false;
    if (dirty) {
      dirty = false;
      void runPass(getAccountId);
    }
  }
}

export function startLedgerManager(getAccountId: () => string | null): void {
  stopLedgerManager();
  syncHandler = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runPass(getAccountId);
    }, SYNC_DEBOUNCE_MS);
  };
  window.addEventListener("velo-sync-done", syncHandler);
}

export function stopLedgerManager(): void {
  if (syncHandler) {
    window.removeEventListener("velo-sync-done", syncHandler);
    syncHandler = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
