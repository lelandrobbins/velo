import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import type { FeedCategory } from "@/services/triage/noiseClassifier";
import type { ThreadExtraction } from "./briefSchema";

export interface ManifestEntry {
  threadId: string;
  extraction: ThreadExtraction;
}

export interface FeedMention {
  subject: string | null;
  fromName: string | null;
  category: FeedCategory;
}

export type MemoSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; threadId: string };

export function buildComposeRequest(
  entries: ManifestEntry[],
  feed: FeedMention[],
  dateLabel: string,
): AiCompletionRequest {
  const threadLines = entries.map((e) => {
    const x = e.extraction;
    const needs = x.needsYou ? ` NEEDS-YOU: ${x.why ?? "action required"}.` : "";
    const dates = x.dates.length
      ? ` Dates: ${x.dates.map((d) => `${d.iso} (${d.what})`).join(", ")}.`
      : "";
    return `- id=${e.threadId} :: ${x.summary}${needs}${dates}`;
  });
  const feedLines = feed.map(
    (f) => `- [${f.category}] ${f.fromName ?? "?"}: ${f.subject ?? "(no subject)"}`,
  );

  return {
    systemPrompt: [
      "You are a chief of staff writing a brief morning memo about the user's email.",
      "Style: plain confident prose, at most 180 words, no headings, no bullet lists.",
      "Order: items that need the user first, then developments, then at most one",
      "sentence about notable feed items, then at most one 'coming up' sentence",
      "built from the listed dates. If nothing needs the user, open by saying so.",
      "Reference a thread ONLY as [natural phrase](thread:THREAD_ID), using ids",
      "from the provided list. Format is exactly [text](thread:THREAD_ID).",
      "Never mention a thread id in plain text. Never invent facts not in the input.",
    ].join("\n"),
    userContent: [
      `Date: ${dateLabel}`,
      "",
      "Focus threads (id :: facts):",
      threadLines.length ? threadLines.join("\n") : "(none)",
      "",
      "Feed arrivals today (metadata only):",
      feedLines.length ? feedLines.join("\n") : "(none)",
    ].join("\n"),
    maxTokens: 400,
  };
}

const LINK_TOKEN = /\[([^\]]+)\]\(thread:([^)\s]+)\)/g;

export function parseMemoSegments(
  memo: string,
  validIds: Set<string>,
): { segments: MemoSegment[]; totalLinks: number; invalidLinks: number } {
  const segments: MemoSegment[] = [];
  let totalLinks = 0;
  let invalidLinks = 0;
  let lastIndex = 0;

  for (const match of memo.matchAll(LINK_TOKEN)) {
    const [full, text, threadId] = match;
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: "text", text: memo.slice(lastIndex, start) });
    }
    totalLinks++;
    if (threadId && validIds.has(threadId)) {
      segments.push({ type: "link", text: text ?? "", threadId });
    } else {
      invalidLinks++;
      segments.push({ type: "text", text: text ?? "" });
    }
    lastIndex = start + full.length;
  }
  if (lastIndex < memo.length) {
    segments.push({ type: "text", text: memo.slice(lastIndex) });
  }
  return { segments, totalLinks, invalidLinks };
}

export function memoIsAcceptable(totalLinks: number, invalidLinks: number): boolean {
  if (totalLinks === 0) return true;
  return invalidLinks / totalLinks <= 0.2;
}

export async function composeMemo(
  provider: AiProviderClient,
  entries: ManifestEntry[],
  feed: FeedMention[],
  dateLabel: string,
): Promise<{ memo: string; segments: MemoSegment[] } | null> {
  const request = buildComposeRequest(entries, feed, dateLabel);
  const memo = (await provider.complete(request)).trim();
  if (!memo) return null;

  const validIds = new Set(entries.map((e) => e.threadId));
  const { segments, totalLinks, invalidLinks } = parseMemoSegments(memo, validIds);
  if (!memoIsAcceptable(totalLinks, invalidLinks)) return null;
  return { memo, segments };
}
