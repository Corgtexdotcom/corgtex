import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import type { AppActor } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
import { createBudgetAlertActor, createCheckInGenerationActor } from "./internal-source-principal";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint,
  readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

beforeEach(resetFixture);
function finance() {
  const budget = fixture.add("modelUsageBudget", { id: "budget", workspaceId, monthlyCostCapUsd: 100, alertThresholdPct: 80, periodStartDay: 1, alertSentAt: null });
  const cost = fixture.add("modelUsage", { id: "cost", workspaceId, estimatedCostUsd: 10, billableCostUsd: 40 });
  return { budget, cost };
}
const unbranded = () => ({ kind: "agent", authProvider: "bootstrap", label: "BUDGET_ALERT", workspaceIds: [workspaceId] }) as AppActor;

describe("Internal source purpose capabilities with actual lineage", () => {
  it("permits exact budget inputs only for a live process capability and denies copies/credentials", async () => {
    const { budget, cost } = finance();
    const actor = createBudgetAlertActor(workspaceId);
    const inputs = [{ kind: "ModelUsageBudget" as const, id: budget.id }, { kind: "ModelUsageCost" as const, id: cost.id }];
    const proof = await captureArtifactInputProof(actor, workspaceId, inputs);
    expect(await isArtifactInputProofReadable(actor, workspaceId, proof)).toBe(true);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(actor.kind === "agent" ? actor.workspaceIds : [])).toBe(true);
    for (const copied of [{ ...actor }, JSON.parse(JSON.stringify(actor)), unbranded(),
      { kind: "agent", authProvider: "credential", label: "BUDGET_ALERT", workspaceIds: [workspaceId], credentialId: "synthetic", scopes: ["*"] }] as AppActor[]) {
      await expect(captureArtifactInputProof(copied, workspaceId, inputs)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    }
    await expect(isArtifactInputProofReadable(createBudgetAlertActor("ws-b"), workspaceId, proof)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(await isArtifactInputProofReadable(createCheckInGenerationActor(workspaceId, "member-alpha"), workspaceId, proof)).toBe(false);
    const privateArticle = fixture.add("brainArticle", { id: "private-article", workspaceId, isPrivate: true, ownerMemberId: "member-beta", title: "Private text", bodyMd: "Private body", archivedAt: null });
    await known("BrainArticle", privateArticle, [], beta);
    expect(await readableArtifactIds(actor, workspaceId, "BrainArticle", [privateArticle])).toEqual(new Set());
  });

  it("bounds question capability to the active recipient on native and immutable reads", async () => {
    const row = fixture.add("checkIn", { id: "question", workspaceId, memberId: "member-alpha", questionText: "Known question", questionType: "COMPANY_UNDERSTANDING", questionSource: "human" });
    await known("CheckIn", row, [], alpha);
    const actor = createCheckInGenerationActor(workspaceId, "member-alpha");
    const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "CheckIn", id: row.id }]);
    const frozen = await captureImmutableArtifactInputProof(actor, workspaceId, roots, fixture.prisma);
    expect(await isArtifactInputProofReadable(actor, workspaceId, frozen)).toBe(true);
    expect(await isArtifactInputProofReadable({ ...actor }, workspaceId, frozen)).toBe(false);
    expect(await isArtifactInputProofReadable(createCheckInGenerationActor(workspaceId, "member-beta"), workspaceId, frozen)).toBe(false);
    fixture.rows.member.find((member: any) => member.id === "member-alpha").isActive = false;
    expect(await isArtifactInputProofReadable(actor, workspaceId, roots)).toBe(false);
    expect(await isArtifactInputProofReadable(actor, workspaceId, frozen)).toBe(false);
  });

  it("rejects mismatched snapshot permission kinds even for a valid budget capability", async () => {
    const { budget } = finance();
    const actor = createBudgetAlertActor(workspaceId);
    const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ModelUsageBudget", id: budget.id }]);
    const frozen = await captureImmutableArtifactInputProof(actor, workspaceId, roots, fixture.prisma);
    const snapshot = fixture.rows.artifactInputSnapshot.find((row: any) => row.id === frozen[0].id);
    snapshot.accessEnvelopeJson.permissionKind = "Workspace";
    const malformed = [{ kind: "ArtifactInputSnapshot" as const, id: snapshot.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }];
    expect(await isArtifactInputProofReadable(actor, workspaceId, malformed)).toBe(false);
  });

  it("keeps copied budget output bound to its current admin and its own recipient driver", async () => {
    const { budget, cost } = finance();
    for (const member of fixture.rows.member) member.role = "ADMIN";
    const actor = createBudgetAlertActor(workspaceId);
    const financialRoots = await captureArtifactInputProof(actor, workspaceId, [
      { kind: "ModelUsageBudget", id: budget.id }, { kind: "ModelUsageCost", id: cost.id },
    ]);
    const notifications: any[] = [];
    for (const id of ["alpha", "beta"]) {
      const recipient = fixture.rows.member.find((member: any) => member.userId === id);
      const roots = await captureArtifactInputProof(actor, workspaceId, [
        { kind: "Member", id: recipient.id }, { kind: "User", id },
      ]);
      const notification = fixture.add("notification", { id: `notification-${id}`, workspaceId, userId: id, type: "budget.threshold_reached", title: "Budget Alert", bodyMd: "$40 of $100", dedupeKey: `budget-${id}`, priority: "HIGH", entityType: "ModelUsageBudget", entityId: budget.id });
      await recordArtifactInputLineage({ tx: fixture.prisma, actor, workspaceId, artifact: { kind: "Notification", id: notification.id },
        content: notification, origin: "DERIVED", inputs: [], inheritedRoots: [...financialRoots, ...roots] });
      notifications.push(notification);
    }
    expect(await readableArtifactIds(beta, workspaceId, "Notification", notifications)).toEqual(new Set(["notification-beta"]));
    fixture.rows.member.find((member: any) => member.userId === "alpha").isActive = false;
    expect(await readableArtifactIds(beta, workspaceId, "Notification", notifications)).toEqual(new Set(["notification-beta"]));
    fixture.rows.member.find((member: any) => member.userId === "beta").role = "CONTRIBUTOR";
    expect(await readableArtifactIds(beta, workspaceId, "Notification", notifications)).toEqual(new Set());
  });
});
