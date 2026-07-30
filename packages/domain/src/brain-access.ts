import type { KnowledgeAccessDomain } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { getFinanceAccessPolicy } from "./finance";

const WORKSPACE_ACCESS_DOMAIN: KnowledgeAccessDomain = "WORKSPACE";
const FINANCE_ACCESS_DOMAIN: KnowledgeAccessDomain = "FINANCE";

function agentCanRequestFinanceKnowledge(actor: AppActor) {
  return actor.kind !== "agent"
    || Boolean(actor.scopes?.includes("brain:read") && actor.scopes.includes("finance:read"));
}

export async function resolveKnowledgeAccessDomains(
  actor: AppActor,
  workspaceId: string,
): Promise<KnowledgeAccessDomain[]> {
  await requireWorkspaceMembership({ actor, workspaceId });

  if (!agentCanRequestFinanceKnowledge(actor)) {
    return [WORKSPACE_ACCESS_DOMAIN];
  }

  const financePolicy = await getFinanceAccessPolicy(actor, workspaceId);
  return financePolicy.canRead
    ? [WORKSPACE_ACCESS_DOMAIN, FINANCE_ACCESS_DOMAIN]
    : [WORKSPACE_ACCESS_DOMAIN];
}
