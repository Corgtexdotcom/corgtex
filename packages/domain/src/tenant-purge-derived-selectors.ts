import { Prisma } from "@prisma/client";

import {
  TENANT_PURGE_DIRECT_RELATIONS,
  TENANT_PURGE_MODEL_DISPOSITIONS,
  TENANT_PURGE_TARGET_MODELS,
  type TenantPurgeTargetModel,
} from "./tenant-purge-scope-registry";

export const TENANT_PURGE_SELECTOR_KINDS = Object.freeze(["DIRECT_SCALAR", "RELATION_PATH", "DERIVED_UNIQUE_JOIN", "SHARED_PRESERVE", "NO_SELECTOR_PRESERVE"] as const);
export const TENANT_PURGE_TARGET_DIMENSIONS = Object.freeze(["WORKSPACE", "DEPLOYMENT", "ACCOUNT", "TRIAL"] as const);
export const TENANT_PURGE_TARGET_MODES = Object.freeze(["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"] as const);
export const TENANT_PURGE_DERIVED_EVIDENCE_KINDS = Object.freeze(["RESEND_TRACKED_EMAIL", "BOOTSTRAP_EXACT_WORKSPACE_SLUG", "SCHEMA_ONLY_NO_CURRENT_WRITER"] as const);
export type TenantPurgeTargetDimension = typeof TENANT_PURGE_TARGET_DIMENSIONS[number];
export type TenantPurgeTargetMode = typeof TENANT_PURGE_TARGET_MODES[number];

type PathSelectorKind = "DIRECT_SCALAR" | "RELATION_PATH" | "SHARED_PRESERVE";
export type TenantPurgeDerivedSelector =
  | { kind: PathSelectorKind; model: Prisma.ModelName; path: readonly string[]; target: TenantPurgeTargetDimension; modes: readonly TenantPurgeTargetMode[]; authorizesRoot: false }
  | { kind: "DERIVED_UNIQUE_JOIN"; model: Prisma.ModelName; sourceField: string; joinedModel: Prisma.ModelName; uniqueField: string; terminalField: string; target: TenantPurgeTargetDimension; modes: readonly TenantPurgeTargetMode[]; evidence: typeof TENANT_PURGE_DERIVED_EVIDENCE_KINDS[number]; secondaryOnly: true; authorizesRoot: false }
  | { kind: "NO_SELECTOR_PRESERVE"; model: Prisma.ModelName; authorizesRoot: false };

const SELECTOR_DSL = `
R|AdviceRequestRecipient|request.workspace|WORKSPACE|B|;R|AdviceRequestRecipient|member.workspace|WORKSPACE|B|
R|AgentStep|agentRun.workspace|WORKSPACE|B|;R|AgentToolCall|agentRun.workspace|WORKSPACE|B|
R|ApprovalDecision|flow.workspace|WORKSPACE|B|;R|ApprovalDecision|member.workspace|WORKSPACE|B|
R|BrainArticleVersion|article.workspace|WORKSPACE|B|;R|BrainDiscussionComment|thread.article.workspace|WORKSPACE|B|;R|BrainDiscussionComment|thread.authorMember.workspace|WORKSPACE|B|;R|BrainDiscussionComment|authorMember.workspace|WORKSPACE|B|
R|BrainDiscussionThread|article.workspace|WORKSPACE|B|;R|BrainDiscussionThread|authorMember.workspace|WORKSPACE|B|;R|BuildArtifactAsset|artifact.workspace|WORKSPACE|B|
R|CircleAgentAssignment|circle.workspace|WORKSPACE|B|;R|CircleAgentAssignment|agentIdentity.workspace|WORKSPACE|B|;R|CircleAgentAssignment|role.circle.workspace|WORKSPACE|B|
R|ContextMapLayoutItem|mapView.workspace|WORKSPACE|B|;R|ContextMapLayoutItem|object.workspace|WORKSPACE|B|
R|ConversationTurn|conversation.workspace|WORKSPACE|B|;R|ConversationTurn|agentRun.workspace|WORKSPACE|B|;R|CrmConversationMessage|conversation.workspace|WORKSPACE|B|
R|ExternalDataSyncLog|source.workspace|WORKSPACE|B|;R|GoalLink|goal.workspace|WORKSPACE|B|;R|GoalUpdate|goal.workspace|WORKSPACE|B|;R|GoalUpdate|authorMember.workspace|WORKSPACE|B|;R|KeyResult|goal.workspace|WORKSPACE|B|
R|MemberExpertise|member.workspace|WORKSPACE|B|;R|MemberExpertise|expertiseTag.workspace|WORKSPACE|B|;R|Objection|flow.workspace|WORKSPACE|B|
R|Role|circle.workspace|WORKSPACE|B|;R|RoleAssignment|role.circle.workspace|WORKSPACE|B|;R|RoleAssignment|member.workspace|WORKSPACE|B|
R|TensionUpvote|tension.workspace|WORKSPACE|B|;R|WebhookDelivery|endpoint.workspace|WORKSPACE|B|
R|WorkspaceToolLinkCircleTag|toolLink.workspace|WORKSPACE|B|;R|WorkspaceToolLinkCircleTag|circle.workspace|WORKSPACE|B|
R|ClientMigrationIdMap|migrationRun.customerAccount|ACCOUNT|A|;R|ClientMigrationIdMap|migrationRun.sourceDeployment|DEPLOYMENT|B|;R|ClientMigrationIdMap|migrationRun.destinationDeployment|DEPLOYMENT|B|
D|EmailDelivery|workspaceId|WORKSPACE|B|;D|FinanceImportCandidate|workspaceId|WORKSPACE|B|;D|FinanceReportFact|workspaceId|WORKSPACE|B|
D|OAuthAccessToken|workspaceId|WORKSPACE|B|;D|OAuthAuthorizationCode|workspaceId|WORKSPACE|B|;D|ProcurementIdempotencyKey|workspaceId|WORKSPACE|B|
D|SelfServeEmailCapture|workspaceId|WORKSPACE|B|;D|SelfServeEmailCapture|procurementTrialId|TRIAL|T|
D|SelfServeSmokeRun|workspaceId|WORKSPACE|B|;D|SelfServeSmokeRun|deploymentId|DEPLOYMENT|B|;D|SelfServeSmokeRun|procurementTrialId|TRIAL|T|
D|SelfServeSupportSession|workspaceId|WORKSPACE|B|;D|SelfServeSupportSession|deploymentId|DEPLOYMENT|B|;D|SupportOperation|workspaceId|WORKSPACE|B|
D|TenantPurgeRun|targetWorkspaceId|WORKSPACE|B|;D|TenantPurgeRun|targetDeploymentId|DEPLOYMENT|B|;D|TenantPurgeRun|targetAccountId|ACCOUNT|A|;D|TenantPurgeRun|targetTrialId|TRIAL|T|
J|EmailDeliveryEvent|providerMessageId>EmailDelivery.providerMessageId>workspaceId|WORKSPACE|B|RESEND_TRACKED_EMAIL
J|CustomerDeploymentBootstrapRun|customerSlug>Workspace.slug>id|WORKSPACE|B|BOOTSTRAP_EXACT_WORKSPACE_SLUG
J|ProcurementIdempotencyKey|setupSessionId>ProcurementSetupSession.id>workspaceId|WORKSPACE|B|SCHEMA_ONLY_NO_CURRENT_WRITER
S|User|memberships.workspace|WORKSPACE|B|;S|User|onboardingStates.workspace|WORKSPACE|B|;S|User|customerDeploymentAccess.deployment|DEPLOYMENT|B|
S|Session|user.memberships.workspace|WORKSPACE|B|;S|Session|user.onboardingStates.workspace|WORKSPACE|B|;S|Session|user.customerDeploymentAccess.deployment|DEPLOYMENT|B|
S|PasswordResetToken|user.memberships.workspace|WORKSPACE|B|;S|PasswordResetToken|user.onboardingStates.workspace|WORKSPACE|B|;S|PasswordResetToken|user.customerDeploymentAccess.deployment|DEPLOYMENT|B|
S|NotificationPreference|user.memberships.workspace|WORKSPACE|B|;S|NotificationPreference|user.onboardingStates.workspace|WORKSPACE|B|;S|NotificationPreference|user.customerDeploymentAccess.deployment|DEPLOYMENT|B|
S|UserSsoIdentity|user.memberships.workspace|WORKSPACE|B|;S|UserSsoIdentity|user.onboardingStates.workspace|WORKSPACE|B|;S|UserSsoIdentity|user.customerDeploymentAccess.deployment|DEPLOYMENT|B|
S|McpOAuthClient|authCodes.workspace|WORKSPACE|B|;S|McpOAuthClient|accessTokens.workspace|WORKSPACE|B|
S|AppDefinition|installations.workspace|WORKSPACE|B|;S|AppDefinition|runtimes.customerDeployment|DEPLOYMENT|B|
S|AppRuntime|installations.workspace|WORKSPACE|B|
S|AppRelease|runtime.customerDeployment|DEPLOYMENT|B|;S|AppRelease|installations.workspace|WORKSPACE|B|
N|StripeWebhookEvent||||
`;

const CODE_TO_KIND = { D: "DIRECT_SCALAR", R: "RELATION_PATH", J: "DERIVED_UNIQUE_JOIN", S: "SHARED_PRESERVE", N: "NO_SELECTOR_PRESERVE" } as const;
const TARGET_MODEL: Record<TenantPurgeTargetDimension, TenantPurgeTargetModel> = { WORKSPACE: "Workspace", DEPLOYMENT: "CustomerDeployment", ACCOUNT: "CustomerAccount", TRIAL: "ProcurementTrial" };
const MODE_SET: Record<string, readonly TenantPurgeTargetMode[]> = { A: Object.freeze(["ACCOUNT_WORKSPACE"]), T: Object.freeze(["SELF_SERVE_TRIAL_WORKSPACE"]), B: TENANT_PURGE_TARGET_MODES };

export function decodeTenantPurgeDerivedSelectors(dsl: string): readonly TenantPurgeDerivedSelector[] {
  const seen = new Set<string>();
  const selectors = dsl.trim().split(/[;\n]+/).filter(Boolean).map((row) => {
    const [code, rawModel, payload, rawTarget, modeCode, rawEvidence, ...extra] = row.split("|");
    const kind = CODE_TO_KIND[code as keyof typeof CODE_TO_KIND];
    const model = rawModel as Prisma.ModelName;
    if (!kind || !Object.values(Prisma.ModelName).includes(model) || extra.length) throw new Error(`Invalid tenant purge selector row: ${row}`);
    const key = `${model}:${payload}:${rawTarget}`;
    if (seen.has(key)) throw new Error(`Duplicate tenant purge selector: ${key}`);
    seen.add(key);
    if (kind === "NO_SELECTOR_PRESERVE") {
      if (payload || rawTarget || modeCode || rawEvidence) throw new Error(`Invalid no-selector row: ${row}`);
      return Object.freeze({ kind, model, authorizesRoot: false }) satisfies TenantPurgeDerivedSelector;
    }
    const target = rawTarget as TenantPurgeTargetDimension;
    const modes = MODE_SET[modeCode];
    if (!TENANT_PURGE_TARGET_DIMENSIONS.includes(target) || !modes || !payload || (["WORKSPACE", "DEPLOYMENT"].includes(target) && modeCode !== "B") || (target === "ACCOUNT" && modeCode !== "A") || (target === "TRIAL" && modeCode !== "T")) throw new Error(`Invalid tenant purge selector scope: ${row}`);
    let selector: TenantPurgeDerivedSelector;
    if (kind === "DERIVED_UNIQUE_JOIN") {
      const match = payload.match(/^(\w+)>(\w+)\.(\w+)>(\w+)$/);
      const evidence = rawEvidence as typeof TENANT_PURGE_DERIVED_EVIDENCE_KINDS[number];
      if (!match || !TENANT_PURGE_DERIVED_EVIDENCE_KINDS.includes(evidence)) throw new Error(`Invalid derived join: ${row}`);
      selector = { kind, model, sourceField: match[1], joinedModel: match[2] as Prisma.ModelName, uniqueField: match[3], terminalField: match[4], target, modes, evidence, secondaryOnly: true, authorizesRoot: false };
    } else {
      if (rawEvidence || !/^(\w+)(\.\w+)*$/.test(payload)) throw new Error(`Invalid selector path: ${row}`);
      selector = { kind, model, path: Object.freeze(payload.split(".")), target, modes, authorizesRoot: false };
    }
    return Object.freeze(selector);
  });
  const preserveModels = new Set(selectors.filter((selector) => selector.kind === "SHARED_PRESERVE" || selector.kind === "NO_SELECTOR_PRESERVE").map((selector) => selector.model));
  if (selectors.some((selector) => preserveModels.has(selector.model) && selector.kind !== "SHARED_PRESERVE" && selector.kind !== "NO_SELECTOR_PRESERVE")) throw new Error("Invalid mixed preserve selector disposition.");
  return Object.freeze(selectors);
}

export const TENANT_PURGE_DERIVED_SELECTORS = decodeTenantPurgeDerivedSelectors(SELECTOR_DSL);
export const TENANT_PURGE_INDIRECT_MODELS = Object.freeze(["AdviceRequestRecipient", "AgentStep", "AgentToolCall", "ApprovalDecision", "BrainArticleVersion", "BrainDiscussionComment", "BrainDiscussionThread", "BuildArtifactAsset", "CircleAgentAssignment", "ContextMapLayoutItem", "ConversationTurn", "CrmConversationMessage", "ExternalDataSyncLog", "GoalLink", "GoalUpdate", "KeyResult", "MemberExpertise", "Objection", "Role", "RoleAssignment", "TensionUpvote", "WebhookDelivery", "WorkspaceToolLinkCircleTag"] as const satisfies readonly Prisma.ModelName[]);

export interface TenantPurgeSchemaField { name: string; kind: string; type: string; isId?: boolean; isUnique?: boolean }
export interface TenantPurgeSchemaModel { name: string; fields: readonly TenantPurgeSchemaField[] }

export function assertTenantPurgeDerivedSelectorRegistry(models: readonly TenantPurgeSchemaModel[], selectors: readonly TenantPurgeDerivedSelector[] = TENANT_PURGE_DERIVED_SELECTORS) {
  const modelMap = new Map(models.map((model) => [model.name, model]));
  const directFields = new Set<string>(TENANT_PURGE_DIRECT_RELATIONS.flatMap((relation) => relation.fields.map((field) => `${relation.model}.${field}`)));
  const directModels = new Set(TENANT_PURGE_DIRECT_RELATIONS.map((relation) => relation.model));
  const scalarTargets = new Map<string, TenantPurgeTargetDimension>(selectors.flatMap((selector) => selector.kind === "DIRECT_SCALAR" ? [[`${selector.model}.${selector.path[0]}`, selector.target] as const] : []));
  const field = (model: string, name: string) => modelMap.get(model)?.fields.find((candidate) => candidate.name === name);
  for (const selector of selectors) {
    if (selector.kind === "NO_SELECTOR_PRESERVE") continue;
    if (selector.kind === "DIRECT_SCALAR") {
      const selected = field(selector.model, selector.path[0]);
      if (selector.path.length !== 1 || selected?.kind !== "scalar" || selected.type !== "String" || directFields.has(`${selector.model}.${selected.name}`)) throw new Error(`Invalid direct scalar selector: ${selector.model}.${selector.path.join(".")}`);
      continue;
    }
    if (selector.kind === "DERIVED_UNIQUE_JOIN") {
      const source = field(selector.model, selector.sourceField);
      const unique = field(selector.joinedModel, selector.uniqueField);
      const terminal = field(selector.joinedModel, selector.terminalField);
      const targetModel = TARGET_MODEL[selector.target];
      const terminalDirect = TENANT_PURGE_DIRECT_RELATIONS.some((relation) => relation.model === selector.joinedModel && relation.target === targetModel && relation.fields.includes(selector.terminalField));
      const terminalScalar = scalarTargets.get(`${selector.joinedModel}.${selector.terminalField}`) === selector.target;
      const terminalRoot = selector.joinedModel === targetModel && selector.terminalField === "id" && terminal?.isId;
      if (source?.kind !== "scalar" || source.type !== "String" || unique?.kind !== "scalar" || unique.type !== "String" || (!unique.isUnique && !unique.isId) || (!terminalDirect && !terminalScalar && !terminalRoot)) throw new Error(`Invalid derived join selector: ${selector.model}.${selector.sourceField}`);
      continue;
    }
    let current = selector.model as string;
    for (const [index, segment] of selector.path.entries()) {
      const relation = field(current, segment);
      if (relation?.kind !== "object" || (index === selector.path.length - 1 ? relation.type !== TARGET_MODEL[selector.target] : !modelMap.has(relation.type))) throw new Error(`Invalid relation path: ${selector.model}.${selector.path.join(".")}`);
      current = relation.type;
    }
  }
  const covered = new Set<string>([...TENANT_PURGE_TARGET_MODELS, ...directModels, ...selectors.map((selector) => selector.model)]);
  const classified = Object.values(TENANT_PURGE_MODEL_DISPOSITIONS).flat();
  const missing = classified.filter((model) => !covered.has(model) || !modelMap.has(model));
  const sharedMissing = TENANT_PURGE_MODEL_DISPOSITIONS.SHARED_PRESERVE.filter((model) => !directModels.has(model) && !selectors.some((selector) => selector.model === model && selector.kind === "SHARED_PRESERVE"));
  const preserveModels = new Set(selectors.filter((selector) => selector.kind === "SHARED_PRESERVE" || selector.kind === "NO_SELECTOR_PRESERVE").map((selector) => selector.model));
  const invalidPreserve = selectors.filter((selector) => (selector.kind === "SHARED_PRESERVE" && !TENANT_PURGE_MODEL_DISPOSITIONS.SHARED_PRESERVE.includes(selector.model as never)) || (selector.kind === "NO_SELECTOR_PRESERVE" && ![...TENANT_PURGE_MODEL_DISPOSITIONS.RETAIN, ...TENANT_PURGE_MODEL_DISPOSITIONS.SHARED_PRESERVE].includes(selector.model as never)) || (preserveModels.has(selector.model) && selector.kind !== "SHARED_PRESERVE" && selector.kind !== "NO_SELECTOR_PRESERVE"));
  const indirect = [...new Set(selectors.filter((selector) => selector.kind === "RELATION_PATH" && TENANT_PURGE_MODEL_DISPOSITIONS.CASCADE.includes(selector.model as never) && !directModels.has(selector.model)).map((selector) => selector.model))].sort();
  const targetScalars = models.flatMap((model) => model.fields.filter((candidate) => candidate.kind === "scalar" && candidate.type === "String" && /(?:workspace|deployment|customerAccount|procurementTrial|targetAccount|targetDeployment|targetWorkspace|targetTrial)Id$/i.test(candidate.name)).map((candidate) => `${model.name}.${candidate.name}`));
  const externalIds = new Set<string>(["CustomerDeployment.remoteWorkspaceId", "WorkspaceIntegrationBinding.externalWorkspaceId", "CommunicationInstallation.externalWorkspaceId"]);
  const uncoveredScalars = targetScalars.filter((key) => !externalIds.has(key) && !directFields.has(key) && !scalarTargets.has(key));
  if (missing.length || sharedMissing.length || invalidPreserve.length || JSON.stringify(indirect) !== JSON.stringify([...TENANT_PURGE_INDIRECT_MODELS].sort()) || uncoveredScalars.length) throw new Error(`Tenant purge derived selector drift: missing=${missing} shared=${sharedMissing} preserve=${invalidPreserve.map((entry) => entry.model)} indirect=${indirect} scalar=${uncoveredScalars}`);
}

export const TENANT_PURGE_WRITER_EVIDENCE_FILES = Object.freeze(["resend", "bootstrap", "selfServe", "procurement", "meetingRecorders", "controlPlane"] as const);
export function assertTenantPurgeWriterEvidence(writers: Record<string, string>) {
  if (JSON.stringify(Object.keys(writers).sort()) !== JSON.stringify([...TENANT_PURGE_WRITER_EVIDENCE_FILES].sort()) || Object.values(writers).some((source) => source.includes("setupSessionId"))) throw new Error("Tenant purge writer inventory drift.");
  const resendLookup = writers.resend.indexOf("prisma.emailDelivery.findUnique");
  const resendEvent = writers.resend.indexOf("prisma.emailDeliveryEvent.upsert");
  const bootstrapEquality = writers.bootstrap.indexOf("workspace?.slug !== body.customerSlug");
  const bootstrapSeed = writers.bootstrap.indexOf("await runStableClientSeed", bootstrapEquality);
  const procurementCreates = [...writers.procurement.matchAll(/procurementIdempotencyKey\.create\(\{\s*data:\s*\{([^{}]*)\}\s*,?\s*\}\)/g)].map((match) => match[1]);
  const procurementEvidence = procurementCreates.length === 2 && procurementCreates.filter((body) => !body.includes("workspaceId:")).length === 1 && procurementCreates.filter((body) => body.includes("workspaceId: workspace.id")).length === 1 && /procurementIdempotencyKey\.updateMany\(\{\s*where:\s*\{[^{}]*workspaceId:\s*null[^{}]*\}\s*,?\s*data:\s*\{[^{}]*workspaceId:\s*workspace\.id/.test(writers.procurement);
  const checks = [resendLookup >= 0 && resendEvent > resendLookup && /emailDeliveryEvent\.upsert[\s\S]*create:[\s\S]*providerMessageId/.test(writers.resend.slice(resendEvent)) && writers.resend.slice(resendLookup, resendEvent).includes("where: { providerMessageId }"), writers.bootstrap.includes("customerSlug_bundleChecksum") && bootstrapEquality >= 0 && bootstrapSeed > bootstrapEquality, /selfServeEmailCapture\.create[\s\S]*workspaceId:[\s\S]*procurementTrialId:/.test(writers.selfServe) && /selfServeSmokeRun\.upsert/.test(writers.selfServe) && /selfServeSupportSession\.create[\s\S]*deploymentId:[\s\S]*workspaceId:/.test(writers.selfServe), procurementEvidence, /meetingRecorderSmokeRun\.create[\s\S]*workspaceId: params\.workspaceId[\s\S]*deploymentId: params\.deploymentId/.test(writers.meetingRecorders), /clientMigrationRun/.test(writers.controlPlane) && /supportOperation\.create[\s\S]*deploymentId:[\s\S]*workspaceId:/.test(writers.controlPlane)];
  if (checks.some((check) => !check)) throw new Error("Tenant purge writer evidence drift.");
}
