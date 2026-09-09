import { ManagedAzureContainerAppError } from "./managed-azure-container-app-transport.mjs";

const ROLES = ["web", "worker"];
function fail(code) { throw new ManagedAzureContainerAppError(code, true); }
function name(target, role) { return role === "web" ? target.webAppName : target.workerAppName; }

export async function snapshotManagedAzureExclusiveActivation(deps, target, baselines) {
  const configurationDigests = {};
  for (const role of ROLES) {
    const state = await deps.readExclusiveState({ target, role });
    if (state.mode !== "Single" || state.provisioningState !== "Succeeded"
      || state.latestRevisionName !== baselines[role].revisionName
      || state.latestReadyRevisionName !== baselines[role].revisionName
      || !state.revisions.some((revision) => revision.revisionName === baselines[role].revisionName && revision.active && revision.replicaCount > 0)
      || state.revisions.some((revision) => revision.revisionName !== baselines[role].revisionName && (revision.active || revision.replicaCount !== 0))) {
      fail("AZURE_EXCLUSIVE_BASELINE_NOT_QUIESCENT");
    }
    configurationDigests[role] = state.configurationDigest;
  }
  return Object.freeze({ originalMode: "Single", temporaryMode: "Multiple", configurationDigests: Object.freeze(configurationDigests) });
}

// The V3 rollback record is persisted under the lease before this context may
// change either app. Its configuration digests bind the otherwise app-scoped
// revision-mode writes to the same recovery owner as the immutable revisions.
export function createManagedAzureExclusiveActivation(deps, { target, ownership, knownRevisions, onProgress }) {
  if (ownership?.originalMode !== "Single" || ownership.temporaryMode !== "Multiple"
    || ROLES.some((role) => !/^sha256:[0-9a-f]{64}$/.test(ownership.configurationDigests?.[role]))) {
    fail("AZURE_EXCLUSIVE_OWNERSHIP_REQUIRED");
  }
  const known = Object.fromEntries(ROLES.map((role) => [role, new Set(knownRevisions[role])]));
  const allowed = { web: new Set(), worker: new Set() };
  let entered = false;
  const input = (role) => ({ target, role, exclusiveActivation: ownership });
  async function inspect(role, mode) {
    const state = await deps.readExclusiveState(input(role));
    if (mode && state.mode !== mode) fail("AZURE_EXCLUSIVE_MODE_DRIFT");
    if (state.configurationDigest !== ownership.configurationDigests[role]) fail("AZURE_EXCLUSIVE_CONFIGURATION_DRIFT");
    return state;
  }
  async function guard(mode = "Multiple") {
    for (const role of ROLES) {
      const state = await inspect(role, mode);
      if (state.revisions.some((revision) => !allowed[role].has(revision.revisionName) && (revision.active || revision.replicaCount !== 0))) {
        fail("AZURE_EXCLUSIVE_PREDECESSOR_ACTIVE");
      }
    }
  }
  async function enter(keep = {}) {
    for (const role of ROLES) {
      allowed[role] = new Set(keep[role] ? [keep[role]] : []);
      if ([...allowed[role]].some((revision) => !known[role].has(revision))) fail("AZURE_EXCLUSIVE_REVISION_UNOWNED");
      const before = await inspect(role);
      if (before.revisions.some((revision) => (revision.active || revision.replicaCount > 0) && !known[role].has(revision.revisionName))) {
        fail("AZURE_EXCLUSIVE_REVISION_UNOWNED");
      }
      await onProgress();
      await deps.setRevisionMode({ ...input(role), mode: "Multiple", onProgress });
    }
    for (const role of ["worker", "web"]) {
      const state = await inspect(role, "Multiple");
      for (const revision of state.revisions) {
        if (allowed[role].has(revision.revisionName) || (!revision.active && revision.replicaCount === 0)) continue;
        if (!known[role].has(revision.revisionName)) fail("AZURE_EXCLUSIVE_REVISION_UNOWNED");
        const result = await deps.setRevisionActive({ target, role, revisionName: revision.revisionName, active: false, onProgress });
        if (!result.terminal || !result.succeeded || result.replicaCount !== 0) fail("AZURE_EXCLUSIVE_DRAIN_AMBIGUOUS");
      }
    }
    entered = true;
    await guard();
  }
  async function finish(selected) {
    for (const role of ROLES) {
      if (!known[role].has(selected[role])) fail("AZURE_EXCLUSIVE_REVISION_UNOWNED");
      allowed[role] = new Set([selected[role]]);
      const state = await inspect(role);
      if (state.latestRevisionName !== selected[role] || state.latestReadyRevisionName !== selected[role]
        || !state.revisions.some((revision) => revision.revisionName === selected[role] && revision.active && revision.replicaCount > 0)
        || state.revisions.some((revision) => revision.revisionName !== selected[role] && (revision.active || revision.replicaCount !== 0))) {
        fail("AZURE_EXCLUSIVE_RESTORE_UNPROVEN");
      }
    }
    for (const role of ROLES) {
      await onProgress();
      await deps.setRevisionMode({ ...input(role), mode: "Single", onProgress });
    }
    await guard("Single");
    entered = false;
    return { mode: "Single", configurationDigests: ownership.configurationDigests, revisions: { ...selected }, predecessorsStopped: true };
  }
  const wrapped = { ...deps };
  for (const method of ["readApp", "readAppTemplate", "waitForState"]) {
    wrapped[method] = (args) => deps[method]({ ...args, exclusiveActivation: ownership });
  }
  wrapped.patchTemplate = async (args) => {
    if (!entered) fail("AZURE_EXCLUSIVE_INTERVAL_REQUIRED");
    await guard();
    const revision = `${name(target, args.role)}--${args.template.revisionSuffix}`;
    // A role's previous revision must already be drained before any successor
    // can start. This covers both migration startup and worker queue consumers.
    if (allowed[args.role].size) fail("AZURE_EXCLUSIVE_ROLE_NOT_DRAINED");
    known[args.role].add(revision);
    allowed[args.role].add(revision);
    const result = await deps.patchTemplate(args);
    await guard();
    return result;
  };
  return Object.freeze({ deps: wrapped, enter, finish, guard });
}
