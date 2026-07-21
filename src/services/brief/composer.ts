import type { AiProviderClient, AiCompletionRequest } from "@/services/ai/types";
import type { FeedCategory } from "@/services/triage/noiseClassifier";
import type { ObligationLine } from "@/services/ledger/obligationLines";
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
  | { type: "bold"; text: string }
  | { type: "link"; text: string; threadId: string };

export type MemoBlock =
  | { type: "paragraph"; segments: MemoSegment[] }
  | { type: "list"; items: MemoSegment[][] };

export function buildComposeRequest(
  entries: ManifestEntry[],
  feed: FeedMention[],
  dateLabel: string,
  obligations: ObligationLine[],
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
      "Style: plain confident and friendly prose, to the point, bullets ok when needed.",
      "Order: items that need the user first, then developments, then at most one",
      "sentence about notable feed items, then at most one 'coming up' sentence",
      "built from the listed dates. If nothing needs the user, open by saying so.",
      "Reference a thread ONLY as [natural phrase](thread:THREAD_ID), using ids",
      "from the provided list. Format is exactly [text](thread:THREAD_ID).",
      "Never mention a thread id in plain text. Never invent facts not in the input.",
      "Obligations may be woven in naturally where they matter; do not enumerate them all.",
    ].join("\n"),
    userContent: [
      `Date: ${dateLabel}`,
      "",
      "Focus threads (id :: facts):",
      threadLines.length ? threadLines.join("\n") : "(none)",
      "",
      "Feed arrivals today (metadata only):",
      feedLines.length ? feedLines.join("\n") : "(none)",
      "",
      "Obligations (id :: fact):",
      obligations.length
        ? obligations.map((o) => `- id=${o.threadId} :: ${o.line}`).join("\n")
        : "(none)",
    ].join("\n"),
    maxTokens: 400,
  };
}

const LINK_TOKEN = /\[([^\]]+)\]\(thread:([^)\s]+)\)/g;
const BOLD_TOKEN = /\*\*([^*]+)\*\*/g;

/** Split a plain-text run into text/bold segments. */
function splitBold(text: string): MemoSegment[] {
  const segments: MemoSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(BOLD_TOKEN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, start) });
    }
    segments.push({ type: "bold", text: match[1] ?? "" });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }
  return segments;
}

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
      segments.push(...splitBold(memo.slice(lastIndex, start)));
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
    segments.push(...splitBold(memo.slice(lastIndex)));
  }
  return { segments, totalLinks, invalidLinks };
}

const BULLET_LINE = /^[-*]\s+/;
const HEADING_LINE = /^#{1,6}\s+/;

/**
 * Parse the memo into paragraph and list blocks (a constrained markdown
 * subset: blank-line paragraphs, "-"/"*" bullets, **bold**, thread links).
 * External markdown links are NOT rendered as links — only validated
 * [text](thread:ID) tokens become navigable, everything else stays text.
 */
export function parseMemoBlocks(
  memo: string,
  validIds: Set<string>,
): { blocks: MemoBlock[]; totalLinks: number; invalidLinks: number } {
  const blocks: MemoBlock[] = [];
  let totalLinks = 0;
  let invalidLinks = 0;
  let paragraphLines: string[] = [];

  const parseInline = (text: string): MemoSegment[] => {
    const parsed = parseMemoSegments(text, validIds);
    totalLinks += parsed.totalLinks;
    invalidLinks += parsed.invalidLinks;
    return parsed.segments;
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const segments = parseInline(paragraphLines.join(" "));
    if (segments.length > 0) blocks.push({ type: "paragraph", segments });
    paragraphLines = [];
  };

  for (const rawLine of memo.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
    } else if (BULLET_LINE.test(line)) {
      flushParagraph();
      const item = parseInline(line.replace(BULLET_LINE, ""));
      const last = blocks[blocks.length - 1];
      if (last?.type === "list") {
        last.items.push(item);
      } else {
        blocks.push({ type: "list", items: [item] });
      }
    } else if (HEADING_LINE.test(line)) {
      flushParagraph();
      blocks.push({
        type: "paragraph",
        segments: [{ type: "bold", text: line.replace(HEADING_LINE, "") }],
      });
    } else {
      paragraphLines.push(line);
    }
  }
  flushParagraph();

  return { blocks, totalLinks, invalidLinks };
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
  obligations: ObligationLine[],
): Promise<{ memo: string; blocks: MemoBlock[] } | null> {
  const request = buildComposeRequest(entries, feed, dateLabel, obligations);
  const memo = (await provider.complete(request)).trim();
  if (!memo) return null;

  const validIds = new Set([
    ...entries.map((e) => e.threadId),
    ...obligations.map((o) => o.threadId),
  ]);
  const { blocks, totalLinks, invalidLinks } = parseMemoBlocks(memo, validIds);
  if (!memoIsAcceptable(totalLinks, invalidLinks)) return null;
  return { memo, blocks };
}
