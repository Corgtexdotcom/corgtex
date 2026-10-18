import { Prisma } from "@prisma/client";
import { getMcpOrigin, assertMcpOriginActive, mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { lockWorkspaceArchiveArtifact } from "./archive";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { assertDirectArtifactReadOutsideCapture, lineageContentFingerprint, sealArtifactInputActor, isArtifactInputProofReadable, type LineageRoot, withArtifactInputReadCapture, captureArtifactInputProof } from "./source-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof, type PermissionEpochProof } from "./source-permission-epochs";

type Kind = "CrmAccount" | "CrmContact" | "CrmDeal" | "CrmActivity";
type Row = { id: string; workspaceId: string; [key: string]: any };
const kinds: Kind[] = ["CrmActivity", "CrmDeal", "CrmContact", "CrmAccount"];
type ControlKind = Kind | "CrmConversation" | "CrmDealStageTransition";
const controlKinds: ControlKind[] = ["CrmConversation", "CrmDealStageTransition", ...kinds];
const models = { CrmAccount: "crmAccount", CrmContact: "crmContact", CrmDeal: "crmDeal", CrmActivity: "crmActivity", CrmConversation: "crmConversation", CrmDealStageTransition: "crmDealStageTransition" } as const;
const fields: Record<Kind, string[]> = {
  CrmAccount: ["name", "slug", "domain", "relationshipType", "lifecycleStage", "descriptionMd", "source", "tags", "ownerUserId"],
  CrmContact: ["accountId", "email", "name", "company", "title", "phone", "source", "tags", "avatarUrl", "lastSeenAt"],
  CrmDeal: ["accountId", "contactId", "title", "stage", "valueCents", "currency", "closedAt", "ownerUserId", "notes"],
  CrmActivity: ["accountId", "contactId", "dealId", "actorUserId", "ownerUserId", "completedByUserId", "type", "title", "bodyMd", "source", "sourceExternalId", "sourceUrl", "sourceOccurredAt", "dueAt", "completedAt"],
};
const links = [["dealId", "CrmDeal"], ["contactId", "CrmContact"], ["accountId", "CrmAccount"]] as const;
type Entry = { kind: Kind; id: string; fingerprint: string; manifestId: string; revision: number;
  parents: Array<{ kind: Kind; id: string; fingerprint: string }>; epochs: PermissionEpochProof; projected?: Row; projectionHash?: string };
type State = { actor: AppActor; workspaceId: string; origin: string; entries: Entry[]; ordinary: Array<{kind: Kind; id: string; fingerprint: string; manifestId: string; revision: number}>; roots: LineageRoot[] };
export type CrmDirectReadSession = Readonly<{ directPresentation: true }>;
const sessions = new WeakMap<CrmDirectReadSession, State>();
const boundRows = new WeakSet<object>();
const discardedRows = new WeakSet<object>();
const originIdentity = () => {
  const origin = getMcpOrigin();
  return JSON.stringify(origin ? [origin.kind, origin.id, origin.workspaceId, origin.credentialVersion ?? null,
    origin.scopeHash ?? null, origin.grantEpoch ?? null] : null);
};

/** A presentation capability is deliberately not a LineageRoot or a writer input. */
export function createCrmDirectReadSession(actor: AppActor, workspaceId: string): CrmDirectReadSession {
  assertDirectArtifactReadOutsideCapture();
  sealArtifactInputActor(actor);
  const session = Object.freeze({ directPresentation: true as const });
  sessions.set(session, { actor, workspaceId, origin: originIdentity(), entries: [], ordinary: [], roots: [] });
  return session;
}
function stateFor(session: CrmDirectReadSession) {
  assertDirectArtifactReadOutsideCapture();
  const state = sessions.get(session);
  invariant(state && state.origin === originIdentity(), 403, "MCP_AUTHORIZATION_REVOKED", "Direct read authority changed.");
  return state;
}
async function authority(state: State, tx: Prisma.TransactionClient) {
  invariant(state.origin === originIdentity(), 403, "MCP_AUTHORIZATION_REVOKED", "Direct read authority changed.");
  const { actor, workspaceId } = state;
  await requireWorkspaceMembership({ actor, workspaceId, tx });
  const origin = getMcpOrigin();
  if (origin) {
    await assertMcpOriginActive(tx, { ...origin, requiredScopes: [...new Set([...(origin.requiredScopes ?? []), "relationships:read"])] }, workspaceId);
    if (origin.kind === "oauth") {
      const token = await tx.mcpOAuthAccessToken.findUnique({ where: { id: origin.id } });
      invariant(actor.kind === "user" && token?.userId === actor.user.id && token.workspaceId === workspaceId
        && token.scopes.includes("relationships:read") && mcpScopesHash(token.scopes) === origin.scopeHash,
      403, "MCP_AUTHORIZATION_REVOKED", "Direct read authority changed.");
    } else invariant(actor.kind === "agent" && actor.authProvider === "credential" && actor.credentialId === origin.id
      && actor.credentialVersion === origin.credentialVersion && mcpScopesHash(actor.scopes ?? []) === origin.scopeHash,
    403, "MCP_AUTHORIZATION_REVOKED", "Direct read authority changed.");
  }
  if (actor.kind === "agent") {
    const credential = actor.authProvider === "credential" && actor.credentialId
      ? await tx.agentCredential.findUnique({ where: { id: actor.credentialId } }) : null;
    invariant(credential?.isActive && credential.workspaceId === workspaceId
      && mcpCredentialVersion(credential.tokenHash) === actor.credentialVersion
      && mcpScopesHash(credential.scopes) === mcpScopesHash(actor.scopes ?? [])
      && credential.scopes.includes("relationships:read"), 403, "AGENT_AUTHORIZATION_REVOKED", "Direct read authority changed.");
  }
}
async function latest(tx: Prisma.TransactionClient, workspaceId: string, kind: Kind, id: string) {
  return tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: kind, artifactId: id }, orderBy: { revision: "desc" } });
}
function original(manifest: Awaited<ReturnType<typeof latest>>, kind: Kind, row: Row, workspaceId: string) {
  const proof = parsePermissionEpochProof(manifest?.permissionEpochsJson);
  return Boolean(manifest && row.workspaceId === workspaceId && manifest.origin === "HUMAN_ORIGINAL"
    && Array.isArray(manifest.inputsJson) && manifest.inputsJson.length === 0
    && Array.isArray(manifest.rootsJson) && manifest.rootsJson.length === 0 && manifest.epochProofVersion === 1
    && proof?.entries.some(entry => entry.kind === kind && entry.id === row.id)
    && proof.entries.some(entry => entry.kind === "Workspace" && entry.id === workspaceId)
    && manifest.contentHash === lineageContentFingerprint(kind, row));
}
async function row(tx: Prisma.TransactionClient, workspaceId: string, kind: ControlKind, id: string): Promise<Row | null> {
  return (tx[models[kind]] as any).findFirst({ where: { workspaceId, id } });
}
/** Same lock order as CRM link writers; row locks also cover semantic changes
 * that do not bump permission epochs. Epoch locks are taken only afterwards. */
async function lockedClosure(tx: Prisma.TransactionClient, workspaceId: string, kind: Kind, ids: string[], additional: Array<{kind: ControlKind; id: string}> = []) {
  const wanted = new Map<ControlKind, Set<string>>(controlKinds.map(key => [key, new Set<string>()]));
  ids.forEach(id => wanted.get(kind)!.add(id));
  additional.forEach(value => wanted.get(value.kind)!.add(value.id));
  const rows = new Map<string, Row>();
  for (const current of controlKinds) {
    for (const id of [...wanted.get(current)!].sort()) {
      if (kinds.includes(current as Kind)) await lockWorkspaceArchiveArtifact(tx, current as Kind, id);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${current}"`)} WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`);
      const stored = await row(tx, workspaceId, current, id);
      invariant(stored, 409, "SOURCE_CHANGED", "A direct read relationship changed.");
      invariant(current !== "CrmDeal" || typeof stored.contactId === "string", 409, "SOURCE_CHANGED", "A required CRM relationship is unavailable.");
      rows.set(`${current}:${id}`, stored);
      for (const [field, parent] of links) if (stored[field] != null) wanted.get(parent)!.add(String(stored[field]));
    }
  }
  return rows;
}
function parentFree(kind: Kind, stored: Row) {
  return kind !== "CrmDeal" && links.every(([field]) => stored[field] == null);
}
function actualParents(kind: Kind, stored: Row, closure: Map<string, Row>): Entry["parents"] {
  const parents = new Map<string, Entry["parents"][number]>();
  const visit = (value: Row) => {
    for (const [field, parentKind] of links) {
      if (value[field] == null) continue;
      const key = `${parentKind}:${String(value[field])}`;
      if (key === `${kind}:${stored.id}` || parents.has(key)) continue;
      const parent = closure.get(key);
      invariant(parent, 409, "SOURCE_CHANGED", "A direct read relationship changed.");
      parents.set(key, {kind: parentKind, id: parent.id, fingerprint: lineageContentFingerprint(parentKind, parent)});
      visit(parent);
    }
  };
  visit(stored);
  return [...parents.values()];
}
async function latestPage(tx: Prisma.TransactionClient, workspaceId: string, kind: Kind, ids: string[]) {
  if (!ids.length) return new Map<string, NonNullable<Awaited<ReturnType<typeof latest>>>>();
  const manifests = await tx.$queryRaw<Array<NonNullable<Awaited<ReturnType<typeof latest>>>>>(Prisma.sql`
    SELECT DISTINCT ON ("artifactId") * FROM "ArtifactInputLineage"
    WHERE "workspaceId" = ${workspaceId} AND "artifactType" = ${kind} AND "artifactId" IN (${Prisma.join(ids)})
    ORDER BY "artifactId", revision DESC`);
  return new Map(manifests.map(manifest => [manifest.artifactId, manifest]));
}
/** Parent-free originals use precisely the same archive mutex identities and
 * scoped row locks as the ordinary closure, in kind/ID order. No payloads are
 * retained by this locking pass; all locks live until the delivery transaction ends. */
async function lockParentFreeEntries(state: State, tx: Prisma.TransactionClient) {
  for (const kind of kinds) {
    const ids = [...new Set(state.entries.filter(entry => entry.kind === kind).map(entry => entry.id))].sort();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const page = ids.slice(offset, offset + 100);
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(identity, 0))
        FROM (SELECT identity FROM unnest(ARRAY[${Prisma.join(page.map(id => `workspace_archive:${kind}:${id}`))}]::text[]) AS ids(identity) ORDER BY identity COLLATE "C") ordered`);
      const locked = await tx.$queryRaw<Array<{id: string}>>(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${kind}"`)}
        WHERE "workspaceId" = ${state.workspaceId} AND id IN (${Prisma.join(page)}) ORDER BY id COLLATE "C" FOR SHARE`);
      invariant(locked.length === page.length, 409, "SOURCE_CHANGED", "A direct read relationship changed.");
    }
  }
}
function canBatchDirect(state: State) {
  return !state.ordinary.length && !state.roots.length && state.entries.every(entry => entry.kind !== "CrmDeal" && !entry.parents.length);
}
async function checkParentFreeEntries(state: State, tx: Prisma.TransactionClient) {
  const epochs = new Map<string, PermissionEpochProof["entries"][number]>();
  for (const entry of state.entries) {
    invariant(!entry.projected || JSON.stringify(entry.projected) === entry.projectionHash, 409, "SOURCE_CHANGED", "The direct presentation changed.");
    for (const epoch of entry.epochs.entries) {
      const key = JSON.stringify([epoch.kind, epoch.id]);
      invariant(!epochs.has(key) || epochs.get(key)!.epoch === epoch.epoch, 409, "SOURCE_CHANGED", "Direct read authority changed.");
      epochs.set(key, epoch);
    }
  }
  const saved = [...epochs].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,epoch]) => epoch);
  for (let offset = 0; offset < saved.length; offset += 100) {
    const proof = {...state.entries[0].epochs, entries: saved.slice(offset, offset + 100)};
    invariant(await isArtifactPermissionEpochProofCurrent(state.workspaceId, proof, tx), 409, "SOURCE_CHANGED", "Direct read authority changed.");
  }
  for (const kind of kinds) {
    const entries = state.entries.filter(entry => entry.kind === kind);
    for (let offset = 0; offset < entries.length; offset += 100) {
      const page = entries.slice(offset, offset + 100), ids = page.map(entry => entry.id);
      const storedRows: Row[] = await (tx[models[kind]] as any).findMany({where: {workspaceId: state.workspaceId, id: {in: ids}}});
      const rows = new Map(storedRows.map(stored => [stored.id, stored]));
      const heads = await latestPage(tx, state.workspaceId, kind, ids);
      for (const entry of page) {
        const stored = rows.get(entry.id), head = heads.get(entry.id);
        invariant(stored && parentFree(kind, stored) && original(head ?? null, kind, stored, state.workspaceId)
          && head!.id === entry.manifestId && head!.revision === entry.revision
          && lineageContentFingerprint(kind, stored) === entry.fingerprint,
        409, "SOURCE_CHANGED", "The original CRM body changed before delivery.");
      }
    }
  }
}
function project(kind: Kind, stored: Row): Row {
  return { id: stored.id, workspaceId: stored.workspaceId,
    ...Object.fromEntries(fields[kind].map(field => [field, structuredClone(stored[field] ?? null)])),
    createdAt: structuredClone(stored.createdAt), updatedAt: structuredClone(stored.updatedAt), archivedAt: structuredClone(stored.archivedAt),
    // These independent free-text/label/relation contributions are never original-body proof.
    archivedByUserId: null, archiveReason: null, account: null, contact: null, deal: null,
  };
}
async function inTransaction<T>(db: Prisma.TransactionClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db === prisma ? prisma.$transaction(work) : work(db);
}

export async function admitCrmDirectOriginalRows<T extends { id: string }>(session: CrmDirectReadSession,
  kind: string, candidates: T[], db: Prisma.TransactionClient = prisma): Promise<T[]> {
  const state = stateFor(session);
  invariant(kinds.includes(kind as Kind), 400, "INVALID_INPUT", "Unsupported direct CRM kind.");
  const typedKind = kind as Kind;
  return inTransaction(db, async tx => {
    const eligible: Row[] = [];
    const candidateHeads = await latestPage(tx, state.workspaceId, typedKind, candidates.map(candidate => candidate.id));
    for (const candidate of candidates) {
      const stored = candidate as unknown as Row;
      if (original(candidateHeads.get(stored.id) ?? null, typedKind, stored, state.workspaceId)) eligible.push(stored);
    }
    if (!eligible.length) return [];
    const pageState: State = {...state, entries: [], ordinary: [], roots: []};
    const fast = eligible.every(stored => parentFree(typedKind, stored));
    let closure: Map<string, Row>;
    if (fast) {
      await lockParentFreeEntries({...pageState, entries: eligible.map(stored => ({kind: typedKind, id: stored.id}) as Entry)}, tx);
      const rows: Row[] = await (tx[models[typedKind]] as any).findMany({where: {workspaceId: state.workspaceId, id: {in: eligible.map(stored => stored.id)}}});
      invariant(rows.every(stored => parentFree(typedKind, stored)), 409, "SOURCE_CHANGED", "A direct read relationship changed.");
      closure = new Map(rows.map(stored => [`${kind}:${stored.id}`, stored]));
    } else closure = await lockedClosure(tx, state.workspaceId, typedKind, eligible.map(value => value.id));
    await authority(state, tx);
    const heads = await latestPage(tx, state.workspaceId, typedKind, eligible.map(stored => stored.id));
    const common = [{kind: "Workspace", id: state.workspaceId}];
    if (state.actor.kind === "user") common.push({kind: "MemberUserPolicy", id: state.actor.user.id}, {kind: "WorkspaceSupportPolicy", id: state.actor.user.id});
    else common.push({kind: "AgentCredential", id: state.actor.credentialId!});
    const origin = getMcpOrigin();
    if (origin?.kind === "oauth") common.push({kind: "McpOAuthGrantPolicy", id: origin.id});
    const pageEpochs = fast ? await capturePermissionEpochs(tx, state.workspaceId, [...common, ...eligible.map(stored => ({kind: typedKind, id: stored.id}))]) : undefined;
    const result: T[] = [];
    for (const candidate of eligible) {
      const stored = closure.get(`${kind}:${candidate.id}`)!;
      const manifest = heads.get(stored.id);
      if (!original(manifest ?? null, typedKind, stored, state.workspaceId)) continue;
      const parents = actualParents(typedKind, stored, closure);
      const identities = [...common, {kind: typedKind, id: stored.id}, ...parents];
      const keys = new Set(identities.map(value => JSON.stringify([value.kind, value.id])));
      const epochs = pageEpochs ? {...pageEpochs, entries: pageEpochs.entries.filter(value => keys.has(JSON.stringify([value.kind, value.id])))}
        : await capturePermissionEpochs(tx, state.workspaceId, identities);
      const projected = project(typedKind, stored);
      const entry: Entry = { projected, projectionHash: JSON.stringify(projected), kind: typedKind, id: stored.id, fingerprint: lineageContentFingerprint(typedKind, stored),
        manifestId: manifest!.id, revision: manifest!.revision, parents, epochs };
      pageState.entries.push(entry); result.push(projected as unknown as T);
    }
    await checkCurrent(pageState, tx, true, true);
    state.entries.push(...pageState.entries);
    for (const projected of result) boundRows.add(projected);
    return result;
  });
}
/** Count-only contributors retain their original authority/body stamps, not
 * their discarded presentation payload. Selected output projections stay bound. */
export function discardCrmDirectReadProjections(session: CrmDirectReadSession, rows: Array<{id:string}>) {
  const discarded=new Set(rows);
  for(const entry of stateFor(session).entries) if(entry.projected&&discarded.has(entry.projected)) {
    boundRows.delete(entry.projected);discardedRows.add(entry.projected);
    entry.projected=undefined;entry.projectionHash=undefined;
  }
}
async function lockContributors(state: State, tx: Prisma.TransactionClient) {
  if (canBatchDirect(state)) return lockParentFreeEntries(state, tx);
  await lockedClosure(tx, state.workspaceId, "CrmActivity", [], [...state.entries.flatMap(entry => [{kind: entry.kind, id: entry.id}, ...entry.parents]), ...state.ordinary, ...state.roots.flatMap(root => controlKinds.includes(root.kind as ControlKind) ? [{kind: root.kind as ControlKind, id: root.id}] : [])]);
}
async function checkCurrent(state: State, tx: Prisma.TransactionClient, directOnly = false, locked = false) {
  // Lock every contributor before any saved delivery epoch is checked.
  if (!locked) await lockContributors(state, tx);
  await authority(state, tx);
  if (canBatchDirect(state)) return checkParentFreeEntries(state, tx);
  for (const entry of directOnly ? [] : state.ordinary) {
    const stored = await row(tx, state.workspaceId, entry.kind, entry.id);
    const manifest = await latest(tx, state.workspaceId, entry.kind, entry.id);
    invariant(stored && lineageContentFingerprint(entry.kind, stored) === entry.fingerprint
      && manifest?.id === entry.manifestId && manifest.revision === entry.revision,
    409, "SOURCE_CHANGED", "An ordinary CRM contributor changed before delivery.");
  }
  invariant(directOnly || !state.roots.length || await isArtifactInputProofReadable(state.actor, state.workspaceId, state.roots, tx),
    409, "SOURCE_CHANGED", "CRM input permissions changed before delivery.");
  for (const entry of state.entries) {
    invariant(!entry.projected || JSON.stringify(entry.projected) === entry.projectionHash, 409, "SOURCE_CHANGED", "The direct presentation changed.");
    invariant(await isArtifactPermissionEpochProofCurrent(state.workspaceId, entry.epochs, tx), 409, "SOURCE_CHANGED", "Direct read authority changed.");
    const stored = await row(tx, state.workspaceId, entry.kind, entry.id);
    const manifest = await latest(tx, state.workspaceId, entry.kind, entry.id);
    invariant(stored && original(manifest, entry.kind, stored, state.workspaceId) && manifest!.id === entry.manifestId
      && manifest!.revision === entry.revision && lineageContentFingerprint(entry.kind, stored) === entry.fingerprint,
    409, "SOURCE_CHANGED", "The original CRM body changed before delivery.");
    for (const parent of entry.parents) {
      const current = await row(tx, state.workspaceId, parent.kind, parent.id);
      invariant(current && lineageContentFingerprint(parent.kind, current) === parent.fingerprint,
        409, "SOURCE_CHANGED", "A direct read relationship changed.");
    }
  }
}
async function withCurrent<T>(state: State, db: Prisma.TransactionClient, deliver: () => Promise<T>) {
  if (db !== prisma) {
    await checkCurrent(state, db);
    return deliver();
  }
  // Native replays only inspect ordinary contributing sources, before SQL locks.
  // The direct presentation capability deliberately never becomes a source root.
  const roots = [...state.roots];
  const preflight = roots.length ? await prepareArtifactCommitPreflight(state.actor, state.workspaceId, roots) : undefined;
  return prisma.$transaction(async tx => {
    await lockContributors(state, tx);
    const checked = async () => { await checkCurrent(state, tx, false, true); return deliver(); };
    return preflight ? withArtifactCommitPreflight(state.actor, state.workspaceId, tx, roots, preflight, checked) : checked();
  });
}
export async function assertCrmDirectReadCurrent(session: CrmDirectReadSession, db: Prisma.TransactionClient = prisma) {
  return withCurrent(stateFor(session), db, async () => undefined);
}
export const isCrmDirectOriginalRow = (value: object) => boundRows.has(value);

/** Remember ordinary contributors, including unreturned rows used for counts/ranks. */
export async function trackCrmDirectOrdinaryRows(session: CrmDirectReadSession, kind: string,
  rows: Array<{id: string}>, roots: LineageRoot[], db: Prisma.TransactionClient = prisma) {
  const state = stateFor(session);
  invariant(kinds.includes(kind as Kind), 400, "INVALID_INPUT", "Unsupported direct CRM kind.");
  for (const stored of rows) {
    const manifest = await latest(db, state.workspaceId, kind as Kind, stored.id);
    const fingerprint = lineageContentFingerprint(kind as Kind, stored);
    invariant(manifest?.contentHash === fingerprint, 409, "SOURCE_CHANGED", "A CRM contributor changed.");
    state.ordinary.push({kind: kind as Kind, id: stored.id, fingerprint, manifestId: manifest.id, revision: manifest.revision});
  }
  state.roots.push(...roots);
}
const results = new WeakMap<object, {session: CrmDirectReadSession; hash: string}>();
/** The trusted delivery boundary must reuse this exact result, not a cloned/cache blob. */
export async function finalizeCrmDirectReadResult<T extends object>(session: CrmDirectReadSession, result: T): Promise<T> {
  const seen = new WeakSet<object>();
  const assertNoDiscardedProjection = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    invariant(!discardedRows.has(value),409,"SOURCE_CHANGED","A discarded direct presentation cannot be delivered.");
    seen.add(value);
    for (const child of Object.values(value)) assertNoDiscardedProjection(child);
  };
  assertNoDiscardedProjection(result);
  const hash = JSON.stringify(result);
  await assertCrmDirectReadCurrent(session);
  invariant(JSON.stringify(result) === hash, 409, "SOURCE_CHANGED", "The direct presentation changed.");
  results.set(result, {session, hash});
  return result;
}
/** UI/HTTP callers invoke this after all awaits, immediately before emitting its JSON.
 * No generic source/copy/model reader accepts this private presentation capability. */
export async function serializeCrmDirectReadResult(actor: AppActor, result: object): Promise<string> {
  assertDirectArtifactReadOutsideCapture();
  const receipt = results.get(result);
  invariant(receipt && stateFor(receipt.session).actor === actor && JSON.stringify(result) === receipt.hash,
    409, "UNKNOWN_LINEAGE", "Direct presentation requires its exact delivery receipt.");
  return withCurrent(stateFor(receipt.session), prisma, async () => {
    invariant(JSON.stringify(result) === receipt.hash, 409, "SOURCE_CHANGED", "The direct presentation changed.");
    return receipt.hash;
  });
}

/** Predicate/count contributors have the same final source fence as output fields. */
export async function captureCrmDirectReadContributors<T>(actor: AppActor, workspaceId: string,
  session: CrmDirectReadSession | undefined, read: () => Promise<T>): Promise<T> {
  if (!session) return read();
  stateFor(session);
  const captured = await withArtifactInputReadCapture(actor, workspaceId, read);
  stateFor(session).roots.push(...captured.roots);
  return captured.value;
}

/** Ordinary decorations retain complete current proofs; originals never acquire
 * unproved relation labels/counts just because their own body is presentable. */
export async function renderCrmDirectAwareRow<T>(actor: AppActor, workspaceId: string,
  session: CrmDirectReadSession | undefined, kind: Kind, stored: Row, render: () => Promise<T>): Promise<T> {
  if (!session) return render();
  return captureCrmDirectReadContributors(actor, workspaceId, session, async () => {
    await captureArtifactInputProof(actor, workspaceId, [{kind, id: stored.id, snapshot: stored}]);
    return render();
  });
}
