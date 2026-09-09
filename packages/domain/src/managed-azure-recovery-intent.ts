import { createHash } from "node:crypto";
import type { ManagedAzureRollbackPayload } from "./managed-azure-recovery-payload";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";

export const MANAGED_RELEASE_WRITE_INTENT_PROTOCOL_VERSION = 1;

export type ManagedReleaseRecoveryIntentRole = "web" | "worker";

export type ManagedReleaseRecoveryIntentBase = Readonly<{
  protocolVersion: 1;
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
  return `ri-${sha256Hex(canonicalManagedReleaseRecoveryIntentJson(base)).slice(0, 32)}`;
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
  if (payload.schemaVersion !== 2) rejectors.conflict();
  const raw = reader.exactRecord(value, INTENT_KEYS);
  const role = reader.enumString(raw.role, ["web", "worker"] as const);
  const appName = reader.azureAppName(raw.appName);
  const recovery = payload.compatibleRecovery[role];
  const base = Object.freeze({
    protocolVersion: reader.literal(raw.protocolVersion, MANAGED_RELEASE_WRITE_INTENT_PROTOCOL_VERSION),
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
  if (typeof raw.revisionSuffix !== "string" || !/^ri-[0-9a-f]{32}$/.test(raw.revisionSuffix)) rejectors.invalid();
  const revisionSuffix = raw.revisionSuffix;
  if (revisionSuffix !== managedReleaseRecoveryIntentRevisionSuffix(base)) rejectors.conflict();
  const templateDigest = reader.digest(raw.templateDigest);
  const digestInput = Object.freeze({ ...base, revisionSuffix, templateDigest });
  const intentDigest = reader.digest(raw.intentDigest);
  if (intentDigest !== managedReleaseRecoveryIntentDigest(digestInput)) rejectors.conflict();
  return Object.freeze({ ...digestInput, intentDigest });
}
