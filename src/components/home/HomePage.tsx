import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { Archive, CalendarDays, Info, Megaphone, type LucideIcon } from "lucide-react";
import { ThreadCard } from "../email/ThreadCard";
import { EmailListSkeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { InboxClearIllustration, NoAccountIllustration, GenericEmptyIllustration } from "../ui/illustrations";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useSelectedThreadId } from "@/hooks/useRouteNavigation";
import { navigateToThread } from "@/router/navigate";
import { getThreadsForAccount, getThreadLabelIds, type DbThread } from "@/services/db/threads";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { archiveThread, addThreadLabel } from "@/services/emailActions";
import { isSignalThread, categorizeFeedThread, type FeedCategory } from "@/services/triage/noiseClassifier";

const HOME_PAGE_SIZE = 100;
const UNDO_ARCHIVE_SECONDS = 8;

type HomeTab = "focus" | "feed";
type FeedGroups = Record<FeedCategory, Thread[]>;

const EMPTY_FEED_GROUPS: FeedGroups = { calendar: [], fyi: [], junk: [] };

const FEED_TABS: { category: FeedCategory; label: string; icon: LucideIcon; emptyText: string }[] = [
  { category: "calendar", label: "Calendar", icon: CalendarDays, emptyText: "No calendar invites" },
  { category: "fyi", label: "FYI", icon: Info, emptyText: "Nothing important pending" },
  { category: "junk", label: "Likely junk", icon: Megaphone, emptyText: "No junk right now" },
];

async function mapDbThreads(dbThreads: DbThread[]): Promise<Thread[]> {
  return Promise.all(
    dbThreads.map(async (t) => {
      const labelIds = await getThreadLabelIds(t.account_id, t.id);
      return {
        id: t.id,
        accountId: t.account_id,
        subject: t.subject,
        snippet: t.snippet,
        lastMessageAt: t.last_message_at ?? 0,
        messageCount: t.message_count,
        isRead: t.is_read === 1,
        isStarred: t.is_starred === 1,
        isPinned: t.is_pinned === 1,
        isMuted: t.is_muted === 1,
        hasAttachments: t.has_attachments === 1,
        labelIds,
        fromName: t.from_name,
        fromAddress: t.from_address,
        listUnsubscribe: t.list_unsubscribe,
      };
    }),
  );
}

/**
 * Home — the app's landing view. Two full-width tabs: Focus (mail from
 * people) and Feed (automated mail, sub-tabbed by kind). Feed tabs support
 * archive-all with an undo toast.
 */
export function HomePage({ width, listRef, banner }: { width?: number; listRef?: React.Ref<HTMLDivElement>; banner?: React.ReactNode }) {
  const threads = useThreadStore((s) => s.threads);
  const setThreads = useThreadStore((s) => s.setThreads);
  const isLoading = useThreadStore((s) => s.isLoading);
  const setLoading = useThreadStore((s) => s.setLoading);
  const clearSearch = useThreadStore((s) => s.clearSearch);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const selectedThreadId = useSelectedThreadId();
  const openMenu = useContextMenuStore((s) => s.openMenu);

  const [signalThreads, setSignalThreads] = useState<Thread[]>([]);
  const [feedGroups, setFeedGroups] = useState<FeedGroups>(EMPTY_FEED_GROUPS);
  const [activeTab, setActiveTab] = useState<HomeTab>("focus");
  const [feedTab, setFeedTab] = useState<FeedCategory>("calendar");
  const [undoIds, setUndoIds] = useState<string[] | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async () => {
    if (!activeAccountId) {
      setSignalThreads([]);
      setFeedGroups(EMPTY_FEED_GROUPS);
      return;
    }
    clearSearch();
    setLoading(true);
    try {
      const dbThreads = await getThreadsForAccount(activeAccountId, "INBOX", HOME_PAGE_SIZE, 0);
      const mapped = await mapDbThreads(dbThreads);
      const signal: Thread[] = [];
      const groups: FeedGroups = { calendar: [], fyi: [], junk: [] };
      for (const thread of mapped) {
        if (isSignalThread(thread)) {
          signal.push(thread);
        } else {
          groups[
            categorizeFeedThread({
              fromAddress: thread.fromAddress,
              subject: thread.subject,
              listUnsubscribe: thread.listUnsubscribe,
            })
          ].push(thread);
        }
      }
      setSignalThreads(signal);
      setFeedGroups(groups);
    } catch (err) {
      console.error("Failed to load home threads:", err);
    } finally {
      setLoading(false);
    }
  }, [activeAccountId, setLoading, clearSearch]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // The visible tab's list goes into the store so keyboard nav and actions work on it
  useEffect(() => {
    setThreads(activeTab === "focus" ? signalThreads : feedGroups[feedTab]);
  }, [activeTab, feedTab, signalThreads, feedGroups, setThreads]);

  // Reload on sync completion (debounced, same pattern as EmailList)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadThreads(), 500);
    };
    window.addEventListener("velo-sync-done", handler);
    return () => {
      window.removeEventListener("velo-sync-done", handler);
      if (timer) clearTimeout(timer);
    };
  }, [loadThreads]);

  // Auto-scroll selected thread into view (keyboard navigation)
  useEffect(() => {
    if (!selectedThreadId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(`[data-thread-id="${CSS.escape(selectedThreadId)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedThreadId]);

  const handleThreadClick = useCallback((thread: Thread) => {
    navigateToThread(thread.id);
  }, []);

  const handleThreadContextMenu = useCallback((e: React.MouseEvent, threadId: string) => {
    e.preventDefault();
    openMenu("thread", { x: e.clientX, y: e.clientY }, { threadId });
  }, [openMenu]);

  const dismissUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoIds(null);
  }, []);

  const handleArchiveAll = useCallback(async () => {
    if (!activeAccountId || activeTab !== "feed") return;
    // Archive what's currently visible (store reflects any prior removals)
    const ids = useThreadStore.getState().threads.map((t) => t.id);
    if (ids.length === 0) return;

    dismissUndo();
    const idSet = new Set(ids);
    setFeedGroups((prev) => ({
      ...prev,
      [feedTab]: prev[feedTab].filter((t) => !idSet.has(t.id)),
    }));
    await Promise.allSettled(ids.map((id) => archiveThread(activeAccountId, id, [])));

    setUndoIds(ids);
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      setUndoIds(null);
    }, UNDO_ARCHIVE_SECONDS * 1000);
  }, [activeAccountId, activeTab, feedTab, dismissUndo]);

  const handleUndoArchiveAll = useCallback(async () => {
    if (!activeAccountId || !undoIds) return;
    const ids = undoIds;
    dismissUndo();
    await Promise.allSettled(ids.map((id) => addThreadLabel(activeAccountId, id, "INBOX")));
    loadThreads();
  }, [activeAccountId, undoIds, dismissUndo, loadThreads]);

  // Shift+E (keyboard) → archive all in the active feed tab
  useEffect(() => {
    const handler = () => handleArchiveAll();
    window.addEventListener("velo-archive-all-feed", handler);
    return () => window.removeEventListener("velo-archive-all-feed", handler);
  }, [handleArchiveAll]);

  // Clear pending undo timer on unmount
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  const feedTotal = useMemo(
    () => feedGroups.calendar.length + feedGroups.fyi.length + feedGroups.junk.length,
    [feedGroups],
  );

  const unreadCount = signalThreads.filter((t) => !t.isRead).length;
  const headline =
    unreadCount > 0
      ? `${unreadCount} conversation${unreadCount === 1 ? "" : "s"} need${unreadCount === 1 ? "s" : ""} you`
      : "You're all caught up";

  const activeFeedTab = FEED_TABS.find((t) => t.category === feedTab)!;

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
      {banner}
      {/* Landing header */}
      <div className="px-5 pt-4 pb-3">
        <h1 className="text-base font-semibold text-text-primary">{headline}</h1>
      </div>

      {/* Focus / Feed tabs */}
      <div className="flex border-b border-border-primary">
        {([
          { tab: "focus" as HomeTab, label: "Focus", count: signalThreads.length },
          { tab: "feed" as HomeTab, label: "Feed", count: feedTotal },
        ]).map(({ tab, label, count }) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? "text-accent border-accent"
                : "text-text-secondary border-transparent hover:text-text-primary"
            }`}
          >
            {label}
            <span className="ml-1.5 text-xs text-text-tertiary">{count}</span>
          </button>
        ))}
      </div>

      {/* Feed category sub-tabs + archive all */}
      {activeTab === "feed" && (
        <div className="px-3 py-2 border-b border-border-secondary flex items-center gap-1.5">
          {FEED_TABS.map(({ category, label, icon: Icon }) => (
            <button
              key={category}
              onClick={() => setFeedTab(category)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors ${
                feedTab === category
                  ? "bg-accent-light text-accent"
                  : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <Icon size={12} />
              {label}
              <span className="text-text-tertiary">{feedGroups[category].length}</span>
            </button>
          ))}
          <button
            onClick={handleArchiveAll}
            disabled={feedGroups[feedTab].length === 0}
            title="Archive all in this tab (Shift+E)"
            className="ml-auto px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Archive size={12} />
            Archive all
          </button>
        </div>
      )}

      {/* Active list — full width */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {isLoading && threads.length === 0 ? (
          <EmailListSkeleton />
        ) : !activeAccountId ? (
          <EmptyState
            illustration={NoAccountIllustration}
            title="No account connected"
            subtitle="Add an account to get started"
          />
        ) : threads.length === 0 ? (
          activeTab === "focus" ? (
            <EmptyState
              illustration={InboxClearIllustration}
              title="You're all caught up"
              subtitle="No conversations need your attention"
            />
          ) : (
            <EmptyState
              illustration={GenericEmptyIllustration}
              title={activeFeedTab.emptyText}
            />
          )
        ) : (
          threads.map((thread) => (
            <div key={thread.id} data-thread-id={thread.id}>
              <ThreadCard
                thread={thread}
                isSelected={thread.id === selectedThreadId}
                onClick={handleThreadClick}
                onContextMenu={handleThreadContextMenu}
              />
            </div>
          ))
        )}
      </div>

      {/* Undo toast for archive-all */}
      <CSSTransition nodeRef={toastRef} in={undoIds !== null} timeout={200} classNames="toast" unmountOnExit>
        <div ref={toastRef} className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-text-primary text-bg-primary rounded-lg shadow-lg overflow-hidden">
          <div className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm">
              Archived {undoIds?.length ?? 0} conversation{(undoIds?.length ?? 0) === 1 ? "" : "s"}
            </span>
            <button
              onClick={handleUndoArchiveAll}
              className="text-sm font-medium text-accent hover:text-accent-hover underline"
            >
              Undo
            </button>
          </div>
          <div className="h-0.5 bg-white/20">
            <div
              className="h-full bg-accent rounded-full"
              style={{ animation: `countdownBar ${UNDO_ARCHIVE_SECONDS}s linear forwards` }}
            />
          </div>
        </div>
      </CSSTransition>
    </div>
  );
}
