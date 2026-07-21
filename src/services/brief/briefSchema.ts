/**
 * Extraction schema and defensive JSON parsing for the Brief pipeline.
 * Parsing must tolerate sloppy output (fences, surrounding prose) because
 * the pipeline is provider-agnostic and local models are less disciplined.
 */

export interface ExtractedDate {
  iso: string;
  what: string;
}

export interface ThreadExtraction {
  summary: string;
  needsYou: boolean;
  why: string | null;
  dates: ExtractedDate[];
  people: string[];
}

export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function validateExtraction(value: unknown): ThreadExtraction | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["summary"] !== "string" || typeof obj["needsYou"] !== "boolean") {
    return null;
  }

  const dates: ExtractedDate[] = [];
  if (Array.isArray(obj["dates"])) {
    for (const d of obj["dates"]) {
      if (
        typeof d === "object" && d !== null &&
        typeof (d as Record<string, unknown>)["iso"] === "string" &&
        typeof (d as Record<string, unknown>)["what"] === "string"
      ) {
        dates.push({ iso: (d as { iso: string }).iso, what: (d as { what: string }).what });
      }
    }
  }

  const people: string[] = Array.isArray(obj["people"])
    ? obj["people"].filter((p): p is string => typeof p === "string")
    : [];

  return {
    summary: obj["summary"],
    needsYou: obj["needsYou"],
    why: typeof obj["why"] === "string" ? obj["why"] : null,
    dates,
    people,
  };
}
