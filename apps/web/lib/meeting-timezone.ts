type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const TIMEZONE_AWARE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-]\d{2}:\d{2})$/;
export const DEFAULT_MEETING_DURATION_MINUTES = 60;
export const MIN_MEETING_DURATION_MINUTES = 1;
export const MAX_MEETING_DURATION_MINUTES = 480;

class MeetingDateTimeInputError extends Error {
  readonly status = 400;
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "MeetingDateTimeInputError";
  }
}

function invalid(message: string): never {
  throw new MeetingDateTimeInputError(message);
}

function normalizeLabel(label: string) {
  return label.trim() || "Meeting time";
}

export function validMeetingTimeZone(value: string | null | undefined) {
  const timeZone = value?.trim();
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return null;
  }
}

function requireMeetingTimeZone(value: string | null | undefined, label: string) {
  const timeZone = validMeetingTimeZone(value);
  if (!timeZone) {
    invalid(`${normalizeLabel(label)} timezone must be a valid IANA timezone.`);
  }
  return timeZone;
}

function parseDateTimeParts(raw: string): DateTimeParts | null {
  const match = raw.match(LOCAL_DATETIME_PATTERN);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0"] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.slice(0, 3).padEnd(3, "0")),
  };
}

function localPartsAreValid(parts: DateTimeParts) {
  const asUtc = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ));
  return parts.month >= 1
    && parts.month <= 12
    && parts.hour >= 0
    && parts.hour <= 23
    && parts.minute >= 0
    && parts.minute <= 59
    && parts.second >= 0
    && parts.second <= 59
    && parts.millisecond >= 0
    && parts.millisecond <= 999
    && asUtc.getUTCFullYear() === parts.year
    && asUtc.getUTCMonth() === parts.month - 1
    && asUtc.getUTCDate() === parts.day
    && asUtc.getUTCHours() === parts.hour
    && asUtc.getUTCMinutes() === parts.minute
    && asUtc.getUTCSeconds() === parts.second
    && asUtc.getUTCMilliseconds() === parts.millisecond;
}

function dateTimePartsInZone(date: Date, timeZone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: Number(values.fractionalSecond ?? 0),
  };
}

function sameParts(left: DateTimeParts, right: DateTimeParts) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second
    && left.millisecond === right.millisecond;
}

function zonedDateTimeToUtc(parts: DateTimeParts, timeZone: string) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let utc = target;
  for (let index = 0; index < 3; index += 1) {
    const rendered = dateTimePartsInZone(new Date(utc), timeZone);
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second, rendered.millisecond);
    const offset = renderedAsUtc - target;
    if (offset === 0) break;
    utc -= offset;
  }
  return new Date(utc);
}

function timezoneAwareTimestampMatchesInput(parsed: Date, match: RegExpMatchArray) {
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  const offsetMinutes = zone.toUpperCase() === "Z"
    ? 0
    : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone.startsWith("-") ? -1 : 1);
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
  return sameParts(dateTimePartsInZone(local, "UTC"), {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.slice(0, 3).padEnd(3, "0")),
  });
}

export function parseMeetingDateTimeInput(value: string, timeZone: string | null | undefined, label = "Meeting time") {
  const fieldLabel = normalizeLabel(label);
  const raw = value.trim();
  if (!raw) {
    invalid(`${fieldLabel} is required.`);
  }

  const timezoneAwareMatch = raw.match(TIMEZONE_AWARE_DATETIME_PATTERN);
  if (timezoneAwareMatch) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.valueOf()) || !timezoneAwareTimestampMatchesInput(parsed, timezoneAwareMatch)) {
      invalid(`${fieldLabel} must be a valid datetime.`);
    }
    return parsed;
  }

  const parts = parseDateTimeParts(raw);
  if (!parts || !localPartsAreValid(parts)) {
    invalid(`${fieldLabel} must be a valid local datetime.`);
  }

  const resolvedTimeZone = requireMeetingTimeZone(timeZone, fieldLabel);
  const parsed = zonedDateTimeToUtc(parts, resolvedTimeZone);
  if (!sameParts(dateTimePartsInZone(parsed, resolvedTimeZone), parts)) {
    invalid(`${fieldLabel} does not exist in ${resolvedTimeZone}.`);
  }
  return parsed;
}

export function parseOptionalMeetingDateTimeInput(value: string | null | undefined, timeZone: string | null | undefined, label = "Meeting time") {
  if (!value?.trim()) return null;
  return parseMeetingDateTimeInput(value, timeZone, label);
}

export function normalizeOptionalMeetingDateTimeInput(value: string | null | undefined, timeZone: string | null | undefined, label = "Meeting time") {
  return parseOptionalMeetingDateTimeInput(value, timeZone, label)?.toISOString() ?? null;
}

export function assertMeetingEndAfterStart(start: Date, end: Date | null, endLabel = "End time") {
  if (end && end <= start) {
    invalid(`${normalizeLabel(endLabel)} must be after the start time.`);
  }
}

function hasDurationInput(value: string | number | null | undefined) {
  return typeof value === "number" || Boolean(value?.trim());
}

export function parseMeetingDurationMinutesInput(
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
    invalid(
      `${normalizeLabel(label)} must be a whole number between ${MIN_MEETING_DURATION_MINUTES} and ${MAX_MEETING_DURATION_MINUTES} minutes.`,
    );
  }
  return parsed;
}

export function meetingEndFromDurationMinutes(start: Date, durationMinutes: number) {
  return new Date(start.getTime() + durationMinutes * 60_000);
}

export function resolveMeetingEndFromDurationOrInput(params: {
  start: Date;
  durationMinutes?: string | number | null;
  scheduledEndAt?: string | null;
  timeZone?: string | null;
  durationLabel?: string;
  endLabel?: string;
}) {
  if (hasDurationInput(params.durationMinutes)) {
    return meetingEndFromDurationMinutes(
      params.start,
      parseMeetingDurationMinutesInput(params.durationMinutes, params.durationLabel),
    );
  }

  const scheduledEndAt = parseOptionalMeetingDateTimeInput(
    params.scheduledEndAt,
    params.timeZone,
    params.endLabel,
  );
  if (scheduledEndAt) {
    assertMeetingEndAfterStart(params.start, scheduledEndAt, params.endLabel);
    return scheduledEndAt;
  }

  return meetingEndFromDurationMinutes(
    params.start,
    parseMeetingDurationMinutesInput(null, params.durationLabel),
  );
}
