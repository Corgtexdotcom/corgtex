export const EXACT_TARGET_INVENTORY_SCHEMA_VERSION = "2.0.0";
export const EXACT_TARGET_INVENTORY_MAX_BYTES = 96_000;
export const EXACT_TARGET_INVENTORY_MAX_DEPTH = 12;
export const EXACT_TARGET_INVENTORY_MAX_TARGETS_PER_CLASS = 4;
export const EXACT_TARGET_INVENTORY_MAX_COMPONENTS_PER_TARGET = 12;
export const EXACT_TARGET_INVENTORY_MAX_DEPENDENCIES_PER_COMPONENT = 8;
export const EXACT_TARGET_INVENTORY_MAX_ISSUES = 32;
export const EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES = 8_192;

export const exactTargetInventoryWorkloadClasses = Object.freeze([
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
] as const);

export type ExactTargetInventoryWorkloadClass = typeof exactTargetInventoryWorkloadClasses[number];

export const exactTargetInventoryComponentKinds = Object.freeze([
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
] as const);

export type ExactTargetInventoryComponentKind = typeof exactTargetInventoryComponentKinds[number];

export const exactTargetInventoryClaimKinds = Object.freeze([
  "LIFECYCLE",
  "AUTHORITY",
  "COMPLETENESS",
  "DEPENDENCY",
  "ROLLBACK",
  "POLICY",
] as const);

export type ExactTargetInventoryClaimKind = typeof exactTargetInventoryClaimKinds[number];

export const exactTargetInventoryProofPurposes = Object.freeze([
  "target-lifecycle",
  "target-authority",
  "target-completeness",
  "component-dependency",
  "component-rollback",
  "target-policy",
] as const);

export type ExactTargetInventoryProofPurpose = typeof exactTargetInventoryProofPurposes[number];

export const exactTargetInventoryClassDispositions = Object.freeze([
  "SELECTABLE",
  "BLOCKED",
  "DECISION_REQUIRED",
  "RETIRE_ONLY",
] as const);

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
  | "DISPOSITION_MISMATCH"
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
  readonly claim: ExactTargetInventoryClaim;
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
  readonly completenessClaim: ExactTargetInventoryCompletenessClaim;
  readonly policyClaim: ExactTargetInventoryClaim;
  readonly components: readonly ExactTargetInventoryComponent[];
};

export type ExactTargetInventoryCompletenessClaim = ExactTargetInventoryClaim & {
  readonly topologyDigest: string;
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly rollbackCount: number;
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
  readonly workloadClass?: ExactTargetInventoryWorkloadClass;
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

export const exactTargetInventoryFieldOwnership: readonly ExactTargetInventoryFieldOwner[] = Object.freeze([
  Object.freeze({ fact: "schema version", owner: "document.schemaVersion" }),
  Object.freeze({ fact: "generation time", owner: "document.generatedAt" }),
  Object.freeze({ fact: "workload class identity", owner: "class.workloadClass" }),
  Object.freeze({ fact: "root disposition", owner: "class.disposition" }),
  Object.freeze({ fact: "target identity", owner: "target.targetId" }),
  Object.freeze({ fact: "component identity", owner: "target.components[].componentId" }),
  Object.freeze({ fact: "dependency edge", owner: "consumer component dependencies[]" }),
  Object.freeze({ fact: "rollback obligation", owner: "owning component rollback" }),
  Object.freeze({ fact: "claim status", owner: "inline claim proof" }),
  Object.freeze({ fact: "artifact identity", owner: "inline proof artifact path and digest" }),
  Object.freeze({ fact: "selection", owner: "evaluateExactTargetInventoryJson invocation" }),
] as const);

export const exactTargetInventoryUseSiteProofRequirements = Object.freeze({
  lifecycleClaim: Object.freeze({ kind: "LIFECYCLE", purpose: "target-lifecycle" }),
  authorityClaim: Object.freeze({ kind: "AUTHORITY", purpose: "target-authority" }),
  completenessClaim: Object.freeze({ kind: "COMPLETENESS", purpose: "target-completeness" }),
  policyClaim: Object.freeze({ kind: "POLICY", purpose: "target-policy" }),
  dependencyClaim: Object.freeze({ kind: "DEPENDENCY", purpose: "component-dependency" }),
  rollbackClaim: Object.freeze({ kind: "ROLLBACK", purpose: "component-rollback" }),
} as const);

export const exactTargetInventoryRequiredDispositions = Object.freeze({
  ACTIVE_CLIENT_PRIMARY: "SELECTABLE",
  ACTIVE_CLIENT_AUTHORITY_UNPROVEN: "BLOCKED",
  ACTIVE_CLIENT_CANARY: "BLOCKED",
  ACTIVE_CLIENT_DECISION_REQUIRED: "DECISION_REQUIRED",
  CORE_WEB: "SELECTABLE",
  CORE_WORKER: "SELECTABLE",
  MCP: "SELECTABLE",
  PUBLIC_SITE: "SELECTABLE",
  SELFSERVE: "BLOCKED",
  STAGING_TEST_E2E: "BLOCKED",
  DEMO: "DECISION_REQUIRED",
  OPS_CONTROL_PLANE: "BLOCKED",
  RESIDUAL_RAILWAY: "RETIRE_ONLY",
  DUPLICATE_AZURE: "RETIRE_ONLY",
} as const satisfies Record<ExactTargetInventoryWorkloadClass, ExactTargetInventoryClassDisposition>);
