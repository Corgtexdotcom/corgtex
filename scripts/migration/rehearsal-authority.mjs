#!/usr/bin/env node
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RESOURCE, HOST, ProbeError } from "./probe-ops-azure-target.mjs";

export const REHEARSAL_GROUP_ID = RESOURCE.split("/providers/")[0];
export const REHEARSAL_TAGS = Object.freeze({ authority: "non-authoritative-restore-target",
  purpose: "railway-to-azure-migration-foundation", managedBy: "github-oidc" });
const subscription = RESOURCE.split("/")[2];
const group = REHEARSAL_GROUP_ID.split("/").at(-1);
const server = RESOURCE.split("/").at(-1);
const need = (value, code) => { if (!value) throw new ProbeError(code); };
export function validateRehearsalAuthority(resource, expectedId) {
  need(typeof resource?.id === "string" && resource.id.toLowerCase() === expectedId.toLowerCase(), "REHEARSAL_AUTHORITY_ID_MISMATCH");
  need(resource.tags && Object.keys(resource.tags).sort().join() === Object.keys(REHEARSAL_TAGS).sort().join()
    && Object.entries(REHEARSAL_TAGS).every(([key, value]) => resource.tags[key] === value), "REHEARSAL_AUTHORITY_TRANSFERRED");
}

// Never cache these observations. This is a fail-closed admission check, not an
// atomic ARM/SQL fence: drain old runs and effects before transferring authority.
export function createRehearsalAuthorityGuard({ read, execute = execFile, deadline = null, environment = process.env } = {}) {
  const readCurrent = read ?? (async (args, remaining) => new Promise((resolve, reject) => {
    const env = { AZURE_CORE_COLLECT_TELEMETRY: "no" };
    for (const key of ["PATH", "HOME", "AZURE_CONFIG_DIR", "TMPDIR", "LANG", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
      if (environment[key]) env[key] = environment[key];
    }
    execute("az", [...args, "--subscription", subscription, "--output", "json", "--only-show-errors"],
      { timeout: Math.min(30000, remaining), maxBuffer: 1024 * 1024, env }, (error, stdout) => {
        if (error) return reject(new ProbeError("REHEARSAL_AUTHORITY_UNAVAILABLE"));
        try { resolve(JSON.parse(stdout)); } catch { reject(new ProbeError("REHEARSAL_AUTHORITY_UNAVAILABLE")); }
      });
  }));
  return async () => {
    need(deadline === null || Number.isSafeInteger(deadline), "REHEARSAL_AUTHORITY_DEADLINE");
    const until = Math.min(deadline ?? Infinity, Date.now() + 60000);
    const remaining = () => { const ms = until - Date.now(); need(ms > 0, "REHEARSAL_AUTHORITY_DEADLINE"); return ms; };
    validateRehearsalAuthority(await readCurrent(["group", "show", "--name", group], remaining()), REHEARSAL_GROUP_ID);
    validateRehearsalAuthority(await readCurrent(["postgres", "flexible-server", "show", "--resource-group", group, "--name", server], remaining()), RESOURCE);
    remaining();
  };
}

// Local rehearsal fixtures and production copy custody retain their own guards.
// Only the fixed historical Azure rehearsal host receives this extra authority check.
export function rehearsalAuthorityForTarget(target, { productionMode = false, ...options } = {}) {
  return !productionMode && target?.host === HOST ? createRehearsalAuthorityGuard(options) : async () => {};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRehearsalAuthorityGuard()().catch(error => {
    console.error(error instanceof ProbeError ? error.code : "REHEARSAL_AUTHORITY_UNAVAILABLE"); process.exitCode = 1;
  });
}
