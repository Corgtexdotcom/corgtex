import { describe, expect, it } from "vitest";
import { snapshotText } from "./snapshot";

describe("version snapshot text", () => {
  it("shows captured Key Results alongside a Goal description", () => {
    const text = snapshotText({
      descriptionMd: "Quarterly objective",
      keyResults: [{ title: "Ship onboarding", currentValue: 2, targetValue: 5, unit: "teams" }],
    });

    expect(text).toContain("Quarterly objective");
    expect(text).toContain('"title": "Ship onboarding"');
    expect(text).toContain('"currentValue": 2');
  });

  it("keeps the existing concise description display when no Key Results are captured", () => {
    expect(snapshotText({ descriptionMd: "Quarterly objective", title: "Grow adoption" }))
      .toBe("Quarterly objective");
  });

  it("keeps the full snapshot visible when Key Results exist without a description", () => {
    const text = snapshotText({
      title: "Grow adoption",
      progressPercent: 40,
      keyResults: [{ title: "Ship onboarding", currentValue: 2, targetValue: 5 }],
    });

    expect(text).toContain('"progressPercent": 40');
    expect(text).toContain('"title": "Ship onboarding"');
  });
});
