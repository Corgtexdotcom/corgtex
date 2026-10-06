import { describe, expect, it } from "vitest";
import { isSlackNudgeWindowOpen, parseSlackNudgeWindow } from "./slack-nudge-window";

const chironeWindow = {
  timeZone: "America/Toronto",
  weekdays: [1, 2, 3, 4, 5],
  startLocalTime: "09:00",
  endLocalTime: "17:00",
};

describe("Slack first-nudge window", () => {
  it("allows Monday-Friday at 09:00 inclusive and 17:00 exclusive", () => {
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T12:59:59Z"), chironeWindow)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T13:00:00Z"), chironeWindow)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T20:59:59Z"), chironeWindow)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T21:00:00Z"), chironeWindow)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-03T19:00:00Z"), chironeWindow)).toBe(false);
  });

  it("uses Toronto's DST offset for local boundaries", () => {
    expect(isSlackNudgeWindowOpen(new Date("2026-03-06T13:59:00Z"), chironeWindow)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-03-06T14:00:00Z"), chironeWindow)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-03-09T12:59:00Z"), chironeWindow)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-03-09T13:00:00Z"), chironeWindow)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-30T13:00:00Z"), chironeWindow)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-11-02T13:00:00Z"), chironeWindow)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-11-02T14:00:00Z"), chironeWindow)).toBe(true);
  });

  it("leaves other workspaces unchanged when unset and fails closed on malformed policy", () => {
    expect(isSlackNudgeWindowOpen(new Date("2026-10-03T19:00:00Z"), undefined)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-03T19:00:00Z"), { ...chironeWindow, timeZone: "EST" })).toBe(false);
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, weekdays: [1, 1] })).toThrow("Invalid Slack nudge window.");
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, endLocalTime: "09:00" })).toThrow("Invalid Slack nudge window.");
  });
});
