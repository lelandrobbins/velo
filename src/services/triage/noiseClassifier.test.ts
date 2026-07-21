import { describe, it, expect } from "vitest";
import { classifyThread, categorizeFeedThread, isSignalThread, isAutomatedAddress } from "./noiseClassifier";

const base = { fromAddress: null, subject: null, listUnsubscribe: null };

describe("isAutomatedAddress", () => {
  it("flags no-reply style addresses and passes humans", () => {
    expect(isAutomatedAddress("noreply@github.com")).toBe(true);
    expect(isAutomatedAddress("alice@example.com")).toBe(false);
  });
});

describe("classifyThread", () => {
  it("classifies plain human mail as signal", () => {
    expect(
      classifyThread({
        ...base,
        fromAddress: "alice@example.com",
        subject: "Lunch tomorrow?",
      }),
    ).toBe("signal");
  });

  it("classifies mail with a List-Unsubscribe header as feed", () => {
    expect(
      classifyThread({
        ...base,
        fromAddress: "digest@substack.com",
        subject: "This week in Rust",
        listUnsubscribe: "<https://example.com/unsub>",
      }),
    ).toBe("feed");
  });

  describe("no-reply style senders", () => {
    it.each([
      "noreply@github.com",
      "no-reply@stripe.com",
      "do-not-reply@bank.com",
      "donotreply@service.io",
      "noreply+billing@vendor.com",
      "notifications@github.com",
      "notification@linkedin.com",
      "notify@twitter.com",
      "mailer-daemon@googlemail.com",
      "postmaster@outlook.com",
      "bounce@sendgrid.net",
      "bounces+123@mailer.example.com",
      "alerts@datadoghq.com",
      "alert@pagerduty.com",
    ])("classifies %s as feed", (fromAddress) => {
      expect(classifyThread({ ...base, fromAddress, subject: "Hi" })).toBe("feed");
    });

    it("does not flag humans whose address merely contains a pattern substring", () => {
      // "renotify"/"salerts" style local parts are not automation prefixes
      expect(
        classifyThread({ ...base, fromAddress: "arnold.postman@example.com", subject: "Hey" }),
      ).toBe("signal");
      expect(
        classifyThread({ ...base, fromAddress: "annotifer@example.com", subject: "Hey" }),
      ).toBe("signal");
    });
  });

  describe("calendar invites and updates", () => {
    it.each([
      "Invitation: Design review @ Mon Jul 21",
      "Accepted: Design review @ Mon Jul 21",
      "Declined: Design review",
      "Tentatively Accepted: Standup",
      "Updated invitation: Standup @ Tue",
      "Canceled event: Standup",
      "Cancelled event: Standup",
      "Invitation from Alice Smith",
    ])("classifies subject %j as feed", (subject) => {
      expect(
        classifyThread({ ...base, fromAddress: "alice@example.com", subject }),
      ).toBe("feed");
    });

    it("classifies Google Calendar sender as feed regardless of subject", () => {
      expect(
        classifyThread({
          ...base,
          fromAddress: "calendar-notification@google.com",
          subject: "Reminder",
        }),
      ).toBe("feed");
    });

    it("does not flag subjects that merely mention an invitation mid-sentence", () => {
      expect(
        classifyThread({
          ...base,
          fromAddress: "alice@example.com",
          subject: "Did you get the invitation?",
        }),
      ).toBe("signal");
    });
  });

  it("treats missing fields as signal (never hide mail we can't judge)", () => {
    expect(classifyThread(base)).toBe("signal");
  });
});

describe("isSignalThread", () => {
  const feedFields = {
    fromAddress: "noreply@github.com",
    subject: "New issue opened",
    listUnsubscribe: "<https://example.com/unsub>",
  };

  it("pinned or starred threads are always signal, even automated ones", () => {
    expect(isSignalThread({ ...feedFields, isPinned: true, isStarred: false })).toBe(true);
    expect(isSignalThread({ ...feedFields, isPinned: false, isStarred: true })).toBe(true);
  });

  it("otherwise follows classifyThread", () => {
    expect(isSignalThread({ ...feedFields, isPinned: false, isStarred: false })).toBe(false);
    expect(
      isSignalThread({
        fromAddress: "alice@example.com",
        subject: "Lunch?",
        listUnsubscribe: null,
        isPinned: false,
        isStarred: false,
      }),
    ).toBe(true);
  });
});

describe("categorizeFeedThread", () => {
  it.each([
    "Invitation: Design review @ Mon Jul 21",
    "Updated invitation: Standup @ Tue",
    "Canceled event: Standup",
    "Accepted: Design review",
  ])("categorizes calendar subject %j as calendar", (subject) => {
    expect(
      categorizeFeedThread({ ...base, fromAddress: "alice@example.com", subject }),
    ).toBe("calendar");
  });

  it("categorizes Google Calendar sender as calendar", () => {
    expect(
      categorizeFeedThread({
        ...base,
        fromAddress: "calendar-notification@google.com",
        subject: "Reminder",
      }),
    ).toBe("calendar");
  });

  describe("fyi — automated mail that looks important", () => {
    it.each([
      "Your receipt from Anthropic",
      "Invoice #1234 is due",
      "Payment confirmation",
      "Your order has shipped",
      "Out for delivery: package #99",
      "Your verification code is 123456",
      "Security alert: new sign-in on Chrome",
      "Your password was changed",
      "Your statement is ready",
      "Action required: confirm your email",
      "Your subscription expires soon",
    ])("categorizes subject %j as fyi", (subject) => {
      expect(
        categorizeFeedThread({
          ...base,
          fromAddress: "noreply@service.com",
          subject,
          listUnsubscribe: "<https://example.com/unsub>",
        }),
      ).toBe("fyi");
    });

    it("categorizes monitoring alert senders as fyi", () => {
      expect(
        categorizeFeedThread({
          ...base,
          fromAddress: "alerts@datadoghq.com",
          subject: "CPU above threshold on web-1",
        }),
      ).toBe("fyi");
    });
  });

  describe("junk — everything else automated", () => {
    it.each([
      ["digest@substack.com", "This week in Rust"],
      ["noreply@marketing.example.com", "50% off everything this weekend!"],
      ["notifications@social.example.com", "You have 3 new followers"],
    ])("categorizes %s / %j as junk", (fromAddress, subject) => {
      expect(
        categorizeFeedThread({
          ...base,
          fromAddress,
          subject,
          listUnsubscribe: "<https://example.com/unsub>",
        }),
      ).toBe("junk");
    });
  });
});
