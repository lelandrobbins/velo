import { useCallback, useEffect, useRef, useState } from "react";
import {
  Vault,
  ShoppingBag,
  Plane,
  FileText,
  CalendarCheck,
  Paperclip,
  Copy,
  X,
  Search,
} from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { GenericEmptyIllustration } from "../ui/illustrations";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToThread, navigateToSettings } from "@/router/navigate";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import { isAiAvailable } from "@/services/ai/providerManager";
import {
  listRecords,
  countRecords,
  type DbRecord,
  type RecordKind,
  type ReferenceNumber,
} from "@/services/records/records";
import { suppressRecord } from "@/services/records/extractor";
import { getVaultFloor } from "@/services/records/recordsManager";
import { askVault, type AskOutcome } from "@/services/records/ask";

const KIND_ICONS: Record<RecordKind, typeof ShoppingBag> = {
  purchase: ShoppingBag,
  travel: Plane,
  statement: FileText,
  appointment: CalendarCheck,
};

const KIND_CHIPS: { value: RecordKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "purchase", label: "Purchases" },
  { value: "travel", label: "Travel" },
  { value: "statement", label: "Statements" },
  { value: "appointment", label: "Appointments" },
];

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function recordDateLabel(r: DbRecord): string {
  const t = r.record_date ?? r.source_message_date;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The Records Vault — receipts, confirmations, statements, and appointments
 * extracted from feed mail. Ask box on top (explicit provider call on Enter);
 * deterministic browsable list below. List reads are pure SQL — opening the
 * view never waits on a model.
 */
export function VaultPage({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> }) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);

  const [records, setRecords] = useState<DbRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [floor, setFloor] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<RecordKind | "all">("all");
  const [loaded, setLoaded] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskOutcome | null>(null);

  // Guards against a stale reload/ask (e.g. in flight when the active account
  // or filter changes) landing after a newer one already resolved — mirrors
  // LedgerPage's ref-guard pattern.
  const kindFilterRef = useRef(kindFilter);
  kindFilterRef.current = kindFilter;

  const reload = useCallback(async () => {
    if (!activeAccountId) return;
    const requestedAccountId = activeAccountId;
    const requestedKindFilter = kindFilter;
    const kinds = kindFilter === "all" ? undefined : [kindFilter];
    const [rows, count, vaultFloor] = await Promise.all([
      listRecords(requestedAccountId, kinds),
      countRecords(requestedAccountId),
      getVaultFloor(requestedAccountId),
    ]);
    if (useAccountStore.getState().activeAccountId !== requestedAccountId) return;
    if (kindFilterRef.current !== requestedKindFilter) return;
    setRecords(rows);
    setTotal(count);
    setFloor(vaultFloor);
    setLoaded(true);
  }, [activeAccountId, kindFilter]);

  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    void isAiAvailable().then(setAiReady);
  }, []);

  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener("velo-records-updated", handler);
    return () => window.removeEventListener("velo-records-updated", handler);
  }, [reload]);

  // Clear stale thread list so global shortcuts can't act on invisible rows
  useEffect(() => {
    const { selectedThreadIds, threadMap } = useThreadStore.getState();
    if (selectedThreadIds.size > 0) useThreadStore.getState().clearMultiSelect();
    if (threadMap.size > 0) useThreadStore.getState().setThreads([]);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    if (!activeAccountId) return;
    const { threadMap, setThreads } = useThreadStore.getState();
    if (threadMap.has(threadId)) {
      setThreads([threadMap.get(threadId)!]);
    } else {
      const dbThread = await getThreadById(activeAccountId, threadId);
      if (!dbThread) return;
      const labelIds = await getThreadLabelIds(activeAccountId, threadId);
      setThreads([{
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

  const ask = useCallback(async () => {
    if (!activeAccountId || !question.trim() || asking) return;
    const requestedAccountId = activeAccountId;
    setAsking(true);
    setAskResult(null);
    try {
      const result = await askVault(requestedAccountId, question.trim());
      if (useAccountStore.getState().activeAccountId !== requestedAccountId) return;
      setAskResult(result);
    } catch (err) {
      console.error("Ask failed:", err);
      if (useAccountStore.getState().activeAccountId !== requestedAccountId) return;
      setAskResult({ status: "bad-question" });
    } finally {
      if (useAccountStore.getState().activeAccountId === requestedAccountId) setAsking(false);
    }
  }, [activeAccountId, question, asking]);

  // Reset ask state when the active account changes so a stale question/answer
  // from the previous account never lingers in view.
  useEffect(() => {
    setQuestion("");
    setAskResult(null);
    setAsking(false);
  }, [activeAccountId]);

  const notARecord = useCallback(async (r: DbRecord) => {
    if (!activeAccountId) return;
    await suppressRecord(activeAccountId, r);
    void reload();
  }, [activeAccountId, reload]);

  const copyRef = useCallback((value: string) => {
    void navigator.clipboard.writeText(value);
  }, []);

  const floorLabel = floor
    ? new Date(floor).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  const renderRow = (r: DbRecord) => {
    const Icon = KIND_ICONS[r.kind] ?? FileText;
    const refs = parseJsonArray<ReferenceNumber>(r.reference_numbers);
    const attachments = parseJsonArray<string>(r.attachment_names);
    return (
      <div
        key={r.id}
        className="px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover transition-colors group flex items-center gap-3"
      >
        <Icon size={16} className="text-text-tertiary shrink-0" />
        <button onClick={() => void openThread(r.thread_id)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">
              {r.vendor && <span className="text-text-tertiary font-normal">{r.vendor} — </span>}
              {r.title}
            </span>
            {r.amount && (
              <span className="text-xs text-text-secondary shrink-0">{r.amount}</span>
            )}
            <span className="text-xs text-text-tertiary shrink-0">{recordDateLabel(r)}</span>
            {attachments.length > 0 && (
              <span title={attachments.join(", ")} className="shrink-0">
                <Paperclip size={12} className="text-text-tertiary" />
              </span>
            )}
          </div>
          {r.details && (
            <div className="text-xs text-text-secondary truncate">{r.details}</div>
          )}
        </button>
        <div className="shrink-0 flex items-center gap-1">
          {refs.map((ref) => (
            <button
              key={`${ref.label}-${ref.value}`}
              onClick={() => copyRef(ref.value)}
              title={`Copy ${ref.value}`}
              className="hidden md:flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-text-secondary bg-bg-tertiary rounded hover:text-accent transition-colors"
            >
              <Copy size={10} />
              {ref.label} {ref.value}
            </button>
          ))}
          <button
            onClick={() => void notARecord(r)}
            title="Not a record"
            className="p-1.5 text-text-secondary hover:text-danger rounded transition-colors opacity-0 group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  };

  const renderAskResult = () => {
    if (!askResult) return null;
    if (askResult.status === "no-match") {
      return (
        <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Nothing in the vault matched that — try the list below.
        </div>
      );
    }
    if (askResult.status === "bad-question") {
      return (
        <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Couldn't understand that question — try rephrasing it.
        </div>
      );
    }
    return (
      <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-accent-light/40 border border-border-secondary">
        <p className="text-sm text-text-primary">{askResult.answer}</p>
        {askResult.sources.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {askResult.sources.map((s) => (
              <button
                key={s.id}
                onClick={() => void openThread(s.thread_id)}
                className="text-left text-xs text-accent hover:underline truncate"
              >
                {s.vendor && <span className="text-text-tertiary font-normal">{s.vendor} — </span>}
                {s.title} · {recordDateLabel(s)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

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
        <h1 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Vault size={16} />
          Vault
        </h1>
        <p className="text-xs text-text-tertiary mt-0.5">
          {total} record{total === 1 ? "" : "s"}
          {floorLabel ? ` since ${floorLabel}` : ""}
        </p>
      </div>

      {aiReady === false ? (
        <div className="m-4 px-4 py-3 rounded-lg bg-bg-tertiary/60 text-sm text-text-secondary">
          Add an AI provider key in{" "}
          <button onClick={() => navigateToSettings("ai")} className="text-accent hover:underline">
            Settings
          </button>{" "}
          and Velo will start filing receipts, confirmations, and statements here.
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary/60 border border-border-secondary focus-within:border-accent transition-colors">
              <Search size={14} className="text-text-tertiary shrink-0" />
              <input
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  if (e.target.value === "") setAskResult(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void ask();
                  if (e.key === "Escape") {
                    setQuestion("");
                    setAskResult(null);
                  }
                }}
                placeholder="Ask your archive — “what's my United confirmation number?”"
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
              {asking && <span className="text-xs text-text-tertiary shrink-0">thinking…</span>}
            </div>
          </div>
          {renderAskResult()}
          <div className="px-4 py-2 flex items-center gap-1.5 flex-wrap">
            {KIND_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setKindFilter(chip.value)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  kindFilter === chip.value
                    ? "bg-accent text-white border-accent"
                    : "text-text-secondary border-border-secondary hover:bg-bg-hover"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto">
        {loaded && records.length === 0 && aiReady !== false ? (
          <EmptyState
            illustration={GenericEmptyIllustration}
            title="No records yet"
            subtitle={
              total === 0
                ? "Indexing your mail — records appear over the next few sync cycles."
                : "Nothing matches this filter."
            }
          />
        ) : (
          records.map(renderRow)
        )}
      </div>
    </div>
  );
}
