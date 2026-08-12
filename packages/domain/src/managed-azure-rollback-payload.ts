import { AppError } from "./errors";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";

export type ManagedAzureRollbackPayloadV1 = {
  readonly schemaVersion: 1;
  readonly target: {
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly acrName: string;
    readonly acrServer: string;
    readonly webAppName: string;
    readonly workerAppName: string;
  };
  readonly previous: {
    readonly releaseVersion: string | null;
    readonly web: { readonly containerName: string; readonly image: string; readonly readyRevision: string };
    readonly worker: { readonly containerName: string; readonly image: string; readonly readyRevision: string };
  };
  readonly incoming: {
    readonly webDigest: string;
    readonly workerDigest: string;
  };
};

export function canonicalizeManagedAzureRollbackPayloadV1(
  value: unknown,
): Readonly<ManagedAzureRollbackPayloadV1> {
  const invalid = (): never => {
    throw new AppError(400, "MANAGED_RELEASE_INVALID_INPUT", "Managed release rollback payload is invalid.");
  };
  const reader = createManagedReleaseProofReader(invalid);
  const rawRoot = reader.exactRecord(value, ["schemaVersion", "target", "previous", "incoming"] as const);
  const rawTarget = reader.exactRecord(rawRoot.target, ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
  const rawPrevious = reader.exactRecord(rawRoot.previous, ["releaseVersion", "web", "worker"] as const);
  const rawWeb = reader.exactRecord(rawPrevious.web, ["containerName", "image", "readyRevision"] as const);
  const rawWorker = reader.exactRecord(rawPrevious.worker, ["containerName", "image", "readyRevision"] as const);
  const rawIncoming = reader.exactRecord(rawRoot.incoming, ["webDigest", "workerDigest"] as const);

  const acrName = reader.azureAcrName(rawTarget.acrName);
  const acrServer = reader.azureAcrServer(rawTarget.acrServer, acrName);
  const webAppName = reader.azureAppName(rawTarget.webAppName);
  const workerAppName = reader.azureAppName(rawTarget.workerAppName);
  if (webAppName === workerAppName) invalid();
  const webImage = reader.azureImage(rawWeb.image, "web");
  const workerImage = reader.azureImage(rawWorker.image, "worker");
  if (webImage.acrName !== acrName || webImage.acrServer !== acrServer
    || workerImage.acrName !== acrName || workerImage.acrServer !== acrServer) invalid();

  const web = reader.exactRecord({
    containerName: reader.azureContainerName(rawWeb.containerName),
    image: webImage.image,
    readyRevision: reader.azureRevision(rawWeb.readyRevision, webAppName),
  }, ["containerName", "image", "readyRevision"] as const);
  const worker = reader.exactRecord({
    containerName: reader.azureContainerName(rawWorker.containerName),
    image: workerImage.image,
    readyRevision: reader.azureRevision(rawWorker.readyRevision, workerAppName),
  }, ["containerName", "image", "readyRevision"] as const);
  const target = reader.exactRecord({
    subscriptionId: reader.uuid(rawTarget.subscriptionId),
    resourceGroup: reader.azureResourceGroup(rawTarget.resourceGroup),
    acrName,
    acrServer,
    webAppName,
    workerAppName,
  }, ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
  const previous = reader.exactRecord({
    releaseVersion: rawPrevious.releaseVersion === null
      ? reader.literal(rawPrevious.releaseVersion, null)
      : reader.version(rawPrevious.releaseVersion),
    web,
    worker,
  }, ["releaseVersion", "web", "worker"] as const);
  const incoming = reader.exactRecord({
    webDigest: reader.digest(rawIncoming.webDigest),
    workerDigest: reader.digest(rawIncoming.workerDigest),
  }, ["webDigest", "workerDigest"] as const);
  const canonical = reader.deepFreeze(reader.exactRecord({
    schemaVersion: reader.literal(rawRoot.schemaVersion, 1),
    target,
    previous,
    incoming,
  }, ["schemaVersion", "target", "previous", "incoming"] as const));
  reader.canonicalJsonBytes(canonical);
  return canonical as Readonly<ManagedAzureRollbackPayloadV1>;
}
