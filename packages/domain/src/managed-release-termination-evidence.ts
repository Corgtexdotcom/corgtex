import { AppError } from "./errors";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";

export type ManagedReleaseTerminationEvidenceV1 = {
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly priorLeaseId: string;
  readonly priorFence: number;
  readonly execution: {
    readonly runId: string;
    readonly attempt: number;
    readonly outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
    readonly terminalAtUnixMs: number;
  };
  readonly workflow: {
    readonly runId: string;
    readonly attempt: number;
    readonly outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
    readonly terminalAtUnixMs: number;
  };
  readonly providerRoles: {
    readonly web: {
      readonly command:
        | { readonly outcome: "EXITED"; readonly exitCode: number; readonly signal: null; readonly terminalAtUnixMs: number }
        | { readonly outcome: "SIGNALED"; readonly exitCode: null; readonly signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL"; readonly terminalAtUnixMs: number };
      readonly provider: {
        readonly appName: string;
        readonly provisioningState: "SUCCEEDED" | "FAILED" | "CANCELED";
        readonly observedAtUnixMs: number;
        readonly image: string;
        readonly revision: string;
      };
    };
    readonly worker: {
      readonly command:
        | { readonly outcome: "EXITED"; readonly exitCode: number; readonly signal: null; readonly terminalAtUnixMs: number }
        | { readonly outcome: "SIGNALED"; readonly exitCode: null; readonly signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL"; readonly terminalAtUnixMs: number };
      readonly provider: {
        readonly appName: string;
        readonly provisioningState: "SUCCEEDED" | "FAILED" | "CANCELED";
        readonly observedAtUnixMs: number;
        readonly image: string;
        readonly revision: string;
      };
    };
  };
};

export function canonicalizeManagedReleaseTerminationEvidenceV1(
  value: unknown,
): Readonly<ManagedReleaseTerminationEvidenceV1> {
  const invalid = (): never => {
    throw new AppError(400, "MANAGED_RELEASE_INVALID_INPUT", "Managed release termination evidence is invalid.");
  };
  const reader = createManagedReleaseProofReader(invalid);
  const rawRoot = reader.exactRecord(value, ["schemaVersion", "deploymentId", "priorLeaseId", "priorFence", "execution", "workflow", "providerRoles"] as const);
  const rawRoles = reader.exactRecord(rawRoot.providerRoles, ["web", "worker"] as const);
  const run = (rawValue: unknown) => {
    const raw = reader.exactRecord(rawValue, ["runId", "attempt", "outcome", "terminalAtUnixMs"] as const);
    const terminalAtUnixMs = reader.integer(raw.terminalAtUnixMs, 1, Number.MAX_SAFE_INTEGER);
    const parsed = reader.exactRecord({
      runId: reader.machineId(raw.runId),
      attempt: reader.integer(raw.attempt, 1, 2_147_483_647),
      outcome: reader.enumString(raw.outcome, ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] as const),
      terminalAtUnixMs,
    }, ["runId", "attempt", "outcome", "terminalAtUnixMs"] as const);
    return { parsed, terminalAtUnixMs };
  };
  const command = (rawValue: unknown) => {
    const raw = reader.exactRecord(rawValue, ["outcome", "exitCode", "signal", "terminalAtUnixMs"] as const);
    const outcome = reader.enumString(raw.outcome, ["EXITED", "SIGNALED"] as const);
    const terminalAtUnixMs = reader.integer(raw.terminalAtUnixMs, 1, Number.MAX_SAFE_INTEGER);
    const parsed = reader.exactRecord({
      outcome,
      exitCode: outcome === "EXITED" ? reader.integer(raw.exitCode, 0, 255) : reader.literal(raw.exitCode, null),
      signal: outcome === "EXITED"
        ? reader.literal(raw.signal, null)
        : reader.enumString(raw.signal, ["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL"] as const),
      terminalAtUnixMs,
    }, ["outcome", "exitCode", "signal", "terminalAtUnixMs"] as const);
    return { parsed, terminalAtUnixMs };
  };
  const role = (rawValue: unknown, expected: "web" | "worker") => {
    const raw = reader.exactRecord(rawValue, ["command", "provider"] as const);
    const rawProvider = reader.exactRecord(raw.provider, ["appName", "provisioningState", "observedAtUnixMs", "image", "revision"] as const);
    const appName = reader.azureAppName(rawProvider.appName);
    const image = reader.azureImage(rawProvider.image, expected);
    const observedAtUnixMs = reader.integer(rawProvider.observedAtUnixMs, 1, Number.MAX_SAFE_INTEGER);
    const provider = reader.exactRecord({
      appName,
      provisioningState: reader.enumString(rawProvider.provisioningState, ["SUCCEEDED", "FAILED", "CANCELED"] as const),
      observedAtUnixMs,
      image: image.image,
      revision: reader.azureRevision(rawProvider.revision, appName),
    }, ["appName", "provisioningState", "observedAtUnixMs", "image", "revision"] as const);
    const parsedCommand = command(raw.command);
    const parsed = reader.exactRecord({ command: parsedCommand.parsed, provider }, ["command", "provider"] as const);
    return { parsed, image, appName, terminalAtUnixMs: parsedCommand.terminalAtUnixMs, observedAtUnixMs };
  };

  const execution = run(rawRoot.execution);
  const workflow = run(rawRoot.workflow);
  const web = role(rawRoles.web, "web");
  const worker = role(rawRoles.worker, "worker");
  const barrier = Math.max(execution.terminalAtUnixMs, workflow.terminalAtUnixMs, web.terminalAtUnixMs, worker.terminalAtUnixMs);
  if (web.appName === worker.appName || web.image.acrName !== worker.image.acrName
    || web.image.acrServer !== worker.image.acrServer
    || web.observedAtUnixMs <= barrier || worker.observedAtUnixMs <= barrier) invalid();
  const providerRoles = reader.exactRecord({ web: web.parsed, worker: worker.parsed }, ["web", "worker"] as const);
  const canonical = reader.deepFreeze(reader.exactRecord({
    schemaVersion: reader.literal(rawRoot.schemaVersion, 1),
    deploymentId: reader.uuid(rawRoot.deploymentId),
    priorLeaseId: reader.uuid(rawRoot.priorLeaseId),
    priorFence: reader.integer(rawRoot.priorFence, 1, 2_147_483_647),
    execution: execution.parsed,
    workflow: workflow.parsed,
    providerRoles,
  }, ["schemaVersion", "deploymentId", "priorLeaseId", "priorFence", "execution", "workflow", "providerRoles"] as const));
  if (reader.canonicalJsonBytes(canonical).byteLength > 4_096) invalid();
  return canonical as Readonly<ManagedReleaseTerminationEvidenceV1>;
}
