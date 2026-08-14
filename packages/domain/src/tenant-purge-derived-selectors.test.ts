import { readFileSync, readdirSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  TENANT_PURGE_DERIVED_SELECTORS,
  TENANT_PURGE_DERIVED_EVIDENCE_KINDS,
  TENANT_PURGE_INDIRECT_MODELS,
  TENANT_PURGE_SELECTOR_KINDS,
  TENANT_PURGE_TARGET_DIMENSIONS,
  TENANT_PURGE_TARGET_MODES,
  TENANT_PURGE_WRITER_EVIDENCE_FILES,
  assertTenantPurgeDerivedSelectorRegistry,
  assertTenantPurgeWriterEvidence,
  decodeTenantPurgeDerivedSelectors,
  type TenantPurgeDerivedSelector,
  type TenantPurgeSchemaModel,
} from "./tenant-purge-derived-selectors";
import { TENANT_PURGE_DIRECT_RELATIONS } from "./tenant-purge-scope-registry";

const repository = new URL("../../../", import.meta.url);
const prismaDirectory = new URL("prisma/", repository);
const schema = readdirSync(prismaDirectory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".prisma")).sort().map((file) => readFileSync(new URL(file, prismaDirectory), "utf8")).join("\n");
const schemaModels: TenantPurgeSchemaModel[] = Prisma.dmmf.datamodel.models.map((model) => ({ name: model.name, fields: model.fields.map((field) => ({ name: field.name, kind: field.kind, type: field.type, isId: field.isId, isUnique: field.isUnique, relationFromFields: field.relationFromFields })) }));
const writerPaths = {
  resend: "apps/web/app/api/webhooks/resend-delivery/route.ts",
  bootstrap: "apps/web/app/api/internal/customer-deployment-bootstrap/route.ts",
  selfServe: "packages/domain/src/self-serve-ops.ts",
  procurement: "packages/domain/src/procurement-trials.ts",
  meetingRecorders: "packages/domain/src/meeting-recorders.ts",
  controlPlane: "packages/domain/src/control-plane.ts",
} as const;
const writers = Object.fromEntries(Object.entries(writerPaths).map(([key, path]) => [key, readFileSync(new URL(path, repository), "utf8")])) as Record<keyof typeof writerPaths, string>;

function cloneModels() {
  return schemaModels.map((model) => ({ ...model, fields: model.fields.map((field) => ({ ...field })) }));
}

function selectorsWithout(predicate: (selector: TenantPurgeDerivedSelector) => boolean) {
  return TENANT_PURGE_DERIVED_SELECTORS.filter((selector) => !predicate(selector));
}

function effectiveTargets(model: Prisma.ModelName) {
  const direct = TENANT_PURGE_DIRECT_RELATIONS.filter((relation) => relation.model === model).flatMap((relation) => relation.fields.map((field) => ({ token: field, target: ({ Workspace: "WORKSPACE", CustomerDeployment: "DEPLOYMENT", CustomerAccount: "ACCOUNT", ProcurementTrial: "TRIAL" } as const)[relation.target] })));
  const derived = TENANT_PURGE_DERIVED_SELECTORS.flatMap((selector) => selector.model === model && selector.kind !== "NO_SELECTOR_PRESERVE" ? [{
    token: selector.kind === "DERIVED_UNIQUE_JOIN" ? `${selector.sourceField}>${selector.joinedModel}.${selector.uniqueField}>${selector.terminalField}` : selector.path.join("."), target: selector.target,
  }] : []);
  return [...direct, ...derived];
}

describe("tenant purge derived selector registry", () => {
  it("decodes a closed, immutable, non-authorizing selector grammar", () => {
    for (const value of [TENANT_PURGE_DERIVED_SELECTORS, TENANT_PURGE_DERIVED_EVIDENCE_KINDS, TENANT_PURGE_INDIRECT_MODELS, TENANT_PURGE_SELECTOR_KINDS, TENANT_PURGE_TARGET_DIMENSIONS, TENANT_PURGE_TARGET_MODES, TENANT_PURGE_WRITER_EVIDENCE_FILES]) expect(Object.isFrozen(value)).toBe(true);
    expect(TENANT_PURGE_DERIVED_SELECTORS.every((selector) => Object.isFrozen(selector) && selector.authorizesRoot === false && (selector.kind === "NO_SELECTOR_PRESERVE" || Object.isFrozen(selector.modes)) && (!("path" in selector) || Object.isFrozen(selector.path)))).toBe(true);
    expect(() => decodeTenantPurgeDerivedSelectors("X|EmailDelivery|workspaceId|WORKSPACE|B|")).toThrow(/Invalid tenant purge selector/);
    expect(() => decodeTenantPurgeDerivedSelectors("D|FutureModel|workspaceId|WORKSPACE|B|")).toThrow(/Invalid tenant purge selector/);
    expect(() => decodeTenantPurgeDerivedSelectors("D|EmailDelivery|workspaceId|FUTURE|B|")).toThrow(/selector scope/);
    expect(() => decodeTenantPurgeDerivedSelectors("D|EmailDelivery||WORKSPACE|B|")).toThrow(/selector scope/);
    expect(() => decodeTenantPurgeDerivedSelectors("D|SelfServeEmailCapture|procurementTrialId|TRIAL|B|")).toThrow(/selector scope/);
    expect(() => decodeTenantPurgeDerivedSelectors("J|EmailDeliveryEvent|providerMessageId>EmailDelivery.providerMessageId>workspaceId|WORKSPACE|B|FUTURE")).toThrow(/derived join/);
    expect(() => decodeTenantPurgeDerivedSelectors("N|StripeWebhookEvent|field|||")).toThrow(/no-selector/);
    expect(() => decodeTenantPurgeDerivedSelectors("D|EmailDelivery|workspaceId|WORKSPACE|B|;D|EmailDelivery|workspaceId|WORKSPACE|B|")).toThrow(/Duplicate/);
    expect(() => decodeTenantPurgeDerivedSelectors("N|StripeWebhookEvent||||;N|StripeWebhookEvent||||")).toThrow(/Duplicate/);
    expect(() => decodeTenantPurgeDerivedSelectors("S|User|memberships.workspace|WORKSPACE|B|;R|User|memberships.workspace|WORKSPACE|B|")).toThrow(/Duplicate|preserve/);
    expect(() => decodeTenantPurgeDerivedSelectors("S|User|memberships.workspace|WORKSPACE|B|;N|User||||")).toThrow(/preserve/);
  });

  it("resolves every path and join against schema and fails on omission or drift", () => {
    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels)).not.toThrow();
    expect([...new Set(TENANT_PURGE_DERIVED_SELECTORS.filter((selector) => selector.kind === "RELATION_PATH" && TENANT_PURGE_INDIRECT_MODELS.includes(selector.model as never)).map((selector) => selector.model))].sort()).toEqual([...TENANT_PURGE_INDIRECT_MODELS].sort());
    const expectedIndirect = {
      AdviceRequestRecipient: ["member.workspace", "request.workspace"], AgentStep: ["agentRun.workspace"], AgentToolCall: ["agentRun.workspace"], ApprovalDecision: ["flow.workspace", "member.workspace"], BrainArticleVersion: ["article.workspace"],
      BrainDiscussionComment: ["authorMember.workspace", "thread.article.workspace", "thread.authorMember.workspace"], BrainDiscussionThread: ["article.workspace", "authorMember.workspace"], BuildArtifactAsset: ["artifact.workspace"],
      CircleAgentAssignment: ["agentIdentity.workspace", "circle.workspace", "role.circle.workspace"], ContextMapLayoutItem: ["mapView.workspace", "object.workspace"], ConversationTurn: ["agentRun.workspace", "conversation.workspace"], CrmConversationMessage: ["conversation.workspace"],
      ExternalDataSyncLog: ["source.workspace"], GoalLink: ["goal.workspace"], GoalUpdate: ["authorMember.workspace", "goal.workspace"], KeyResult: ["goal.workspace"], MemberExpertise: ["expertiseTag.workspace", "member.workspace"], Objection: ["flow.workspace"],
      Role: ["circle.workspace"], RoleAssignment: ["member.workspace", "role.circle.workspace"], TensionUpvote: ["tension.workspace"], WebhookDelivery: ["endpoint.workspace"], WorkspaceToolLinkCircleTag: ["circle.workspace", "toolLink.workspace"],
    };
    for (const [model, paths] of Object.entries(expectedIndirect)) expect(TENANT_PURGE_DERIVED_SELECTORS.flatMap((selector) => selector.kind === "RELATION_PATH" && selector.model === model ? [selector.path.join(".")] : []).sort()).toEqual(paths);

    const brokenHop = cloneModels();
    brokenHop.find((model) => model.name === "AgentRun")!.fields.find((field) => field.name === "workspace")!.name = "renamedWorkspace";
    expect(() => assertTenantPurgeDerivedSelectorRegistry(brokenHop)).toThrow(/relation path/);

    const lostUnique = cloneModels();
    const providerId = lostUnique.find((model) => model.name === "EmailDelivery")!.fields.find((field) => field.name === "providerMessageId")!;
    providerId.isUnique = false;
    expect(() => assertTenantPurgeDerivedSelectorRegistry(lostUnique)).toThrow(/derived join/);

    const addedScalar = cloneModels();
    addedScalar.find((model) => model.name === "EmailDelivery")!.fields.push({ name: "shadowWorkspaceId", kind: "scalar", type: "String" });
    expect(() => assertTenantPurgeDerivedSelectorRegistry(addedScalar)).toThrow(/scalar=.*shadowWorkspaceId/);

    const addedParent = cloneModels();
    addedParent.find((model) => model.name === "AgentStep")!.fields.push({ name: "alternateAgentRun", kind: "object", type: "AgentRun", relationFromFields: ["alternateAgentRunId"] });
    expect(() => assertTenantPurgeDerivedSelectorRegistry(addedParent)).toThrow(/paths=AgentStep/);

    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels, selectorsWithout((selector) => selector.model === "AgentStep"))).toThrow(/missing=AgentStep/);
    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels, selectorsWithout((selector) => selector.kind === "SHARED_PRESERVE" && selector.model === "User"))).toThrow(/shared=User/);
    const invalidPreserve = [...TENANT_PURGE_DERIVED_SELECTORS, { kind: "SHARED_PRESERVE", model: "AdviceRequestRecipient", path: ["request", "workspace"], target: "WORKSPACE", modes: ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"], authorizesRoot: false }] as TenantPurgeDerivedSelector[];
    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels, invalidPreserve)).toThrow(/preserve=AdviceRequestRecipient/);
    const mixedPreserve = [...TENANT_PURGE_DERIVED_SELECTORS, { kind: "RELATION_PATH", model: "User", path: ["memberships", "workspace"], target: "WORKSPACE", modes: ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"], authorizesRoot: false }] as TenantPurgeDerivedSelector[];
    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels, mixedPreserve)).toThrow(/preserve=User/);
    expect(() => assertTenantPurgeDerivedSelectorRegistry(schemaModels, [...TENANT_PURGE_DERIVED_SELECTORS, { kind: "NO_SELECTOR_PRESERVE", model: "User", authorizesRoot: false }])).toThrow(/preserve=User/);
  });

  it("composes all exceptional unions without confusing CRM or target modes", () => {
    const scalarTokens = TENANT_PURGE_DERIVED_SELECTORS.flatMap((selector) => selector.kind === "DIRECT_SCALAR" ? [`${selector.model}.${selector.path[0]}:${selector.target}:${selector.modes.length === 2 ? "B" : selector.modes[0] === "ACCOUNT_WORKSPACE" ? "A" : "T"}`] : []).sort();
    expect(scalarTokens).toEqual([
      "EmailDelivery.workspaceId:WORKSPACE:B", "FinanceImportCandidate.workspaceId:WORKSPACE:B", "FinanceReportFact.workspaceId:WORKSPACE:B", "OAuthAccessToken.workspaceId:WORKSPACE:B", "OAuthAuthorizationCode.workspaceId:WORKSPACE:B", "ProcurementIdempotencyKey.workspaceId:WORKSPACE:B",
      "SelfServeEmailCapture.procurementTrialId:TRIAL:T", "SelfServeEmailCapture.workspaceId:WORKSPACE:B", "SelfServeSmokeRun.deploymentId:DEPLOYMENT:B", "SelfServeSmokeRun.procurementTrialId:TRIAL:T", "SelfServeSmokeRun.workspaceId:WORKSPACE:B",
      "SelfServeSupportSession.deploymentId:DEPLOYMENT:B", "SelfServeSupportSession.workspaceId:WORKSPACE:B", "SupportOperation.workspaceId:WORKSPACE:B", "TenantPurgeRun.targetAccountId:ACCOUNT:A", "TenantPurgeRun.targetDeploymentId:DEPLOYMENT:B", "TenantPurgeRun.targetTrialId:TRIAL:T", "TenantPurgeRun.targetWorkspaceId:WORKSPACE:B",
    ].sort());
    const expected: Record<string, readonly string[]> = {
      AppRelease: ["installations.workspace", "runtime.customerDeployment"], AppRuntime: ["customerDeploymentId", "installations.workspace"], ClientMigrationIdMap: ["migrationRun.customerAccount", "migrationRun.destinationDeployment", "migrationRun.sourceDeployment"], ClientMigrationRun: ["customerAccountId", "destinationDeploymentId", "sourceDeploymentId"],
      CrmProspectWorkspace: ["crmWorkspaceId", "targetWorkspaceId"], CustomerDeploymentAccess: ["deploymentId"], CustomerDeploymentEvent: ["deploymentId"], CustomerEntitlement: ["customerAccountId", "deploymentId"], CustomerReleaseTarget: ["customerAccountId", "deploymentId"],
      FleetHealthSnapshot: ["customerAccountId", "deploymentId"], MeetingRecorderSmokeRun: ["deploymentId", "workspaceId"], ProcurementIdempotencyKey: ["setupSessionId>ProcurementSetupSession.id>workspaceId", "workspaceId"],
      ProviderCutover: ["customerAccountId", "destinationDeploymentId", "sourceDeploymentId"], SelfServeEmailCapture: ["procurementTrialId", "workspaceId"], SelfServeSmokeRun: ["deploymentId", "procurementTrialId", "workspaceId"], SelfServeSupportSession: ["deploymentId", "workspaceId"], SupportOperation: ["deploymentId", "workspaceId"],
    };
    expect(Object.keys(expected)).toHaveLength(17);
    for (const [model, tokens] of Object.entries(expected)) expect([...new Set(effectiveTargets(model as Prisma.ModelName).map((entry) => entry.token))].sort()).toEqual(tokens);
    expect(effectiveTargets("CrmProspectWorkspace").some((entry) => entry.token === "accountId")).toBe(false);
    for (const selector of TENANT_PURGE_DERIVED_SELECTORS.filter((entry) => entry.kind !== "NO_SELECTOR_PRESERVE")) {
      if (selector.target === "ACCOUNT") expect(selector.modes).toEqual(["ACCOUNT_WORKSPACE"]);
      if (selector.target === "TRIAL") expect(selector.modes).toEqual(["SELF_SERVE_TRIAL_WORKSPACE"]);
    }
    expect(() => decodeTenantPurgeDerivedSelectors("D|EmailDelivery|workspaceId|WORKSPACE|A|")).toThrow(/selector scope/);
  });

  it("locks both late joins, dormant procurement evidence, and all six writers", () => {
    expect(() => assertTenantPurgeWriterEvidence(writers)).not.toThrow();
    expect(schema).toMatch(/model Workspace[\s\S]*?slug\s+String\s+@unique/);
    expect(schema).toMatch(/model CustomerDeploymentBootstrapRun[\s\S]*?@@unique\(\[customerSlug, bundleChecksum\]\)[\s\S]*?@@index\(\[customerSlug, status\]\)/);
    expect(schema).toMatch(/model ProcurementIdempotencyKey[\s\S]*?@@index\(\[setupSessionId\]\)/);
    expect(schema).toMatch(/model EmailDeliveryEvent[\s\S]*?@@index\(\[providerMessageId, occurredAt\]\)/);
    const joins = TENANT_PURGE_DERIVED_SELECTORS.filter((selector) => selector.kind === "DERIVED_UNIQUE_JOIN");
    expect(joins).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "EmailDeliveryEvent", sourceField: "providerMessageId", joinedModel: "EmailDelivery", uniqueField: "providerMessageId", terminalField: "workspaceId", evidence: "RESEND_TRACKED_EMAIL", secondaryOnly: true }),
      expect.objectContaining({ model: "CustomerDeploymentBootstrapRun", sourceField: "customerSlug", joinedModel: "Workspace", uniqueField: "slug", terminalField: "id", evidence: "BOOTSTRAP_EXACT_WORKSPACE_SLUG", secondaryOnly: true }),
      expect.objectContaining({ model: "ProcurementIdempotencyKey", sourceField: "setupSessionId", joinedModel: "ProcurementSetupSession", uniqueField: "id", terminalField: "workspaceId", evidence: "SCHEMA_ONLY_NO_CURRENT_WRITER", secondaryOnly: true }),
    ]));
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, resend: writers.resend.replace("prisma.emailDelivery.findUnique", "prisma.emailDelivery.findMany") })).toThrow(/writer evidence/);
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, bootstrap: writers.bootstrap.replace("workspace?.slug !== body.customerSlug", "workspace?.slug === body.customerSlug") })).toThrow(/writer evidence/);
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, procurement: `${writers.procurement}\nsetupSessionId: futureSession.id` })).toThrow(/writer inventory/);
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, procurement: writers.procurement.replace("requestHash: params.idemRequestHash,\n          workspaceId: workspace.id,\n          responseJson", "requestHash: params.idemRequestHash,\n          responseJson") })).toThrow(/writer evidence/);
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, procurement: writers.procurement.replace("workspaceId: null,", "workspaceId: workspace.id,") })).toThrow(/writer evidence/);
    expect(() => assertTenantPurgeWriterEvidence({ ...writers, procurement: writers.procurement.replace(/(procurementIdempotencyKey\.updateMany\(\{[\s\S]*?requestHash:) params\.idemRequestHash/, "$1 wrongRequestHash") })).toThrow(/writer evidence/);
  });

  it("keeps shared and retained rows preserve-only and exports no evidence values", () => {
    const sharedModels = ["User", "Session", "PasswordResetToken", "NotificationPreference", "UserSsoIdentity", "McpOAuthClient", "AppDefinition", "AppRuntime", "AppRelease"];
    for (const model of sharedModels) expect(TENANT_PURGE_DERIVED_SELECTORS.some((selector) => selector.model === model && selector.kind === "SHARED_PRESERVE")).toBe(true);
    const expectedShared = {
      AppDefinition: ["installations.workspace", "runtimes.customerDeployment"], AppRelease: ["installations.workspace", "runtime.customerDeployment"], AppRuntime: ["installations.workspace"], McpOAuthClient: ["accessTokens.workspace", "authCodes.workspace"],
      NotificationPreference: ["user.customerDeploymentAccess.deployment", "user.memberships.workspace", "user.onboardingStates.workspace"], PasswordResetToken: ["user.customerDeploymentAccess.deployment", "user.memberships.workspace", "user.onboardingStates.workspace"],
      Session: ["user.customerDeploymentAccess.deployment", "user.memberships.workspace", "user.onboardingStates.workspace"], User: ["customerDeploymentAccess.deployment", "memberships.workspace", "onboardingStates.workspace"], UserSsoIdentity: ["user.customerDeploymentAccess.deployment", "user.memberships.workspace", "user.onboardingStates.workspace"],
    };
    for (const [model, paths] of Object.entries(expectedShared)) expect(TENANT_PURGE_DERIVED_SELECTORS.flatMap((selector) => selector.model === model && selector.kind === "SHARED_PRESERVE" ? [selector.path.join(".")] : []).sort()).toEqual(paths);
    expect(TENANT_PURGE_DERIVED_SELECTORS).toContainEqual({ kind: "NO_SELECTOR_PRESERVE", model: "StripeWebhookEvent", authorizesRoot: false });
    expect(effectiveTargets("TenantPurgeRun").map((entry) => entry.target).sort()).toEqual(["ACCOUNT", "DEPLOYMENT", "TRIAL", "WORKSPACE"]);
    expect(JSON.stringify(TENANT_PURGE_DERIVED_SELECTORS)).not.toMatch(/bundleUri|tokenHash|payload|toEmail|failureReason|rawLastEvent/);
  });
});
