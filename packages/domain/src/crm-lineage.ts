import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { captureArtifactInputProof, captureArtifactReadHeadObservation, captureReadableWorkItemInputs,
  mergeLineageInputRoot, readableArtifactIds, withArtifactCountReleaseSnapshot, type LineageInput, type LineageRoot } from "./source-lineage";
import { requireWorkspaceMembership } from "./auth";
import { admitCrmDirectOriginalRows, assertCrmDirectReadCurrent, discardCrmDirectReadProjections, trackCrmDirectOrdinaryRows, type CrmDirectReadSession } from "./crm-direct-original-read";

export type CrmReadPage = { take: number; cursor?: { id: string }; skip?: number };
const CRM_READ_BATCH_SIZE = 100;
const CRM_OUTPUT_PAGE_LIMIT = 5_000;
class CrmReadRelease {
  active=true;
  readonly roots = new Map<string,LineageRoot>();
  readonly heads = new Map<string,string>();
  constructor(readonly actor:AppActor,readonly workspaceId:string) {}
  add(roots: readonly LineageRoot[], heads: ReadonlyMap<string,string> = new Map()) {
    for (const root of roots) {
      const key=JSON.stringify([root.kind,root.id]);
      this.roots.set(key,mergeLineageInputRoot(this.roots.get(key),root));
    }
    for (const [key,stamp] of heads) {
      invariant(!this.heads.has(key)||this.heads.get(key)===stamp,409,"SOURCE_CHANGED","CRM lineage changed during collection.");
      this.heads.set(key,stamp);
    }
  }
  async observe<T>(read:()=>Promise<T>) {
    const observed=await captureArtifactReadHeadObservation(read);
    this.add([],observed.heads);
    return observed.value;
  }
  async admit<T extends {id:string}>(kind:LineageInput["kind"],rows:T[],tx:Prisma.TransactionClient) {
    if(tx===prisma && ["CrmAccount","CrmContact","CrmActivity","CrmDeal"].includes(kind)) {
      const captured=await this.observe(()=>captureReadableWorkItemInputs(this.actor,this.workspaceId,kind as "CrmAccount"|"CrmContact"|"CrmActivity"|"CrmDeal",rows));
      this.add(captured.roots,captured.heads);
      return rows.filter(row=>captured.ids.has(row.id));
    }
    const readable=await this.observe(()=>readableArtifactIds(this.actor,this.workspaceId,kind,rows,tx));
    const admitted=rows.filter(row=>readable.has(row.id));
    if(admitted.length) this.add(await this.observe(()=>captureArtifactInputProof(this.actor,this.workspaceId,
      admitted.map(row=>({kind,id:row.id,snapshot:row})),tx)));
    return admitted;
  }
  finish<T>(value:T) {
    return withArtifactCountReleaseSnapshot(this.actor,this.workspaceId,[...this.roots.values()],async()=>{},async tx=>{
      await requireWorkspaceMembership({actor:this.actor,workspaceId:this.workspaceId,tx});
      return value;
    },this.heads);
  }
}
const crmReadRelease=new AsyncLocalStorage<CrmReadRelease>();
/** One original-observation ledger across a list/detail and every awaited join. */
export async function withCrmReadSnapshot<T>(actor:AppActor,workspaceId:string,read:()=>Promise<T>):Promise<T> {
  const inherited=crmReadRelease.getStore();
  if(inherited) {
    invariant(inherited.active&&inherited.actor===actor&&inherited.workspaceId===workspaceId,409,"SOURCE_CHANGED","CRM reader changed.");
    return read();
  }
  const release=new CrmReadRelease(actor,workspaceId);
  return crmReadRelease.run(release,async()=>{try{return await release.finish(await read());}finally{release.active=false;}});
}
export async function observeCrmReadRows<T extends {id:string}>(actor:AppActor,workspaceId:string,kind:LineageInput["kind"],rows:T[]) {
  const release=crmReadRelease.getStore();
  if(release) {
    invariant(release.active&&release.actor===actor&&release.workspaceId===workspaceId,409,"SOURCE_CHANGED","CRM reader changed.");
    return release.admit(kind,rows,prisma);
  }
  const readable=await readableArtifactIds(actor,workspaceId,kind,rows);
  return rows.filter(row=>readable.has(row.id));
}

type Selection<T> = {take:number;skip?:number;count?:boolean;admit?:(rows:T[])=>Promise<T[]>};
/** Hydrate only canonical pages. Exact totals retain compact original proofs,
 * while bodies outside the requested output page are discarded immediately. */
export async function readCrmPage<T extends {id:string}>(actor:AppActor,workspaceId:string,
  kind:LineageInput["kind"],fetch:(page:CrmReadPage)=>Promise<T[]>,selection:Selection<T>,
  tx:Prisma.TransactionClient=prisma,direct?:CrmDirectReadSession) {
  const take=selection.take,skip=selection.skip??0;
  invariant(Number.isSafeInteger(take)&&take>=0&&take<=CRM_OUTPUT_PAGE_LIMIT&&Number.isSafeInteger(skip)&&skip>=0,
    400,"INVALID_INPUT","CRM pagination is invalid.");
  const items:T[]=[];
  let total=0,cursor:{id:string}|undefined;
  const seen=new Set<string>();
  const release=crmReadRelease.getStore();
  invariant(!release||release.active&&release.actor===actor&&release.workspaceId===workspaceId,409,"SOURCE_CHANGED","CRM reader changed.");
  for(;;) {
    const rows=await fetch({take:CRM_READ_BATCH_SIZE,...(cursor?{cursor,skip:1}:{})});
    invariant(rows.length<=CRM_READ_BATCH_SIZE,409,"SOURCE_CHANGED","CRM query returned an invalid page.");
    const fresh=rows.filter(row=>!seen.has(row.id));
    fresh.forEach(row=>seen.add(row.id));
    const originals=direct?await admitCrmDirectOriginalRows(direct,kind,fresh,tx):[];
    const originalIds=new Set(originals.map(row=>row.id));
    const rest=fresh.filter(row=>!originalIds.has(row.id));
    const permitted=release&&selection.count!==false?await release.admit(kind,rest,tx):[];
    if(!release||selection.count===false) {
      const readable=await readableArtifactIds(actor,workspaceId,kind,rest,tx);
      permitted.push(...rest.filter(row=>readable.has(row.id)));
    }
    if(direct&&permitted.length) await trackCrmDirectOrdinaryRows(direct,kind,permitted,
      await captureArtifactInputProof(actor,workspaceId,permitted.map(row=>({kind,id:row.id,snapshot:row})),tx),tx);
    const byId=new Map([...permitted,...originals].map(row=>[row.id,row]));
    let admitted=fresh.flatMap(row=>byId.has(row.id)?[byId.get(row.id)!]:[]);
    if(selection.admit) admitted=await selection.admit(admitted);
    const selected:T[]=[];
    for(const row of admitted) {
      if(total>=skip&&items.length<take){items.push(row);selected.push(row);}
      total++;
    }
    if(release&&selection.count===false&&selected.length) {
      const captured=await release.admit(kind,selected,tx);
      invariant(captured.length===selected.length,409,"SOURCE_CHANGED","A selected CRM record changed during admission.");
    }
    if(direct)discardCrmDirectReadProjections(direct,originals.filter(row=>!selected.includes(row)));
    if(rows.length<CRM_READ_BATCH_SIZE||selection.count===false&&items.length===take)break;
    const next=rows.at(-1)!;
    invariant(next.id!==cursor?.id&&fresh.length>0,409,"SOURCE_CHANGED","CRM records changed while reading.");
    cursor={id:next.id};
  }
  if(direct)await assertCrmDirectReadCurrent(direct,tx);
  return {items,total,take,skip};
}

export async function readCrmCount<T extends {id:string}>(actor:AppActor,workspaceId:string,
  kind:LineageInput["kind"],fetch:(page:CrmReadPage)=>Promise<T[]>) {
  return (await readCrmPage(actor,workspaceId,kind,fetch,{take:0})).total;
}
export async function readCrmSample<T extends {id:string}>(actor:AppActor,workspaceId:string,
  kind:LineageInput["kind"],fetch:(page:CrmReadPage)=>Promise<T[]>,take:number) {
  return (await readCrmPage(actor,workspaceId,kind,fetch,{take,count:false})).items;
}

/** Complete-return APIs may retain every returned body, but never an unrelated corpus. */
export async function readCrmRows<T extends {id:string}>(actor:AppActor,workspaceId:string,
  kind:LineageInput["kind"],fetch:(page:CrmReadPage)=>Promise<T[]>,tx:Prisma.TransactionClient=prisma,direct?:CrmDirectReadSession) {
  const rows:T[]=[];
  await readCrmPage(actor,workspaceId,kind,fetch,{take:0,admit:async page=>{rows.push(...page);return page;}},tx,direct);
  return rows;
}
export function crmPage<T>(rows:T[],take:number,skip:number) {
  invariant(Number.isSafeInteger(take)&&take>=0&&take<=CRM_OUTPUT_PAGE_LIMIT&&Number.isSafeInteger(skip)&&skip>=0,
    400,"INVALID_INPUT","CRM pagination is invalid.");
  return {items:rows.slice(skip,skip+take),total:rows.length,take,skip};
}
