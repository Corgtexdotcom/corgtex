import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, readableArtifactIds, invariant } from "@corgtex/domain";
import { assertLegacyRecoveryProjection, withLegacyRecoveryProjection } from "../../../packages/domain/src/legacy-recovery";

/** Recovery has already committed. A projection failure never rolls back history
 * or pretends that background bootstrap workers can read a new receipt. */
export async function rebuildRecoveredHistory(actor: AppActor, workspaceId: string,
  recovery: {id: string; kind: string; receiptId: string}) {
  if (recovery.kind !== "Document" && recovery.kind !== "BrainSource") return {status:"NOT_REQUIRED" as const};
  try {
    const kind=recovery.kind;
    return await withLegacyRecoveryProjection(actor,workspaceId,recovery.receiptId,kind,recovery.id,async()=>{
    await assertLegacyRecoveryProjection(actor,workspaceId,recovery.receiptId,kind,recovery.id);
    if (recovery.kind === "Document") {
      const {syncDocumentKnowledge} = await import("@corgtex/knowledge");
      const chunks = await syncDocumentKnowledge({workspaceId,documentId:recovery.id,lineageActor:actor});
      return {status:"COMPLETED" as const,chunks};
    }
    // Article publication and embedding are intentionally separate existing
    // phases. Retry their exact persisted outputs after an embedding failure;
    // never create another proposal merely because that final phase failed.
    let runCursor: string | undefined;
    let rebuilt = 0;
    const {syncBrainArticleKnowledge} = await import("@corgtex/knowledge");
    for (;;) {
      const runs = await prisma.agentRun.findMany({where:{workspaceId,agentKey:"brain-absorb",triggerRef:`legacy-recovery:${recovery.receiptId}`,
        ...(runCursor?{id:{gt:runCursor}}:{})},orderBy:{id:"asc"},take:100,select:{id:true}});
      for (const run of runs) {
        let articleCursor: string | undefined;
        for (;;) {
          const articles=await prisma.brainArticle.findMany({where:{workspaceId,sourceIds:{has:recovery.id},
            derivationJson:{path:["agentRunId"],equals:run.id},...(articleCursor?{id:{gt:articleCursor}}:{})},orderBy:{id:"asc"},take:100});
          const readable=await readableArtifactIds(actor,workspaceId,"BrainArticle",articles);
          for(const article of articles) {
            invariant(readable.has(article.id),409,"RECOVERY_PROJECTION_STALE","A saved recovery proposal is no longer authorized.");
            const chunks=await syncBrainArticleKnowledge({workspaceId,articleId:article.id,lineageActor:actor});
            invariant(chunks>0 || !article.bodyMd.trim(),409,"RECOVERY_PROJECTION_STALE","A saved proposal could not be indexed.");
            rebuilt++;
          }
          if(articles.length<100) break;
          articleCursor=articles.at(-1)!.id;
        }
      }
      if(runs.length<100) break;
      runCursor=runs.at(-1)!.id;
    }
    if(rebuilt) return {status:"COMPLETED" as const,rebuilt};
    const {absorbSource,executeAgentRun} = await import("@corgtex/agents");
    const roots = await captureArtifactInputProof(actor,workspaceId,[{kind:"BrainSource",id:recovery.id}]);
    const result = await executeAgentRun({lineageActor:actor,lineageRoots:roots,contextLineageRoots:()=>roots,
      workspaceId,agentKey:"brain-absorb",triggerType:"MANUAL",triggerRef:`legacy-recovery:${recovery.receiptId}`,
      goal:"Regenerate company knowledge from the exact currently authorized recovered source.",payload:{sourceId:recovery.id},
      plan:["load-source","absorb","sync-knowledge"],
      buildContext:async helpers=>helpers.tool("brain.load-source",{sourceId:recovery.id},async()=>({sourceId:recovery.id}),{receipt:helpers.plannedInputReceipt}),
      execute:async(_context,helpers,runId,model)=>helpers.step("absorb",{sourceId:recovery.id},async()=>{
        const value=await absorbSource({workspaceId,sourceId:recovery.id,agentRunId:runId,model,actor,recoveryReceiptId:recovery.receiptId});
        if ("skipped" in value && value.skipped) throw new Error("RECOVERY_PROJECTION_SKIPPED");
        const lineageReceipt="lineageRoots" in value && value.lineageRoots?.length ? await helpers.captureInputs(value.lineageRoots) : undefined;
        return {resultJson:value,...(lineageReceipt?{lineageReceipt}:{})};
      },{receipt:helpers.plannedInputReceipt}),
    });
    return {status:"status" in result && result.status === "COMPLETED" ? "COMPLETED" as const : "PENDING" as const,
      ...("id" in result?{runId:result.id}:{}),...("reason" in result?{reason:result.reason}:{})};
    });
  } catch {
    // Never expose storage/model/provider errors or old source content in diagnostics.
    return {status:"FAILED" as const,retryable:true};
  }
}
