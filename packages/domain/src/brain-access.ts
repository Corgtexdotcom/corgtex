import { Prisma, type KnowledgeAccessDomain } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { getFinanceAccessPolicy } from "./finance";

const WORKSPACE_ACCESS_DOMAIN: KnowledgeAccessDomain = "WORKSPACE";
const FINANCE_ACCESS_DOMAIN: KnowledgeAccessDomain = "FINANCE";


export async function resolveKnowledgeAccessDomains(
  actor: AppActor,
  workspaceId: string,
  db?: Prisma.TransactionClient,
): Promise<KnowledgeAccessDomain[]> {
  await requireWorkspaceMembership({ actor, workspaceId, ...(db ? { tx: db } : {}) });

  if (actor.kind === "agent") {
    return [WORKSPACE_ACCESS_DOMAIN];
  }

  const financePolicy = db ? await getFinanceAccessPolicy(actor, workspaceId, db)
    : await getFinanceAccessPolicy(actor, workspaceId);
  return financePolicy.canRead
    ? [WORKSPACE_ACCESS_DOMAIN, FINANCE_ACCESS_DOMAIN]
    : [WORKSPACE_ACCESS_DOMAIN];
}
