export const EXACT_TARGET_INVENTORY_SCHEMA_VERSION = "2.0.0";
export const EXACT_TARGET_INVENTORY_MAX_BYTES = 96_000;
export const EXACT_TARGET_INVENTORY_MAX_DEPTH = 12;
export const EXACT_TARGET_INVENTORY_MAX_TARGETS_PER_CLASS = 4;
export const EXACT_TARGET_INVENTORY_MAX_COMPONENTS_PER_TARGET = 12;
export const EXACT_TARGET_INVENTORY_MAX_DEPENDENCIES_PER_COMPONENT = 8;
export const EXACT_TARGET_INVENTORY_MAX_ISSUES = 32;

export const exactTargetInventoryWorkloadClasses = [
  "ACTIVE_CLIENT_PRIMARY",
  "ACTIVE_CLIENT_AUTHORITY_UNPROVEN",
  "ACTIVE_CLIENT_CANARY",
  "ACTIVE_CLIENT_DECISION_REQUIRED",
  "CORE_WEB",
  "CORE_WORKER",
  "MCP",
  "PUBLIC_SITE",
  "SELFSERVE",
  "STAGING_TEST_E2E",
  "DEMO",
  "OPS_CONTROL_PLANE",
  "RESIDUAL_RAILWAY",
  "DUPLICATE_AZURE",
] as const;

export type ExactTargetInventoryWorkloadClass = typeof exactTargetInventoryWorkloadClasses[number];

export const exactTargetInventoryComponentKinds = [
  "WEB_APP",
  "WORKER_APP",
  "MCP_SERVER",
  "PUBLIC_SITE",
  "CONTROL_PLANE",
  "DATABASE",
  "QUEUE",
  "CACHE",
  "STORAGE",
  "REGISTRY",
  "SECRET_BINDING",
  "OBSERVABILITY",
] as const;

export type ExactTargetInventoryComponentKind = typeof exactTargetInventoryComponentKinds[number];

export const exactTargetInventoryClaimKinds = [
  "LIFECYCLE",
  "AUTHORITY",
  "COMPLETENESS",
  "DEPENDENCY",
  "ROLLBACK",
  "POLICY",
] as const;

export type ExactTargetInventoryClaimKind = typeof exactTargetInventoryClaimKinds[number];

export const exactTargetInventoryProofPurposes = [
  "target-lifecycle",
  "target-authority",
  "target-completeness",
  "component-dependency",
  "component-rollback",
  "target-policy",
] as const;

export type ExactTargetInventoryProofPurpose = typeof exactTargetInventoryProofPurposes[number];

export const exactTargetInventoryClassDispositions = [
  "SELECTABLE",
  "BLOCKED",
  "DECISION_REQUIRED",
  "RETIRE_ONLY",
] as const;

export type ExactTargetInventoryClassDisposition = typeof exactTargetInventoryClassDispositions[number];

export type ExactTargetInventoryIssueCode =
  | "INPUT_NOT_STRING"
  | "INPUT_TOO_LARGE"
  | "JSON_MALFORMED"
  | "DUPLICATE_JSON_KEY"
  | "SCHEMA_MISMATCH"
  | "UNKNOWN_KEY"
  | "LIMIT_EXCEEDED"
  | "TYPE_MISMATCH"
  | "INVALID_VALUE"
  | "CLASS_CARDINALITY_INVALID"
  | "TARGET_CARDINALITY_INVALID"
  | "TARGET_IDENTITY_REUSED"
  | "COMPONENT_TOPOLOGY_INVALID"
  | "DEPENDENCY_INVALID"
  | "DEPENDENCY_CYCLE"
  | "ROLLBACK_INVALID"
  | "PROOF_INVALID"
  | "PROOF_ARTIFACT_REUSED"
  | "PROOF_CHRONOLOGY_INVALID"
  | "PROOF_EXPIRED"
  | "CLASS_BLOCKED"
  | "RETIREMENT_BLOCKED"
  | "REQUESTED_CLASS_NOT_FOUND";

export type ExactTargetInventoryIssue = {
  readonly code: ExactTargetInventoryIssueCode;
  readonly scope: "input" | "artifact" | "class" | "target" | "component" | "proof" | "selection";
  readonly workloadClass?: ExactTargetInventoryWorkloadClass;
};

export type ExactTargetInventoryArtifactIdentity = {
  readonly path: string;
  readonly digest: string;
};

export type ExactTargetInventoryProof = {
  readonly purpose: ExactTargetInventoryProofPurpose;
  readonly owner: string;
  readonly claimKind: ExactTargetInventoryClaimKind;
  readonly finality: "SETTLED";
  readonly artifact: ExactTargetInventoryArtifactIdentity;
  readonly observedAt: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
};

export type ExactTargetInventoryClaim = {
  readonly kind: ExactTargetInventoryClaimKind;
  readonly owner: string;
  readonly assertedAt: string;
  readonly proof: ExactTargetInventoryProof;
};

export type ExactTargetInventoryDependency = {
  readonly componentId: string;
  readonly kind: ExactTargetInventoryComponentKind;
};

export type ExactTargetInventoryRollback = {
  readonly strategy: "PREVIOUS_IMAGE" | "PREVIOUS_CONFIG" | "RESTORE_SNAPSHOT";
  readonly predecessorRef: string;
  readonly claim: ExactTargetInventoryClaim;
};

export type ExactTargetInventoryComponent = {
  readonly componentId: string;
  readonly kind: ExactTargetInventoryComponentKind;
  readonly required: boolean;
  readonly dependencies: readonly ExactTargetInventoryDependency[];
  readonly rollback?: ExactTargetInventoryRollback;
};

export type ExactTargetInventoryTarget = {
  readonly targetId: string;
  readonly lifecycleClaim: ExactTargetInventoryClaim;
  readonly authorityClaim: ExactTargetInventoryClaim;
  readonly completenessClaim: ExactTargetInventoryClaim;
  readonly policyClaim: ExactTargetInventoryClaim;
  readonly components: readonly ExactTargetInventoryComponent[];
};

export type ExactTargetInventoryClassBundle = {
  readonly workloadClass: ExactTargetInventoryWorkloadClass;
  readonly disposition: ExactTargetInventoryClassDisposition;
  readonly rootClaim: ExactTargetInventoryClaim;
  readonly targets: readonly ExactTargetInventoryTarget[];
};

export type ExactTargetInventoryDocument = {
  readonly schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  readonly inventoryId: string;
  readonly generatedAt: string;
  readonly classes: readonly ExactTargetInventoryClassBundle[];
};

export type ExactTargetInventoryClassProjection = {
  readonly workloadClass: ExactTargetInventoryWorkloadClass;
  readonly disposition: ExactTargetInventoryClassDisposition;
  readonly targetCount: number;
  readonly eligibleTargetCount: number;
  readonly status: "ELIGIBLE" | "BLOCKED" | "INVALID";
  readonly issueCodes: readonly ExactTargetInventoryIssueCode[];
};

export type ExactTargetInventorySelectionProjection = {
  readonly workloadClass: ExactTargetInventoryWorkloadClass;
  readonly status: "SELECTED" | "BLOCKED" | "INVALID";
  readonly opaqueTargetId?: string;
  readonly issueCodes: readonly ExactTargetInventoryIssueCode[];
};

export type ExactTargetInventoryEvaluationResult = {
  readonly ok: boolean;
  readonly schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  readonly artifactStatus: "VALID" | "INVALID";
  readonly evaluatedAt: string;
  readonly validUntil: string | null;
  readonly canonicalDigest: string | null;
  readonly issueCodes: readonly ExactTargetInventoryIssueCode[];
  readonly issues: readonly ExactTargetInventoryIssue[];
  readonly classes: readonly ExactTargetInventoryClassProjection[];
  readonly selection?: ExactTargetInventorySelectionProjection;
};

export type ExactTargetInventoryEvaluationOptions = {
  readonly now: string | Date;
  readonly requestedWorkloadClass?: ExactTargetInventoryWorkloadClass;
};

export type ExactTargetInventoryFieldOwner = {
  readonly fact: string;
  readonly owner: string;
};

export const exactTargetInventoryFieldOwnership: readonly ExactTargetInventoryFieldOwner[] = [
  { fact: "schema version", owner: "document.schemaVersion" },
  { fact: "generation time", owner: "document.generatedAt" },
  { fact: "workload class identity", owner: "class.workloadClass" },
  { fact: "root disposition", owner: "class.disposition" },
  { fact: "target identity", owner: "target.targetId" },
  { fact: "component identity", owner: "target.components[].componentId" },
  { fact: "dependency edge", owner: "consumer component dependencies[]" },
  { fact: "rollback obligation", owner: "owning component rollback" },
  { fact: "claim status", owner: "inline claim proof" },
  { fact: "artifact identity", owner: "inline proof artifact path and digest" },
  { fact: "selection", owner: "evaluateExactTargetInventoryJson invocation" },
] as const;

export const exactTargetInventoryUseSiteProofRequirements = {
  lifecycleClaim: { kind: "LIFECYCLE", purpose: "target-lifecycle" },
  authorityClaim: { kind: "AUTHORITY", purpose: "target-authority" },
  completenessClaim: { kind: "COMPLETENESS", purpose: "target-completeness" },
  policyClaim: { kind: "POLICY", purpose: "target-policy" },
  dependencyClaim: { kind: "DEPENDENCY", purpose: "component-dependency" },
  rollbackClaim: { kind: "ROLLBACK", purpose: "component-rollback" },
} as const;
