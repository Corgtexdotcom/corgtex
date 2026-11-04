import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const f = vi.hoisted(() => ({actor:{kind:"user",user:{id:"reader"}},auth:vi.fn(),feature:vi.fn(),accounts:vi.fn(),contacts:vi.fn(),deals:vi.fn(),activities:vi.fn(),serialize:vi.fn(),origin:undefined as any,order:[] as string[]}));
vi.mock("@/lib/auth",()=>({resolveRequestActor:f.auth}));
vi.mock("@/lib/workspace-feature-flags",()=>({requireWorkspaceFeature:f.feature}));
vi.mock("@corgtex/shared",()=>({getMcpOrigin:()=>f.origin}));
vi.mock("@corgtex/domain",async()=>({AppError:(await import("../../../../../../../../packages/domain/src/errors")).AppError,listCrmAccounts:f.accounts,listContacts:f.contacts,listDeals:f.deals,listCrmActivities:f.activities}));
vi.mock("../../../../../../../../packages/domain/src/crm-direct-original-read",()=>({serializeCrmDirectReadResult:f.serialize}));
vi.mock("@/lib/http",()=>({handleRouteError:(error:any)=>Response.json({error:error.code??"INVALID_INPUT"},{status:error.status??500})}));
import { AppError } from "../../../../../../../../packages/domain/src/errors";
import { GET } from "./route";
function request(query:string,workspace="ws") {return GET(new NextRequest(`http://localhost/api/workspaces/${workspace}/leads/archive?${query}`),{params:Promise.resolve({workspaceId:workspace})});}
beforeEach(()=>{vi.resetAllMocks();f.origin=undefined;f.order=[];f.auth.mockResolvedValue(f.actor);f.feature.mockResolvedValue(undefined);for(const read of [f.accounts,f.contacts,f.deals,f.activities])read.mockImplementation(async()=>{f.order.push("read");return {items:[],total:0,take:50,skip:0};});f.serialize.mockImplementation(async(_actor,result)=>{f.order.push("final-delivery");return JSON.stringify(result);});});
describe("CRM native archive presentation HTTP composition",()=>{
  it.each([["accounts",f.accounts],["contacts",f.contacts],["deals",f.deals],["activities",f.activities]] as const)("serializes the exact %s result at delivery without another read",async(family,read)=>{
    const result={items:[{id:"original",title:"Proven original",archiveReason:null}],total:1,take:7,skip:2};read.mockResolvedValue(result);
    const response=await request(`family=${family}&archiveFilter=all&take=7&skip=2`);
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("content-type")).toContain("application/json");
    expect(read).toHaveBeenCalledWith(f.actor,"ws",{archiveFilter:"all",take:7,skip:2});expect(f.serialize).toHaveBeenCalledWith(f.actor,result);expect(f.feature).toHaveBeenCalledWith("ws","RELATIONSHIPS");
    expect(await response.json()).toEqual(result);expect(f.order.at(-1)).toBe("final-delivery");
  });
  it.each(["", "family=private", "family=accounts&archiveFilter=active", "family=accounts&take=5001", "family=accounts&take=nope", "family=accounts&take=1.5", "family=accounts&skip=-1", "family=accounts&skip=5001", "family=accounts&skip=nope"])("rejects unsupported presentation input %s",async query=>{
    const response = await request(query); expect(response.status).toBe(400); expect(await response.json()).toEqual({error:"VALIDATION_ERROR"}); for (const read of [f.accounts,f.contacts,f.deals,f.activities]) expect(read).not.toHaveBeenCalled(); expect(f.feature).not.toHaveBeenCalled(); expect(f.serialize).not.toHaveBeenCalled();
  });
  it("returns no body when source or membership revokes before final serialization",async()=>{
    f.serialize.mockRejectedValue(new AppError(409,"SOURCE_CHANGED","changed"));const response=await request("family=accounts");
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"SOURCE_CHANGED"});
  });
  it("does not substitute authority for outsider or cross-workspace failures",async()=>{
    f.accounts.mockRejectedValue(new AppError(403,"NOT_A_MEMBER","outsider"));expect((await request("family=accounts","foreign")).status).toBe(403);expect(f.serialize).not.toHaveBeenCalled();
  });
  it("rejects changed ambient origin before any native body reader",async()=>{
    f.feature.mockImplementation(async()=>{f.origin={kind:"oauth",id:"changed",workspaceId:"ws",scopeHash:"new",grantEpoch:"1"};});
    expect((await request("family=accounts")).status).toBe(403);expect(f.accounts).not.toHaveBeenCalled();expect(f.serialize).not.toHaveBeenCalled();
  });
  it("preserves an authority-filtered empty result without inventing hidden counts or bodies",async()=>{
    const response=await request("family=activities");expect(await response.json()).toMatchObject({items:[],total:0});expect(f.serialize).toHaveBeenCalledWith(f.actor,expect.objectContaining({items:[],total:0}));
  });
});
