import type { AppActor } from "@corgtex/shared";
import { visitSourceReadableRecords } from "./source-scoped-read";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { captureArtifactInputProof, captureArtifactReadHeadObservation, captureReadableWorkItemInputs, mergeLineageInputRoot, readableArtifactIds, withArtifactCountReleaseSnapshot,
  type LineageKind, type LineageRoot } from "./source-lineage";

/** Compact original observations only. Bodies stay in their canonical page. */
export class WorkItemReadRelease {
  private readonly roots = new Map<string, LineageRoot>();
  private readonly heads = new Map<string,string>();
  constructor(private readonly actor: AppActor, private readonly workspaceId: string) {}
  async observeRead<T>(read: () => Promise<T>): Promise<T> {
    const observed = await captureArtifactReadHeadObservation(read);
    for (const [key, stamp] of observed.heads) {
      invariant(!this.heads.has(key) || this.heads.get(key) === stamp, 409, "SOURCE_CHANGED", "Source lineage changed during collection.");
      this.heads.set(key, stamp);
    }
    return observed.value;
  }
  async admit<T extends {id: string}>(kind: "Action" | "Proposal" | "Tension", rows: T[]) {
    const proof = await captureReadableWorkItemInputs(this.actor, this.workspaceId, kind, rows);
    this.add(proof.roots);
    for (const [key,stamp] of proof.heads) {
      invariant(!this.heads.has(key) || this.heads.get(key) === stamp,409,"SOURCE_CHANGED","Work item lineage changed during collection.");
      this.heads.set(key,stamp);
    }
    return rows.filter(row => proof.ids.has(row.id));
  }
  async observe<T extends {id: string}>(kind: LineageKind, rows: T[]) {
    if (!rows.length) return;
    for (let offset=0;offset<rows.length;offset+=100) {
      if (kind === "Action" || kind === "Proposal" || kind === "Tension") {
        const page = rows.slice(offset,offset+100);
        const admitted = await this.admit(kind,page);
        invariant(admitted.length === page.length,409,"SOURCE_CHANGED","A selected work item changed before release.");
        continue;
      }
      const proof = await this.observeRead(() => captureArtifactInputProof(this.actor, this.workspaceId,
        rows.slice(offset,offset+100).map(row => ({kind, id: row.id, snapshot: row}))));
      this.add(proof);
    }
  }
  add(proof: readonly LineageRoot[]) {
    for (const root of proof) {
      const key = `${root.kind}:${root.id}`;
      this.roots.set(key, mergeLineageInputRoot(this.roots.get(key), root));
    }
  }
  async has<T extends {id: string}>(kind: LineageKind, load: (afterId: string | undefined, take: number) => Promise<T[]>) {
    let found=false;
    await visitSourceReadableRecords({actor:this.actor,workspaceId:this.workspaceId,kind,load,
      visit:async rows=>{ if(!rows.length) return; await this.observe(kind,[rows[0]]);found=true;return false; }});
    return found;
  }
  finish<T>(value: T) {
    return withArtifactCountReleaseSnapshot(this.actor, this.workspaceId, [...this.roots.values()],
      async () => {}, async tx => {
        await requireWorkspaceMembership({actor: this.actor, workspaceId: this.workspaceId, tx});
        return value;
      }, this.heads);
  }
}

export type WorkItemPosition = { id: string; title: string; priority: number; createdAt: Date };
export function workItemAfter(row: WorkItemPosition, sort?: string) {
  const date = [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }];
  if (sort === "date") return { OR: date };
  if (sort === "created_asc") return {OR:[{createdAt:{gt:row.createdAt}},{createdAt:row.createdAt,id:{gt:row.id}}]};
  if (sort === "alpha") return { OR: [{ title: { gt: row.title } }, ...date.map(after => ({ title: row.title, ...after }))] };
  return { OR: [{ priority: { lt: row.priority } }, ...date.map(after => ({ priority: row.priority, ...after }))] };
}

/** Canonical, sorted keyset pages; the corpus is never retained for a total. */
export async function readableWorkItemPage<T extends WorkItemPosition>(params: {
  actor: AppActor; workspaceId: string; kind: "Action" | "Proposal" | "Tension";
  take: number; skip: number; release: WorkItemReadRelease;
  load: (after: T | undefined) => Promise<T[]>;
  admit?: (row: T) => Promise<boolean>;
}) {
  invariant(Number.isSafeInteger(params.take) && params.take >= 0 && params.take <= 5000
    && Number.isSafeInteger(params.skip) && params.skip >= 0,400,"INVALID_INPUT","Work item pagination is invalid.");
  let after: T | undefined;
  let total=0;
  const items:T[]=[];
  for (;;) {
    const rows=await params.load(after);
    invariant(rows.length <= 100 && (!rows.length || rows.at(-1)!.id !== after?.id),503,"SOURCE_READ_SCAN_CHANGED","Source page changed; retry.");
    const next=rows.at(-1);
    const readable = params.admit
      ? await readableArtifactIds(params.actor,params.workspaceId,params.kind,rows)
      : new Set((await params.release.admit(params.kind,rows)).map(row => row.id));
    const admitted:T[]=[];
    for(const row of rows) {
      if(!readable.has(row.id) || params.admit && !await params.admit(row)) continue;
      admitted.push(row);
      if(total >= params.skip && items.length < params.take) items.push(row);
      total++;
    }
    if (params.admit) await params.release.observe(params.kind,admitted);
    if(rows.length<100) break;
    after=next;
  }
  const current=await readableArtifactIds(params.actor,params.workspaceId,params.kind,items);
  return {items:items.filter(row=>current.has(row.id)),total:total-items.filter(row=>!current.has(row.id)).length};
}

/** Permission-filtered rank cannot use a raw SQL relation count. Keep at most
 * 100 ranked canonical rows per window; deep offsets trade repeated scans for
 * bounded memory. No corpus-sized rank or body array is retained. */
export async function rankedReadableTensionPage<T extends WorkItemPosition>(params: {
  actor:AppActor; workspaceId:string; take:number; skip:number; release: WorkItemReadRelease;
  load:(afterId:string|undefined)=>Promise<T[]>;
  votes:(row:T)=>Promise<number>;
}) {
  invariant(Number.isSafeInteger(params.take) && params.take>=0 && params.take<=5000
    && Number.isSafeInteger(params.skip) && params.skip>=0,400,"INVALID_INPUT","Work item pagination is invalid.");
  type Ranked={row:T;votes:number};
  const compare=(a:Ranked,b:Ranked)=>(b.row.priority??0)-(a.row.priority??0) || b.votes-a.votes
    || (b.row.createdAt?.getTime()??0)-(a.row.createdAt?.getTime()??0) || b.row.id.localeCompare(a.row.id);
  const items:T[]=[];
  let boundary:Ranked|undefined,total=0,remainingSkip=params.skip,first=true;
  for(;;) {
    const window:Ranked[]=[];
    let afterId:string|undefined;
    for(;;) {
      const rows=await params.load(afterId);
      invariant(rows.length<=100,503,"SOURCE_READ_SCAN_CHANGED","Source page changed; retry.");
      const readable=new Set((await params.release.admit("Tension",rows)).map(row => row.id));
      for(const row of rows) {
        invariant(!afterId || row.id>afterId,503,"SOURCE_READ_SCAN_CHANGED","Source page changed; retry.");
        if(!readable.has(row.id)) continue;
        if(first) total++;
        if(params.take===0) continue;
        const ranked={row,votes:await params.votes(row)};
        if(boundary && compare(ranked,boundary)<=0) continue;
        window.push(ranked);window.sort(compare);
        if(window.length>100) window.pop();
      }
      if(rows.length<100) break;
      afterId=rows.at(-1)!.id;
    }
    first=false;
    if(!window.length) break;
    const skip=Math.min(remainingSkip,window.length);remainingSkip-=skip;
    for(const candidate of window.slice(skip)) if(items.length<params.take) items.push(candidate.row);
    if(items.length===params.take || window.length<100) break;
    boundary=window.at(-1);
  }
  const current=await readableArtifactIds(params.actor,params.workspaceId,"Tension",items);
  return {items:items.filter(row=>current.has(row.id)),total:total-items.filter(row=>!current.has(row.id)).length};
}
