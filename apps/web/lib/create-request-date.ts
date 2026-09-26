import { AppError } from "@corgtex/domain";

export function parseCreateRequestDate(value: string | null, label: string, allowPast = false, now = Date.now()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a valid date.`);
  }
  if (!allowPast && date.getTime() <= now) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be in the future.`);
  }
  return date;
}
