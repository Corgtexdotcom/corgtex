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
}));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  auth = { test: async () => ({ ok: true, team_id: "T_SYNTHETIC", user_id: "U_BOT" }) };
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
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { captureSlackNativeMessageFetch, isCommunicationMessageNativeInputCurrent,
  claimSlackNativeCommitPreflight, inspectSlackNativeCommitClaim, prepareSlackNativeCommitPreflight,
  withClaimedSlackNativeCommitPreflight, withSlackNativeCommitPreflight, withSlackNativeCommitReceipt } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof,
  captureArtifactPermissionEpochs, isArtifactInputProofReadable, recordArtifactInputLineage } from "./source-lineage";
import { lineageContentFingerprint } from "./source-lineage";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;
async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `mixed-owner-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `mixed-other-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic mixed external commit", slug: `mixed-native-${suffix}` } });
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
    provider: "SLACK", externalWorkspaceId: "T_SYNTHETIC", appId: "APP_SYNTHETIC", botUserId: "U_BOT",
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
    await prisma.workspace.delete({ where: { id: f.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [f.user.id, f.other.id] } } });
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

  it.each(["slack", "box+slack", "mcp+slack", "box+mcp+slack"])("publishes %s with no provider transport in the transaction", async combination => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const roots = [
      ...(combination.includes("box") ? [f.roots[0]!] : []),
      ...(combination.includes("mcp") ? [f.roots[1]!] : []),
      ...slack.roots,
    ];
    const token = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.slackRead.mockClear();
    const output = await prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id, tx,
      roots, token, async () => {
        expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, slack.input, tx)).toBe(true);
        expect(await isCommunicationMessageNativeInputCurrent(f.actor, f.workspace.id, slack.input)).toBe(false);
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
      }));
    expect(output.id).toBeTruthy();
    expect(remote.slackRead).not.toHaveBeenCalled();
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id,
      tx, roots, token, async () => "reused"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
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
