import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { HomePage } from "../home/HomePage";
import { EmailListSkeleton } from "../ui/Skeleton";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToThread, navigateToLabel, navigateToSettings } from "@/router/navigate";
import { isAiAvailable } from "@/services/ai/providerManager";
import {
  getCachedBrief,
  generateBrief,
  computeFiledToday,
  type StoredBrief,
} from "@/services/brief/briefManager";
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

  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [brief, setBrief] = useState<StoredBrief | null>(null);
  const [filed, setFiled] = useState<Record<FeedCategory, number>>({ calendar: 0, fyi: 0, junk: 0 });
  const [generating, setGenerating] = useState(false);
  const [slowFirstRun, setSlowFirstRun] = useState(false);
  const loadedOnceRef = useRef(false);

  const reload = useCallback(async () => {
    if (!activeAccountId) return;
    const [cached, counts] = await Promise.all([
      getCachedBrief(activeAccountId),
      computeFiledToday(activeAccountId),
    ]);
    setBrief(cached);
    setFiled(counts);
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

  // Initial load: AI availability, cached memo, first generation if none
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ready = await isAiAvailable();
      if (cancelled) return;
      setAiReady(ready);
      if (!ready || !activeAccountId) return;
      await reload();
      if (cancelled) return;
      const cached = await getCachedBrief(activeAccountId);
      if (!cached && !loadedOnceRef.current) {
        loadedOnceRef.current = true;
        const slowTimer = setTimeout(() => setSlowFirstRun(true), FIRST_RUN_SLOW_MS);
        setGenerating(true);
        try {
          const fresh = await generateBrief(activeAccountId);
          if (!cancelled && fresh) setBrief(fresh);
        } catch (err) {
          console.error("Initial brief generation failed:", err);
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
                <button
                  key={i}
                  onClick={() => navigateToThread(seg.threadId)}
                  className="text-accent hover:text-accent-hover underline decoration-accent/40 underline-offset-2"
                >
                  {seg.text}
                </button>
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
