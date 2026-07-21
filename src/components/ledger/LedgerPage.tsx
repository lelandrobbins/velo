import { useCallback, useEffect, useState } from "react";
import { Hourglass, HandHeart, Pin, Send, Check, X } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { GenericEmptyIllustration } from "../ui/illustrations";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToThread } from "@/router/navigate";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import { getLedger, type LedgerEntry } from "@/services/ledger/ledger";
import { draftNudge } from "@/services/ledger/nudge";
import { setLedgerOverride } from "@/services/db/ledgerOverrides";

function ageLabel(e: LedgerEntry): string {
  if (e.dueAt) {
    const due = new Date(e.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return e.dueAt < Date.now() ? `overdue (${due})` : `due ${due}`;
  }
  if (e.ageDays === 0) return "today";
  return `${e.ageDays} day${e.ageDays === 1 ? "" : "s"}`;
}

/**
 * The Ledger — obligations derived from sent mail. Two lists: replies
 * you're owed and promises you made. Derivation is instant (cached
 * extractions only); actions write overrides and refresh.
 */
export function LedgerPage({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> }) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);

  const [waitingOn, setWaitingOn] = useState<LedgerEntry[]>([]);
  const [promises, setPromises] = useState<LedgerEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!activeAccountId) return;
    const ledger = await getLedger(activeAccountId, Date.now());
    setWaitingOn(ledger.waitingOn);
    setPromises(ledger.promises);
    setLoaded(true);
  }, [activeAccountId]);

  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener("velo-ledger-updated", handler);
    window.addEventListener("velo-sync-done", handler);
    return () => {
      window.removeEventListener("velo-ledger-updated", handler);
      window.removeEventListener("velo-sync-done", handler);
    };
  }, [reload]);

  // Clear stale thread list so global shortcuts can't act on invisible rows
  useEffect(() => {
    const { selectedThreadIds, threadMap } = useThreadStore.getState();
    if (selectedThreadIds.size > 0) useThreadStore.getState().clearMultiSelect();
    if (threadMap.size > 0) useThreadStore.getState().setThreads([]);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    if (!activeAccountId) return;
    const { threadMap, threads, setThreads } = useThreadStore.getState();
    if (!threadMap.has(threadId)) {
      const dbThread = await getThreadById(activeAccountId, threadId);
      if (!dbThread) return;
      const labelIds = await getThreadLabelIds(activeAccountId, threadId);
      setThreads([...threads, {
        id: dbThread.id,
        accountId: dbThread.account_id,
        subject: dbThread.subject,
        snippet: dbThread.snippet,
        lastMessageAt: dbThread.last_message_at ?? 0,
        messageCount: dbThread.message_count,
        isRead: dbThread.is_read === 1,
        isStarred: dbThread.is_starred === 1,
        isPinned: dbThread.is_pinned === 1,
        isMuted: dbThread.is_muted === 1,
        hasAttachments: dbThread.has_attachments === 1,
        labelIds,
        fromName: dbThread.from_name,
        fromAddress: dbThread.from_address,
        listUnsubscribe: dbThread.list_unsubscribe,
      }]);
    }
    navigateToThread(threadId);
  }, [activeAccountId]);

  const dismiss = useCallback(async (e: LedgerEntry) => {
    if (!activeAccountId) return;
    await setLedgerOverride(activeAccountId, e.threadId, e.kind, "dismissed");
    void reload();
  }, [activeAccountId, reload]);

  const markDone = useCallback(async (e: LedgerEntry) => {
    if (!activeAccountId) return;
    await setLedgerOverride(activeAccountId, e.threadId, e.kind, "done");
    void reload();
  }, [activeAccountId, reload]);

  // Keyboard row navigation: j/k move focus, Enter opens, n nudge,
  // d dismiss, e mark done (promises). Global shortcuts no-op here because
  // the thread store is cleared on mount, so there is no conflict.
  const [focusIdx, setFocusIdx] = useState(-1);
  const allEntries = [...waitingOn, ...promises];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const focused = focusIdx >= 0 ? allEntries[focusIdx] : undefined;
      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIdx((i) => Math.min(i + 1, allEntries.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIdx((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          if (focused) { e.preventDefault(); void openThread(focused.threadId); }
          break;
        case "n":
          if (focused?.kind === "waiting") { e.preventDefault(); void draftNudge(focused); }
          break;
        case "d":
          if (focused) { e.preventDefault(); void dismiss(focused); }
          break;
        case "e":
          if (focused?.kind === "promise") { e.preventDefault(); void markDone(focused); }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusIdx, allEntries, openThread, dismiss, markDone]);

  const focusedEntry = focusIdx >= 0 ? allEntries[focusIdx] : undefined;
  const focusedKey = focusedEntry ? `${focusedEntry.kind}-${focusedEntry.threadId}` : null;

  const renderRow = (entry: LedgerEntry) => (
    <div
      key={`${entry.kind}-${entry.threadId}`}
      className={`px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover transition-colors group flex items-center gap-3 ${
        focusedKey === `${entry.kind}-${entry.threadId}` ? "bg-bg-selected" : ""
      }`}
    >
      <button onClick={() => void openThread(entry.threadId)} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          {entry.pinned && <Pin size={12} className="text-accent shrink-0" />}
          <span className="text-sm font-medium text-text-primary truncate">
            {entry.kind === "waiting" ? (entry.counterparty ?? "Unknown") : (entry.detail ?? "Promise")}
          </span>
          <span className={`text-xs shrink-0 ${entry.dueAt && entry.dueAt < Date.now() ? "text-warning font-medium" : "text-text-tertiary"}`}>
            {ageLabel(entry)}
          </span>
        </div>
        <div className="text-xs text-text-secondary truncate">
          {entry.kind === "waiting" ? (entry.detail ?? entry.subject ?? "") : `to ${entry.counterparty ?? "someone"} — ${entry.subject ?? ""}`}
        </div>
      </button>
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {entry.kind === "waiting" && (
          <button
            onClick={() => void draftNudge(entry)}
            title="Nudge — draft a follow-up"
            className="p-1.5 text-text-secondary hover:text-accent rounded transition-colors"
          >
            <Send size={14} />
          </button>
        )}
        {entry.kind === "promise" && (
          <button
            onClick={() => void markDone(entry)}
            title="Mark done"
            className="p-1.5 text-text-secondary hover:text-success rounded transition-colors"
          >
            <Check size={14} />
          </button>
        )}
        <button
          onClick={() => void dismiss(entry)}
          title="Dismiss"
          className="p-1.5 text-text-secondary hover:text-danger rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );

  const section = (title: string, icon: React.ReactNode, entries: LedgerEntry[]) => (
    <div>
      <div className="px-4 py-2 flex items-center gap-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider bg-bg-tertiary/50 border-b border-border-secondary sticky top-0">
        {icon}
        {title}
        <span className="normal-case tracking-normal font-normal">{entries.length}</span>
      </div>
      {entries.map(renderRow)}
    </div>
  );

  return (
    <div
      ref={listRef}
      className={`flex flex-col bg-bg-secondary/50 glass-panel ${
        readingPanePosition === "right"
          ? "min-w-[240px] shrink-0"
          : readingPanePosition === "bottom"
            ? "w-full border-b border-border-primary h-[40%] min-h-[200px]"
            : "w-full flex-1"
      }`}
      style={readingPanePosition === "right" && width ? { width } : undefined}
    >
      <div className="px-5 py-4 border-b border-border-primary">
        <h1 className="text-base font-semibold text-text-primary">Ledger</h1>
        <p className="text-xs text-text-tertiary mt-0.5">
          {waitingOn.length} waiting · {promises.length} promised
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loaded && waitingOn.length === 0 && promises.length === 0 ? (
          <EmptyState
            illustration={GenericEmptyIllustration}
            title="Clean slate"
            subtitle="Nobody owes you anything, and you owe nobody."
          />
        ) : (
          <>
            {waitingOn.length > 0 && section("Waiting on", <Hourglass size={12} />, waitingOn)}
            {promises.length > 0 && section("You promised", <HandHeart size={12} />, promises)}
          </>
        )}
      </div>
    </div>
  );
}
