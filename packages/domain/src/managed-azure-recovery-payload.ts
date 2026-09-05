import { AppError } from "./errors";
import { isProxy } from "node:util/types";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";
import { canonicalizeManagedAzureRollbackPayloadV1, type ManagedAzureRollbackPayloadV1 } from "./managed-azure-rollback-payload";

export type ManagedAzureRollbackPayloadV2 = Omit<ManagedAzureRollbackPayloadV1, "schemaVersion" | "incoming"> & {
  readonly schemaVersion: 2;
  readonly incoming: ManagedAzureRollbackPayloadV1["incoming"] & { readonly schemaApprovalDigest: string };
  readonly compatibleRecovery: {
    readonly gitSha: string; readonly imageTag: string; readonly releaseVersion: string;
    readonly web: { readonly image: string; readonly digest: string };
    readonly worker: { readonly image: string; readonly digest: string };
    readonly schemaCompatibilityApprovalDigest: string;
    readonly acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1";
    readonly activationPolicy: "STANDARD" | "EXCLUSIVE";
  };
};
export type ManagedAzureRollbackPayload = ManagedAzureRollbackPayloadV1 | ManagedAzureRollbackPayloadV2;
const invalid = (): never => { throw new AppError(400, "MANAGED_RELEASE_INVALID_INPUT", "Managed release rollback payload is invalid."); };

export function canonicalizeManagedAzureRollbackPayload(value: unknown): Readonly<ManagedAzureRollbackPayload> {
  let version: unknown;
  try {
    if (!value || typeof value !== "object" || isProxy(value)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
    if (!descriptor) throw new AppError(400, "MANAGED_RELEASE_INVALID_INPUT", "Managed release rollback payload is invalid.");
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
    version = descriptor.value;
  } catch { invalid(); }
  if (version === 1) return canonicalizeManagedAzureRollbackPayloadV1(value);
  const reader = createManagedReleaseProofReader(invalid);
  const root = reader.exactRecord(value, ["schemaVersion", "target", "previous", "incoming", "compatibleRecovery"] as const);
  reader.literal(root.schemaVersion, 2);
  const rawIncoming = reader.exactRecord(root.incoming, ["webDigest", "workerDigest", "schemaApprovalDigest"] as const);
  const base = canonicalizeManagedAzureRollbackPayloadV1({ schemaVersion: 1, target: root.target, previous: root.previous,
    incoming: { webDigest: rawIncoming.webDigest, workerDigest: rawIncoming.workerDigest } });
  const raw = reader.exactRecord(root.compatibleRecovery, ["gitSha", "imageTag", "releaseVersion", "web", "worker", "schemaCompatibilityApprovalDigest", "acceptancePolicy", "activationPolicy"] as const);
  const webRaw = reader.exactRecord(raw.web, ["image", "digest"] as const); const workerRaw = reader.exactRecord(raw.worker, ["image", "digest"] as const);
  const gitSha = reader.gitSha(raw.gitSha); const webImage = reader.azureImage(webRaw.image, "web"); const workerImage = reader.azureImage(workerRaw.image, "worker");
  if (webImage.acrName !== base.target.acrName || workerImage.acrName !== base.target.acrName
    || webImage.digest !== reader.digest(webRaw.digest) || workerImage.digest !== reader.digest(workerRaw.digest)) invalid();
  const compatibleRecovery = reader.exactRecord({ gitSha, imageTag: reader.imageTag(raw.imageTag, gitSha), releaseVersion: reader.version(raw.releaseVersion),
    web: reader.exactRecord({ image: webImage.image, digest: webImage.digest }, ["image", "digest"] as const),
    worker: reader.exactRecord({ image: workerImage.image, digest: workerImage.digest }, ["image", "digest"] as const),
    schemaCompatibilityApprovalDigest: reader.digest(raw.schemaCompatibilityApprovalDigest), acceptancePolicy: reader.literal(raw.acceptancePolicy, "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1"),
    activationPolicy: reader.enumString(raw.activationPolicy, ["STANDARD", "EXCLUSIVE"] as const),
  }, ["gitSha", "imageTag", "releaseVersion", "web", "worker", "schemaCompatibilityApprovalDigest", "acceptancePolicy", "activationPolicy"] as const);
  reader.deepFreeze(compatibleRecovery);
  reader.canonicalJsonBytes(compatibleRecovery);
  const incoming = reader.deepFreeze(reader.exactRecord({ ...base.incoming, schemaApprovalDigest: reader.digest(rawIncoming.schemaApprovalDigest) },
    ["webDigest", "workerDigest", "schemaApprovalDigest"] as const));
  const canonical = Object.freeze({ schemaVersion: 2 as const, target: base.target, previous: base.previous, incoming, compatibleRecovery });
  return canonical as Readonly<ManagedAzureRollbackPayloadV2>;
}
