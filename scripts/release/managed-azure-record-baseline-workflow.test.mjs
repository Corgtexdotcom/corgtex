import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("managed Azure record baseline workflow", () => {
  it("records only a verified control-plane baseline behind the protected environment", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-record-baseline.yml", import.meta.url), "utf8");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: managed-azure-release-production");
    expect(workflow).toContain("permissions:\n  contents: read\n");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("CONTROL_PLANE_AGENT_API_KEY: ${{ secrets.CONTROL_PLANE_AGENT_API_KEY }}");
    expect(workflow).toContain("node scripts/control-plane.mjs record-release");
    expect(workflow).not.toContain("azure/login");
    expect(workflow).not.toContain("--execute true");
  });
});
