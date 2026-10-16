import type { AppActor } from "@corgtex/shared";

// Trusted producer authority is process local. Neither a bearer credential nor
// a serialized actor can acquire a purpose by copying this object's fields.
type Purpose = { workspaceId: string; kind: "CHECKIN_GENERATION"; memberId: string }
  | { workspaceId: string; kind: "BUDGET_ALERT" };
const purposes = new WeakMap<AppActor, Purpose>();
function mint(purpose: Purpose): AppActor {
  const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap",
    label: purpose.kind, workspaceIds: Object.freeze([purpose.workspaceId]) as unknown as string[] });
  purposes.set(actor, Object.freeze(purpose));
  return actor;
}
export const createCheckInGenerationActor = (workspaceId: string, memberId: string) => mint({ workspaceId, memberId, kind: "CHECKIN_GENERATION" });
export const createBudgetAlertActor = (workspaceId: string) => mint({ workspaceId, kind: "BUDGET_ALERT" });
export function internalSourcePermission(actor: AppActor, workspaceId: string, kind: string, row: Record<string, unknown>) {
  const purpose = purposes.get(actor);
  if (!purpose || purpose.workspaceId !== workspaceId) return false;
  return purpose.kind === "CHECKIN_GENERATION" ? kind === "CheckIn" && row.memberId === purpose.memberId
    : kind === "ModelUsageBudget" || kind === "ModelUsageCost";
}
