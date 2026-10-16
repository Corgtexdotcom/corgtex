import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AppError } from "../../../../../../../packages/domain/src/errors";
const { findMany, finish, capturePage } = vi.hoisted(() => ({findMany:vi.fn(),finish:vi.fn(),capturePage:vi.fn()}));
vi.mock("@corgtex/shared",()=>({prisma:{brainArticle:{findMany}}}));
vi.mock("../../../../../../../packages/domain/src/auth",()=>({requireWorkspaceMembership:async()=>({id:"member"})}));
vi.mock("../../../../../../../packages/domain/src/source-lineage",()=>({
  captureReadableWorkItemInputs:async (_a:unknown,_w:string,kind:string,rows:Array<{id:string}>)=>{
    capturePage(kind, rows);
    const admitted=rows.filter(row=>Number(row.id)%2===0);
    return {ids:new Set(admitted.map(row=>row.id)),roots:admitted.map(row=>({kind,id:row.id,fingerprint:"a".repeat(64)})),heads:new Map()};
  },
  captureArtifactInputProof:async (_a:unknown,_w:string,inputs:Array<{kind:string;id:string}>)=>{
    if(Number(inputs[0].id)%2===1)throw new AppError(409,"UNKNOWN_LINEAGE","Unproved");
    return [{...inputs[0],fingerprint:"a".repeat(64)}];
  },
  captureArtifactReadHeadObservation:async(read:()=>Promise<unknown>)=>({value:await read(),heads:new Map()}),
  mergeLineageInputRoot:(_p:unknown,r:unknown)=>r,
  withArtifactCountReleaseSnapshot:async(_a:unknown,_w:string,roots:unknown,_r:unknown,done:(tx:unknown)=>Promise<unknown>)=>{await finish(roots);return done({});},
}));
vi.mock("@corgtex/domain",async()=>({...await import("../../../../../../../packages/domain/src/digest-lineage"),requireWorkspaceMembership:async()=>({id:"member"})}));
import { listBrainArticleTypeCounts } from "./article-type-counts";
beforeEach(()=>vi.clearAllMocks());
it("the actual Brain page folds every permitted type beyond5000 in100-row hydration pages",async()=>{
  const rows=Array.from({length:5001},(_,i)=>({id:String(i).padStart(5,"0"),type:i%4===0?"PROJECT":"STRATEGY",bodyMd:"body"}));
  findMany.mockImplementation(async args=>{
    expect(args.take).toBe(100);expect(args.orderBy).toEqual({id:"asc"});
    const after=args.where.AND[0].id?.gt;
    return rows.filter(row=>!after||row.id>after).slice(0,args.take);
  });
  const result=await listBrainArticleTypeCounts({actor:{kind:"user",user:{id:"user"}} as any,workspaceId:"ws",membership:{id:"member",role:"CONTRIBUTOR"}});
  expect(result).toEqual([{type:"PROJECT",count:1251},{type:"STRATEGY",count:1250}]);
  expect(findMany).toHaveBeenCalledTimes(51);
  expect(capturePage).toHaveBeenCalledTimes(51);
  expect(capturePage.mock.calls.every(([kind, rows])=>kind === "BrainArticle" && rows.length <= 100)).toBe(true);
  expect(finish.mock.calls[0][0]).toHaveLength(2501);
  const page=readFileSync(new URL("./page.tsx",import.meta.url),"utf8");
  expect(page).toContain('import { brainArticleVisibility, listBrainArticleTypeCounts } from "./article-type-counts"');
  expect(page).toContain("listBrainArticleTypeCounts({ workspaceId, actor, membership })");
});
