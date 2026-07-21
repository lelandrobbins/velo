import type { DbThread } from "@/services/db/threads";
import { isSignalThread } from "@/services/triage/noiseClassifier";

export const FOCUS_WINDOW_HOURS = 48;
export const FOCUS_WINDOW_CAP = 30;
export const FEED_WINDOW_HOURS = 24;
export const FEED_CAP = 20;

function rowIsSignal(row: DbThread): boolean {
  return isSignalThread({
    isPinned: row.is_pinned === 1,
    isStarred: row.is_starred === 1,
    fromAddress: row.from_address,
    subject: row.subject,
    listUnsubscribe: row.list_unsubscribe,
  });
}

/** Focus threads worth extracting: unread, or active within the window. */
export function selectFocusWindow(rows: DbThread[], now: number): DbThread[] {
  const cutoff = now - FOCUS_WINDOW_HOURS * 3_600_000;
  return rows
    .filter((r) => rowIsSignal(r))
    .filter((r) => r.is_read === 0 || (r.last_message_at ?? 0) >= cutoff)
    .sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))
    .slice(0, FOCUS_WINDOW_CAP);
}

/** Feed threads mentioned to the composer: subject+sender only, recent, capped. */
export function selectFeedItems(rows: DbThread[], now: number): DbThread[] {
  const cutoff = now - FEED_WINDOW_HOURS * 3_600_000;
  return rows
    .filter((r) => !rowIsSignal(r))
    .filter((r) => (r.last_message_at ?? 0) >= cutoff)
    .sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))
    .slice(0, FEED_CAP);
}

export function threadStateKey(row: { last_message_at: number | null; message_count: number }): string {
  return `${row.last_message_at ?? 0}:${row.message_count}`;
}

/** Order-independent djb2 hash of the manifest (threadId+stateKey pairs). */
export function manifestHash(entries: { threadId: string; stateKey: string }[]): string {
  const joined = entries
    .map((e) => `${e.threadId}=${e.stateKey}`)
    .sort()
    .join("|");
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
