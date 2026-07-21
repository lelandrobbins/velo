import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LedgerPage } from "./LedgerPage";
import { useAccountStore } from "@/stores/accountStore";

const waitingEntry = {
  threadId: "t1", kind: "waiting" as const, subject: "Venue",
  counterparty: "Alice Chen", counterpartyAddress: "alice@example.com", detail: "confirm venue", ageDays: 6,
  sinceAt: 1, dueAt: null, pinned: false,
};

vi.mock("@/services/ledger/ledger", () => ({
  getLedger: vi.fn(() => Promise.resolve({ waitingOn: [waitingEntry], promises: [] })),
}));
vi.mock("@/services/ledger/nudge", () => ({ draftNudge: vi.fn() }));
const mockComposerState = { isOpen: false };
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => mockComposerState },
}));
vi.mock("@/services/db/ledgerOverrides", () => ({ setLedgerOverride: vi.fn() }));
vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(() => Promise.resolve(undefined)),
  getThreadLabelIds: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/router/navigate", () => ({ navigateToThread: vi.fn() }));
vi.mock("@/hooks/useRouteNavigation", () => ({ useSelectedThreadId: () => null }));

import { setLedgerOverride } from "@/services/db/ledgerOverrides";
import { draftNudge } from "@/services/ledger/nudge";

describe("LedgerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComposerState.isOpen = false;
    useAccountStore.setState({
      accounts: [{ id: "acc-1", email: "me@x.com", displayName: null, avatarUrl: null, isActive: true }],
      activeAccountId: "acc-1",
    });
  });

  it("renders waiting entries with counterparty and age", async () => {
    render(<LedgerPage />);
    expect(await screen.findByText("Alice Chen")).toBeInTheDocument();
    expect(screen.getByText("6 days")).toBeInTheDocument();
  });

  it("dismiss writes an override", async () => {
    render(<LedgerPage />);
    await screen.findByText("Alice Chen");
    fireEvent.click(screen.getByTitle("Dismiss"));
    await waitFor(() => {
      expect(vi.mocked(setLedgerOverride)).toHaveBeenCalledWith("acc-1", "t1", "waiting", "dismissed");
    });
  });

  it("nudge calls draftNudge with the entry", async () => {
    render(<LedgerPage />);
    await screen.findByText("Alice Chen");
    fireEvent.click(screen.getByTitle("Nudge — draft a follow-up"));
    expect(vi.mocked(draftNudge)).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" }));
  });

  it("ignores list keys while the composer is open", async () => {
    render(<LedgerPage />);
    await screen.findByText("Alice Chen");
    fireEvent.keyDown(window, { key: "j" }); // focus the first row
    mockComposerState.isOpen = true;
    fireEvent.keyDown(window, { key: "d" });
    expect(vi.mocked(setLedgerOverride)).not.toHaveBeenCalled();
  });
});
