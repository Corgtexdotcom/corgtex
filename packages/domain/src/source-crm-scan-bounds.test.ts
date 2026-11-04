import { beforeEach, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const probe = vi.hoisted(() => ({ admissions: [] as number[], finish: vi.fn(async (value: unknown) => value) }));
vi.mock("@corgtex/shared", () => ({ prisma: {} }));
vi.mock("./digest-lineage", () => ({ DigestReadRelease: class {
  async captureSourcePage(_kind: string, records: {id: string}[]) { probe.admissions.push(records.length); return { records }; }
  finish(value: unknown) { return probe.finish(value); }
} }));
vi.mock("./source-lineage", () => ({ readableArtifactIds: vi.fn(async (_actor, _workspace, _kind, rows: {id: string}[]) => {
  probe.admissions.push(rows.length); return new Set(rows.map(row => row.id));
}) }));
vi.mock("./auth", () => ({}));
vi.mock("./crm-direct-original-read", () => ({}));
import { scanSourceReadableRecords, countSourceReadableRecords, hasSourceReadableRecord } from "./source-scoped-read";
import { readCrmPage, readCrmRows, readCrmSample } from "./crm-lineage";
const actor = { kind: "user", user: { id: "reader" } } as AppActor;
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m-${String(i).padStart(5, "0")}` }));
beforeEach(() => { probe.admissions.length = 0; vi.clearAllMocks(); });
it("source exact collection uses one candidate snapshot despite insertions around the cursor", async () => {
  const data = rows(150);
  const load = vi.fn(async (after: string | undefined, take: number) => {
    const result = data.filter(row => !after || row.id > after).slice(0, take);
    if (load.mock.calls.length === 1) data.push({id: "a-new"}, {id: "z-new"});
    data.sort((a,b) => a.id.localeCompare(b.id));
    return result;
  });
  expect(await scanSourceReadableRecords({actor, workspaceId: "ws", kind: "Document", load})).toHaveLength(150);
  expect(load).toHaveBeenCalledExactlyOnceWith(undefined, 10001);
  expect(probe.admissions).toEqual([100, 50]);
});
it.each([10000, 10001])("source exact enumeration has an explicit %i-row boundary", async count => {
  const data = rows(count), load = vi.fn(async (after: string | undefined, take: number) => data.filter(row => !after || row.id > after).slice(0,take));
  const result = scanSourceReadableRecords({actor,workspaceId:"ws",kind:"Document",load});
  if(count===10000) expect(await result).toHaveLength(count);
  else { await expect(result).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"}); expect(probe.admissions).toEqual([]); }
  expect(load).toHaveBeenCalledTimes(1);
  expect(probe.admissions.every(count => count<=100)).toBe(true);
});
it("source count and existence retain a final proof release", async () => {
  const load = vi.fn(async () => rows(1));
  expect(await countSourceReadableRecords({actor,workspaceId:"ws",kind:"Document",load})).toBe(1);
  expect(await hasSourceReadableRecord({actor,workspaceId:"ws",kind:"Document",load})).toBe(true);
  expect(probe.finish).toHaveBeenCalledTimes(2);
});
it("CRM totals and selected page share one enumeration despite reordered/inserted candidates", async () => {
  const data = rows(150);
  const fetch = vi.fn(async (page: {take:number;cursor?:{id:string};skip?:number}) => {
    const start = page.cursor ? data.findIndex(row=>row.id===page.cursor!.id)+(page.skip??0) : 0;
    const result = data.slice(start,start+page.take);
    if(fetch.mock.calls.length===1) { data.unshift({id:"a-new"}); data.push({id:"z-new"}); }
    return result;
  });
  expect(await readCrmPage(actor,"ws","CrmAccount",fetch,{take:1,skip:149})).toEqual({items:[{id:"m-00149"}],total:150,take:1,skip:149});
  expect(fetch).toHaveBeenCalledExactlyOnceWith({take:10001});
  expect(probe.admissions).toEqual([100,50]);
});
it.each([10000,10001])("CRM exact arrays enforce the %i-row boundary before partial output",async count=>{
  const data=rows(count),fetch=vi.fn(async(page:{take:number;cursor?:{id:string};skip?:number})=>{
    const start=page.cursor?data.findIndex(row=>row.id===page.cursor!.id)+(page.skip??0):0;
    return data.slice(start,start+page.take);
  });
  const result=readCrmRows(actor,"ws","CrmAccount",fetch);
  if(count===10000)expect(await result).toHaveLength(count);
  else {await expect(result).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});expect(probe.admissions).toEqual([]);}
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(probe.admissions.every(count=>count<=100)).toBe(true);
});
it("a fulfilled CRM sample does not require an exact corpus total",async()=>{
  const fetch=vi.fn(async()=>rows(10001));
  expect(await readCrmSample(actor,"ws","CrmAccount",fetch,1)).toEqual([{id:"m-00000"}]);
  expect(fetch).toHaveBeenCalledTimes(1);expect(probe.admissions).toEqual([100]);
});
