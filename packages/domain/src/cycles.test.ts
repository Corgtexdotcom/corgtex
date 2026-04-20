import { describe, expect, it } from "vitest";
import { normalizeAllocationPoints, normalizeCycleWindow } from "./cycles";

describe("normalizeCycleWindow", () => {
  it("accepts a valid window", () => {
    const startDate = new Date("2026-04-01T00:00:00.000Z");
    const endDate = new Date("2026-04-30T00:00:00.000Z");

    expect(
      normalizeCycleWindow({
        startDate,
        endDate,
        pointsPerUser: 100,
      }),
    ).toEqual({
      startDate,
      endDate,
      pointsPerUser: 100,
    });
  });

  it("rejects end dates before the start date", () => {
    expect(() =>
      normalizeCycleWindow({
        startDate: new Date("2026-04-30T00:00:00.000Z"),
        endDate: new Date("2026-04-01T00:00:00.000Z"),
        pointsPerUser: 100,
      }),
    ).toThrowError("endDate must be after startDate.");
  });
});

describe("normalizeAllocationPoints", () => {
  it("accepts positive integers", () => {
    expect(normalizeAllocationPoints(25)).toBe(25);
  });

  it("rejects zero or negative values", () => {
    expect(() => normalizeAllocationPoints(0)).toThrowError("points must be a positive integer.");
    expect(() => normalizeAllocationPoints(-3)).toThrowError("points must be a positive integer.");
  });
});
