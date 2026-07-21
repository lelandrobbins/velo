import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("@/services/db/aiCache", () => ({ getAiCache: vi.fn() }));
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: vi.fn(() => Promise.resolve(true)),
  getActiveProvider: vi.fn(() => Promise.resolve({ complete: vi.fn() })),
}));
vi.mock("./candidates", () => ({ getRecordCandidates: vi.fn() }));
vi.mock("@/services/ledger/ledger", () => ({ getOwnerEmail: vi.fn(() => Promise.resolve("me@x.com")) }));
vi.mock("./extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extractor")>()),
  extractThreadRecords: vi.fn(() => Promise.resolve({ records: [], suppressed: [] })),
  ensureThreadMaterialized: vi.fn(() => Promise.resolve(false)),
}));

import { getSetting, setSetting } from "@/services/db/settings";
import { getAiCache } from "@/services/db/aiCache";
import { isAiAvailable } from "@/services/ai/providerManager";
import { getRecordCandidates } from "./candidates";
import { extractThreadRecords, ensureThreadMaterialized } from "./extractor";
import {
  ensureVaultFloor,
  getVaultFloor,
  refreshRecordExtractions,
  RECORDS_BATCH_SIZE,
} from "./recordsManager";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

function candidate(i: number) {
  return { threadId: `t${i}`, subject: "Receipt", lastMessageAt: NOW - i, messageCount: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAiAvailable).mockResolvedValue(true);
  vi.mocked(getSetting).mockResolvedValue(String(NOW - 90 * DAY));
  vi.mocked(getAiCache).mockResolvedValue(null);
  vi.mocked(getRecordCandidates).mockResolvedValue([]);
  vi.mocked(extractThreadRecords).mockResolvedValue({ records: [], suppressed: [] });
});

describe("vault floor", () => {
  it("reads an existing floor", async () => {
    expect(await getVaultFloor("a1")).toBe(NOW - 90 * DAY);
    expect(vi.mocked(getSetting)).toHaveBeenCalledWith("records_vault_floor:a1");
  });

  it("returns null for missing or malformed floors", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await getVaultFloor("a1")).toBeNull();
    vi.mocked(getSetting).mockResolvedValue("not-a-number");
    expect(await getVaultFloor("a1")).toBeNull();
  });

  it("stamps now - 90 days exactly once", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    const floor = await ensureVaultFloor("a1", NOW);
    expect(floor).toBe(NOW - 90 * DAY);
    expect(vi.mocked(setSetting)).toHaveBeenCalledWith(
      "records_vault_floor:a1",
      String(NOW - 90 * DAY),
    );
  });

  it("never moves an existing floor", async () => {
    const floor = await ensureVaultFloor("a1", NOW + 5 * DAY);
    expect(floor).toBe(NOW - 90 * DAY);
    expect(vi.mocked(setSetting)).not.toHaveBeenCalled();
  });
});

describe("refreshRecordExtractions", () => {
  it("does nothing without AI", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    expect(await refreshRecordExtractions("a1")).toBe(0);
    expect(vi.mocked(getRecordCandidates)).not.toHaveBeenCalled();
  });

  it("passes the owner email into candidate selection", async () => {
    await refreshRecordExtractions("a1");
    expect(vi.mocked(getRecordCandidates)).toHaveBeenCalledWith("a1", "me@x.com", NOW - 90 * DAY);
  });

  it("extracts only stale candidates", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue([candidate(1), candidate(2)]);
    // t1 fresh, t2 stale
    vi.mocked(getAiCache).mockImplementation((_a, threadId) =>
      Promise.resolve(
        threadId === "t1"
          ? JSON.stringify({ stateKey: `${NOW - 1}:1`, records: [], suppressed: [] })
          : null,
      ),
    );
    expect(await refreshRecordExtractions("a1")).toBe(1);
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledTimes(1);
  });

  it("caps a pass at RECORDS_BATCH_SIZE stale threads", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue(
      Array.from({ length: RECORDS_BATCH_SIZE + 15 }, (_, i) => candidate(i)),
    );
    await refreshRecordExtractions("a1");
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledTimes(RECORDS_BATCH_SIZE);
  });

  it("heals fresh candidates whose materialization is missing, without provider calls", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue([candidate(1), candidate(2)]);
    // t1 fresh (heal path), t2 stale (extraction path)
    vi.mocked(getAiCache).mockImplementation((_a, threadId) =>
      Promise.resolve(
        threadId === "t1"
          ? JSON.stringify({ stateKey: `${NOW - 1}:1`, records: [], suppressed: [] })
          : null,
      ),
    );
    vi.mocked(ensureThreadMaterialized).mockResolvedValue(true);
    await refreshRecordExtractions("a1");
    expect(vi.mocked(ensureThreadMaterialized)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureThreadMaterialized)).toHaveBeenCalledWith(
      "a1", expect.objectContaining({ threadId: "t1" }),
    );
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractThreadRecords)).toHaveBeenCalledWith(
      expect.anything(), "a1", expect.objectContaining({ threadId: "t2" }),
    );
  });

  it("counts only successful extractions", async () => {
    vi.mocked(getRecordCandidates).mockResolvedValue([candidate(1), candidate(2)]);
    vi.mocked(extractThreadRecords)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ records: [], suppressed: [] });
    expect(await refreshRecordExtractions("a1")).toBe(1);
  });
});
