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
    expect(workflow).toContain("resource_group:");
    expect(workflow).toContain("web_app_name:");
    expect(workflow).toContain("worker_app_name:");
    expect(workflow).toContain("uses: azure/login@v2");
    expect(workflow).toContain("client-id: ${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("az containerapp show");
    expect(workflow).toContain("verify_role web \"$WEB_APP_NAME\"");
    expect(workflow).toContain("verify_role worker \"$WORKER_APP_NAME\"");
    expect(workflow).toContain("CORGTEX_RELEASE_IMAGE_TAG");
    expect(workflow).toContain("CORGTEX_RELEASE_VERSION");
    expect(workflow).toContain("CORGTEX_RELEASE_GIT_SHA");
    expect(workflow).toContain("node scripts/control-plane.mjs record-release");
    expect(workflow).not.toContain("--execute true");
  });
});
