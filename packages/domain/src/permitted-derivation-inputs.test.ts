import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument } from "../../agents/src/agents/model-consumer.test-fixture";
vi.mock("@corgtex/shared", async () => ({ prisma: fixture.prisma, ...await import("../../shared/src/mcp-context"), env: {},
  encryptSecret: (value: string) => `synthetic-encrypted:${value}`, decryptSecret: (value: string) => value.slice("synthetic-encrypted:".length) }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/knowledge", () => ({ extractTextFromFileBuffer: vi.fn() }));
const slack = vi.hoisted(() => ({ remote: { type: "message", ts: "1700000000.000001", user: "U_AUTHOR", text: "Public native message" },
  principal: "U_BOT", auth: vi.fn(), info: vi.fn(), history: vi.fn() }));
vi.mock("@slack/web-api", () => ({ WebClient: class { auth = { test: slack.auth }; conversations = { info: slack.info, history: slack.history }; } }));
import { preparePermittedDerivationInputs, derivationHash } from "./permitted-derivation-inputs";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import { captureDirectMemberTranscriptInput, directMemberTranscriptRoots } from "./native-transcript-input";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import { inspectStoredArtifactInputDependencyIdentities } from "./context-graph-retirement";
import { captureSlackNativeMessageFetch } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { lineageContentFingerprint } from "./source-lineage";

const epochs = new Map<string, bigint>();
beforeEach(async () => {
  await resetFixture(); epochs.clear();
  slack.remote = { type: "message", ts: "1700000000.000001", user: "U_AUTHOR", text: "Public native message" }; slack.principal = "U_BOT";
  slack.auth.mockImplementation(async () => ({ ok: true, team_id: "T_TEST", user_id: slack.principal }));
  slack.info.mockResolvedValue({ ok: true, channel: { id: "C_PUBLIC", is_private: false, is_member: true, is_archived: false } });
  slack.history.mockImplementation(async () => ({ ok: true, messages: [slack.remote] }));
  for (const name of ["communicationInstallation", "communicationChannel", "communicationMessage", "communicationMessageNativeInput", "workspaceIntegrationBinding"]) {
    fixture.rows[name] = [];
    const match = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
    fixture.prisma[name] = { findFirst: vi.fn(async ({ where }: any) => fixture.rows[name].find(row => match(row, where)) ?? null),
      findUnique: vi.fn(async () => null), findMany: vi.fn(async ({ where }: any) => fixture.rows[name].filter(row => {
        const { id, ...rest } = where; return match(row, rest) && (typeof id === "object" ? id.in.includes(row.id) : !id || id === row.id);
      })) };
  }
  fixture.prisma.$executeRaw = vi.fn(async (sql: any) => {
    if (sql.strings?.join("").includes('INSERT INTO "SourcePermissionEpoch"')) {
      for (let i = 0; i < sql.values.length; i += 4) {
        const [, ws, kind, id] = sql.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]);
        if (!epochs.has(key)) epochs.set(key, 0n);
      }
    }
    return 1;
  });
  fixture.prisma.$queryRaw = vi.fn(async (sql: any) => {
    if (!sql.strings?.join("").includes('FROM "SourcePermissionEpoch"')) return [];
    const [ws, ...pairs] = sql.values; const result = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
      if (epoch !== undefined) result.push({ sourceKind, sourceId, epoch });
    }
    return result;
  });
  fixture.rows.contextGraphObject = [];
  fixture.prisma.contextGraphObject = { findFirst: vi.fn(async ({ where }: any) => fixture.rows.contextGraphObject.find(row =>
    Object.entries(where).every(([key, value]) => row[key] === value)) ?? null) };
  fixture.rows.nativeTranscriptInput = [];
  fixture.prisma.nativeTranscriptInput = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `native-${fixture.rows.nativeTranscriptInput.length}`, createdAt: fixture.timestamp,
        meetingAudioAssetId: null, sourceRecordId: null, connectionId: null, recordingId: null,
        fileHash: null, storageKey: null, fileSizeBytes: null, grantHash: null, ...data };
      fixture.rows.nativeTranscriptInput.push(row); return { ...row };
    }),
    findFirst: vi.fn(async ({ where }: any) => fixture.rows.nativeTranscriptInput.find(row =>
      Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
  };
  for (const name of ["brainArticleVersion", "workspaceArchiveRecord"]) {
    fixture.rows[name] = []; fixture.prisma[name] = { findMany: vi.fn(async () => []) };
  }
});
const original = async (id: string, privateInput = false) => {
  const row = fixture.add("brainArticle", { id, workspaceId, title: privateInput ? "PRIVATE ARTICLE" : "Public original",
    bodyMd: privateInput ? "PRIVATE BODY" : "Original public facts", slug: id, isPrivate: privateInput,
    ownerMemberId: "member-beta", variantOfArticleId: null, authority: "REFERENCE", archivedAt: null });
  await known("BrainArticle", row); return row;
};
const document = async (id: string) => {
  const row = fixture.add("document", { id, workspaceId, title: "Permitted document", textContent: "Public document facts",
    accessDomain: "WORKSPACE", archivedAt: null, authorMemberId: null, metadata: { privateInternal: "DO NOT PROMPT" }, storageKey: "DO NOT PROMPT" });
  await knownCopiedDocument(row); return row;
};
describe("independently permitted derivation input capture with real source gates", () => {
  it("admits full current public document and human article, excludes private and foreign inputs", async () => {
    const doc = await document("doc"); const publicArticle = await original("public"); const restricted = await original("private", true);
    const foreign = fixture.add("document", { id: "foreign", workspaceId: "ws-b", textContent: "FOREIGN BODY" });
    const result = await preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId,
      [{ kind: "Document", id: doc.id }, { kind: "BrainArticle", id: publicArticle.id }, { kind: "BrainArticle", id: restricted.id }, { kind: "Document", id: foreign.id }], []);
    expect(result?.sources.map(source => source.id).sort()).toEqual(["doc", "public"]);
    expect(JSON.stringify(result?.sources)).not.toMatch(/PRIVATE|FOREIGN|DO NOT PROMPT/);
    expect(result?.roots.some(root => root.kind === "Document" && root.id === doc.id)).toBe(true);
    expect(result?.roots.some(root => root.kind === "BrainSource" && root.id === `original-${doc.id}`)).toBe(true);
    expect(result?.permissionEpochs.entries.some(entry => entry.kind === "Document" && entry.id === doc.id)).toBe(true);
  });
  it("excludes the old canonical body and derived wrapper containing its immutable snapshot", async () => {
    const canonical = await original("canonical"); const safe = await document("safe");
    const wrapper = fixture.add("brainSource", { id: "wrapper", workspaceId, title: "OLD WRAPPER", content: canonical.bodyMd, accessDomain: "WORKSPACE", archivedAt: null });
    await known("BrainSource", wrapper, [{ kind: "BrainArticle", id: canonical.id }]);
    const result = await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId,
      [{ kind: "BrainArticle", id: canonical.id }, { kind: "BrainSource", id: wrapper.id }, { kind: "Document", id: safe.id }], [{ kind: "BrainArticle", id: canonical.id }]);
    expect(result?.sources.map(source => source.id)).toEqual([safe.id]);
    expect(result?.roots.some(root => root.kind === "BrainArticle" && root.id === canonical.id)).toBe(false);
  });
  it("never uses UNKNOWN or model-derived domain wrappers as independently authored leaves", async () => {
    const unknown = fixture.add("brainArticle", { id: "unknown", workspaceId, title: "UNKNOWN", bodyMd: "UNKNOWN", isPrivate: false, archivedAt: null });
    const base = await original("base");
    const generated = fixture.add("brainArticle", { id: "generated", workspaceId, title: "GENERATED", bodyMd: "GENERATED", isPrivate: false, archivedAt: null });
    await known("BrainArticle", generated, [{ kind: "BrainArticle", id: base.id }]);
    expect(await preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId,
      [{ kind: "BrainArticle", id: unknown.id }, { kind: "BrainArticle", id: generated.id }], [])).toBeNull();
  });
  it("rechecks exact body revision after locking before returning the projection", async () => {
    const doc = await document("changed");
    const execute = fixture.prisma.$executeRaw.getMockImplementation();
    fixture.prisma.$executeRaw.mockImplementation(async (sql: any, ...values: any[]) => {
      if (values.includes(`workspace_archive:Document:${doc.id}`)) {
        fixture.rows.document.find(row => row.id === doc.id).textContent = "Changed while locking";
      }
      return execute!(sql, ...values);
    });
    await expect(preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId, [{ kind: "Document", id: doc.id }], [])).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
  it("permission epochs forbid privacy loss-and-restore even with byte-identical body", async () => {
    const doc = await document("epochs");
    const proof = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Document", id: doc.id }]);
    const prepared = await preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId, [{ kind: "Document", id: doc.id }], []);
    const key = JSON.stringify([workspaceId, "Document", doc.id]); epochs.set(key, epochs.get(key)! + 2n);
    const { isArtifactPermissionEpochProofCurrent } = await import("./source-permission-epochs");
    expect(await isArtifactPermissionEpochProofCurrent(workspaceId, prepared?.permissionEpochs, fixture.prisma)).toBe(false);
    expect(proof.length).toBeGreaterThan(0);
  });
  it("recipe hashes ignore JSONB object key ordering but preserve source array ordering/revisions", () => {
    expect(derivationHash({ b: { z: 1, a: 2 }, a: 3 })).toBe(derivationHash({ a: 3, b: { a: 2, z: 1 } }));
    expect(derivationHash([1, 2])).not.toBe(derivationHash([2, 1]));
  });
  it.each(["target", "historical-derived", "immutable-snapshot"])("rejects a legacy %s missing captured epochs without recertifying its ancestry", async location => {
    const doc = await document("legacy-document");
    const graph = fixture.add("contextGraphObject", { id: "legacy-derived-graph", workspaceId, title: "Preserved old derived title", properties: {} });
    if (location === "immutable-snapshot") {
      const proof = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Document", id: doc.id }], fixture.prisma);
      const immutable = await captureImmutableArtifactInputProof(alpha, workspaceId, proof, fixture.prisma);
      await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "ContextGraphObject", id: graph.id },
        content: graph, origin: "DERIVED", inputs: [], inheritedRoots: immutable });
    } else await known("ContextGraphObject", graph, [{ kind: "Document", id: doc.id }], alpha);
    const identity = { kind: "ContextGraphObject" as const, id: graph.id };
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, identity)).complete).toBe(true);
    const legacy = location === "target" ? fixture.manifest("ContextGraphObject", graph.id)
      : location === "historical-derived" ? fixture.manifest("Document", doc.id)
        : fixture.rows.artifactInputSnapshot.find(row => row.sourceKind === "Document" && row.sourceId === doc.id);
    expect(legacy.rootsJson.length).toBeGreaterThan(0);
    const originalProof = { epochProofVersion: legacy.epochProofVersion, permissionEpochsJson: legacy.permissionEpochsJson };
    const beforeRows = fixture.rows.artifactInputLineage.length;
    const beforeEpochs = [...epochs.entries()];
    legacy.epochProofVersion = null; legacy.permissionEpochsJson = null;
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, identity)).complete).toBe(false);
    expect(fixture.rows.artifactInputLineage).toHaveLength(beforeRows);
    expect([...epochs.entries()]).toEqual(beforeEpochs);
    expect(graph.title).toBe("Preserved old derived title");
    Object.assign(legacy, originalProof);
    // Historical identity discovery may use a proven old receipt after privacy
    // changes. Current model input admission still performs its own live gates.
    epochs.set(JSON.stringify([workspaceId, "Document", doc.id]), 2n);
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, identity)).complete).toBe(true);
  });
  it("recognizes known immutable native transcript snapshots, admitting only the actual current owner", async () => {
    const submission = { workspaceId, transcript: "Owner's exact native transcript", title: "Native meeting" };
    const receipt = await captureDirectMemberTranscriptInput(alpha, { workspaceId, submission });
    const nativeRoots = await directMemberTranscriptRoots(alpha, workspaceId, submission, receipt);
    const native = fixture.rows.nativeTranscriptInput[0];
    const meeting = fixture.add("meeting", { id: "native-meeting", workspaceId, title: submission.title, source: "SYNTHETIC",
      transcript: submission.transcript, archivedAt: null });
    await known("MeetingTranscript", meetingTranscriptInputProjection(meeting), [{ kind: "NativeTranscriptInput", id: native.id }], alpha);
    const own = await preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId, [{ kind: "MeetingTranscript", id: meeting.id }], []);
    expect(own?.sources).toEqual([expect.objectContaining({ kind: "MeetingTranscript", content: submission.transcript })]);
    expect(own?.permissionEpochs.entries).toContainEqual(expect.objectContaining({ kind: "NativeTranscriptInput", id: native.id }));
    expect(await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId, [{ kind: "MeetingTranscript", id: meeting.id }], [])).toBeNull();
    const graph = fixture.add("contextGraphObject", { id: "native-derived-graph", workspaceId, title: "Derived native fact", properties: {} });
    const promptProof = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "MeetingTranscript", id: meeting.id }], fixture.prisma);
    const immutable = await captureImmutableArtifactInputProof(alpha, workspaceId, promptProof, fixture.prisma);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "ContextGraphObject", id: graph.id },
      content: graph, origin: "DERIVED", inputs: [], inheritedRoots: immutable });
    const historical = await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: graph.id });
    expect(historical.complete).toBe(true);
    expect(historical.dependencies).toContainEqual({ kind: "NativeTranscriptInput", id: native.id });
    const rawGraph = fixture.add("contextGraphObject", { id: "raw-native-graph", workspaceId, title: "Known native original capture", properties: {} });
    await known("ContextGraphObject", rawGraph, [{ kind: "MeetingTranscript", id: meeting.id }], alpha);
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: rawGraph.id })).complete).toBe(true);
    const consumed = fixture.manifest("MeetingTranscript", meeting.id); const captured = consumed.permissionEpochsJson;
    consumed.permissionEpochsJson = null;
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: rawGraph.id })).complete).toBe(false);
    consumed.permissionEpochsJson = captured;
    const cipher = native.encryptedPayloadJson; native.encryptedPayloadJson = "edited immutable payload";
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: rawGraph.id })).complete).toBe(false);
    native.encryptedPayloadJson = cipher;
    expect(fixture.rows.artifactInputSnapshot).toContainEqual(expect.objectContaining({ sourceKind: "NativeTranscriptInput", origin: "NATIVE_ORIGINAL" }));
    const epochKey = JSON.stringify([workspaceId, "NativeTranscriptInput", native.id]); epochs.set(epochKey, (epochs.get(epochKey) ?? 0n) + 2n);
    const { isArtifactInputProofReadable } = await import("./source-lineage");
    expect(await isArtifactInputProofReadable(alpha, workspaceId, nativeRoots, fixture.prisma)).toBe(false);
  });
  it("does not promote UNKNOWN native historical snapshots into transcript input proof", async () => {
    const meeting = fixture.add("meeting", { id: "unknown-transcript", workspaceId, title: "Unknown native", source: "SYNTHETIC", transcript: "Unproved text", archivedAt: null });
    expect(await preparePermittedDerivationInputs(fixture.prisma, alpha, workspaceId, [{ kind: "MeetingTranscript", id: meeting.id }], [])).toBeNull();
    expect(fixture.rows.nativeTranscriptInput).toEqual([]);
  });

  it("recognizes authenticated Message native snapshots and rechecks actual current provider before prompt admission", async () => {
    fixture.add("communicationInstallation", { id: "installation", workspaceId, provider: "SLACK", externalWorkspaceId: "T_TEST", appId: "APP_TEST",
      botUserId: "U_BOT", botTokenEnc: "synthetic-encrypted:synthetic-token", scopes: ["channels:read", "channels:history"], optionalScopes: [], settings: {}, status: "ACTIVE", disconnectedAt: null });
    const channel = fixture.add("communicationChannel", { id: "channel", workspaceId, installationId: "installation", provider: "SLACK", externalChannelId: "C_PUBLIC",
      kind: "PUBLIC", isIngestEnabled: true, isArchived: false });
    const fetched = await captureSlackNativeMessageFetch({ workspaceId, installationId: "installation", channelId: "C_PUBLIC", messageTs: slack.remote.ts });
    const stamp = new Date(Number(slack.remote.ts) * 1000);
    const message = fixture.add("communicationMessage", { id: "message", workspaceId, installationId: "installation", provider: "SLACK", externalChannelId: "C_PUBLIC",
      externalMessageId: slack.remote.ts, externalUserId: slack.remote.user, threadExternalId: null, text: slack.remote.text, raw: fetched.projected,
      messageTs: stamp, receivedAt: stamp, expiresRawAt: new Date(Date.now() + 120000), isBot: false, isDeleted: false, isHidden: false, textRedactedAt: null, permalink: null });
    const epochProof = await capturePermissionEpochs(fixture.prisma, workspaceId, artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = fixture.add("communicationMessageNativeInput", { id: "message-native", workspaceId, installationId: "installation", communicationMessageId: message.id,
      provider: "SLACK", externalWorkspaceId: "T_TEST", appId: "APP_TEST", providerPrincipalId: "U_BOT", externalChannelId: "C_PUBLIC",
      externalMessageId: slack.remote.ts, externalUserId: slack.remote.user, threadExternalId: null, mode: "AUTHENTICATED_FETCH", ingressInputId: null,
      requestJson: { ...fetched.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", message) },
      encryptedPayloadJson: `synthetic-encrypted:${communicationCanonicalJson(fetched.payload)}`, projectedContentJson: fetched.projected,
      projectionHash: communicationNativeHash(communicationCanonicalJson(fetched.projected)), installationGrantHash: fetched.installationGrantHash,
      channelGrantHash: fetched.channelGrantHash, permissionEpochsJson: epochProof, epochProofVersion: 1, expiresRawAt: message.expiresRawAt, fetchedAt: fixture.timestamp });
    await known("CommunicationMessage", message, [{ kind: "CommunicationMessageNativeInput", id: input.id }], alpha);
    const graph = fixture.add("contextGraphObject", { id: "message-graph", workspaceId, title: "Derived message fact", properties: {} });
    const promptProof = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "CommunicationMessage", id: message.id }], fixture.prisma);
    const immutable = await captureImmutableArtifactInputProof(alpha, workspaceId, promptProof, fixture.prisma);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "ContextGraphObject", id: graph.id },
      content: graph, origin: "DERIVED", inputs: [], inheritedRoots: immutable });
    const ancestry = await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: graph.id });
    expect(ancestry.complete).toBe(true); expect(ancestry.dependencies).toContainEqual({ kind: "CommunicationMessageNativeInput", id: input.id });
    const rawGraph = fixture.add("contextGraphObject", { id: "raw-native-message-graph", workspaceId, title: "Known native fetch capture", properties: {} });
    await known("ContextGraphObject", rawGraph, [{ kind: "CommunicationMessage", id: message.id }], alpha);
    const callsBeforeDiscovery = slack.history.mock.calls.length;
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: rawGraph.id })).complete).toBe(true);
    expect(slack.history.mock.calls.length).toBe(callsBeforeDiscovery);
    const mode = input.mode; input.mode = "LEGACY_IMPORT";
    expect((await inspectStoredArtifactInputDependencyIdentities(fixture.prisma, workspaceId, { kind: "ContextGraphObject", id: rawGraph.id })).complete).toBe(false);
    input.mode = mode;
    const admitted = await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId, ancestry.dependencies, [{ kind: "ContextGraphObject", id: graph.id }]);
    expect(admitted?.sources).toEqual([expect.objectContaining({ kind: "CommunicationMessage", content: "Public native message" })]);
    expect(admitted?.roots.some(root => root.kind === "CommunicationMessageNativeInput" && root.id === input.id)).toBe(true);
    expect(fixture.prisma.$queryRaw.mock.calls.some(([sql]: any[]) => sql.sql?.includes('FROM "CommunicationMessageNativeInput"'))).toBe(true);
    slack.remote = { ...slack.remote, text: "Provider edited exact source" };
    expect(await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId, ancestry.dependencies, [])).toBeNull();
    slack.remote = { ...slack.remote, text: message.text }; slack.principal = "U_REPLACEMENT";
    expect(await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId, ancestry.dependencies, [])).toBeNull();
    slack.principal = "U_BOT"; channel.kind = "PRIVATE";
    const policyKey = JSON.stringify([workspaceId, "CommunicationChannelPolicy", JSON.stringify(["installation", "C_PUBLIC"])]);
    epochs.set(policyKey, (epochs.get(policyKey) ?? 0n) + 2n); channel.kind = "PUBLIC";
    expect(await preparePermittedDerivationInputs(fixture.prisma, beta, workspaceId, ancestry.dependencies, [])).toBeNull();
  });

});
