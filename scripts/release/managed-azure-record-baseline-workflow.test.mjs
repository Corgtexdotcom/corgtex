import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("managed Azure record baseline workflow", () => {
  it("records only a verified control-plane baseline behind the protected environment", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-record-baseline.yml", import.meta.url), "utf8");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: managed-azure-release-production");
    expect(workflow).toContain("group: managed-azure-release-${{ inputs.deployment_id }}");
    expect(workflow).toContain("permissions:\n  contents: read\n  id-token: write\n");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("CONTROL_PLANE_AGENT_API_KEY: ${{ secrets.CONTROL_PLANE_AGENT_API_KEY }}");
    expect(workflow).toContain("workload_class:");
    expect(workflow).toContain("acr_name:");
    expect(workflow).toContain("acr_server:");
    expect(workflow).toContain("node scripts/control-plane.mjs call get_managed_release_bootstrap_target");
    expect(workflow).toContain("uses: azure/login@v2");
    expect(workflow).toContain("client-id: ${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("--subscription \"$subscription_id\"");
    expect(workflow).toContain("/^sha-[0-9a-f]{40}$/.test(releaseImageTag)");
    expect(workflow).toContain("/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(releaseVersion)");
    expect(workflow).toContain("az containerapp show");
    expect(workflow).toContain("az acr manifest show-metadata");
    expect(workflow).toContain("imageMatch[1] !== tagDigest");
    expect(workflow).toContain("activeRevisionsMode");
    expect(workflow).toContain("latestRevisionName !== properties.latestReadyRevisionName");
    expect(workflow).toContain("(sha256:[0-9a-f]{64})");
    expect(workflow).toContain("verify_role web \"$WEB_APP_NAME\"");
    expect(workflow).toContain("verify_role worker \"$WORKER_APP_NAME\"");
    expect(workflow).toContain("CORGTEX_RELEASE_IMAGE_TAG");
    expect(workflow).toContain("CORGTEX_RELEASE_VERSION");
    expect(workflow).toContain("CORGTEX_RELEASE_GIT_SHA");
    expect(workflow).toContain("node scripts/control-plane.mjs record-release");
    expect(workflow).toContain("WORKLOAD_CLASS: ${{ inputs.workload_class }}");
    expect(workflow).toContain("JSON.stringify({ ...payload.target, workloadClass: process.env.WORKLOAD_CLASS })");
    expect(workflow).not.toContain("--execute true");
  });
});
