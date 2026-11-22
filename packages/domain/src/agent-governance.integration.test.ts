import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { updateControlPlaneAgentPolicy } from "./control-plane";
import { withMcpToolInput } from "./mcp-tool-input";
import { listAgentConfigs, getAgentGovernancePolicy, updateAgentConfig } from "./agent-config";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "./source-lineage";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Governance test", slug: `governance-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `policy-${randomUUID()}@example.test`, passwordHash: "synthetic-test-only", displayName: "Policy author" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", kind: "HUMAN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: user.displayName } };
  return { workspace, user, actor };
}
describe("authenticated saved governance persistence", () => {
  beforeEach(truncateAllTables);
  it("saves human source proof, preserves it across unrelated config edits, and rejects a stale live policy", async () => {
    const f = await fixture();
    const config = await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Use approved sources." });
    const inputs = [{ kind: "WorkspaceAgentGovernance" as const, id: config.id }];
    const live = await captureArtifactInputProof(f.actor, f.workspace.id, inputs);
    const frozen = await prisma.$transaction(tx => captureImmutableArtifactInputProof(f.actor, f.workspace.id, live, tx));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, live)).toBe(true);
    await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", enabled: false });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, live)).toBe(true);
    await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Replacement instruction." });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, live)).toBe(false);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, frozen)).toBe(true);
    const current = await captureArtifactInputProof(f.actor, f.workspace.id, inputs);
    await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: null });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, current)).toBe(false);
  });
  it("does not infer original authorship for legacy policy or unproven automated saves", async () => {
    const f = await fixture();
    const legacy = await prisma.workspaceAgentConfig.create({ data: { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Unproven legacy instruction." } });
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: legacy.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "Synthetic automation", scopes: ["support:write"], workspaceIds: [f.workspace.id] };
    await updateAgentConfig(actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Unproven generated instruction." });
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: legacy.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Full human replacement." });
    expect(await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: legacy.id }])).toHaveLength(1);
  });
  it("revokes captured governance across direct archive and restore", async () => {
    const f = await fixture();
    const config = await updateAgentConfig(f.actor, { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Authored policy." });
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: config.id }]);
    const frozen = await prisma.$transaction(tx => captureImmutableArtifactInputProof(f.actor, f.workspace.id, roots, tx));
    await prisma.workspaceAgentConfig.update({ where: { id: config.id }, data: { archivedAt: new Date() } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, frozen)).toBe(false);
    await prisma.workspaceAgentConfig.update({ where: { id: config.id }, data: { archivedAt: null } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, frozen)).toBe(false);
  });
  it("saves managed control-plane policy only with workspace membership and a matching source projection", async () => {
    const f = await fixture();
    const actor: AppActor = { kind: "user", user: { id: f.user.id, email: f.user.email, displayName: f.user.displayName, globalRole: "OPERATOR" } };
    const deployment = await prisma.customerDeployment.create({ data: { label: "Governance test", url: `https://${randomUUID()}.example.test`, managedWorkspaceId: f.workspace.id } });
    const result = await updateControlPlaneAgentPolicy(actor, { deploymentId: deployment.id, agentKey: "inbox-triage", governancePolicy: "Operator policy.", reason: "Synthetic policy acceptance." });
    const config = await prisma.workspaceAgentConfig.findUniqueOrThrow({ where: { workspaceId_agentKey: { workspaceId: f.workspace.id, agentKey: "inbox-triage" } } });
    expect(await captureArtifactInputProof(actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: config.id }])).toHaveLength(1);
    expect(result).toMatchObject({ config: { hasGovernancePolicy: true } });
    expect(JSON.stringify(result)).not.toContain("Operator policy.");
    await prisma.member.deleteMany({ where: { workspaceId: f.workspace.id, userId: f.user.id } });
    await expect(updateControlPlaneAgentPolicy(actor, { deploymentId: deployment.id, agentKey: "inbox-triage", governancePolicy: "Unauthorized policy.", reason: "Synthetic denial acceptance." })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect((await prisma.workspaceAgentConfig.findUniqueOrThrow({ where: { id: config.id } })).governancePolicy).toBe("Operator policy.");
  });
  it("retains authenticated MCP argument provenance and credential revocation", async () => {
    const f = await fixture();
    const scopes = ["support:write", "agents:read", "workspace:read"];
    const tokenHash = randomUUID();
    const credential = await prisma.agentCredential.create({ data: { workspaceId: f.workspace.id, label: "Synthetic support", tokenHash, scopes } });
    const version = mcpCredentialVersion(tokenHash);
    const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic MCP", credentialId: credential.id,
      credentialVersion: version, workspaceIds: [f.workspace.id], scopes };
    const origin = { kind: "agent" as const, workspaceId: f.workspace.id, id: credential.id, credentialVersion: version, scopeHash: mcpScopesHash(scopes) };
    const config = await runWithMcpOrigin(origin, () => withMcpToolInput(actor, { workspaceId: f.workspace.id, toolName: "update_agent_policy",
      requiredScopes: ["support:write"], args: { agentKey: "inbox-triage", governancePolicy: "Authenticated MCP policy." } },
    args => updateAgentConfig(actor, { workspaceId: f.workspace.id, ...args })));
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "WorkspaceAgentGovernance", artifactId: config.id }, orderBy: { revision: "desc" } });
    expect(manifest.origin).toBe("DERIVED");
    expect(JSON.stringify(manifest.rootsJson)).toContain("McpToolInput");
    const roots = await captureArtifactInputProof(actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: config.id }]);
    const frozen = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, f.workspace.id, roots, tx));
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { isActive: false } });
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, frozen)).toBe(false);
  });
  it("retains transitive source revocation on immutable governance snapshots", async () => {
    const f = await fixture();
    const source = await prisma.document.create({ data: { workspaceId: f.workspace.id, title: "Policy source", textContent: "Source policy", mimeType: "text/plain", storageKey: "synthetic-test-only", source: "upload" } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "Document", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const config = await prisma.workspaceAgentConfig.create({ data: { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "Derived policy." } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "WorkspaceAgentGovernance", id: config.id }, content: config, origin: "DERIVED", inputs: [{ kind: "Document", id: source.id }] }));
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "WorkspaceAgentGovernance", id: config.id }]);
    const frozen = await prisma.$transaction(tx => captureImmutableArtifactInputProof(f.actor, f.workspace.id, roots, tx));
    await prisma.document.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, frozen)).toBe(false);
    expect((await listAgentConfigs(f.actor, f.workspace.id)).find(row => row.agentKey === "inbox-triage")).toMatchObject({
      hasGovernancePolicy: true, governancePolicy: null, governancePolicyWithheld: true,
    });
    expect(await getAgentGovernancePolicy(f.actor, f.workspace.id, "inbox-triage")).toBeNull();
  });
});
