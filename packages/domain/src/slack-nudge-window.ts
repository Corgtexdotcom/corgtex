import { AppError } from "./errors";

export type SlackNudgeWindow = {
  timeZone: string;
  weekdays: number[];
  startLocalTime: string;
  endLocalTime: string;
};

const WEEKDAY_NUMBERS: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};
const formatters = new Map<string, Intl.DateTimeFormat>();

function localMinute(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function parseSlackNudgeWindow(value: unknown): SlackNudgeWindow | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "INVALID_INPUT", "Invalid Slack nudge window.");
  }
  const input = value as Record<string, unknown>;
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  const weekdays = input.weekdays;
  const startMinute = localMinute(input.startLocalTime);
  const endMinute = localMinute(input.endLocalTime);
  if (!timeZone || !Array.isArray(weekdays) || weekdays.length === 0
    || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(weekdays).size !== weekdays.length
    || startMinute === null || endMinute === null || startMinute >= endMinute) {
    throw new AppError(400, "INVALID_INPUT", "Invalid Slack nudge window.");
  }
  if (timeZone !== "UTC" && !Intl.supportedValuesOf("timeZone").includes(timeZone)) {
    throw new AppError(400, "INVALID_INPUT", "Slack nudge window requires a valid IANA time zone.");
  }
  return {
    timeZone,
    weekdays: [...weekdays].sort((a, b) => a - b),
    startLocalTime: input.startLocalTime as string,
    endLocalTime: input.endLocalTime as string,
  };
}

export function isSlackNudgeWindowOpen(now: Date, value: unknown) {
  let window: SlackNudgeWindow | null;
  try {
    window = parseSlackNudgeWindow(value);
  } catch {
    return false;
  }
  if (!window) return true;
  let formatter = formatters.get(window.timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: window.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(window.timeZone, formatter);
  }
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_NUMBERS[parts.get("weekday") ?? ""];
  const minuteOfDay = Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
  return window.weekdays.includes(weekday)
    && minuteOfDay >= localMinute(window.startLocalTime)!
    && minuteOfDay < localMinute(window.endLocalTime)!;
}
