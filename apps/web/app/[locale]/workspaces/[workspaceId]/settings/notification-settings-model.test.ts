import { describe, expect, it } from "vitest";

import {
  activityNotificationRows,
  displayActivityNotificationChannel,
  displayNotificationChannel,
  notificationChannelOptions,
  urgentNotificationRows,
} from "./notification-settings-model";

describe("notification settings model", () => {
  it("groups high-signal alert and activity notification types", () => {
    expect(urgentNotificationRows.map((row) => row.type)).toEqual([
      "deliberation.mention",
      "advice.requested",
      "advice.reminder_due",
      "advice.reply_posted",
      "role-onboarding.assigned",
      "budget.threshold_reached",
      "action.assigned",
      "tension.assigned",
    ]);

    expect(activityNotificationRows.map((row) => row.type)).toEqual([
      "meeting.created",
      "action.created",
      "tension.created",
      "proposal.opened",
      "proposal.submitted",
    ]);
  });

  it("displays legacy BOTH rows as IN_APP_EMAIL", () => {
    expect(displayNotificationChannel("BOTH")).toBe("IN_APP_EMAIL");
    expect(displayNotificationChannel("SLACK")).toBe("SLACK");
    expect(displayNotificationChannel(null)).toBeNull();
  });

  it("displays old outbound activity overrides as in-app", () => {
    expect(displayActivityNotificationChannel("EMAIL")).toBe("IN_APP");
    expect(displayActivityNotificationChannel("BOTH")).toBe("IN_APP");
    expect(displayActivityNotificationChannel("ALL")).toBe("IN_APP");
    expect(displayActivityNotificationChannel("OFF")).toBe("OFF");
    expect(displayActivityNotificationChannel(undefined)).toBeUndefined();
  });

  it("offers all stored channel values except legacy BOTH when Slack is connected", () => {
    const options = notificationChannelOptions({
      includeUseDefault: true,
      slackConnected: true,
    });

    expect(options.map((option) => option.value)).toEqual([
      "USE_DEFAULT",
      "IN_APP",
      "EMAIL",
      "IN_APP_EMAIL",
      "SLACK",
      "IN_APP_SLACK",
      "EMAIL_SLACK",
      "ALL",
      "OFF",
    ]);
    expect(options.some((option) => option.value === "BOTH")).toBe(false);
  });

  it("gates Slack choices when Slack is not connected", () => {
    const options = notificationChannelOptions({
      includeUseDefault: false,
      slackConnected: false,
    });

    expect(options.map((option) => option.value)).toEqual([
      "IN_APP",
      "EMAIL",
      "IN_APP_EMAIL",
      "SLACK",
      "OFF",
    ]);
    expect(options.find((option) => option.value === "SLACK")).toMatchObject({
      disabled: true,
    });
  });

  it("keeps activity notifications in-app only", () => {
    const options = notificationChannelOptions({
      includeUseDefault: true,
      slackConnected: true,
      activityOnly: true,
    });

    expect(options.map((option) => option.value)).toEqual([
      "USE_DEFAULT",
      "IN_APP",
      "OFF",
    ]);
  });
});
