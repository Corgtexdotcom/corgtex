import { createHmac } from "node:crypto";
import { AppError } from "./errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  txMock,
  createActionMock,
  slackWebClientMock,
  meetingReviewConfirmMock,
  meetingReviewDismissMock,
  meetingReviewEditViewMock,
  meetingReviewModalUpdateMock,
  captureDigestProofMock,
  digestProofReadableMock,
  reviewPublicationMock,
  reviewRefreshMock,
  requireMembershipMock,
} = vi.hoisted(() => {
  const tx = {
    communicationInstallation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceIntegrationBinding: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    communicationIngressInput: { create: vi.fn(), findFirst: vi.fn() },
    communicationMessageNativeInput: { create: vi.fn(async ({data}: any)=>({id:"native-1",...data})) },
    communicationInboundEvent: { findUnique: vi.fn(), create: vi.fn() },
    workflowJob: { upsert: vi.fn() },
    communicationEntityLink: { create: vi.fn() },
    $queryRaw: vi.fn(),
    agentRequestInput: { create: vi.fn() },
    member: { findFirst: vi.fn() },
    communicationChannel: { findFirst: vi.fn(), updateMany: vi.fn() },
    communicationExternalUser: { findFirst: vi.fn() },
    communicationMessage: { findFirst: vi.fn(), upsert: vi.fn() },
  };
  const webClient = {
    auth: { test: vi.fn() },
    conversations: {
      list: vi.fn(),
      join: vi.fn(),
      history: vi.fn(),
      replies: vi.fn(),
      info: vi.fn(),
    },
    oauth: {
      v2: { access: vi.fn() },
    },
    chat: {
      postMessage: vi.fn(),
      postEphemeral: vi.fn(),
      update: vi.fn(),
      getPermalink: vi.fn(),
    },
    users: {
      lookupByEmail: vi.fn(),
      info: vi.fn(),
    },
    views: {
      publish: vi.fn(),
      open: vi.fn(),
    },
  };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(tx)),
      communicationIngressInput: { create: vi.fn(), findFirst: vi.fn() },
      communicationInboundEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      communicationInstallation: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
      workspaceIntegrationBinding: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      member: { findFirst: vi.fn() },
      agentRequestInput: { create: vi.fn() },
      communicationChannel: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
      communicationExternalUser: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      communicationMessage: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      knowledgeChunk: {
        deleteMany: vi.fn(),
      },
      meeting: {
        findFirst: vi.fn(),
      },
      communicationEntityLink: {
        create: vi.fn(),
        upsert: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      workflowJob: {
        upsert: vi.fn(),
      },
    },
    createActionMock: vi.fn(),
    slackWebClientMock: webClient,
    meetingReviewConfirmMock: vi.fn(),
    meetingReviewDismissMock: vi.fn(),
    meetingReviewEditViewMock: vi.fn(),
    meetingReviewModalUpdateMock: vi.fn(),
    captureDigestProofMock: vi.fn(),
    digestProofReadableMock: vi.fn(),
    reviewPublicationMock: vi.fn(),
    reviewRefreshMock: vi.fn(),
    requireMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", async () => ({
  ...(await import("../../shared/src/support-context")),
  prisma: prismaMock,
  env: {
    APP_URL: "https://app.example.test",
    NODE_ENV: "test",
    SLACK_SIGNING_SECRET: "slack-secret",
    get SLACK_WORKSPACE_BINDINGS_JSON() { return process.env.SLACK_WORKSPACE_BINDINGS_JSON; },
    SLACK_CLIENT_ID: "global-client",
    SLACK_CLIENT_SECRET: "global-secret",
    ENCRYPTION_KEY: "a".repeat(64),
  },
  randomOpaqueToken: vi.fn(() => "nonce"),
  toInputJson: (value: unknown) => value,
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
}));

vi.mock("./actions", () => ({
  createAction: createActionMock,
  publishAction: vi.fn(),
}));

vi.mock("./tensions", () => ({
  createTension: vi.fn(),
  publishTension: vi.fn(),
}));

vi.mock("./proposals", () => ({
  createProposal: vi.fn(),
  submitProposal: vi.fn(),
}));

vi.mock("./brain", () => ({
  ingestSource: vi.fn(),
}));

vi.mock("./source-permission-epochs", async (original) => ({ ...await original<typeof import("./source-permission-epochs")>(), artifactPermissionEpochIdentities:()=>[{kind:"Workspace",id:"workspace-1"}],
  capturePermissionEpochs:vi.fn(async()=>({version:1})),isArtifactPermissionEpochProofCurrent:vi.fn(async()=>true) }));
vi.mock("./source-lineage", () => ({ recordArtifactInputLineage:vi.fn(), preserveUnknownArtifactInputSnapshot:vi.fn(),
  captureArtifactInputProof: captureDigestProofMock,
  mergeLineageInputRoot: (prior: {fingerprint: string} | undefined, root: {fingerprint: string}) => {
    if (prior && prior.fingerprint !== root.fingerprint) throw new AppError(409, "SOURCE_CHANGED", "Changed original");
    return root;
  },
  withArtifactCountReleaseSnapshot: async (actor: unknown, workspaceId: string, roots: unknown[], remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
    if (roots.length && !await digestProofReadableMock(actor, workspaceId, roots)) throw new AppError(409, "SOURCE_CHANGED", "Changed original");
    await remote();
    if (roots.length && !await digestProofReadableMock(actor, workspaceId, roots)) throw new AppError(409, "SOURCE_CHANGED", "Changed original");
    return finish(txMock);
  },
  captureArtifactInputSnapshotProof: vi.fn(async () => []),
  lineageContentFingerprint: (_kind: string, row: unknown) => JSON.stringify(row),
  isArtifactInputProofReadable: digestProofReadableMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireMembershipMock,
}));

vi.mock("./meeting-action-review", () => ({
  assertMeetingReviewPublicPublication: reviewPublicationMock,
  refreshSlackMeetingActionReviewAfterWebApply: reviewRefreshMock,
  SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID: "corgtex_meeting_review_edit_modal",
  isSlackMeetingActionReviewAction: (actionId: string) => [
    "corgtex_meeting_review_confirm",
    "corgtex_meeting_review_edit",
    "corgtex_meeting_review_dismiss",
  ].includes(actionId),
  parseSlackMeetingActionReviewActionValue: (value: string) => JSON.parse(value || "{}"),
  buildSlackMeetingActionReviewEditView: meetingReviewEditViewMock,
  confirmSlackMeetingActionReviewProposal: meetingReviewConfirmMock,
  dismissSlackMeetingActionReviewProposal: meetingReviewDismissMock,
  updateSlackMeetingActionReviewProposalFromModal: meetingReviewModalUpdateMock,
}));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn(function WebClient() {
    return slackWebClientMock;
  }),
}));

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", "slack-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Headers({
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  });
}

/** Real HMAC ingress and current provider fixtures replace the old raw-row shortcuts. */
async function authenticatedCommunicationFixture() {
  const domain = await import("./communication");
  const authority = await import("./communication-native-authority");
  const defaults = (row: any) => ({ externalWorkspaceId:"T1",appId:"A1",botUserId:"UBOT",botTokenEnc:"enc:token",provider:"SLACK",
    scopes:[],optionalScopes:[],disconnectedAt:null,settings:{}, ...row });
  const signed = (payload: Record<string,unknown>) => { const raw=JSON.stringify(payload); return domain.captureSlackSignedIngress(raw,signedHeaders(raw)); };
  return { ...domain,
    syncSlackPublicArchiveForWorkspace: async (workspaceId: string) => {
      const installation=defaults(await prismaMock.communicationInstallation.findFirst({where:{workspaceId}}));
      prismaMock.communicationInstallation.findFirst.mockResolvedValue(installation);
      txMock.communicationInstallation.findUnique.mockResolvedValue(installation);
      slackWebClientMock.conversations.history.mockImplementation(async()=>({ok:true,messages:[{ts:"1714320000.000100",user:"U1",text:"Public update"}]}));
      return domain.syncSlackPublicArchiveForWorkspace(workspaceId);
    },
    handleSlackCommand: async (payload: URLSearchParams) => {
      const installation=defaults(await prismaMock.communicationInstallation.findUnique({where:{id:"install-1"}}));
      prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce(installation);
      payload=new URLSearchParams(payload);payload.set("api_app_id","A1");
      return domain.handleSlackCommand(payload,signed(Object.fromEntries(payload)));
    },
    handleSlackInteraction: async (payload: Record<string,unknown>) => {
      const installation=defaults(await prismaMock.communicationInstallation.findUnique({where:{id:"install-1"}}));
      prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce(installation);
      payload={...payload,api_app_id:"A1"};
      return domain.handleSlackInteraction(payload,signed(payload));
    },
    ingestCommunicationEvent: async (provider: any,payload: Record<string,unknown>) => {
      const installation=defaults(await prismaMock.communicationInstallation.findUnique({where:{id:"install-1"}}));
      prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce(installation);
      txMock.communicationInstallation.findUnique.mockResolvedValue(installation);
      txMock.communicationInboundEvent.findUnique.mockImplementation(prismaMock.communicationInboundEvent.findUnique);
      txMock.communicationInboundEvent.create.mockImplementation(prismaMock.communicationInboundEvent.create);
      txMock.communicationIngressInput.create.mockImplementation(async ({data}:any)=>({id:"ingress-1",...data}));
      const body={...payload,api_app_id:"A1"};
      return domain.ingestCommunicationEvent(provider,body,signed(body));
    },
    processSlackInboundEvent: async (id: string) => {
      const inbound:any = await prismaMock.communicationInboundEvent.findUnique({where:{id}});
      if (!inbound?.installation) return;
      inbound.installation=defaults(inbound.installation);
      inbound.payload={...inbound.payload,team_id:"T1",api_app_id:"A1"};
      inbound.ingressInputId="signed-ingress-1";
      const proof=signed(inbound.payload);
      const ingress={id:inbound.ingressInputId,workspaceId:inbound.installation.workspaceId,installationId:inbound.installation.id,provider:"SLACK",
        externalWorkspaceId:"T1",appId:"A1",requestTimestamp:proof.requestTimestamp,signature:proof.signature,signingBindingHash:proof.signingBindingHash,
        installationGrantHash:authority.communicationInstallationGrantHash(inbound.installation),encryptedRawBody:`enc:${proof.rawBody}`,bodyHash:proof.bodyHash,
        epochProofVersion:1,permissionEpochsJson:{version:1},expiresRawAt:new Date(Date.now()+86400000)};
      prismaMock.communicationIngressInput.findFirst.mockResolvedValue(ingress);
      prismaMock.communicationInstallation.findFirst.mockResolvedValue(inbound.installation);
      txMock.communicationInstallation.findUnique.mockResolvedValue(inbound.installation);
      prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(inbound);
      const event=inbound.payload.event, raw=event?.message??event;
      const native={ts:raw?.ts,user:raw?.user,text:raw?.text,thread_ts:raw?.thread_ts};
      slackWebClientMock.conversations.history.mockResolvedValue({ok:true,messages:[native]});
      slackWebClientMock.conversations.replies.mockResolvedValue({ok:true,messages:[native]});
      return domain.processSlackInboundEvent(id);
    },
  };
}

function slackMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    externalChannelId: "C1",
    externalMessageId: "1714320000.000100",
    threadExternalId: null,
    messageTs: new Date("2024-04-28T16:00:00.000Z"),
    updatedAt: new Date("2024-04-28T16:00:01.000Z"),
    ...overrides,
  };
}

function stubAuthoredSlackScope() {
  const installation = { externalWorkspaceId:"T1",appId:"A1",botUserId:"UBOT",scopes:[],optionalScopes:[], id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", disconnectedAt: null, botTokenEnc: "enc:bot-token", settings: {} };
  const channel = { id: "channel-1", workspaceId: "workspace-1", installationId: "install-1", provider: "SLACK", externalChannelId: "C1", kind: "PUBLIC", isIngestEnabled: true, isArchived: false };
  const member = { id: "member-1", workspaceId: "workspace-1", userId: "user-1", isActive: true,
    user: { id: "user-1", email: "user@example.test", displayName: "User" } };
  const mapping = { id: "external-user-1", workspaceId: "workspace-1", installationId: "install-1", provider: "SLACK", externalUserId: "U1", userId: "user-1", memberId: "member-1", isBot: false, isDeleted: false };
  prismaMock.communicationInstallation.findFirst.mockResolvedValue(installation);
  prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
  prismaMock.communicationChannel.findFirst.mockResolvedValue(channel);
  prismaMock.member.findFirst.mockResolvedValue(member);
  prismaMock.communicationExternalUser.findFirst.mockResolvedValue(mapping);
  prismaMock.agentRequestInput.create.mockImplementation(async ({ data }: any) => ({ id: "request-1", ...data }));
  prismaMock.communicationMessage.findFirst.mockResolvedValue(null);
  prismaMock.communicationMessage.findMany.mockResolvedValue([]);
  txMock.communicationInstallation.findUnique.mockResolvedValue(installation);
  txMock.communicationInstallation.findFirst.mockResolvedValue(installation);
  txMock.communicationChannel.findFirst.mockResolvedValue(channel);
  txMock.member.findFirst.mockResolvedValue(member);
  txMock.communicationExternalUser.findFirst.mockResolvedValue(mapping);
  txMock.agentRequestInput.create.mockImplementation(async ({ data }: any) => ({ id: "request-1", ...data }));
  txMock.communicationMessage.findFirst.mockResolvedValue(null);
  txMock.communicationMessage.upsert.mockImplementation(async ({ create }: any) => slackMessageRow({ id: "message-1", ...create }));
  txMock.$queryRaw.mockResolvedValue([]);
  slackWebClientMock.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_private: false, is_member: true, is_archived: false } });
}

describe("communication Slack integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.communicationInboundEvent.findUnique.mockReset();
    prismaMock.communicationInstallation.findUnique.mockReset();
    prismaMock.communicationIngressInput.findFirst.mockReset();
    txMock.communicationMessageNativeInput.create.mockImplementation(async ({data}:any)=>({id:"native-1",...data}));
    slackWebClientMock.auth.test.mockResolvedValue({ok:true,team_id:"T1",user_id:"UBOT"});
    prismaMock.communicationInstallation.findFirst.mockReset();
    txMock.communicationMessage.findFirst.mockReset().mockResolvedValue(null);
    txMock.communicationMessage.upsert.mockImplementation(async ({create}:any)=>slackMessageRow({expiresRawAt:new Date(Date.now()+86400000),...create}));
    txMock.communicationChannel.findFirst.mockResolvedValue({id:"channel-1",workspaceId:"workspace-1",installationId:"install-1",provider:"SLACK",externalChannelId:"C1",kind:"PUBLIC",isIngestEnabled:true,isArchived:false});
    prismaMock.communicationChannel.findFirst.mockResolvedValue({id:"channel-1",workspaceId:"workspace-1",installationId:"install-1",provider:"SLACK",externalChannelId:"C1",kind:"PUBLIC",isIngestEnabled:true,isArchived:false});
    slackWebClientMock.conversations.info.mockResolvedValue({ok:true,channel:{id:"C1",is_private:false,is_archived:false,is_member:true}});
    requireMembershipMock.mockReset().mockResolvedValue(undefined);
    reviewPublicationMock.mockReset().mockImplementation(async (actor, params) => {
      await requireMembershipMock({ actor, workspaceId: params.workspaceId });
      if (!params.lineageRoots?.length) throw new AppError(403, "UNKNOWN_LINEAGE", "Synthetic review input proof is unavailable.");
    });
    reviewRefreshMock.mockReset().mockResolvedValue(null);
    captureDigestProofMock.mockReset().mockImplementation(async (_actor, _workspaceId, inputs) =>
      inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    digestProofReadableMock.mockReset().mockResolvedValue(true);
    prismaMock.communicationChannel.findMany.mockReset().mockResolvedValue([{ installationId: "install-1", externalChannelId: "C1" }]);
    vi.stubEnv("SLACK_WORKSPACE_BINDINGS_JSON", undefined);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    createActionMock.mockResolvedValue({ id: "action-1" });
    prismaMock.communicationEntityLink.create.mockResolvedValue({});
    prismaMock.communicationEntityLink.upsert.mockResolvedValue({ id: "stop-marker" });
    prismaMock.communicationEntityLink.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.communicationEntityLink.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.communicationEntityLink.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.communicationEntityLink.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.communicationMessage.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.communicationMessage.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.communicationMessage.findMany.mockReset().mockResolvedValue([]);
    prismaMock.knowledgeChunk.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.workspaceIntegrationBinding.findUnique.mockReset();
    prismaMock.workspaceIntegrationBinding.upsert.mockReset();
    prismaMock.communicationInstallation.findFirst.mockReset();
    prismaMock.communicationInstallation.findUnique.mockReset();
    prismaMock.communicationChannel.upsert.mockReset();
    prismaMock.communicationExternalUser.findFirst.mockReset();
    prismaMock.communicationExternalUser.findUnique.mockReset();
    prismaMock.communicationExternalUser.upsert.mockReset();
    prismaMock.user.findUnique.mockReset();
    prismaMock.communicationMessage.upsert.mockReset();
    prismaMock.communicationInstallation.update.mockReset();
    txMock.workspaceIntegrationBinding.findUnique.mockReset().mockResolvedValue(null);
    txMock.workspaceIntegrationBinding.upsert.mockReset().mockResolvedValue({ id: "binding-1", externalWorkspaceId: "T1" });
    txMock.communicationInstallation.findFirst.mockReset().mockResolvedValue(null);
    txMock.communicationInstallation.findUnique.mockReset().mockResolvedValue(null);
    txMock.communicationInstallation.update.mockReset();
    txMock.communicationInstallation.upsert.mockReset().mockResolvedValue({ id: "install-1" });
    txMock.workflowJob.upsert.mockReset();
    txMock.communicationEntityLink.create.mockReset().mockResolvedValue({});
    slackWebClientMock.conversations.list.mockReset();
    slackWebClientMock.conversations.join.mockReset();
    slackWebClientMock.conversations.history.mockReset().mockImplementation(async (args:any) => {
      const responses=await Promise.all(slackWebClientMock.conversations.replies.mock.results.map(result=>result.value));
      return {ok:true,messages:responses.flatMap(response=>response?.messages??[]).filter((row:any)=>row.ts===args.oldest).slice(0,1)};
    });
    slackWebClientMock.conversations.replies.mockReset();
    slackWebClientMock.conversations.info.mockReset().mockResolvedValue({ok:true,channel:{id:"C1",is_private:false,is_archived:false,is_member:true}});
    slackWebClientMock.chat.update.mockReset();
    slackWebClientMock.chat.getPermalink.mockReset();
    slackWebClientMock.users.lookupByEmail.mockReset();
    slackWebClientMock.users.info.mockReset();
    slackWebClientMock.views.open.mockReset();
    prismaMock.meeting.findFirst.mockReset();
    meetingReviewConfirmMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Created action.",
      lineageRoots: [{ kind: "MeetingFollowUpReview", id: "review-1", fingerprint: "a".repeat(64) }],
    });
    meetingReviewDismissMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Dismissed.",
      lineageRoots: [{ kind: "MeetingFollowUpReview", id: "review-1", fingerprint: "a".repeat(64) }],
    });
    meetingReviewEditViewMock.mockReset().mockResolvedValue({ type: "modal", callback_id: "corgtex_meeting_review_edit_modal", blocks: [] });
    meetingReviewModalUpdateMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Updated.",
      lineageRoots: [{ kind: "MeetingFollowUpReview", id: "review-1", fingerprint: "a".repeat(64) }],
    });
  });

  it("uses Slack's canonical workspace permalink for a source message", async () => {
    const { slackSourceLink } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({ botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    slackWebClientMock.chat.getPermalink.mockResolvedValueOnce({ ok: true, permalink: "https://customer.slack.com/archives/C1/p1714320000000100" });

    await expect(slackSourceLink("install-1", "C1", "1714320000.000100")).resolves.toEqual({ url: "https://customer.slack.com/archives/C1/p1714320000000100", label: "Slack source" });
    expect(slackWebClientMock.chat.getPermalink).toHaveBeenCalledWith({ channel: "C1", message_ts: "1714320000.000100" });
  });

  it("falls back to the installation-qualified channel when Slack cannot return a permalink", async () => {
    const { slackSourceLink } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({ botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    slackWebClientMock.chat.getPermalink.mockRejectedValueOnce(new Error("temporary Slack error"));

    await expect(slackSourceLink("install-1", "C1", "1714320000.000100")).resolves.toEqual({ url: "https://app.slack.com/client/T1/C1", label: "Slack channel" });
  });

  it("verifies Slack request signatures", async () => {
    const { verifySlackRequest } = await authenticatedCommunicationFixture();
    const body = JSON.stringify({ type: "event_callback" });

    expect(verifySlackRequest(body, signedHeaders(body))).toBe(true);
  });

  it("counts only current complete Message inputs across unknown crowding before returning installation totals", async () => {
    const {listCommunicationInstallations} = await import("./communication");
    prismaMock.communicationInstallation.findMany.mockResolvedValue([{id:"install-1",_count:{channels:1,externalUsers:1}}]);
    const rows=Array.from({length:5005},(_,index)=>({id:`row-${String(index).padStart(4,"0")}`,workspaceId:"workspace-1",installationId:"install-1"}));
    prismaMock.communicationMessage.findMany.mockImplementation(async({where,take}:any)=>rows.filter(row=>!where.id?.gt||row.id>where.id.gt).slice(0,take));
    captureDigestProofMock.mockImplementation(async(_actor,_ws,inputs:any[])=>{
      if(inputs.some(input=>Number(input.id.slice(4))<5002))throw new AppError(409,"UNKNOWN_LINEAGE","Synthetic unknown message");
      return inputs.map(input=>({kind:input.kind,id:input.id,fingerprint:"a".repeat(64)}));
    });
    const result=await listCommunicationInstallations({kind:"user",user:{id:"admin",email:"admin@example.test",displayName:"Admin"}},"workspace-1");
    expect(result[0]._count.messages).toBe(3);
    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledTimes(51);
    expect(prismaMock.communicationMessage.findMany.mock.calls.every(([query]: any[]) => query.take === 100)).toBe(true);
    expect(prismaMock.communicationInstallation.findMany.mock.calls[0][0].select._count.select).toEqual({channels:true,externalUsers:true});
  });

  it("does not release an installation total after an earlier source is revoked during a later page", async () => {
    const {listCommunicationInstallations} = await import("./communication");
    prismaMock.communicationInstallation.findMany.mockResolvedValue([{id: "install-1", _count: {channels: 1, externalUsers: 0}}]);
    const rows = Array.from({length: 101}, (_, i) => ({id: `row-${String(i).padStart(3, "0")}`, workspaceId: "workspace-1", installationId: "install-1"}));
    prismaMock.communicationMessage.findMany.mockImplementation(async ({where, take}: any) => {
      if (where.id?.gt) digestProofReadableMock.mockResolvedValue(false);
      return rows.filter(row => !where.id?.gt || row.id > where.id.gt).slice(0, take);
    });
    await expect(listCommunicationInstallations({kind: "user", user: {id: "admin", email: "admin@example.test", displayName: "Admin"}}, "workspace-1"))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

  it("bounds Slack digest messages by an optional upper cutoff", async () => {
    const { listSlackMessagesForDigest } = await authenticatedCommunicationFixture();
    const since = new Date("2026-04-29T12:00:00.000Z");
    const until = new Date("2026-04-30T12:00:00.000Z");

    await listSlackMessagesForDigest({ kind: "agent", authProvider: "bootstrap", label: "Digest test", workspaceIds: ["workspace-1"] }, "workspace-1", since, until);

    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        receivedAt: { gte: since, lte: until },
        text: { not: null },
        isBot: false,
        isHidden: false,
        isDeleted: false,
      }),
    }));
  });

  it("fills the 500-message digest sample after discarding earlier unauthorized snapshots", async () => {
    const { listSlackMessagesForDigest } = await authenticatedCommunicationFixture();
    const actor = { kind: "agent" as const, authProvider: "bootstrap" as const, label: "Digest test", workspaceIds: ["workspace-1"] };
    const since = new Date("2026-04-29T12:00:00Z");
    const rows = Array.from({ length: 1070 }, (_, index) => ({
      id: `digest-${String(index).padStart(4, "0")}`, workspaceId: "workspace-1", installationId: "install-1", provider: "SLACK",
      externalChannelId: "C1", receivedAt: new Date(since.getTime() + index), text: `Synthetic Slack input ${index}`,
      isBot: false, isHidden: false, isDeleted: false, textRedactedAt: null,
    }));
    prismaMock.communicationMessage.findMany.mockImplementation(async (query) => {
      const cursor = query.where.AND?.[0].OR;
      return rows.filter((row) => !cursor || row.receivedAt > cursor[0].receivedAt.gt
        || (row.receivedAt.getTime() === cursor[1].receivedAt.getTime() && row.id > cursor[1].id.gt)).slice(0, query.take);
    });
    captureDigestProofMock.mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (Number(inputs[0].id.split("-")[1]) < 550) throw new AppError(409, "SOURCE_RESTRICTED", "Synthetic revoked input");
      return [{ kind: "CommunicationMessage", id: inputs[0].id, fingerprint: "a".repeat(64) }];
    });

    const selected = await listSlackMessagesForDigest(actor, "workspace-1", since);

    expect(selected).toHaveLength(500);
    expect(selected[0].id).toBe("digest-0550");
    expect(selected.at(-1)?.id).toBe("digest-1049");
    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledTimes(11);
    expect(prismaMock.communicationMessage.findMany.mock.calls.every(([query]) => query.take === 100)).toBe(true);
    expect(prismaMock.communicationMessage.findMany.mock.calls[1][0]).toMatchObject({
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      where: { AND: [{ OR: [{ receivedAt: { gt: rows[99].receivedAt } }, { receivedAt: rows[99].receivedAt, id: { gt: rows[99].id } }] }] },
    });
  });

  it("applies the shared audience gate before the Slack digest sample cap", async () => {
    const { listSlackMessagesForDigest } = await authenticatedCommunicationFixture();
    const actor = { kind: "agent" as const, authProvider: "bootstrap" as const, label: "Digest test", workspaceIds: ["workspace-1"] };
    const audience = [{ kind: "user" as const, user: { id: "synthetic-user", email: "synthetic@example.test", displayName: "Synthetic user" } }];
    const rows = [{ id: "revoked-for-reader", receivedAt: new Date("2026-04-29T12:00:00Z") }, { id: "shared", receivedAt: new Date("2026-04-29T13:00:00Z") }];
    prismaMock.communicationMessage.findMany.mockResolvedValue(rows);
    digestProofReadableMock.mockImplementation(async (_actor, _workspaceId, roots) => roots[0].id === "shared");

    expect(await listSlackMessagesForDigest(actor, "workspace-1", new Date("2026-04-29T00:00:00Z"), undefined, audience)).toEqual([rows[1]]);
    expect(digestProofReadableMock).toHaveBeenCalledWith(audience[0], "workspace-1", expect.any(Array));
  });

  it("prefilters live public channels and installs before loading digest messages", async () => {
    const { listSlackMessagesForDigest } = await authenticatedCommunicationFixture();
    const actor = { kind: "agent" as const, authProvider: "bootstrap" as const, label: "Digest test", workspaceIds: ["workspace-1"] };
    await listSlackMessagesForDigest(actor, "workspace-1", new Date("2026-04-29T00:00:00Z"));
    expect(prismaMock.communicationChannel.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", provider: "SLACK", kind: "PUBLIC", isIngestEnabled: true, isArchived: false,
        installation: { workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", disconnectedAt: null } },
      select: { installationId: true, externalChannelId: true },
    });
    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      OR: [{ installationId: "install-1", externalChannelId: "C1" }], textRedactedAt: null,
      installation: { workspaceId: "workspace-1", status: "ACTIVE", disconnectedAt: null },
    }) }));
    prismaMock.communicationMessage.findMany.mockClear();
    prismaMock.communicationChannel.findMany.mockResolvedValue([]);
    expect(await listSlackMessagesForDigest(actor, "workspace-1", new Date("2026-04-29T00:00:00Z"))).toEqual([]);
    expect(prismaMock.communicationMessage.findMany).not.toHaveBeenCalled();
  });

  it("rejects stale Slack request timestamps", async () => {
    const { verifySlackRequest } = await authenticatedCommunicationFixture();
    const body = "{}";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;

    expect(() => verifySlackRequest(body, signedHeaders(body, staleTimestamp))).toThrow("timestamp");
  });

  const scopedWorkspace = "11111111-1111-4111-8111-111111111111";
  function configureScopedSlack() {
    vi.stubEnv("SLACK_WORKSPACE_BINDINGS_JSON", JSON.stringify({ [scopedWorkspace]: {
      teamId: "T1", appId: "A1", clientId: "111.222", clientSecret: "scoped-client-secret",
      signingSecret: "slack-secret", scopes: ["commands", "channels:history"],
    } }));
  }

  it("authenticates scoped envelopes and rejects signed wrong-team or wrong-app payloads", async () => {
    const { verifySlackRequest } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    const envelope = JSON.stringify({team_id: "T1", api_app_id: "A1", event: {type: "message"}});
    expect(verifySlackRequest(envelope, signedHeaders(envelope), scopedWorkspace)).toBe(true);
    for (const payload of [{team_id: "T2", api_app_id: "A1"}, {team_id: "T1", api_app_id: "A2"}]) {
      const raw = JSON.stringify(payload);
      expect(() => verifySlackRequest(raw, signedHeaders(raw), scopedWorkspace)).toThrow("does not match");
    }
    expect(() => verifySlackRequest(envelope, signedHeaders(envelope))).toThrow("not configured");
    expect(() => verifySlackRequest(envelope, signedHeaders(envelope), "22222222-2222-4222-8222-222222222222")).toThrow("not configured");
    const challenge = JSON.stringify({type: "url_verification", challenge: "test-challenge"});
    expect(verifySlackRequest(challenge, signedHeaders(challenge), scopedWorkspace)).toBe(true);
    expect(() => verifySlackRequest(challenge, new Headers(), scopedWorkspace)).toThrow("timestamp");
    const command = new URLSearchParams({team_id: "T1", api_app_id: "A1", command: "/corgtex"}).toString();
    expect(verifySlackRequest(command, signedHeaders(command), scopedWorkspace)).toBe(true);
    const interaction = new URLSearchParams({payload: JSON.stringify({team: {id: "T1"}, api_app_id: "A1"})}).toString();
    expect(verifySlackRequest(interaction, signedHeaders(interaction), scopedWorkspace)).toBe(true);
  });

  it("rejects scoped delivery when persisted installation belongs to another workspace", async () => {
    const { verifySlackWorkspaceInstallation } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({id: "install-1", workspaceId: "other", appId: "A1"});
    await expect(verifySlackWorkspaceInstallation(scopedWorkspace, {team_id: "T1", api_app_id: "A1"})).rejects.toThrow("does not match");
    expect(prismaMock.communicationInboundEvent.create).not.toHaveBeenCalled();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({id: "install-1", workspaceId: scopedWorkspace, appId: "A1"});
    await expect(verifySlackWorkspaceInstallation(scopedWorkspace, {team_id: "T1", api_app_id: "A1"})).resolves.toBeUndefined();
  });

  it("exchanges OAuth with scoped credentials and rejects another app response", async () => {
    const { exchangeSlackOAuthCode } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    slackWebClientMock.oauth.v2.access.mockResolvedValue({ok: true, team: {id: "T1"}, app_id: "A1", access_token: "synthetic-token"});
    await exchangeSlackOAuthCode("code", "https://example.test/callback", scopedWorkspace);
    expect(slackWebClientMock.oauth.v2.access).toHaveBeenCalledWith(expect.objectContaining({client_id: "111.222", client_secret: "scoped-client-secret"}));
    slackWebClientMock.oauth.v2.access.mockResolvedValue({ok: true, team: {id: "T1"}, app_id: "A2", access_token: "synthetic-token"});
    await expect(exchangeSlackOAuthCode("code", "https://example.test/callback", scopedWorkspace)).rejects.toThrow("does not match");
  });

  it("preserves reconnect settings and selected channel policy for a scoped app", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    txMock.communicationInstallation.findUnique.mockResolvedValue({workspaceId: scopedWorkspace, settings: {
      mutedChannelIds: ["C-muted"], proactiveEnabled: false, lastPublicArchiveSyncAt: "2026-09-01T00:00:00Z", rawRetentionDays: 90,
    }});
    await saveSlackInstallationForWorkspace({workspaceId: scopedWorkspace, oauthResponse: {
      ok: true, team: {id: "T1"}, app_id: "A1", access_token: "synthetic-token", scope: "commands,channels:history",
    } as any});
    expect(txMock.communicationInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({update: expect.objectContaining({
      settings: {mutedChannelIds: ["C-muted"], proactiveEnabled: false, lastPublicArchiveSyncAt: "2026-09-01T00:00:00Z", rawRetentionDays: 90,
        channelAdmissionMode: "selected", publicArchiveSyncEnabled: false, broadPublicIngestion: false, autoJoinPublicChannels: false},
    })}));
    expect(prismaMock.communicationChannel.upsert).not.toHaveBeenCalled();
  });

  it.each([{ scopes: ["channels:history", "channels:join"] }, { scopes: [] }])("holds queued archive jobs with scopes $scopes", async ({ scopes }) => {
    const { syncSlackPublicArchiveForWorkspace, slackPublicArchiveEnabled } = await authenticatedCommunicationFixture();
    for (const settings of [{publicArchiveSyncEnabled: false}, {publicIngestionEnabled: false}, {channelAdmissionMode: "selected"}, {broadPublicIngestion: false}]) {
      expect(slackPublicArchiveEnabled(settings)).toBe(false);
      prismaMock.communicationInstallation.findFirst.mockResolvedValue({id: "install-1", workspaceId: "ws-1", scopes, settings, botTokenEnc: null});
      await expect(syncSlackPublicArchiveForWorkspace("ws-1")).resolves.toMatchObject({channelsSeen: 0, messagesUpserted: 0});
    }
    expect(slackWebClientMock.conversations.list).not.toHaveBeenCalled();
    expect(slackWebClientMock.conversations.join).not.toHaveBeenCalled();
    expect(slackWebClientMock.conversations.history).not.toHaveBeenCalled();
    expect(prismaMock.communicationInstallation.update).not.toHaveBeenCalled();
  });

  it("checks a durable workspace team before the configured OAuth fallback", async () => {
    const { getSlackExpectedTeamIdForWorkspace } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    prismaMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce({ externalWorkspaceId: "TDURABLE" });
    await expect(getSlackExpectedTeamIdForWorkspace(scopedWorkspace)).resolves.toBe("TDURABLE");
    expect(prismaMock.communicationInstallation.findFirst).not.toHaveBeenCalled();
  });

  it("uses the configured team before dormant installation history when no durable binding exists", async () => {
    const { getSlackExpectedTeamIdForWorkspace } = await authenticatedCommunicationFixture();
    configureScopedSlack();
    prismaMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({ externalWorkspaceId: "TDORMANT" });
    await expect(getSlackExpectedTeamIdForWorkspace(scopedWorkspace)).resolves.toBe("T1");
    expect(prismaMock.communicationInstallation.findFirst).not.toHaveBeenCalled();
  });

  it("requests public channel history and join scopes for archive installs", async () => {
    const { slackOAuthScopes } = await authenticatedCommunicationFixture();

    expect(slackOAuthScopes().split(",")).toEqual(expect.arrayContaining([
      "channels:history",
      "channels:join",
    ]));
  });

  it("round-trips versioned Slack OAuth state with expected team and flow metadata", async () => {
    const { createSlackOAuthState, readSlackOAuthState } = await authenticatedCommunicationFixture();

    const state = createSlackOAuthState("workspace-1", {
      expectedTeamId: "T1",
      flow: {
        kind: "control_plane",
        deploymentId: "dep-1",
        initiatedByUserId: "operator-1",
      },
    });

    expect(readSlackOAuthState(state.value)).toEqual({
      version: 1,
      workspaceId: "workspace-1",
      nonce: "nonce",
      expectedTeamId: "T1",
      flow: {
        kind: "control_plane",
        deploymentId: "dep-1",
        initiatedByUserId: "operator-1",
      },
    });
  });

  it("keeps reading legacy Slack OAuth state while callbacks roll over", async () => {
    const { readSlackOAuthState } = await authenticatedCommunicationFixture();
    const legacyState = Buffer.from(JSON.stringify({
      workspaceId: "workspace-1",
      nonce: "nonce",
    })).toString("base64url");

    expect(readSlackOAuthState(legacyState)).toEqual({
      version: 0,
      workspaceId: "workspace-1",
      nonce: "nonce",
      expectedTeamId: null,
      flow: { kind: "workspace" },
    });
  });

  it("stores archive settings with long retention when public history is granted", async () => {
    const { saveSlackInstallation } = await authenticatedCommunicationFixture();
    txMock.communicationInstallation.upsert.mockResolvedValueOnce({ id: "install-1" });

    await saveSlackInstallation({ kind: "system" } as any, {
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands,channels:history,channels:join",
      } as any,
    });

    expect(txMock.workspaceIntegrationBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_provider: { workspaceId: "workspace-1", provider: "SLACK" } },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
      }),
    }));
    expect(txMock.communicationInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          broadPublicIngestion: true,
          autoJoinPublicChannels: true,
          rawRetentionDays: 3650,
          unansweredFollowupDelayMinutes: 1440,
          unansweredActionCreationDelayMinutes: 1440,
          staleActionFollowupDelayMinutes: 4320,
          label: "Public Channel Archive",
        }),
      }),
      create: expect.objectContaining({
        settings: expect.objectContaining({
          broadPublicIngestion: true,
          autoJoinPublicChannels: true,
          rawRetentionDays: 3650,
          unansweredFollowupDelayMinutes: 1440,
          unansweredActionCreationDelayMinutes: 1440,
          staleActionFollowupDelayMinutes: 4320,
          label: "Public Channel Archive",
        }),
      }),
    }));
  });

  it("stores Slack installations for a target workspace without workspace membership checks", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.communicationInstallation.upsert.mockResolvedValueOnce({ id: "install-1" });

    await saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      installedByUserId: "operator-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        enterprise: { id: "E1" },
        app_id: "A1",
        bot_user_id: "B1",
        access_token: "xoxb-token",
        scope: "commands, chat:write, channels:history",
      } as any,
    });

    expect(txMock.workspaceIntegrationBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_provider: { workspaceId: "workspace-1", provider: "SLACK" } },
      update: expect.objectContaining({
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        installedByUserId: "operator-1",
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        installedByUserId: "operator-1",
      }),
    }));
    expect(txMock.communicationInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: "T1" } },
      update: expect.objectContaining({
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        botUserId: "B1",
        botTokenEnc: "enc:xoxb-token",
        scopes: ["commands", "chat:write", "channels:history"],
        optionalScopes: ["channels:history"],
        status: "ACTIVE",
        installedByUserId: "operator-1",
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
        installedByUserId: "operator-1",
      }),
    }));
  });

  it("rejects Slack OAuth when the selected team does not match the workspace binding", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce({ externalWorkspaceId: "T1" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      expectedTeamId: "T1",
      oauthResponse: {
        ok: true,
        team: { id: "T2", name: "Other Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_MISMATCH",
    });

    expect(txMock.workspaceIntegrationBinding.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects Slack OAuth when that team is already connected to another Corgtex workspace", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.communicationInstallation.findUnique.mockResolvedValueOnce({ workspaceId: "workspace-2" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_ALREADY_CONNECTED",
    });

    expect(txMock.workspaceIntegrationBinding.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("sanitizes concurrent Slack binding uniqueness conflicts", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.workspaceIntegrationBinding.upsert.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    }));

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_ALREADY_CONNECTED",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects same-workspace Slack binding races before saving the losing team installation", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.workspaceIntegrationBinding.upsert.mockResolvedValueOnce({ externalWorkspaceId: "T2" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_WORKSPACE_ALREADY_BOUND",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("does not sanitize unrelated Slack binding database errors as tenant conflicts", async () => {
    const { saveSlackInstallationForWorkspace } = await authenticatedCommunicationFixture();
    txMock.workspaceIntegrationBinding.upsert.mockRejectedValueOnce(Object.assign(new Error("Record not found"), {
      code: "P2025",
    }));

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "P2025",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("resolves notification recipients from cached Slack user mappings before API lookup", async () => {
    const { resolveSlackNotificationRecipient } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      botTokenEnc: "enc:xoxb-token",
    });
    prismaMock.communicationExternalUser.findFirst.mockResolvedValueOnce({
      externalUserId: "U1",
    });

    await expect(resolveSlackNotificationRecipient({
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
    })).resolves.toEqual({
      installationId: "install-1",
      externalUserId: "U1",
    });

    expect(slackWebClientMock.users.lookupByEmail).not.toHaveBeenCalled();
  });

  it("looks up notification recipients by email and caches the Slack mapping", async () => {
    const { resolveSlackNotificationRecipient } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      botTokenEnc: "enc:xoxb-token",
    });
    prismaMock.communicationExternalUser.findFirst.mockResolvedValueOnce(null);
    slackWebClientMock.users.lookupByEmail.mockResolvedValueOnce({
      user: {
        id: "U1",
        name: "andy",
        deleted: false,
        is_bot: false,
        profile: {
          email: "andy@example.test",
          display_name: "Andy",
        },
      },
    });
    prismaMock.communicationExternalUser.upsert.mockResolvedValueOnce({ id: "external-user-1" });

    await expect(resolveSlackNotificationRecipient({
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "andy@example.test",
    })).resolves.toEqual({
      installationId: "install-1",
      externalUserId: "U1",
    });

    expect(slackWebClientMock.users.lookupByEmail).toHaveBeenCalledWith({ email: "andy@example.test" });
    expect(prismaMock.communicationExternalUser.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { installationId_externalUserId: { installationId: "install-1", externalUserId: "U1" } },
      update: expect.objectContaining({
        userId: "user-1",
        email: "andy@example.test",
        displayName: "Andy",
        isBot: false,
        isDeleted: false,
      }),
      create: expect.objectContaining({
        installationId: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalUserId: "U1",
        userId: "user-1",
      }),
    }));
  });

  it("syncs accessible public Slack channel history without storing bot messages", async () => {
    const { syncSlackPublicArchiveForWorkspace } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:xoxb-token",
      scopes: ["channels:history", "channels:join"],
      settings: { rawRetentionDays: 3650 },
      installedAt: new Date(),
    });
    slackWebClientMock.conversations.list.mockResolvedValueOnce({
      channels: [{ id: "C1", name: "general", is_archived: false, is_member: false }],
      response_metadata: {},
    });
    slackWebClientMock.conversations.join.mockResolvedValueOnce({ ok: true });
    slackWebClientMock.conversations.history.mockResolvedValueOnce({
      messages: [
        { ts: "1714320000.000100", user: "U1", text: "Public update" },
        { ts: "1714320001.000100", bot_id: "B1", subtype: "bot_message", text: "ignored" },
      ],
      response_metadata: {},
    });
    prismaMock.communicationChannel.upsert.mockResolvedValue({ id: "channel-1" });
    prismaMock.communicationMessage.upsert.mockResolvedValue(slackMessageRow());
    prismaMock.communicationInstallation.update.mockResolvedValue({ id: "install-1" });

    const summary = await syncSlackPublicArchiveForWorkspace("workspace-1");

    expect(summary).toMatchObject({
      channelsSeen: 1,
      channelsJoined: 1,
      messagesScanned: 2,
      messagesUpserted: 1,
      retentionDays: 3650,
    });
    expect(txMock.communicationMessage.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.communicationInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastError: null },
    }));
  });

  it("deduplicates Slack events and enqueues new events", async () => {
    const { ingestCommunicationEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      status: "ACTIVE",
    });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-1",
    });

    const result = await ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "message" },
    });

    expect(result).toEqual({ inboundEventId: "inbound-1", duplicate: false });
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
      }),
    }));
  });

  it("ignores Slack events for disconnected installations without enqueueing jobs", async () => {
    const { ingestCommunicationEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      status: "DISCONNECTED",
    });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-ignored",
    });

    await expect(ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "EvDisconnected",
      event: { type: "message", text: "do not retain this text" },
    })).rejects.toMatchObject({code:"SLACK_TENANT_MISMATCH"});
    expect(prismaMock.communicationInboundEvent.create).not.toHaveBeenCalled();
    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.update).not.toHaveBeenCalled();
  });

  it("ignores Slack events when the team no longer matches the workspace binding", async () => {
    const { ingestCommunicationEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-legacy",
      workspaceId: "workspace-1",
      status: "ACTIVE",
    });
    prismaMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce({ externalWorkspaceId: "T2" });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-ignored",
    });

    await expect(ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "EvLegacy",
      event: { type: "message" },
    })).rejects.toMatchObject({code:"SLACK_TENANT_MISMATCH"});
    expect(prismaMock.communicationInboundEvent.create).not.toHaveBeenCalled();
    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.update).not.toHaveBeenCalled();
  });

  it("does not process stale queued Slack events after installation disconnect", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-1",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          channel: "C1",
          ts: "1710000000.000100",
          text: "do not retain this text",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        status: "DISCONNECTED",
      },
    });

    await processSlackInboundEvent("inbound-1");

    expect(prismaMock.communicationInboundEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inbound-1" },
      data: expect.objectContaining({
        status: "IGNORED",
        error: "Slack installation is not active.",
      }),
    }));
    expect(txMock.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("keeps unseen public channels disabled after selected-channel reconnect", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-new-channel", provider: "SLACK",
      payload: {event: {type: "message", channel: "C-new", channel_type: "channel", user: "U1", ts: "1714320000.000100", text: "outside selected channels"}},
      installation: {id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", settings: {channelAdmissionMode: "selected"}},
    });
    prismaMock.communicationChannel.upsert.mockImplementationOnce(async ({create}) => ({id: "new-channel", ...create}));
    await processSlackInboundEvent("inbound-new-channel");
    expect(prismaMock.communicationChannel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.not.objectContaining({isIngestEnabled: true}),
      create: expect.objectContaining({externalChannelId: "C-new", isIngestEnabled: false}),
    }));
    expect(txMock.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("stores public Slack message events and queues Brain indexing plus summaries", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-message",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          ts: "1714320000.000100",
          text: "Public launch detail is ready.",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        settings: { rawRetentionDays: 3650 },
      },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow());

    await processSlackInboundEvent("inbound-message");

    expect(txMock.communicationMessage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        text: "Public launch detail is ready.",
        textRedactedAt: null,
        isDeleted: false,
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "knowledge.sync.slack-message",
        payload: { messageId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "external-resource.capture-source",
        payload: { sourceType: "SLACK_MESSAGE", sourceId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.context-summary",
        payload: expect.objectContaining({
          installationId: "install-1",
          channelId: "C1",
        }),
      }),
    }));
  });

  it.each(["STOP", "Stop. Do nothing", "ack"])("persists an unmatched human '%s' reply against its Slack thread", async (text) => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-stop", provider: "SLACK",
      payload: { event: { type: "message", channel: "C1", channel_type: "channel", user: "U-unmatched", ts: "1788896184.791699", thread_ts: "1788205758.060039", text } },
      installation: { id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", settings: {} },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    txMock.communicationMessage.upsert.mockImplementationOnce(async ({create}:any)=>slackMessageRow({...create,id:"stop-message"}));

    await processSlackInboundEvent("inbound-stop");
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ workspaceId: "workspace-1", installationId: "install-1", messageId: "stop-message", externalUserId: "U-unmatched", entityId: "C1:1788205758.060039", action: "slack_followup_suppressed" }),
    }));
  });

  it("removes thread suppression when the originating Slack reply is edited to non-stop text", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-corrected-stop", provider: "SLACK",
      payload: { event: { type: "message", subtype: "message_changed", channel: "C1", message: { type: "message", user: "U1", ts: "1788896184.791699", thread_ts: "1788205758.060039", text: "Got it, but keep reminding me" } } },
      installation: { id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", settings: {} },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    txMock.communicationMessage.upsert.mockImplementationOnce(async ({create}:any)=>slackMessageRow({...create,id:"stop-message"}));
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "marker-1", messageId: "stop-message" });

    await processSlackInboundEvent("inbound-corrected-stop");
    expect(prismaMock.communicationEntityLink.deleteMany).toHaveBeenCalledWith({ where: { id: "marker-1", messageId: "stop-message" } });
  });

  it.each([
    { settings: { publicIngestionEnabled: false }, channelEnabled: true },
    { settings: { publicIngestionEnabled: true, channelAdmissionMode: "selected" }, channelEnabled: false },
  ])("reconciles a stored stop edit while ingestion is held: %j", async ({ settings, channelEnabled }) => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-held-edit", provider: "SLACK",
      payload: { event: { type: "message", subtype: "message_changed", channel: "C1", message: { type: "message", user: "U1", ts: "1788896184.791699", thread_ts: "1788205758.060039", text: "Please keep reminding me" } } },
      installation: { id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", settings },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: channelEnabled });
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessageRow({ id: "stop-message", threadExternalId: "1788205758.060039" }));
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "marker-1", messageId: "stop-message" });

    await processSlackInboundEvent("inbound-held-edit");

    expect(prismaMock.communicationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "stop-message", installationId: "install-1" },
      data: expect.objectContaining({ text: null, raw: expect.anything(), textRedactedAt: expect.any(Date) }),
    }));
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({ where: { sourceType: "SLACK", sourceId: "stop-message" } });
    expect(prismaMock.communicationEntityLink.deleteMany).toHaveBeenCalledWith({ where: { id: "marker-1", messageId: "stop-message" } });
    expect(txMock.communicationMessage.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { rawRetentionDays: 3650 },
    { publicIngestionEnabled: false, channelAdmissionMode: "selected" },
    { publicIngestionEnabled: true, channelAdmissionMode: "selected" },
  ])("redacts existing deleted messages even when ingestion is held: %j", async (settings) => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-delete",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          subtype: "message_deleted",
          channel: "C1",
          channel_type: "channel",
          deleted_ts: "1714320000.000100",
          previous_message: {
            type: "message",
            channel: "C1",
            user: "U1",
            ts: "1714320000.000100",
            text: "Please remove this",
          },
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        settings,
      },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: false });
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessageRow());
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "marker-1", messageId: "message-1" });

    await processSlackInboundEvent("inbound-delete");

    expect(prismaMock.communicationChannel.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationMessage.upsert).not.toHaveBeenCalled();
    expect(prismaMock.communicationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        installationId: "install-1",
        externalChannelId: "C1",
        externalMessageId: "1714320000.000100",
      }),
      data: expect.objectContaining({
        text: null,
        isDeleted: true,
        isHidden: true,
        textRedactedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.communicationEntityLink.deleteMany).toHaveBeenCalledWith({ where: { id: "marker-1", messageId: "message-1" } });
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceType: "SLACK",
        sourceId: "message-1",
      },
    });
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ type: "knowledge.sync.slack-message" }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "external-resource.capture-source",
        payload: { sourceType: "SLACK_MESSAGE", sourceId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.context-summary",
      }),
    }));
  });

  it("does not create channels or history for a deletion without a stored message", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-unknown-delete",
      provider: "SLACK",
      payload: { event: { type: "message", subtype: "message_deleted", channel: "C-unknown", deleted_ts: "1714320000.000100" } },
      installation: {
        id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE",
        settings: { publicIngestionEnabled: false, channelAdmissionMode: "selected" },
      },
    });
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(null);

    await processSlackInboundEvent("inbound-unknown-delete");

    expect(prismaMock.communicationChannel.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationMessage.upsert).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("creates private action drafts from Slack slash commands", async () => {
    const { handleSlackCommand } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    const response = await handleSlackCommand(new URLSearchParams({
      team_id: "T1",
      user_id: "U1",
      text: "action Ship the Slack MVP",
    }));

    expect(createActionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Ship the Slack MVP",
      isPrivate: true,
    }));
    expect(response.text).toContain("Action draft created");
    if (!("blocks" in response)) throw new Error("Expected Slack draft response blocks.");
    expect(JSON.stringify(response.blocks)).toContain("Assign an active human owner");
    expect(JSON.stringify(response.blocks)).not.toContain("corgtex_publish_action");
  });

  it("atomically creates an open Action and final source link for a claim key", async () => {
    const { createWorkItemFromCommunicationSource } = await authenticatedCommunicationFixture();

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      externalUserId: "U1",
      open: true,
      assigneeMemberId: "member-1",
      claimKey: "slack:proactive-action:message-1",
    })).resolves.toMatchObject({
      entityType: "Action",
      entityId: "action-1",
      opened: true,
    });

    expect(createActionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      isPrivate: false,
      _tx: txMock,
    }));
    expect(txMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        claimKey: "slack:proactive-action:message-1",
        entityType: "Action",
        entityId: "action-1",
        action: "create_action",
      }),
    });
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("returns the committed source-linked Action after a concurrent claim-key loss", async () => {
    const uniqueError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    txMock.communicationEntityLink.create.mockRejectedValueOnce(uniqueError);
    prismaMock.communicationEntityLink.findUnique.mockResolvedValueOnce({
      installationId: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      messageId: "message-1",
      entityType: "Action",
      entityId: "action-existing",
      action: "create_action",
      claimKey: "slack:proactive-action:message-1",
    });
    const { createWorkItemFromCommunicationSource } = await authenticatedCommunicationFixture();

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      assigneeMemberId: "member-1",
      claimKey: "slack:proactive-action:message-1",
    })).resolves.toMatchObject({
      entityType: "Action",
      entityId: "action-existing",
      opened: true,
    });
  });

  it("leaves no pre-claim when Action creation fails inside the transaction", async () => {
    const createError = new Error("Action creation failed");
    createActionMock.mockRejectedValueOnce(createError);
    const { createWorkItemFromCommunicationSource } = await authenticatedCommunicationFixture();

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      assigneeMemberId: "member-1",
      claimKey: "slack:proactive-action:message-1",
    })).rejects.toBe(createError);

    expect(txMock.communicationEntityLink.create).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.findUnique).not.toHaveBeenCalled();
  });

  it("does not mask unrelated unique failures or allow claim keys on non-open Actions", async () => {
    const uniqueError = Object.assign(new Error("Unrelated unique constraint failed"), { code: "P2002" });
    txMock.communicationEntityLink.create.mockRejectedValueOnce(uniqueError);
    const { createWorkItemFromCommunicationSource } = await authenticatedCommunicationFixture();
    const actor = {
      kind: "user" as const,
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" as const },
    };

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      assigneeMemberId: "member-1",
      claimKey: "slack:proactive-action:message-1",
    })).rejects.toBe(uniqueError);

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Draft only",
      claimKey: "slack:proactive-action:draft",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "TENSION",
      title: "Not an Action",
      open: true,
      claimKey: "slack:proactive-action:tension",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Blank claim",
      open: true,
      claimKey: "   ",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enqueues plain Slack slash command text for the Slack agent", async () => {
    stubAuthoredSlackScope();
    const { handleSlackCommand } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const response = await handleSlackCommand(new URLSearchParams({
      team_id: "T1",
      user_id: "U1",
      channel_id: "C1",
      response_url: "https://hooks.slack.test/response",
      text: "Jan should follow up with Milan tomorrow",
    }));

    expect(createActionMock).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "slash_command",
          prompt: "Jan should follow up with Milan tomorrow",
          channelId: "C1",
          responseUrlEnc: "enc:https://hooks.slack.test/response",
        }),
      }),
    }));
    expect(response.text).toContain("working");
  });

  it("enqueues app mentions with the bot mention stripped", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-1",
      provider: "SLACK",
      payload: {
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "1710000000.000100",
          text: "<@UBOT> turn this into a tension",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        botUserId: "UBOT",
        botTokenEnc: "enc:bot-token",
      },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000000.000100" }));
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    await processSlackInboundEvent("inbound-1");

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "inbound-1:communication-slack-agent" },
      create: expect.objectContaining({
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "app_mention",
          prompt: "turn this into a tension",
          threadTs: "1710000000.000100",
          sourceMessageId: "message-1",
        }),
      }),
    }));
  });

  it.each(["<@UBOT> STOP", "<@UBOT> STOP ALL FOLLOW UP"])("honors an unmatched Slack mention '%s' without running the agent", async (text) => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-unmatched-stop", provider: "SLACK",
      payload: { event: { type: "app_mention", channel: "C1", user: "U-unmatched", ts: "1788896184.791699", thread_ts: "1788205758.060039", text } },
      installation: { id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botUserId: "UBOT", botTokenEnc: "enc:bot-token", settings: {} },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    txMock.communicationMessage.upsert.mockImplementationOnce(async ({create}:any)=>slackMessageRow({...create,id:"stop-message"}));
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({ id: "install-1", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.chat.postMessage.mockResolvedValueOnce({ ok: true, ts: "1788896185.000001" });

    await processSlackInboundEvent("inbound-unmatched-stop");
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ externalUserId: "U-unmatched", entityId: "C1:1788205758.060039", action: "slack_followup_suppressed" }),
    }));
    expect(prismaMock.communicationExternalUser.findUnique).not.toHaveBeenCalled();
    expect(slackWebClientMock.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", thread_ts: "1788205758.060039", text: "I will stop Corgtex follow-ups in this thread." }));
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ type: "communication.slack.agent" }) }));
  });

  it("routes app mentions in agenda threads to agenda editing", async () => {
    const { processSlackInboundEvent } = await authenticatedCommunicationFixture();
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-agenda",
      provider: "SLACK",
      payload: {
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "1710000001.000100",
          thread_ts: "1710000000.000100",
          text: "<@UBOT> add Bob's detail to action item 2",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        botUserId: "UBOT",
        botTokenEnc: "enc:bot-token",
      },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000001.000100", threadExternalId: "1710000000.000100" }));
    prismaMock.meeting.findFirst.mockResolvedValueOnce({ id: "meeting-1" });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    await processSlackInboundEvent("inbound-agenda");

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "inbound-agenda:meeting-agenda-edit" },
      create: expect.objectContaining({
        type: "meeting.agenda.edit",
        payload: expect.objectContaining({
          meetingId: "meeting-1",
          actorUserId: "user-1",
          installationId: "install-1",
          channelId: "C1",
          threadTs: "1710000000.000100",
          messageTs: "1710000001.000100",
          messageText: "add Bob's detail to action item 2",
          sourceMessageId: "message-1",
        }),
      }),
    }));
  });

  it("validates Slack agenda channels before saving", async () => {
    const { validateSlackPostTarget } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      botTokenEnc: "enc:bot-token",
    });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({
      channel: {
        id: "C1",
        name: "all-corgtex",
        is_archived: false,
        is_member: true,
      },
    });

    await expect(validateSlackPostTarget("install-1", "<#C1|all-corgtex>")).resolves.toEqual({
      ok: true,
      channelId: "C1",
      channelName: "all-corgtex",
    });
  });

  it("rejects Slack agenda channels where the bot is not a member", async () => {
    const { validateSlackPostTarget } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      botTokenEnc: "enc:bot-token",
    });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({
      channel: {
        id: "C1",
        name: "new-channel",
        is_archived: false,
        is_member: false,
      },
    });

    await expect(validateSlackPostTarget("install-1", "C1")).resolves.toMatchObject({
      ok: false,
      code: "SLACK_CHANNEL_NOT_JOINED",
    });
  });

  it("runs the Slack agent for message shortcuts instead of opening the legacy modal", async () => {
    stubAuthoredSlackScope();
    slackWebClientMock.conversations.replies.mockResolvedValue({ ok: true, messages: [{ user: "U2", ts: "1710000000.000100", text: "We need clearer ownership for onboarding." }] });
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000000.000100" }));
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const response = await handleSlackInteraction({
      type: "message_action",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C1" },
      response_url: "https://hooks.slack.test/response",
      message: {
        user: "U2",
        ts: "1710000000.000100",
        text: "We need clearer ownership for onboarding.",
      },
    });

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "message_shortcut",
          requestInputId: "request-1",
          prompt: "Act on the selected Slack message.",
          sourceMessageId: "message-1",
          responseUrlEnc: "enc:https://hooks.slack.test/response",
        }),
      }),
    }));
    expect(response.text).toContain("working");
  });

  it.each([true, undefined])("withholds a required public destination when Slack reports privacy %s", async (isPrivate) => {
    const { validateSlackPostTarget } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", name: "synthetic-target", is_private: isPrivate, is_member: true, is_archived: false } });
    expect(await validateSlackPostTarget("install-1", "C1", { requirePublic: true })).toMatchObject({ ok: false, code: "SLACK_CHANNEL_NOT_PUBLIC" });
  });

  it("accepts an expressly public provider destination while preserving other private agenda validation", async () => {
    const { validateSlackPostTarget } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({ ok: true, channel: { id: "C1", name: "synthetic-public", is_private: false, is_member: true, is_archived: false } });
    expect(await validateSlackPostTarget("install-1", "C1", { requirePublic: true })).toMatchObject({ ok: true });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({ ok: true, channel: { id: "C1", name: "synthetic-private", is_private: true, is_member: true, is_archived: false } });
    expect(await validateSlackPostTarget("install-1", "C1")).toMatchObject({ ok: true });
  });

  it("routes signed meeting-review confirm block actions through Corgtex-side authorization", async () => {
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    const response = await handleSlackInteraction({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      actions: [{
        action_id: "corgtex_meeting_review_confirm",
        value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      }],
    });

    expect(meetingReviewConfirmMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), {
      workspaceId: "workspace-1",
      installationId: "install-1",
      externalUserId: "U1",
      reviewId: "review-1",
      insightId: "insight-1",
    });
    expect(slackWebClientMock.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      ts: "1714320000.000100",
      text: "Corgtex meeting follow-up review",
    }));
    expect(response).toEqual({ response_type: "ephemeral", text: "Created action." });
  });

  it("opens the meeting-review edit modal from signed block actions", async () => {
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    await expect(handleSlackInteraction({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      trigger_id: "trigger-1",
      actions: [{
        action_id: "corgtex_meeting_review_edit",
        value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      }],
    })).resolves.toEqual({});

    expect(meetingReviewEditViewMock).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace-1",
      reviewId: "review-1",
      insightId: "insight-1",
    });
    expect(slackWebClientMock.views.open).toHaveBeenCalledWith(expect.objectContaining({
      trigger_id: "trigger-1",
      view: expect.objectContaining({ type: "modal" }),
    }));
  });

  it("updates the meeting-review Slack post after modal submissions", async () => {
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    await expect(handleSlackInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        callback_id: "corgtex_meeting_review_edit_modal",
        private_metadata: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
        state: { values: { title: { value: { value: "Edited title" } } } },
      },
    })).resolves.toEqual({});

    expect(meetingReviewModalUpdateMock).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace-1",
      privateMetadata: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      values: { title: { value: { value: "Edited title" } } },
    });
    expect(slackWebClientMock.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      ts: "1714320000.000100",
    }));
  });

  it("forwards the current web requester and complete rendered receipt before updating Slack", async () => {
    const { syncSlackMeetingActionReviewAfterWebApply } = await authenticatedCommunicationFixture();
    const actor = { kind: "user" as const, user: { id: "user-1", email: "user@example.test", displayName: "User" } };
    const params = { workspaceId: "workspace-1", insightId: "insight-1" };
    const update = { channelId: "C1", messageTs: "1714320000.000100", blocks: [],
      text: "Synthetic complete review", responseText: "Updated", lineageRoots: [
        { kind: "Meeting", id: "meeting-1", fingerprint: "a".repeat(64) },
        { kind: "MeetingInsight", id: "uncited-insight-2", fingerprint: "b".repeat(64) },
      ] };
    reviewRefreshMock.mockResolvedValue({ installationId: "install-1", update });
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "enc:bot-token" });

    await syncSlackMeetingActionReviewAfterWebApply(actor, params);

    expect(reviewRefreshMock).toHaveBeenCalledWith(actor, params);
    expect(reviewPublicationMock).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", installationId: "install-1", channelId: "C1", lineageRoots: update.lineageRoots });
    expect(reviewPublicationMock.mock.invocationCallOrder[0]).toBeLessThan(slackWebClientMock.chat.update.mock.invocationCallOrder[0]);
    expect(slackWebClientMock.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: "Synthetic complete review" }));
  });

  it.each(["interaction", "modal", "web"] as const)("blocks the %s Slack review update when its publication proof is revoked", async (path) => {
    const { handleSlackInteraction, syncSlackMeetingActionReviewAfterWebApply } = await authenticatedCommunicationFixture();
    const user = { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" as const };
    const actor = { kind: "user" as const, user };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: user.id });
    prismaMock.user.findUnique.mockResolvedValue(user);
    const update = { channelId: "C1", messageTs: "1714320000.000100", blocks: [], text: "Synthetic stale review", responseText: "Updated", lineageRoots: [{ kind: "Meeting", id: "meeting-1", fingerprint: "a".repeat(64) }] };
    meetingReviewConfirmMock.mockResolvedValue(update);
    meetingReviewModalUpdateMock.mockResolvedValue(update);
    reviewRefreshMock.mockResolvedValue({ installationId: "install-1", update });
    reviewPublicationMock.mockRejectedValueOnce(new AppError(403, "SOURCE_RESTRICTED", "Synthetic source revoked after rendering."));
    const request = path === "web" ? syncSlackMeetingActionReviewAfterWebApply(actor, { workspaceId: "workspace-1", insightId: "insight-1" })
      : handleSlackInteraction({ team: { id: "T1" }, user: { id: "U1" }, ...(path === "modal" ? {
        type: "view_submission", view: { callback_id: "corgtex_meeting_review_edit_modal", private_metadata: "{}", state: { values: {} } },
      } : { type: "block_actions", actions: [{ action_id: "corgtex_meeting_review_confirm", value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }) }] }) });
    if (path === "interaction") expect(await request).toEqual({ response_type: "ephemeral", text: "Synthetic source revoked after rendering." });
    else await expect(request).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(reviewPublicationMock).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", installationId: "install-1", channelId: "C1", lineageRoots: update.lineageRoots });
    expect(slackWebClientMock.chat.update).not.toHaveBeenCalled();
  });

  it.each(["interaction", "modal", "web"] as const)("blocks the %s Slack review update when legacy lineage is unknown", async (path) => {
    const { handleSlackInteraction, syncSlackMeetingActionReviewAfterWebApply } = await authenticatedCommunicationFixture();
    const user = { id: "user-1", email: "user@example.test", displayName: "User" };
    const actor = { kind: "user" as const, user };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: user.id });
    prismaMock.user.findUnique.mockResolvedValue(user);
    const update = { channelId: "C1", messageTs: "1714320000.000100", blocks: [], text: "Synthetic unknown review", responseText: "Updated", lineageRoots: [] };
    meetingReviewConfirmMock.mockResolvedValue(update);
    meetingReviewModalUpdateMock.mockResolvedValue(update);
    reviewRefreshMock.mockResolvedValue({ installationId: "install-1", update });
    const request = path === "web" ? syncSlackMeetingActionReviewAfterWebApply(actor, { workspaceId: "workspace-1", insightId: "insight-1" })
      : handleSlackInteraction({ team: { id: "T1" }, user: { id: "U1" }, ...(path === "modal" ? {
        type: "view_submission", view: { callback_id: "corgtex_meeting_review_edit_modal", private_metadata: "{}", state: { values: {} } },
      } : { type: "block_actions", actions: [{ action_id: "corgtex_meeting_review_confirm", value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }) }] }) });
    if (path === "interaction") expect(await request).toEqual({ response_type: "ephemeral", text: "Synthetic review input proof is unavailable." });
    else await expect(request).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(slackWebClientMock.chat.update).not.toHaveBeenCalled();
  });

  it("rejects a Slack review sender whose membership was revoked after rendering", async () => {
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.test", displayName: "User" });
    const update = { channelId: "C1", messageTs: "1714320000.000100", blocks: [], text: "Synthetic stale membership review", responseText: "Updated", lineageRoots: [{ kind: "Meeting", id: "meeting-1", fingerprint: "a".repeat(64) }] };
    meetingReviewConfirmMock.mockImplementationOnce(async () => {
      requireMembershipMock.mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Synthetic requester membership was revoked."));
      return update;
    });
    expect(await handleSlackInteraction({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, actions: [{
      action_id: "corgtex_meeting_review_confirm", value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
    }] })).toEqual({ response_type: "ephemeral", text: "Synthetic requester membership was revoked." });
    expect(reviewPublicationMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user", user: expect.objectContaining({ id: "user-1" }) }), expect.any(Object));
    expect(slackWebClientMock.chat.update).not.toHaveBeenCalled();
  });

  it.each(["missing", "deleted", "bot", "departed"] as const)("does not substitute an actor for a %s Slack review requester", async (condition) => {
    const { handleSlackInteraction } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ id: "install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "enc:bot-token", externalWorkspaceId: "T1" });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1", isDeleted: condition === "deleted", isBot: condition === "bot" });
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.test", displayName: "User" });
    if (condition === "departed") requireMembershipMock.mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Synthetic departed member"));
    expect(await handleSlackInteraction({ type: "block_actions", team: { id: "T1" }, user: condition === "missing" ? {} : { id: "U1" }, actions: [{
      action_id: "corgtex_meeting_review_confirm", value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
    }] })).toMatchObject({ response_type: "ephemeral" });
    expect(meetingReviewConfirmMock).not.toHaveBeenCalled();
    expect(reviewPublicationMock).not.toHaveBeenCalled();
    expect(slackWebClientMock.chat.update).not.toHaveBeenCalled();
  });

  it("purges expired raw message content while preserving rows", async () => {
    const { purgeExpiredCommunicationMessages } = await authenticatedCommunicationFixture();
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      { id: "message-1" },
      { id: "message-2" },
    ]);

    await purgeExpiredCommunicationMessages("workspace-1");

    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        textRedactedAt: null,
      }),
      select: { id: true },
    }));
    expect(prismaMock.communicationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        textRedactedAt: null,
      }),
      data: expect.objectContaining({
        text: null,
        textRedactedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceType: "SLACK",
        sourceId: { in: ["message-1", "message-2"] },
      },
    });
  });

  it("reconciles a pending nudge across Slack thread pages", async () => {
    const { checkSlackThreadNudge } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ botUserId: "UBOT", appId: "A1", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.conversations.replies
      .mockResolvedValueOnce({ ok: true, messages: [{ user: "U1", text: "Question?", ts: "1777492800.000100" }], has_more: true, response_metadata: { next_cursor: "next" } })
      .mockResolvedValueOnce({ ok: true, messages: [{ app_id: "A1", text: "Bringing this back into view.", ts: "1777493100.000100" }], has_more: false });
    await expect(checkSlackThreadNudge("install-1", {
      channelId: "C1", threadTs: "1777492800.000100", createdAt: new Date("2026-04-29T20:00:00Z"), text: "Bringing this back into view.",
    })).resolves.toBe("found");
    expect(slackWebClientMock.conversations.replies).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
  });

  it("does not treat another author's matching text as a delivered nudge", async () => {
    const { checkSlackThreadNudge } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ botUserId: "UBOT", appId: "A1", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.conversations.replies.mockResolvedValueOnce({
      ok: true, messages: [{ user: "UOTHER", text: "Bringing this back into view.", ts: "1777493100.000100" }], has_more: false,
    });
    await expect(checkSlackThreadNudge("install-1", {
      channelId: "C1", threadTs: "1777492800.000100", createdAt: new Date("2026-04-29T20:00:00Z"), text: "Bringing this back into view.",
    })).resolves.toBe("unknown");
  });

  it("keeps a pending nudge when Slack history is incomplete", async () => {
    const { checkSlackThreadNudge } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ botUserId: "UBOT", botTokenEnc: "enc:bot-token" });
    slackWebClientMock.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [{ user: "U1", text: "Question?", ts: "1777492800.000100" }], has_more: true });
    await expect(checkSlackThreadNudge("install-1", {
      channelId: "C1", threadTs: "1777492800.000100", createdAt: new Date("2026-04-29T20:00:00Z"), text: "Bringing this back into view.",
    })).resolves.toBe("unknown");
  });

  it("reports a complete thread without a matching bot nudge, and fails closed on Slack errors", async () => {
    const { checkSlackThreadNudge } = await authenticatedCommunicationFixture();
    prismaMock.communicationInstallation.findUnique.mockResolvedValue({ botUserId: "UBOT", botTokenEnc: "enc:bot-token" });
    const query = { channelId: "C1", threadTs: "1777492800.000100", createdAt: new Date("2026-04-29T20:00:00Z"), text: "Bringing this back into view." };
    slackWebClientMock.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [{ user: "U1", text: "Question?", ts: "1777492800.000100" }], has_more: false });
    await expect(checkSlackThreadNudge("install-1", query)).resolves.toBe("absent");
    slackWebClientMock.conversations.replies.mockRejectedValueOnce(new Error("rate_limited"));
    await expect(checkSlackThreadNudge("install-1", query)).resolves.toBe("unknown");
  });
});
