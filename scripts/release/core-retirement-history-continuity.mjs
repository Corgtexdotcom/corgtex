import { identityHash } from "../accepted-core-baseline.mjs";
import { need } from "./core-retirement.mjs";

const same = (left, right) => identityHash(left) === identityHash(right);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const QUERY = "query RetirementHistorySupplement($id:String!) { deployment(id:$id) { id projectId environmentId serviceId status meta } }";
const requireHistory = value => need(value, "HISTORY_EVIDENCE_CHANGED");
const index = rows => {
  requireHistory(Array.isArray(rows) && rows.every(row => row && typeof row.id === "string" && UUID.test(row.id)));
  const result = new Map(rows.map(row => [row.id, row]));
  requireHistory(result.size === rows.length); return result;
};

/** Retain exact first-page evidence when a new deployment displaces its oldest row.
 * The complete fence establishes lifecycle continuity; exact-ID reads supplement
 * only the missing image metadata and never replace either provider projection.
 */
export async function verifyRetirementHistoryContinuity({ role, previous, current, previousIds, target, query, onSupplement = async () => {} }) {
  requireHistory(["worker", "web"].includes(role));
  const serviceId = target?.[`${role}ServiceId`];
  const boundTarget = { projectId: target?.projectId, environmentId: target?.environmentId, serviceId };
  requireHistory(Object.values(boundTarget).every(value => typeof value === "string" && UUID.test(value)));
  const bound = row => row && Object.entries(boundTarget).every(([key, value]) => row[key] === value);
  const priorStage = previous?.stages?.[role], currentStage = current?.stages?.[role];
  requireHistory(Array.isArray(priorStage?.history) && priorStage.history.length <= 100
    && Array.isArray(currentStage?.history) && currentStage.history.length <= 100);
  const priorHistory = index(priorStage.history), currentHistory = index(currentStage.history);
  requireHistory(Array.isArray(previousIds) && new Set(previousIds).size === previousIds.length
    && Array.isArray(priorStage.activeDeployments)
    && same([...previousIds].sort(), priorStage.activeDeployments.map(row => row.id).sort())
    && previousIds.every(id => priorHistory.has(id)));
  const predecessors = new Set(previousIds);
  const service = state => {
    const fence = state?.fence;
    requireHistory(fence?.binding?.projectId === target.projectId && fence.binding.environmentId === target.environmentId
      && Array.isArray(fence.binding.serviceIds) && fence.binding.serviceIds.includes(serviceId)
      && Array.isArray(fence.services));
    const matches = fence.services.filter(row => row.serviceId === serviceId);
    requireHistory(matches.length === 1); return matches[0];
  };
  const priorFence = index(service(previous).deployments), currentFence = index(service(current).deployments);
  // No disappearance or lifecycle change is admitted for any nonactive row,
  // including records older than the stage's first page.
  for (const [id, old] of priorFence) {
    const observed = currentFence.get(id);
    requireHistory(bound(old) && bound(observed) && (predecessors.has(id) || same(old, observed)));
  }
  const missing = [];
  for (const [id, old] of priorHistory) {
    const visible = currentHistory.get(id);
    requireHistory(priorFence.has(id) && currentFence.has(id));
    if (visible) requireHistory(visible.digest === old.digest && (predecessors.has(id) || same(visible, old)));
    else {
      requireHistory(currentStage.hasMoreHistory === true);
      const oldLifecycle = priorFence.get(id), lifecycle = currentFence.get(id);
      requireHistory(bound(lifecycle) && oldLifecycle.status === old.status
        && (predecessors.has(id) || same(oldLifecycle, lifecycle)));
      missing.push({ old, lifecycle });
    }
  }
  const supplements = [];
  for (const { old, lifecycle } of missing) {
    const result = await query(QUERY, { id: old.id });
    const deployment = result?.deployment;
    const digest = deployment?.meta?.imageDigest ?? null;
    requireHistory(deployment?.id === old.id && bound(deployment) && deployment.status === lifecycle.status && digest === old.digest);
    supplements.push({ id: old.id, status: deployment.status, digest, target: { ...boundTarget } });
  }
  if (supplements.length) await onSupplement(structuredClone(supplements));
  return supplements;
}
