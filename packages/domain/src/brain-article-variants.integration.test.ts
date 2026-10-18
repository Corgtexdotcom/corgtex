import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { syncBrainArticleKnowledge } from "../../knowledge/src/chunks";
import { fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "../../knowledge/src/retrieval";
const slack = vi.hoisted(() => ({ original: { type: "message", ts: "1700000000.000001", user: "U_AUTHOR", text: "Public original communication facts" } }));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  auth = { test: async () => ({ ok: true, team_id: "T_SYNTHETIC", user_id: "U_BOT" }) };
  conversations = { info: async () => ({ ok: true, channel: { id: "synthetic-public", is_private: false, is_member: true, is_archived: false } }),
    history: async () => ({ ok: true, messages: [slack.original] }) };
} }));
import { captureSlackNativeMessageFetch, withSlackNativeCommitReceipt } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { lineageContentFingerprint } from "./source-lineage";
import { createArticle, getArticle, listArticles, publishArticle, updateArticle } from "./brain";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { lockSourceAuthorityRow } from "./source-commit-row-locks";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage, type LineageKind } from "./source-lineage";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { captureRecorderProviderWire, prepareRecorderTranscript, publishRecorderTranscript, withRecorderTranscriptAttempt } from "./recorder-transcript-input";
import { BRAIN_ARTICLE_VARIANT_JOB_TYPE, generateBrainArticleVariant, getReadableBrainArticleVariant,
  requestBrainArticleVariant, type PermittedVariantSource } from "./brain-article-variants";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic variant workspace", slug: `variants-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign workspace", slug: `variants-foreign-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `variants-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `variants-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: reader.id, role: "ADMIN" } });
  await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: true } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null, globalRole: "USER" } };
  const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: null, globalRole: "USER" } };
  const publicSource = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1,
    title: "Allowed launch planning", content: "Public launch planning facts for the permitted article.", accessDomain: "WORKSPACE" } });
  await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: publicSource.id }, content: publicSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const financeOriginal = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "private-finance-original",
    title: "PRIVATE FINANCE ORIGINAL CANARY", bodyMd: "PRIVATE FINANCE FACT CANARY", type: "STRATEGY",
    isPrivate: true, ownerMemberId: ownerMember.id, authority: "DRAFT" });
  // Finance's module defaults permit ordinary members to read the module. This
  // copied Finance source additionally retains the author's private original.
  const financeSource = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3,
    accessDomain: "FINANCE", title: "PRIVATE FINANCE SOURCE CANARY", content: financeOriginal.bodyMd } });
  await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: financeSource.id }, content: financeSource, origin: "DERIVED",
    inputs: [{ kind: "BrainArticle", id: financeOriginal.id }] }));
  const canonical = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "broad-finance-canonical",
    title: "PRIVATE CANONICAL TITLE CANARY", type: "PROJECT", authority: "REFERENCE", isPrivate: false,
    bodyMd: `${publicSource.content}\n\n${financeOriginal.bodyMd}`, sourceIds: [publicSource.id, financeSource.id],
    frontmatterJson: { also: ["PRIVATE CANONICAL ALIAS CANARY"] } });
  return { workspace, foreign, owner, reader, ownerMember, readerMember, ownerActor, readerActor,
    publicSource, financeSource, financeOriginal, canonical };
}

async function recorderVariantFixture() {
  vi.stubEnv("RECALL_API_KEY", "synthetic-variant-recall-key");
  vi.stubEnv("RECALL_REGION", "us-west-2");
  vi.stubEnv("RECALL_WEBHOOK_SECRET", "synthetic-variant-signing");
  vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", undefined);
  const f = await fixture();
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, title: "Authenticated recorder meeting",
    source: "manual", recordedAt: new Date(), status: "SCHEDULED" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
    artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "HUMAN_ORIGINAL", inputs: [] }));
  await prisma.workspaceMeetingRecorderConfig.create({ data: { workspaceId: f.workspace.id, enabled: true } });
  const recording = await prisma.meetingRecording.create({ data: { workspaceId: f.workspace.id, meetingId: meeting.id,
    provider: "RECALL_AI", externalBotId: `synthetic-variant-bot-${randomUUID()}`,
    meetingUrl: "https://meet.google.com/synthetic-variant", status: "COMPLETED" } });
  const transcriptPayload = [{ speaker: "Synthetic speaker", start: 0, text: "AUTHENTIC RECORDER CANARY" }];
  const publication = await withRecorderTranscriptAttempt(recording, null, async receipt => {
    captureRecorderProviderWire(`https://us-west-2.recall.ai/api/v1/bot/${recording.externalBotId}/transcript/`,
      { headers: { Authorization: "Token synthetic-variant-recall-key" } }, 200, JSON.stringify(transcriptPayload));
    return publishRecorderTranscript(await prepareRecorderTranscript(receipt, { transcriptPayload, metadata: {} }, {}));
  });
  expect(publication).toMatchObject({ committed: true, meetingId: meeting.id });
  const nativeInput = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { workspaceId: f.workspace.id, mode: "RECORDER" } });
  const completeInputRoots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, [
    { kind: "BrainSource", id: f.publicSource.id }, { kind: "BrainSource", id: f.financeSource.id },
    { kind: "MeetingTranscript", id: meeting.id },
  ]);
  const canonical = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "authenticated-recorder-canonical",
    title: "PRIVATE RECORDER CANONICAL TITLE CANARY", bodyMd: `${f.publicSource.content}\nPRIVATE FINANCE FACT CANARY\nAUTHENTIC RECORDER CANARY`,
    type: "PROJECT", authority: "REFERENCE", sourceIds: [f.publicSource.id, f.financeSource.id], completeInputRoots });
  return { ...f, meeting, recording, nativeInput, canonical };
}

async function mixedFixture() {
  const f = await fixture();
  const document = await prisma.document.create({ data: { workspaceId: f.workspace.id, title: "Public native document",
    source: "SYNTHETIC", storageKey: "DO NOT PROMPT STORAGE KEY", textContent: "Public native document facts", metadata: { secret: "DO NOT PROMPT DOCUMENT METADATA" } } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
    artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const transcriptSource = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "DOC", tier: 1,
    title: "Public native meeting", content: "Public native transcript facts" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
    artifact: { kind: "BrainSource", id: transcriptSource.id }, content: transcriptSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, title: transcriptSource.title!, source: "SYNTHETIC",
    recordedAt: new Date(), participantIds: [], transcript: transcriptSource.content, summaryMd: "DO NOT PROMPT UNPROVEN SUMMARY" } });
  // The transcript is an actual copy of independently shared human notes. It
  // has complete input provenance, unlike a raw legacy transcript upload.
  const { meetingTranscriptInputProjection } = await import("./meeting-intelligence-context");
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
    artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), origin: "DERIVED",
    inputs: [{ kind: "BrainSource", id: transcriptSource.id }] }));
  const installation = await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id, provider: "SLACK",
    externalWorkspaceId: "T_SYNTHETIC", appId: "APP_SYNTHETIC", botUserId: "U_BOT", botTokenEnc: encryptSecret("synthetic-token"),
    scopes: ["channels:read", "channels:history"], status: "ACTIVE" } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: "synthetic-public", name: "DO NOT PROMPT CHANNEL LABEL", kind: "PUBLIC", isIngestEnabled: true } });
  const fetched = await captureSlackNativeMessageFetch({ workspaceId: f.workspace.id, installationId: installation.id,
    channelId: channel.externalChannelId, messageTs: slack.original.ts });
  const message = await prisma.$transaction(async tx => {
    const stamp = new Date(Math.trunc(Number(slack.original.ts) * 1000));
    const message = await tx.communicationMessage.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
      provider: "SLACK", externalChannelId: channel.externalChannelId, externalMessageId: slack.original.ts, externalUserId: slack.original.user,
      text: String(fetched.projected.text), raw: fetched.projected as any, messageTs: stamp, receivedAt: stamp,
      expiresRawAt: new Date(Date.now() + 120000), permalink: null } });
    const permissionEpochsJson = await capturePermissionEpochs(tx, f.workspace.id, artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
      communicationMessageId: message.id, provider: "SLACK", externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId,
      providerPrincipalId: fetched.providerPrincipalId, externalChannelId: channel.externalChannelId, externalMessageId: message.externalMessageId,
      externalUserId: message.externalUserId, threadExternalId: null, mode: "AUTHENTICATED_FETCH", ingressInputId: null,
      requestJson: { ...fetched.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", message) } as any,
      encryptedPayloadJson: encryptSecret(communicationCanonicalJson(fetched.payload)), projectedContentJson: fetched.projected as any,
      projectionHash: communicationNativeHash(communicationCanonicalJson(fetched.projected)), installationGrantHash: fetched.installationGrantHash,
      channelGrantHash: fetched.channelGrantHash, permissionEpochsJson: permissionEpochsJson as any, epochProofVersion: 1,
      expiresRawAt: message.expiresRawAt!, fetchedAt: new Date(fetched.capturedAtMs) } });
    await withSlackNativeCommitReceipt(f.ownerActor, f.workspace.id, input.id, tx, fetched, () => recordArtifactInputLineage({ tx,
      actor: f.ownerActor, workspaceId: f.workspace.id, artifact: { kind: "CommunicationMessage", id: message.id }, content: message,
      origin: "DERIVED", inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }] }));
    return message;
  });
  const session = await prisma.conversationSession.create({ data: { workspaceId: f.workspace.id, userId: f.owner.id,
    topic: "DO NOT PROMPT SESSION TOPIC", systemPrompt: "DO NOT PROMPT UNKNOWN SYSTEM" } });
  const prompt = await prisma.conversationPromptInput.create({ data: { workspaceId: f.workspace.id, sessionId: session.id, userId: f.owner.id,
    content: "PRIVATE OWNER PROMPT CANARY" } });
  const ingress = await prisma.conversationIngressInput.create({ data: { workspaceId: f.workspace.id, actorKind: "user", userId: f.owner.id,
    content: "PRIVATE OWNER INGRESS CANARY" } });
  const request = await prisma.agentRequestInput.create({ data: { workspaceId: f.workspace.id, userId: f.owner.id, agentKey: "synthetic-original-request",
    prompt: "PRIVATE OWNER AGENT REQUEST CANARY" } });
  const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "public-original-mixed",
    title: "Public human original article", bodyMd: "Public human original article facts", type: "STRATEGY", authority: "REFERENCE", isPrivate: false });
  const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "Public human circle", purposeMd: "Public human circle purpose", domainMd: "Public human circle domain" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Public human role", purposeMd: "Public human role purpose",
    accountabilities: ["Public human accountability"], artifacts: ["Public human artifact"] } });
  const action = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human action",
    bodyMd: "Public human action facts", status: "OPEN", isPrivate: false, publishedAt: new Date() } });
  const tension = await prisma.tension.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human tension",
    bodyMd: "Public human tension facts", status: "OPEN", isPrivate: false, publishedAt: new Date() } });
  const goal = await prisma.goal.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human goal",
    descriptionMd: "Public human goal facts", status: "ACTIVE", isPrivate: false, publishedAt: new Date() } });
  for (const [kind, row] of [["Circle", circle], ["Role", role], ["Action", action], ["Tension", tension], ["Goal", goal]] as const) {
    // These records are freshly authored synthetic originals; there is no legacy or model body to certify.
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  const inputs: Array<{ kind: LineageKind; id: string }> = [
    { kind: "Document", id: document.id }, { kind: "MeetingTranscript", id: meeting.id }, { kind: "CommunicationMessage", id: message.id },
    { kind: "ConversationPromptInput", id: prompt.id }, { kind: "ConversationIngressInput", id: ingress.id }, { kind: "AgentRequestInput", id: request.id },
    { kind: "BrainArticle", id: original.id }, { kind: "BrainArticle", id: f.financeOriginal.id }, { kind: "Circle", id: circle.id },
    { kind: "Role", id: role.id }, { kind: "Action", id: action.id }, { kind: "Tension", id: tension.id }, { kind: "Goal", id: goal.id },
  ];
  const completeInputRoots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, inputs);
  const canonical = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "mixed-broad-canonical", type: "PROJECT", authority: "REFERENCE",
    isPrivate: false, title: "PRIVATE MIXED CANONICAL TITLE CANARY", bodyMd: "PRIVATE MIXED CANONICAL BODY CANARY",
    sourceIds: [f.publicSource.id], completeInputRoots });
  return { ...f, canonical, document, meeting, message, transcriptSource, original, circle, role, action, tension, goal, prompt, ingress, request };
}

/** Append a new, complete native parent after the canonical saved its roots.
 * The copied bytes deliberately match the existing source: a new manifest can
 * have the same content fingerprint while its actual ancestry has changed. */
async function appendCurrentSlackParent(f: Awaited<ReturnType<typeof fixture>>,
  additionalSources: Array<typeof f.publicSource> = []) {
  const installation = await prisma.communicationInstallation.findFirst({ where: { workspaceId: f.workspace.id } })
    ?? await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id, provider: "SLACK",
      externalWorkspaceId: "T_SYNTHETIC", appId: "APP_SYNTHETIC", botUserId: "U_BOT",
      botTokenEnc: encryptSecret("synthetic-token"), scopes: ["channels:read", "channels:history"], status: "ACTIVE" } });
  const channel = await prisma.communicationChannel.findFirst({ where: { installationId: installation.id } })
    ?? await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
      provider: "SLACK", externalChannelId: "synthetic-public", name: "Synthetic public channel", kind: "PUBLIC",
      isIngestEnabled: true } });
  slack.original = { type: "message", ts: "1700000000.000002", user: "U_AUTHOR", text: f.publicSource.content };
  const fetched = await captureSlackNativeMessageFetch({ workspaceId: f.workspace.id, installationId: installation.id,
    channelId: channel.externalChannelId, messageTs: slack.original.ts });
  const message = await prisma.$transaction(async tx => {
    const stamp = new Date(Math.trunc(Number(slack.original.ts) * 1000));
    const message = await tx.communicationMessage.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
      provider: "SLACK", externalChannelId: channel.externalChannelId, externalMessageId: slack.original.ts,
      externalUserId: slack.original.user, text: String(fetched.projected.text), raw: fetched.projected as any,
      messageTs: stamp, receivedAt: stamp, expiresRawAt: new Date(Date.now() + 300000), permalink: null } });
    const permissionEpochsJson = await capturePermissionEpochs(tx, f.workspace.id,
      artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: f.workspace.id,
      installationId: installation.id, communicationMessageId: message.id, provider: "SLACK",
      externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId,
      providerPrincipalId: fetched.providerPrincipalId, externalChannelId: channel.externalChannelId,
      externalMessageId: message.externalMessageId, externalUserId: message.externalUserId, threadExternalId: null,
      mode: "AUTHENTICATED_FETCH", ingressInputId: null,
      requestJson: { ...fetched.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", message) } as any,
      encryptedPayloadJson: encryptSecret(communicationCanonicalJson(fetched.payload)),
      projectedContentJson: fetched.projected as any,
      projectionHash: communicationNativeHash(communicationCanonicalJson(fetched.projected)),
      installationGrantHash: fetched.installationGrantHash, channelGrantHash: fetched.channelGrantHash,
      permissionEpochsJson: permissionEpochsJson as any, epochProofVersion: 1,
      expiresRawAt: message.expiresRawAt!, fetchedAt: new Date(fetched.capturedAtMs) } });
    await withSlackNativeCommitReceipt(f.ownerActor, f.workspace.id, input.id, tx, fetched,
      () => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
        artifact: { kind: "CommunicationMessage", id: message.id }, content: message, origin: "DERIVED",
        inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }] }));
    return message;
  });
  const roots = await captureArtifactInputProof(f.ownerActor, f.workspace.id,
    [{ kind: "CommunicationMessage", id: message.id }]);
  const preflight = await prepareArtifactCommitPreflight(f.ownerActor, f.workspace.id, roots);
  await prisma.$transaction(tx => withArtifactCommitPreflight(f.ownerActor, f.workspace.id, tx, roots, preflight,
    async () => {
      for (const source of [f.publicSource, ...additionalSources]) await recordArtifactInputLineage({ tx,
        actor: f.ownerActor, workspaceId: f.workspace.id, artifact: { kind: "BrainSource", id: source.id },
        content: source, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    }));
  return message;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

async function claim(f: Fixture, expectedAttempt = 1, expectedOwner = "fixture-worker") {
  const requested = await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id });
  if (requested.status !== "pending") throw new Error(`Expected a pending variant: ${requested.status}`);
  await prisma.workflowJob.update({ where: { id: requested.jobId }, data: {
    status: "RUNNING", attempts: expectedAttempt, lockedBy: expectedOwner,
  } });
  return { workspaceId: f.workspace.id, jobId: requested.jobId, expectedAttempt, expectedOwner };
}

async function generateVariant(f: Fixture) {
  const lease = await claim(f);
  const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
    expect(sources.map((source) => source.id)).toEqual([f.publicSource.id]);
    expect(JSON.stringify(sources)).not.toContain("PRIVATE");
    return { title: "Permitted launch planning", bodyMd: "Public launch planning facts for the permitted article." };
  });
  const generated = await generateBrainArticleVariant({ ...lease, generate });
  if (generated.phase !== "APPLIED" || !generated.articleId) throw new Error(`Expected an applied variant: ${generated.phase}`);
  const variant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.articleId } });
  return { lease, variant, generate };
}

async function archiveAndRestoreSource(f: Fixture) {
  const archivedAt = new Date();
  const history = await prisma.$transaction(async (tx) => {
    await tx.brainSource.update({ where: { id: f.publicSource.id }, data: { archivedAt } });
    return tx.workspaceArchiveRecord.create({ data: { workspaceId: f.workspace.id, entityType: "BrainSource",
      entityId: f.publicSource.id, archivedAt, archivedByUserId: f.owner.id, archiveReason: "Synthetic restore regression" } });
  });
  await prisma.$transaction(async (tx) => {
    await tx.brainSource.update({ where: { id: f.publicSource.id }, data: { archivedAt: null } });
    await tx.workspaceArchiveRecord.update({ where: { id: history.id }, data: { restoredAt: new Date(), restoredByUserId: f.owner.id } });
  });
}

describe("permitted article variants across real read/write boundaries", () => {
  beforeEach(async () => {
    // A synthetic key enables disposable cache fixtures without external credentials.
    process.env.ENCRYPTION_KEY ??= "1".repeat(64);
    slack.original = { type: "message", ts: "1700000000.000001", user: "U_AUTHOR", text: "Public original communication facts" };
    await truncateAllTables();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  it.each(["source", "caller", "claim"].flatMap(change => [0, 1].map(priorSends => ({ change, priorSends }))))(
    "provider attempt denies article $change drift after $priorSends sends", async ({ change, priorSends }) => {
      const f = await fixture(); const lease = await claim(f);
      await prisma.workflowJob.update({ where: { id: lease.jobId }, data: { lockedAt: new Date(), startedAt: new Date() } });
      let sends = 0;
      const result = await generateBrainArticleVariant({ ...lease, generate: async (_sources, controls) => {
        if (priorSends) { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
        if (change === "source") await archiveAndRestoreSource(f);
        if (change === "caller") {
          await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
          await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true } });
        }
        if (change === "claim") await prisma.workflowJob.update({ where: { id: lease.jobId }, data: { attempts: 2, lockedBy: "replacement" } });
        await controls?.authorizeAttempt({ signal: controls.signal }); sends++;
        return { title: "Candidate", bodyMd: "Permitted original facts." };
      } }).catch(error => error);
      expect(sends).toBe(priorSends);
      expect(result).toBeInstanceOf(Error);
      expect(await prisma.brainArticle.count({ where: { workspaceId: f.workspace.id, variantOfArticleId: f.canonical.id } })).toBe(0);
      if (change === "claim") expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } }))
        .toMatchObject({ status: "RUNNING", attempts: 2, lockedBy: "replacement" });
    });

  it("provider attempt permits article retries with unchanged original authority", async () => {
    const f = await fixture(); const lease = await claim(f);
    await prisma.workflowJob.update({ where: { id: lease.jobId }, data: { lockedAt: new Date(), startedAt: new Date() } });
    let sends = 0;
    const result = await generateBrainArticleVariant({ ...lease, generate: async (_sources, controls) => {
      for (let attempt = 0; attempt < 2; attempt++) { await controls.authorizeAttempt({ signal: controls.signal }); sends++; }
      return { title: "Candidate", bodyMd: "Permitted original facts." };
    } });
    expect(sends).toBe(2); expect(result.phase).toBe("APPLIED");
  });

  it("enqueues denied canonicals automatically, serves a separate owned variant, and redacts internal recipe metadata", async () => {
    const f = await fixture();
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    const initialList = await listArticles(f.readerActor, { workspaceId: f.workspace.id, take: 1 });
    expect(initialList).toMatchObject({ items: [], total: 0 });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspace.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(1);
    const { variant, lease } = await generateVariant(f);
    const body = await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(body).toMatchObject({ id: variant.id, title: "Permitted launch planning", isPrivate: true,
      ownerMemberId: f.readerMember.id, isPermissionVariant: true,
      variantOfArticleId: null, variantTargetFingerprint: null, variantInputSetHash: null,
      variantSourceStateJson: null, variantGenerationJobId: null });
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(body.slug).not.toBe(f.canonical.slug);
    const list = await listArticles(f.readerActor, { workspaceId: f.workspace.id, take: 1 });
    expect(list.total).toBe(1);
    expect(list.items.map((article) => article.id)).toEqual([variant.id]);
    expect(JSON.stringify(list)).not.toContain(f.financeSource.id);
    expect(JSON.stringify(list)).not.toContain("PRIVATE");
    const broad = await getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(broad.id).toBe(f.canonical.id);
    expect(broad.bodyMd).toContain("PRIVATE FINANCE FACT CANARY");
    await expect(getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: variant.slug }))
      .rejects.toMatchObject({ status: 404 });
    expect((await listArticles(f.ownerActor, { workspaceId: f.workspace.id })).items.map((article) => article.id)).not.toContain(variant.id);
    expect((await listArticles(f.readerActor, { workspaceId: f.foreign.id })).total).toBe(0);
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.foreign.id, articleId: f.canonical.id }))
      .toEqual({ status: "unavailable" });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({
      title: f.canonical.title, bodyMd: f.canonical.bodyMd, frontmatterJson: f.canonical.frontmatterJson, sourceIds: f.canonical.sourceIds,
    });
    expect(await prisma.artifactInputLineage.findFirst({ where: { artifactId: variant.id }, orderBy: { revision: "desc" } }))
      .toMatchObject({ origin: "DERIVED", rootsJson: [{ kind: "BrainSource", id: f.publicSource.id,
        fingerprint: brainSourceContentFingerprint(f.publicSource) }] });
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } });
    expect(JSON.stringify(job.payload)).not.toContain("PRIVATE");
    expect(JSON.stringify(job.payload)).not.toContain("Public launch planning facts");
    await expect(updateArticle(f.readerActor, { workspaceId: f.workspace.id, slug: variant.slug, bodyMd: "Changed" }))
      .rejects.toMatchObject({ code: "IMMUTABLE_VARIANT" });
    await expect(publishArticle(f.readerActor, { workspaceId: f.workspace.id, slug: variant.slug }))
      .rejects.toMatchObject({ code: "IMMUTABLE_VARIANT" });
  });

  it("regenerates from independent survivors when an authenticated recorder input becomes unavailable", async () => {
    const f = await recorderVariantFixture();
    const roots = await captureArtifactInputProof(f.readerActor, f.workspace.id,
      [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    expect(await isArtifactInputProofReadable(f.readerActor, f.workspace.id, roots)).toBe(true);
    const genericAgent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-article-variant", workspaceIds: [f.workspace.id] };
    expect(await isArtifactInputProofReadable(genericAgent, f.workspace.id, roots)).toBe(false);
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
    expect(await isArtifactInputProofReadable(f.readerActor, f.workspace.id, roots)).toBe(false);
    const { variant, generate } = await generateVariant(f);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls)).not.toContain("RECORDER CANARY");
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactId: variant.id }, orderBy: { revision: "desc" } });
    expect(manifest.rootsJson).toEqual([{ kind: "BrainSource", id: f.publicSource.id,
      fingerprint: brainSourceContentFingerprint(f.publicSource),
      permissionEpochs: expect.objectContaining({ version: 1, entries: expect.any(Array) }) }]);
    expect((await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(variant.id);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ bodyMd: f.canonical.bodyMd });
    expect(await prisma.nativeTranscriptInput.findUniqueOrThrow({ where: { id: f.nativeInput.id } }))
      .toMatchObject({ encryptedPayloadJson: f.nativeInput.encryptedPayloadJson });
    expect(await prisma.recorderTranscriptPublication.count({ where: { nativeInputId: f.nativeInput.id } })).toBe(1);
  });

  it("keeps restored recorder proof and its previous member variant withheld while creating a survivor-only variant", async () => {
    const f = await recorderVariantFixture();
    const lease = await claim(f);
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources.map(source => source.kind).sort()).toEqual(["BrainSource", "MeetingTranscript"].sort());
      expect(sources.find(source => source.kind === "MeetingTranscript")?.content).toContain("AUTHENTIC RECORDER CANARY");
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "Allowed recorder and launch facts", bodyMd: "AUTHENTIC RECORDER CANARY and public launch facts." };
    });
    const generated = await generateBrainArticleVariant({ ...lease, generate });
    expect(generated.phase).toBe("APPLIED");
    if (generated.phase !== "APPLIED") throw new Error("Expected an authenticated recorder variant");
    const oldVariant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.articleId } });
    expect((await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(oldVariant.id);
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
    expect(await getReadableBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id })).toBeNull();
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
    expect(await getReadableBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id })).toBeNull();
    expect(await readableArtifactIds(f.readerActor, f.workspace.id, "BrainArticle", [oldVariant])).toEqual(new Set());
    const { variant: fresh } = await generateVariant(f);
    expect(fresh.id).not.toBe(oldVariant.id);
    expect(fresh.bodyMd).not.toContain("RECORDER CANARY");
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: oldVariant.id } })).toMatchObject({ bodyMd: oldVariant.bodyMd });
    expect(await prisma.nativeTranscriptInput.findUniqueOrThrow({ where: { id: f.nativeInput.id } }))
      .toMatchObject({ encryptedPayloadJson: f.nativeInput.encryptedPayloadJson });
  });

  it("denies recorder planner roots and targets in another tenant and denies a nonmember before generation", async () => {
    const f = await recorderVariantFixture();
    const roots = await captureArtifactInputProof(f.readerActor, f.workspace.id,
      [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    expect(await isArtifactInputProofReadable(f.readerActor, f.foreign.id, roots)).toBe(false);
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.foreign.id, articleId: f.canonical.id }))
      .toEqual({ status: "unavailable" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.foreign.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(0);
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await expect(isArtifactInputProofReadable(f.readerActor, f.workspace.id, roots))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id }))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspace.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(0);
  });

  it.each(["configuration", "binding", "membership", "meeting"] as const)(
    "rejects a recorder candidate across %s revocation and attempted restoration during generation", async boundary => {
      const f = await recorderVariantFixture();
      const lease = await claim(f);
      const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
        expect(sources.find(source => source.kind === "MeetingTranscript")?.content).toContain("AUTHENTIC RECORDER CANARY");
        expect(JSON.stringify(sources)).not.toContain("PRIVATE");
        if (boundary === "configuration") {
          await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
          await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
        } else if (boundary === "binding") {
          await prisma.recorderTranscriptBinding.update({ where: { id: f.nativeInput.recorderBindingId! },
            data: { active: false, revokedAt: new Date() } });
          await expect(prisma.recorderTranscriptBinding.update({ where: { id: f.nativeInput.recorderBindingId! },
            data: { active: true, revokedAt: null } })).rejects.toThrow("cannot be revived or rewritten");
        } else if (boundary === "membership") {
          await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
          await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true } });
        } else {
          await archiveWorkspaceArtifact(f.ownerActor, { workspaceId: f.workspace.id, entityType: "Meeting", entityId: f.meeting.id });
          await restoreWorkspaceArtifact(f.ownerActor, { workspaceId: f.workspace.id, entityType: "Meeting", entityId: f.meeting.id });
        }
        return { title: "Stale recorder candidate", bodyMd: "AUTHENTIC RECORDER CANARY" };
      });
      expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
      expect(generate).toHaveBeenCalledOnce();
      expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
      expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } })).toMatchObject({ payload: { phase: "STALE" } });
      expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ bodyMd: f.canonical.bodyMd });
      expect(await prisma.nativeTranscriptInput.findUniqueOrThrow({ where: { id: f.nativeInput.id } }))
        .toMatchObject({ encryptedPayloadJson: f.nativeInput.encryptedPayloadJson });
      expect(await prisma.recorderTranscriptPublication.count({ where: { nativeInputId: f.nativeInput.id } })).toBe(1);
      const next = await claim(f);
      expect(next.jobId).not.toBe(lease.jobId);
      const fresh = await generateBrainArticleVariant({ ...next, generate: async sources => {
        const transcript = sources.find(source => source.kind === "MeetingTranscript");
        // Restored membership can make an independently current recorder input
        // available again. Restored source policy cannot revive its old proof.
        if (boundary === "membership") expect(transcript?.content).toContain("AUTHENTIC RECORDER CANARY");
        else expect(transcript).toBeUndefined();
        return { title: "Fresh permitted facts", bodyMd: "Public launch planning facts." };
      } });
      expect(fresh.phase).toBe("APPLIED");
    });

  it("shares immutable native custody with a concurrent canonical source reader without upgrading its lock", async () => {
    const f = await recorderVariantFixture();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reader = prisma.$transaction(async tx => {
      await lockSourceAuthorityRow(tx, "NativeTranscriptInput", f.nativeInput.id, f.workspace.id);
      ready();
      await held;
    }, { timeout: 15_000 });
    await entered;
    try {
      expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id }))
        .toMatchObject({ status: "pending" });
    } finally { release(); await reader; }
  });

  it("holds native custody before waiting for the local BrainSource row, matching canonical native source order", async () => {
    const f = await recorderVariantFixture();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${f.publicSource.id} AND "workspaceId" = ${f.workspace.id} FOR UPDATE`;
      ready();
      await held;
    }, { timeout: 15_000 });
    await entered;
    const request = requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id });
    try {
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw<Array<{ query: string }>>`SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
        expect(waiting.some(row => row.query.includes('FROM "BrainSource"') && row.query.includes("FOR UPDATE"))).toBe(true);
      }, { timeout: 5_000, interval: 20 });
      await expect(prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "NativeTranscriptInput"
        WHERE id = ${f.nativeInput.id} AND "workspaceId" = ${f.workspace.id} FOR UPDATE NOWAIT`))
        .rejects.toMatchObject({ meta: { code: "55P03" } });
    } finally { release(); await blocker; }
    expect(await request).toMatchObject({ status: "pending" });
  });

  it("reserves archive advisories before authority rows when a canonical recorder source plan is already admitted", async () => {
    const f = await recorderVariantFixture();
    const roots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, [
      { kind: "BrainSource", id: f.publicSource.id }, { kind: "MeetingTranscript", id: f.meeting.id },
    ]);
    const options = { writeTargets: [], ownerBinding: { kind: "HUMAN_REQUEST" as const, id: f.ownerMember.id, generation: 1 } };
    const token = await prepareArtifactSourceCommit(f.ownerActor, f.workspace.id, roots, options);
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let backendPid = 0;
    let first = true;
    const reader = prisma.$transaction(tx => withArtifactSourceCommit(f.ownerActor, f.workspace.id, tx, roots, options, token,
      async current => {
        if (first) {
          first = false;
          const [backend] = await current.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          backendPid = backend.pid;
          ready();
          await held;
        }
        expect(await current.member.findFirst({ where: { id: options.ownerBinding.id, workspaceId: f.workspace.id,
          userId: f.owner.id, isActive: true } })).not.toBeNull();
      }, async () => "canonical-reader-finished"), { timeout: 15_000 }).then(
      value => ({ ok: true, value }), error => ({ ok: false, error }));
    await Promise.race([entered, reader.then(() => { throw new Error("Canonical plan ended before reserving its archive union."); })]);
    const request = requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id }).then(
      value => ({ ok: true, value }), error => ({ ok: false, error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw<Array<{ query: string }>>`SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND ${backendPid} = ANY(pg_blocking_pids(pid))`;
        expect(waiting.some(row => row.query.includes("pg_advisory_xact_lock"))).toBe(true);
      }, { timeout: 5_000, interval: 20 });
      // A waiting planner must not retain Workspace UPDATE. Otherwise the
      // canonical plan's later Workspace SHARE would close a deadlock cycle.
      await expect(prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Workspace"
        WHERE id = ${f.workspace.id} FOR SHARE NOWAIT`)).resolves.toEqual([{ id: f.workspace.id }]);
    } finally { release(); }
    const [canonicalResult, plannerResult] = await Promise.all([reader, request]);
    expect(canonicalResult).toEqual({ ok: true, value: "canonical-reader-finished" });
    expect(plannerResult).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("excludes a readable source copied from the canonical's historical original body", async () => {
    const f = await fixture();
    const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "historical-canonical",
      title: "OLD CANONICAL TITLE CANARY", bodyMd: "OLD CANONICAL BODY CANARY", type: "PROJECT", authority: "DRAFT", isPrivate: false });
    const historicalProof = await prisma.$transaction(async (tx) => {
      const roots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, [{ kind: "BrainArticle", id: original.id }], tx);
      return captureImmutableArtifactInputProof(f.ownerActor, f.workspace.id, roots, tx);
    });
    const wrapper = await prisma.$transaction(async (tx) => {
      const source = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "CONVERSATION", tier: 3,
        accessDomain: "WORKSPACE", title: original.title, content: original.bodyMd } });
      await recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
        artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "DERIVED", inputs: [], inheritedRoots: historicalProof });
      return source;
    });
    const canonical = await updateArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: original.slug,
      title: "CURRENT PRIVATE CANONICAL TITLE CANARY", bodyMd: "CURRENT PRIVATE CANONICAL BODY CANARY",
      sourceIds: [f.publicSource.id, f.financeSource.id, wrapper.id] });
    // A historical human original remains legitimately readable through its immutable snapshot.
    // It still cannot supply this target's old body to the variant generator.
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainSource", [wrapper])).has(wrapper.id)).toBe(true);
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainArticle", [canonical])).has(canonical.id)).toBe(false);
    const { variant, generate } = await generateVariant({ ...f, canonical });
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(generate.mock.calls)).not.toContain("OLD CANONICAL");
    expect(variant.sourceIds).toEqual([f.publicSource.id]);
    expect(await prisma.brainSource.findUniqueOrThrow({ where: { id: wrapper.id } })).toMatchObject({
      title: original.title, content: original.bodyMd,
    });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: canonical.id } })).toMatchObject({
      title: canonical.title, bodyMd: canonical.bodyMd, sourceIds: canonical.sourceIds,
    });
  });

  it("rebuilds a mixed canonical from current public native/original content while keeping owner prompts private", async () => {
    const f = await mixedFixture();
    const lease = await claim(f);
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources.map((source) => source.kind).sort()).toEqual(["BrainSource", "BrainSource", "Document", "MeetingTranscript", "CommunicationMessage", "BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"].sort());
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      expect(JSON.stringify(sources)).not.toContain("DO NOT PROMPT");
      expect(sources.find((source) => source.kind === "MeetingTranscript")?.content).toBe("Public native transcript facts");
      return { title: "Mixed permitted facts", bodyMd: "Public native document, transcript, message and original governance facts." };
    });
    const generated = await generateBrainArticleVariant({ ...lease, generate });
    expect(generated.phase).toBe("APPLIED");
    if (generated.phase !== "APPLIED") throw new Error("Expected applied mixed variant");
    const variant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.articleId } });
    expect(variant.sourceIds.sort()).toEqual([f.publicSource.id, f.transcriptSource.id].sort());
    expect(variant.sourceIds).not.toContain(f.document.id);
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactId: variant.id }, orderBy: { revision: "desc" } });
    expect(manifest.origin).toBe("DERIVED");
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Document", id: f.document.id }), expect.objectContaining({ kind: "MeetingTranscript", id: f.meeting.id }),
      expect.objectContaining({ kind: "CommunicationMessage", id: f.message.id }), expect.objectContaining({ kind: "Role", id: f.role.id }),
    ]));
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } });
    expect(job.payload).toMatchObject({ version: 2, sources: expect.arrayContaining([{ kind: "Document", id: f.document.id, fingerprint: expect.any(String) }]) });
    const visible = await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(visible.id).toBe(variant.id);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE");
    await expect(getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: variant.slug })).rejects.toMatchObject({ status: 404 });
    expect((await getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(f.canonical.id);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ title: f.canonical.title, bodyMd: f.canonical.bodyMd, sourceIds: [f.publicSource.id] });
  });

  it("includes a new native parent on a current candidate after the canonical saved its older roots", async () => {
    const f = await mixedFixture();
    const newMessage = await appendCurrentSlackParent(f);
    const currentSource = await prisma.brainSource.findUniqueOrThrow({ where: { id: f.publicSource.id } });
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainSource", [currentSource]))
      .has(currentSource.id)).toBe(true);
    const currentProof = await captureArtifactInputProof(f.readerActor, f.workspace.id,
      [{ kind: "BrainSource", id: currentSource.id }]);
    expect(currentProof).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "CommunicationMessage", id: newMessage.id }),
    ]));
    const lease = await claim(f);
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "CommunicationMessage", id: newMessage.id, content: f.publicSource.content }),
        expect.objectContaining({ kind: "BrainSource", id: f.publicSource.id, content: f.publicSource.content }),
      ]));
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "Current native facts", bodyMd: f.publicSource.content };
    });
    const result = await generateBrainArticleVariant({ ...lease, generate });
    expect(result.phase).toBe("APPLIED");
    expect(generate).toHaveBeenCalledOnce();
    if (result.phase !== "APPLIED") throw new Error("Expected a current native variant");
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, artifactType: "BrainArticle", artifactId: result.articleId,
    }, orderBy: { revision: "desc" } });
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "CommunicationMessage", id: newMessage.id }),
    ]));
    expect((await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(result.articleId);
    // The original remote bytes are part of this source's saved proof. A later
    // provider edit cannot resurrect this immutable variant with the old hash.
    slack.original.text = "Changed provider bytes after publication";
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug }))
      .rejects.toMatchObject({ status: 404 });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: result.articleId } }))
      .toMatchObject({ bodyMd: f.publicSource.content, archivedAt: null });
  });

  it("prepares the first native parent of a current source whose canonical had no native ancestry", async () => {
    const f = await fixture();
    const message = await appendCurrentSlackParent(f);
    const lease = await claim(f);
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "CommunicationMessage", id: message.id, content: f.publicSource.content }),
        expect.objectContaining({ kind: "BrainSource", id: f.publicSource.id }),
      ]));
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "New native source", bodyMd: f.publicSource.content };
    });
    const result = await generateBrainArticleVariant({ ...lease, generate });
    expect(result.phase).toBe("APPLIED");
    expect(generate).toHaveBeenCalledOnce();
    if (result.phase !== "APPLIED") throw new Error("Expected a new-native variant");
    const variant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: result.articleId } });
    expect(variant.bodyMd).toBe(f.publicSource.content);
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, artifactType: "BrainArticle", artifactId: variant.id,
    }, orderBy: { revision: "desc" } });
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "CommunicationMessage", id: message.id }),
    ]));
  });

  it("uses a remaining candidate's own saved native vector when another enclosing source was revoked", async () => {
    const f = await fixture();
    const remainingSource = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id,
      sourceType: "DOC", tier: 1, accessDomain: "WORKSPACE", title: "Independent remaining facts",
      content: f.publicSource.content } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind: "BrainSource", id: remainingSource.id }, content: remainingSource,
      origin: "HUMAN_ORIGINAL", inputs: [] }));
    const canonical = await createArticle(f.ownerActor, { workspaceId: f.workspace.id,
      slug: "two-independent-native-candidates", title: "PRIVATE TWO SOURCE CANONICAL", type: "PROJECT",
      authority: "REFERENCE", isPrivate: false, bodyMd: `PRIVATE CANONICAL FACTS\n\n${remainingSource.content}`,
      sourceIds: [f.publicSource.id, remainingSource.id, f.financeSource.id] });
    const message = await appendCurrentSlackParent(f, [remainingSource]);
    await archiveAndRestoreSource(f);
    const staleRow = await prisma.brainSource.findUniqueOrThrow({ where: { id: f.publicSource.id } });
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainSource", [staleRow])).has(staleRow.id)).toBe(false);
    const remainingRow = await prisma.brainSource.findUniqueOrThrow({ where: { id: remainingSource.id } });
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainSource", [remainingRow])).has(remainingRow.id)).toBe(true);
    const lease = await claim({ ...f, canonical });
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "BrainSource", id: remainingSource.id }),
        expect.objectContaining({ kind: "CommunicationMessage", id: message.id }),
      ]));
      expect(sources.some(source => source.id === f.publicSource.id)).toBe(false);
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "Remaining native facts", bodyMd: remainingSource.content };
    });
    const result = await generateBrainArticleVariant({ ...lease, generate });
    expect(result.phase).toBe("APPLIED");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("regenerates separate member variants from remaining native inputs after Document removal and restoration", async () => {
    const f = await mixedFixture();
    const firstLease = await claim(f);
    const first = await generateBrainArticleVariant({ ...firstLease, generate: async () => ({ title: "Initial mixed variant", bodyMd: "Public document and remaining facts." }) });
    if (first.phase !== "APPLIED") throw new Error("Expected initial variant");
    const firstVariant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: first.articleId } });
    await archiveWorkspaceArtifact(f.ownerActor, { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id,
      reason: "Synthetic native Document removal" });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: firstVariant.slug })).rejects.toMatchObject({ status: 404 });
    const remainingLease = await claim(f);
    const remaining = await generateBrainArticleVariant({ ...remainingLease, generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(false);
      expect(sources.some((source) => source.kind === "MeetingTranscript")).toBe(true);
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "Remaining public facts", bodyMd: "Public transcript, message and original facts." };
    } });
    if (remaining.phase !== "APPLIED") throw new Error("Expected remaining-source variant");
    expect(remaining.articleId).not.toBe(first.articleId);
    const ownerRequested = await requestBrainArticleVariant(f.ownerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id });
    if (ownerRequested.status !== "pending") throw new Error("Expected independent owner recipe");
    await prisma.workflowJob.update({ where: { id: ownerRequested.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "owner-worker" } });
    const ownerVariant = await generateBrainArticleVariant({ workspaceId: f.workspace.id, jobId: ownerRequested.jobId, expectedAttempt: 1, expectedOwner: "owner-worker", generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(false);
      expect(sources.map((source) => source.kind)).toEqual(expect.arrayContaining(["ConversationPromptInput", "ConversationIngressInput", "AgentRequestInput"]));
      expect(JSON.stringify(sources)).toContain("PRIVATE OWNER PROMPT CANARY");
      expect(JSON.stringify(sources)).not.toContain("PRIVATE MIXED CANONICAL");
      expect(JSON.stringify(sources)).not.toContain("DO NOT PROMPT SESSION");
      return { title: "Owner-only remaining facts", bodyMd: "PRIVATE OWNER FACTS" };
    } });
    expect(ownerVariant.phase).toBe("APPLIED");
    if (ownerVariant.phase !== "APPLIED") throw new Error("Expected owner variant");
    const ownerRow = await prisma.brainArticle.findUniqueOrThrow({ where: { id: ownerVariant.articleId } });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: ownerRow.slug })).rejects.toMatchObject({ status: 404 });
    await restoreWorkspaceArtifact(f.ownerActor, { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: firstVariant.slug })).rejects.toMatchObject({ status: 404 });
    const restoredLease = await claim(f);
    expect(restoredLease.jobId).not.toBe(firstLease.jobId);
    const restored = await generateBrainArticleVariant({ ...restoredLease, generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(true);
      return { title: "Fresh restored facts", bodyMd: "Public restored document and remaining facts." };
    } });
    expect(restored.phase).toBe("APPLIED");
    if (restored.phase !== "APPLIED") throw new Error("Expected restored variant");
    expect(restored.articleId).not.toBe(first.articleId);
    expect((await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(restored.articleId);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: first.articleId } })).toMatchObject({ bodyMd: firstVariant.bodyMd, archivedAt: null });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ bodyMd: "PRIVATE MIXED CANONICAL BODY CANARY" });
  });

  it("rejects mixed native source edits during generation and makes v1 queued jobs stale before generation", async () => {
    const f = await mixedFixture();
    const lease = await claim(f);
    const changed = await generateBrainArticleVariant({ ...lease, generate: async () => {
      await prisma.document.update({ where: { id: f.document.id }, data: { textContent: "Changed uncited Document facts" } });
      return { title: "Stale native candidate", bodyMd: "Never persisted." };
    } });
    expect(changed).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    const next = await claim(f);
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: next.jobId } });
    const payload = job.payload as any;
    await prisma.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, version: 1,
      sources: payload.sources.filter((source: any) => source.kind === "BrainSource").map(({ id, fingerprint }: any) => ({ id, fingerprint })) } } });
    const generate = vi.fn();
    expect(await generateBrainArticleVariant({ ...next, generate })).toEqual({ phase: "STALE" });
    expect(generate).not.toHaveBeenCalled();
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
  });

  it("preserves unknown legacy bodies and independently authored originals without guessing citation receipts", async () => {
    const f = await fixture();
    const unknown = await prisma.brainArticle.create({ data: { workspaceId: f.workspace.id, slug: "unknown-original",
      title: "Unknown original", bodyMd: "Unclassified historical body", type: "PROJECT", sourceIds: [f.publicSource.id] } });
    const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "known-original", title: "Known original",
      bodyMd: "Independent original body", type: "PROJECT", authority: "REFERENCE", isPrivate: false });
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: unknown.id }))
      .toEqual({ status: "unavailable" });
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: original.id }))
      .toEqual({ status: "original" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspace.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(0);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ bodyMd: "Unclassified historical body" });
    expect(await prisma.artifactInputLineage.count({ where: { artifactId: unknown.id } })).toBe(0);
  });

  it("rejects generation after source privacy changes and after membership revocation", async () => {
    const f = await fixture();
    const lease = await claim(f);
    expect(await generateBrainArticleVariant({ ...lease, generate: async () => {
      await prisma.brainSource.update({ where: { id: f.publicSource.id }, data: { accessDomain: "FINANCE" } });
      return { title: "Stale source candidate", bodyMd: "Never accepted." };
    } })).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    await prisma.brainSource.update({ where: { id: f.publicSource.id }, data: { accessDomain: "WORKSPACE" } });
    const retry = await claim(f, 2);
    expect(await generateBrainArticleVariant({ ...retry, generate: async () => {
      await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
      return { title: "Revoked member candidate", bodyMd: "Never accepted." };
    } })).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug }))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("withholds an old variant after source restore and creates a new immutable recipe instead of resurrecting it", async () => {
    const f = await fixture();
    const before = await generateVariant(f);
    await archiveAndRestoreSource(f);
    expect(await getReadableBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id })).toBeNull();
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: before.variant.slug }))
      .rejects.toMatchObject({ status: 404 });
    expect((await listArticles(f.readerActor, { workspaceId: f.workspace.id })).total).toBe(0);
    const after = await generateVariant(f);
    expect(after.variant.id).not.toBe(before.variant.id);
    expect(after.lease.jobId).not.toBe(before.lease.jobId);
    expect(after.variant.variantInputSetHash).not.toBe(before.variant.variantInputSetHash);
    expect((await listArticles(f.readerActor, { workspaceId: f.workspace.id })).items.map((article) => article.id)).toEqual([after.variant.id]);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: before.variant.id } })).toMatchObject({
      bodyMd: before.variant.bodyMd, archivedAt: null, variantInputSetHash: before.variant.variantInputSetHash,
    });
  });

  it("does not let an obsolete worker accept content over a later successful attempt", async () => {
    const f = await fixture();
    const lease = await claim(f);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const old = generateBrainArticleVariant({ ...lease, generate: async () => {
      entered(); await held; return { title: "Old attempt", bodyMd: "Obsolete output" };
    } });
    await waiting;
    await prisma.workflowJob.update({ where: { id: lease.jobId }, data: { attempts: 2, lockedBy: "worker-new" } });
    const current = await generateBrainArticleVariant({ ...lease, expectedAttempt: 2, expectedOwner: "worker-new",
      generate: async () => ({ title: "Current attempt", bodyMd: "Current permitted facts" }) });
    release();
    expect(await old).toEqual({ phase: "SUPERSEDED" });
    expect(current.phase).toBe("APPLIED");
    expect(await prisma.brainArticle.findMany({ where: { variantOfArticleId: f.canonical.id } }))
      .toMatchObject([{ title: "Current attempt", bodyMd: "Current permitted facts" }]);
  });

  it("indexes an owner-only variant and gates search cache and chunk redemption after source and member changes", async () => {
    const f = await fixture();
    const { variant } = await generateVariant(f);
    vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage: { provider: "fixture", model: "fixture-embed" },
    }));
    vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({ documents }) => ({
      results: documents.map((document, index) => ({ index, score: 1, document })), usage: { provider: "fixture", model: "fixture-rerank" },
    }));
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: variant.id, lineageActor: f.readerActor })).toBe(1);
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: f.canonical.id, lineageActor: f.ownerActor })).toBe(1);
    const query = { actor: f.readerActor, workspaceId: f.workspace.id, query: "public launch planning", sourceTypes: ["BRAIN_ARTICLE" as const] };
    const results = await searchIndexedKnowledge(query);
    expect(results.map((result) => result.sourceId)).toEqual([variant.id]);
    expect(JSON.stringify(results)).not.toContain("PRIVATE");
    expect((await searchIndexedKnowledge({ ...query, actor: f.ownerActor })).map((result) => result.sourceId)).toEqual([f.canonical.id]);
    expect(await searchIndexedKnowledge({ ...query, workspaceId: f.foreign.id })).toEqual([]);
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { sourceId: variant.id } });
    const receipt = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, artifactType: "KnowledgeChunk", artifactId: chunk.id,
    }, orderBy: { revision: "desc" } });
    expect(receipt).toMatchObject({ origin: "DERIVED", contentHash: lineageContentFingerprint("KnowledgeChunk", chunk) });
    expect(chunk.metadata).toMatchObject({ type: variant.type, authority: variant.authority, slug: variant.slug,
      sourceContentHash: lineageContentFingerprint("BrainArticle", variant), sourceType: "BRAIN_ARTICLE", chunkIndex: 0 });
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, chunk.id)).toMatchObject({ id: chunk.id });
    expect(await fetchReadableKnowledgeChunk(f.ownerActor, f.workspace.id, chunk.id)).toBeNull();
    await archiveAndRestoreSource(f);
    expect(await searchIndexedKnowledge(query)).toEqual([]);
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, chunk.id)).toBeNull();
    const row = await prisma.brainArticle.findUniqueOrThrow({ where: { id: variant.id } });
    expect(await readableArtifactIds(f.readerActor, f.workspace.id, "BrainArticle", [row])).toEqual(new Set());
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await expect(searchIndexedKnowledge(query)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("requires a fresh variant and chunk after its owner's membership is revoked and restored", async () => {
    const f = await fixture();
    const { variant } = await generateVariant(f);
    vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage: { provider: "fixture", model: "fixture-embed" },
    }));
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: variant.id, lineageActor: f.readerActor })).toBe(1);
    const previousChunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { sourceId: variant.id } });
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await expect(fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, previousChunk.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true } });
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, previousChunk.id)).toBeNull();
    const { variant: rebuilt } = await generateVariant(f);
    expect(rebuilt.id).not.toBe(variant.id);
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: rebuilt.id, lineageActor: f.readerActor })).toBe(1);
    const currentChunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { sourceId: rebuilt.id } });
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, currentChunk.id)).toMatchObject({ id: currentChunk.id });
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, previousChunk.id)).toBeNull();
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: variant.id } })).toMatchObject({ bodyMd: variant.bodyMd });
  });

  it("rolls back replacement chunks when persisted output differs from the generated full rows", async () => {
    const f = await fixture();
    const { variant } = await generateVariant(f);
    vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage: { provider: "fixture", model: "fixture-embed" },
    }));
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: variant.id, lineageActor: f.readerActor })).toBe(1);
    const before = await prisma.knowledgeChunk.findMany({ where: { sourceId: variant.id } });
    const client = getPrismaClient();
    const transaction = client.$transaction.bind(client);
    // Exercise a changed SQL output with the real source/epoch/receipt helpers.
    // No source permission gate is replaced by this faulty writer fixture.
    vi.spyOn(client, "$transaction").mockImplementation((async (work: unknown, options?: object) => {
      if (typeof work !== "function") throw new Error("Expected a callback transaction in the indexing fixture.");
      return transaction(async tx => work(new Proxy(tx, { get(target, property, receiver) {
        if (property !== "knowledgeChunk") return Reflect.get(target, property, receiver);
        return new Proxy(target.knowledgeChunk, { get(delegate, method, delegateReceiver) {
          if (method !== "createMany") return Reflect.get(delegate, method, delegateReceiver);
          return (args: Prisma.KnowledgeChunkCreateManyArgs) => delegate.createMany({ ...args,
            data: (Array.isArray(args.data) ? args.data : [args.data]).map(row => ({ ...row,
              content: `${row.content} synthetic unexpected SQL output` })) });
        } });
      } })), options);
    }) as typeof prisma.$transaction);
    await expect(syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: variant.id, lineageActor: f.readerActor }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED", message: "Persisted knowledge output differs from the generated chunks." });
    expect(await prisma.knowledgeChunk.findMany({ where: { sourceId: variant.id } })).toEqual(before);
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, before[0].id)).toMatchObject({ id: before[0].id });
  });
});
