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
    expect(isSlackNudgeWindowOpen(new Date("2026-10-03T19:00:00Z"), { ...chironeWindow, timeZone: "Invalid/Place" })).toBe(false);
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, weekdays: [1, 1] })).toThrow("Invalid Slack nudge window.");
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, endLocalTime: "09:00" })).toThrow("Invalid Slack nudge window.");
  });

  it("rejects windows shorter than the hourly scan cadence", () => {
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, startLocalTime: "09:15", endLocalTime: "09:45" }))
      .toThrow("Slack nudge windows must last at least one hour.");
    expect(parseSlackNudgeWindow({ ...chironeWindow, startLocalTime: "09:15", endLocalTime: "10:15" }))
      .toMatchObject({ startLocalTime: "09:15", endLocalTime: "10:15" });
  });

  it.each(["Etc/UTC", "US/Eastern", "Etc/GMT+5", "Asia/Kathmandu", "CET", "GB", "Japan", "EST"])("accepts runtime-supported IANA identifier %s", (timeZone) => {
    expect(parseSlackNudgeWindow({ ...chironeWindow, timeZone })?.timeZone).toBe(timeZone);
  });

  it.each([
    ["CET", "2026-10-05T07:00:00Z"],
    ["GB", "2026-10-05T08:00:00Z"],
    ["Japan", "2026-10-05T00:00:00Z"],
  ])("evaluates the local boundary for %s", (timeZone, instant) => {
    const window = { ...chironeWindow, timeZone };
    expect(isSlackNudgeWindowOpen(new Date(Date.parse(instant) - 1), window)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date(instant), window)).toBe(true);
  });

  it("admits an hourly UTC scan inside a one-hour window in a quarter-hour-offset zone", () => {
    const window = { ...chironeWindow, timeZone: "Asia/Kathmandu", startLocalTime: "09:15", endLocalTime: "10:15" };
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T03:00:00Z"), window)).toBe(false);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T04:00:00Z"), window)).toBe(true);
    expect(isSlackNudgeWindowOpen(new Date("2026-10-05T05:00:00Z"), window)).toBe(false);
  });

  it("rejects an unknown IANA identifier", () => {
    expect(() => parseSlackNudgeWindow({ ...chironeWindow, timeZone: "Invalid/Place" })).toThrow("valid IANA time zone");
  });
});
