import { describe, expect, it } from "vitest";
import { parseCreateRequestDate } from "./create-request-date";

describe("Action form request dates", () => {
  const now = new Date("2026-09-26T11:01:00.000Z").getTime();

  it("rejects an elapsed reminder on a new submission", () => {
    expect(() => parseCreateRequestDate("2026-09-26T11:00:00.000Z", "Reminder", false, now))
      .toThrow("Reminder must be in the future.");
  });

  it("accepts the same elapsed reminder for a claimed Action retry", () => {
    expect(parseCreateRequestDate("2026-09-26T11:00:00.000Z", "Reminder", true, now)?.toISOString())
      .toBe("2026-09-26T11:00:00.000Z");
  });
});
