import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPage } from "./VaultPage";
import { useAccountStore } from "@/stores/accountStore";
import type { DbRecord } from "@/services/records/records";

const purchase: DbRecord = {
  id: "r1", account_id: "acc-1", thread_id: "t1", kind: "purchase",
  vendor: "Fully", title: "Standing desk order", record_date: 1_780_000_000_000,
  amount: "$729.00", reference_numbers: '[{"label":"Order #","value":"F-118272"}]',
  details: "Jarvis desk", attachment_names: '["invoice.pdf"]',
  source_message_date: 1_780_000_000_000, created_at: 1,
};

vi.mock("@/services/records/records", () => ({
  RECORD_KINDS: ["purchase", "travel", "statement", "appointment"],
  listRecords: vi.fn(() => Promise.resolve([purchase])),
  countRecords: vi.fn(() => Promise.resolve(1)),
}));
vi.mock("@/services/records/extractor", () => ({ suppressRecord: vi.fn() }));
vi.mock("@/services/records/recordsManager", () => ({
  getVaultFloor: vi.fn(() => Promise.resolve(1_772_000_000_000)),
}));
vi.mock("@/services/records/ask", () => ({
  askVault: vi.fn(() =>
    Promise.resolve({ status: "answered", answer: "Order F-118272.", sources: [purchase] }),
  ),
}));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(() => Promise.resolve(undefined)),
  getThreadLabelIds: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  navigateToSettings: vi.fn(),
  navigateToLabel: vi.fn(),
}));

import { listRecords } from "@/services/records/records";
import { suppressRecord } from "@/services/records/extractor";
import { askVault, type AskOutcome } from "@/services/records/ask";
import { isAiAvailable } from "@/services/ai/providerManager";

describe("VaultPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    useAccountStore.setState({
      accounts: [{ id: "acc-1", email: "me@x.com", displayName: null, avatarUrl: null, isActive: true }],
      activeAccountId: "acc-1",
    });
  });

  it("renders records with vendor, title, amount, and copyable references", async () => {
    render(<VaultPage />);
    expect(await screen.findByText("Standing desk order")).toBeInTheDocument();
    expect(screen.getByText("$729.00")).toBeInTheDocument();
    expect(screen.getByText("Order # F-118272")).toBeInTheDocument();
  });

  it("filters by kind when a chip is clicked", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    await waitFor(() => {
      expect(vi.mocked(listRecords)).toHaveBeenLastCalledWith("acc-1", ["travel"]);
    });
  });

  it("asks the vault on Enter and renders the answer with sources", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    const box = screen.getByPlaceholderText(/ask your archive/i);
    fireEvent.change(box, { target: { value: "desk order number?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Order F-118272.")).toBeInTheDocument();
    expect(vi.mocked(askVault)).toHaveBeenCalledWith("acc-1", "desk order number?");
  });

  it("suppresses a record via Not a record", async () => {
    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    fireEvent.click(screen.getByTitle("Not a record"));
    await waitFor(() => {
      expect(vi.mocked(suppressRecord)).toHaveBeenCalledWith(
        "acc-1", expect.objectContaining({ id: "r1" }),
      );
    });
  });

  it("discards a stale ask result when the active account changes before it resolves", async () => {
    let resolveAsk: ((v: AskOutcome) => void) | undefined;
    const pending = new Promise<AskOutcome>((resolve) => {
      resolveAsk = resolve;
    });
    vi.mocked(askVault).mockReturnValue(pending);

    render(<VaultPage />);
    await screen.findByText("Standing desk order");
    const box = screen.getByPlaceholderText(/ask your archive/i);
    fireEvent.change(box, { target: { value: "desk order number?" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // Switch the active account while the ask is still in flight.
    useAccountStore.setState({ activeAccountId: "acc-2" });

    resolveAsk?.({ status: "answered", answer: "Order F-118272.", sources: [purchase] });
    await pending;
    await waitFor(() => {
      expect(screen.queryByText("Order F-118272.")).not.toBeInTheDocument();
    });
  });

  it("shows the AI setup pointer when no provider is configured", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    render(<VaultPage />);
    expect(await screen.findByText(/add an ai provider/i)).toBeInTheDocument();
  });
});
