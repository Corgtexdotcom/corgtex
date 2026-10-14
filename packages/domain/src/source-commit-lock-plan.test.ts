import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { fixture, alpha, beta, workspaceId, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { prepareArtifactStructuralAuthority } from "./artifact-structural-authority";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { isArtifactInputProofReadable, recordArtifactInputLineage, captureArtifactInputProof, lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { mergePermissionEpochProofs, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";
import { assertOutsideArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { SOURCE_AUTHORITY_TABLES } from "./source-authority-edges";
import { isSourceCommitHeldPermissionUnionCurrent, sourceCommitPermissionReadIdentities, registerSourceCommitPublishedOutput, assertSourceCommitSemanticRootCovered, assertSourceCommitSnapshotInputCovered, assertSourceCommitTransactionCompatible, assertSourceCommitPermissionReadCovered, assertSourceCommitEpochCaptureCovered, assertSourceCommitPredicateRowsCovered, prepareSourceCommitAmbientFences, assertSourceCommitEpochCovered, assertSourceCommitNewbornEpochAllowed, assertSourceCommitOutputHeadReserved, assertSourceCommitRowCovered,
  hasActiveSourceCommitLockPlan, prepareSourceCommitLockPlan, prepareSourceCommitOwnerAttestation, withSourceCommitLockPlan,
  type SourceCommitLockPlan, type SourceCommitWriteTarget } from "./source-commit-lock-plan";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));

const binding = { kind: "HUMAN_REQUEST", id: "synthetic-request", generation: 1 } as const;
let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
let proof: LineageRoot[];
let tx: Prisma.TransactionClient;
let pid: number;
let sqlLog: string[];
function sql(args: any[]) { return typeof args[0]?.sql === "string" ? args[0].sql : Array.isArray(args[0]) ? args[0].join("?") : ""; }
function values(args: any[]) { return args[0]?.values ?? args.slice(1); }
function source() { return fixture.rows.action.find(row => row.id === "source"); }
function cloneTx() { return new Proxy(fixture.prisma, { get(target, key) { return key === "$transaction" ? undefined : Reflect.get(target,key); } }); }
function extraTables() {
  for (const table of SOURCE_AUTHORITY_TABLES) {
    const name = table[0].toLowerCase() + table.slice(1);
    if (fixture.prisma[name]) continue;
    fixture.rows[name] = [];
    const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key,value]: [string,any]) => {
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const parents: Record<string,string> = {circle:"circle",member:"member",role:"role",agentRun:"agentRun",article:"brainArticle"};
        if (parents[key]) return match(fixture.rows[parents[key]].find(parent=>parent.id===row[key+"Id"]),value);
        if (value.in) return value.in.includes(row[key]);
        throw new Error(`Unsupported fixture predicate ${key}`);
      }
      return row?.[key]===value;
    });
    const find = (args: any) => fixture.rows[name].filter(row => match(row,args.where));
    fixture.prisma[name] = {
      findFirst: vi.fn(async (args: any) => { const row=find(args)[0]; return row ? args.select ? Object.fromEntries(Object.keys(args.select).map(key=>[key,row[key]])) : {...row} : null; }),
      findMany: vi.fn(async (args: any) => find(args).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,args.take ?? Infinity).map(row=>({...row}))),
    };
  }
}
beforeEach(async () => {
  await resetFixture(); extraTables(); sqlLog=[];pid=101;
  fixture.prisma.$queryRaw.mockReset().mockImplementation(async (...args: any[]) => {
    const text=sql(args);sqlLog.push(text);
    if(text.includes("pg_backend_pid")) return [{pid,transactionId:"20261013"}];
    const table=text.match(/FROM "([A-Za-z]+)"/)?.[1];
    if(table&&text.includes("FOR ")) {
      const name=table[0].toLowerCase()+table.slice(1),id=values(args)[0];
      return fixture.rows[name].filter(row=>row.id===id).map(row=>({id:row.id}));
    }
    return [];
  });
  fixture.prisma.$executeRaw.mockReset().mockImplementation(async (...args: any[])=>{sqlLog.push(sql(args));return 1;});
  epochs=installSourcePermissionEpochFixture(fixture.prisma);
  const epochQuery=fixture.prisma.$queryRaw.getMockImplementation();
  fixture.prisma.$queryRaw.mockImplementation(async (...args:any[])=>{
    if(sql(args).includes('FROM "SourcePermissionEpoch"')) sqlLog.push(sql(args));
    return epochQuery(...args);
  });
  await prepareSourceCommitAmbientFences(alpha,workspaceId,{db:fixture.prisma});
  const action=fixture.add("action",{id:"source",workspaceId,title:"Synthetic source",bodyMd:"Before-model original",isPrivate:false,authorUserId:null,archivedAt:null});
  await known("Action",action,[],alpha);
  // Actual complete capture before generation, including the actor labels present in this synthetic prompt.
  proof=await captureArtifactInputProof(alpha,workspaceId,[{kind:"Action",id:action.id},{kind:"User",id:"alpha"},{kind:"Member",id:"member-alpha"}],fixture.prisma);
  tx=cloneTx();sqlLog=[];
});
async function prepare(writeTargets:SourceCommitWriteTarget[]=[],maxNodes?:number) {
  return prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets,ownerBinding:binding,db:fixture.prisma,maxNodes});
}
async function run(plan:SourceCommitLockPlan,work=async()=>"written",writeTargets:SourceCommitWriteTarget[]=[],ownerCheck:(tx:Prisma.TransactionClient)=>Promise<void>=vi.fn(async()=>{})) {
  const owner=await prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,plan,binding,ownerCheck);
  return withSourceCommitLockPlan(alpha,workspaceId,tx,proof,writeTargets,binding,plan,owner,work);
}

describe("private variant structural fence composition",()=>{
  function canonical(){return fixture.add("brainArticle",{id:"canonical",workspaceId,title:"UNKNOWN OLD TITLE",bodyMd:"UNKNOWN OLD BODY",isPrivate:false,ownerMemberId:null,archivedAt:null});}
  function targets(row:any):SourceCommitWriteTarget[]{return [{kind:"BrainArticle",id:"private-variant",projectedAuthority:{isPrivate:true,ownerMemberId:"member-alpha",
    variantOfArticleId:row.id,variantTargetFingerprint:lineageContentFingerprint("BrainArticle",row),variantSourceStateJson:{},archivedAt:null}}];}
  async function token(row:any){return prepareArtifactStructuralAuthority(alpha,workspaceId,{kind:"BrainArticle",id:row.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:binding});}
  async function planned(row:any,outputs=targets(row)){
    return prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:outputs,ownerBinding:binding,db:fixture.prisma,structuralAuthorities:[await token(row)]});
  }
  it("creates a new private variant of an unknown canonical body without adopting its old ancestry",async()=>{
    const row=canonical(),outputs=targets(row),original=structuredClone(proof),plan=await planned(row,outputs);
    await run(plan,async()=>{
      expect(sourceCommitPermissionReadIdentities(tx,workspaceId)).toContainEqual({kind:"BrainArticle",id:row.id});
      const capture=await capturePermissionEpochs(tx,workspaceId,[{kind:"BrainArticle",id:row.id},{kind:"BrainArticle",id:"private-variant"}]);
      expect(await isArtifactPermissionEpochProofCurrent(workspaceId,capture,tx)).toBe(true);
      expect(()=>assertSourceCommitEpochCovered(tx,workspaceId,capture)).toThrow();
      fixture.add("brainArticle",{id:"private-variant",workspaceId,...outputs[0].projectedAuthority,title:"Fresh known inputs",bodyMd:"Generated only from captured Action"});
      return "created";
    },outputs);
    expect(proof).toEqual(original);expect(row.bodyMd).toBe("UNKNOWN OLD BODY");
  });
  it("captures the full other-owner governor closure through the real structural factory",async()=>{
    const row=canonical();row.ownerMemberId="member-beta";
    const outputs=targets(row),plan=await planned(row,outputs);
    await run(plan,async()=>{
      assertSourceCommitRowCovered(tx,"Member","member-beta");assertSourceCommitRowCovered(tx,"User","beta");
      const governed=await capturePermissionEpochs(tx,workspaceId,[{kind:"MemberUserPolicy",id:"beta"},{kind:"WorkspaceSupportPolicy",id:"beta"}]);
      expect(await isArtifactPermissionEpochProofCurrent(workspaceId,governed,tx)).toBe(true);
      expect(()=>assertSourceCommitEpochCovered(tx,workspaceId,governed)).toThrow();
      fixture.add("brainArticle",{id:"private-variant",workspaceId,...outputs[0].projectedAuthority});return "created";
    },outputs);
  });
  it("does not use structural current fences to repair missing historical semantic input governors",async()=>{
    const row=canonical();await known("BrainArticle",row,[],alpha);
    proof.push({kind:"BrainArticle",id:row.id,fingerprint:lineageContentFingerprint("BrainArticle",row)});
    await expect(planned(row)).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("rejects forged, cloned, replayed, duplicate and unused structural receipts",async()=>{
    const row=canonical(),outputs=targets(row),receipt=await token(row);
    const options={writeTargets:outputs,ownerBinding:binding,db:fixture.prisma};
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,structuralAuthorities:[{} as any]})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,structuralAuthorities:[{...receipt}]})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,structuralAuthorities:[receipt,receipt]})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,structuralAuthorities:[receipt]});
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,structuralAuthorities:[receipt]})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{...options,writeTargets:[],structuralAuthorities:[await token(row)]})).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
  });
  it("rejects canonical mutation, existing variant updates, wrong owner and public outputs",async()=>{
    const row=canonical();
    for(const overrides of [{isPrivate:false},{ownerMemberId:"member-beta"},{variantTargetFingerprint:"a".repeat(64)}]){
      const outputs=targets(row);Object.assign(outputs[0].projectedAuthority!,overrides);
      await expect(planned(row,outputs)).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    }
    await expect(planned(row,[...targets(row),{kind:"BrainArticle",id:row.id}])).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    fixture.add("brainArticle",{id:"private-variant",workspaceId,...targets(row)[0].projectedAuthority});
    await expect(planned(row)).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
  });
  it("rejects exact target head/body/envelope drift and revoke/restore after preparation",async()=>{
    const row=canonical(),outputs=targets(row),plan=await planned(row,outputs);
    fixture.add("artifactInputLineage",{id:"new-unknown-head",workspaceId,artifactType:"BrainArticle",artifactId:row.id,revision:1,origin:"UNKNOWN",rootsJson:null,inputsJson:null,contentHash:lineageContentFingerprint("BrainArticle",row)});
    await expect(run(plan,async()=>"bad",outputs)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    const fresh=await planned(row,outputs);epochs.bump(workspaceId,"BrainArticle",row.id);epochs.bump(workspaceId,"BrainArticle",row.id);
    await expect(run(fresh,async()=>"bad",outputs)).rejects.toMatchObject({code:"PERMISSION_CHANGED"});
    const changed=await planned(row,outputs);row.bodyMd="Changed after model";
    await expect(run(changed,async()=>"bad",outputs)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("fences exact graph bundles and refuses canonical targets used as uncertified semantic sources",async()=>{
    const graph=fixture.add("contextGraphObject",{id:"graph",workspaceId,objectType:"Team",title:"UNKNOWN OLD GRAPH BODY",createdByUserId:"alpha"});
    fixture.add("artifactInputLineage",{id:"unknown-graph-head",workspaceId,artifactType:"ContextGraphObject",artifactId:graph.id,revision:1,origin:"UNKNOWN",rootsJson:null,inputsJson:null,contentHash:lineageContentFingerprint("ContextGraphObject",graph)});
    const graphToken=()=>prepareArtifactStructuralAuthority(alpha,workspaceId,{kind:"ContextGraphObject",id:graph.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:binding});
    const outputs:SourceCommitWriteTarget[]=[{kind:"GenericDerivedArtifactVariant",id:"graph-variant",projectedAuthority:{ownerMemberId:"member-alpha",targetKind:"ContextGraphObject",targetId:graph.id,
      targetFingerprint:lineageContentFingerprint("ContextGraphObject",graph),targetsJson:[{kind:"ContextGraphObject",id:graph.id,manifestId:"unknown-graph-head",fingerprint:lineageContentFingerprint("ContextGraphObject",graph)}],
      scopeJson:{sources:[{kind:"Action",id:"source",fingerprint:proof[0].fingerprint}]},sourceStateJson:{permissionEpochs:proof[0].permissionEpochs}}}];
    const plan=await prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:outputs,ownerBinding:binding,db:fixture.prisma,structuralAuthorities:[await graphToken()]});
    await run(plan,async()=>{fixture.add("genericDerivedArtifactVariant",{id:"graph-variant",workspaceId,...outputs[0].projectedAuthority});return "created";},outputs);
    fixture.rows.genericDerivedArtifactVariant=[];
    outputs[0].projectedAuthority!.scopeJson={sources:[{kind:"ContextGraphObject",id:graph.id,fingerprint:lineageContentFingerprint("ContextGraphObject",graph)}]};
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:outputs,ownerBinding:binding,db:fixture.prisma,structuralAuthorities:[await graphToken()]})).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
  });
  it("rejects every omitted or mismatched graph scope source even when its governor epoch is covered",async()=>{
    const graph=fixture.add("contextGraphObject",{id:"graph",workspaceId,objectType:"Team",title:"Unknown",createdByUserId:"alpha"});
    fixture.add("artifactInputLineage",{id:"unknown-graph-head",workspaceId,artifactType:"ContextGraphObject",artifactId:graph.id,revision:1,origin:"UNKNOWN",rootsJson:null,inputsJson:null,contentHash:lineageContentFingerprint("ContextGraphObject",graph)});
    const governor=fixture.rows.workspace[0],omitted={kind:"Workspace" as const,id:workspaceId,fingerprint:lineageContentFingerprint("Workspace",governor)};
    proof[0]={...proof[0],permissionEpochs:mergePermissionEpochProofs(proof[0].permissionEpochs,await capturePermissionEpochs(fixture.prisma,workspaceId,[omitted]))};
    const outputs:SourceCommitWriteTarget[]=[{kind:"GenericDerivedArtifactVariant",id:"variant",projectedAuthority:{ownerMemberId:"member-alpha",targetKind:"ContextGraphObject",targetId:graph.id,
      targetFingerprint:lineageContentFingerprint("ContextGraphObject",graph),targetsJson:[{kind:"ContextGraphObject",id:graph.id,manifestId:"unknown-graph-head",fingerprint:lineageContentFingerprint("ContextGraphObject",graph)}],
      scopeJson:{sources:[]},sourceStateJson:{permissionEpochs:proof[0].permissionEpochs}}}];
    for(const second of [omitted,{...proof[0],fingerprint:"a".repeat(64)}]) {
      outputs[0].projectedAuthority!.scopeJson={sources:[proof[0],second]};
      const structural=await prepareArtifactStructuralAuthority(alpha,workspaceId,{kind:"ContextGraphObject",id:graph.id},{purpose:"NEW_OWNER_PRIVATE_VARIANT",ownerBinding:binding});
      await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:outputs,ownerBinding:binding,db:fixture.prisma,structuralAuthorities:[structural]})).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    }
  });

});

describe("complete source commit lock plan",()=>{
  it("requires every held epoch at fresh comparison while allowing absent unused newborn metadata",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false}}],plan=await prepare(targets);
    await run(plan,async()=>{
      const identities=sourceCommitPermissionReadIdentities(tx,workspaceId),observed:Array<{kind:string;id:string;epoch:string}>=[];
      for(const identity of identities) {
        if(identity.kind==="BrainArticle"&&identity.id==="new-output")continue;
        const actual=await capturePermissionEpochs(tx,workspaceId,[identity]);observed.push(actual.entries[0]);
      }
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,observed)).toBe(true);
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,observed.slice(1))).toBe(false);
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,observed.map((entry,index)=>index?entry:{...entry,epoch:String(BigInt(entry.epoch)+1n)}))).toBe(false);
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,[...observed,{kind:"BrainArticle",id:"new-output",epoch:"1"}])).toBe(true);
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,[...observed,{kind:"BrainArticle",id:"unplanned",epoch:"1"}])).toBe(false);
      expect(isSourceCommitHeldPermissionUnionCurrent(tx,workspaceId,[...observed,observed[0]])).toBe(false);
      expect(()=>isSourceCommitHeldPermissionUnionCurrent(cloneTx(),workspaceId,observed)).toThrow();
      expect(()=>isSourceCommitHeldPermissionUnionCurrent(tx,"foreign-workspace",observed)).toThrow();
      return "fresh-held-comparison";
    },targets);
  });
  it("exposes only immutable covered permission identities without values, initialization or a detached scope",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false}}],plan=await prepare(targets);
    let retained:readonly {kind:string;id:string}[]=[];
    await run(plan,async()=>{
      const before=sqlLog.length;retained=sourceCommitPermissionReadIdentities(tx,workspaceId);
      expect(sqlLog.length).toBe(before);
      expect(retained).toContainEqual({kind:"BrainArticle",id:"new-output"});
      expect(retained).toContainEqual({kind:"Action",id:"source"});
      expect(retained).toContainEqual({kind:"ModulePolicy",id:"finance"});
      expect(retained).not.toContainEqual({kind:"BrainArticle",id:"unplanned-output"});
      expect(retained.every(identity=>Object.keys(identity).sort().join(",")==="id,kind")).toBe(true);
      const keys=retained.map(identity=>JSON.stringify([identity.kind,identity.id]));
      expect(keys).toEqual([...new Set(keys)].sort());
      expect(Object.isFrozen(retained)).toBe(true);expect(retained.every(Object.isFrozen)).toBe(true);
      expect(()=>{(retained[0] as {id:string}).id="changed";}).toThrow();
      expect(()=>sourceCommitPermissionReadIdentities(cloneTx(),workspaceId)).toThrow();
      expect(()=>sourceCommitPermissionReadIdentities(tx,"foreign-workspace")).toThrow();
      expect(fixture.rows.brainArticle.some(row=>row.id==="new-output")).toBe(false);
      return "identities-only";
    },targets);
    expect(retained).toContainEqual({kind:"BrainArticle",id:"new-output"});
    expect(()=>sourceCommitPermissionReadIdentities(tx,workspaceId)).toThrow();
  });
  it("fences actual lineage reader base and foreign clients before any membership or source query",async()=>{
    const outputs:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false}}],plan=await prepare(outputs);
    await run(plan,async()=>{
      const memberCalls=fixture.membership.mock.calls.length,sourceCalls=fixture.prisma.action.findFirst.mock.calls.length;
      await expect(isArtifactInputProofReadable(alpha,workspaceId,[proof[0]])).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
      await expect(isArtifactInputProofReadable(alpha,workspaceId,[proof[0]],cloneTx())).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
      expect(fixture.membership.mock.calls.length).toBe(memberCalls);expect(fixture.prisma.action.findFirst.mock.calls.length).toBe(sourceCalls);
      expect(await isArtifactInputProofReadable(alpha,workspaceId,[proof[0]],tx)).toBe(true);
      const row=fixture.add("brainArticle",{id:"new-output",workspaceId,isPrivate:false,title:"Verified output",bodyMd:"Complete captured original"});
      await recordArtifactInputLineage({tx,actor:alpha,workspaceId,artifact:{kind:"BrainArticle",id:row.id},content:row,origin:"DERIVED",inputs:[],inheritedRoots:proof});
      expect(await isArtifactInputProofReadable(alpha,workspaceId,[{kind:"BrainArticle",id:row.id,fingerprint:lineageContentFingerprint("BrainArticle",row)}],tx)).toBe(true);
      return "reader-fenced";
    },outputs);
  });
  it("never upgrades governing rows into semantics and admits only exact registered output fingerprints",async()=>{
    const output={kind:"BrainArticle" as const,id:"new-output",projectedAuthority:{isPrivate:false}},plan=await prepare([output]);
    const governor={kind:"Workspace" as const,id:workspaceId,fingerprint:lineageContentFingerprint("Workspace",fixture.rows.workspace[0])};
    const published={kind:"BrainArticle" as const,id:output.id,fingerprint:"a".repeat(64)};
    await run(plan,async()=>{
      assertSourceCommitSemanticRootCovered(tx,workspaceId,proof[0]);
      expect(()=>assertSourceCommitSemanticRootCovered(tx,workspaceId,governor)).toThrow();
      expect(()=>assertSourceCommitSemanticRootCovered(tx,workspaceId,published)).toThrow();
      expect(()=>registerSourceCommitPublishedOutput(tx,workspaceId,governor)).toThrow();
      expect(()=>registerSourceCommitPublishedOutput(cloneTx(),workspaceId,published)).toThrow();
      registerSourceCommitPublishedOutput(tx,workspaceId,published);
      assertSourceCommitSemanticRootCovered(tx,workspaceId,published);
      expect(()=>assertSourceCommitSemanticRootCovered(tx,workspaceId,{...published,fingerprint:"b".repeat(64)})).toThrow();
      const final={...published,fingerprint:"c".repeat(64)};
      registerSourceCommitPublishedOutput(tx,workspaceId,final);
      assertSourceCommitSemanticRootCovered(tx,workspaceId,final);
      expect(()=>assertSourceCommitSemanticRootCovered(tx,workspaceId,published)).toThrow();
      return "verified-writer-only";
    },[output]);
    expect(()=>registerSourceCommitPublishedOutput(tx,workspaceId,published)).toThrow();
    expect(()=>assertSourceCommitSemanticRootCovered(tx,workspaceId,published)).toThrow();
  });
  it("reserves the complete sorted head union before the first owner row lock and never reacquires it",async()=>{
    const outputs:SourceCommitWriteTarget[]=[{kind:"ExecutionRequest",id:"new-request",projectedAuthority:{}}];
    const plan=await prepare(outputs),counts:number[]=[];
    const check=async()=>{
      counts.push(sqlLog.filter(query=>query.includes("pg_advisory_xact_lock")).length);
      sqlLog.push("OWNER_CONTROL_FOR_UPDATE");
    };
    await run(plan,async()=>"published",outputs,check);
    expect(counts[0]).toBeGreaterThan(1);expect(new Set(counts).size).toBe(1);
    const ownerIndex=sqlLog.indexOf("OWNER_CONTROL_FOR_UPDATE");
    expect(sqlLog.slice(ownerIndex).some(query=>query.includes("pg_advisory_xact_lock"))).toBe(false);
    const next=await prepare();await prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,next,binding,async()=>{});
    await expect(prepareSourceCommitOwnerAttestation(alpha,workspaceId,cloneTx(),next,binding,async()=>{})).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
  });
  it("requires exact original semantic snapshot input before allocation and verifies stored bytes",async()=>{
    const input=proof[0],prior=structuredClone(source());
    const outputs:SourceCommitWriteTarget[]=[{kind:"ArtifactInputSnapshot",id:"new-snapshot",snapshotInput:input,
      projectedAuthority:{sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint}}];
    const plan=await prepare(outputs);
    await run(plan,async()=>{
      assertSourceCommitSnapshotInputCovered(tx,workspaceId,"new-snapshot",input);
      expect(()=>assertSourceCommitSnapshotInputCovered(tx,workspaceId,"new-snapshot",{...input,fingerprint:"a".repeat(64)})).toThrow();
      expect(()=>assertSourceCommitSnapshotInputCovered(cloneTx(),workspaceId,"new-snapshot",input)).toThrow();
      fixture.add("artifactInputSnapshot",{id:"new-snapshot",workspaceId,...outputs[0].projectedAuthority,origin:"HUMAN_ORIGINAL",contentJson:prior,rootsJson:[],epochProofVersion:1,permissionEpochsJson:input.permissionEpochs});
      return "snapshotted";
    },outputs);
    fixture.rows.artifactInputSnapshot=[];
    for(const target of [{...outputs[0],snapshotInput:undefined},{...outputs[0],projectedAuthority:{...outputs[0].projectedAuthority,sourceFingerprint:"a".repeat(64)}}])
      await expect(prepare([target])).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    const fresh=await prepare(outputs);
    await expect(run(fresh,async()=>{
      fixture.add("artifactInputSnapshot",{id:"new-snapshot",workspaceId,...outputs[0].projectedAuthority,contentJson:{...prior,bodyMd:"Uncaptured body"},rootsJson:[]});return "bad";
    },outputs)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("rejects snapshot ancestry and inputs borrowed from permission-only governor coverage",async()=>{
    const input=proof[0],outputs:SourceCommitWriteTarget[]=[{kind:"ArtifactInputSnapshot",id:"new-snapshot",snapshotInput:input,
      projectedAuthority:{sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint}}];
    const governor=fixture.rows.workspace[0],unconsumed={kind:"Workspace" as const,id:workspaceId,fingerprint:lineageContentFingerprint("Workspace",governor)};
    await expect(prepare([{...outputs[0],snapshotInput:unconsumed,projectedAuthority:{sourceKind:unconsumed.kind,sourceId:unconsumed.id,sourceFingerprint:unconsumed.fingerprint}}])).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    const plan=await prepare(outputs);
    await expect(run(plan,async()=>{
      fixture.add("artifactInputSnapshot",{id:"new-snapshot",workspaceId,...outputs[0].projectedAuthority,contentJson:structuredClone(source()),rootsJson:[unconsumed]});return "bad";
    },outputs)).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
  });
  it("accepts an authenticated immutable snapshot's exact original source equivalence",async()=>{
    const prior=structuredClone(source()),input=proof[0];
    const snapshot=fixture.add("artifactInputSnapshot",{id:"original-snapshot",workspaceId,sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint,
      origin:"HUMAN_ORIGINAL",contentJson:prior,accessEnvelopeJson:prior,rootsJson:[],epochProofVersion:1,permissionEpochsJson:input.permissionEpochs});
    proof=[{kind:"ArtifactInputSnapshot",id:snapshot.id,fingerprint:lineageContentFingerprint("ArtifactInputSnapshot",snapshot),permissionEpochs:input.permissionEpochs},...proof.slice(1)];
    const outputs:SourceCommitWriteTarget[]=[{kind:"ArtifactInputSnapshot",id:"converted",snapshotInput:proof[0],projectedAuthority:{sourceKind:input.kind,sourceId:input.id,sourceFingerprint:input.fingerprint}}];
    const plan=await prepare(outputs);
    await run(plan,async()=>{assertSourceCommitSnapshotInputCovered(tx,workspaceId,"converted",proof[0]);fixture.add("artifactInputSnapshot",{...snapshot,id:"converted"});return "converted";},outputs);
  });
  it("locks advisory heads then the complete physical union before a single saved+ambient epoch union",async()=>{
    const plan=await prepare();sqlLog=[];
    const beforeProof=structuredClone(proof);
    const ownerCheck=vi.fn(async (connection)=>{expect(connection).toBe(tx);});
    expect(await run(plan,async()=>{
      expect(hasActiveSourceCommitLockPlan(tx)).toBe(true);
      assertSourceCommitRowCovered(tx,"Action","source");
      assertSourceCommitEpochCovered(tx,workspaceId,proof[0].permissionEpochs);
      return "written";
    },[],ownerCheck)).toBe("written");
    const advisory=sqlLog.map((query,index)=>query.includes("pg_advisory_xact_lock")?index:-1).filter(index=>index>=0);
    const physical=sqlLog.map((query,index)=>query.includes("FOR SHARE")&&!query.includes("SourcePermissionEpoch")?index:-1).filter(index=>index>=0);
    const saved=sqlLog.map((query,index)=>query.includes("SourcePermissionEpoch")&&query.includes("FOR SHARE")?index:-1).filter(index=>index>=0);
    expect(saved).toHaveLength(1);expect(Math.max(...advisory)).toBeLessThan(Math.min(...physical));expect(Math.max(...physical)).toBeLessThan(saved[0]);
    expect(proof).toEqual(beforeProof);expect(hasActiveSourceCommitLockPlan(tx)).toBe(false);expect(ownerCheck).toHaveBeenCalledTimes(4);
  });
  it("reserves consumed-only Box selection UPDATE before epochs so native scopes never upgrade SHARE",async()=>{
    const selection=fixture.add("externalContentSource",{id:"selection",workspaceId,connectionId:"box-connection",selectedByUserId:"alpha",providerKey:"box",sourceKind:"FILE",externalId:"synthetic-file"});
    fixture.add("externalMcpConnection",{id:"box-connection",workspaceId,userId:"alpha",status:"ACTIVE"});
    // Planner metadata is not a native serving capability. Authentic native transport is covered in PG.
    const input=fixture.add("externalProviderFetchInput",{id:"native-box",workspaceId,connectionId:"box-connection",localUserId:"alpha",providerKey:"box",externalContentSourceId:selection.id});
    const original=await capturePermissionEpochs(fixture.prisma,workspaceId,[{kind:"ExternalProviderFetchInput",id:input.id},
      {kind:"ExternalContentSource",id:selection.id},{kind:"ExternalMcpConnection",id:"box-connection"},
      {kind:"MemberUserPolicy",id:"alpha"},{kind:"WorkspaceSupportPolicy",id:"alpha"}]);
    proof.push({kind:"ExternalProviderFetchInput",id:input.id,fingerprint:lineageContentFingerprint("ExternalProviderFetchInput",input),permissionEpochs:original});
    const plan=await prepare();sqlLog=[];
    await run(plan,async()=>{assertSourceCommitRowCovered(tx,"ExternalContentSource",selection.id,"UPDATE");return "reserved";});
    const update=sqlLog.findIndex(query=>query.includes('FROM "ExternalContentSource"')&&query.includes("FOR UPDATE"));
    const epoch=sqlLog.findIndex(query=>query.includes('FROM "SourcePermissionEpoch"')&&query.includes("FOR SHARE"));
    expect(update).toBeGreaterThanOrEqual(0);expect(update).toBeLessThan(epoch);
    expect(sqlLog.some(query=>query.includes('FROM "ExternalContentSource"')&&query.includes("FOR SHARE"))).toBe(false);
  });
  it("uses the exact native channel policy only for permission-only Slack channel edges",async()=>{
    fixture.add("communicationInstallation",{id:"install",workspaceId,provider:"SLACK",status:"ACTIVE"});
    const channel=fixture.add("communicationChannel",{id:"channel",workspaceId,provider:"SLACK",installationId:"install",externalChannelId:"C_PUBLIC",kind:"PUBLIC",isIngestEnabled:true});
    fixture.add("communicationMessage",{id:"message",workspaceId,provider:"SLACK",installationId:"install",externalChannelId:"C_PUBLIC"});
    const original=await capturePermissionEpochs(fixture.prisma,workspaceId,[{kind:"CommunicationMessageNativeInput",id:"native-slack"},
      {kind:"CommunicationMessage",id:"message"},{kind:"CommunicationInstallation",id:"install"},{kind:"IntegrationPolicy",id:"SLACK"},
      {kind:"CommunicationChannelPolicy",id:'["install","C_PUBLIC"]'}]);
    const native=fixture.add("communicationMessageNativeInput",{id:"native-slack",workspaceId,provider:"SLACK",mode:"AUTHENTICATED_FETCH",installationId:"install",
      externalChannelId:"C_PUBLIC",communicationMessageId:"message",epochProofVersion:1,permissionEpochsJson:original});
    proof.push({kind:"CommunicationMessageNativeInput",id:native.id,fingerprint:lineageContentFingerprint("CommunicationMessageNativeInput",native),permissionEpochs:original});
    const before=structuredClone(proof);const plan=await prepare();await run(plan);
    expect(proof).toEqual(before);expect(original.entries.some(entry=>entry.kind==="CommunicationChannel")).toBe(false);
    proof.push({kind:"CommunicationChannel",id:channel.id,fingerprint:lineageContentFingerprint("CommunicationChannel",channel),permissionEpochs:original});
    await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
    proof=before;native.permissionEpochsJson={...original,entries:original.entries.filter(entry=>entry.kind!=="CommunicationChannelPolicy")};
    proof=proof.map(root=>root.kind==="CommunicationMessageNativeInput"?{...root,fingerprint:lineageContentFingerprint(root.kind,native),permissionEpochs:native.permissionEpochsJson}:root);
    await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("allows a preallocated newborn target with exclusive head reservation and only its own new epoch",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false,ownerMemberId:null,archivedAt:null}}];
    const plan=await prepare(targets);
    await run(plan,async()=>{
      assertSourceCommitOutputHeadReserved(tx,workspaceId,targets[0]);
      assertSourceCommitNewbornEpochAllowed(tx,workspaceId,targets[0]);
      fixture.add("brainArticle",{id:"new-output",workspaceId,isPrivate:false,ownerMemberId:null,archivedAt:null,title:"Output",bodyMd:"Derived from admitted original"});
      fixture.add("artifactInputLineage",{id:"new-manifest",workspaceId,artifactType:"BrainArticle",artifactId:"new-output",revision:1,
        origin:"DERIVED",contentHash:"f".repeat(64),inputsJson:[],rootsJson:proof,permissionEpochsJson:proof[0].permissionEpochs,epochProofVersion:1});
      return "created";
    },targets);
    expect(sqlLog.some(query=>query.includes('"BrainArticle"')&&query.includes("FOR UPDATE"))).toBe(true);
  });
  it("resolves newborn output parents structurally without promoting missing consumed sources",async()=>{
    const targets:SourceCommitWriteTarget[]=[
      {kind:"ExecutionRequest",id:"new-request",projectedAuthority:{status:"PENDING"}},
      {kind:"ExecutionResult",id:"new-result",projectedAuthority:{executionRequestId:"new-request",status:"SUBMITTED"}}];
    const plan=await prepare(targets);
    await run(plan,async()=>{
      fixture.add("executionRequest",{id:"new-request",workspaceId,status:"PENDING"});
      fixture.add("executionResult",{id:"new-result",workspaceId,executionRequestId:"new-request",status:"SUBMITTED"});
      return "created";
    },targets);
    proof.push({kind:"ExecutionRequest",id:"missing-consumed",fingerprint:"a".repeat(64),permissionEpochs:proof[0].permissionEpochs});
    await expect(prepare([{kind:"ExecutionRequest",id:"missing-consumed",projectedAuthority:{status:"PENDING"}}])).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("permits a declared consumed body update while retaining the original receipt and exact final envelope",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"Action",id:"source"}];
    const plan=await prepare(targets);
    await run(plan,async()=>{source().bodyMd="Regenerated body from captured original";return "updated";},targets);
    expect(source().bodyMd).toBe("Regenerated body from captured original");
  });
  it("uses relation and CRM ownership columns for newborn output envelopes",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"AgentRun",id:"new-run",projectedAuthority:{}},
      {kind:"AgentStep",id:"new-step",projectedAuthority:{agentRunId:"new-run"}},
      {kind:"CrmProspectWorkspace",id:"new-prospect",projectedAuthority:{targetWorkspaceId:workspaceId}}];
    const plan=await prepare(targets);
    await run(plan,async()=>{
      fixture.add("agentRun",{id:"new-run",workspaceId});
      fixture.add("agentStep",{id:"new-step",agentRunId:"new-run"});
      fixture.add("crmProspectWorkspace",{id:"new-prospect",crmWorkspaceId:workspaceId,targetWorkspaceId:workspaceId});
      return "created";
    },targets);
  });
  it("rejects planning from an interactive transaction before any discovery",async()=>{
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:[],ownerBinding:binding,db:tx})).rejects.toMatchObject({code:"SOURCE_LOCK_UNAVAILABLE"});
  });
  it("admits only newborn own captures and exact discovered predicate tuples",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false}}];
    const plan=await prepare(targets);
    await run(plan,async()=>{
      expect(assertSourceCommitEpochCaptureCovered(tx,workspaceId,[{kind:"Action",id:"source"},{kind:"ModulePolicy",id:"finance"},{kind:"BrainArticle",id:"new-output"}]))
        .toEqual([{kind:"BrainArticle",id:"new-output"}]);
      expect(()=>assertSourceCommitEpochCaptureCovered(tx,workspaceId,[{kind:"BrainArticle",id:"unknown-old"}])).toThrow();
      expect(()=>assertSourceCommitEpochCaptureCovered(tx,"ws-b",[{kind:"BrainArticle",id:"new-output"}])).toThrow();
      assertSourceCommitPredicateRowsCovered(tx,"Member",{workspaceId,userId:"alpha"},["member-alpha"]);
      expect(()=>assertSourceCommitPredicateRowsCovered(tx,"Member",{workspaceId,userId:"beta"},["member-alpha"])).toThrow();
      expect(()=>assertSourceCommitPredicateRowsCovered(tx,"Member",{workspaceId,userId:"alpha"},[])).toThrow();
      fixture.add("brainArticle",{id:"new-output",workspaceId,isPrivate:false});return "created";
    },targets);
  });
  it("captures and validates newborn writer epochs while refusing fresh old ancestors",async()=>{
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:"new-output",projectedAuthority:{isPrivate:false}}];
    const plan=await prepare(targets);
    await run(plan,async()=>{
      fixture.add("brainArticle",{id:"new-output",workspaceId,isPrivate:false});
      const capture=await capturePermissionEpochs(tx,workspaceId,[{kind:"BrainArticle",id:"new-output"},{kind:"Action",id:"source"},{kind:"ModulePolicy",id:"finance"}]);
      assertSourceCommitPermissionReadCovered(tx,workspaceId,capture);
      expect(await isArtifactPermissionEpochProofCurrent(workspaceId,capture,tx)).toBe(true);
      expect(()=>assertSourceCommitEpochCovered(tx,workspaceId,capture)).toThrow();
      expect(()=>assertSourceCommitPermissionReadCovered(tx,workspaceId,{...capture,entries:[...capture.entries,{kind:"BrainArticle",id:"old-uncaptured",epoch:"0"}].sort((a,b)=>JSON.stringify([a.kind,a.id]).localeCompare(JSON.stringify([b.kind,b.id])))})).toThrow();
      const changed={...capture,entries:capture.entries.map(entry=>entry.kind==="Action"?{...entry,epoch:String(Number(entry.epoch)+1)}:entry)};
      expect(()=>assertSourceCommitPermissionReadCovered(tx,workspaceId,changed)).toThrow();
      return "created";
    },targets);
  });
  it("initializes only current ambient absence controls and returns no historical input proof",async()=>{
    const before=structuredClone(proof);
    expect(await prepareSourceCommitAmbientFences(alpha,workspaceId,{db:fixture.prisma})).toBeUndefined();
    expect(proof).toEqual(before);
    await expect(prepareSourceCommitAmbientFences(alpha,workspaceId,{db:tx})).rejects.toMatchObject({code:"SOURCE_LOCK_UNAVAILABLE"});
    proof=proof.map(root=>({...root,permissionEpochs:root.permissionEpochs?{...root.permissionEpochs,entries:root.permissionEpochs.entries.filter(entry=>entry.kind!=="Action")}:undefined}));
    await prepareSourceCommitAmbientFences(alpha,workspaceId,{db:fixture.prisma});
    await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("rejects an unplanned newborn or stronger late row lock",async()=>{
    const plan=await prepare();await expect(run(plan,async()=>{
      assertSourceCommitRowCovered(tx,"Action","source","UPDATE");return "bad";
    })).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
    const second=await prepare();await expect(run(second,async()=>{
      assertSourceCommitNewbornEpochAllowed(tx,workspaceId,{kind:"ArtifactInputSnapshot",id:"minted-inside-tx"});return "bad";
    })).rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
  });
  it("denies forged, cloned and replayed plans/attestations",async()=>{
    await expect(run({} as SourceCommitLockPlan)).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    const plan=await prepare();const owner=await prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,plan,binding,async()=>{});
    await expect(withSourceCommitLockPlan(alpha,workspaceId,tx,proof,[],binding,plan,{...owner},async()=>null)).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    await withSourceCommitLockPlan(alpha,workspaceId,tx,proof,[],binding,plan,owner,async()=>null);
    await expect(withSourceCommitLockPlan(alpha,workspaceId,tx,proof,[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
  });
  it("binds exact actor, workspace, roots, owner generation and supplied transaction",async()=>{
    const plan=await prepare();const owner=await prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,plan,binding,async()=>{});
    await expect(withSourceCommitLockPlan(beta,workspaceId,tx,proof,[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(withSourceCommitLockPlan(alpha,"ws-b",tx,proof,[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(withSourceCommitLockPlan(alpha,workspaceId,tx,proof,[],{...binding,generation:2},plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(withSourceCommitLockPlan(alpha,workspaceId,tx,[],[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await expect(withSourceCommitLockPlan(alpha,workspaceId,cloneTx(),proof,[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
  });
  it("rejects a helper's foreign transaction escape while permitting ordinary standalone calls",async()=>{
    expect(()=>assertSourceCommitTransactionCompatible(fixture.prisma)).not.toThrow();
    const plan=await prepare();await run(plan,async()=>{
      expect(()=>assertSourceCommitTransactionCompatible(tx)).not.toThrow();
      expect(()=>assertSourceCommitTransactionCompatible(cloneTx())).toThrow();
      expect(()=>assertSourceCommitTransactionCompatible(fixture.prisma)).toThrow();return "same-transaction";
    });
    expect(()=>assertSourceCommitTransactionCompatible(fixture.prisma)).not.toThrow();
  });
  it("rejects a different backend connection and cannot use the default client as a transaction",async()=>{
    const plan=await prepare();await expect(prepareSourceCommitOwnerAttestation(alpha,workspaceId,fixture.prisma,plan,binding,async()=>{})).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    const owner=await prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,plan,binding,async()=>{});pid=102;
    await expect(withSourceCommitLockPlan(alpha,workspaceId,tx,proof,[],binding,plan,owner,async()=>null)).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
  });
  it("blocks native transport in owner attestation, every execution owner fence, and DB work",async()=>{
    const transport=vi.fn(async()=>"provider");
    const nativeRead=async()=>{assertOutsideArtifactNativeCommitPhase();return transport();};
    const plan=await prepare();
    await expect(prepareSourceCommitOwnerAttestation(alpha,workspaceId,tx,plan,binding,async()=>{await nativeRead();})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    for(const at of [2,3,4]){
      let checks=0;const planned=await prepare(),work=vi.fn(async()=>"written");
      const check=async()=>{if(++checks===at)await nativeRead();};
      await expect(run(planned,work,[],check)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
      expect(work).toHaveBeenCalledTimes(at===4?1:0);
    }
    const planned=await prepare();await expect(run(planned,nativeRead)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    const forbiddenPlan=await prepare();await expect(run(forbiddenPlan,()=>prepare().then(()=>"bad"))).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(transport).not.toHaveBeenCalled();
    // Failed scopes confer no enduring deny phase to the independent outside caller.
    expect(await nativeRead()).toBe("provider");
  });
  it("requires typed nonzero immutable owner generation and preserves owner adapter failures",async()=>{
    await expect(prepareSourceCommitLockPlan(alpha,workspaceId,proof,{writeTargets:[],db:fixture.prisma,ownerBinding:{...binding,generation:0}})).rejects.toMatchObject({code:"SOURCE_OWNER_UNAVAILABLE"});
    const plan=await prepare();await expect(run(plan,async()=>"bad",[],async()=>{throw Object.assign(new Error("Lease lost"),{code:"OWNER_STALE"});})).rejects.toMatchObject({code:"OWNER_STALE"});
  });
  it("rejects unknown source ancestry instead of certifying an old row",async()=>{
    fixture.manifest("Action","source").origin="UNKNOWN";
    await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
    fixture.rows.artifactInputLineage=[];await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("rejects body drift between before-model capture and planning",async()=>{
    source().bodyMd="Changed after generation";await expect(prepare()).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("rejects a replaced manifest head even when body bytes remain identical",async()=>{
    const plan=await prepare();fixture.add("artifactInputLineage",{...fixture.manifest("Action","source"),id:"changed-head",revision:2});
    const work=vi.fn(async()=>"bad");await expect(run(plan,work)).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(work).not.toHaveBeenCalled();
  });
  it("rejects new support authority edges on rewalk without taking their late row lock",async()=>{
    const plan=await prepare();fixture.add("workspaceSupportGrant",{id:"new-support",workspaceId,userId:"alpha",isActive:false,role:"SETUP"});sqlLog=[];
    await expect(run(plan)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(sqlLog.some(query=>query.includes('FROM "WorkspaceSupportGrant"')&&query.includes("FOR SHARE"))).toBe(false);
  });
  it("rejects an original permission transition and restore rather than adopting the latest vector",async()=>{
    const plan=await prepare();epochs.bump(workspaceId,"Action","source");epochs.bump(workspaceId,"Action","source");
    await expect(run(plan)).rejects.toMatchObject({code:"PERMISSION_CHANGED"});
  });
  it("rejects its own permission-trigger transition despite already holding the original epoch lock",async()=>{
    const plan=await prepare();await expect(run(plan,async()=>{epochs.bump(workspaceId,"Action","source");return "bad";})).rejects.toMatchObject({code:"PERMISSION_CHANGED"});
  });
  it("locks current ambient policies without persisting them as historical roots",async()=>{
    const before=structuredClone(proof);const plan=await prepare();epochs.bump(workspaceId,"ModulePolicy","finance");
    await expect(run(plan)).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(proof).toEqual(before);
  });
  it("rejects new governing metadata during work and expires coverage after failure",async()=>{
    const plan=await prepare();await expect(run(plan,async()=>{source().authorUserId="beta";return "bad";})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(hasActiveSourceCommitLockPlan(tx)).toBe(false);expect(()=>assertSourceCommitRowCovered(tx,"Action","source")).toThrow();
  });
  it("denies expired detached source contexts before standalone SQL or proof fallback",async()=>{
    const plan=await prepare();let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    let detached!:Promise<void>;
    await run(plan,async()=>{
      detached=barrier.then(async()=>{
        const before=sqlLog.length;
        await expect(capturePermissionEpochs(tx,workspaceId,[{kind:"Action",id:"unplanned-late-source"}]))
          .rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
        await expect(captureArtifactInputProof(alpha,workspaceId,[{kind:"Action",id:"source"}],tx))
          .rejects.toMatchObject({code:"SOURCE_LOCK_UNCOVERED"});
        expect(sqlLog.length).toBe(before);
      });
      return "completed";
    });
    release();await detached;
  });
  it("does not allow output declassification merely because it adds no new ancestry",async()=>{
    const output=fixture.add("brainArticle",{id:"existing-output",workspaceId,isPrivate:true,ownerMemberId:null,archivedAt:null,title:"Private",bodyMd:"Original private body"});
    const targets:SourceCommitWriteTarget[]=[{kind:"BrainArticle",id:output.id}];
    const plan=await prepare(targets);
    await expect(run(plan,async()=>{output.isPrivate=false;return "bad";},targets)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("counts synthesized snapshot source nodes and predicates in the hard closure budget",async()=>{
    const prior=structuredClone(source());const snapshot=fixture.add("artifactInputSnapshot",{id:"snapshot",workspaceId,sourceKind:"Action",sourceId:"source",
      sourceFingerprint:lineageContentFingerprint("Action",prior),origin:"HUMAN_ORIGINAL",contentJson:prior,accessEnvelopeJson:prior,rootsJson:[],epochProofVersion:1,permissionEpochsJson:proof[0].permissionEpochs});
    proof=[{kind:"ArtifactInputSnapshot",id:snapshot.id,fingerprint:lineageContentFingerprint("ArtifactInputSnapshot",snapshot),permissionEpochs:proof[0].permissionEpochs}];
    await expect(prepare([],12)).rejects.toMatchObject({code:"SOURCE_LOCK_LIMIT"});
  });
  it("refuses a governor missing from original historical vectors",async()=>{
    proof=proof.map(root=>({...root,permissionEpochs:root.permissionEpochs ? {...root.permissionEpochs,entries:root.permissionEpochs.entries.filter(entry=>entry.kind!=="Action")} : undefined}));
    await expect(prepare()).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
});
