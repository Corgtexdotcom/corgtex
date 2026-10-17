import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import type { ArtifactStructuralAuthority } from "./artifact-structural-authority";
import type { LineageInput, LineageKind, LineageRoot } from "./source-lineage";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { getExternalProviderWorkerPurpose } from "./external-provider-principal";
import { getTranscriptSourceImportPurpose, getRecorderTranscriptWorkerPurpose, getAudioTranscriptWorkerPurpose } from "./native-transcript-principal";
import { invariant } from "./errors";
import { CATEGORY_BOUND_SOURCE_KINDS } from "./information-category-policy";
import { assertOutsideArtifactNativeCommitPhase, withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, mergePermissionEpochProofs, parsePermissionEpochProof, type PermissionEpochIdentity, type PermissionEpochProof } from "./source-permission-epochs";
import { authorityIdentity, authorityRecord, discoverAmbientSourceAuthority, discoverSourceAuthorityEdges,
  loadSourceAuthorityRecord, sourceAuthorityDelegate, sourceAuthorityDescriptor, sourceAuthorityPhysicalRow,
  SOURCE_AUTHORITY_REGISTRY, SOURCE_AUTHORITY_TABLES,
  type SourceAuthorityBudget, type SourceAuthorityClient, type SourceAuthorityEdges, type SourceAuthorityRow } from "./source-authority-edges";

export type SourceCommitOwnerBinding = Readonly<{ kind: "WORKFLOW_JOB" | "AGENT_RUN" | "CONVERSATION_GENERATION" | "HUMAN_REQUEST" | "RECORDER_TRANSCRIPT" | "TRANSCRIPT_SOURCE_IMPORT";
  id: string; generation: number; [key: string]: unknown }>;
export type SourceCommitWriteTarget = LineageInput & { /** Declare changed governing bindings BEFORE opening the transaction. */
  projectedAuthority?: Record<string, unknown>;
  /** Exact consumed revision frozen by this newborn snapshot; never permission-only authority. */
  snapshotInput?: LineageRoot };
declare const planBrand: unique symbol;
declare const ownerBrand: unique symbol;
export type SourceCommitLockPlan = { readonly [planBrand]: true };
export type SourceCommitOwnerAttestation = { readonly [ownerBrand]: true };
export const SOURCE_COMMIT_CONTROL_TABLES = ["NativeTranscriptPublication", "MeetingTranscriptSourceRecord", "FinanceReportFact", "MeetingRecording", "MeetingRecorderProviderEvent", "MeetingRecorderSmokeRun", "MeetingTranscriptProcessingProgress", "AuditLog", "Event", "RecorderTranscriptPublication", "RecorderTranscriptAttempt"] as const;
/** Typed exact before/after control projections. These confer no semantic input authority. */
export type SourceCommitControlWriteTarget = { table: typeof SOURCE_COMMIT_CONTROL_TABLES[number]; id: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null };
export type SourceCommitLockPlanOptions = { writeTargets: readonly SourceCommitWriteTarget[]; ownerBinding: SourceCommitOwnerBinding;
  /** Test-only injectable primary read client; planning never invokes a supplied production interactive transaction. */
  controlWriteTargets?: readonly SourceCommitControlWriteTarget[];
  db?: SourceAuthorityClient; maxNodes?: number; structuralAuthorities?:readonly ArtifactStructuralAuthority[] };
type PhysicalLock = SourceAuthorityRow & { mode: "SHARE" | "UPDATE" };
type Discovery = { rows: PhysicalLock[]; advisories: Array<{key: string; mode: "SHARE" | "UPDATE"}>;
  ledger: Array<[string, string]>; originalEpochs: PermissionEpochProof | undefined;
  structuralEpochs:PermissionEpochProof|undefined;
  /** Current ambient fences are never historical input proofs or recorder roots. */
  ambientEpochs: Array<{kind:string;id:string;epoch:string}>;
  policies: Array<{kind: string; id: string}>; predicates:SourceAuthorityEdges["predicates"]; newborns: string[];
  semanticRoots:LineageRoot[]; snapshotBindings:Array<{id:string;input:LineageRoot;source:LineageRoot}> };
type StructuralAuthorityState=Pick<ReturnType<typeof import("./artifact-structural-authority").consumeArtifactStructuralAuthority>,"target"|"observation"|"permissionEpochs">;
type PlanState = { structural:StructuralAuthorityState[]; actor: AppActor; actorHash: string; origin: unknown; workspaceId: string; roots: LineageRoot[];
  nativePurposeHash: string; controlWriteTargets: SourceCommitControlWriteTarget[]; writeTargets: SourceCommitWriteTarget[]; ownerBinding: SourceCommitOwnerBinding; maxNodes: number; discovered: Discovery };
type AttestationState = { plan: SourceCommitLockPlan; tx: Prisma.TransactionClient; connection: string;
  assertOwner: (tx: Prisma.TransactionClient, binding: SourceCommitOwnerBinding) => Promise<void> };
const plans = new WeakMap<object, PlanState>();
const attestations = new WeakMap<object, AttestationState>();
const headReservations = new WeakMap<object,{tx:Prisma.TransactionClient;connection:string;complete:boolean}>();
const activePlans = new AsyncLocalStorage<{state: PlanState; tx: Prisma.TransactionClient; active: boolean;published:Map<string,LineageRoot>}>();
const MAX_NODES = 10000;
const ARCHIVE_TABLES = new Set(["BrainSource", "Document", "BrainArticle", "Meeting", "Action", "Tension", "Proposal", "Goal", "Circle", "Role", "AgentIdentity",
  "CrmAccount", "CrmActivity", "CrmContact", "CrmDeal", "WorkspaceToolLink"]);

export function sourceCommitCanonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(sourceCommitCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,item]) => item !== undefined)
    .sort(([a],[b]) => compare(a,b)).map(([key,item]) => `${JSON.stringify(key)}:${sourceCommitCanonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(sourceCommitCanonical(value)).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const logicalKey = (input: LineageInput) => JSON.stringify([input.kind,input.id]);
const rowKey = (row: SourceAuthorityRow) => JSON.stringify([row.table,row.id]);
/** Every manifest/body writer must reserve this canonical alias key BEFORE source DML. */
export function sourceCommitHeadAdvisoryKey(workspaceId:string,input:LineageInput) {
  const row=sourceAuthorityPhysicalRow(input);
  invariant(row,409,"SOURCE_LOCK_UNSUPPORTED","Virtual control inputs have no writable source head.");
  return `source-head:${workspaceId}:${rowKey(row)}`;
}
const nativePurposeHash=(actor:AppActor,workspaceId:string)=>hash([getExternalProviderWorkerPurpose(actor)??null,getAudioTranscriptWorkerPurpose(actor,workspaceId)??null,getRecorderTranscriptWorkerPurpose(actor,workspaceId)??null,getTranscriptSourceImportPurpose(actor,workspaceId)??null]);
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
function validBinding(binding: SourceCommitOwnerBinding) {
  invariant(binding && ["WORKFLOW_JOB", "AGENT_RUN", "CONVERSATION_GENERATION", "HUMAN_REQUEST", "RECORDER_TRANSCRIPT", "TRANSCRIPT_SOURCE_IMPORT"].includes(binding.kind)
    && typeof binding.id === "string" && binding.id.length > 0 && Number.isSafeInteger(binding.generation) && binding.generation > 0,
  409, "SOURCE_OWNER_UNAVAILABLE", "Commit requires an exact typed owner and generation binding.");
  // Bind only finite serializable scalar/object data; no executable or object-identity authority can be serialized here.
  const validate = (value: unknown, depth = 0): void => {
    invariant(depth <= 20 && (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value)) || Array.isArray(value)
      || (authorityRecord(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)))),
    409, "SOURCE_OWNER_UNAVAILABLE", "Owner binding is not immutable serializable control data.");
    if (value && typeof value === "object") for (const child of Object.values(value)) validate(child, depth + 1);
  };
  validate(binding);
}
function budget(maxNodes: number): SourceAuthorityBudget {
  const seen = new Set<string>();
  return { consume(key) { if (seen.has(key)) return; invariant(seen.size < maxNodes, 409, "SOURCE_LOCK_LIMIT", "Source lock closure exceeds its bounded budget."); seen.add(key); },
    remaining() { return Math.max(0,maxNodes - seen.size); } };
}
function roots(value: unknown): LineageRoot[] {
  invariant(Array.isArray(value), 409, "SOURCE_LOCK_INCOMPLETE", "Stored input ancestry is unavailable.");
  for (const root of value) {
    invariant(authorityRecord(root) && typeof root.kind === "string" && Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY_REGISTRY,root.kind)
      && typeof root.id === "string" && root.id.length > 0 && typeof root.fingerprint === "string" && /^[a-f0-9]{64}$/.test(root.fingerprint)
      && (root.permissionEpochs === undefined || parsePermissionEpochProof(root.permissionEpochs)),
    409, "SOURCE_LOCK_INCOMPLETE", "Stored input ancestry is malformed.");
  }
  return value as LineageRoot[];
}
// Only envelope/linkage fields for a live permission-only source. Its old or unreadable semantic body is never promoted into an input.
const GOVERNING_FIELDS = ["id", "workspaceId", "crmWorkspaceId", "ownerMemberId", "memberId", "authorMemberId", "recipientMemberId", "userId", "authorUserId", "createdByUserId",
  "submittedByUserId", "requesterUserId", "requestedByUserId", "localUserId", "selectedByUserId", "uploadedByUserId", "circleId", "parentCircleId", "targetCircleId", "roleId",
  "isPrivate", "visibility", "classification", "publicRevokedAt", "archivedAt", "isActive", "status", "expiresAt", "isHidden", "isDeleted", "textRedactedAt", "expiresRawAt", "isBot",
  "installationId", "externalChannelId", "externalMessageId", "communicationMessageId", "connectionId", "externalContentSourceId", "sourceKind", "sourceRecordId", "mode", "meetingAudioAssetId",
  "provider", "providerKey", "externalId", "externalWorkspaceId", "appId", "providerPrincipalId", "accessDomain", "credentialId", "agentCredentialId", "agentIdentityId", "audienceType",
  "goalId", "actionId", "tensionId", "articleId", "threadId", "mapViewId", "constitutionId", "proposalId", "artifactId", "executionRequestId", "meetingId", "sessionId", "conversationId",
  "flowId", "subjectType", "subjectId", "sourceType", "sourceId", "parentType", "parentId", "demoLeadId", "qualificationId", "accountId", "contactId", "dealId", "activityId", "targetWorkspaceId",
  "batchId", "documentId", "informationCategory", "brainSourceId", "sourceBatchId", "reportId", "sourceCandidateId", "candidateId", "targetFactId", "factId", "appliedByUserId", "approvedByUserId", "kind", "beforeRevisionId", "afterRevisionId", "agentRunId", "stepId", "priorRunSnapshotId", "variantOfArticleId",
  "variantTargetFingerprint", "variantSourceStateJson", "targetFingerprint", "targetKind", "targetId", "targetsJson", "scopeJson", "sourceStateJson", "metadata", "operation", "controlJson", "ingressInputId"];
const envelope = (row: Record<string, unknown>) => Object.fromEntries(GOVERNING_FIELDS.filter(key => key in row).map(key => [key,row[key]]));
const outputEnvelope=(row:Record<string,unknown>)=>Object.fromEntries(GOVERNING_FIELDS.map(key=>[key,row[key]??null]));
function projectedAuthorityRecord(input:LineageInput,projected:Record<string,unknown>,workspaceId:string) {
  const descriptor=sourceAuthorityDescriptor(input.kind);
  const row:Record<string,unknown>={...projected,id:input.id};
  // Ownership lives on the physical model: relation-owned rows have no workspace column.
  // Their exact parent edge is discovered separately and checked through the tenant-scoped loader.
  delete row.workspaceId;delete row.crmWorkspaceId;
  if(descriptor.scope==="workspace")row.workspaceId=workspaceId;
  else if(descriptor.scope==="crm")row.crmWorkspaceId=workspaceId;
  return row;
}
const phase = (table: string) => ["CommunicationMessageNativeInput", "ExternalMcpResponseInput", "ExternalProviderFetchInput", "NativeTranscriptInput", "FinanceReportUploadInput"].includes(table) ? 0
  : ["WorkflowJob", "AgentRun"].includes(table) ? 1 : table === "BrainSource" ? 3 : table === "Document" ? 4 : table === "BrainArticle" ? 6 : 5;

function structuralOutputReferences(authority:Record<string,unknown>|undefined):LineageInput[] {
  if(!authority)return [];
  if(typeof authority.variantOfArticleId==="string")return [{kind:"BrainArticle",id:authority.variantOfArticleId}];
  if(Array.isArray(authority.targetsJson))return authority.targetsJson.flatMap(value=>{
    const target=authorityRecord(value);return target&&typeof target.kind==="string"&&typeof target.id==="string"?[{kind:target.kind as LineageKind,id:target.id}]:[];
  });return [];
}
function validateStructuralOutput(state:Omit<PlanState,"discovered">,input:LineageInput,authority:Record<string,unknown>|undefined,existing?:Record<string,unknown>|null) {
  const refs=structuralOutputReferences(authority);
  if(!refs.some(ref=>state.structural.some(receipt=>logicalKey(receipt.target)===logicalKey(ref))))return;
  invariant(!existing&&authority,409,"SOURCE_LOCK_UNCOVERED","Structural authority requires an absent private output.");
  const covered=refs.map(ref=>state.structural.find(receipt=>logicalKey(receipt.target)===logicalKey(ref)));
  invariant(covered.every(Boolean)&&new Set(refs.map(logicalKey)).size===refs.length,409,"SOURCE_LOCK_UNCOVERED","Variant canonical targets are not exactly covered.");
  if(input.kind==="BrainArticle") {
    const receipt=covered[0]!;
    invariant(refs.length===1&&receipt.target.kind==="BrainArticle"&&authority.isPrivate===true&&authority.ownerMemberId===receipt.observation.ownerMemberId
      &&authority.variantTargetFingerprint===receipt.observation.fingerprint,409,"SOURCE_LOCK_UNCOVERED","Structural article output is not a new owner-private variant.");
  } else {
    invariant(input.kind==="GenericDerivedArtifactVariant"&&covered.every(receipt=>receipt!.target.kind!=="BrainArticle"&&authority.ownerMemberId===receipt!.observation.ownerMemberId)
      &&refs.some(ref=>ref.kind===authority.targetKind&&ref.id===authority.targetId),409,"SOURCE_LOCK_UNCOVERED","Structural graph output is not a new owner-private variant.");
    for(const value of authority.targetsJson as unknown[]) {
      const target=authorityRecord(value)!,receipt=state.structural.find(receipt=>receipt.target.kind===target.kind&&receipt.target.id===target.id)!;
      invariant(target.fingerprint===receipt.observation.fingerprint,409,"SOURCE_LOCK_UNCOVERED","Structural graph output target fingerprint is unavailable.");
    }
    const scope=authorityRecord(authority.scopeJson);
    for(const value of Array.isArray(scope?.sources)?scope.sources:[]) {
      const source=authorityRecord(value);
      if(source&&state.structural.some(receipt=>receipt.target.kind===source.kind&&receipt.target.id===source.id))
        invariant(state.roots.some(root=>root.kind===source.kind&&root.id===source.id&&root.fingerprint===source.fingerprint),
          409,"SOURCE_LOCK_UNCOVERED","Structural targets cannot become consumed semantic sources.");
    }
    const main=state.structural.find(receipt=>receipt.target.kind===authority.targetKind&&receipt.target.id===authority.targetId)!;
    invariant(authority.targetFingerprint===main.observation.fingerprint,409,"SOURCE_LOCK_UNCOVERED","Structural graph primary fingerprint differs from its canonical target.");
  }
}

async function discover(state: Omit<PlanState,"discovered">, db: SourceAuthorityClient, afterWork = false): Promise<Discovery> {
  const { actor, workspaceId, writeTargets, maxNodes } = state;
  const remaining = budget(maxNodes);
  const context={actor,workspaceId,db,budget:remaining,queryCache:new Map<string,Promise<Array<Record<string,unknown>>>>(),rowCache:new Map<string,Record<string,unknown>>()};
  const physical = new Map<string,PhysicalLock>();
  const advisory = new Map<string,{key:string;mode:"SHARE"|"UPDATE"}>();
  const ledger = new Map<string,string>();
  const predicates=new Map<string,SourceAuthorityEdges["predicates"][number]>();
  const policies = new Map<string,{kind:string;id:string}>();
  const requiredPolicies = new Set<string>();
  const equivalentGovernors:Array<{keys:string[];structural:boolean}>=[];
  const structuralRequiredPolicies=new Set<string>();
  const structuralTargets=new Map(state.structural.map(receipt=>[logicalKey(receipt.target),receipt]));
  const ambientPolicies = new Map<string,{kind:string;id:string}>();
  const vectors: PermissionEpochProof[] = [];
  const semanticRoots=new Map<string,LineageRoot>();
  const snapshotSources=new Map<string,LineageRoot>();
  const variantScopes:Array<Record<string,unknown>>=[];
  const snapshotOutputs:Array<{target:SourceCommitWriteTarget;row:Record<string,unknown>;persisted:boolean}> = [];
  const semanticKey=(root:LineageRoot)=>JSON.stringify([root.kind,root.id,root.fingerprint]);
  const admitSemantic=(root:LineageRoot)=>{remaining.consume(`semantic:${semanticKey(root)}`);semanticRoots.set(semanticKey(root),{kind:root.kind,id:root.id,fingerprint:root.fingerprint});};
  const pending: Array<{input:LineageInput; root?:LineageRoot; output?:boolean;structural?:boolean}> = state.roots.map(root => ({input:root,root}));
  const visited = new Set<string>();
  const targetKeys = new Set(writeTargets.map(logicalKey));
  const targetRows = new Set([...state.controlWriteTargets.map(rowKey), ...writeTargets.flatMap(input => { const row = sourceAuthorityPhysicalRow(input); return row ? [rowKey(row)] : []; })]);
  const addRow = (row:SourceAuthorityRow, mode:"SHARE"|"UPDATE" = "SHARE") => {
    remaining.consume(`physical:${rowKey(row)}`);
    const old = physical.get(rowKey(row)); physical.set(rowKey(row),{...row,mode:mode === "UPDATE" || row.mode === "UPDATE" || old?.mode === "UPDATE" || targetRows.has(rowKey(row)) ? "UPDATE" : "SHARE"});
    const key = `source-head:${workspaceId}:${rowKey(row)}`;
    advisory.set(key,{key,mode:targetRows.has(rowKey(row)) ? "UPDATE" : "SHARE"});
    if (ARCHIVE_TABLES.has(row.table)) {
      // Existing archive/source-link writers use this exact namespace.
      const key = `workspace_archive:${row.table}:${row.id}`; advisory.set(key,{key,mode:targetRows.has(rowKey(row)) ? "UPDATE" : "SHARE"});
    }
  };
  for (const control of state.controlWriteTargets) {
    addRow(control, "UPDATE");
    const actual = await sourceAuthorityDelegate(db, control.table).findFirst({ where: { id: control.id } });
    const expected = afterWork ? control.after : control.before;
    const fields = Object.keys(expected ?? control.before ?? control.after ?? {});
    const projected = actual && Object.fromEntries(fields.map(field => [field, actual[field] ?? null]));
    invariant(hash(projected) === hash(expected), 409, "SOURCE_CHANGED", "Planned control state changed.");
    if (actual) invariant(actual.workspaceId === workspaceId, 409, "SOURCE_CHANGED", "Control row belongs to another workspace.");
  }
  const addVector = (value:unknown) => {
    const parsed = parsePermissionEpochProof(value); invariant(parsed,409,"SOURCE_LOCK_INCOMPLETE","A saved original permission vector is unavailable."); vectors.push(parsed);
    for (const entry of parsed.entries) remaining.consume(`epoch:${JSON.stringify([entry.kind,entry.id])}`);
  };
  const addEdges = async (edges:SourceAuthorityEdges, ambient = false, output = false,
    authorityInput?:LineageInput,content?:Record<string,unknown>,semantic=false,structural=false) => {
    for (const parent of edges.artifacts) pending.push({input:parent,structural:structural||(output&&structuralTargets.has(logicalKey(parent)))});
    for(const consumed of edges.consumedArtifacts??[]) {
      remaining.consume(`ancestor:${logicalKey(consumed)}:${consumed.fingerprint}`);
      pending.push({input:consumed,root:consumed});
    }
    for (const row of edges.rows) {
      addRow(row);
      const loaded = context.rowCache.get(rowKey(row))??await sourceAuthorityDelegate(db,row.table).findFirst({where:{id:row.id}});
      invariant(loaded,409,"SOURCE_LOCK_INCOMPLETE","A governing row is unavailable.");
      if (!afterWork || !targetRows.has(rowKey(row))) ledger.set(`governor:${rowKey(row)}`,hash(loaded));
    }
    for (const predicate of edges.predicates) {
      remaining.consume(`predicate:${predicate.key}`); ledger.set(`predicate:${predicate.key}`,hash(predicate));predicates.set(predicate.key,predicate);
    }
    for (const policy of edges.policies) {
      const key=JSON.stringify([policy.kind,policy.id]);remaining.consume(`policy:${key}`);policies.set(key,policy);
      // Declared output category governors are current write constraints, never
      // refreshed historical inputs. OWN epochs keep their existing reservation.
      const categoryGovernor = output && authorityInput
        && (CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(authorityInput.kind)
        && ["InformationCategoryPolicy", "Role", "Circle"].includes(policy.kind);
      if(ambient || categoryGovernor) ambientPolicies.set(key,policy);
      else if(!output) {
        if(!semantic&&authorityInput&&policy.kind===authorityInput.kind&&policy.id===authorityInput.id
          &&["Member","User"].includes(authorityInput.kind)) {
          const userId=authorityInput.kind==="User"?authorityInput.id:authorityIdentity(content?.userId);
          equivalentGovernors.push({keys:[key,JSON.stringify(["MemberUserPolicy",userId])],structural});
        } else if(!semantic&&authorityInput?.kind==="CommunicationChannel"&&policy.kind==="CommunicationChannel"&&policy.id===authorityInput.id) {
          // A native message consumes the bound channel policy, not the channel's semantic body.
          // The exact current channel tuple is tenant-scoped and retained in the locked ledger.
          const installationId=authorityIdentity(content?.installationId),externalChannelId=authorityIdentity(content?.externalChannelId);
          equivalentGovernors.push({keys:[key,JSON.stringify(["CommunicationChannelPolicy",JSON.stringify([installationId,externalChannelId])])],structural});
        } else (structural?structuralRequiredPolicies:requiredPolicies).add(key);
      }
    }
  };
  await addEdges(await discoverAmbientSourceAuthority(context,authorityRecord(state.origin)),true);
  pending.push({input:{kind:"Workspace",id:workspaceId}});
  for (const input of writeTargets) pending.push({input,output:true});
  for(const receipt of state.structural)pending.push({input:receipt.target,structural:true});
  const { lineageContentFingerprint } = await import("./source-lineage");
  for (let index=0;index<pending.length;index++) {
    const {input,root,output:explicitOutput,structural=false} = pending[index];
    // Declared outputs reached through parent edges are structural authority only.
    // A semantic consumed root never acquires this absent-row exception.
    const output=Boolean(explicitOutput||(!root&&targetKeys.has(logicalKey(input))));
    const key = `${logicalKey(input)}:${root?.fingerprint ?? "authority"}:${output ? "output" : "input"}:${structural?"structural":"original"}`;
    if (visited.has(key)) continue;
    remaining.consume(`visit:${key}`); visited.add(key);
    const descriptor = sourceAuthorityDescriptor(input.kind);
    const physicalRow = sourceAuthorityPhysicalRow(input); if (physicalRow) addRow(physicalRow,output ? "UPDATE" : "SHARE");
    const loaded = await loadSourceAuthorityRecord(db,workspaceId,input);
    const projected = writeTargets.find(target => logicalKey(target) === logicalKey(input))?.projectedAuthority;
    if(output&&state.structural.length)validateStructuralOutput(state,input,loaded?{...loaded,...(!afterWork?projected:undefined)}:projected,afterWork?undefined:loaded);
    if(output&&input.kind==="GenericDerivedArtifactVariant")variantScopes.push(loaded&&afterWork?loaded:projectedAuthorityRecord(input,{...loaded,...projected},workspaceId));
    if(!output&&root&&input.kind==="GenericDerivedArtifactVariant"&&loaded)variantScopes.push(loaded);
    if(output&&input.kind==="ArtifactInputSnapshot") {
      const target=writeTargets.find(target=>logicalKey(target)===logicalKey(input))!;
      invariant(target.snapshotInput&&target.projectedAuthority,409,"SOURCE_LOCK_UNCOVERED","Snapshot output requires its exact original semantic input.");
      roots([target.snapshotInput]);
      snapshotOutputs.push({target,persisted:Boolean(loaded),row:afterWork&&loaded?loaded:projectedAuthorityRecord(input,target.projectedAuthority,workspaceId)});
    }
    if (!loaded) {
      invariant(output && projected,409,"SOURCE_LOCK_INCOMPLETE","A source authority row is unavailable.");
      if (!afterWork) ledger.set(`output:${logicalKey(input)}`,"ABSENT");
      ledger.set(`expected-output:${logicalKey(input)}`,hash(outputEnvelope(projectedAuthorityRecord(input,projected,workspaceId))));
      await addEdges(await discoverSourceAuthorityEdges(context,input,projectedAuthorityRecord(input,projected,workspaceId)),false,true,input);
      continue;
    }
    if (!output && root?.permissionEpochs !== undefined) addVector(root.permissionEpochs);
    const immutableAuthority = descriptor.native || descriptor.manifest === "snapshot";
    if (!output && (!afterWork || !targetKeys.has(logicalKey(input)))) {
      // Native exact encrypted/projection fields are authority, even when discovered through a permission-only edge.
      ledger.set(`content:${key}`,hash(root || immutableAuthority ? loaded : envelope(loaded)));
    }
    if (output && !afterWork) ledger.set(`output:${logicalKey(input)}`,hash(envelope(loaded)));
    if(output) ledger.set(`expected-output:${logicalKey(input)}`,hash(outputEnvelope(afterWork?loaded:projectedAuthorityRecord(input,{...loaded,...projected},workspaceId))));
    await addEdges(await discoverSourceAuthorityEdges(context,input,loaded),false,Boolean(output),input,loaded,Boolean(root),structural);
    if (projected) await addEdges(await discoverSourceAuthorityEdges(context,input,projectedAuthorityRecord(input,{...loaded,...projected},workspaceId)),false,true,input);
    if (input.kind === "ArtifactInputSnapshot") {
      // A declared newborn snapshot is an OUTPUT, never historical input authority.
      // Its exact source governor was discovered from projectedAuthority before DML.
      if(output) continue;
      invariant(loaded.epochProofVersion === 1 && ["HUMAN_ORIGINAL","DERIVED","NATIVE_ORIGINAL"].includes(String(loaded.origin)),
        409,"SOURCE_LOCK_INCOMPLETE","Preserved input has no authenticated ancestry.");
      addVector(loaded.permissionEpochsJson);
      const sourceKind = authorityIdentity(loaded.sourceKind);
      invariant(Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY_REGISTRY,sourceKind) && sourceKind !== "ArtifactInputSnapshot",409,"SOURCE_LOCK_INCOMPLETE","Preserved authority source is unsupported.");
      invariant(authorityRecord(loaded.contentJson)&&lineageContentFingerprint(sourceKind as LineageKind,loaded.contentJson)===loaded.sourceFingerprint,
        409,"SOURCE_LOCK_INCOMPLETE","Preserved source bytes do not match their immutable receipt.");
      // This synthetic source node consumes the SAME hard budget as a base node.
      const source = {kind:sourceKind as LineageKind,id:authorityIdentity(loaded.sourceId)};
      if(root) {admitSemantic(root);const sourceRoot={...source,fingerprint:authorityIdentity(loaded.sourceFingerprint)};admitSemantic(sourceRoot);snapshotSources.set(semanticKey(root),sourceRoot);}
      remaining.consume(`synthetic:${logicalKey(source)}`); pending.push({input:source});
      const originals=await sourceAuthorityDelegate(db,"ArtifactInputLineage").findMany({where:{workspaceId,artifactType:sourceKind,
        artifactId:source.id,contentHash:loaded.sourceFingerprint,...(["KnowledgeChunk","CommunicationMessage"].includes(sourceKind)?{origin:"DERIVED"}:{})},
      orderBy:{revision:"desc"},take:remaining.remaining()+1});
      for(const original of originals) {
        const manifestRow={table:"ArtifactInputLineage",id:authorityIdentity(original.id)};
        remaining.consume(`snapshot-original:${rowKey(manifestRow)}`);addRow(manifestRow);
        ledger.set(`snapshot-original:${rowKey(manifestRow)}`,hash(original));
      }
      invariant(!["KnowledgeChunk","CommunicationMessage"].includes(sourceKind)||originals.some(original=>Array.isArray(original.rootsJson)&&original.rootsJson.length>0),
        409,"SOURCE_LOCK_INCOMPLETE","Preserved derived source has no original stored receipt.");
      if (root) invariant(lineageContentFingerprint("ArtifactInputSnapshot",loaded) === root.fingerprint,
        409,"SOURCE_CHANGED","Preserved input changed before locking.");
      for (const ancestor of roots(loaded.rootsJson)) { remaining.consume(`ancestor:${logicalKey(ancestor)}:${ancestor.fingerprint}`); pending.push({input:ancestor,root:ancestor}); }
      continue;
    }
    if (descriptor.manifest === "virtual") {
      if(root&&!output) {invariant(lineageContentFingerprint(input.kind,loaded)===root.fingerprint,409,"SOURCE_CHANGED","Consumed virtual source changed before locking.");admitSemantic(root);}
      continue;
    }
    if(!output&&input.kind==="GenericDerivedArtifactVariant") {
      const sourceState=authorityRecord(loaded.sourceStateJson);
      addVector(sourceState?.permissionEpochs);addVector(sourceState?.targetEpochs);
    }
    // Native rows may retain their own saved vectors in addition to their enclosing immutable proof.
    if (input.kind === "CommunicationMessageNativeInput") { invariant(loaded.epochProofVersion === 1,409,"SOURCE_LOCK_INCOMPLETE","Native communication has no original vector."); addVector(loaded.permissionEpochsJson); }
    if (input.kind === "ExternalMcpResponseInput") addVector(loaded.originalLocalEpochsJson);
    const manifestDelegate = sourceAuthorityDelegate(db,"ArtifactInputLineage");
    const head = await manifestDelegate.findFirst({where:{workspaceId,artifactType:input.kind,artifactId:input.id},orderBy:{revision:"desc"}});
    const structuralReceipt=structuralTargets.get(logicalKey(input));
    if(structural&&structuralReceipt) {
      const {loadArtifactPermissionMetadata}=await import("./source-permission-parents");
      const metadata=await loadArtifactPermissionMetadata(db,workspaceId,input);
      const stamp=(value:unknown)=>createHash("sha256").update(sourceCommitCanonical(value)).digest("hex");
      invariant(lineageContentFingerprint(input.kind,loaded)===structuralReceipt.observation.fingerprint
        &&stamp(metadata)===structuralReceipt.observation.envelopeStamp&&stamp(head)===structuralReceipt.observation.headStamp,
        409,"SOURCE_CHANGED","Structural target changed before variant publication.");
      for(const target of writeTargets) if(target.kind==="GenericDerivedArtifactVariant") {
        const authority=afterWork?await loadSourceAuthorityRecord(db,workspaceId,target):target.projectedAuthority;
        for(const entry of Array.isArray(authority?.targetsJson)?authority.targetsJson:[]) {
          const reference=authorityRecord(entry);
          if(reference?.kind===input.kind&&reference.id===input.id&&reference.manifestId!==undefined)
            invariant(reference.manifestId===head?.id,409,"SOURCE_CHANGED","Structural target recipe head is stale.");
        }
      }
      ledger.set(`structural-observation:${logicalKey(input)}`,hash(structuralReceipt.observation));
    }
    if (head) {
      addRow({table:"ArtifactInputLineage",id:authorityIdentity(head.id)});
      if (!output && (!afterWork || !targetKeys.has(logicalKey(input)))) ledger.set(`head:${logicalKey(input)}`,hash(head));
      if (output && !afterWork) ledger.set(`output-head:${logicalKey(input)}`,hash(head));
    } else if (output && !afterWork) ledger.set(`output-head:${logicalKey(input)}`,"ABSENT");
    if (root && !output) {
      admitSemantic(root);
      if(!afterWork||!targetKeys.has(logicalKey(input))) invariant(lineageContentFingerprint(input.kind,loaded) === root.fingerprint,409,"SOURCE_CHANGED","Consumed source changed before locking.");
      const manifest = head?.contentHash === root.fingerprint ? head : await manifestDelegate.findFirst({where:{workspaceId,artifactType:input.kind,artifactId:input.id,contentHash:root.fingerprint},orderBy:{revision:"desc"}});
      invariant(manifest || descriptor.manifest !== "required",409,"SOURCE_LOCK_INCOMPLETE","Consumed source has no complete manifest.");
      if (manifest) {
        addRow({table:"ArtifactInputLineage",id:authorityIdentity(manifest.id)}); ledger.set(`consumed-manifest:${logicalKey(input)}:${root.fingerprint}`,hash(manifest));
        const upstream = roots(manifest.rootsJson);
        invariant(["HUMAN_ORIGINAL","DERIVED","NATIVE_ORIGINAL"].includes(String(manifest.origin))
          && (manifest.origin !== "DERIVED" || upstream.length > 0),409,"SOURCE_LOCK_INCOMPLETE","Consumed source ancestry is unknown.");
        if (manifest.origin !== "HUMAN_ORIGINAL") { invariant(manifest.epochProofVersion === 1,409,"SOURCE_LOCK_INCOMPLETE","Consumed manifest has no original vector."); addVector(manifest.permissionEpochsJson); }
        for (const ancestor of upstream) { remaining.consume(`ancestor:${logicalKey(ancestor)}:${ancestor.fingerprint}`); pending.push({input:ancestor,root:ancestor}); }
      }
      if (input.kind === "ConversationOperationOutcome" && loaded.operation === "LEGACY_RECOVERY_PUBLICATION") {
        // Only an exact consumed receipt carries these dynamic original inputs.
        // Permission-only governors and declared outputs must not grant semantics.
        const { currentLegacyRecoveryPublication } = await import("./legacy-recovery");
        const recovery = await currentLegacyRecoveryPublication(actor, workspaceId, loaded, db);
        invariant(recovery, 409, "SOURCE_CHANGED", "Consumed recovery authority changed before locking.");
        for (const ancestor of roots(recovery.roots)) {
          remaining.consume(`ancestor:${logicalKey(ancestor)}:${ancestor.fingerprint}`);
          pending.push({input: ancestor, root: ancestor});
        }
      }
      if (input.kind === "KnowledgeChunk") {
        const metadata = authorityRecord(loaded.metadata);
        const sources:Record<string,LineageKind> = {BRAIN_ARTICLE:"BrainArticle",DOCUMENT:"Document",MEETING:"Meeting",PROPOSAL:"Proposal",EXTERNAL_CONTENT:"ExternalContentSource",EXTERNAL_DATABASE:"SqlNativeRunInput",TENSION:"Tension",ACTION:"Action",CIRCLE:"Circle",ROLE:"Role",SLACK:"CommunicationMessage"};
        const kind = sources[String(loaded.sourceType)]; invariant(kind && typeof metadata?.sourceContentHash === "string",409,"SOURCE_LOCK_INCOMPLETE","Knowledge parent proof is unavailable.");
        const ancestor = {kind,id:authorityIdentity(loaded.sourceType === "EXTERNAL_DATABASE" ? metadata.nativeInputId : loaded.sourceId),fingerprint:metadata.sourceContentHash};
        remaining.consume(`synthetic:${logicalKey(ancestor)}:${ancestor.fingerprint}`); pending.push({input:ancestor,root:ancestor});
      }
    }
  }
  // Scope IDs are consumed content, not governing permission edges. Every claimed
  // source must occur in the complete original semantic traversal or a verified
  // immutable snapshot's original source equivalence.
  for(const variant of variantScopes) {
    const scope=authorityRecord(variant.scopeJson);
    invariant(Array.isArray(scope?.sources)&&scope.sources.length>0,409,"SOURCE_LOCK_UNCOVERED","Variant source scope is unavailable.");
    for(const value of scope.sources) {
      const source=roots([value])[0];
      invariant(semanticRoots.has(semanticKey(source)),409,"SOURCE_LOCK_UNCOVERED","Variant source has no original consumed semantic proof.");
    }
  }
  const snapshotBindings=snapshotOutputs.map(({target,row,persisted})=>{
    const input=target.snapshotInput!;
    invariant(semanticRoots.has(semanticKey(input)),409,"SOURCE_LOCK_UNCOVERED","Snapshot input has no original consumed semantic proof.");
    const source=snapshotSources.get(semanticKey(input))??input;
    invariant(row.sourceKind===source.kind&&row.sourceId===source.id&&row.sourceFingerprint===source.fingerprint,
      409,"SOURCE_LOCK_UNCOVERED","Snapshot output does not bind its exact consumed source revision.");
    if(afterWork&&persisted) invariant(authorityRecord(row.contentJson)&&lineageContentFingerprint(source.kind,row.contentJson)===source.fingerprint,
      409,"SOURCE_CHANGED","Snapshot output bytes differ from their consumed source revision.");
    return {id:target.id,input:{kind:input.kind,id:input.id,fingerprint:input.fingerprint},source};
  });
  if(afterWork) for(const {row,persisted} of snapshotOutputs) if(persisted) for(const ancestor of roots(row.rootsJson)) {
    if(semanticRoots.has(semanticKey(ancestor)))continue;
    const conversion=snapshotOutputs.find(output=>output.persisted&&output.target.id===ancestor.id&&ancestor.kind==="ArtifactInputSnapshot");
    invariant(conversion&&lineageContentFingerprint("ArtifactInputSnapshot",conversion.row)===ancestor.fingerprint,
      409,"SOURCE_LOCK_UNCOVERED","Snapshot output introduced unconsumed ancestry.");
  }
  const originalEpochs = mergePermissionEpochProofs(...vectors);
  invariant(originalEpochs,409,"SOURCE_LOCK_INCOMPLETE","Commit inputs have no original consumed permission vector.");
    const structuralEpochs=mergePermissionEpochProofs(...state.structural.map(receipt=>receipt.permissionEpochs));
  for(const entry of structuralEpochs?.entries??[])remaining.consume(`epoch:${JSON.stringify([entry.kind,entry.id])}`);
  const savedKeys=new Set(originalEpochs.entries.map(entry=>JSON.stringify([entry.kind,entry.id])));
  const structuralKeys=new Set([...savedKeys,...(structuralEpochs?.entries??[]).map(entry=>JSON.stringify([entry.kind,entry.id]))]);
  // Conflicting current structural and historical revisions never replace each other.
  mergePermissionEpochProofs(originalEpochs,structuralEpochs);
  invariant([...requiredPolicies].every(key=>savedKeys.has(key))&&[...structuralRequiredPolicies].every(key=>structuralKeys.has(key))
    &&equivalentGovernors.every(group=>group.keys.some(key=>(group.structural?structuralKeys:savedKeys).has(key))),
    409,"SOURCE_LOCK_INCOMPLETE","Consumed source has a governor missing from its original permission vectors.");
  const observations=[...ambientPolicies.values()].filter(policy=>!structuralKeys.has(JSON.stringify([policy.kind,policy.id])));
  const epochRows=observations.length ? await db.$queryRaw<Array<{sourceKind:string;sourceId:string;epoch:bigint}>>(Prisma.sql`SELECT "sourceKind","sourceId","epoch" FROM "SourcePermissionEpoch"
    WHERE "workspaceId"=${workspaceId} AND ("sourceKind","sourceId") IN (${Prisma.join(observations.map(entry=>Prisma.sql`(${entry.kind},${entry.id})`))})
    ORDER BY "sourceKind" COLLATE "C","sourceId" COLLATE "C"`) : [];
  // Ambient absence keys must already be durable. No epoch insertion or recapture of historical roots occurs here.
  invariant(epochRows.length===observations.length,409,"SOURCE_LOCK_INCOMPLETE","Ambient permission absence fence is unavailable.");
  const ambientEpochs=epochRows.map(row=>({kind:row.sourceKind,id:row.sourceId,epoch:String(row.epoch)}));
  const newborns=afterWork ? [] : [...ledger].filter(([key,value])=>key.startsWith("output:")&&value==="ABSENT").map(([key])=>key.slice(7)).sort(compare);
  return {rows:[...physical.values()].sort((a,b)=>phase(a.table)-phase(b.table)||compare(a.table,b.table)||compare(a.id,b.id)),
    advisories:[...advisory.values()].sort((a,b)=>compare(a.key,b.key)),ledger:[...ledger].sort(([a],[b])=>compare(a,b)),originalEpochs,structuralEpochs,
    ambientEpochs,semanticRoots:[...semanticRoots.values()].sort((a,b)=>compare(semanticKey(a),semanticKey(b))),snapshotBindings,
    predicates:[...predicates.values()].sort((a,b)=>compare(a.key,b.key)),policies:[...policies.values()].sort((a,b)=>compare(JSON.stringify([a.kind,a.id]),JSON.stringify([b.kind,b.id]))),newborns};
}

type SourceAuthorityPrimaryClient=SourceAuthorityClient & {$transaction<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>};
/** Outside-TX initialization of CURRENT control-absence keys only. This returns no
 * roots/vector/capability and never creates an absent historical content/OAuth governor. */
export async function prepareSourceCommitAmbientFences(actor:AppActor,workspaceId:string,
  options:{db?:SourceAuthorityClient;maxNodes?:number}={}):Promise<void> {
  assertOutsideArtifactNativeCommitPhase();sealArtifactInputActor(actor);
  const db=(options.db??prisma) as SourceAuthorityPrimaryClient;
  invariant(typeof db.$transaction==="function",409,"SOURCE_LOCK_UNAVAILABLE","Ambient preparation must precede the interactive transaction.");
  const maxNodes=options.maxNodes??MAX_NODES;
  invariant(Number.isSafeInteger(maxNodes)&&maxNodes>0&&maxNodes<=MAX_NODES,409,"SOURCE_LOCK_LIMIT","Ambient preparation requires a bounded closure.");
  const principal=hash(actor),origin=structuredClone(getMcpOrigin()??null),purpose=nativePurposeHash(actor,workspaceId);
  const allowed=new Set(["ModulePolicy","FeaturePolicy","MemberRolePolicy","MemberUserPolicy","WorkspaceSupportPolicy"]);
  const edges=await discoverAmbientSourceAuthority({actor,workspaceId,db,budget:budget(maxNodes)},authorityRecord(origin));
  const identities=edges.policies.filter(identity=>allowed.has(identity.kind));
  if(identities.length) await db.$transaction(async tx=>{await capturePermissionEpochs(tx,workspaceId,identities);});
  invariant(hash(actor)===principal&&isDeepStrictEqual(origin,getMcpOrigin()??null)&&nativePurposeHash(actor,workspaceId)===purpose,
    409,"SOURCE_CHANGED","Commit principal changed during ambient preparation.");
}

/** Primary DB metadata only. Discovery confers no read capability and never performs provider replay. */
export async function prepareSourceCommitLockPlan(actor:AppActor,workspaceId:string,originalRoots:readonly LineageRoot[],options:SourceCommitLockPlanOptions):Promise<SourceCommitLockPlan> {
  assertOutsideArtifactNativeCommitPhase();
  invariant(!options.db||typeof (options.db as unknown as {$transaction?:unknown}).$transaction==="function",409,"SOURCE_LOCK_UNAVAILABLE","Source planning must precede the interactive transaction.");
  validBinding(options.ownerBinding); sealArtifactInputActor(actor);
  const submitted = structuredClone([...originalRoots]); roots(submitted);
  const maxNodes = options.maxNodes ?? MAX_NODES;
  invariant(submitted.length>0 && submitted.length<=maxNodes && Number.isSafeInteger(maxNodes)&&maxNodes>0&&maxNodes<=MAX_NODES,
    409,"SOURCE_LOCK_LIMIT","Source lock plan requires bounded complete inputs.");
  for (const control of options.controlWriteTargets ?? []) {
    invariant(SOURCE_COMMIT_CONTROL_TABLES.includes(control.table) && typeof control.id === "string" && control.id.length > 0
      && (control.before !== null || control.after !== null)
      && [control.before, control.after].every(row => row === null || (row.id === control.id && row.workspaceId === workspaceId)),
      409, "SOURCE_LOCK_UNCOVERED", "Control output identity or tenant binding is invalid.");
  }
  invariant(new Set((options.controlWriteTargets ?? []).map(rowKey)).size === (options.controlWriteTargets ?? []).length,
    409, "SOURCE_LOCK_UNCOVERED", "Control outputs must be unique.");
  const tokens=Object.freeze([...(options.structuralAuthorities??[])]);
  invariant(new Set(tokens).size===tokens.length,409,"SOURCE_CHANGED","Structural receipts cannot be duplicated.");
  const state:Omit<PlanState,"discovered"> = {structural:[],actor,actorHash:hash(actor),origin:deepFreeze(structuredClone(getMcpOrigin() ?? null)),workspaceId,
    controlWriteTargets:deepFreeze(structuredClone([...(options.controlWriteTargets ?? [])])),nativePurposeHash:nativePurposeHash(actor,workspaceId),roots:deepFreeze(submitted),writeTargets:deepFreeze(structuredClone([...options.writeTargets])),ownerBinding:deepFreeze(structuredClone(options.ownerBinding)),maxNodes};
  const structural:StructuralAuthorityState[]=[];
  if(tokens.length) {
    const {consumeArtifactStructuralAuthority}=await import("./artifact-structural-authority");
    for(const token of tokens) {
      const receipt=consumeArtifactStructuralAuthority(actor,workspaceId,state.ownerBinding,token);
      structural.push(deepFreeze(structuredClone({target:receipt.target,observation:receipt.observation,permissionEpochs:receipt.permissionEpochs})));
    }
  }
  state.structural=deepFreeze(structural);
  for(const target of state.writeTargets) { sourceAuthorityDescriptor(target.kind); authorityIdentity(target.id); }
  invariant(new Set(state.structural.map(receipt=>logicalKey(receipt.target))).size===state.structural.length,
    409,"SOURCE_CHANGED","A structural target was supplied more than once.");
  for(const receipt of state.structural)invariant(!state.writeTargets.some(target=>logicalKey(target)===logicalKey(receipt.target)),
    409,"SOURCE_LOCK_UNCOVERED","Structural authority cannot mutate its canonical target.");
  // Explicit output categories need durable absence markers before discovery.
  // This initializes no policy or semantic authority and never changes an existing
  // epoch. The returned current vector is discarded; original proofs stay intact.
  const outputCategories = [...new Set(state.writeTargets.flatMap(target => {
    const category = target.projectedAuthority?.informationCategory;
    return (CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(target.kind)
      && typeof category === "string" && category.length > 0 ? [authorityIdentity(category)] : [];
  }))];
  invariant(outputCategories.length <= maxNodes,409,"SOURCE_LOCK_LIMIT","Output category closure is too large.");
  if(outputCategories.length) {
    const primary = (options.db ?? prisma) as SourceAuthorityPrimaryClient;
    await primary.$transaction(async tx => { await capturePermissionEpochs(tx,workspaceId,
      outputCategories.map(id => ({kind:"InformationCategoryPolicy",id}))); });
  }
  const discovered = await discover(state,options.db ?? prisma);
  for(const receipt of state.structural)invariant(state.writeTargets.some(target=>discovered.newborns.includes(logicalKey(target))&&structuralOutputReferences(target.projectedAuthority).some(reference=>logicalKey(reference)===logicalKey(receipt.target))),
    409,"SOURCE_LOCK_UNCOVERED","Structural authority requires a declared newborn private variant.");
  invariant(hash(actor)===state.actorHash && nativePurposeHash(actor,workspaceId)===state.nativePurposeHash && isDeepStrictEqual(state.origin,getMcpOrigin()??null),409,"SOURCE_CHANGED","Commit principal changed while planning.");
  const token=Object.freeze({}) as SourceCommitLockPlan; plans.set(token,{...state,discovered:deepFreeze(discovered)}); return token;
}
async function connectionIdentity(tx:Prisma.TransactionClient) {
  invariant(tx!==prisma,409,"SOURCE_OWNER_UNAVAILABLE","Commit requires an interactive transaction.");
  const rows=await tx.$queryRaw<Array<{pid:number;transactionId:string}>>`SELECT pg_backend_pid() AS pid, txid_current()::text AS "transactionId"`;
  invariant(rows.length===1 && Number.isInteger(rows[0].pid)&&typeof rows[0].transactionId==="string"&&/^[0-9]+$/.test(rows[0].transactionId),
    409,"SOURCE_OWNER_UNAVAILABLE","Commit connection attestation is unavailable.");
  return `${rows[0].pid}:${rows[0].transactionId}`;
}
function assertBinding(state:PlanState,actor:AppActor,workspaceId:string,originalRoots:readonly LineageRoot[],writeTargets:readonly SourceCommitWriteTarget[],binding:SourceCommitOwnerBinding) {
  invariant(state.actor===actor && state.actorHash===hash(actor)&&state.workspaceId===workspaceId&&isDeepStrictEqual(state.origin,getMcpOrigin()??null)
    &&state.nativePurposeHash===nativePurposeHash(actor,workspaceId)
    &&isDeepStrictEqual(state.roots,originalRoots)&&isDeepStrictEqual(state.writeTargets,writeTargets)&&isDeepStrictEqual(state.ownerBinding,binding),
    409,"SOURCE_CHANGED","Source commit capability does not match the current principal and inputs.");
}
/** Internal canonical-owner adapter seam. The token attests the exact supplied transaction/connection;
 * assertOwner MUST requery/lock actual lifecycle controls and reject stale lease/run/generation state.
 * A callback alone does not prove Bloop lifecycle semantics; that adapter remains a required integration. */
export async function prepareSourceCommitOwnerAttestation(actor:AppActor,workspaceId:string,tx:Prisma.TransactionClient,
  plan:SourceCommitLockPlan,binding:SourceCommitOwnerBinding,assertOwner:AttestationState["assertOwner"]):Promise<SourceCommitOwnerAttestation> {
  return withArtifactNativeCommitPhase(async()=>{
  const state=plans.get(plan); invariant(state&&typeof assertOwner==="function",409,"SOURCE_OWNER_UNAVAILABLE","Commit owner adapter is unavailable.");
  invariant(!activePlans.getStore()?.active,409,"SOURCE_LOCK_UNCOVERED","Owner attestation cannot introduce a nested source lock union.");
  assertBinding(state,actor,workspaceId,state.roots,state.writeTargets,binding);
  const connection=await connectionIdentity(tx);
  const reserved=headReservations.get(plan);
  invariant(!reserved||(reserved.complete&&reserved.tx===tx&&reserved.connection===connection),409,"SOURCE_OWNER_UNAVAILABLE","Source head reservation belongs to another transaction.");
  if(!reserved) {
    // Reserve the entire sorted head/archive union BEFORE owner adapters lock any control row.
    headReservations.set(plan,{tx,connection,complete:false});
    try {
      for(const advisory of state.discovered.advisories) {
        if(advisory.mode==="UPDATE")await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${advisory.key},0))`;
        else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${advisory.key},0))`;
      }
      headReservations.get(plan)!.complete=true;
    } catch(error) {plans.delete(plan);headReservations.delete(plan);throw error;}
  }
  await assertOwner(tx,state.ownerBinding);
  invariant(connection===await connectionIdentity(tx),409,"SOURCE_OWNER_UNAVAILABLE","Commit connection changed during owner attestation.");
  const token=Object.freeze({}) as SourceCommitOwnerAttestation; attestations.set(token,{plan,tx,connection,assertOwner}); return token;
  });
}
async function rewalk(state:PlanState,tx:Prisma.TransactionClient,afterWork=false) {
  try {return await discover(state,tx,afterWork);} catch(error) {
    if(error&&typeof error==="object"&&"code" in error&&["SOURCE_LOCK_INCOMPLETE","SOURCE_LOCK_UNSUPPORTED","SOURCE_LOCK_LIMIT"].includes(String(error.code)))
      invariant(false,409,"SOURCE_CHANGED","Source authority closure changed; retry with a new plan.");
    throw error;
  }
}
function stableAfterWork(before:Discovery,after:Discovery,targets:readonly SourceCommitWriteTarget[],controls:readonly SourceCommitControlWriteTarget[]) {
  // Declared output bodies/heads can change. Their newly created manifest rows do not need a late lock:
  // exclusive output-head ownership already serializes them. Other rows and every governing edge must be unchanged.
  const keys=targets.map(logicalKey),physical=targets.flatMap(target=>{const row=sourceAuthorityPhysicalRow(target);return row?[rowKey(row)]:[];});
  physical.push(...controls.map(rowKey));
  const outputLedger=(key:string)=>key.startsWith("output:")||key.startsWith("output-head:")
    ||keys.some(target=>key===`head:${target}`||key.startsWith(`content:${target}:`))
    ||physical.some(target=>key===`governor:${target}`);
  return isDeepStrictEqual(before.ledger.filter(([key])=>!outputLedger(key)),after.ledger.filter(([key])=>!outputLedger(key)))
    &&isDeepStrictEqual(before.policies,after.policies)
    &&isDeepStrictEqual(before.semanticRoots,after.semanticRoots)&&isDeepStrictEqual(before.snapshotBindings,after.snapshotBindings)
    &&isDeepStrictEqual(before.originalEpochs,after.originalEpochs)&&isDeepStrictEqual(before.structuralEpochs,after.structuralEpochs)&&isDeepStrictEqual(before.ambientEpochs,after.ambientEpochs)
    &&after.rows.every(row=>before.rows.some(prior=>rowKey(prior)===rowKey(row)) || row.table==="ArtifactInputLineage")
    &&isDeepStrictEqual(before.advisories.filter(entry=>!entry.key.includes('["ArtifactInputLineage",')),after.advisories.filter(entry=>!entry.key.includes('["ArtifactInputLineage",')));
}
async function verifyOriginalEpochUnion(tx:Prisma.TransactionClient,workspaceId:string,discovered:Discovery,lock:boolean) {
  const entries=[...mergePermissionEpochProofs(discovered.originalEpochs,discovered.structuralEpochs)!.entries,...discovered.ambientEpochs];
  const sorted=[...entries].sort((a,b)=>compare(a.kind,b.kind)||compare(a.id,b.id));
  const rows=await tx.$queryRaw<Array<{sourceKind:string;sourceId:string;epoch:bigint}>>(Prisma.sql`SELECT "sourceKind","sourceId","epoch" FROM "SourcePermissionEpoch"
    WHERE "workspaceId"=${workspaceId} AND ("sourceKind","sourceId") IN (${Prisma.join(sorted.map(entry=>Prisma.sql`(${entry.kind},${entry.id})`))})
    ORDER BY "sourceKind" COLLATE "C","sourceId" COLLATE "C" ${Prisma.raw(lock?"FOR SHARE":"")}`);
  const current=new Map(rows.map(row=>[JSON.stringify([row.sourceKind,row.sourceId]),String(row.epoch)]));
  invariant(rows.length===entries.length&&entries.every(entry=>current.get(JSON.stringify([entry.kind,entry.id]))===entry.epoch),
    409,"PERMISSION_CHANGED","Original consumed source permissions changed before commit.");
}
/** All advisory/physical rows precede the ONE saved epoch union. No transport or model calls belong in work. */
export async function withSourceCommitLockPlan<T>(actor:AppActor,workspaceId:string,tx:Prisma.TransactionClient,
  originalRoots:readonly LineageRoot[],writeTargets:readonly SourceCommitWriteTarget[],binding:SourceCommitOwnerBinding,
  plan:SourceCommitLockPlan,owner:SourceCommitOwnerAttestation,work:()=>Promise<T>):Promise<T> {
  return withArtifactNativeCommitPhase(async()=>{
  const state=plans.get(plan),attestation=attestations.get(owner);
  invariant(state&&attestation?.plan===plan&&attestation.tx===tx&&!activePlans.getStore(),409,"SOURCE_OWNER_UNAVAILABLE","Source commit plan/owner attestation is unavailable.");
  assertBinding(state,actor,workspaceId,originalRoots,writeTargets,binding);
  const reserved=headReservations.get(plan);
  invariant(reserved?.complete&&reserved.tx===tx&&reserved.connection===attestation.connection,409,"SOURCE_OWNER_UNAVAILABLE","Complete source head reservation is unavailable.");
  plans.delete(plan);attestations.delete(owner);headReservations.delete(plan);
  const checkOwner=async()=>{ assertBinding(state,actor,workspaceId,originalRoots,writeTargets,binding);
    invariant(await connectionIdentity(tx)===attestation.connection,409,"SOURCE_OWNER_UNAVAILABLE","Source commit moved to a different connection."); await attestation.assertOwner(tx,state.ownerBinding); };
  await checkOwner();
  for(const row of state.discovered.rows) {
    invariant(SOURCE_AUTHORITY_TABLES.includes(row.table),409,"SOURCE_LOCK_UNSUPPORTED","Physical source lock table is unavailable.");
    const ids=await tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${row.table}"`)} WHERE "id"=${row.id}
      ${Prisma.raw(row.mode==="UPDATE"?"FOR UPDATE":"FOR SHARE")}`);
    // Missing preallocated outputs are fenced by their reserved head. Every existing/input row must still exist.
    const declared=state.controlWriteTargets.some(control=>control.table===row.table&&control.id===row.id)||state.writeTargets.some(target=>sourceAuthorityPhysicalRow(target)?.table===row.table&&target.id===row.id);
    invariant(ids.length===1||declared,409,"SOURCE_CHANGED","Planned source row disappeared before locking.");
  }
  const locked=await rewalk(state,tx);
  invariant(isDeepStrictEqual(state.discovered,locked),409,"SOURCE_CHANGED","Source authority closure changed; retry with a new plan.");
  await verifyOriginalEpochUnion(tx,workspaceId,state.discovered,true);
  await checkOwner();
  const scope={state,tx,active:true,published:new Map<string,LineageRoot>()};
  return activePlans.run(scope,async()=>{
    try {
      const result=await work();await checkOwner();
      const current=await rewalk(state,tx,true);
      invariant(stableAfterWork(state.discovered,current,state.writeTargets,state.controlWriteTargets),409,"SOURCE_CHANGED","Commit introduced an unplanned source authority edge.");
      // Other transactions cannot change a SHARE-locked vector, but this transaction's own DML triggers can.
      // Rechecking the held union takes no additional lock and catches those transitions.
      await verifyOriginalEpochUnion(tx,workspaceId,state.discovered,false);
      return result;
    } finally {scope.active=false;}
  });
  });
}
function currentScope(tx:Prisma.TransactionClient) {
  const scope=activePlans.getStore();invariant(scope?.active&&scope.tx===tx,409,"SOURCE_LOCK_UNAVAILABLE","Source commit lock coverage is unavailable.");return scope;
}
/** Existing source/auth/native readers must call these assertions instead of taking later locks. */
export function assertSourceCommitRowCovered(tx:Prisma.TransactionClient,table:string,id:string,mode:"SHARE"|"UPDATE"="SHARE") {
  const scope=currentScope(tx),row=scope.state.discovered.rows.find(row=>row.table===table&&row.id===id);
  invariant(row&&(mode!=="UPDATE"||row.mode==="UPDATE"),409,"SOURCE_LOCK_UNCOVERED","Source commit requested an unplanned row lock.");
}
export function assertSourceCommitEpochCovered(tx:Prisma.TransactionClient,workspaceId:string,proof:unknown) {
  const scope=currentScope(tx),parsed=parsePermissionEpochProof(proof);
  const entries=new Map(scope.state.discovered.originalEpochs!.entries.map(entry=>[JSON.stringify([entry.kind,entry.id]),entry.epoch]));
  invariant(scope.state.workspaceId===workspaceId&&parsed&&parsed.entries.every(entry=>entries.get(JSON.stringify([entry.kind,entry.id]))===entry.epoch),
    409,"SOURCE_LOCK_UNCOVERED","Source commit requested an unplanned permission vector.");
}
/** Fence capture SQL BEFORE it runs. Only declared newborn OWN identities may be
 * initialized; existing historical and tagged current identities were already locked. */
export function assertSourceCommitEpochCaptureCovered(tx:Prisma.TransactionClient,workspaceId:string,identities:readonly PermissionEpochIdentity[]):readonly PermissionEpochIdentity[] {
  const scope=currentScope(tx);
  invariant(scope.state.workspaceId===workspaceId,409,"SOURCE_LOCK_UNCOVERED","Commit capture workspace is unplanned.");
  const existing=new Set([...scope.state.discovered.originalEpochs!.entries,...(scope.state.discovered.structuralEpochs?.entries??[]),...scope.state.discovered.ambientEpochs].map(entry=>JSON.stringify([entry.kind,entry.id])));
  const newborns=new Map<string,PermissionEpochIdentity>();
  for(const target of scope.state.writeTargets) if(scope.state.discovered.newborns.includes(logicalKey(target))) {
    const own=artifactPermissionEpochIdentities(target.kind,{id:target.id})[0];
    if(own)newborns.set(JSON.stringify([own.kind,own.id]),own);
  }
  const allowed=new Map<string,PermissionEpochIdentity>();
  for(const identity of identities){
    const key=JSON.stringify([authorityIdentity(identity.kind),authorityIdentity(identity.id)]);
    if(existing.has(key))continue;
    const own=newborns.get(key);invariant(own,409,"SOURCE_LOCK_UNCOVERED","Commit capture requested an unplanned source governor.");
    const target=scope.state.writeTargets.find(target=>scope.state.discovered.newborns.includes(logicalKey(target))
      &&JSON.stringify(artifactPermissionEpochIdentities(target.kind,{id:target.id})[0])===JSON.stringify(own));
    invariant(target,409,"SOURCE_LOCK_UNCOVERED","Newborn source head reservation is unavailable.");
    assertSourceCommitOutputHeadReserved(tx,workspaceId,target);allowed.set(key,own);
  }
  return deepFreeze([...allowed.entries()].sort(([a],[b])=>compare(a,b)).map(([,identity])=>({...identity})));
}
/** Writer-facing current checks may include exact original/current fences plus
 * declared newborn OWN keys. The caller must still query/compare their actual values;
 * this checks lock coverage only and grants no source or historical authority. */
export function assertSourceCommitPermissionReadCovered(tx:Prisma.TransactionClient,workspaceId:string,value:unknown) {
  const scope=currentScope(tx),proof=parsePermissionEpochProof(value);
  invariant(proof,409,"SOURCE_LOCK_UNCOVERED","Commit permission read is malformed.");
  const newborn=new Set(assertSourceCommitEpochCaptureCovered(tx,workspaceId,proof.entries).map(entry=>JSON.stringify([entry.kind,entry.id])));
  const held=new Map([...scope.state.discovered.originalEpochs!.entries,...(scope.state.discovered.structuralEpochs?.entries??[]),...scope.state.discovered.ambientEpochs].map(entry=>[JSON.stringify([entry.kind,entry.id]),entry.epoch]));
  invariant(proof.entries.every(entry=>newborn.has(JSON.stringify([entry.kind,entry.id]))||held.get(JSON.stringify([entry.kind,entry.id]))===entry.epoch),
    409,"SOURCE_LOCK_UNCOVERED","Commit permission read differs from its original or current authority fences.");
}
/** Native/auth SQL helpers do not need to know the registry's private predicate key. */
export function assertSourceCommitPredicateRowsCovered(tx:Prisma.TransactionClient,table:string,where:Record<string,unknown>,ids:readonly string[]) {
  const scope=currentScope(tx),sorted=[...ids].sort(compare);
  invariant(scope.state.discovered.predicates.some(predicate=>predicate.table===table&&hash(predicate.where)===hash(where)&&isDeepStrictEqual(predicate.ids,sorted)),
    409,"SOURCE_LOCK_UNCOVERED","Commit requested an unplanned source authority predicate.");
}
/** Current ambient policy observations are not historical vectors and cannot be used by a recorder. */
export function assertSourceCommitAmbientPolicyCovered(tx:Prisma.TransactionClient,workspaceId:string,identity:{kind:string;id:string;epoch:string}) {
  const scope=currentScope(tx);
  const rows=[...scope.state.discovered.originalEpochs!.entries,...(scope.state.discovered.structuralEpochs?.entries??[]),...scope.state.discovered.ambientEpochs];
  invariant(scope.state.workspaceId===workspaceId&&rows.some(entry=>entry.kind===identity.kind&&entry.id===identity.id&&entry.epoch===identity.epoch),
    409,"SOURCE_LOCK_UNCOVERED","Commit requested an unplanned ambient policy fence.");
}
export function assertSourceCommitPredicateCovered(tx:Prisma.TransactionClient,key:string,table:string,where:Record<string,unknown>,ids:readonly string[]) {
  const scope=currentScope(tx);
  const saved=scope.state.discovered.ledger.find(([entry])=>entry===`predicate:${key}`);
  invariant(saved?.[1]===hash({key,table,where,ids:[...ids].sort(compare)}),409,"SOURCE_LOCK_UNCOVERED","Commit requested an unplanned authority predicate.");
}
/** New preallocated outputs may capture their OWN newly inserted epoch after DML.
 * This cannot add older ancestor epochs or grant historical source authority. */
export function assertSourceCommitNewbornEpochAllowed(tx:Prisma.TransactionClient,workspaceId:string,input:LineageInput) {
  const scope=currentScope(tx);
  invariant(scope.state.workspaceId===workspaceId&&scope.state.discovered.newborns.includes(logicalKey(input)),
    409,"SOURCE_LOCK_UNCOVERED","An unplanned new artifact cannot acquire a post-DML permission epoch.");
  assertSourceCommitOutputHeadReserved(tx,workspaceId,input);
}
export function assertSourceCommitOutputHeadReserved(tx:Prisma.TransactionClient,workspaceId:string,output:LineageInput) {
  const scope=currentScope(tx),physical=sourceAuthorityPhysicalRow(output);
  invariant(scope.state.workspaceId===workspaceId&&scope.state.writeTargets.some(target=>logicalKey(target)===logicalKey(output))&&physical
    &&scope.state.discovered.rows.some(row=>rowKey(row)===rowKey(physical)&&row.mode==="UPDATE"),409,"SOURCE_LOCK_UNCOVERED","Manifest writer did not reserve its output before source DML.");
}
/** A helper cannot escape an active union by supplying another connection/client. */
export function assertSourceCommitTransactionCompatible(tx:Prisma.TransactionClient) {
  const scope=activePlans.getStore();
  invariant(!scope||(scope.active&&scope.tx===tx),409,"SOURCE_LOCK_UNCOVERED","Commit helper moved to an unplanned transaction or expired source scope.");
}
export function hasActiveSourceCommitLockPlan(tx:Prisma.TransactionClient) {
  assertSourceCommitTransactionCompatible(tx);
  const scope=activePlans.getStore();return Boolean(scope?.active&&scope.tx===tx);
}

/** Snapshot allocation proves source-content coverage, independently of output head coverage. */
export function assertSourceCommitSnapshotInputCovered(tx:Prisma.TransactionClient,workspaceId:string,outputId:string,input:LineageRoot) {
  const scope=currentScope(tx);
  const binding=scope.state.discovered.snapshotBindings.find(entry=>entry.id===outputId);
  invariant(scope.state.workspaceId===workspaceId&&binding&&binding.input.kind===input.kind&&binding.input.id===input.id&&binding.input.fingerprint===input.fingerprint,
    409,"SOURCE_LOCK_UNCOVERED","Snapshot allocation requested an unplanned consumed source revision.");
  assertSourceCommitOutputHeadReserved(tx,workspaceId,{kind:"ArtifactInputSnapshot",id:outputId});
}

/** Consumed semantics must come from the exact original closure or a verified
 * same-transaction publication. Governor, ambient and structural rows grant none. */
export function assertSourceCommitSemanticRootCovered(tx:Prisma.TransactionClient,workspaceId:string,root:LineageRoot):void {
  const scope=currentScope(tx);
  const original=scope.state.discovered.semanticRoots.some(input=>input.kind===root.kind&&input.id===root.id&&input.fingerprint===root.fingerprint);
  const published=scope.published.get(logicalKey(root));
  invariant(scope.state.workspaceId===workspaceId&&(original||published?.fingerprint===root.fingerprint),
    409,"SOURCE_LOCK_UNCOVERED","Semantic source was not consumed or verified by this commit.");
}
/** INTERNAL writer seam; do not barrel-export or accept user-supplied registrations.
 * The canonical recorder MUST verify the actual content, complete original proof,
 * current epochs and known origin BEFORE calling this. Registration grants no
 * permission by itself: the ordinary full source proof remains mandatory. */
export function registerSourceCommitPublishedOutput(tx:Prisma.TransactionClient,workspaceId:string,root:LineageRoot):void {
  const scope=currentScope(tx);roots([root]);
  assertSourceCommitOutputHeadReserved(tx,workspaceId,root);
  scope.published.set(logicalKey(root),{kind:root.kind,id:root.id,fingerprint:root.fingerprint});
}

/** Internal read-only batching seam. Identity coverage is not a permission proof,
 * current epoch value, serving grant or instruction to initialize missing rows. */
export function sourceCommitPermissionReadIdentities(tx:Prisma.TransactionClient,workspaceId:string):readonly PermissionEpochIdentity[] {
  const scope=currentScope(tx);
  invariant(scope.state.workspaceId===workspaceId,409,"SOURCE_LOCK_UNCOVERED","Permission batch workspace is unplanned.");
  const identities=new Map<string,PermissionEpochIdentity>();
  const add=(identity:PermissionEpochIdentity)=>{
    const key=JSON.stringify([identity.kind,identity.id]);
    identities.set(key,{kind:identity.kind,id:identity.id});
    invariant(identities.size<=scope.state.maxNodes,409,"SOURCE_LOCK_LIMIT","Permission batch exceeds the closed source budget.");
  };
  for(const entry of [...scope.state.discovered.originalEpochs!.entries,...(scope.state.discovered.structuralEpochs?.entries??[]),...scope.state.discovered.ambientEpochs])add(entry);
  for(const target of scope.state.writeTargets) if(scope.state.discovered.newborns.includes(logicalKey(target))) {
    assertSourceCommitOutputHeadReserved(tx,workspaceId,target);
    const own=artifactPermissionEpochIdentities(target.kind,{id:target.id})[0];
    if(own)add(own);
  }
  return deepFreeze([...identities.entries()].sort(([a],[b])=>compare(a,b)).map(([,identity])=>identity));
}

/** Internal pure fence comparison. Observations MUST come from a fresh same-TX
 * read; this returns no replacement saved vector or semantic serving authority.
 * Unused newborn rows may be absent, but every originally held key is required. */
export function isSourceCommitHeldPermissionUnionCurrent(tx:Prisma.TransactionClient,workspaceId:string,
  observed:readonly (PermissionEpochIdentity & {epoch:string})[]):boolean {
  const scope=currentScope(tx);
  invariant(scope.state.workspaceId===workspaceId,409,"SOURCE_LOCK_UNCOVERED","Permission batch workspace is unplanned.");
  if(!Array.isArray(observed)||observed.length>scope.state.maxNodes)return false;
  const allowed=new Set(sourceCommitPermissionReadIdentities(tx,workspaceId).map(identity=>JSON.stringify([identity.kind,identity.id])));
  const current=new Map<string,string>();
  for(const entry of observed) {
    if(!entry||typeof entry.kind!=="string"||typeof entry.id!=="string"||typeof entry.epoch!=="string"||!/^(0|[1-9][0-9]*)$/.test(entry.epoch))return false;
    const key=JSON.stringify([entry.kind,entry.id]);
    if(!allowed.has(key)||current.has(key))return false;
    current.set(key,entry.epoch);
  }
  const held=[...scope.state.discovered.originalEpochs!.entries,...(scope.state.discovered.structuralEpochs?.entries??[]),...scope.state.discovered.ambientEpochs];
  return held.every(entry=>current.get(JSON.stringify([entry.kind,entry.id]))===entry.epoch);
}
