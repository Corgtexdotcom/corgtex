import { readReleaseBuildIdentity } from "./release-build-node.mjs";
import type { ReleaseBuildRole } from "./release-build.mjs";
import { resolveReleaseMetadata } from "./release-metadata";

export { readReleaseBuildIdentity } from "./release-build-node.mjs";

export function resolveNodeReleaseMetadata(
  role: ReleaseBuildRole,
  env: NodeJS.ProcessEnv = process.env,
  options: { service?: string } = { service: role },
) {
  return resolveReleaseMetadata(env, { ...options, expectedRole: role, bakedIdentity: readReleaseBuildIdentity(role) });
}
