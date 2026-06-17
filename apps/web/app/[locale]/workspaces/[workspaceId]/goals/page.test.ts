import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Goals page source", () => {
  it("does not render the permanent Brain direction workbench by default", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("CompanyDirectionFromBrain");
    expect(source).not.toContain("listCompanyDirectionFromBrain");
  });
});
