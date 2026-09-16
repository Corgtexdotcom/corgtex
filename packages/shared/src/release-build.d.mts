export type ReleaseBuildRole = "web" | "worker";
export type ReleaseBuildIdentity = { schemaVersion: 1; role: ReleaseBuildRole; gitSha: string };
export function parseReleaseBuildIdentity(value: unknown, role: string | undefined): ReleaseBuildIdentity | null;
