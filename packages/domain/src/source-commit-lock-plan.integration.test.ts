import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, encryptSecret, mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputSnapshotProof, captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, withSourceCommitPermissionReadPass } from "./source-permission-epochs";
import { assertSourceCommitSnapshotInputCovered, prepareSourceCommitAmbientFences, prepareSourceCommitLockPlan, prepareSourceCommitOwnerAttestation, sourceCommitHeadAdvisoryKey,
  withSourceCommitLockPlan, type SourceCommitLockPlan } from "./source-commit-lock-plan";

const provider=vi.hoisted(()=>({transport:vi.fn(),transactionDepth:0,callsInTransaction:0}));
vi.mock("./external-mcp",async importOriginal=>({...await importOriginal<typeof import("./external-mcp")>(),readBoxExternalMcpNativeResponse:provider.transport}));
vi.mock("@corgtex/shared",async importOriginal=>{
  const actual=await importOriginal<typeof import("@corgtex/shared")>();
  const instrumented=new Proxy(actual.prisma,{get(target,key){
    if(key!=="$transaction")return Reflect.get(target,key,target);
    return async (...args:any[])=>{
      const original=target.$transaction.bind(target) as (...args:any[])=>Promise<any>;
      if(typeof args[0]!=="function")return original(...args);
      const callback=args[0];return original(async(tx:any)=>{
        provider.transactionDepth++;try{return await callback(tx);}finally{provider.transactionDepth--;}
      },...args.slice(1));
    };
  }});return {...actual,prisma:instrumented};
});
import { selectExternalContentSource } from "./external-content-sources";
import { captureExternalProviderFetchInput,prepareExternalProviderRootCommitPreflight,withExternalProviderCommitPreflight } from "./external-provider-authority";
import { assertSourceCommitRowCovered } from "./source-commit-lock-plan";

import { prepareArtifactStructuralAuthority } from "./artifact-structural-authority";
import { prepareArtifactSourceCommit,withArtifactSourceCommit } from "./artifact-source-commit";
import { createAction,completeAction,updateAction } from "./actions";
import { withMcpToolInput } from "./mcp-tool-input";
import { lineageContentFingerprint,inspectStoredArtifactInputDependencies,readableArtifactIds } from "./source-lineage";

import { withArtifactInputSnapshotAllocations } from "./artifact-input-snapshot-allocations";

// Exclusive disposable DB only. No DDL, provider, model or external credentials.
async function fixture(seedAmbient=true) {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic commit locks",slug:`source-locks-${randomUUID()}`}});
  const foreign=await prisma.workspace.create({data:{name:"Synthetic foreign",slug:`source-locks-foreign-${randomUUID()}`}});
  const user=await prisma.user.create({data:{email:`source-lock-owner-${randomUUID()}@example.test`,passwordHash:"synthetic",displayName:"Owner"}});
  const other=await prisma.user.create({data:{email:`source-lock-other-${randomUUID()}@example.test`,passwordHash:"synthetic",displayName:"Other"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN"}});
  await prisma.member.create({data:{workspaceId:foreign.id,userId:other.id,role:"ADMIN"}});
  const actor:AppActor={kind:"user",user:{id:user.id,email:user.email,displayName:user.displayName,globalRole:"USER"}};
  const source=await prisma.brainArticle.create({data:{workspaceId:workspace.id,slug:"native-original",type:"STRATEGY",title:"Synthetic original",bodyMd:"Exact before-model original",isPrivate:false,sourceIds:[]}});
  await prisma.$transaction(async tx=>{
    await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"BrainArticle",id:source.id},content:source,origin:"HUMAN_ORIGINAL",inputs:[]});
    // Current ambient keys are administrative fences, never added to the captured historical prompt roots.
    if(seedAmbient) await capturePermissionEpochs(tx,workspace.id,[{kind:"ModulePolicy",id:"finance"},{kind:"FeaturePolicy",id:"FINANCE"},{kind:"MemberRolePolicy",id:member.id}]);
  });
  const roots=await captureArtifactInputProof(actor,workspace.id,[{kind:"BrainArticle",id:source.id},{kind:"User",id:user.id},{kind:"Member",id:member.id}]);
  const binding={kind:"HUMAN_REQUEST" as const,id:randomUUID(),generation:1};
  return {workspace,foreign,user,other,member,actor,source,roots,binding};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
async function prepare(f:Fixture) {return prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:[],ownerBinding:f.binding});}
async function owner(f:Fixture,tx:Prisma.TransactionClient,plan:SourceCommitLockPlan){
  return prepareSourceCommitOwnerAttestation(f.actor,f.workspace.id,tx,plan,f.binding,async connection=>{
    const member=await connection.member.findFirst({where:{id:f.member.id,workspaceId:f.workspace.id,userId:f.user.id,isActive:true}});
    if(!member) throw Object.assign(new Error("Synthetic owner no longer current"),{code:"OWNER_STALE"});
  });
}
async function run(f:Fixture,plan:SourceCommitLockPlan,work:(tx:Prisma.TransactionClient)=>Promise<unknown>){
  return prisma.$transaction(async tx=>{
    const attested=await owner(f,tx,plan);
    return withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,[],f.binding,plan,attested,()=>work(tx));
  },{timeout:20000});
}
async function sourceWriter(f:Fixture,write:(tx:Prisma.TransactionClient)=>Promise<unknown>){
  return prisma.$transaction(async tx=>{
    const key=sourceCommitHeadAdvisoryKey(f.workspace.id,{kind:"BrainArticle",id:f.source.id});
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id=${f.source.id} FOR UPDATE`;
    return write(tx);
  },{timeout:20000});
}

describe("closed source commit plan PostgreSQL races",()=>{
  beforeEach(async()=>{
    await truncateAllTables();provider.transactionDepth=0;provider.callsInTransaction=0;
    provider.transport.mockClear().mockImplementation(async()=>{
      if(provider.transactionDepth){provider.callsInTransaction++;throw new Error("Provider inside interactive transaction");}
      return {text:"Synthetic authenticated provider response",etag:"fixed"};
    });
  });
  it("holds the whole head union before the actual owner control row lock",async()=>{
    const f=await fixture(),request=await prisma.executionRequest.create({data:{workspaceId:f.workspace.id,createdByUserId:f.user.id,goal:"Synthetic owner control"}});
    const targets=[{kind:"ExecutionRequest" as const,id:request.id,projectedAuthority:{status:request.status}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>{
      const attested=await prepareSourceCommitOwnerAttestation(f.actor,f.workspace.id,tx,plan,f.binding,async connection=>{
        for(const input of [{kind:"BrainArticle" as const,id:f.source.id},{kind:"ExecutionRequest" as const,id:request.id}]) {
          const key=sourceCommitHeadAdvisoryKey(f.workspace.id,input);
          const held=await connection.$queryRaw<Array<{held:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
            AND classid=((hashtextextended(${key},0)>>32)&4294967295)::oid AND objid=(hashtextextended(${key},0)&4294967295)::oid) AS held`;
          expect(held[0].held).toBe(true);
        }
        await connection.$queryRaw`SELECT id FROM "ExecutionRequest" WHERE id=${request.id} FOR UPDATE`;
      });
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,attested,async()=>"held");
    },{timeout:20000});
    expect(provider.callsInTransaction).toBe(0);
  });
  it("allocates a genuine immutable snapshot only for its exact planned semantic input",async()=>{
    const f=await fixture(),input=f.roots.find(root=>root.kind==="BrainArticle")!,id=randomUUID();
    const targets=[{kind:"ArtifactInputSnapshot" as const,id,snapshotInput:input,projectedAuthority:{sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>{
      const attested=await owner(f,tx,plan);
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,attested,()=>
        withArtifactInputSnapshotAllocations(f.actor,f.workspace.id,tx,[{id,input}],async()=>{
          assertSourceCommitSnapshotInputCovered(tx,f.workspace.id,id,input);
          const roots=await captureArtifactInputSnapshotProof(f.actor,f.workspace.id,input,tx);
          expect(roots.some(root=>root.kind==="ArtifactInputSnapshot"&&root.id===id)).toBe(true);
        }));
    },{timeout:20000});
    const snapshot=await prisma.artifactInputSnapshot.findUniqueOrThrow({where:{id}});
    expect(snapshot.sourceFingerprint).toBe(input.fingerprint);expect(snapshot.sourceId).toBe(input.id);
    // The INSERT trigger creates metadata for all physical rows. It must never
    // be included as a freshly minted grant in the immutable saved input vector.
    const saved=snapshot.permissionEpochsJson as {entries:Array<{kind:string;id:string}>};
    expect(saved.entries.some(entry=>entry.kind==="ArtifactInputSnapshot"&&entry.id===id)).toBe(false);
    const immutable=await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"ArtifactInputSnapshot",id}]);
    expect(immutable.some(root=>root.id===id)).toBe(true);
    const convertedId=randomUUID(),convertedTargets=[{kind:"ArtifactInputSnapshot" as const,id:convertedId,snapshotInput:immutable[0],projectedAuthority:{sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint}}];
    const converted=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,immutable,{writeTargets:convertedTargets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>withSourceCommitLockPlan(f.actor,f.workspace.id,tx,immutable,convertedTargets,f.binding,converted,await owner(f,tx,converted),async()=>"validated-equivalence"),{timeout:20000});
    expect(provider.callsInTransaction).toBe(0);
  });
  it("prepares fresh unconfigured ambient absence fences without recertifying original inputs",async()=>{
    const f=await fixture(false),original=structuredClone(f.roots);
    await expect(prepare(f)).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
    await prepareSourceCommitAmbientFences(f.actor,f.workspace.id);
    expect(f.roots).toEqual(original);
    const plan=await prepare(f);expect(await run(f,plan,async()=>"fresh-workspace")).toBe("fresh-workspace");
    const unknown=f.roots.map(root=>({...root,permissionEpochs:root.permissionEpochs?{...root.permissionEpochs,entries:root.permissionEpochs.entries.filter(entry=>entry.kind!=="BrainArticle")}:undefined}));
    await expect(prepareSourceCommitLockPlan(f.actor,f.workspace.id,unknown,{writeTargets:[],ownerBinding:f.binding})).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("serializes a reader before a protocol-compliant body writer without a deadlock",async()=>{
    const f=await fixture(),plan=await prepare(f),entered=deferred(),release=deferred(),writerStarted=deferred();
    const reader=run(f,plan,async()=>{entered.resolve();await release.promise;return "published-original";});
    await entered.promise;
    const writer=sourceWriter(f,async tx=>{writerStarted.resolve();return tx.brainArticle.update({where:{id:f.source.id},data:{bodyMd:"Later revision"}});});
    // A statement on the competing transaction is waiting for our source-head lock.
    try {
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++) {
        const rows=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted=false) AS waiting`;
        waiting=rows[0].waiting;if(!waiting) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
    } finally {release.resolve();await Promise.allSettled([reader,writer]);}
    expect(await reader).toBe("published-original");await writer;await writerStarted.promise;
    expect((await prisma.brainArticle.findUniqueOrThrow({where:{id:f.source.id}})).bodyMd).toBe("Later revision");
  });
  it("rejects the old plan when the body writer wins before lock acquisition",async()=>{
    const f=await fixture(),plan=await prepare(f),entered=deferred(),release=deferred();
    const writer=sourceWriter(f,async tx=>{await tx.brainArticle.update({where:{id:f.source.id},data:{bodyMd:"Won before publication"}});entered.resolve();await release.promise;});
    await entered.promise;const work=vi.fn(async()=>"must-not-publish");const reader=run(f,plan,work);
    release.resolve();await writer;await expect(reader).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(work).not.toHaveBeenCalled();
  });
  it("rejects a changed latest manifest head with identical body bytes",async()=>{
    const f=await fixture(),plan=await prepare(f);
    await sourceWriter(f,async tx=>{
      const prior=await tx.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspace.id,artifactType:"BrainArticle",artifactId:f.source.id},orderBy:{revision:"desc"}});
      await tx.artifactInputLineage.create({data:{workspaceId:f.workspace.id,artifactType:"BrainArticle",artifactId:f.source.id,revision:prior.revision+1,
        origin:"UNKNOWN",contentHash:prior.contentHash,rootsJson:Prisma.JsonNull,inputsJson:Prisma.JsonNull}});
    });
    const work=vi.fn(async()=>"must-not-publish");await expect(run(f,plan,work)).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(work).not.toHaveBeenCalled();
  });
  it("rejects a source permission revoke/restore even though the consumed bytes are identical again",async()=>{
    const f=await fixture(),plan=await prepare(f);
    await prisma.brainArticle.update({where:{id:f.source.id},data:{isPrivate:true,ownerMemberId:f.member.id}});
    await prisma.brainArticle.update({where:{id:f.source.id},data:{isPrivate:false,ownerMemberId:null}});
    const work=vi.fn(async()=>"must-not-publish");await expect(run(f,plan,work)).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(work).not.toHaveBeenCalled();
  });
  it("rejects a newly inserted restricting support edge without taking that new row lock",async()=>{
    const f=await fixture(),plan=await prepare(f);
    await prisma.workspaceSupportGrant.create({data:{workspaceId:f.workspace.id,userId:f.user.id,role:"SETUP",grantedByUserId:f.other.id}});
    await expect(run(f,plan,async()=>"must-not-publish")).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("detects its own trigger transition inside work and atomically rolls back unrelated output",async()=>{
    const f=await fixture(),plan=await prepare(f),outputId=randomUUID();
    await expect(run(f,plan,async tx=>{
      await tx.brainArticle.update({where:{id:f.source.id},data:{isPrivate:true,ownerMemberId:f.member.id}});
      await tx.brainArticle.create({data:{id:outputId,workspaceId:f.workspace.id,slug:"rollback",type:"STRATEGY",title:"Must roll back",bodyMd:"Synthetic",sourceIds:[]}});
    })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(await prisma.brainArticle.findUnique({where:{id:outputId}})).toBeNull();
    expect((await prisma.brainArticle.findUniqueOrThrow({where:{id:f.source.id}})).isPrivate).toBe(false);
  });
  it("fences same-transaction privacy changes during a delayed nested permission read",async()=>{
    const f=await fixture(),plan=await prepare(f),entered=deferred(),changed=deferred();
    await expect(run(f,plan,async tx=>{
      const reader=withSourceCommitPermissionReadPass(tx,f.workspace.id,async()=>{
        const admitted=await isArtifactInputProofReadable(f.actor,f.workspace.id,f.roots,tx);
        expect(admitted).toBe(true);entered.resolve();await changed.promise;return admitted;
      });
      await entered.promise;
      try {await tx.brainArticle.update({where:{id:f.source.id},data:{isPrivate:true,ownerMemberId:f.member.id}});}
      finally {changed.resolve();}
      expect(await reader).toBe(false);
      expect(await isArtifactInputProofReadable(f.actor,f.workspace.id,f.roots,tx)).toBe(false);
      return "must-roll-back";
    })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect((await prisma.brainArticle.findUniqueOrThrow({where:{id:f.source.id}})).isPrivate).toBe(false);
    expect(provider.callsInTransaction).toBe(0);
  });
  it("reads newborn own epochs afresh and fences a delayed referenced newborn change",async()=>{
    const f=await fixture(),outputId=randomUUID(),targets=[{kind:"BrainArticle" as const,id:outputId,projectedAuthority:{isPrivate:false}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await expect(prisma.$transaction(async tx=>{
      return withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,await owner(f,tx,plan),async()=>{
        // An unused reserved output need not have an epoch before construction.
        expect(await isArtifactInputProofReadable(f.actor,f.workspace.id,f.roots,tx)).toBe(true);
        await tx.brainArticle.create({data:{id:outputId,workspaceId:f.workspace.id,slug:"read-pass-newborn",type:"STRATEGY",title:"Synthetic",bodyMd:"Synthetic"}});
        const saved=await capturePermissionEpochs(tx,f.workspace.id,[{kind:"BrainArticle",id:outputId}]);
        expect(await withSourceCommitPermissionReadPass(tx,f.workspace.id,()=>isArtifactPermissionEpochProofCurrent(f.workspace.id,saved,tx))).toBe(true);
        const entered=deferred(),changed=deferred();
        const reader=withSourceCommitPermissionReadPass(tx,f.workspace.id,async()=>{
          const admitted=await isArtifactPermissionEpochProofCurrent(f.workspace.id,saved,tx);
          expect(admitted).toBe(true);entered.resolve();await changed.promise;return admitted;
        });
        await entered.promise;
        try {await tx.brainArticle.update({where:{id:outputId},data:{isPrivate:true,ownerMemberId:f.member.id}});}
        finally {changed.resolve();}
        expect(await reader).toBe(false);
        expect(await withSourceCommitPermissionReadPass(tx,f.workspace.id,()=>isArtifactPermissionEpochProofCurrent(f.workspace.id,saved,tx))).toBe(false);
        // This tests epoch fencing only, not an authenticated producer recipe.
        throw Object.assign(new Error("Synthetic epoch fixture rollback"),{code:"SYNTHETIC_ROLLBACK"});
      });
    },{timeout:20000})).rejects.toMatchObject({code:"SYNTHETIC_ROLLBACK"});
    expect(await prisma.brainArticle.findUnique({where:{id:outputId}})).toBeNull();
    expect(provider.callsInTransaction).toBe(0);
  });
  it("binds the capability to the real transaction connection and consumes it once",async()=>{
    const f=await fixture(),plan=await prepare(f);
    let attested:Awaited<ReturnType<typeof owner>>;
    await prisma.$transaction(async tx=>{attested=await owner(f,tx,plan);});
    await expect(prisma.$transaction(tx=>withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,[],f.binding,plan,attested!,async()=>null)))
      .rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    await expect(run(f,plan,async()=>"moved-head-reservation")).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    const replacement=await prepare(f);
    expect(await run(f,replacement,async()=>"same-tx")).toBe("same-tx");
    await expect(run(f,replacement,async()=>"replayed")).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
  });
  it("blocks detached standalone fallback while the actual transaction is still open",async()=>{
    const f=await fixture(),plan=await prepare(f),barrier=deferred(),unplannedId=randomUUID();
    await prisma.$transaction(async tx=>{
      let detached!:Promise<void>;
      const attested=await owner(f,tx,plan);
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,[],f.binding,plan,attested,async()=>{
        detached=barrier.promise.then(async()=>{
          await expect(capturePermissionEpochs(tx,f.workspace.id,[{kind:"BrainArticle",id:unplannedId}]))
            .rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
          await expect(captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"BrainArticle",id:f.source.id}],tx))
            .rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
        });
        return "source-scope-finished";
      });
      barrier.resolve();await detached;
      expect(await tx.sourcePermissionEpoch.findMany({where:{workspaceId:f.workspace.id,sourceKind:"BrainArticle",sourceId:unplannedId}})).toEqual([]);
    },{timeout:20000});
    expect(provider.callsInTransaction).toBe(0);
  });
  it("serializes two consumed-only Box native scopes using initial UPDATE without provider calls inside SQL",async()=>{
    const f=await fixture();
    const connection=await prisma.externalMcpConnection.create({data:{workspaceId:f.workspace.id,userId:f.user.id,providerKey:"box",
      displayName:"Synthetic Box",serverUrl:"https://mcp.box.com",providerAccountId:"synthetic-owner",accessTokenEnc:encryptSecret("synthetic-token"),scopes:["root_readwrite"]}});
    const selection=await selectExternalContentSource(f.actor,{workspaceId:f.workspace.id,providerKey:"box",sourceKind:"FILE",externalId:"synthetic-file",connectionId:connection.id,title:"Synthetic selection"});
    const receipt=await captureExternalProviderFetchInput(f.actor,{workspaceId:f.workspace.id,externalContentSourceId:selection.id,connectionId:connection.id,
      sourceKind:"FILE",externalId:"synthetic-file",toolName:"get_file_content",arguments:{file_id:"synthetic-file"}});
    f.roots.push(...await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"ExternalProviderFetchInput",id:receipt.input.id}]));
    const plans=await Promise.all([prepare(f),prepare(f)]);
    const native=await Promise.all([prepareExternalProviderRootCommitPreflight(f.actor,f.workspace.id,f.roots),prepareExternalProviderRootCommitPreflight(f.actor,f.workspace.id,f.roots)]);
    const entered=deferred(),release=deferred();const secondWork=vi.fn(async()=>"second");
    const reader=run(f,plans[0],tx=>withExternalProviderCommitPreflight(f.actor,f.workspace.id,tx,native[0],async()=>{
      assertSourceCommitRowCovered(tx,"ExternalContentSource",selection.id,"UPDATE");entered.resolve();await release.promise;return "first";
    }));
    await entered.promise;
    const second=run(f,plans[1],tx=>withExternalProviderCommitPreflight(f.actor,f.workspace.id,tx,native[1],secondWork));
    try {
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++){
        const rows=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%"ExternalContentSource"%') AS waiting`;
        waiting=rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);expect(secondWork).not.toHaveBeenCalled();
    }finally{release.resolve();await Promise.allSettled([reader,second]);}
    expect(await reader).toBe("first");expect(await second).toBe("second");
    expect(provider.transport).toHaveBeenCalled();expect(provider.callsInTransaction).toBe(0);
  });
  it("creates a declared newborn request/result parent pair under reserved heads",async()=>{
    const f=await fixture(),requestId=randomUUID(),resultId=randomUUID();
    const targets=[{kind:"ExecutionRequest" as const,id:requestId,projectedAuthority:{status:"PENDING"}},
      {kind:"ExecutionResult" as const,id:resultId,projectedAuthority:{executionRequestId:requestId,status:"SUBMITTED"}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>{
      const attested=await owner(f,tx,plan);
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,attested,async()=>{
        await tx.executionRequest.create({data:{id:requestId,workspaceId:f.workspace.id,goal:"Synthetic output"}});
        await tx.executionResult.create({data:{id:resultId,workspaceId:f.workspace.id,executionRequestId:requestId,idempotencyKey:randomUUID(),outputJson:{synthetic:true}}});
      });
    },{timeout:20000});
    expect((await prisma.executionResult.findUniqueOrThrow({where:{id:resultId}})).executionRequestId).toBe(requestId);
  });
  it("creates relation-owned and CRM-owned targets without fabricated workspace columns",async()=>{
    const f=await fixture(),runId=randomUUID(),stepId=randomUUID(),prospectId=randomUUID();
    const lead=await prisma.demoLead.create({data:{workspaceId:f.workspace.id,email:"synthetic-lead@example.test"}});
    const targets=[{kind:"AgentRun" as const,id:runId,projectedAuthority:{status:"PENDING"}},
      {kind:"AgentStep" as const,id:stepId,projectedAuthority:{agentRunId:runId,status:"PENDING"}},
      {kind:"CrmProspectWorkspace" as const,id:prospectId,projectedAuthority:{targetWorkspaceId:f.workspace.id,demoLeadId:lead.id,status:"PROVISIONING"}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>{
      const attested=await owner(f,tx,plan);
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,attested,async()=>{
        await tx.agentRun.create({data:{id:runId,workspaceId:f.workspace.id,agentKey:"synthetic",triggerType:"MANUAL",goal:"Synthetic output"}});
        await tx.agentStep.create({data:{id:stepId,agentRunId:runId,name:"Synthetic step"}});
        await tx.crmProspectWorkspace.create({data:{id:prospectId,crmWorkspaceId:f.workspace.id,targetWorkspaceId:f.workspace.id,demoLeadId:lead.id,adminEmail:f.user.email}});
      });
    },{timeout:20000});
    expect((await prisma.agentStep.findUniqueOrThrow({where:{id:stepId}})).agentRunId).toBe(runId);
    expect((await prisma.crmProspectWorkspace.findUniqueOrThrow({where:{id:prospectId}})).crmWorkspaceId).toBe(f.workspace.id);
  });
  it("updates a consumed declared body with unchanged governing envelope and preimage receipt",async()=>{
    const f=await fixture(),targets=[{kind:"BrainArticle" as const,id:f.source.id}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding});
    await prisma.$transaction(async tx=>{
      const attested=await owner(f,tx,plan);
      await withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,attested,async()=>{
        await tx.brainArticle.update({where:{id:f.source.id},data:{bodyMd:"Generated replacement"}});
      });
    },{timeout:20000});
    expect((await prisma.brainArticle.findUniqueOrThrow({where:{id:f.source.id}})).bodyMd).toBe("Generated replacement");
  });
  it("creates an owner-private variant of an unknown canonical original with full source/native composition",async()=>{
    const f=await fixture(),otherMember=await prisma.member.create({data:{workspaceId:f.workspace.id,userId:f.other.id,role:"CONTRIBUTOR"}});
    const target=await prisma.brainArticle.create({data:{workspaceId:f.workspace.id,slug:"unknown-canonical",type:"STRATEGY",title:"UNKNOWN ORIGINAL TITLE",bodyMd:"UNKNOWN ORIGINAL BODY",isPrivate:false,ownerMemberId:otherMember.id}});
    const structural=await prepareArtifactStructuralAuthority(f.actor,f.workspace.id,{kind:"BrainArticle",id:target.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:f.binding});
    const outputId=randomUUID(),fingerprint=lineageContentFingerprint("BrainArticle",target);
    const options={ownerBinding:f.binding,structuralAuthorities:[structural],writeTargets:[{kind:"BrainArticle" as const,id:outputId,
      projectedAuthority:{isPrivate:true,ownerMemberId:f.member.id,variantOfArticleId:target.id,variantTargetFingerprint:fingerprint,variantSourceStateJson:{}}}]};
    const token=await prepareArtifactSourceCommit(f.actor,f.workspace.id,f.roots,options);
    const priorProviderCalls=provider.transport.mock.calls.length;
    const output=await prisma.$transaction(tx=>withArtifactSourceCommit(f.actor,f.workspace.id,tx,f.roots,options,token,async bound=>{
      if(!await bound.member.findFirst({where:{id:f.member.id,isActive:true}}))throw new Error("Owner stale");
    },async()=>{
      const row=await tx.brainArticle.create({data:{id:outputId,workspaceId:f.workspace.id,slug:"private-replacement",type:"STRATEGY",title:"Fresh private variant",bodyMd:"Only known original input",
        isPrivate:true,ownerMemberId:f.member.id,variantOfArticleId:target.id,variantTargetFingerprint:fingerprint,variantSourceStateJson:{}}});
      await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"BrainArticle",id:row.id},content:row,origin:"DERIVED",inputs:[],inheritedRoots:f.roots});
      expect((await readableArtifactIds(f.actor,f.workspace.id,"BrainArticle",[row],tx)).has(row.id)).toBe(true);return row;
    }),{timeout:20000});
    expect(provider.transport.mock.calls.length).toBe(priorProviderCalls);expect(provider.callsInTransaction).toBe(0);
    expect((await prisma.brainArticle.findUniqueOrThrow({where:{id:target.id}})).bodyMd).toBe("UNKNOWN ORIGINAL BODY");
    expect((await readableArtifactIds(f.actor,f.workspace.id,"BrainArticle",[target])).size).toBe(0);
    const otherActor:AppActor={kind:"user",user:{id:f.other.id,email:f.other.email,displayName:f.other.displayName}};
    expect((await readableArtifactIds(otherActor,f.workspace.id,"BrainArticle",[output])).size).toBe(0);
  });
  it("rejects structural canonical mutation and missing old semantic governor vectors",async()=>{
    const f=await fixture(),target=f.source;
    const structural=await prepareArtifactStructuralAuthority(f.actor,f.workspace.id,{kind:"BrainArticle",id:target.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:f.binding});
    await expect(prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{ownerBinding:f.binding,writeTargets:[{kind:"BrainArticle",id:target.id}],structuralAuthorities:[structural]})).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    const cap=await prepareArtifactStructuralAuthority(f.actor,f.workspace.id,{kind:"BrainArticle",id:target.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:f.binding});
    const original=f.roots.map(root=>({...root,permissionEpochs:root.permissionEpochs?{...root.permissionEpochs,entries:root.permissionEpochs.entries.filter(entry=>entry.kind!=="BrainArticle")}:undefined}));
    await expect(prepareSourceCommitLockPlan(f.actor,f.workspace.id,original,{ownerBinding:f.binding,writeTargets:[{kind:"BrainArticle",id:randomUUID(),projectedAuthority:{isPrivate:true,ownerMemberId:f.member.id,
      variantOfArticleId:target.id,variantTargetFingerprint:lineageContentFingerprint("BrainArticle",target),variantSourceStateJson:{}}}],structuralAuthorities:[cap]})).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it.each(["target-head","target-restore","owner-restore"])("rejects structural %s drift before publishing any output",async drift=>{
    const f=await fixture(),otherMember=await prisma.member.create({data:{workspaceId:f.workspace.id,userId:f.other.id,role:"CONTRIBUTOR"}});
    const target=await prisma.brainArticle.create({data:{workspaceId:f.workspace.id,slug:"unknown-target",type:"STRATEGY",title:"Unknown",bodyMd:"Preserved",isPrivate:false,ownerMemberId:otherMember.id}});
    const cap=await prepareArtifactStructuralAuthority(f.actor,f.workspace.id,{kind:"BrainArticle",id:target.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:f.binding});
    const targets=[{kind:"BrainArticle" as const,id:randomUUID(),projectedAuthority:{isPrivate:true,ownerMemberId:f.member.id,variantOfArticleId:target.id,
      variantTargetFingerprint:lineageContentFingerprint("BrainArticle",target),variantSourceStateJson:{}}}];
    const plan=await prepareSourceCommitLockPlan(f.actor,f.workspace.id,f.roots,{writeTargets:targets,ownerBinding:f.binding,structuralAuthorities:[cap]});
    if(drift==="target-head") await prisma.artifactInputLineage.create({data:{workspaceId:f.workspace.id,artifactType:"BrainArticle",artifactId:target.id,revision:1,origin:"UNKNOWN",contentHash:lineageContentFingerprint("BrainArticle",target),rootsJson:Prisma.JsonNull,inputsJson:Prisma.JsonNull}});
    else if(drift==="target-restore"){
      await prisma.brainArticle.update({where:{id:target.id},data:{isPrivate:true}});await prisma.brainArticle.update({where:{id:target.id},data:{isPrivate:false}});
    }else{
      await prisma.member.update({where:{id:otherMember.id},data:{isActive:false}});await prisma.member.update({where:{id:otherMember.id},data:{isActive:true}});
    }
    const work=vi.fn(async()=>"must-not-publish");
    await expect(prisma.$transaction(async tx=>withSourceCommitLockPlan(f.actor,f.workspace.id,tx,f.roots,targets,f.binding,plan,await owner(f,tx,plan),work),{timeout:20000}))
      .rejects.toMatchObject({code:drift==="owner-restore"?"PERMISSION_CHANGED":"SOURCE_CHANGED"});
    expect(work).not.toHaveBeenCalled();expect(await prisma.brainArticle.findUnique({where:{id:targets[0].id}})).toBeNull();
  });
  it("captures a standing public note's complete old snapshot closure after reopening and private credential revocation",async()=>{
    const f=await fixture(),action=await createAction(f.actor,{workspaceId:f.workspace.id,title:"Original public Action",bodyMd:"Original human body",isPrivate:false,assigneeMemberId:f.member.id});
    const credential=await prisma.agentCredential.create({data:{workspaceId:f.workspace.id,label:"Synthetic write-only native sender",tokenHash:randomUUID(),scopes:["actions:write"]}});
    const actor:AppActor={kind:"agent",authProvider:"credential",label:credential.label,workspaceIds:[f.workspace.id],credentialId:credential.id,credentialVersion:mcpCredentialVersion(credential.tokenHash),scopes:["actions:write"]};
    await runWithMcpOrigin({kind:"agent",id:credential.id,workspaceId:f.workspace.id,credentialVersion:actor.credentialVersion,scopeHash:mcpScopesHash(credential.scopes),requiredScopes:["actions:write"]},
      ()=>withMcpToolInput(actor,{workspaceId:f.workspace.id,toolName:"complete_action",args:{actionId:action.id,completedVia:"  Explicit published field  "},requiredScopes:["actions:write"]},args=>completeAction(actor,{workspaceId:f.workspace.id,...args})));
    await updateAction(f.actor,{workspaceId:f.workspace.id,actionId:action.id,status:"OPEN"});
    await prisma.agentCredential.update({where:{id:credential.id},data:{isActive:false}});
    const note=await prisma.conversationOperationOutcome.findFirstOrThrow({where:{workspaceId:f.workspace.id,operation:"ACTION_COMPLETION_PUBLIC_NOTE"}});
    const controls=note.controlJson as Record<string,unknown>;
    const proof=await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"ConversationOperationOutcome",id:note.id}]);
    const dependencies=await inspectStoredArtifactInputDependencies(prisma,f.workspace.id,proof,{maxNodes:10000});
    expect(dependencies.complete).toBe(true);expect(dependencies.roots).toContainEqual(expect.objectContaining({kind:"ArtifactInputSnapshot",id:controls.oldActionSnapshotId,fingerprint:controls.oldActionSnapshotFingerprint}));
    expect(dependencies.roots.some(root=>root.kind==="McpToolInput")).toBe(false);
    const outputId=randomUUID(),options={ownerBinding:f.binding,writeTargets:[{kind:"BrainArticle" as const,id:outputId,projectedAuthority:{isPrivate:false}}]};
    const token=await prepareArtifactSourceCommit(f.actor,f.workspace.id,proof,options);
    await prisma.$transaction(tx=>withArtifactSourceCommit(f.actor,f.workspace.id,tx,proof,options,token,async()=>{},async()=>{
      const row=await tx.brainArticle.create({data:{id:outputId,workspaceId:f.workspace.id,slug:"public-note-derived",type:"STRATEGY",title:"Published contribution",bodyMd:"Explicit published field"}});
      await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"BrainArticle",id:row.id},content:row,origin:"DERIVED",inputs:[],inheritedRoots:proof});
      expect((await readableArtifactIds(f.actor,f.workspace.id,"BrainArticle",[row],tx)).has(row.id)).toBe(true);
    }),{timeout:20000});
    expect(provider.callsInTransaction).toBe(0);
  });
  it("denies a missing original governor vector and never refreshes it from current policy",async()=>{
    const f=await fixture();
    const old:LineageRoot[]=structuredClone(f.roots);
    f.roots=f.roots.map(root=>({...root,permissionEpochs:root.permissionEpochs?{...root.permissionEpochs,entries:root.permissionEpochs.entries.filter(entry=>entry.kind!=="BrainArticle")}:undefined}));
    await expect(prepare(f)).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
    expect(old.some(root=>root.permissionEpochs?.entries.some(entry=>entry.kind==="BrainArticle"))).toBe(true);
  });
});
