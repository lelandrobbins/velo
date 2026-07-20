import { useMatches } from "@tanstack/react-router";

/**
 * Safely call useMatches — returns [] when no router context is available
 * (e.g. in pop-out ThreadWindow which has no RouterProvider).
 */
function useMatchesSafe() {
  try {
    return useMatches();
  } catch {
    return [];
  }
}

/**
 * Derive the active label from the current route.
 * Returns the same string format as the old uiStore.activeLabel.
 */
export function useActiveLabel(): string {
  const matches = useMatchesSafe();
  for (const match of matches) {
    if (match.routeId === "/mail/$label" || match.routeId === "/mail/$label/thread/$threadId") {
      return (match.params as { label: string }).label;
    }
    if (match.routeId === "/label/$labelId" || match.routeId === "/label/$labelId/thread/$threadId") {
      return (match.params as { labelId: string }).labelId;
    }
    if (match.routeId === "/settings/$tab" || match.routeId === "/settings") {
      return "settings";
    }
  }
  return "inbox";
}

/**
 * Get the selected thread ID from route params, or null if no thread is selected.
 */
export function useSelectedThreadId(): string | null {
  const matches = useMatchesSafe();
  for (const match of matches) {
    const params = match.params as Record<string, string>;
    if (params["threadId"]) {
      return params["threadId"];
    }
  }
  return null;
}

/**
 * Get the search query from search params.
 */
export function useSearchQuery(): string {
  const matches = useMatchesSafe();
  for (const match of matches) {
    const search = (match as { search?: Record<string, unknown> }).search;
    if (search && typeof search["q"] === "string") {
      return search["q"];
    }
  }
  return "";
}
