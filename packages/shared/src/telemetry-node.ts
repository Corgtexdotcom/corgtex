import * as telemetry from "./telemetry";
import { resolveNodeReleaseMetadata } from "./release-metadata-node";

export type { CaptureTelemetryResult, ErrorTelemetryInput, TelemetryEventInput } from "./telemetry";
export { sanitizeProperties } from "./telemetry";

export function telemetryRuntimeContext(env: NodeJS.ProcessEnv = process.env) {
  return telemetry.telemetryRuntimeContext(env, resolveNodeReleaseMetadata("web", env, {}));
}

export function buildErrorTelemetryEvent(input: telemetry.ErrorTelemetryInput, env: NodeJS.ProcessEnv = process.env) {
  return telemetry.buildErrorTelemetryEvent(input, env, resolveNodeReleaseMetadata(input.surface === "worker" ? "worker" : "web", env, {}));
}

export function captureTelemetryEvent(input: telemetry.TelemetryEventInput, env: NodeJS.ProcessEnv = process.env) {
  return telemetry.captureTelemetryEvent(input, env, resolveNodeReleaseMetadata("web", env, {}));
}

export function captureErrorTelemetry(input: telemetry.ErrorTelemetryInput, env: NodeJS.ProcessEnv = process.env) {
  return telemetry.captureErrorTelemetry(input, env, resolveNodeReleaseMetadata(input.surface === "worker" ? "worker" : "web", env, {}));
}
