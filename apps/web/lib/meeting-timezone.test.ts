import { describe, expect, it } from "vitest";
import {
  assertMeetingEndAfterStart,
  DEFAULT_MEETING_DURATION_MINUTES,
  MAX_MEETING_DURATION_MINUTES,
  MIN_MEETING_DURATION_MINUTES,
  meetingEndFromDurationMinutes,
  normalizeOptionalMeetingDateTimeInput,
  parseMeetingDurationMinutesInput,
  parseMeetingDateTimeInput,
  parseOptionalMeetingDateTimeInput,
  resolveMeetingEndFromDurationOrInput,
  validMeetingTimeZone,
} from "./meeting-timezone";

describe("meeting timezone parsing", () => {
  it("converts local summer wall-clock time with an IANA timezone to UTC", () => {
    expect(parseMeetingDateTimeInput("2026-06-11T14:07", "America/Los_Angeles").toISOString())
      .toBe("2026-06-11T21:07:00.000Z");
  });

  it("converts local winter wall-clock time with daylight-saving rules", () => {
    expect(parseMeetingDateTimeInput("2026-01-11T14:07", "America/Los_Angeles").toISOString())
      .toBe("2026-01-11T22:07:00.000Z");
  });

  it("keeps timezone-aware ISO timestamps as absolute instants", () => {
    expect(parseMeetingDateTimeInput("2026-06-11T14:07:00.000Z", null).toISOString())
      .toBe("2026-06-11T14:07:00.000Z");
    expect(parseMeetingDateTimeInput("2026-06-11T14:07:00-07:00", null).toISOString())
      .toBe("2026-06-11T21:07:00.000Z");
  });

  it("rejects invalid timezones and invalid local datetimes", () => {
    expect(validMeetingTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(validMeetingTimeZone("Mars/Colony")).toBeNull();
    expect(() => parseMeetingDateTimeInput("2026-06-11T14:07", "Mars/Colony")).toThrow(/valid IANA timezone/);
    expect(() => parseMeetingDateTimeInput("2026-02-31T14:07", "America/Los_Angeles")).toThrow(/valid local datetime/);
  });

  it("rejects nonexistent local times during daylight-saving transitions", () => {
    expect(() => parseMeetingDateTimeInput("2026-03-08T02:30", "America/Los_Angeles")).toThrow(/does not exist/);
  });

  it("normalizes optional values and rejects end times before starts", () => {
    expect(parseOptionalMeetingDateTimeInput("", "America/Los_Angeles")).toBeNull();
    expect(normalizeOptionalMeetingDateTimeInput("2026-06-11T14:07", "America/Los_Angeles"))
      .toBe("2026-06-11T21:07:00.000Z");
    expect(() => assertMeetingEndAfterStart(
      new Date("2026-06-11T21:07:00.000Z"),
      new Date("2026-06-11T20:07:00.000Z"),
    )).toThrow(/after the start time/);
  });

  it("parses meeting duration minutes and defaults to one hour", () => {
    expect(parseMeetingDurationMinutesInput(null)).toBe(DEFAULT_MEETING_DURATION_MINUTES);
    expect(parseMeetingDurationMinutesInput("60")).toBe(60);
    expect(parseMeetingDurationMinutesInput("90")).toBe(90);
    expect(parseMeetingDurationMinutesInput(45)).toBe(45);
    expect(parseMeetingDurationMinutesInput(String(MIN_MEETING_DURATION_MINUTES))).toBe(MIN_MEETING_DURATION_MINUTES);
    expect(parseMeetingDurationMinutesInput(String(MAX_MEETING_DURATION_MINUTES))).toBe(MAX_MEETING_DURATION_MINUTES);
    expect(() => parseMeetingDurationMinutesInput("0")).toThrow(/between 1 and 480 minutes/);
    expect(() => parseMeetingDurationMinutesInput("12.5")).toThrow(/whole number/);
    expect(() => parseMeetingDurationMinutesInput("481")).toThrow(/between 1 and 480 minutes/);
  });

  it("derives meeting end times from duration before falling back to scheduled end input", () => {
    const start = new Date("2026-06-11T21:00:00.000Z");
    expect(meetingEndFromDurationMinutes(start, 90).toISOString()).toBe("2026-06-11T22:30:00.000Z");
    expect(resolveMeetingEndFromDurationOrInput({
      start,
      durationMinutes: "45",
      scheduledEndAt: "2026-06-11T23:00:00.000Z",
    }).toISOString()).toBe("2026-06-11T21:45:00.000Z");
    expect(resolveMeetingEndFromDurationOrInput({
      start,
      scheduledEndAt: "2026-06-11T23:00:00.000Z",
    }).toISOString()).toBe("2026-06-11T23:00:00.000Z");
    expect(resolveMeetingEndFromDurationOrInput({ start }).toISOString()).toBe("2026-06-11T22:00:00.000Z");
  });
});
