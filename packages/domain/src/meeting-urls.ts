import { createHash } from "node:crypto";

export type RecorderMeetingUrlKind =
  | "GOOGLE_MEET"
  | "ZOOM"
  | "MICROSOFT_TEAMS_MEETUP_JOIN"
  | "MICROSOFT_TEAMS_MEET";

export type RecorderMeetingUrl = {
  url: string;
  kind: RecorderMeetingUrlKind;
  providerSchedulable: boolean;
};

export const TEAMS_FULL_JOIN_LINK_REQUIRED_MESSAGE =
  "Paste a supported live meeting link from Microsoft Teams, Google Meet, or Zoom.";

const CANDIDATE_URL_PATTERN = /https:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[),.;\]}]+$/;

export function normalizeMeetingUrl(value: string) {
  try {
    const url = new URL(value.trim().replace(TRAILING_PUNCTUATION_PATTERN, ""));
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.includes("zoom.us")) {
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function meetingUrlHash(value: string) {
  return createHash("sha256").update(normalizeMeetingUrl(value)).digest("hex");
}

function isZoomHost(hostname: string) {
  return hostname === "zoom.us" || hostname.endsWith(".zoom.us");
}

export function normalizeRecorderMeetingUrl(value?: string | null): RecorderMeetingUrl | null {
  if (!value?.trim()) return null;
  const normalized = normalizeMeetingUrl(value);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname;
  if (hostname === "meet.google.com" && /^\/[a-z0-9-]+\/?$/i.test(pathname)) {
    return { url: normalized, kind: "GOOGLE_MEET", providerSchedulable: true };
  }
  if (isZoomHost(hostname) && pathname.startsWith("/j/")) {
    return { url: normalized, kind: "ZOOM", providerSchedulable: true };
  }
  if (hostname === "teams.microsoft.com" && pathname.startsWith("/l/meetup-join/")) {
    return { url: normalized, kind: "MICROSOFT_TEAMS_MEETUP_JOIN", providerSchedulable: true };
  }
  if (hostname === "teams.microsoft.com" && pathname.startsWith("/meet/")) {
    const hasMeetingId = pathname.replace(/^\/meet\/?/, "").length > 0;
    return {
      url: normalized,
      kind: "MICROSOFT_TEAMS_MEET",
      providerSchedulable: hasMeetingId && url.searchParams.has("p"),
    };
  }
  return null;
}

export function extractRecorderMeetingUrlFromText(value?: string | null): RecorderMeetingUrl | null {
  if (!value) return null;
  const candidates = value.match(CANDIDATE_URL_PATTERN) ?? [];
  for (const candidate of candidates) {
    const match = normalizeRecorderMeetingUrl(candidate);
    if (match) return match;
  }
  return null;
}

export function extractSupportedMeetingUrlFromText(value?: string | null) {
  const match = extractRecorderMeetingUrlFromText(value);
  return match?.providerSchedulable ? match.url : null;
}

export function isMicrosoftTeamsRecorderUrl(value?: string | null) {
  const match = normalizeRecorderMeetingUrl(value);
  return match?.kind === "MICROSOFT_TEAMS_MEETUP_JOIN" || match?.kind === "MICROSOFT_TEAMS_MEET";
}

export function isMicrosoftTeamsMeetingUrl(value?: string | null) {
  const match = normalizeRecorderMeetingUrl(value);
  return Boolean(match?.providerSchedulable && (
    match.kind === "MICROSOFT_TEAMS_MEETUP_JOIN" || match.kind === "MICROSOFT_TEAMS_MEET"
  ));
}
