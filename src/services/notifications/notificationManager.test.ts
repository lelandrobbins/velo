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
});
