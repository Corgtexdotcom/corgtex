import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseBuild(role, env = process.env) {
  if (!["web", "worker"].includes(role)) throw new Error("Invalid release build role.");
  const gitSha = env.CORGTEX_RELEASE_GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GITHUB_SHA || null;
  if (gitSha !== null && !/^[a-f0-9]{40}$/.test(gitSha)) throw new Error("Invalid release build SHA.");
  return { schemaVersion: 1, role, gitSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync("/app/release-build.json", JSON.stringify(releaseBuild(process.argv[2])) + "\n");
}
