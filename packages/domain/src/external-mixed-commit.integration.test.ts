import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMcpOAuthGrantEpoch, encryptSecret, mcpScopesHash, prisma,
  runWithMcpOrigin, type AppActor } from "@corgtex/shared";

const remote = vi.hoisted(() => ({
  box: { text: "Synthetic selected Box bytes" } as unknown,
  mcp: { structuredContent: { results: [{ id: "synthetic-hit" }] } } as unknown,
  boxRead: vi.fn(), mcpRead: vi.fn(), inTransaction: 0,
  slack: [{ type: "message", ts: "1700000000.000001", user: "U_PUBLIC", text: "Synthetic public Slack input" }],
  slackRead: vi.fn(),
  slackTeamId: "T_SYNTHETIC",
}));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  auth = { test: async () => ({ ok: true, team_id: remote.slackTeamId, user_id: "U_BOT" }) };
  conversations = {
    info: async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, is_private: false,
      is_archived: false, is_member: true } }),
    history: remote.slackRead,
    replies: remote.slackRead,
  };
} }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      const callback = args[0];
      return original(async (tx: any) => {
        remote.inTransaction++;
        try { return await callback(tx); } finally { remote.inTransaction--; }
      }, ...args.slice(1));
    };
  } });
  return { ...actual, prisma: instrumented };
});
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.boxRead,
  readExternalMcpNativeToolResult: remote.mcpRead,
}));

import { selectExternalContentSource } from "./external-content-sources";
import { captureExternalProviderFetchInput, isExternalProviderFetchInputCurrent,
  prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight } from "./external-provider-authority";
import { captureExternalMcpResponseInput, isExternalMcpResponseInputCurrent, prepareExternalMcpResponseCommitPreflight,
  withExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { prepareExternalMixedCommitPreflight, withExternalMixedCommitPreflight } from "./external-mixed-commit";
import { savedEnclosingNativeEpochs } from "./native-commit-original-vector";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight, lockArtifactReadAuthorityRows } from "./artifact-commit-preflight";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { captureSlackNativeMessageFetch, isCommunicationMessageNativeInputCurrent,
  claimSlackNativeCommitPreflight, inspectSlackNativeCommitClaim, prepareSlackNativeCommitPreflight,
  withClaimedSlackNativeCommitPreflight, withSlackNativeCommitPreflight, withSlackNativeCommitReceipt } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof,
  captureArtifactPermissionEpochs, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { lineageContentFingerprint } from "./source-lineage";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;
const oauthClients = new Set<string>();
const sourceWriterJobs = new Set<string>();
async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `mixed-owner-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `mixed-other-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic mixed external commit", slug: `mixed-native-${suffix}` } });
  remote.slackTeamId = `T_PUN68_ROOT_${suffix}`;
  await prisma.member.createMany({ data: [user.id, other.id].map(userId => ({ workspaceId: workspace.id, userId, role: "ADMIN", isActive: true })) });
  const actor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } } as AppActor;
  const otherActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } } as AppActor;
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: user.id,
    providerKey: "box", displayName: "Synthetic selected Box", serverUrl: "https://mcp.box.com",
    providerAccountId: "synthetic-box-owner", accessTokenEnc: encryptSecret("synthetic-only-token"),
    scopes: ["root_readwrite"], status: "ACTIVE" } });
  const source = await selectExternalContentSource(actor, { workspaceId: workspace.id, providerKey: "box",
    sourceKind: "FILE", externalId: "synthetic-file", connectionId: connection.id, title: "Selected synthetic file" });
  const provider = await captureExternalProviderFetchInput(actor, { workspaceId: workspace.id,
    externalContentSourceId: source.id, connectionId: connection.id, sourceKind: "FILE", externalId: "synthetic-file",
    toolName: "get_file_content", arguments: { file_id: "synthetic-file" } });
  const mcp = await captureExternalMcpResponseInput(actor, { workspaceId: workspace.id,
    connectionId: connection.id, mode: "SEARCH", query: "synthetic", limit: 1 });
  const roots = await captureArtifactInputProof(actor, workspace.id, [
    { kind: "ExternalProviderFetchInput", id: provider.input.id },
    { kind: "ExternalMcpResponseInput", id: mcp.input.id, snapshot: mcp.input },
  ]);
  return { user, other, workspace, actor, otherActor, connection, source, provider, mcp, roots };
}

async function addSlack(f: Fixture, index = 0, priorInstallation?: Awaited<ReturnType<typeof prisma.communicationInstallation.create>>) {
  const installation = priorInstallation ?? await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id,
    provider: "SLACK", externalWorkspaceId: remote.slackTeamId, appId: "APP_SYNTHETIC", botUserId: "U_BOT",
    botTokenEnc: encryptSecret("synthetic-slack-token"), scopes: ["channels:read", "channels:history"], status: "ACTIVE" } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id,
    installationId: installation.id, provider: "SLACK", externalChannelId: `C_PUBLIC_${index}`,
    name: "Synthetic public channel", kind: "PUBLIC", isIngestEnabled: true } });
  const messageTs = remote.slack[index]!.ts;
  const receipt = await captureSlackNativeMessageFetch({ workspaceId: f.workspace.id, installationId: installation.id,
    channelId: channel.externalChannelId, messageTs });
  const saved = await prisma.$transaction(async tx => {
    const stamp = new Date(Math.trunc(Number(messageTs) * 1000));
    const message = await tx.communicationMessage.create({ data: { workspaceId: f.workspace.id,
      installationId: installation.id, provider: "SLACK", externalChannelId: channel.externalChannelId,
      externalMessageId: messageTs, externalUserId: String(receipt.projected.user),
      text: String(receipt.projected.text), raw: receipt.projected as any, messageTs: stamp, receivedAt: stamp,
      expiresRawAt: new Date(Date.now() + 600_000), permalink: null } });
    const epochs = await capturePermissionEpochs(tx, f.workspace.id,
      artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: f.workspace.id,
      installationId: installation.id, communicationMessageId: message.id, provider: "SLACK",
      externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId,
      providerPrincipalId: receipt.providerPrincipalId, externalChannelId: channel.externalChannelId,
      externalMessageId: messageTs, externalUserId: message.externalUserId, threadExternalId: null,
      mode: "AUTHENTICATED_FETCH", ingressInputId: null,
      requestJson: { ...receipt.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", message) } as any,
      encryptedPayloadJson: encryptSecret(communicationCanonicalJson(receipt.payload)),
      projectedContentJson: receipt.projected as any,
      projectionHash: communicationNativeHash(communicationCanonicalJson(receipt.projected)),
      installationGrantHash: receipt.installationGrantHash, channelGrantHash: receipt.channelGrantHash,
      permissionEpochsJson: epochs as any, epochProofVersion: 1,
      expiresRawAt: message.expiresRawAt!, fetchedAt: new Date(receipt.capturedAtMs) } });
    await withSlackNativeCommitReceipt(f.actor, f.workspace.id, input.id, tx, receipt, () => recordArtifactInputLineage({
      tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "CommunicationMessage", id: message.id },
      content: message, origin: "DERIVED", inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }],
    }));
    return { message, input };
  });
  const roots = await captureArtifactInputProof(f.actor, f.workspace.id,
    [{ kind: "CommunicationMessage", id: saved.message.id }]);
  return { ...saved, installation, channel, roots };
}

afterEach(async () => {
  const f = current; current = null;
  if (f) {
    if (sourceWriterJobs.size) {
      await prisma.workflowJob.deleteMany({ where: { id: { in: [...sourceWriterJobs] } } });
      sourceWriterJobs.clear();
    }
    await prisma.workspace.delete({ where: { id: f.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [f.user.id, f.other.id] } } });
  }
  if (oauthClients.size) {
    await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: [...oauthClients] } } });
    oauthClients.clear();
  }
  remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.inTransaction = 0;
  remote.slackRead.mockClear();
  remote.box = { text: "Synthetic selected Box bytes" };
  remote.mcp = { structuredContent: { results: [{ id: "synthetic-hit" }] } };
  remote.slack = [{ type: "message", ts: "1700000000.000001", user: "U_PUBLIC", text: "Synthetic public Slack input" }];
});

describe("mixed selected Box and live MCP native commit scopes", () => {
  it.each(["box", "mcp"])("recovers %s original vector from an exact derived-only manifest", async provider => {
    const f = current = await fixture();
    const kind = provider === "box" ? "ExternalProviderFetchInput" : "ExternalMcpResponseInput";
    const id = provider === "box" ? f.provider.input.id : f.mcp.input.id;
    const initialRoots = f.roots.filter(root => root.kind === kind);
    const initial = provider === "box"
      ? await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, initialRoots)
      : await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, initialRoots);
    const source = await prisma.$transaction(tx => {
      const create = async () => {
        const row = await tx.brainSource.create({ data: { workspaceId: f.workspace.id,
          sourceType: "EXTERNAL_CONTENT", tier: 2, title: `Synthetic ${provider} derivative`, content: "Copied bytes" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "DERIVED",
          inputs: [{ kind, id } as { kind: "ExternalProviderFetchInput" | "ExternalMcpResponseInput"; id: string }] });
        return row;
      };
      return provider === "box"
        ? withExternalProviderCommitPreflight(f.actor, f.workspace.id, tx,
          initial as Awaited<ReturnType<typeof prepareExternalProviderRootCommitPreflight>>, create)
        : withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, tx,
          initial as Awaited<ReturnType<typeof prepareExternalMcpResponseCommitPreflight>>, create);
    });
    const roots = (await captureArtifactInputProof(f.actor, f.workspace.id,
      [{ kind: "BrainSource", id: source.id }])).filter(root => root.kind === "BrainSource");
    expect(roots).toHaveLength(1);
    if (provider === "box") {
      const token = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, roots);
      remote.boxRead.mockClear();
      await expect(prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id,
        tx, token, async () => "proven Box"))).resolves.toBe("proven Box");
      expect(remote.boxRead).not.toHaveBeenCalled();
    } else {
      const token = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, roots);
      remote.mcpRead.mockClear();
      await expect(prisma.$transaction(tx => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id,
        tx, token, async () => "proven MCP"))).resolves.toBe("proven MCP");
      expect(remote.mcpRead).not.toHaveBeenCalled();
    }
    await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: "BrainSource",
      artifactId: source.id, revision: 2, contentHash: lineageContentFingerprint("BrainSource", source),
      origin: "HUMAN_ORIGINAL", rootsJson: [], inputsJson: [] } });
    expect((await savedEnclosingNativeEpochs(f.workspace.id, roots, kind)).size).toBe(0);
  });

  it("rejects standalone nesting, then writes a complete mixed output with no SDK call in the transaction", async () => {
    const f = current = await fixture();
    const provider = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, f.roots);
    const mcp = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    await expect(prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id, tx, provider,
      () => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, tx, mcp, async () => "unreachable"))))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();

    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    const row = await prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id, tx, f.roots, token,
      async () => {
        expect(await isExternalProviderFetchInputCurrent(f.actor, f.workspace.id, f.provider.input, tx)).toBe(true);
        const output = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "EXTERNAL_CONTENT", tier: 2,
          title: "Mixed synthetic source", content: "Combined response", channel: "box" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: output.id }, content: output,
          origin: "DERIVED", inputs: [], inheritedRoots: f.roots });
        return output;
      }));
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id,
      await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: row.id }]))).toBe(true);
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id, tx,
      f.roots, token, async () => "reused"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("binds actor, workspace and complete roots before consuming its single-use capability", async () => {
    const f = current = await fixture();
    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.otherActor, f.workspace.id,
      tx, f.roots, token, async () => "wrong actor"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, randomUUID(),
      tx, f.roots, token, async () => "wrong workspace"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots.slice(0, 1), token, async () => "incomplete roots"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.boxRead).not.toHaveBeenCalled(); expect(remote.mcpRead).not.toHaveBeenCalled();
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots, token, async () => "valid"))).resolves.toBe("valid");
  });

  it("rejects a revoked and restored grant without native replay or work", async () => {
    const f = current = await fixture();
    const provider = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, f.roots);
    const mcp = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, f.roots);
    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    const work = vi.fn(async () => "wrong");
    await expect(prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id,
      tx, provider, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id,
      tx, mcp, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots, token, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled();
    expect(remote.boxRead).not.toHaveBeenCalled(); expect(remote.mcpRead).not.toHaveBeenCalled();
  });

  it("rejects either stale remote response before opening a writer transaction", async () => {
    const f = current = await fixture();
    remote.box = { text: "Changed selected Box bytes" };
    await expect(prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    remote.box = { text: "Synthetic selected Box bytes" };
    remote.mcp = { structuredContent: { results: [{ id: "changed-hit" }] } };
    await expect(prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.inTransaction).toBe(0);
  });
});

describe("complete Slack native commit closure", () => {
  it("recovers the originally consumed native vector from a message-only derived root", async () => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const roots = slack.roots.filter(root => root.kind === "CommunicationMessage");
    expect(roots).toHaveLength(1);
    const token = await prepareSlackNativeCommitPreflight(f.actor, f.workspace.id, roots);
    remote.slackRead.mockClear();
    await expect(prisma.$transaction(tx => withSlackNativeCommitPreflight(f.actor, f.workspace.id,
      tx, roots, token, async () => "proven message"))).resolves.toBe("proven message");
    expect(remote.slackRead).not.toHaveBeenCalled();
  });

  it("cannot trim or rewrite a claimed Slack closure to bypass a revoked Document", async () => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const document = await prisma.document.create({ data: { workspaceId: f.workspace.id,
      title: "Synthetic local contributor", source: "SYNTHETIC", storageKey: "synthetic-document",
      textContent: "Local input included in the Slack copy" } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const documentRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Document", id: document.id }]);
    const roots = [...slack.roots, ...documentRoots];
    const token = await prepareSlackNativeCommitPreflight(f.actor, f.workspace.id, roots);
    const work = vi.fn(async () => "unsafe copy");
    await prisma.$transaction(async tx => {
      const claim = claimSlackNativeCommitPreflight(f.actor, f.workspace.id, tx, token, roots);
      const inspected = inspectSlackNativeCommitClaim(claim);
      expect(Object.isFrozen(inspected.roots)).toBe(true);
      expect(() => (inspected.roots as typeof roots).splice(1, 1)).toThrow(TypeError);
      const exposedDocument = inspected.roots.find(root => root.kind === "Document")!;
      expect(Object.isFrozen(exposedDocument)).toBe(true);
      expect(() => Object.assign(exposedDocument, { fingerprint: "forged" })).toThrow(TypeError);
      await prisma.document.update({ where: { id: document.id }, data: { archivedAt: new Date() } });
      await expect(withClaimedSlackNativeCommitPreflight(f.actor, f.workspace.id, tx, claim, work))
        .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("withholds a malformed human original with declared but unproven inputs", async () => {
    const f = current = await fixture();
    const row = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id,
      sourceType: "RESEARCH", tier: 2, title: "Malformed historical original", content: "Synthetic sensitive text" } });
    const root = { kind: "BrainSource" as const, id: row.id,
      fingerprint: lineageContentFingerprint("BrainSource", row) };
    await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: root.kind,
      artifactId: root.id, revision: 1, contentHash: root.fingerprint, origin: "HUMAN_ORIGINAL",
      rootsJson: [], inputsJson: [{ kind: "Document", id: "unproved-input" }] } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, [root])).toBe(false);
    await expect(prisma.$transaction(tx => captureArtifactInputSnapshotProof(f.actor, f.workspace.id, root, tx)))
      .rejects.toMatchObject({ code: expect.stringMatching(/SOURCE_CHANGED|UNKNOWN_LINEAGE/) });
    // A snapshot saved by the older permissive path must not outlive the
    // malformed exact original receipt merely because its rootsJson is empty.
    const epochs = await prisma.$transaction(tx => captureArtifactPermissionEpochs(f.actor, f.workspace.id, [root], tx));
    const historical = await prisma.artifactInputSnapshot.create({ data: { workspaceId: f.workspace.id,
      sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint,
      origin: "HUMAN_ORIGINAL", contentJson: JSON.parse(JSON.stringify(row)),
      accessEnvelopeJson: { accessDomain: row.accessDomain, archivedAt: null },
      permissionEpochsJson: epochs as any, epochProofVersion: 1, rootsJson: [] } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, [{ kind: "ArtifactInputSnapshot",
      id: historical.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", historical) }])).toBe(false);
    await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: root.kind,
      artifactId: root.id, revision: 2, contentHash: root.fingerprint, origin: "HUMAN_ORIGINAL",
      rootsJson: [], inputsJson: [] } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, [{ kind: "ArtifactInputSnapshot",
      id: historical.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", historical) }])).toBe(false);
    const newlyBound = await prisma.$transaction(tx => captureArtifactInputSnapshotProof(f.actor, f.workspace.id, root, tx));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, newlyBound)).toBe(true);
  });

  it("requires every native message in a two-message closure and preserves owner binding", async () => {
    const f = current = await fixture();
    remote.slack.push({ type: "message", ts: "1700000001.000002", user: "U_PUBLIC", text: "Second public input" });
    const first = await addSlack(f, 0);
    const second = await addSlack(f, 1, first.installation);
    const roots = [...first.roots, ...second.roots];
    const token = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    const work = vi.fn(async () => "published");
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.otherActor, f.workspace.id,
      tx, roots, token, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id,
      tx, roots.slice(0, 1), token, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    remote.slackRead.mockClear();
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id,
      tx, roots, token, async () => {
        expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, first.input, tx)).toBe(true);
        expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, second.input, tx)).toBe(true);
        return work();
      }))).resolves.toBe("published");
    expect(work).toHaveBeenCalledOnce();
    expect(remote.slackRead).not.toHaveBeenCalled();
  });

  it.each(["box", "mcp", "box+mcp", "slack", "box+slack", "mcp+slack", "box+mcp+slack"])("publishes %s with source rows before epochs and no transport in the transaction", async combination => {
    const f = current = await fixture();
    const slack = combination.includes("slack") ? await addSlack(f) : undefined;
    const roots = [
      ...(combination.includes("box") ? [f.roots[0]!] : []),
      ...(combination.includes("mcp") ? [f.roots[1]!] : []),
      ...(slack?.roots ?? []),
    ];
    const token = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.slackRead.mockClear();
    const lockEvents: string[] = [];
    const reserve = vi.fn();
    const output = await prisma.$transaction(async connection => {
      const tx = new Proxy(connection, { get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key, target);
        return (...args: any[]) => {
          const sql = typeof args[0]?.sql === "string" ? args[0].sql : Array.isArray(args[0]) ? args[0].join("?") : "";
          lockEvents.push(sql);
          return (target.$queryRaw as (...args: any[]) => Promise<any>)(...args);
        };
      } });
      reserve.mockImplementation(async () => {
        expect(lockEvents.some(sql => /FROM "(ExternalProviderFetchInput|ExternalMcpResponseInput|CommunicationMessageNativeInput)"/.test(sql))).toBe(true);
        expect(lockEvents.some(sql => sql.includes('FROM "SourcePermissionEpoch"'))).toBe(false);
        await lockArtifactReadAuthorityRows(f.actor, f.workspace.id, tx);
        lockEvents.push("reserved-source-rows");
        // Reservation is inert: no native scope exists before the full proof.
        if (slack) expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, slack.input, tx)).toBe(false);
        if (combination.includes("box")) expect(await isExternalProviderFetchInputCurrent(f.actor, f.workspace.id, f.provider.input, tx)).toBe(false);
        if (combination.includes("mcp")) expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, f.mcp.input, tx)).toBe(false);
      });
      return withArtifactCommitPreflight(f.actor, f.workspace.id, tx, roots, token, async () => {
        if (slack) {
          expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, slack.input, tx)).toBe(true);
          expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, slack.input)).toBe(false);
        }
        if (combination.includes("box")) {
          expect(await isExternalProviderFetchInputCurrent(f.actor, f.workspace.id, f.provider.input, tx)).toBe(true);
          expect(await isExternalProviderFetchInputCurrent(f.actor, f.workspace.id, f.provider.input)).toBe(false);
        }
        if (combination.includes("mcp")) {
          expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, f.mcp.input, tx)).toBe(true);
          expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, f.mcp.input)).toBe(false);
        }
        const row = await tx.brainSource.create({ data: { workspaceId: f.workspace.id,
          sourceType: "EXTERNAL_CONTENT", tier: 2, title: `Synthetic ${combination}`, content: "Combined public evidence" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "DERIVED",
          inputs: [], inheritedRoots: roots });
        return row;
      }, { beforeSourceEpochs: reserve });
    });
    expect(output.id).toBeTruthy();
    expect(reserve).toHaveBeenCalledOnce();
    expect(lockEvents.findIndex(sql => sql.includes('FROM "SourcePermissionEpoch"')))
      .toBeGreaterThan(lockEvents.indexOf("reserved-source-rows"));
    expect(remote.slackRead).not.toHaveBeenCalled();
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id,
      tx, roots, token, async () => "reused"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it.each(["box", "mcp", "box+mcp", "slack", "box+slack", "mcp+slack", "box+mcp+slack"])(
    "composes the full source plan with actual %s adapters and a preallocated derived writer", async combination => {
      const f = current = await fixture();
      const slack = combination.includes("slack") ? await addSlack(f) : undefined;
      const roots = [
        ...(combination.includes("box") ? [f.roots[0]!] : []),
        ...(combination.includes("mcp") ? [f.roots[1]!] : []),
        ...(slack?.roots ?? []),
      ];
      const originalRoots = structuredClone(roots);
      const job = await prisma.workflowJob.create({ data: { workspaceId: f.workspace.id,
        type: "synthetic.source-writer", payload: { requesterUserId: f.user.id }, status: "RUNNING",
        attempts: 1, lockedAt: new Date(), lockedBy: "synthetic-local-owner" } });
      sourceWriterJobs.add(job.id);
      const outputId = randomUUID();
      const options = { writeTargets: [{ kind: "BrainSource" as const, id: outputId,
        projectedAuthority: { sourceType: "EXTERNAL_CONTENT", accessDomain: "WORKSPACE", informationCategory: "GENERAL" } }],
      ownerBinding: { kind: "WORKFLOW_JOB" as const, id: job.id, generation: 1,
        lockedBy: job.lockedBy, lockedAt: job.lockedAt!.toISOString(), requesterUserId: f.user.id } };
      const token = await prepareArtifactSourceCommit(f.actor, f.workspace.id, roots, options);
      remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.slackRead.mockClear();
      const queries: string[] = [];
      const output = await prisma.$transaction(async connection => {
        const tx = new Proxy(connection, { get(target, key) {
          if (key !== "$queryRaw") return Reflect.get(target, key, target);
          return (...args: any[]) => {
            const sql = typeof args[0]?.sql === "string" ? args[0].sql : Array.isArray(args[0]) ? args[0].join("?") : "";
            queries.push(sql);
            return (target.$queryRaw as (...args: any[]) => Promise<any>)(...args);
          };
        } });
        return withArtifactSourceCommit(f.actor, f.workspace.id, tx, roots, options, token, async (bound, binding) => {
          const [current] = await bound.$queryRaw<Array<{ status: string; attempts: number; lockedBy: string; lockedAt: Date; payload: { requesterUserId: string } }>>`
            SELECT "status", "attempts", "lockedBy", "lockedAt", "payload" FROM "WorkflowJob"
            WHERE "id" = ${job.id} AND "workspaceId" = ${f.workspace.id} FOR UPDATE`;
          expect(binding).toEqual(options.ownerBinding);
          expect(current?.status).toBe("RUNNING"); expect(current?.attempts).toBe(1);
          expect(current?.lockedBy).toBe(options.ownerBinding.lockedBy);
          expect(current?.lockedAt.toISOString()).toBe(options.ownerBinding.lockedAt);
          expect(current?.payload.requesterUserId).toBe(f.user.id);
        }, async () => {
          const row = await tx.brainSource.create({ data: { id: outputId, workspaceId: f.workspace.id,
            sourceType: "EXTERNAL_CONTENT", tier: 2, title: "Synthetic complete planned output", content: "Combined permitted inputs" } });
          await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
            artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
          expect((await readableArtifactIds(f.actor, f.workspace.id, "BrainSource", [row], tx)).has(row.id)).toBe(true);
          return row;
        });
      }, { timeout: 30_000 });
      expect(output.id).toBe(outputId); expect(roots).toEqual(originalRoots);
      const firstUnion = queries.findIndex(query => query.includes('FROM "SourcePermissionEpoch"') && query.includes("FOR SHARE"));
      expect(firstUnion).toBeGreaterThan(0);
      expect(queries.filter(query => query.includes('FROM "SourcePermissionEpoch"') && query.includes("FOR SHARE"))).toHaveLength(1);
      expect(queries.slice(firstUnion + 1).filter(query => /FROM "(ExternalContentSource|ExternalProviderFetchInput|ExternalMcpResponseInput|CommunicationMessageNativeInput|Workspace|Member|User)"/.test(query)
        && /FOR (SHARE|UPDATE)/.test(query))).toEqual([]);
      expect(remote.boxRead).not.toHaveBeenCalled(); expect(remote.mcpRead).not.toHaveBeenCalled(); expect(remote.slackRead).not.toHaveBeenCalled();
      const manifest = await prisma.artifactInputLineage.findFirst({ where: { workspaceId: f.workspace.id,
        artifactType: "BrainSource", artifactId: outputId }, orderBy: { revision: "desc" } });
      expect(manifest?.rootsJson).toEqual(roots);
      // A public Slack channel is shared inside its workspace. Owner-bound Box
      // and MCP inputs still restrict every mixture that consumes them.
      expect((await readableArtifactIds(f.otherActor, f.workspace.id, "BrainSource", [output])).size)
        .toBe(combination === "slack" ? 1 : 0);
      await expect(prisma.$transaction(tx => withArtifactSourceCommit(f.actor, f.workspace.id, tx,
        roots, options, token, async () => {}, async () => "reused"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    });

  it.each(["insert", "restore", "undeclared-category", "omitted-category"])(
    "rejects %s output category drift without adopting new authority", async mutation => {
      const f = current = await fixture();
      const roots = [f.roots[0]!];
      const originalRoots = structuredClone(roots);
      const job = await prisma.workflowJob.create({ data: { workspaceId: f.workspace.id,
        type: "synthetic.source-writer", payload: { requesterUserId: f.user.id }, status: "RUNNING",
        attempts: 1, lockedAt: new Date(), lockedBy: "synthetic-local-owner" } });
      sourceWriterJobs.add(job.id);
      const outputId = randomUUID();
      const options = { writeTargets: [{ kind: "BrainSource" as const, id: outputId,
        projectedAuthority: { sourceType: "EXTERNAL_CONTENT", accessDomain: "WORKSPACE",
          ...(mutation === "omitted-category" ? {} : { informationCategory: "GENERAL" }) } }],
        ownerBinding: { kind: "WORKFLOW_JOB" as const, id: job.id, generation: 1,
          lockedBy: job.lockedBy, lockedAt: job.lockedAt!.toISOString(), requesterUserId: f.user.id } };
      const token = await prepareArtifactSourceCommit(f.actor, f.workspace.id, roots, options);
      expect(await prisma.informationCategoryPolicy.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      if (mutation === "insert" || mutation === "restore") {
        const policy = await prisma.informationCategoryPolicy.create({ data: { workspaceId: f.workspace.id,
          category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [] } });
        if (mutation === "restore") await prisma.informationCategoryPolicy.delete({ where: { id: policy.id } });
      }
      const work = vi.fn(async (tx: Parameters<typeof recordArtifactInputLineage>[0]["tx"]) => {
        const row = await tx.brainSource.create({ data: { id: outputId, workspaceId: f.workspace.id,
          sourceType: "EXTERNAL_CONTENT", tier: 2, title: "Uncommitted synthetic output", content: "Permitted input",
          informationCategory: mutation === "undeclared-category" ? "OTHER" : "GENERAL" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      });
      await expect(prisma.$transaction(tx => withArtifactSourceCommit(f.actor, f.workspace.id, tx,
        roots, options, token, async (bound) => {
          const [owner] = await bound.$queryRaw<Array<{ id: string }>>`SELECT id FROM "WorkflowJob"
            WHERE id = ${job.id} AND "workspaceId" = ${f.workspace.id} AND status = 'RUNNING'
              AND attempts = 1 AND "lockedBy" = ${job.lockedBy} FOR UPDATE`;
          expect(owner?.id).toBe(job.id);
        }, () => work(tx)), { timeout: 30_000 })).rejects.toMatchObject({ code:
          mutation === "insert" || mutation === "restore" ? "SOURCE_CHANGED" : "SOURCE_LOCK_UNCOVERED" });
      if (mutation === "insert" || mutation === "restore") expect(work).not.toHaveBeenCalled();
      expect(await prisma.brainSource.count({ where: { id: outputId } })).toBe(0);
      expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactId: outputId } })).toBe(0);
      expect(roots).toEqual(originalRoots);
      expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    });

  it("denies a restored local channel epoch and a changed remote message without copying", async () => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const roots = slack.roots;
    const token = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    await prisma.communicationChannel.update({ where: { id: slack.channel.id }, data: { kind: "PRIVATE" } });
    await prisma.communicationChannel.update({ where: { id: slack.channel.id }, data: { kind: "PUBLIC" } });
    remote.slackRead.mockClear();
    const work = vi.fn(async () => "unreachable");
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id,
      tx, roots, token, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled(); expect(remote.slackRead).not.toHaveBeenCalled();
    remote.slack[0] = { ...remote.slack[0]!, text: "Changed provider bytes" };
    await expect(prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("denies a native-first replay before SDK when the same user's OAuth grant lacks a document ancestor scope", async () => {
    const f = current = await fixture();
    const document = await prisma.document.create({ data: { workspaceId: f.workspace.id,
      title: "Synthetic private query contributor", source: "SYNTHETIC", storageKey: "synthetic-key",
      textContent: "Private document text embedded in a later provider query", metadata: {} } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const documentRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Document", id: document.id }]);
    const client = await prisma.mcpOAuthClient.create({ data: { clientId: `native-closure-${randomUUID()}`,
      name: "Synthetic narrow OAuth", redirectUris: ["https://synthetic.example.test"],
      scopes: ["external-tools:read"] } });
    oauthClients.add(client.id);
    const token = await prisma.mcpOAuthAccessToken.create({ data: { workspaceId: f.workspace.id,
      userId: f.user.id, clientId: client.id, instanceSlug: "selfserve", tokenHash: `synthetic-${randomUUID()}`,
      scopes: ["external-tools:read"], expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 3_600_000) } });
    const grantEpoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, f.workspace.id, token.id));
    const origin = { kind: "oauth" as const, id: token.id, workspaceId: f.workspace.id,
      scopeHash: mcpScopesHash(token.scopes), grantEpoch };
    const roots = [f.roots[1]!, ...documentRoots]; // Deliberately put the provider root first.
    remote.mcpRead.mockClear(); remote.boxRead.mockClear(); remote.slackRead.mockClear();
    await expect(runWithMcpOrigin(origin,
      () => prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.mcpRead).not.toHaveBeenCalled();
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.slackRead).not.toHaveBeenCalled();
  });

  it.each(["proof", "list", "capture"].flatMap(api => ["response", "privacy", "manifest"].map(change => [api, change] as const)))(
    "admits the full primary %s closure and rechecks %s changes after replay", async (api, change) => {
    const f = current = await fixture();
    const canary = "SYNTHETIC_DOCUMENT_QUERY_CANARY";
    const document = await prisma.document.create({ data: { workspaceId: f.workspace.id,
      title: "Synthetic query contributor", source: "SYNTHETIC", storageKey: "synthetic-key", textContent: canary } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const native = await captureExternalMcpResponseInput(f.actor, { workspaceId: f.workspace.id,
      connectionId: f.connection.id, mode: "SEARCH", query: canary, limit: 1 });
    const inputs = [{ kind: "Document" as const, id: document.id },
      { kind: "ExternalMcpResponseInput" as const, id: native.input.id }];
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, change === "privacy" ? inputs : inputs.reverse());
    const plan = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    const account = await prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id, tx, roots, plan, async () => {
      const row = await tx.crmAccount.create({ data: { workspaceId: f.workspace.id, name: "Synthetic derived account",
        slug: `derived-${randomUUID()}`, descriptionMd: "Synthetic provider and document synthesis" } });
      await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: { kind: "CrmAccount", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      return row;
    }));
    const bodyRoot = { kind: "CrmAccount" as const, id: account.id, fingerprint: lineageContentFingerprint("CrmAccount", account) };
    const replacement = change === "manifest" ? await captureExternalMcpResponseInput(f.actor, { workspaceId: f.workspace.id,
      connectionId: f.connection.id, mode: "SEARCH", query: "NEW_SYNTHETIC_CONTRIBUTOR", limit: 1 }) : undefined;
    const replacementRoots = replacement ? await captureArtifactInputProof(f.actor, f.workspace.id,
      [{ kind: "ExternalMcpResponseInput", id: replacement.input.id }, { kind: "Document", id: document.id }]) : undefined;
    const replacementPlan = replacementRoots ? await prepareArtifactCommitPreflight(f.actor, f.workspace.id, replacementRoots) : undefined;
    const client = await prisma.mcpOAuthClient.create({ data: { clientId: `primary-closure-${randomUUID()}`,
      name: "Synthetic primary read client", redirectUris: ["https://synthetic.example.test"],
      scopes: ["relationships:read", "external-tools:read", "brain:read"] } });
    oauthClients.add(client.id);
    const grant = async (scopes: string[]) => {
      const token = await prisma.mcpOAuthAccessToken.create({ data: { workspaceId: f.workspace.id,
        userId: f.user.id, clientId: client.id, instanceSlug: "selfserve", tokenHash: `synthetic-${randomUUID()}`,
        scopes, expiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 3_600_000) } });
      return { kind: "oauth" as const, id: token.id, workspaceId: f.workspace.id, scopeHash: mcpScopesHash(scopes),
        grantEpoch: await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, f.workspace.id, token.id)) };
    };
    const runRead = async (allowed: boolean, captureError = "UNKNOWN_LINEAGE") => {
      if (api === "proof") expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, [bodyRoot])).toBe(allowed);
      else if (api === "list") expect(await readableArtifactIds(f.actor, f.workspace.id, "CrmAccount", [account]))
        .toEqual(new Set(allowed ? [account.id] : []));
      else if (allowed) expect(await captureArtifactInputProof(f.actor, f.workspace.id,
        [{ kind: "CrmAccount", id: account.id }])).not.toHaveLength(0);
      else await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "CrmAccount", id: account.id }]))
        .rejects.toMatchObject({ code: captureError });
    };
    const denied = await grant(["relationships:read", "external-tools:read"]);
    remote.mcpRead.mockClear();
    await runWithMcpOrigin(denied, () => runRead(false));
    expect(remote.mcpRead).not.toHaveBeenCalled();
    const permitted = await grant(["relationships:read", "external-tools:read", "brain:read"]);
    await runWithMcpOrigin(permitted, () => runRead(true));
    const replays = remote.mcpRead.mock.calls.length;
    expect(replays).toBeGreaterThan(0);
    for (const call of remote.mcpRead.mock.calls) expect(call[1]).toMatchObject({ arguments: { query: canary } });
    if (change === "privacy") remote.mcpRead.mockImplementationOnce(async () => {
      if (remote.inTransaction) throw new Error("MCP SDK called during a writer transaction.");
      await prisma.document.update({ where: { id: document.id }, data: { accessDomain: "FINANCE" } });
      return structuredClone(remote.mcp);
    });
    else if (change === "manifest") remote.mcpRead.mockImplementationOnce(async () => {
      if (remote.inTransaction) throw new Error("MCP SDK called during a writer transaction.");
      const originalResponse = structuredClone(remote.mcp);
      await prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id, tx,
        replacementRoots!, replacementPlan!, () => recordArtifactInputLineage({ tx, actor: f.actor,
          workspaceId: f.workspace.id, artifact: { kind: "CrmAccount", id: account.id }, content: account,
          origin: "DERIVED", inputs: [], inheritedRoots: replacementRoots })));
      remote.mcp = { structuredContent: { results: [{ id: "changed-synthetic-replacement" }] } };
      return originalResponse;
    });
    else remote.mcp = { structuredContent: { results: [{ id: "changed-synthetic-hit" }] } };
    await runWithMcpOrigin(permitted, () => runRead(false,
      change === "privacy" ? "PERMISSION_CHANGED" : change === "manifest" ? "SOURCE_CHANGED" : "UNKNOWN_LINEAGE"));
    expect(remote.mcpRead.mock.calls.length).toBeGreaterThan(replays);
    if (change === "manifest") {
      expect(remote.mcpRead.mock.calls.length).toBe(replays + 1);
      expect(remote.mcpRead.mock.calls.at(-1)?.[1]).toMatchObject({ arguments: { query: canary } });
    }
  });
});

remote.boxRead.mockImplementation(async () => {
  if (remote.inTransaction) throw new Error("Box SDK called during a writer transaction.");
  return structuredClone(remote.box);
});
remote.mcpRead.mockImplementation(async () => {
  if (remote.inTransaction) throw new Error("MCP SDK called during a writer transaction.");
  return structuredClone(remote.mcp);
});
remote.slackRead.mockImplementation(async (request: { oldest?: string; latest?: string }) => {
  if (remote.inTransaction) throw new Error("Slack SDK called during a writer transaction.");
  return { ok: true, messages: structuredClone(remote.slack.filter(message => message.ts === request.oldest)), has_more: false };
});
