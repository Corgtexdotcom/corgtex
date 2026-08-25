import { createHash } from "node:crypto";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  EXACT_TARGET_INVENTORY_MAX_COMPONENTS_PER_TARGET,
  EXACT_TARGET_INVENTORY_MAX_DEPENDENCIES_PER_COMPONENT,
  EXACT_TARGET_INVENTORY_MAX_DEPTH,
  EXACT_TARGET_INVENTORY_MAX_ISSUES,
  EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES,
  EXACT_TARGET_INVENTORY_MAX_TARGETS_PER_CLASS,
  EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
  exactTargetInventoryClassDispositions,
  exactTargetInventoryClaimKinds,
  exactTargetInventoryComponentKinds,
  exactTargetInventoryProofPurposes,
  exactTargetInventoryRequiredDispositions,
  exactTargetInventoryUseSiteProofRequirements,
  exactTargetInventoryWorkloadClasses,
  type ExactTargetInventoryArtifactIdentity,
  type ExactTargetInventoryClassBundle,
  type ExactTargetInventoryClassProjection,
  type ExactTargetInventoryClaim,
  type ExactTargetInventoryComponent,
  type ExactTargetInventoryCompletenessClaim,
  type ExactTargetInventoryDependency,
  type ExactTargetInventoryDocument,
  type ExactTargetInventoryEvaluationOptions,
  type ExactTargetInventoryEvaluationResult,
  type ExactTargetInventoryIssue,
  type ExactTargetInventoryIssueCode,
  type ExactTargetInventoryProof,
  type ExactTargetInventoryRollback,
  type ExactTargetInventorySelectionProjection,
  type ExactTargetInventoryTarget,
  type ExactTargetInventoryWorkloadClass,
} from "./exact-target-inventory-contract";

type MutableIssue = ExactTargetInventoryIssue;
type TargetTopology = {
  readonly digest: string;
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly rollbackCount: number;
};
type RequestedWorkloadClass =
  | { readonly status: "NONE" }
  | { readonly status: "VALID"; readonly workloadClass: ExactTargetInventoryWorkloadClass }
  | { readonly status: "INVALID" };
type NormalizedOptions = {
  readonly evaluatedAt: string;
  readonly requested: RequestedWorkloadClass;
};
type OptionsResult =
  | { readonly ok: true; readonly options: NormalizedOptions }
  | { readonly ok: false; readonly evaluatedAt: string };

const workloadClasses = Object.freeze([...exactTargetInventoryWorkloadClasses]);
const workloadClassSet = new Set<string>(workloadClasses);
const componentKinds = Object.freeze([...exactTargetInventoryComponentKinds]);
const classDispositions = Object.freeze([...exactTargetInventoryClassDispositions]);
const requiredDispositions = Object.freeze({ ...exactTargetInventoryRequiredDispositions });
const rollbackStrategies = Object.freeze(["PREVIOUS_IMAGE", "PREVIOUS_CONFIG", "RESTORE_SNAPSHOT"] as const);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const enumHas = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && values.includes(value);

const requestedWorkloadClass = (requested: unknown): RequestedWorkloadClass => {
  if (requested === undefined) return { status: "NONE" };
  if (typeof requested === "string" && workloadClassSet.has(requested)) {
    return { status: "VALID", workloadClass: requested as ExactTargetInventoryWorkloadClass };
  }
  return { status: "INVALID" };
};

const boundedId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

const boundedSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{2,63}$/.test(value);

const boundedPath = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^evidence\/[a-z0-9][a-z0-9./-]{2,120}\.json$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && segment.length > 0);
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const issue = (
  code: ExactTargetInventoryIssueCode,
  scope: ExactTargetInventoryIssue["scope"],
  workloadClass?: ExactTargetInventoryWorkloadClass,
): MutableIssue => workloadClass === undefined ? { code, scope } : { code, scope, workloadClass };

const uniqueCodes = (issues: readonly ExactTargetInventoryIssue[]): readonly ExactTargetInventoryIssueCode[] =>
  [...new Set(issues.map((item) => item.code))].slice(0, EXACT_TARGET_INVENTORY_MAX_ISSUES);

const fail = (
  code: ExactTargetInventoryIssueCode,
  scope: ExactTargetInventoryIssue["scope"],
  options: NormalizedOptions,
): ExactTargetInventoryEvaluationResult => {
  const issues = [issue(code, scope)];
  return {
    ok: false,
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    artifactStatus: "INVALID",
    evaluatedAt: options.evaluatedAt,
    validUntil: null,
    canonicalDigest: null,
    issueCodes: uniqueCodes(issues),
    issues,
    classes: [],
    ...(options.requested.status === "NONE" ? {} : {
      selection: {
        ...(options.requested.status === "VALID" ? { workloadClass: options.requested.workloadClass } : {}),
        status: "INVALID",
        issueCodes: [code],
      } satisfies ExactTargetInventorySelectionProjection,
    }),
  };
};

const failInvalidOptions = (evaluatedAt = "1970-01-01T00:00:00.000Z"): ExactTargetInventoryEvaluationResult => ({
  ok: false,
  schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
  artifactStatus: "INVALID",
  evaluatedAt,
  validUntil: null,
  canonicalDigest: null,
  issueCodes: ["INVALID_VALUE"],
  issues: [issue("INVALID_VALUE", "input")],
  classes: [],
});

const parseInstant = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};

const normalizeNowValue = (value: unknown): string | null => {
  if (typeof value === "string") return parseInstant(value) === null ? null : value;
  if (value instanceof Date) {
    try {
      const time = Date.prototype.getTime.call(value);
      return Number.isFinite(time) ? new Date(time).toISOString() : null;
    } catch {
      return null;
    }
  }
  return null;
};

const normalizeOptions = (value: ExactTargetInventoryEvaluationOptions): OptionsResult => {
  try {
    if (!isRecord(value)) return { ok: false, evaluatedAt: "1970-01-01T00:00:00.000Z" };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (!keys.includes("now") || keys.some((key) => key !== "now" && key !== "requestedWorkloadClass")) {
      return { ok: false, evaluatedAt: "1970-01-01T00:00:00.000Z" };
    }
    const nowDescriptor = descriptors.now;
    const requestedDescriptor = descriptors.requestedWorkloadClass;
    if (nowDescriptor === undefined || !Object.hasOwn(nowDescriptor, "value")
      || (requestedDescriptor !== undefined && !Object.hasOwn(requestedDescriptor, "value"))) {
      return { ok: false, evaluatedAt: "1970-01-01T00:00:00.000Z" };
    }
    const evaluatedAt = normalizeNowValue(nowDescriptor.value);
    if (evaluatedAt === null) return { ok: false, evaluatedAt: "1970-01-01T00:00:00.000Z" };
    return {
      ok: true,
      options: {
        evaluatedAt,
        requested: requestedWorkloadClass(requestedDescriptor?.value),
      },
    };
  } catch {
    return { ok: false, evaluatedAt: "1970-01-01T00:00:00.000Z" };
  }
};

const detectDuplicateJsonKeys = (text: string): boolean => {
  const stack: Array<Set<string> | null> = [];
  let currentKey = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const next = text[end];
        if (escaped) {
          escaped = false;
        } else if (next === "\\") {
          escaped = true;
        } else if (next === "\"") {
          break;
        }
        end += 1;
      }
      if (end >= text.length) return false;
      const after = text.slice(end + 1).match(/^\s*:/);
      if (after && stack.at(-1) instanceof Set && currentKey) {
        try {
          const key = JSON.parse(text.slice(index, end + 1)) as string;
          const keys = stack.at(-1) as Set<string>;
          if (keys.has(key)) return true;
          keys.add(key);
        } catch {
          return false;
        }
      }
      index = end;
    } else if (char === "{") {
      stack.push(new Set<string>());
      currentKey = true;
    } else if (char === "[") {
      stack.push(null);
      currentKey = false;
    } else if (char === "}") {
      stack.pop();
      currentKey = false;
    } else if (char === "]") {
      stack.pop();
      currentKey = false;
    } else if (char === ",") {
      currentKey = stack.at(-1) instanceof Set;
    }
  }
  return false;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const targetTopology = (components: readonly ExactTargetInventoryComponent[]): TargetTopology => {
  const normalized = components.map((component) => ({
    componentId: component.componentId,
    kind: component.kind,
    required: component.required,
    dependencies: component.dependencies.map((dependency) => ({
      componentId: dependency.componentId,
      kind: dependency.kind,
    })).sort((a, b) => a.componentId.localeCompare(b.componentId)),
    rollback: component.rollback === undefined ? null : {
      strategy: component.rollback.strategy,
      predecessorRef: component.rollback.predecessorRef,
    },
  })).sort((a, b) => a.componentId.localeCompare(b.componentId));
  return {
    digest: `sha256:${digest(canonicalJson(normalized))}`,
    componentCount: components.length,
    dependencyCount: components.reduce((count, component) => count + component.dependencies.length, 0),
    rollbackCount: components.reduce((count, component) => count + (component.rollback === undefined ? 0 : 1), 0),
  };
};

const depthOf = (value: unknown, depth = 0): number => {
  if (depth > EXACT_TARGET_INVENTORY_MAX_DEPTH) return depth;
  if (value === null || typeof value !== "object") return depth;
  if (Array.isArray(value)) return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  return Object.values(value as Record<string, unknown>).reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
};

class Reader {
  public readonly issues: MutableIssue[] = [];
  private readonly artifactPaths = new Map<string, string>();
  private readonly artifactDigests = new Map<string, string>();
  private readonly proofExpiries: string[] = [];
  private readonly componentIds = new Set<string>();
  private readonly targetIds = new Set<string>();
  private readonly now: number;
  private readonly generatedAt: number;

  public constructor(nowIso: string, generatedAt: string) {
    this.now = Date.parse(nowIso);
    this.generatedAt = parseInstant(generatedAt) ?? Number.NaN;
  }

  public add(code: ExactTargetInventoryIssueCode, scope: ExactTargetInventoryIssue["scope"], workloadClass?: ExactTargetInventoryWorkloadClass): void {
    if (this.issues.length < EXACT_TARGET_INVENTORY_MAX_ISSUES) this.issues.push(issue(code, scope, workloadClass));
  }

  public artifact(value: unknown): ExactTargetInventoryArtifactIdentity | null {
    if (!isRecord(value) || !exactKeys(value, ["path", "digest"])) {
      this.add("UNKNOWN_KEY", "proof");
      return null;
    }
    if (!boundedPath(value.path) || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
      this.add("INVALID_VALUE", "proof");
      return null;
    }
    if (this.artifactPaths.has(value.path) || this.artifactDigests.has(value.digest)) {
      this.add("PROOF_ARTIFACT_REUSED", "proof");
    }
    this.artifactPaths.set(value.path, value.digest);
    this.artifactDigests.set(value.digest, value.path);
    return { path: value.path, digest: value.digest };
  }

  public validUntil(): string | null {
    return [...this.proofExpiries].sort()[0] ?? null;
  }

  public proof(value: unknown, owner: string, claimKind: ExactTargetInventoryClaim["kind"], purpose: ExactTargetInventoryProof["purpose"]): ExactTargetInventoryProof | null {
    if (!isRecord(value) || !exactKeys(value, ["purpose", "owner", "claimKind", "finality", "artifact", "observedAt", "verifiedAt", "expiresAt"])) {
      this.add("UNKNOWN_KEY", "proof");
      return null;
    }
    const artifact = this.artifact(value.artifact);
    if (value.owner !== owner || value.claimKind !== claimKind || value.purpose !== purpose || value.finality !== "SETTLED" || artifact === null) {
      this.add("PROOF_INVALID", "proof");
      return null;
    }
    const observedAt = parseInstant(value.observedAt);
    const verifiedAt = parseInstant(value.verifiedAt);
    const expiresAt = parseInstant(value.expiresAt);
    if (observedAt === null || verifiedAt === null || expiresAt === null || observedAt > verifiedAt || expiresAt <= this.now
      || typeof value.observedAt !== "string" || typeof value.verifiedAt !== "string" || typeof value.expiresAt !== "string") {
      this.add(expiresAt !== null && expiresAt <= this.now ? "PROOF_EXPIRED" : "PROOF_CHRONOLOGY_INVALID", "proof");
      return null;
    }
    this.proofExpiries.push(value.expiresAt);
    return {
      purpose,
      owner,
      claimKind,
      finality: "SETTLED",
      artifact,
      observedAt: value.observedAt,
      verifiedAt: value.verifiedAt,
      expiresAt: value.expiresAt,
    };
  }

  public claim(value: unknown, owner: string, claimKind: ExactTargetInventoryClaim["kind"], purpose: ExactTargetInventoryProof["purpose"]): ExactTargetInventoryClaim | null {
    if (!isRecord(value) || !exactKeys(value, ["kind", "owner", "assertedAt", "proof"])) {
      this.add("UNKNOWN_KEY", "proof");
      return null;
    }
    const assertedAt = parseInstant(value.assertedAt);
    const proof = this.proof(value.proof, owner, claimKind, purpose);
    const verifiedAt = proof === null ? null : parseInstant(proof.verifiedAt);
    if (value.owner !== owner || value.kind !== claimKind || assertedAt === null || proof === null || verifiedAt === null || typeof value.assertedAt !== "string") {
      this.add("PROOF_INVALID", "proof");
      return null;
    }
    if (verifiedAt > assertedAt || assertedAt > this.generatedAt || this.generatedAt > this.now) {
      this.add("PROOF_CHRONOLOGY_INVALID", "proof");
      return null;
    }
    return { kind: claimKind, owner, assertedAt: value.assertedAt, proof };
  }

  public completenessClaim(value: unknown, owner: string, topology: TargetTopology): ExactTargetInventoryCompletenessClaim | null {
    if (!isRecord(value) || !exactKeys(value, ["kind", "owner", "assertedAt", "proof", "topologyDigest", "componentCount", "dependencyCount", "rollbackCount"])) {
      this.add("UNKNOWN_KEY", "proof");
      return null;
    }
    const claim = this.claim(
      {
        kind: value.kind,
        owner: value.owner,
        assertedAt: value.assertedAt,
        proof: value.proof,
      },
      owner,
      "COMPLETENESS",
      exactTargetInventoryUseSiteProofRequirements.completenessClaim.purpose,
    );
    if (claim === null || value.topologyDigest !== topology.digest || value.componentCount !== topology.componentCount
      || value.dependencyCount !== topology.dependencyCount || value.rollbackCount !== topology.rollbackCount) {
      this.add("PROOF_INVALID", "proof");
      return null;
    }
    return {
      ...claim,
      topologyDigest: value.topologyDigest,
      componentCount: value.componentCount,
      dependencyCount: value.dependencyCount,
      rollbackCount: value.rollbackCount,
    };
  }

  public dependency(value: unknown, owner: string): ExactTargetInventoryDependency | null {
    if (!isRecord(value) || !exactKeys(value, ["componentId", "kind", "claim"])) {
      this.add("UNKNOWN_KEY", "component");
      return null;
    }
    if (!boundedId(value.componentId) || !enumHas(componentKinds, value.kind)) {
      this.add("DEPENDENCY_INVALID", "component");
      return null;
    }
    const claim = this.claim(value.claim, owner, "DEPENDENCY", exactTargetInventoryUseSiteProofRequirements.dependencyClaim.purpose);
    if (claim === null) return null;
    return { componentId: value.componentId, kind: value.kind, claim };
  }

  public rollback(value: unknown, owner: string): ExactTargetInventoryRollback | null {
    if (!isRecord(value) || !exactKeys(value, ["strategy", "predecessorRef", "claim"])) {
      this.add("UNKNOWN_KEY", "component");
      return null;
    }
    if (!enumHas(rollbackStrategies, value.strategy) || !boundedId(value.predecessorRef)) {
      this.add("ROLLBACK_INVALID", "component");
      return null;
    }
    const claim = this.claim(value.claim, `${owner}->${value.predecessorRef}`, "ROLLBACK", exactTargetInventoryUseSiteProofRequirements.rollbackClaim.purpose);
    if (claim === null) return null;
    return { strategy: value.strategy, predecessorRef: value.predecessorRef, claim };
  }

  public component(value: unknown): ExactTargetInventoryComponent | null {
    if (!isRecord(value) || !["componentId", "kind", "required", "dependencies"].every((key) => Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !["componentId", "kind", "required", "dependencies", "rollback"].includes(key))) {
      this.add("UNKNOWN_KEY", "component");
      return null;
    }
    if (!boundedId(value.componentId) || !enumHas(componentKinds, value.kind) || typeof value.required !== "boolean" || !Array.isArray(value.dependencies)) {
      this.add("TYPE_MISMATCH", "component");
      return null;
    }
    if (this.componentIds.has(value.componentId)) this.add("COMPONENT_TOPOLOGY_INVALID", "component");
    this.componentIds.add(value.componentId);
    if (value.dependencies.length > EXACT_TARGET_INVENTORY_MAX_DEPENDENCIES_PER_COMPONENT) this.add("LIMIT_EXCEEDED", "component");
    const dependencies = value.dependencies.map((item) => this.dependency(item, `${value.componentId}->${isRecord(item) && typeof item.componentId === "string" ? item.componentId : "invalid"}`)).filter((item): item is ExactTargetInventoryDependency => item !== null);
    const rollback = Object.hasOwn(value, "rollback") ? this.rollback(value.rollback, value.componentId) : undefined;
    if (value.required && rollback === undefined) this.add("ROLLBACK_INVALID", "component");
    if (rollback === null) this.add("ROLLBACK_INVALID", "component");
    return {
      componentId: value.componentId,
      kind: value.kind,
      required: value.required,
      dependencies,
      ...(rollback === undefined || rollback === null ? {} : { rollback }),
    };
  }

  public target(value: unknown): ExactTargetInventoryTarget | null {
    if (!isRecord(value) || !exactKeys(value, ["targetId", "lifecycleClaim", "authorityClaim", "completenessClaim", "policyClaim", "components"])) {
      this.add("UNKNOWN_KEY", "target");
      return null;
    }
    if (!boundedId(value.targetId) || !Array.isArray(value.components)) {
      this.add("TYPE_MISMATCH", "target");
      return null;
    }
    if (this.targetIds.has(value.targetId)) this.add("TARGET_IDENTITY_REUSED", "target");
    this.targetIds.add(value.targetId);
    if (value.components.length === 0 || value.components.length > EXACT_TARGET_INVENTORY_MAX_COMPONENTS_PER_TARGET) this.add("LIMIT_EXCEEDED", "target");
    const components = value.components.map((item) => this.component(item)).filter((item): item is ExactTargetInventoryComponent => item !== null);
    validateComponentTopology(components, this);
    const topology = targetTopology(components);
    const lifecycleClaim = this.claim(value.lifecycleClaim, value.targetId, "LIFECYCLE", exactTargetInventoryUseSiteProofRequirements.lifecycleClaim.purpose);
    const authorityClaim = this.claim(value.authorityClaim, value.targetId, "AUTHORITY", exactTargetInventoryUseSiteProofRequirements.authorityClaim.purpose);
    const completenessClaim = this.completenessClaim(value.completenessClaim, value.targetId, topology);
    const policyClaim = this.claim(value.policyClaim, value.targetId, "POLICY", exactTargetInventoryUseSiteProofRequirements.policyClaim.purpose);
    if (lifecycleClaim === null || authorityClaim === null || completenessClaim === null || policyClaim === null) return null;
    return { targetId: value.targetId, lifecycleClaim, authorityClaim, completenessClaim, policyClaim, components };
  }

  public classBundle(value: unknown): ExactTargetInventoryClassBundle | null {
    if (!isRecord(value) || !exactKeys(value, ["workloadClass", "disposition", "rootClaim", "targets"])) {
      this.add("UNKNOWN_KEY", "class");
      return null;
    }
    if (!enumHas(workloadClasses, value.workloadClass) || !enumHas(classDispositions, value.disposition) || !Array.isArray(value.targets)) {
      this.add("TYPE_MISMATCH", "class");
      return null;
    }
    if (value.disposition !== requiredDispositions[value.workloadClass]) this.add("DISPOSITION_MISMATCH", "class", value.workloadClass);
    if (value.targets.length > EXACT_TARGET_INVENTORY_MAX_TARGETS_PER_CLASS) this.add("LIMIT_EXCEEDED", "class", value.workloadClass);
    if (value.disposition === "SELECTABLE" && value.targets.length > 1) this.add("TARGET_CARDINALITY_INVALID", "target", value.workloadClass);
    const rootClaim = this.claim(value.rootClaim, `class-${value.workloadClass.toLowerCase().replaceAll("_", "-")}`, "AUTHORITY", exactTargetInventoryUseSiteProofRequirements.authorityClaim.purpose);
    const targets = value.targets.map((item) => this.target(item)).filter((item): item is ExactTargetInventoryTarget => item !== null);
    if (rootClaim === null) return null;
    return { workloadClass: value.workloadClass, disposition: value.disposition, rootClaim, targets };
  }
}

const validateComponentTopology = (components: readonly ExactTargetInventoryComponent[], reader: Reader): void => {
  const componentIds = new Set(components.map((component) => component.componentId));
  const componentById = new Map(components.map((component) => [component.componentId, component]));
  for (const component of components) {
    const seenDependencies = new Set<string>();
    for (const dependency of component.dependencies) {
      const target = componentById.get(dependency.componentId);
      if (!componentIds.has(dependency.componentId) || dependency.componentId === component.componentId || seenDependencies.has(dependency.componentId)
        || target?.kind !== dependency.kind) {
        reader.add("DEPENDENCY_INVALID", "component");
      }
      seenDependencies.add(dependency.componentId);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (componentId: string): boolean => {
    if (visiting.has(componentId)) return false;
    if (visited.has(componentId)) return true;
    visiting.add(componentId);
    const component = components.find((item) => item.componentId === componentId);
    for (const dependency of component?.dependencies ?? []) {
      if (!visit(dependency.componentId)) return false;
    }
    visiting.delete(componentId);
    visited.add(componentId);
    return true;
  };
  for (const component of components) {
    if (!visit(component.componentId)) {
      reader.add("DEPENDENCY_CYCLE", "component");
      break;
    }
  }
  for (const component of components) {
    if (component.required && component.rollback === undefined) reader.add("ROLLBACK_INVALID", "component");
    if (component.rollback !== undefined) {
      const predecessor = componentById.get(component.rollback.predecessorRef);
      if (predecessor === undefined || predecessor.kind !== component.kind) reader.add("ROLLBACK_INVALID", "component");
    }
  }
};

const readDocument = (value: unknown, nowIso: string): { document: ExactTargetInventoryDocument | null; reader: Reader } => {
  const generatedAt = isRecord(value) && typeof value.generatedAt === "string" ? value.generatedAt : "";
  const reader = new Reader(nowIso, generatedAt);
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "inventoryId", "generatedAt", "classes"])) {
    reader.add("UNKNOWN_KEY", "artifact");
    return { document: null, reader };
  }
  if (value.schemaVersion !== EXACT_TARGET_INVENTORY_SCHEMA_VERSION || !boundedId(value.inventoryId) || typeof value.generatedAt !== "string" || parseInstant(value.generatedAt) === null || !Array.isArray(value.classes)) {
    reader.add(value.schemaVersion === EXACT_TARGET_INVENTORY_SCHEMA_VERSION ? "TYPE_MISMATCH" : "SCHEMA_MISMATCH", "artifact");
    return { document: null, reader };
  }
  if (depthOf(value) > EXACT_TARGET_INVENTORY_MAX_DEPTH) reader.add("LIMIT_EXCEEDED", "artifact");
  const classes = value.classes.map((item) => reader.classBundle(item)).filter((item): item is ExactTargetInventoryClassBundle => item !== null);
  const classNames = classes.map((item) => item.workloadClass);
  const expected = new Set(workloadClasses);
  if (classes.length !== workloadClasses.length
    || new Set(classNames).size !== workloadClasses.length
    || classNames.some((item) => !expected.has(item))) {
    reader.add("CLASS_CARDINALITY_INVALID", "artifact");
  }
  return {
    reader,
    document: {
      schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
      inventoryId: value.inventoryId,
      generatedAt: value.generatedAt,
      classes,
    },
  };
};

const classIssues = (
  workloadClass: ExactTargetInventoryWorkloadClass,
  disposition: ExactTargetInventoryClassBundle["disposition"],
  targets: readonly ExactTargetInventoryTarget[],
): ExactTargetInventoryIssueCode[] => {
  if (disposition === "RETIRE_ONLY") return ["RETIREMENT_BLOCKED"];
  if (disposition !== "SELECTABLE") return ["CLASS_BLOCKED"];
  if (targets.length !== 1) return ["TARGET_CARDINALITY_INVALID"];
  return [];
};

const publicClassProjection = (bundle: ExactTargetInventoryClassBundle): ExactTargetInventoryClassProjection => {
  const codes = classIssues(bundle.workloadClass, bundle.disposition, bundle.targets);
  return {
    workloadClass: bundle.workloadClass,
    disposition: bundle.disposition,
    targetCount: bundle.targets.length,
    eligibleTargetCount: codes.length === 0 ? 1 : 0,
    status: codes.length === 0 ? "ELIGIBLE" : "BLOCKED",
    issueCodes: codes,
  };
};

const selectionFor = (
  requested: RequestedWorkloadClass,
  classes: readonly ExactTargetInventoryClassProjection[],
  document: ExactTargetInventoryDocument | null,
  artifactIssueCodes: readonly ExactTargetInventoryIssueCode[],
): ExactTargetInventorySelectionProjection | undefined => {
  if (requested.status === "NONE") return undefined;
  if (requested.status === "INVALID") return { status: "INVALID", issueCodes: ["REQUESTED_CLASS_NOT_FOUND"] };
  const projection = classes.find((item) => item.workloadClass === requested.workloadClass);
  if (document === null) {
    return { workloadClass: requested.workloadClass, status: "INVALID", issueCodes: artifactIssueCodes };
  }
  if (projection === undefined) {
    return { workloadClass: requested.workloadClass, status: "INVALID", issueCodes: ["REQUESTED_CLASS_NOT_FOUND"] };
  }
  if (projection.status !== "ELIGIBLE") {
    return { workloadClass: requested.workloadClass, status: "BLOCKED", issueCodes: projection.issueCodes };
  }
  const target = document.classes.find((item) => item.workloadClass === requested.workloadClass)?.targets[0];
  return {
    workloadClass: requested.workloadClass,
    status: "SELECTED",
    opaqueTargetId: target === undefined ? undefined : digest(`${requested.workloadClass}:${target.targetId}`).slice(0, 32),
    issueCodes: [],
  };
};

const assertOutputBound = (result: ExactTargetInventoryEvaluationResult): ExactTargetInventoryEvaluationResult => {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes <= EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES) return result;
  return {
    ok: false,
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    artifactStatus: "INVALID",
    evaluatedAt: result.evaluatedAt,
    validUntil: null,
    canonicalDigest: null,
    issueCodes: ["LIMIT_EXCEEDED"],
    issues: [issue("LIMIT_EXCEEDED", "artifact")],
    classes: [],
    ...(result.selection === undefined ? {} : {
      selection: {
        ...(result.selection.workloadClass === undefined ? {} : { workloadClass: result.selection.workloadClass }),
        status: "INVALID",
        issueCodes: ["LIMIT_EXCEEDED"],
      } satisfies ExactTargetInventorySelectionProjection,
    }),
  };
};

export function evaluateExactTargetInventoryJson(
  inputText: unknown,
  options: ExactTargetInventoryEvaluationOptions,
): ExactTargetInventoryEvaluationResult {
  const normalized = normalizeOptions(options);
  if (!normalized.ok) return failInvalidOptions(normalized.evaluatedAt);
  const { evaluatedAt, requested } = normalized.options;
  if (typeof inputText !== "string") return fail("INPUT_NOT_STRING", "input", normalized.options);
  if (Buffer.byteLength(inputText, "utf8") > EXACT_TARGET_INVENTORY_MAX_BYTES) return fail("INPUT_TOO_LARGE", "input", normalized.options);
  if (detectDuplicateJsonKeys(inputText)) return fail("DUPLICATE_JSON_KEY", "input", normalized.options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText) as unknown;
  } catch {
    return fail("JSON_MALFORMED", "input", normalized.options);
  }
  const { document, reader } = readDocument(parsed, evaluatedAt);
  const artifactIssues = reader.issues;
  const artifactValid = document !== null && artifactIssues.length === 0;
  const classes = artifactValid ? document.classes.map(publicClassProjection) : [];
  const selection = selectionFor(requested, classes, artifactValid ? document : null, uniqueCodes(artifactIssues));
  const requestedIssues = requested.status === "INVALID" ? [issue("REQUESTED_CLASS_NOT_FOUND", "selection")] : [];
  const allIssues = [...artifactIssues, ...requestedIssues].slice(0, EXACT_TARGET_INVENTORY_MAX_ISSUES);
  const canonical = artifactValid ? canonicalJson(parsed) : null;
  const result: ExactTargetInventoryEvaluationResult = {
    ok: artifactValid && (requested.status === "NONE" || selection?.status === "SELECTED"),
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    artifactStatus: artifactValid ? "VALID" : "INVALID",
    evaluatedAt,
    validUntil: artifactValid ? reader.validUntil() : null,
    canonicalDigest: canonical === null ? null : `sha256:${digest(canonical)}`,
    issueCodes: uniqueCodes(allIssues),
    issues: allIssues,
    classes,
    ...(selection === undefined ? {} : { selection }),
  };
  return assertOutputBound(result);
}
