import { readFileSync } from "node:fs";
import { parseReleaseBuildIdentity } from "./release-build.mjs";

// Never synthesize immutable identity from runtime environment variables.
export function readReleaseBuildIdentity(role) {
  try {
    return parseReleaseBuildIdentity(JSON.parse(readFileSync("/app/release-build.json", "utf8")), role);
  } catch {
    return null;
  }
}
