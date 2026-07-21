import { shouldNotifyForMessage } from "./notificationManager";

describe("shouldNotifyForMessage", () => {
  it("notifies for everything when smart notifications are off", () => {
    expect(shouldNotifyForMessage(false, new Set(), "someone@example.com")).toBe(true);
    expect(shouldNotifyForMessage(false, new Set(["vip@example.com"]), "someone@example.com")).toBe(true);
    expect(shouldNotifyForMessage(false, new Set())).toBe(true);
  });

  it("notifies for everything when smart is on but no VIPs are configured", () => {
    expect(shouldNotifyForMessage(true, new Set(), "someone@example.com")).toBe(true);
    expect(shouldNotifyForMessage(true, new Set())).toBe(true);
  });

  it("notifies only VIP senders when smart is on and VIPs are configured", () => {
    const vips = new Set(["vip@example.com"]);
    expect(shouldNotifyForMessage(true, vips, "vip@example.com")).toBe(true);
    expect(shouldNotifyForMessage(true, vips, "VIP@Example.com")).toBe(true); // case-insensitive match
    expect(shouldNotifyForMessage(true, vips, "someone-else@example.com")).toBe(false);
    expect(shouldNotifyForMessage(true, vips)).toBe(false); // no fromAddress at all
  });

  describe("feed suppression — only Focus items notify", () => {
    it("suppresses feed-classified mail (List-Unsubscribe header)", () => {
      expect(
        shouldNotifyForMessage(false, new Set(), "digest@substack.com", {
          subject: "This week in Rust",
          listUnsubscribe: "<https://example.com/unsub>",
        }),
      ).toBe(false);
    });

    it("suppresses feed-classified mail (no-reply sender)", () => {
      expect(
        shouldNotifyForMessage(false, new Set(), "noreply@github.com", {
          subject: "New issue opened",
          listUnsubscribe: null,
        }),
      ).toBe(false);
    });

    it("suppresses calendar invites", () => {
      expect(
        shouldNotifyForMessage(false, new Set(), "alice@example.com", {
          subject: "Invitation: Design review @ Mon Jul 21",
          listUnsubscribe: null,
        }),
      ).toBe(false);
    });

    it("still notifies for human mail", () => {
      expect(
        shouldNotifyForMessage(false, new Set(), "alice@example.com", {
          subject: "Lunch tomorrow?",
          listUnsubscribe: null,
        }),
      ).toBe(true);
    });

    it("VIP senders always notify, even when their mail classifies as feed", () => {
      const vips = new Set(["noreply@github.com"]);
      expect(
        shouldNotifyForMessage(true, vips, "noreply@github.com", {
          subject: "New issue opened",
          listUnsubscribe: "<https://example.com/unsub>",
        }),
      ).toBe(true);
    });

    it("without triage info behaves as before (notifies)", () => {
      expect(shouldNotifyForMessage(false, new Set(), "noreply@github.com")).toBe(true);
    });
  });
});
