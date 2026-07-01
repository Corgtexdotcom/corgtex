import { AppError } from "./errors";

export const DEFAULT_MEETING_DURATION_MINUTES = 60;
export const MIN_MEETING_DURATION_MINUTES = 1;
export const MAX_MEETING_DURATION_MINUTES = 480;

function hasDurationInput(value: string | number | null | undefined) {
  return typeof value === "number" || Boolean(value?.trim());
}

function normalizeLabel(label: string) {
  return label.trim() || "Duration";
}

export function parseMeetingDurationMinutes(
  value: string | number | null | undefined,
  label = "Duration",
  defaultMinutes = DEFAULT_MEETING_DURATION_MINUTES,
) {
  if (!hasDurationInput(value)) {
    return defaultMinutes;
  }

  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (
    !Number.isInteger(parsed)
    || parsed < MIN_MEETING_DURATION_MINUTES
    || parsed > MAX_MEETING_DURATION_MINUTES
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      `${normalizeLabel(label)} must be a whole number between ${MIN_MEETING_DURATION_MINUTES} and ${MAX_MEETING_DURATION_MINUTES} minutes.`,
    );
  }
  return parsed;
}

export function meetingEndFromDurationMinutes(start: Date, durationMinutes: number) {
  return new Date(start.getTime() + durationMinutes * 60_000);
}
