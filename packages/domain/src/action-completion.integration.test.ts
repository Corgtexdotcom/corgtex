import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMcpOAuthGrantEpoch, decryptSecret, mcpCredentialVersion, mcpScopesHash, prisma,
  runWithMcpOrigin, type AppActor, type McpOrigin } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { completeAction, createAction, getAction, updateAction } from "./actions";
import { ACTION_COMPLETION_PUBLIC_NOTE, getActionCompletionOutcomeInputRoots,
  isActionCompletionPublicNoteReadable } from "./action-completion";
import { createArticle } from "./brain";
import { createDocument } from "./documents";
import { withMcpToolInput } from "./mcp-tool-input";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";

const txHooks = vi.hoisted(() => ({transaction: undefined as undefined | ((work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>)}));
vi.mock("@corgtex/shared", async () => {
  const actual = await vi.importActual<typeof import("@corgtex/shared")>("@corgtex/shared");
  return {...actual, prisma: new Proxy(actual.prisma, {get(target, key) {
    return key === "$transaction" && txHooks.transaction ? txHooks.transaction : Reflect.get(target, key);
  }})};
});

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || database.pathname !== "/corgtex_test"
  || database.searchParams.get("schema") !== "public") throw new Error("Action completion tests require the disposable loopback corgtex_test database.");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

async function fixture(kind: "agent" | "oauth" = "agent", separateAssignee = false) {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({data: {name: "Synthetic Action completion", slug: `action-completion-${suffix}`}});
  const user = await prisma.user.create({data: {email: `action-completion-${suffix}@example.test`, displayName: "Synthetic action human", passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR", kind: "HUMAN"}});
  const separateAssigneeUser = separateAssignee ? await prisma.user.create({data: {
    email: `action-assignee-${suffix}@example.test`, displayName: "Synthetic assignee", passwordHash: "synthetic"}}) : null;
  const assignee = separateAssigneeUser
    ? await prisma.member.create({data: {workspaceId: workspace.id, userId: separateAssigneeUser.id,
      role: "CONTRIBUTOR", kind: "HUMAN"}}) : member;
  const secondUser = await prisma.user.create({data: {email: `action-reader-${suffix}@example.test`, displayName: "Synthetic action reader", passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: secondUser.id, role: "CONTRIBUTOR", kind: "HUMAN"}});
  const reader: AppActor = {kind: "user", user: {id: secondUser.id, email: secondUser.email, displayName: secondUser.displayName}};
  const human: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: user.displayName}};
  const action = await createAction(human, {workspaceId: workspace.id, title: "Synthetic original title canary",
    bodyMd: "Synthetic original body canary", isPrivate: false, assigneeMemberId: assignee.id});
  let actor: AppActor;
  let origin: McpOrigin;
  let grantId: string;
  if (kind === "agent") {
    const credential = await prisma.agentCredential.create({data: {workspaceId: workspace.id, label: "Synthetic write-only agent",
      tokenHash: `synthetic-${suffix}`, scopes: ["actions:write"]}});
    actor = {kind: "agent", authProvider: "credential", label: credential.label, workspaceIds: [workspace.id],
      credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), scopes: ["actions:write"]};
    origin = {kind, id: credential.id, workspaceId: workspace.id, credentialVersion: mcpCredentialVersion(credential.tokenHash),
      scopeHash: mcpScopesHash(credential.scopes), requiredScopes: ["actions:write"]};
    grantId = credential.id;
  } else {
    const client = await prisma.mcpOAuthClient.create({data: {clientId: `action-completion-${suffix}`, name: "Synthetic OAuth client",
      redirectUris: ["https://synthetic.example.test/callback"], scopes: ["actions:write"]}});
    const token = await prisma.mcpOAuthAccessToken.create({data: {workspaceId: workspace.id, userId: user.id, clientId: client.id,
      instanceSlug: "selfserve", tokenHash: `synthetic-oauth-${suffix}`, scopes: ["actions:write"],
      expiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 3_600_000)}});
    const epoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, workspace.id, token.id));
    actor = human;
    origin = {kind, id: token.id, workspaceId: workspace.id, scopeHash: mcpScopesHash(token.scopes), grantEpoch: epoch,
      requiredScopes: ["actions:write"]};
    grantId = token.id;
  }
  const args = {actionId: action.id, completedVia: "  Exact native completion note canary  "};
  const complete = () => runWithMcpOrigin(origin, () => withMcpToolInput(actor,
    {workspaceId: workspace.id, toolName: "complete_action", args, requiredScopes: ["actions:write"]},
    supplied => completeAction(actor, {workspaceId: workspace.id, ...supplied})));
  return {workspace, action, actor, human, reader, member, assignee, args, origin, grantId, complete};
}

beforeEach(async () => { await truncateAllTables(); });
afterEach(() => { txHooks.transaction = undefined; vi.restoreAllMocks(); });

describe("native Action completion transaction", () => {
  it("completes through the actual native MCP wrapper with write-only grants and preserves the complete old body proof", async () => {
    const f = await fixture();
    const prior = await prisma.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    const result = await f.complete();
    expect(result).toEqual({id: f.action.id, status: "COMPLETED"});
    expect(JSON.stringify(result)).not.toMatch(/title|body|canary|completedVia/);
    const current = await prisma.action.findUniqueOrThrow({where: {id: f.action.id}});
    expect(current).toMatchObject({title: f.action.title, bodyMd: f.action.bodyMd, version: f.action.version,
      completedVia: f.args.completedVia.trim(), status: "COMPLETED"});
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id,
      [{kind: "Action", id: current.id, fingerprint: lineageContentFingerprint("Action", current)}])).toBe(false);
    const preserved = await prisma.artifactInputSnapshot.findFirstOrThrow({where: {sourceKind: "Action", sourceId: f.action.id}});
    expect(preserved.contentJson).toMatchObject({title: f.action.title, bodyMd: f.action.bodyMd, status: "OPEN"});
    expect(preserved.permissionEpochsJson).toEqual(prior.permissionEpochsJson);
    expect(preserved.rootsJson).toEqual(prior.rootsJson);
    const latest = await prisma.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    expect(latest.origin).toBe("DERIVED");
    expect(latest.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({kind: "ArtifactInputSnapshot"}),
      expect.objectContaining({kind: "ConversationOperationOutcome"})]));
    expect(JSON.stringify(latest.rootsJson)).not.toContain('"kind":"McpToolInput"');
    const publicNote = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    expect(publicNote).toMatchObject({actorKind: "public", userId: null, credentialId: null, requiredScopes: [],
      controlJson: {completedVia: f.args.completedVia.trim(), audience: "ACTION_READERS", publicationPolicyVersion: 1}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, publicNote)).toBe(true);
    const input = await prisma.mcpToolInput.findFirstOrThrow({where: {workspaceId: f.workspace.id, toolName: "complete_action"}});
    expect(decryptSecret(input.argumentsJson as string)).toBe(JSON.stringify(f.args));
    const publicView = await getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id});
    expect(publicView).toMatchObject({completedVia: f.args.completedVia.trim()});
    expect(JSON.stringify(publicView)).not.toContain(input.id);
    expect(JSON.stringify(publicView)).not.toContain(publicNote.controlJson && typeof publicNote.controlJson === "object"
      && !Array.isArray(publicNote.controlJson) ? String(publicNote.controlJson.controlHash) : "private-control-hash");
    const fact = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id, operation: "ACTION_COMPLETED"}});
    const factManifest = await prisma.artifactInputLineage.findFirstOrThrow({where: {artifactType: "ConversationOperationOutcome", artifactId: fact.id}});
    expect(factManifest).toMatchObject({origin: "NATIVE_ORIGINAL", rootsJson: [], inputsJson: []});
    await expect(getActionCompletionOutcomeInputRoots(f.actor, f.workspace.id, result)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({kind: "ConversationOperationOutcome"})]));
    await expect(getActionCompletionOutcomeInputRoots(f.actor, f.workspace.id, {...result})).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    const audit = await prisma.auditLog.findFirstOrThrow({where: {workspaceId: f.workspace.id, action: "action.completed"}});
    expect(JSON.stringify(audit.meta)).not.toMatch(/title|body|canary/);
  });

  it.each(["unknown", "stale"] as const)("does not recertify %s old content while committing an independent native status", async mode => {
    const f = await fixture();
    if (mode === "unknown") await prisma.artifactInputLineage.deleteMany({where: {artifactType: "Action", artifactId: f.action.id}});
    else {
      await prisma.action.update({where: {id: f.action.id}, data: {isPrivate: true}});
      await prisma.action.update({where: {id: f.action.id}, data: {isPrivate: false}});
    }
    await expect(f.complete()).resolves.toEqual({id: f.action.id, status: "COMPLETED"});
    const latest = await prisma.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    expect(latest.origin).toBe("UNKNOWN");
    expect(latest.rootsJson).toEqual([]);
    const snapshot = await prisma.artifactInputSnapshot.findFirstOrThrow({where: {sourceKind: "Action", sourceId: f.action.id}});
    expect(snapshot.contentJson).toMatchObject({bodyMd: f.action.bodyMd});
  });

  it("rolls status, snapshots, manifests, audit, and outbox back if the native outcome cannot commit", async () => {
    const f = await fixture();
    const original = prisma.$transaction.bind(prisma) as <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    txHooks.transaction = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => original(tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "conversationOperationOutcome") return {...target.conversationOperationOutcome,
          create: async () => { throw new Error("Synthetic native status marker failure"); }};
        return Reflect.get(target, key);
      },
    })));
    await expect(f.complete()).rejects.toThrow("Synthetic native status marker failure");
    expect(await prisma.action.findUniqueOrThrow({where: {id: f.action.id}})).toMatchObject({status: "OPEN", completedVia: null});
    expect(await prisma.artifactInputSnapshot.count({where: {sourceKind: "Action", sourceId: f.action.id}})).toBe(0);
    expect(await prisma.artifactInputLineage.count({where: {artifactType: "Action", artifactId: f.action.id}})).toBe(1);
    expect(await prisma.auditLog.count({where: {workspaceId: f.workspace.id, action: "action.completed"}})).toBe(0);
    expect(await prisma.event.count({where: {workspaceId: f.workspace.id, type: "action.updated"}})).toBe(0);
    expect(await prisma.conversationOperationOutcome.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  });

  it("does not revive an earlier native status receipt after actual Action privacy revoke and restore", async () => {
    const f = await fixture(); const result = await f.complete();
    await prisma.action.update({where: {id: f.action.id}, data: {isPrivate: true}});
    await expect(getActionCompletionOutcomeInputRoots(f.actor, f.workspace.id, result)).rejects.toBeDefined();
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
    await prisma.action.update({where: {id: f.action.id}, data: {isPrivate: false}});
    await expect(getActionCompletionOutcomeInputRoots(f.actor, f.workspace.id, result)).rejects.toBeDefined();
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
  });

  it("holds the actual OAuth command epoch through its status effect while concurrent scope revocation waits", async () => {
    const f = await fixture("oauth");
    const entered = deferred(); const resume = deferred();
    const independent = new PrismaClient({datasources: {db: {url: process.env.DATABASE_URL!}}});
    const original = prisma.$transaction.bind(prisma) as <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    txHooks.transaction = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => original(tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "action") return {...target.action, update: async (args: Parameters<typeof tx.action.update>[0]) => {
          const updated = await target.action.update(args);
          if (args.data.status === "COMPLETED") { entered.resolve(); await resume.promise; }
          return updated;
        }};
        return Reflect.get(target, key);
      },
    })));
    const completion = f.complete();
    let revocation: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, completion.then(() => { throw new Error("Status fence was not exercised"); })]);
      revocation = independent.mcpOAuthAccessToken.update({where: {id: f.grantId}, data: {scopes: []}});
      const pendingRevocation = revocation;
      let revoked = false;
      pendingRevocation.then(() => { revoked = true; }, () => undefined);
      await vi.waitFor(async () => {
        const blocked = await independent.$queryRaw<Array<{blocked: boolean}>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%McpOAuthAccessToken%' AND pid <> pg_backend_pid()) AS blocked`;
        expect(blocked[0]?.blocked).toBe(true);
      }, {timeout: 2_000, interval: 20});
      expect(revoked).toBe(false);
      resume.resolve();
      const finished = await Promise.allSettled([completion, pendingRevocation]);
      // A committed effect is permitted under the old locked grant. Its outgoing
      // acknowledgment must still satisfy the newly current grant after commit.
      const action = await independent.action.findUniqueOrThrow({where: {id: f.action.id}});
      expect(action.status).toBe("COMPLETED");
      expect(await independent.conversationOperationOutcome.count({where: {workspaceId: f.workspace.id, operation: "ACTION_COMPLETED"}})).toBe(1);
      expect(finished[1].status).toBe("fulfilled");
      if (finished[0].status === "fulfilled") expect(finished[0].value).toEqual({id: f.action.id, status: "COMPLETED"});
      else expect(String(finished[0].reason)).toMatch(/MCP_AUTHORIZATION_REVOKED|SOURCE_CHANGED|SOURCE_RESTRICTED|revoked|changed/i);
      await expect(f.complete()).rejects.toBeDefined();
      expect(await independent.conversationOperationOutcome.count({where: {workspaceId: f.workspace.id}})).toBe(2);
    } finally {
      resume.resolve();
      await Promise.allSettled([completion, ...(revocation ? [revocation] : [])]);
      await independent.$disconnect();
    }
  });
  it.each(["agent", "oauth"] as const)("preserves known public body and explicitly published completion note for both ordinary human readers after %s completion", async kind => {
    const f = await fixture(kind);
    for (const reader of [f.human, f.reader]) {
      await expect(getAction(reader, {workspaceId: f.workspace.id, actionId: f.action.id})).resolves.toMatchObject({bodyMd: f.action.bodyMd, status: "OPEN"});
    }
    await f.complete();
    for (const reader of [f.human, f.reader]) {
      await expect(getAction(reader, {workspaceId: f.workspace.id, actionId: f.action.id})).resolves.toMatchObject({
        bodyMd: f.action.bodyMd, completedVia: f.args.completedVia.trim(), status: "COMPLETED"});
    }
    if (kind === "agent") await prisma.agentCredential.update({where: {id: f.grantId}, data: {isActive: false}});
    else await prisma.mcpOAuthAccessToken.update({where: {id: f.grantId}, data: {scopes: []}});
    for (const reader of [f.human, f.reader]) {
      await expect(getAction(reader, {workspaceId: f.workspace.id, actionId: f.action.id})).resolves.toMatchObject({
        bodyMd: f.action.bodyMd, completedVia: f.args.completedVia.trim(), status: "COMPLETED"});
    }
  });

  it("admits brain:read OAuth and credential principals to the published note's original Action audience", async () => {
    const f = await fixture();
    await f.complete();
    const note = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    const client = await prisma.mcpOAuthClient.create({data: {clientId: `action-brain-reader-${randomUUID()}`,
      name: "Synthetic brain reader", redirectUris: ["https://synthetic.example.test/callback"], scopes: ["brain:read"]}});
    const token = await prisma.mcpOAuthAccessToken.create({data: {workspaceId: f.workspace.id, userId: f.reader.user.id,
      clientId: client.id, instanceSlug: "selfserve", tokenHash: `synthetic-reader-${randomUUID()}`, scopes: ["brain:read"],
      expiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 3_600_000)}});
    const grantEpoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, f.workspace.id, token.id));
    const readerOrigin: McpOrigin = {kind: "oauth", id: token.id, workspaceId: f.workspace.id,
      scopeHash: mcpScopesHash(token.scopes), grantEpoch, requiredScopes: []};
    expect(await runWithMcpOrigin(readerOrigin,
      () => isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note))).toBe(true);
    const credential = await prisma.agentCredential.create({data: {workspaceId: f.workspace.id,
      label: "Synthetic brain reader", tokenHash: `synthetic-reader-${randomUUID()}`, scopes: ["brain:read"]}});
    const agent: AppActor = {kind: "agent", authProvider: "credential", label: credential.label,
      workspaceIds: [f.workspace.id], credentialId: credential.id,
      credentialVersion: mcpCredentialVersion(credential.tokenHash), scopes: ["brain:read"]};
    const agentOrigin: McpOrigin = {kind: "agent", id: credential.id, workspaceId: f.workspace.id,
      credentialVersion: mcpCredentialVersion(credential.tokenHash), scopeHash: mcpScopesHash(credential.scopes),
      requiredScopes: []};
    expect(await runWithMcpOrigin(agentOrigin,
      () => isActionCompletionPublicNoteReadable(agent, f.workspace.id, note))).toBe(true);
    await prisma.mcpOAuthAccessToken.update({where: {id: token.id}, data: {scopes: []}});
    expect(await runWithMcpOrigin(readerOrigin,
      () => isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note))).toBe(false);
  });

  it("retains an authenticated historical public note when its Action is reopened", async () => {
    const f = await fixture();
    await f.complete();
    const note = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    const published = note.controlJson as {publishedActionRevision: number; completedActionFingerprint: string};
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(true);
    const reopened = await updateAction(f.human, {workspaceId: f.workspace.id, actionId: f.action.id, status: "OPEN"});
    expect(reopened).toMatchObject({status: "OPEN", completedVia: null});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(true);
    await prisma.agentCredential.update({where: {id: f.grantId}, data: {isActive: false}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(true);
    await expect(captureArtifactInputProof(f.reader, f.workspace.id,
      [{kind: "ConversationOperationOutcome", id: note.id}])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "ConversationOperationOutcome", id: note.id})]));
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).resolves.toMatchObject({
      bodyMd: f.action.bodyMd, status: "OPEN"});
    const historic = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      artifactType: "Action", artifactId: f.action.id, revision: published.publishedActionRevision}});
    expect(historic).toMatchObject({origin: "DERIVED", contentHash: published.completedActionFingerprint});
  });

  it("keeps the standing note readable when its former assignee leaves but current readers remain", async () => {
    const f = await fixture("agent", true);
    await f.complete();
    const note = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(true);
    await prisma.member.update({where: {id: f.assignee.id}, data: {isActive: false}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(true);
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).resolves.toMatchObject({
      bodyMd: f.action.bodyMd, completedVia: f.args.completedVia.trim()});
  });

  it("retains a pre-existing public Action's genuine private copied ancestry before and after native completion", async () => {
    const f = await fixture();
    const privateOriginal = await createArticle(f.human, {workspaceId: f.workspace.id, slug: `private-original-${randomUUID()}`,
      title: "Synthetic private original", type: "PROJECT", bodyMd: "Synthetic privately copied body canary", isPrivate: true});
    // Reproduce an old producer's public state with authentic DERIVED evidence;
    // current new-public writers correctly reject private source publication.
    await prisma.$transaction(async tx => {
      const roots = await captureArtifactInputProof(f.human, f.workspace.id, [{kind: "BrainArticle", id: privateOriginal.id}], tx);
      const copied = await tx.action.update({where: {id: f.action.id}, data: {bodyMd: privateOriginal.bodyMd}});
      await recordArtifactInputLineage({tx, actor: f.human, workspaceId: f.workspace.id, artifact: {kind: "Action", id: copied.id},
        content: copied, origin: "DERIVED", inputs: [], inheritedRoots: roots});
    });
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
    await expect(f.complete()).resolves.toEqual({id: f.action.id, status: "COMPLETED"});
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({kind: "BrainArticle", id: privateOriginal.id})]));
    const note = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(false);
  });

  it("withholds a copied body and note if a historical Action proof omitted its Document epoch", async () => {
    const f = await fixture();
    const document = await createDocument(f.human, {workspaceId: f.workspace.id, title: "Synthetic copied document",
      textContent: "Synthetic copied document body", source: "SYNTHETIC", storageKey: `synthetic/${randomUUID()}`});
    await prisma.$transaction(async tx => {
      const copied = await tx.action.update({where: {id: f.action.id}, data: {bodyMd: document.textContent}});
      await recordArtifactInputLineage({tx, actor: f.human, workspaceId: f.workspace.id,
        artifact: {kind: "Action", id: copied.id}, content: copied, origin: "DERIVED",
        inputs: [{kind: "Document", id: document.id}]});
    });
    const valid = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    const entries = (valid.permissionEpochsJson as {entries: Array<{kind: string; id: string; epoch: string}>}).entries;
    expect(entries.some(entry => entry.kind === "Document" && entry.id === document.id)).toBe(true);
    const malformedProof = {...valid.permissionEpochsJson as object,
      entries: entries.filter(entry => !(entry.kind === "Document" && entry.id === document.id))};
    await prisma.artifactInputLineage.create({data: {workspaceId: f.workspace.id, artifactType: "Action",
      artifactId: f.action.id, revision: valid.revision + 1, origin: "DERIVED", contentHash: valid.contentHash,
      inputsJson: valid.inputsJson as Prisma.InputJsonValue, rootsJson: valid.rootsJson as Prisma.InputJsonValue,
      epochProofVersion: 1, permissionEpochsJson: malformedProof}});
    await expect(f.complete()).resolves.toEqual({id: f.action.id, status: "COMPLETED"});
    const final = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      artifactType: "Action", artifactId: f.action.id}, orderBy: {revision: "desc"}});
    expect(final).toMatchObject({origin: "UNKNOWN", rootsJson: []});
    const note = await prisma.conversationOperationOutcome.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      operation: ACTION_COMPLETION_PUBLIC_NOTE}});
    await prisma.document.update({where: {id: document.id}, data: {accessDomain: "FINANCE"}});
    await prisma.document.update({where: {id: document.id}, data: {accessDomain: "WORKSPACE"}});
    expect(await isActionCompletionPublicNoteReadable(f.reader, f.workspace.id, note)).toBe(false);
    await expect(getAction(f.reader, {workspaceId: f.workspace.id, actionId: f.action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
  });

});
