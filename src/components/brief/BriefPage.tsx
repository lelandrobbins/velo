import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { HomePage } from "../home/HomePage";
import { EmailListSkeleton } from "../ui/Skeleton";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useSelectedThreadId } from "@/hooks/useRouteNavigation";
import { navigateToThread, navigateToLabel, navigateToSettings } from "@/router/navigate";
import { isAiAvailable } from "@/services/ai/providerManager";
import {
  getCachedBrief,
  generateBrief,
  computeFiledToday,
  type StoredBrief,
} from "@/services/brief/briefManager";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import type { FeedCategory } from "@/services/triage/noiseClassifier";

const FIRST_RUN_SLOW_MS = 10_000;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateline(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/**
 * The Brief — Velo's landing surface. Renders the cached chief-of-staff
 * memo instantly; regenerations happen in the background via briefManager.
 */
export function BriefPage({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> }) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const selectedThreadId = useSelectedThreadId();

  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [brief, setBrief] = useState<StoredBrief | null>(null);
  const [filed, setFiled] = useState<Record<FeedCategory, number>>({ calendar: 0, fyi: 0, junk: 0 });
  const [generating, setGenerating] = useState(false);
  const [slowFirstRun, setSlowFirstRun] = useState(false);
  const [firstRunFailed, setFirstRunFailed] = useState(false);
  const attemptedAccountRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!activeAccountId) return null;
    const [cached, counts] = await Promise.all([
      getCachedBrief(activeAccountId),
      computeFiledToday(activeAccountId),
    ]);
    setBrief(cached);
    setFiled(counts);
    return cached;
  }, [activeAccountId]);

  const forceRegenerate = useCallback(async () => {
    if (!activeAccountId || generating) return;
    setGenerating(true);
    try {
      const fresh = await generateBrief(activeAccountId, { force: true });
      if (fresh) setBrief(fresh);
    } catch (err) {
      console.error("Brief refresh failed:", err);
    } finally {
      setGenerating(false);
    }
  }, [activeAccountId, generating]);

  // The reading pane resolves the selected thread only via threadStore's
  // threadMap. The memo's links reference threads that were never loaded
  // into that store (unlike HomePage's list), so hydrate the one clicked
  // thread before navigating — mirrors ContactSidebar's handleThreadClick.
  const handleMemoLinkClick = useCallback(async (threadId: string) => {
    if (!activeAccountId) return;
    const dbThread = await getThreadById(activeAccountId, threadId);
    if (!dbThread) return;
    const labelIds = await getThreadLabelIds(activeAccountId, threadId);
    useThreadStore.getState().setThreads([
      {
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
      },
    ]);
    navigateToThread(threadId);
  }, [activeAccountId]);

  // Initial load: AI availability, cached memo, first generation if none
  useEffect(() => {
    let cancelled = false;
    setSlowFirstRun(false);
    setFirstRunFailed(false);
    (async () => {
      const ready = await isAiAvailable();
      if (cancelled) return;
      setAiReady(ready);
      if (!ready || !activeAccountId) return;
      const cached = await reload();
      if (cancelled) return;
      if (!cached && attemptedAccountRef.current !== activeAccountId) {
        attemptedAccountRef.current = activeAccountId;
        const slowTimer = setTimeout(() => { if (!cancelled) setSlowFirstRun(true); }, FIRST_RUN_SLOW_MS);
        setGenerating(true);
        try {
          const fresh = await generateBrief(activeAccountId);
          if (!cancelled) {
            if (fresh) setBrief(fresh);
            else setFirstRunFailed(true);
          }
        } catch (err) {
          console.error("Initial brief generation failed:", err);
          if (!cancelled) setFirstRunFailed(true);
        } finally {
          clearTimeout(slowTimer);
          if (!cancelled) setGenerating(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeAccountId, reload]);

  // Background regenerations land here
  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener("velo-brief-updated", handler);
    return () => window.removeEventListener("velo-brief-updated", handler);
  }, [reload]);

  // Filed counts refresh on sync even when the memo is gated
  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener("velo-sync-done", handler);
    return () => window.removeEventListener("velo-sync-done", handler);
  }, [reload]);

  // F5 on this view forces a regeneration (global handler still syncs)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F5") void forceRegenerate();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [forceRegenerate]);

  // The memo view (as opposed to the HomePage fallback branches below) renders
  // its own list, so the global threadStore must not still hold another
  // view's threads — otherwise keyboard shortcuts like Ctrl+A + e would act
  // on invisible threads. This re-runs on every brief refresh (background
  // regen, sync), so skip the clear when the currently open thread (clicked
  // via handleMemoLinkClick) is already hydrated — otherwise a mid-read
  // refresh would kick the reading pane back to "Select an email to read".
  useEffect(() => {
    if (aiReady !== false && !(slowFirstRun && !brief) && !(firstRunFailed && !brief)) {
      const { threadMap, setThreads, clearMultiSelect } = useThreadStore.getState();
      if (selectedThreadId && threadMap.has(selectedThreadId)) return;
      setThreads([]);
      clearMultiSelect();
    }
  }, [aiReady, slowFirstRun, firstRunFailed, brief, selectedThreadId]);

  // No AI configured → setup card above the tabbed Home (the fallback landing view)
  if (aiReady === false) {
    return (
      <HomePage
        width={width}
        listRef={listRef}
        banner={
          <button
            onClick={() => navigateToSettings("ai")}
            className="mx-4 mt-3 px-4 py-3 rounded-lg bg-accent-light text-left flex items-center gap-3 hover:bg-accent-light/80 transition-colors"
          >
            <Sparkles size={16} className="text-accent shrink-0" />
            <span className="text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Set up your Brief.</span>{" "}
              Add an AI provider key in Settings and Velo will open with a morning memo
              of what actually needs you.
            </span>
          </button>
        }
      />
    );
  }

  // First generation failed outright (e.g. a configured provider key is
  // invalid) → tabs with an error note and a way to fix it, instead of a
  // skeleton that never resolves
  if (firstRunFailed && !brief) {
    return (
      <HomePage
        width={width}
        listRef={listRef}
        banner={
          <button
            onClick={() => navigateToSettings("ai")}
            className="mx-4 mt-3 px-4 py-3 rounded-lg bg-warning/10 text-left flex items-center gap-3 hover:bg-warning/20 transition-colors"
          >
            <AlertTriangle size={16} className="text-warning shrink-0" />
            <span className="text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Couldn&apos;t write your brief.</span>{" "}
              Check your AI provider settings. It will retry on the next sync.
            </span>
          </button>
        }
      />
    );
  }

  // First generation is taking long → show the tabs with a note
  if (slowFirstRun && !brief) {
    return (
      <HomePage
        width={width}
        listRef={listRef}
        banner={
          <div className="mx-4 mt-3 px-4 py-2 rounded-lg bg-bg-tertiary text-xs text-text-tertiary">
            Your brief is being written — it will take over this screen when ready.
          </div>
        }
      />
    );
  }

  const filedTotal = filed.calendar + filed.fyi + filed.junk;

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
      {/* Dateline + staleness chip */}
      <div className="px-6 pt-5 pb-3 flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-text-tertiary">The Brief</div>
          <h1 className="text-lg font-semibold text-text-primary">{formatDateline(new Date())}</h1>
        </div>
        {brief && (
          <button
            onClick={forceRegenerate}
            title="Refresh brief (F5)"
            className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
          >
            <RefreshCw size={12} className={generating ? "animate-spin" : ""} />
            as of {formatTime(brief.generatedAt)}
          </button>
        )}
      </div>

      {/* Memo */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {!activeAccountId ? (
          <p className="text-sm text-text-tertiary">Add an account to get started.</p>
        ) : !brief ? (
          <EmailListSkeleton />
        ) : (
          <p className="text-[15px] leading-7 text-text-primary max-w-prose">
            {brief.segments.map((seg, i) =>
              seg.type === "link" ? (
                // Anchor, not button: buttons are atomic inline-blocks that
                // can't wrap across lines, which breaks the prose flow
                <a
                  key={i}
                  role="link"
                  tabIndex={0}
                  onClick={() => void handleMemoLinkClick(seg.threadId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleMemoLinkClick(seg.threadId);
                  }}
                  className="text-accent hover:text-accent-hover underline decoration-accent/40 underline-offset-2 cursor-pointer"
                >
                  {seg.text}
                </a>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </p>
        )}
      </div>

      {/* Filed footer — deterministic receipts */}
      <div className="shrink-0 border-t border-border-primary px-6 py-3">
        {filedTotal === 0 ? (
          <span className="text-xs text-text-tertiary">Nothing filed today.</span>
        ) : (
          <button
            onClick={() => navigateToLabel("home")}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Filed today: {filedTotal} to the feed
            {" "}({filed.calendar} calendar · {filed.fyi} FYI · {filed.junk} likely junk)
          </button>
        )}
      </div>
    </div>
  );
}
