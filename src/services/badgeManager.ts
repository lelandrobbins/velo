import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getUnreadInboxTriageRows } from "./db/threads";
import { isSignalThread } from "./triage/noiseClassifier";

let lastCount = -1;

export async function updateBadgeCount(): Promise<void> {
  try {
    // Only Focus items count toward the badge — feed-classified mail doesn't
    const rows = await getUnreadInboxTriageRows();
    const count = rows.filter((r) =>
      isSignalThread({
        isPinned: r.is_pinned === 1,
        isStarred: r.is_starred === 1,
        fromAddress: r.from_address,
        subject: r.subject,
        listUnsubscribe: r.list_unsubscribe,
      }),
    ).length;
    if (count === lastCount) return;
    lastCount = count;

    try {
      await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
    } catch {
      // badge count may not be supported on all platforms
    }

    const tooltip = count > 0 ? `Velo - ${count} unread` : "Velo";
    try {
      await invoke("set_tray_tooltip", { tooltip });
    } catch {
      // tray tooltip update is best-effort
    }
  } catch (err) {
    console.error("Failed to update badge count:", err);
  }
}
