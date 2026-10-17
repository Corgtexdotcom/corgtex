import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "../../../../../../../packages/domain/src/errors";
const { findMany, sourceFindMany, finish, capturePage, captureInput } = vi.hoisted(() => ({findMany:vi.fn(),sourceFindMany:vi.fn(),finish:vi.fn(),capturePage:vi.fn(),captureInput:vi.fn()}));
vi.mock("@corgtex/shared",()=>({prisma:{brainArticle:{findMany},brainSource:{findMany:sourceFindMany}}}));
vi.mock("../../../../../../../packages/domain/src/auth",()=>({requireWorkspaceMembership:async()=>({id:"member"})}));
vi.mock("../../../../../../../packages/domain/src/source-lineage",()=>({
  captureReadableWorkItemInputs:async (_a:unknown,_w:string,kind:string,rows:Array<{id:string}>)=>{
    await capturePage(kind, rows);
    const admitted=rows.filter(row=>Number(row.id)%2===0);
    return {ids:new Set(admitted.map(row=>row.id)),roots:admitted.map(row=>({kind,id:row.id,fingerprint:"a".repeat(64)})),heads:new Map()};
  },
  captureArtifactInputProof:async (_a:unknown,_w:string,inputs:Array<{kind:string;id:string}>)=>{
    await captureInput(inputs);
    if(Number(inputs[0].id)%2===1)throw new AppError(409,"UNKNOWN_LINEAGE","Unproved");
    return [{...inputs[0],fingerprint:"a".repeat(64)}];
  },
  captureArtifactReadHeadObservation:async(read:()=>Promise<unknown>)=>({value:await read(),heads:new Map()}),
  mergeLineageInputRoot:(_p:unknown,r:unknown)=>r,
  withArtifactCountReleaseSnapshot:async(_a:unknown,_w:string,roots:unknown,_r:unknown,done:(tx:unknown)=>Promise<unknown>)=>{await finish(roots);return done({});},
}));
vi.mock("@corgtex/domain",async()=>({...await import("../../../../../../../packages/domain/src/digest-lineage"),requireWorkspaceMembership:async()=>({id:"member"}),resolveKnowledgeAccessDomains:async()=>["WORKSPACE"]}));
import { listBrainArticleTypeCounts, listBrainPendingSourceCount } from "./article-type-counts";
const params={actor:{kind:"user",user:{id:"user"}} as any,workspaceId:"ws",membership:{id:"member",role:"CONTRIBUTOR"}};
beforeEach(()=>{vi.clearAllMocks();finish.mockReset();capturePage.mockReset();captureInput.mockReset();});
it("bounds Brain count windows to200raw candidates while retaining permitted type contributions",async()=>{
  const rows=Array.from({length:5001},(_,i)=>({id:String(i).padStart(5,"0"),type:i%4===0?"PROJECT":"STRATEGY",bodyMd:"body"}));
  findMany.mockImplementation(async args=>{
    expect(args.take).toBe(200);expect(args.orderBy).toEqual({id:"asc"});
    const after=args.where.AND[0].id?.gt;
    return rows.filter(row=>!after||row.id>after).slice(0,args.take);
  });
  expect(await listBrainArticleTypeCounts(params)).toEqual({counts:[{type:"PROJECT",count:50},{type:"STRATEGY",count:50}],complete:false});
  expect(findMany).toHaveBeenCalledOnce();expect(capturePage).toHaveBeenCalledTimes(2);
  expect(finish.mock.calls[0][0]).toHaveLength(100);
});
it("does not claim global absence after a hidden-only Brain count window",async()=>{
  findMany.mockImplementation(async args=>Array.from({length:args.take},(_,i)=>({id:String((args.where.AND[0].id?.gt?201:1)+2*i),type:"PROJECT"})));
  expect(await listBrainArticleTypeCounts(params)).toEqual({counts:[],complete:false});
  expect(findMany).toHaveBeenCalledOnce();expect(finish).toHaveBeenCalledOnce();
});
it("returns exact type totals for an exhausted small window with the existing visibility filter",async()=>{
  findMany.mockResolvedValue([{id:"2",type:"PROJECT"},{id:"4",type:"STRATEGY"},{id:"5",type:"PROJECT"}]);
  expect(await listBrainArticleTypeCounts(params)).toEqual({counts:[{type:"PROJECT",count:1},{type:"STRATEGY",count:1}],complete:true});
  expect(findMany.mock.calls[0][0].where.AND[1]).toEqual({OR:[{isPrivate:false},{isPrivate:true,ownerMemberId:"member"}]});
});
it("withholds a count when original proof authority is withdrawn before final release",async()=>{
  findMany.mockResolvedValue([{id:"2",type:"PROJECT"}]);finish.mockRejectedValue(new AppError(409,"SOURCE_CHANGED","Original authority changed"));
  await expect(listBrainArticleTypeCounts(params)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
it("bounds pending-source counts, preserves access domains and replays their original proofs",async()=>{
  sourceFindMany.mockImplementation(async args=>Array.from({length:args.take},(_,i)=>({id:String((args.where.id?.gt?200:0)+i).padStart(5,"0")})));
  expect(await listBrainPendingSourceCount(params)).toEqual({count:100,complete:false});
  expect(sourceFindMany).toHaveBeenCalledOnce();
  expect(sourceFindMany.mock.calls[0][0].where).toMatchObject({workspaceId:"ws",accessDomain:{in:["WORKSPACE"]},archivedAt:null,absorbedAt:null});
  expect(finish).toHaveBeenCalledOnce();
});

it.each(["articles","sources"] as const)("enumerates one fixed %s window when inserts straddle the admission cursor",async kind=>{
  const rows=Array.from({length:150},(_,i)=>({id:String(100+i*2).padStart(5,"0"),type:"PROJECT"}));
  const query=kind==="articles"?findMany:sourceFindMany;
  query.mockImplementation(async args=>{
    const after=kind==="articles"?args.where.AND[0].id?.gt:args.where.id?.gt;
    return rows.filter(row=>!after||row.id>after).slice(0,args.take);
  });
  let changed=false;
  const mutate=()=>{if(!changed){changed=true;rows.unshift({id:"00098",type:"PROJECT"});rows.push({id:"00400",type:"PROJECT"});}};
  (kind==="articles"?capturePage:captureInput).mockImplementation(mutate);
  const result=kind==="articles"?await listBrainArticleTypeCounts(params):await listBrainPendingSourceCount(params);
  expect(rows).toHaveLength(152);
  expect(result).toEqual(kind==="articles"?{counts:[{type:"PROJECT",count:150}],complete:true}:{count:150,complete:true});
  expect(query).toHaveBeenCalledOnce();
  if(kind==="articles")expect(capturePage.mock.calls.map(([,batch])=>batch.length)).toEqual([100,50]);
});
