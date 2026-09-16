// Pure validation shared by Node startup and browser/Edge-safe metadata resolution.
export function parseReleaseBuildIdentity(value, role) {
  if (role !== "web" && role !== "worker") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "gitSha,role,schemaVersion") return null;
  if (value.schemaVersion !== 1 || value.role !== role || typeof value.gitSha !== "string"
    || !/^[a-f0-9]{40}$/.test(value.gitSha)) return null;
  return { schemaVersion: 1, role, gitSha: value.gitSha };
}
