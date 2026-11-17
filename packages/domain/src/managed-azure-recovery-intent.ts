import { createHash } from "node:crypto";
import type { ManagedAzureRollbackPayload } from "./managed-azure-recovery-payload";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";

// Runner capability is distinct from immutable revision intent format.
export const MANAGED_RELEASE_RUNNER_PROTOCOL_VERSION = 3;

export type ManagedReleaseRecoveryIntentRole = "web" | "worker";

export type ManagedReleaseRecoveryIntentBase = Readonly<{
  protocolVersion: 1 | 2;
  purpose: "COMPATIBLE_RECOVERY_PATCH";
  role: ManagedReleaseRecoveryIntentRole;
  originatingLeaseId: string;
  originatingFence: number;
  appName: string;
  predecessorRevisionName: string;
  predecessorTemplateDigest: string;
  gitSha: string;
  imageDigest: string;
  templateBaseDigest: string;
}>;

export type ManagedReleaseRecoveryIntent = ManagedReleaseRecoveryIntentBase & Readonly<{
  revisionSuffix: string;
  templateDigest: string;
  intentDigest: string;
}>;

export type ManagedReleaseRecoveryIntentAuthority = Readonly<{
  leaseId: string;
  fence: number;
  payload: Readonly<ManagedAzureRollbackPayload>;
}>;

type IntentRejectors = Readonly<{
  invalid: () => never;
  conflict: () => never;
}>;

const INTENT_KEYS = [
  "protocolVersion",
  "purpose",
  "role",
  "originatingLeaseId",
  "originatingFence",
  "appName",
  "predecessorRevisionName",
  "predecessorTemplateDigest",
  "gitSha",
  "imageDigest",
  "templateBaseDigest",
  "revisionSuffix",
  "templateDigest",
  "intentDigest",
] as const;

function defaultReject(code: string): never {
  throw new Error(code);
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalManagedReleaseRecoveryIntentJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalManagedReleaseRecoveryIntentJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalManagedReleaseRecoveryIntentJson(object[key])}`).join(",")}}`;
}

export function managedReleaseRecoveryIntentRevisionSuffix(base: ManagedReleaseRecoveryIntentBase) {
  const length = base.protocolVersion === 1 ? 32 : Math.min(32, 54 - base.appName.length - 5);
  return `ri-${sha256Hex(canonicalManagedReleaseRecoveryIntentJson(base)).slice(0, length)}`;
}

export function managedReleaseRecoveryIntentDigest(intent: Omit<ManagedReleaseRecoveryIntent, "intentDigest">) {
  return `sha256:${sha256Hex(canonicalManagedReleaseRecoveryIntentJson(intent))}`;
}

export function canonicalizeManagedReleaseRecoveryIntent(
  value: unknown,
  authority: ManagedReleaseRecoveryIntentAuthority,
  rejectors: IntentRejectors = {
    invalid: () => defaultReject("MANAGED_RELEASE_INVALID_RECOVERY_INTENT"),
    conflict: () => defaultReject("MANAGED_RELEASE_RECOVERY_INTENT_CONFLICT"),
  },
): ManagedReleaseRecoveryIntent {
  const reader = createManagedReleaseProofReader(rejectors.invalid);
  const payload = authority.payload;
  if (payload.schemaVersion === 1) rejectors.conflict();
  const raw = reader.exactRecord(value, INTENT_KEYS);
  const role = reader.enumString(raw.role, ["web", "worker"] as const);
  const appName = reader.azureAppName(raw.appName);
  const recovery = payload.compatibleRecovery[role];
  const base = Object.freeze({
    protocolVersion: reader.integer(raw.protocolVersion, 1, 2) as 1 | 2,
    purpose: reader.literal(raw.purpose, "COMPATIBLE_RECOVERY_PATCH"),
    role,
    originatingLeaseId: reader.uuid(raw.originatingLeaseId),
    originatingFence: reader.integer(raw.originatingFence, 1, authority.fence),
    appName,
    predecessorRevisionName: reader.azureRevision(raw.predecessorRevisionName, appName),
    predecessorTemplateDigest: reader.digest(raw.predecessorTemplateDigest),
    gitSha: reader.gitSha(raw.gitSha),
    imageDigest: reader.digest(raw.imageDigest),
    templateBaseDigest: reader.digest(raw.templateBaseDigest),
  }) satisfies ManagedReleaseRecoveryIntentBase;
  if (base.originatingLeaseId !== authority.leaseId
    || base.originatingFence !== authority.fence
    || base.appName !== payload.target[role === "web" ? "webAppName" : "workerAppName"]
    || base.gitSha !== payload.compatibleRecovery.gitSha
    || base.imageDigest !== recovery.digest) {
    rejectors.conflict();
  }
  if (typeof raw.revisionSuffix !== "string" || !/^ri-[0-9a-f]+$/.test(raw.revisionSuffix)) rejectors.invalid();
  const revisionSuffix = raw.revisionSuffix;
  if (revisionSuffix !== managedReleaseRecoveryIntentRevisionSuffix(base)) rejectors.conflict();
  if (base.protocolVersion === 2 && `${appName}--${revisionSuffix}`.length > 54) rejectors.invalid();
  const templateDigest = reader.digest(raw.templateDigest);
  const digestInput = Object.freeze({ ...base, revisionSuffix, templateDigest });
  const intentDigest = reader.digest(raw.intentDigest);
  if (intentDigest !== managedReleaseRecoveryIntentDigest(digestInput)) rejectors.conflict();
  return Object.freeze({ ...digestInput, intentDigest });
}


/** The protected controller attests its complete ARM census. The server binds
 * that attestation to the current lease and immutable predecessor; it does not
 * infer provider absence from an HTTP failure or issue provider requests. */
export function canonicalizeInvalidRecoveryIntentSupersession(
  old: ManagedReleaseRecoveryIntent,
  replacement: ManagedReleaseRecoveryIntent,
  evidence: unknown,
  authority: ManagedReleaseRecoveryIntentAuthority & { currentLeaseId: string; currentFence: number; now: number },
) {
  const invalid = () => defaultReject("MANAGED_RELEASE_RECOVERY_SUPERSESSION_INVALID");
  const reader = createManagedReleaseProofReader(invalid);
  if (old.protocolVersion !== 1 || `${old.appName}--${old.revisionSuffix}`.length <= 54
    || replacement.protocolVersion !== 2 || authority.payload.schemaVersion !== 3) invalid();
  for (const key of ["purpose", "role", "originatingLeaseId", "originatingFence", "appName", "predecessorRevisionName",
    "predecessorTemplateDigest", "gitSha", "imageDigest", "templateBaseDigest"] as const) {
    if (old[key] !== replacement[key]) invalid();
  }
  const raw = reader.exactRecord(evidence, ["schemaVersion", "startedAt", "observedAt", "leaseId", "fence", "targetDigest",
    "oldIntentDigest", "role", "appName", "latestRevisionName", "latestReadyRevisionName", "templateDigest",
    "configurationDigest", "provisioningState", "revisions"] as const);
  reader.literal(raw.schemaVersion, 1);
  const startedAt = reader.integer(raw.startedAt, 0, Number.MAX_SAFE_INTEGER);
  const observedAt = reader.integer(raw.observedAt, 0, Number.MAX_SAFE_INTEGER);
  if (startedAt > observedAt || observedAt - startedAt > 180_000 || observedAt > authority.now + 5_000
    || authority.now - observedAt > 60_000) invalid();
  if (raw.leaseId !== authority.currentLeaseId || raw.fence !== authority.currentFence
    || raw.targetDigest !== `sha256:${sha256Hex(canonicalManagedReleaseRecoveryIntentJson(authority.payload.target))}`
    || raw.oldIntentDigest !== old.intentDigest || raw.role !== old.role || raw.appName !== old.appName
    || raw.latestRevisionName !== old.predecessorRevisionName || raw.latestReadyRevisionName !== old.predecessorRevisionName
    || raw.templateDigest !== old.predecessorTemplateDigest || raw.provisioningState !== "Succeeded") invalid();
  if (authority.payload.schemaVersion !== 3
    || raw.configurationDigest !== authority.payload.exclusiveActivation.configurationDigests[old.role]) invalid();
  if (!Array.isArray(raw.revisions) || raw.revisions.length < 1 || raw.revisions.length > 256) invalid();
  const names = new Set<string>();
  const revisions = (raw.revisions as unknown[]).map(value => {
    const row = reader.exactRecord(value, ["revisionName", "active", "replicaCount"] as const);
    const revisionName = reader.azureRevision(row.revisionName, old.appName);
    if (names.has(revisionName) || revisionName === `${old.appName}--${old.revisionSuffix}`
      || revisionName === `${replacement.appName}--${replacement.revisionSuffix}` || typeof row.active !== "boolean") invalid();
    names.add(revisionName);
    const replicaCount = reader.integer(row.replicaCount, 0, 256);
    if (revisionName !== old.predecessorRevisionName && (row.active || replicaCount !== 0)) invalid();
    return Object.freeze({ revisionName, active: row.active as boolean, replicaCount });
  });
  if (!names.has(old.predecessorRevisionName)) invalid();
  return Object.freeze({ ...raw, startedAt, observedAt, revisions: Object.freeze(revisions) });
}
