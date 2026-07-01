import { describe, expect, it } from "vitest";
import {
  extractRecorderMeetingUrlFromText,
  extractSupportedMeetingUrlFromText,
  isMicrosoftTeamsMeetingUrl,
  isMicrosoftTeamsRecorderUrl,
  normalizeMeetingUrl,
  normalizeRecorderMeetingUrl,
  TEAMS_FULL_JOIN_LINK_REQUIRED_MESSAGE,
} from "./meeting-urls";

describe("meeting URL policy", () => {
  it("normalizes schedulable recorder links", () => {
    expect(normalizeRecorderMeetingUrl("https://MEET.google.com/abc-defg-hij#ignored")).toEqual({
      url: "https://meet.google.com/abc-defg-hij",
      kind: "GOOGLE_MEET",
      providerSchedulable: true,
    });
    expect(normalizeRecorderMeetingUrl("https://acme.zoom.us/j/123456789?pwd=b&foo=a#ignored")).toEqual({
      url: "https://acme.zoom.us/j/123456789?foo=a&pwd=b",
      kind: "ZOOM",
      providerSchedulable: true,
    });
    expect(normalizeRecorderMeetingUrl("https://TEAMS.microsoft.com/l/meetup-join/abc?context=x#ignored")).toEqual({
      url: "https://teams.microsoft.com/l/meetup-join/abc?context=x",
      kind: "MICROSOFT_TEAMS_MEETUP_JOIN",
      providerSchedulable: true,
    });
  });

  it("recognizes Teams meet links but does not mark them provider schedulable", () => {
    expect(normalizeRecorderMeetingUrl("https://teams.microsoft.com/meet/21377000607471?p=abc")).toEqual({
      url: "https://teams.microsoft.com/meet/21377000607471?p=abc",
      kind: "MICROSOFT_TEAMS_MEET",
      providerSchedulable: false,
    });
    expect(isMicrosoftTeamsRecorderUrl("https://teams.microsoft.com/meet/21377000607471?p=abc")).toBe(true);
    expect(isMicrosoftTeamsMeetingUrl("https://teams.microsoft.com/meet/21377000607471?p=abc")).toBe(false);
    expect(TEAMS_FULL_JOIN_LINK_REQUIRED_MESSAGE).toContain("/l/meetup-join/");
  });

  it("extracts only provider schedulable links through the compatibility helper", () => {
    expect(extractRecorderMeetingUrlFromText("Join https://teams.microsoft.com/meet/21377000607471?p=abc."))
      .toMatchObject({ kind: "MICROSOFT_TEAMS_MEET", providerSchedulable: false });
    expect(extractSupportedMeetingUrlFromText("Join https://teams.microsoft.com/meet/21377000607471?p=abc."))
      .toBeNull();
    expect(extractSupportedMeetingUrlFromText("Join https://teams.microsoft.com/l/meetup-join/abc."))
      .toBe("https://teams.microsoft.com/l/meetup-join/abc");
  });

  it("rejects unsupported URLs", () => {
    expect(normalizeRecorderMeetingUrl("https://example.com/call")).toBeNull();
    expect(extractRecorderMeetingUrlFromText("No usable link here")).toBeNull();
    expect(normalizeMeetingUrl("not a url")).toBe("not a url");
  });
});
