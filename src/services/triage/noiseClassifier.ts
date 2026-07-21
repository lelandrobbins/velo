/**
 * Deterministic noise triage — first stage of the noise engine.
 *
 * Classifies a thread as "signal" (mail from a human, shown prominently on
 * the Home landing view) or "feed" (automated mail and calendar traffic,
 * tucked into the collapsed Feed section). Rules are intentionally
 * conservative: when in doubt, classify as signal so nothing real is hidden.
 */

export type ThreadClass = "signal" | "feed";

export interface ClassifierInput {
  /** Sender address of the thread's latest message */
  fromAddress: string | null;
  /** Thread subject */
  subject: string | null;
  /** Raw List-Unsubscribe header of the latest message, if any */
  listUnsubscribe: string | null;
}

/** Local-part prefixes that indicate an automated sender. */
const AUTOMATED_LOCAL_PREFIXES = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "notification",
  "notifications",
  "notify",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
  "alert",
  "alerts",
];

/** Senders that are calendar machinery regardless of subject. */
const CALENDAR_SENDERS = [
  "calendar-notification@google.com",
  "calendar-server.bounces.google.com",
];

/** Subject prefixes used by calendar invites, replies, and updates. */
const CALENDAR_SUBJECT_PREFIXES = [
  "invitation:",
  "invitation from ",
  "updated invitation:",
  "accepted:",
  "declined:",
  "tentatively accepted:",
  "canceled event:",
  "cancelled event:",
];

export function isAutomatedAddress(address: string): boolean {
  const localPart = address.split("@")[0]?.toLowerCase() ?? "";
  return AUTOMATED_LOCAL_PREFIXES.some(
    (prefix) =>
      localPart === prefix ||
      localPart.startsWith(`${prefix}+`) ||
      localPart.startsWith(`${prefix}-`) ||
      localPart.startsWith(`${prefix}.`) ||
      localPart.startsWith(`${prefix}_`),
  );
}

function isCalendarThread(fromAddress: string | null, subject: string | null): boolean {
  if (fromAddress && CALENDAR_SENDERS.includes(fromAddress.toLowerCase())) {
    return true;
  }
  if (subject) {
    const s = subject.toLowerCase();
    if (CALENDAR_SUBJECT_PREFIXES.some((prefix) => s.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

export function classifyThread(input: ClassifierInput): ThreadClass {
  if (input.listUnsubscribe) return "feed";
  if (input.fromAddress && isAutomatedAddress(input.fromAddress)) return "feed";
  if (isCalendarThread(input.fromAddress, input.subject)) return "feed";
  return "signal";
}

export interface TriageThreadInput extends ClassifierInput {
  isPinned: boolean;
  isStarred: boolean;
}

/**
 * Thread-level signal check: pinned/starred threads are always signal —
 * the user marked them — otherwise defer to classifyThread.
 */
export function isSignalThread(input: TriageThreadInput): boolean {
  if (input.isPinned || input.isStarred) return true;
  return classifyThread(input) === "signal";
}

/** What kind of feed item a feed-classified thread is. */
export type FeedCategory = "calendar" | "fyi" | "junk";

/** Sender local-part prefixes whose automated mail still looks important. */
const FYI_SENDER_PREFIXES = ["alert", "alerts"];

/**
 * Subject cues for automated mail that looks important — transactional,
 * security, and logistics traffic rather than bulk marketing.
 */
const FYI_SUBJECT_CUES = [
  // Money
  "receipt",
  "invoice",
  "payment",
  "statement",
  "billing",
  "renewal",
  "subscription expir",
  // Security / account
  "verification code",
  "verify your",
  "security alert",
  "sign-in",
  "sign in attempt",
  "password",
  "one-time",
  "action required",
  // Logistics
  "order",
  "shipped",
  "shipping",
  "delivery",
  "delivered",
  "tracking",
];

/**
 * Categorize a thread already classified as "feed". Calendar wins over FYI;
 * anything without an importance cue is likely junk.
 */
export function categorizeFeedThread(input: ClassifierInput): FeedCategory {
  if (isCalendarThread(input.fromAddress, input.subject)) return "calendar";

  const localPart = input.fromAddress?.split("@")[0]?.toLowerCase() ?? "";
  if (FYI_SENDER_PREFIXES.some((p) => localPart === p || localPart.startsWith(`${p}+`))) {
    return "fyi";
  }

  const subject = input.subject?.toLowerCase() ?? "";
  if (subject && FYI_SUBJECT_CUES.some((cue) => subject.includes(cue))) {
    return "fyi";
  }

  return "junk";
}
