import { getThreadsForAccount, type DbThread } from "@/services/db/threads";
import { getAiCache, setAiCache } from "@/services/db/aiCache";
import { getActiveProvider, isAiAvailable } from "@/services/ai/providerManager";
import { getObligationLines } from "@/services/ledger/obligationLines";
import { categorizeFeedThread, type FeedCategory } from "@/services/triage/noiseClassifier";
import { selectFocusWindow, selectFeedItems, threadStateKey, manifestHash } from "./briefWindow";
import { extractThread } from "./extractor";
import { composeMemo, type ManifestEntry, type MemoBlock, type FeedMention } from "./composer";

export const BRIEF_THREAD_ID = "__brief__";
// v2: memo stored as markdown-subset blocks (v1 rows are ignored and regenerated)
export const MEMO_TYPE = "brief_memo_v2";

const THREAD_QUERY_LIMIT = 100;
const SYNC_DEBOUNCE_MS = 2000;

export interface StoredBrief {
  memo: string;
  blocks: MemoBlock[];
  generatedAt: number;
  manifestHash: string;
  empty: boolean;
}

export async function getCachedBrief(accountId: string): Promise<StoredBrief | null> {
  const raw = await getAiCache(accountId, BRIEF_THREAD_ID, MEMO_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredBrief;
  } catch {
    return null;
  }
}

async function storeBrief(accountId: string, brief: StoredBrief): Promise<void> {
  await setAiCache(accountId, BRIEF_THREAD_ID, MEMO_TYPE, JSON.stringify(brief));
}

function rowToFeedMention(row: DbThread): FeedMention {
  return {
    subject: row.subject,
    fromName: row.from_name ?? row.from_address,
    category: categorizeFeedThread({
      fromAddress: row.from_address,
      subject: row.subject,
      listUnsubscribe: row.list_unsubscribe,
    }),
  };
}

function dateLabel(now: number): string {
  return new Date(now).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export async function generateBrief(
  accountId: string,
  opts?: { force?: boolean },
): Promise<StoredBrief | null> {
  if (!(await isAiAvailable())) return null;

  const now = Date.now();
  const rows = await getThreadsForAccount(accountId, "INBOX", THREAD_QUERY_LIMIT, 0);
  const focus = selectFocusWindow(rows, now);
  const feed = selectFeedItems(rows, now);
  const obligations = await getObligationLines(accountId, now);

  // Deterministic empty brief — no model call
  if (focus.length === 0 && obligations.length === 0) {
    const brief: StoredBrief = {
      memo: "Nothing needs you. Enjoy the quiet.",
      blocks: [{ type: "paragraph", segments: [{ type: "text", text: "Nothing needs you. Enjoy the quiet." }] }],
      generatedAt: now,
      manifestHash: manifestHash([]),
      empty: true,
    };
    await storeBrief(accountId, brief);
    return brief;
  }

  const hash = manifestHash([
    ...focus.map((t) => ({ threadId: t.id, stateKey: threadStateKey(t) })),
    ...obligations.map((o) => ({ threadId: o.threadId, stateKey: o.hashKey })),
  ]);

  if (!opts?.force) {
    const cached = await getCachedBrief(accountId);
    if (cached && cached.manifestHash === hash) return cached;
  }

  const provider = await getActiveProvider();

  const entries: ManifestEntry[] = [];
  for (const thread of focus) {
    const extraction = await extractThread(provider, accountId, thread);
    if (extraction) entries.push({ threadId: thread.id, extraction });
  }
  if (entries.length === 0 && obligations.length === 0) return null;

  const composed = await composeMemo(
    provider,
    entries,
    feed.map(rowToFeedMention),
    dateLabel(now),
    obligations,
  );
  if (!composed) return null;

  const brief: StoredBrief = {
    memo: composed.memo,
    blocks: composed.blocks,
    generatedAt: now,
    manifestHash: hash,
    empty: false,
  };
  await storeBrief(accountId, brief);
  return brief;
}

export async function computeFiledToday(
  accountId: string,
): Promise<Record<FeedCategory, number>> {
  const now = Date.now();
  const rows = await getThreadsForAccount(accountId, "INBOX", THREAD_QUERY_LIMIT, 0);
  const counts: Record<FeedCategory, number> = { calendar: 0, fyi: 0, junk: 0 };
  for (const row of selectFeedItems(rows, now)) {
    counts[rowToFeedMention(row).category]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Sync-triggered regeneration (serialized, debounced, dirty-rerun)
// ---------------------------------------------------------------------------

let syncHandler: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let dirty = false;

async function runGeneration(getAccountId: () => string | null): Promise<void> {
  const accountId = getAccountId();
  if (!accountId) return;
  if (inFlight) {
    dirty = true;
    return;
  }
  inFlight = true;
  try {
    const brief = await generateBrief(accountId);
    if (brief) window.dispatchEvent(new Event("velo-brief-updated"));
  } catch (err) {
    console.error("Brief generation failed:", err);
  } finally {
    inFlight = false;
    if (dirty) {
      dirty = false;
      void runGeneration(getAccountId);
    }
  }
}

export function startBriefManager(getAccountId: () => string | null): void {
  stopBriefManager();
  syncHandler = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runGeneration(getAccountId);
    }, SYNC_DEBOUNCE_MS);
  };
  window.addEventListener("velo-sync-done", syncHandler);
}

export function stopBriefManager(): void {
  if (syncHandler) {
    window.removeEventListener("velo-sync-done", syncHandler);
    syncHandler = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
