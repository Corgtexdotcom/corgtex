import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  chatMock,
  extractMock,
  sendEmailMock,
  loggerMock,
  txMock,
  batchIngestDailyConversationsMock,
  createArticleMock,
  listSlackMessagesForDigestMock,
  updateArticleMock,
  rebuildBacklinksMock,
  getWorkspaceNewspaperCadenceMock,
  instrumentNewspaperHtmlLinksMock,
  recordNewspaperDeliveryMock,
  upsertNewspaperEditionMock,
  collectWorkspaceBriefingCandidatesMock,
  upsertWorkspaceBriefingMock,
} = vi.hoisted(() => ({
  txMock: {
    demoLead: {
      update: vi.fn(),
    },
    crmActivity: {
      create: vi.fn(),
    },
    newspaperDelivery: {
      create: vi.fn(),
    },
  },
  prismaMock: {
    $transaction: vi.fn(),
    conversationSession: {
      findMany: vi.fn(),
    },
    meeting: {
      findMany: vi.fn(),
    },
    buildArtifact: {
      findMany: vi.fn(),
    },
    adviceRequest: {
      findMany: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
    },
    goal: {
      findMany: vi.fn(),
    },
    roleVersion: {
      findMany: vi.fn(),
    },
    roleHolderHistory: {
      findMany: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
    },
    brainArticle: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    demoLead: {
      findFirst: vi.fn(),
    },
  },
  chatMock: vi.fn(),
  extractMock: vi.fn(),
  sendEmailMock: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
  batchIngestDailyConversationsMock: vi.fn(),
  createArticleMock: vi.fn(),
  listSlackMessagesForDigestMock: vi.fn(),
  updateArticleMock: vi.fn(),
  rebuildBacklinksMock: vi.fn(),
  getWorkspaceNewspaperCadenceMock: vi.fn(),
  instrumentNewspaperHtmlLinksMock: vi.fn(),
  recordNewspaperDeliveryMock: vi.fn(),
  upsertNewspaperEditionMock: vi.fn(),
  collectWorkspaceBriefingCandidatesMock: vi.fn(),
  upsertWorkspaceBriefingMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: { APP_URL: "https://app.example.com" },
  logger: loggerMock,
  prisma: prismaMock,
  sendEmail: sendEmailMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: chatMock,
    extract: extractMock,
  },
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "daily-digest": {
      defaultModelTier: "excellent",
    },
  },
  NEWSPAPER_SECTION_DEFINITIONS: [
    { id: "adviceRequests", title: "Requests Awaiting Your Input", aliases: ["inputRequests", "requestsAwaitingInput", "pendingAdviceRequests"] },
    { id: "meetingBriefs", title: "Meeting Briefs", aliases: ["meetings", "meetingSummaries", "meetingBriefings"] },
    { id: "decisionsAndProposals", title: "Decisions & Proposals", aliases: ["decisions", "proposals"] },
    { id: "resolvedTensions", title: "Resolved Tensions", aliases: ["closedTensions", "resolvedIssues"] },
    { id: "openActions", title: "Open Actions", aliases: ["assignedActions", "openActionItems", "actions"] },
    { id: "goalsProgress", title: "Goals & Quarterly Progress", aliases: ["goals", "goalUpdates", "quarterlyGoals", "progress"] },
    { id: "rolesAndPeople", title: "Roles & People", aliases: ["roleChanges", "peopleChanges", "newMembers", "roles"] },
    { id: "keyDecisions", title: "Key Decisions Made", aliases: ["keyDecisionsMade"] },
    { id: "actionItems", title: "Action Items Identified", aliases: ["actions", "nextActions"] },
    { id: "builtWork", title: "Built / Shipped Work", aliases: ["shippedWork", "buildArtifacts"] },
    { id: "conversationHighlights", title: "Conversation Highlights", aliases: ["highlights", "summary"] },
    { id: "teamPulse", title: "Team Pulse", aliases: ["pulse", "sentiment"] },
    { id: "emergingTensions", title: "Emerging Tensions", aliases: ["tensions", "risks"] },
    { id: "otherUpdates", title: "Other Updates", aliases: ["misc", "other", "brainUpdates", "documentUpdates"] },
  ],
  getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  getWorkspaceNewspaperCadence: getWorkspaceNewspaperCadenceMock,
  isHumanNewspaperRecipientIdentity: (identity: { kind?: string | null; user?: { email?: string | null; displayName?: string | null } | null; email?: string | null; displayName?: string | null }) => {
    const user = identity.user ?? identity;
    const email = user.email?.trim().toLowerCase() ?? "";
    const displayName = user.displayName?.trim().toLowerCase() ?? "";
    if (identity.kind === "SYSTEM") return false;
    return Boolean(email) && !email.startsWith("system+") && !email.startsWith("support+") && displayName !== "corgtex support";
  },
  normalizeNewspaperCadence: (value: unknown) => {
    if (value === "DAILY" || value === "WEEKLY" || value === "OFF") return value;
    return "WEEKLY";
  },
  capNewspaperDigestSections: (sections: Array<{ items: string[] }>) => sections,
  normalizeNewspaperDigestPayload: (input: any) => {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (Array.isArray(record.sections)) {
      return {
        intro: typeof record.intro === "string" ? record.intro : null,
        sections: record.sections.flatMap((section: any) => (
          section
            && typeof section.id === "string"
            && typeof section.title === "string"
            && Array.isArray(section.items)
            ? [{
              id: section.id,
              title: section.title,
              items: section.items.map((item: unknown) => String(item).trim()).filter(Boolean),
            }]
            : []
        )),
      };
    }
    const definitions = [
      { id: "adviceRequests", title: "Requests Awaiting Your Input", keys: ["adviceRequests", "inputRequests", "requestsAwaitingInput", "pendingAdviceRequests"] },
      { id: "meetingBriefs", title: "Meeting Briefs", keys: ["meetingBriefs", "meetings", "meetingSummaries", "meetingBriefings"] },
      { id: "decisionsAndProposals", title: "Decisions & Proposals", keys: ["decisionsAndProposals", "decisions", "proposals"] },
      { id: "resolvedTensions", title: "Resolved Tensions", keys: ["resolvedTensions", "closedTensions", "resolvedIssues"] },
      { id: "openActions", title: "Open Actions", keys: ["openActions", "assignedActions", "openActionItems", "actions"] },
      { id: "goalsProgress", title: "Goals & Quarterly Progress", keys: ["goalsProgress", "goals", "goalUpdates", "quarterlyGoals", "progress"] },
      { id: "rolesAndPeople", title: "Roles & People", keys: ["rolesAndPeople", "roleChanges", "peopleChanges", "newMembers", "roles"] },
      { id: "keyDecisions", title: "Key Decisions Made", keys: ["keyDecisions", "keyDecisionsMade"] },
      { id: "actionItems", title: "Action Items Identified", keys: ["actionItems", "actions", "nextActions"] },
      { id: "builtWork", title: "Built / Shipped Work", keys: ["builtWork", "shippedWork", "buildArtifacts"] },
      { id: "conversationHighlights", title: "Conversation Highlights", keys: ["conversationHighlights", "highlights", "summary"] },
      { id: "teamPulse", title: "Team Pulse", keys: ["teamPulse", "pulse", "sentiment"] },
      { id: "emergingTensions", title: "Emerging Tensions", keys: ["emergingTensions", "tensions", "risks"] },
      { id: "otherUpdates", title: "Other Updates", keys: ["otherUpdates", "misc", "other", "brainUpdates", "documentUpdates"] },
    ];
    const sections = definitions.flatMap((definition) => {
      const items = definition.keys.flatMap((key) => {
        const value = record[key];
        if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
        if (typeof value === "string") return [value.trim()].filter(Boolean);
        return [];
      });
      return items.length > 0 ? [{ id: definition.id, title: definition.title, items }] : [];
    });
    return { intro: typeof record.intro === "string" ? record.intro : null, sections };
  },
  renderNewspaperDigestMarkdown: ({ title, digest }: { title: string; digest: { intro: string | null; sections: Array<{ title: string; items: string[] }> } }) => [
    `# ${title}`,
    digest.intro ? `\n${digest.intro}` : "",
    ...digest.sections.flatMap((section) => ["", `## ${section.title}`, "", ...section.items.map((item) => `- ${item}`)]),
  ].filter((line, index) => line !== "" || index > 0).join("\n").trim(),
  computeNewspaperLayout: (sections: Array<{ id: string; itemCount: number }>) => {
    const visibleSections = sections
      .filter((section) => section.itemCount > 0)
      .map((section) => ({
        ...section,
        itemCap: Math.min(section.itemCount, 5),
        excerptMaxLength: 180,
        placement: "standard",
      }));
    return {
      variant: visibleSections.length <= 2 ? "sparse" : "balanced",
      visibleSections,
      sectionCaps: Object.fromEntries(visibleSections.map((section) => [
        section.id,
        {
          itemCap: section.itemCap,
          excerptMaxLength: section.excerptMaxLength,
          placement: section.placement,
        },
      ])),
    };
  },
  instrumentNewspaperHtmlLinks: instrumentNewspaperHtmlLinksMock,
  recordNewspaperDelivery: recordNewspaperDeliveryMock,
  workspaceBriefingPeriodFromCadence: (cadence: string) => cadence === "WEEKLY" ? "WEEKLY" : "DAILY",
  collectWorkspaceBriefingCandidates: collectWorkspaceBriefingCandidatesMock,
  buildWorkspaceBriefingFromDigest: ({ title, period, dateKey, digest }: any) => ({
    title,
    period,
    dateKey,
    generatedAt: "2026-04-30T12:00:00.000Z",
    introMd: digest.intro ?? null,
    items: digest.sections.flatMap((section: any) => section.items.map((item: string, index: number) => ({
      kind: section.id === "meetingBriefs"
        ? "MEETING"
        : section.id === "decisionsAndProposals"
          ? "PROPOSAL"
          : section.id === "resolvedTensions" || section.id === "emergingTensions"
            ? "TENSION"
            : section.id === "openActions" || section.id === "actionItems"
              ? "ACTION"
              : section.id === "goalsProgress"
                ? "GOAL"
                : section.id === "adviceRequests"
                  ? "ADVICE_REQUEST"
                  : section.id === "builtWork"
                    ? "BUILD_ARTIFACT"
                    : section.id === "conversationHighlights"
                      ? "COMMUNICATION"
                      : "BRAIN_ARTICLE",
      title: section.title,
      summaryMd: item,
      whyItMattersMd: "Selected for the workspace briefing.",
      prominence: index === 0 ? "lead" : "standard",
      sourceRefs: [],
      href: null,
      occurredAt: "2026-04-30T12:00:00.000Z",
      confidence: 0.8,
    }))),
    sourceRefs: [],
    sourceCounts: {},
  }),
  buildWorkspaceBriefingFromCandidates: ({ title, period, dateKey, candidates }: any) => ({
    title,
    period,
    dateKey,
    generatedAt: "2026-04-30T12:00:00.000Z",
    introMd: candidates.length > 0 ? "Here is what matters most." : "This was a quiet period.",
    items: candidates.length > 0
      ? candidates.map((candidate: any, index: number) => ({
          kind: candidate.sourceType,
          title: candidate.title,
          summaryMd: candidate.summaryMd,
          whyItMattersMd: candidate.whyItMattersMd ?? "Selected for the workspace briefing.",
          prominence: index === 0 ? "lead" : "standard",
          sourceRefs: candidate.sourceRefs ?? [],
          href: candidate.href ?? null,
          occurredAt: candidate.occurredAt instanceof Date ? candidate.occurredAt.toISOString() : "2026-04-30T12:00:00.000Z",
          confidence: candidate.confidence ?? 0.8,
        }))
      : [{
          kind: "QUIET",
          title: "No major operating changes found",
          summaryMd: "No new high-signal updates were found.",
          whyItMattersMd: "The briefing stays short.",
          prominence: "lead",
          sourceRefs: [],
          href: null,
          occurredAt: "2026-04-30T12:00:00.000Z",
          confidence: 0.8,
        }],
    sourceRefs: candidates.flatMap((candidate: any) => candidate.sourceRefs ?? []),
    sourceCounts: {},
  }),
  renderWorkspaceBriefingMarkdown: (briefing: any) => `# ${briefing.title}\n\n${briefing.items.map((item: any) => `- ${item.summaryMd}`).join("\n")}`,
  upsertWorkspaceBriefing: upsertWorkspaceBriefingMock,
  workspaceBriefingToNewspaperDigest: ({ briefingJson }: any) => {
    const sectionForKind = (kind: string) => {
      if (kind === "MEETING") return { id: "meetingBriefs", title: "Meeting Briefs" };
      if (kind === "PROPOSAL") return { id: "decisionsAndProposals", title: "Decisions & Proposals" };
      if (kind === "TENSION") return { id: "emergingTensions", title: "Emerging Tensions" };
      if (kind === "ACTION") return { id: "openActions", title: "Open Actions" };
      if (kind === "GOAL") return { id: "goalsProgress", title: "Goals & Quarterly Progress" };
      if (kind === "ADVICE_REQUEST") return { id: "adviceRequests", title: "Requests Awaiting Your Input" };
      if (kind === "BUILD_ARTIFACT") return { id: "builtWork", title: "Built / Shipped Work" };
      if (kind === "COMMUNICATION") return { id: "conversationHighlights", title: "Conversation Highlights" };
      return { id: "otherUpdates", title: "Other Updates" };
    };
    return {
      intro: briefingJson.introMd ?? null,
      sections: briefingJson.items.map((item: any) => ({
        ...sectionForKind(item.kind),
        items: [item.summaryMd],
      })),
    };
  },
  upsertNewspaperEdition: upsertNewspaperEditionMock,
  batchIngestDailyConversations: batchIngestDailyConversationsMock,
  createArticle: createArticleMock,
  listSlackMessagesForDigest: listSlackMessagesForDigestMock,
  updateArticle: updateArticleMock,
  rebuildBacklinks: rebuildBacklinksMock,
}));

function mockRecentBuildArtifact() {
  return {
    repositoryOwner: "puncar-dev",
    repositoryName: "corgtex",
    pullRequestNumber: 52,
    pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/52",
    branchName: "feat/newspaper",
    title: "Newspaper delivery observability",
    summaryMd: "Delivery records and reporting.",
    status: "MERGED",
    mergedAt: new Date("2026-04-30T12:00:00.000Z"),
    closedAt: new Date("2026-04-30T12:00:00.000Z"),
    updatedAt: new Date("2026-04-30T12:00:00.000Z"),
    assets: [],
  };
}

describe("runDailyDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    batchIngestDailyConversationsMock.mockResolvedValue(undefined);
    prismaMock.conversationSession.findMany.mockResolvedValue([]);
    prismaMock.meeting.findMany.mockResolvedValue([]);
    listSlackMessagesForDigestMock.mockResolvedValue([]);
    prismaMock.buildArtifact.findMany.mockResolvedValue([]);
    prismaMock.adviceRequest.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.goal.findMany.mockResolvedValue([]);
    prismaMock.roleVersion.findMany.mockResolvedValue([]);
    prismaMock.roleHolderHistory.findMany.mockResolvedValue([]);
    prismaMock.document.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockImplementation(async (params: any) => {
      if (params?.select?.joinedAt) return [];
      return [
        {
          id: "member-1",
          newspaperCadence: null,
          roleAssignments: [],
          user: {
            id: "user-1",
            email: "member@example.com",
            displayName: "Member One",
          },
        },
      ];
    });
    prismaMock.demoLead.findFirst.mockResolvedValue(null);
    prismaMock.brainSource.create.mockResolvedValue({ id: "source-1" });
    prismaMock.brainArticle.findUnique.mockResolvedValue(null);
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    chatMock.mockResolvedValue({ content: "Merged profile body" });
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) {
        return {
          output: {
            intro: "Structured daily brief.",
            builtWork: ["Shipped a useful update."],
            conversationHighlights: ["Discussed operating priorities."],
          },
        };
      }
      if (instruction.startsWith("Personalize this structured")) {
        return {
          output: {
            greeting: "Hello Member One,",
            intro: "Here is what matters most today.",
            emphasizedSectionIds: ["builtWork"],
          },
        };
      }
      return { output: {} };
    });
    createArticleMock.mockResolvedValue({ id: "article-1" });
    updateArticleMock.mockResolvedValue({ id: "article-1" });
    rebuildBacklinksMock.mockResolvedValue(undefined);
    sendEmailMock.mockResolvedValue({ status: "SENT", providerMessageId: "email-1" });
    instrumentNewspaperHtmlLinksMock.mockImplementation(async ({ html }: { html: string }) => html);
    recordNewspaperDeliveryMock.mockResolvedValue({ id: "delivery-1" });
    upsertNewspaperEditionMock.mockImplementation(async (params: any) => ({
      id: "edition-1",
      title: params.title,
      digestJson: params.digestJson,
    }));
    collectWorkspaceBriefingCandidatesMock.mockReset().mockResolvedValue([]);
    upsertWorkspaceBriefingMock.mockReset().mockImplementation(async (params: any) => ({
      id: "briefing-1",
      title: params.title,
      briefingJson: params.briefing,
    }));
    txMock.demoLead.update.mockResolvedValue({ id: "lead-1" });
    txMock.crmActivity.create.mockResolvedValue({ id: "activity-1" });
    txMock.newspaperDelivery.create.mockResolvedValue({ id: "delivery-1" });
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");
    prismaMock.workspace.findUnique.mockResolvedValue({ name: "Workspace One" });
  });

  it("includes recent active and merged build artifacts in the digest input", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
        branchName: "feat/outcome-board",
        title: "Built outcome board",
        summaryMd: "Plan and acceptance criteria.",
        status: "OPEN",
        mergedAt: null,
        closedAt: null,
        updatedAt: new Date("2026-04-30T09:00:00.000Z"),
        assets: [
          {
            kind: "SCREENSHOT",
            label: "In-progress board",
            captionMd: "Shows active PR work.",
          },
        ],
      },
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 41,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/41",
        branchName: "feat/tools",
        title: "Tools directory",
        summaryMd: "Merged tools outcome.",
        status: "MERGED",
        mergedAt: new Date("2026-04-30T08:00:00.000Z"),
        closedAt: new Date("2026-04-30T08:00:00.000Z"),
        updatedAt: new Date("2026-04-30T08:00:00.000Z"),
        assets: [],
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    const digestCall = extractMock.mock.calls.find(([request]) => request.instruction.startsWith("Generate a structured"));
    const digestInput = digestCall?.[0].input;
    expect(digestInput).toContain("Built / PR activity for accomplishments and shipped work");
    expect(digestInput).toContain("Active PR work");
    expect(digestInput).toContain("Built outcome board");
    expect(digestInput).toContain("Visual proof: In-progress board (SCREENSHOT): Shows active PR work.");
    expect(digestInput).toContain("Merged PRs / shipped outcomes");
    expect(digestInput).toContain("Tools directory");
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      type: "DIGEST",
      bodyMd: expect.stringContaining("## Built / Shipped Work"),
      title: "Weekly Newspaper - 2026-04-30",
    }));
    expect(upsertNewspaperEditionMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      cadence: "WEEKLY",
      dateKey: "2026-04-30",
      runKey: "workspace-1:weekly-newspaper:2026-04-30",
      title: "Weekly Newspaper - 2026-04-30",
      slug: "weekly-newspaper-2026-04-30",
      digestJson: expect.objectContaining({
        sections: expect.arrayContaining([
          expect.objectContaining({ id: "builtWork" }),
        ]),
      }),
      bodyMd: expect.stringContaining("## Built / Shipped Work"),
      sourceCounts: expect.objectContaining({
        buildArtifacts: 2,
      }),
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      subject: "Weekly Newspaper - 2026-04-30 - Your Personal Briefing",
      html: expect.stringContaining("The Workspace One Edition"),
      tracking: expect.objectContaining({
        emailType: "newspaper.member",
        userId: "user-1",
        workspaceId: "workspace-1",
        metadata: expect.objectContaining({
          runKey: "workspace-1:weekly-newspaper:2026-04-30",
          cadence: "WEEKLY",
          kind: "MEMBER_NEWSPAPER",
        }),
      }),
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      memberId: "member-1",
      kind: "MEMBER_NEWSPAPER",
      cadence: "WEEKLY",
      status: "SENT",
      providerMessageId: "email-1",
    }));
  });

  it("renders member newsletters from the stored canonical workspace briefing", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    upsertWorkspaceBriefingMock.mockResolvedValueOnce({
      id: "briefing-1",
      title: "Stored Workspace Briefing - 2026-04-30",
      briefingJson: {
        title: "Stored Workspace Briefing - 2026-04-30",
        period: "WEEKLY",
        dateKey: "2026-04-30",
        generatedAt: "2026-04-30T12:00:00.000Z",
        introMd: "Stored shared intro.",
        items: [{
          kind: "BUILD_ARTIFACT",
          title: "Stored shipped work",
          summaryMd: "Stored briefing item.",
          whyItMattersMd: "The briefing is canonical.",
          prominence: "lead",
          sourceRefs: [],
          href: null,
          occurredAt: "2026-04-30T12:00:00.000Z",
          confidence: 0.9,
        }],
        sourceRefs: [],
        sourceCounts: {
          BUILD_ARTIFACT: 1,
        },
      },
    });

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      subject: "Stored Workspace Briefing - 2026-04-30 - Your Personal Briefing",
      html: expect.stringContaining("Stored Workspace Briefing - 2026-04-30"),
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining("Stored briefing item."),
    }));
  });

  it("sends a weekly newspaper for a meeting-only workspace", async () => {
    prismaMock.meeting.findMany.mockResolvedValue([
      {
        id: "meeting-1",
        title: "Weekly tactical",
        recordedAt: new Date("2026-04-29T10:00:00.000Z"),
        summaryMd: "Reviewed onboarding progress and agreed to unblock the role handoff.",
        decisionsJson: [{ title: "Role handoff", summary: "Move onboarding ownership to the facilitation role." }],
        participantEmails: ["member@example.com"],
        insights: [
          {
            type: "ACTION_ITEM",
            operation: "CREATE",
            status: "CONFIRMED",
            title: "Document onboarding handoff",
            bodyMd: "Capture the next step before Monday.",
            dueAt: new Date("2026-05-04T12:00:00.000Z"),
          },
        ],
      },
    ]);
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) {
        return {
          output: {
            intro: "Weekly operating brief.",
            meetingBriefs: ["Weekly tactical: onboarding progress and role handoff were reviewed."],
            decisionsAndProposals: ["Role handoff ownership moves to facilitation."],
          },
        };
      }
      if (instruction.startsWith("Personalize this structured")) return { output: {} };
      return { output: {} };
    });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    const digestCall = extractMock.mock.calls.find(([request]) => request.instruction.startsWith("Generate a structured"));
    expect(digestCall?.[0].input).toContain("Meeting summaries and decisions");
    expect(digestCall?.[0].input).toContain("Weekly tactical");
    expect(result).toEqual(expect.objectContaining({
      cadence: "WEEKLY",
      sentEmails: 1,
    }));
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      type: "DIGEST",
      bodyMd: expect.stringContaining("## Meeting Briefs"),
      title: "Weekly Newspaper - 2026-04-30",
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      html: expect.stringContaining("Meeting Briefs"),
    }));
  });

  it("batches recipient profile reads into a single findMany over all recipient slugs", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.member.findMany.mockResolvedValue([
      { id: "member-a", newspaperCadence: "DAILY", user: { id: "user-a", email: "a@example.com", displayName: "A" } },
      { id: "member-b", newspaperCadence: "DAILY", user: { id: "user-b", email: "b@example.com", displayName: "B" } },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          slug: { in: expect.arrayContaining(["person-user-a", "person-user-b"]) },
        }),
      }),
    );
    // The per-recipient profile read must not fall back to a findUnique per member.
    const personFindUniqueCalls = prismaMock.brainArticle.findUnique.mock.calls.filter(
      ([arg]) => arg?.where?.workspaceId_slug?.slug?.startsWith("person-"),
    );
    expect(personFindUniqueCalls).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("batches conversing-member profile lookups into a single findMany", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.conversationSession.findMany.mockResolvedValue([
      { userId: "user-a", user: { id: "user-a", email: "a@example.com", displayName: "A" }, turns: [{ userMessage: "hi", assistantMessage: "yo" }] },
      { userId: "user-b", user: { id: "user-b", email: "b@example.com", displayName: "B" }, turns: [{ userMessage: "ho", assistantMessage: "hey" }] },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          slug: { in: expect.arrayContaining(["person-user-a", "person-user-b"]) },
        }),
      }),
    );
    expect(createArticleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({ slug: "person-user-a", type: "PERSON" }),
    );
    expect(createArticleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({ slug: "person-user-b", type: "PERSON" }),
    );
  });

  it("generates the briefing but sends no email when no active members match the requested cadence", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        newspaperCadence: null,
        user: {
          id: "user-1",
          email: "member@example.com",
          displayName: "Member One",
        },
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      cadence: "DAILY",
      briefingId: "briefing-1",
      processedSessions: 0,
    }));
    expect(batchIngestDailyConversationsMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
    }));
    expect(upsertWorkspaceBriefingMock).toHaveBeenCalledWith(expect.objectContaining({
      period: "DAILY",
    }));
    expect(chatMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(upsertNewspaperEditionMock).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
  });

  it("does not generate a newspaper when the requested cadence is off", async () => {
    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "OFF",
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      cadence: "OFF",
      sentEmails: 0,
    }));
    expect(batchIngestDailyConversationsMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_delivery_skipped", expect.objectContaining({
      reason: "cadence_off",
    }));
  });

  it("excludes members whose effective cadence is off", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-off",
        newspaperCadence: "OFF",
        user: {
          id: "user-off",
          email: "off@example.com",
          displayName: "Off Member",
        },
      },
      {
        id: "member-daily",
        newspaperCadence: "DAILY",
        user: {
          id: "user-daily",
          email: "daily@example.com",
          displayName: "Daily Member",
        },
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "daily@example.com",
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-daily",
      status: "SENT",
    }));
  });

  it("excludes system and support identities from recipient newspapers", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.member.findMany.mockImplementation(async (params: any) => {
      if (params?.select?.joinedAt) return [];
      return [
        {
          id: "member-human",
          newspaperCadence: "WEEKLY",
          roleAssignments: [],
          user: { id: "user-human", email: "human@example.com", displayName: "Human Member" },
        },
        {
          id: "member-system",
          newspaperCadence: "WEEKLY",
          roleAssignments: [],
          user: { id: "user-system", email: "system+workspace@corgtex.local", displayName: "System" },
        },
        {
          id: "member-support",
          newspaperCadence: "WEEKLY",
          roleAssignments: [],
          user: { id: "user-support", email: "support+workspace@corgtex.local", displayName: "Corgtex Support" },
        },
      ];
    });

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "WEEKLY",
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "human@example.com",
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-human",
      status: "SENT",
    }));
  });

  it("adds pending advice requests only to the recipient newspaper", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-a",
        newspaperCadence: "DAILY",
        roleAssignments: [
          {
            role: {
              circleId: "circle-1",
              archivedAt: null,
              circle: { workspaceId: "workspace-1", archivedAt: null },
            },
          },
        ],
        user: { id: "user-a", email: "a@example.com", displayName: "A" },
      },
      {
        id: "member-b",
        newspaperCadence: "DAILY",
        roleAssignments: [
          {
            role: {
              circleId: "circle-2",
              archivedAt: null,
              circle: { workspaceId: "workspace-1", archivedAt: null },
            },
          },
        ],
        user: { id: "user-b", email: "b@example.com", displayName: "B" },
      },
    ]);
    prismaMock.adviceRequest.findMany.mockResolvedValue([
      {
        id: "request-selected",
        audienceType: "MEMBERS",
        targetCircleId: null,
        messageMd: "Please advise on the pricing decision.",
        deadlineAt: new Date("2026-05-03T12:00:00.000Z"),
        reminderAt: null,
        preferredChannel: "IN_APP",
        createdAt: new Date("2026-04-30T08:00:00.000Z"),
        requestedBy: { email: "requester@example.com", displayName: "Requester" },
        targetCircle: null,
        recipients: [{ memberId: "member-a" }],
        process: { subjectType: "PROPOSAL", subjectId: "proposal-1" },
      },
      {
        id: "request-circle",
        audienceType: "CIRCLE",
        targetCircleId: "circle-1",
        messageMd: "Can you clarify the support handoff?",
        deadlineAt: null,
        reminderAt: new Date("2026-05-01T12:00:00.000Z"),
        preferredChannel: "SLACK",
        createdAt: new Date("2026-04-30T09:00:00.000Z"),
        requestedBy: { email: "requester@example.com", displayName: "Requester" },
        targetCircle: { name: "Support" },
        recipients: [],
        process: { subjectType: "TENSION", subjectId: "tension-1" },
      },
      {
        id: "request-workspace",
        audienceType: "WORKSPACE",
        targetCircleId: null,
        messageMd: "Share any rollout constraints before launch.",
        deadlineAt: null,
        reminderAt: null,
        preferredChannel: "EMAIL",
        createdAt: new Date("2026-04-30T10:00:00.000Z"),
        requestedBy: { email: "requester@example.com", displayName: "Requester" },
        targetCircle: null,
        recipients: [],
        process: { subjectType: "ACTION", subjectId: "action-1" },
      },
    ]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "proposal-1", title: "Approve pricing" }]);
    prismaMock.tension.findMany.mockResolvedValue([{ id: "tension-1", title: "Clarify support ownership" }]);
    prismaMock.action.findMany.mockResolvedValue([{ id: "action-1", title: "Prepare launch checklist" }]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const htmlByRecipient = new Map(sendEmailMock.mock.calls.map(([request]) => [request.to, request.html]));
    const memberAHtml = htmlByRecipient.get("a@example.com");
    const memberBHtml = htmlByRecipient.get("b@example.com");
    expect(memberAHtml).toContain("Requests Awaiting Your Input");
    expect(memberAHtml).toContain("Advice request: Proposal - Approve pricing");
    expect(memberAHtml).toContain("Input request: Tension - Clarify support ownership");
    expect(memberAHtml).toContain("Deadline: 2026-05-03");
    expect(memberAHtml).toContain("Audience: Support circle");
    expect(memberAHtml).not.toContain("Prepare launch checklist");
    expect(memberBHtml).not.toContain("Requests Awaiting Your Input");
    expect(memberBHtml).not.toContain("Prepare launch checklist");
    expect(memberBHtml).not.toContain("Approve pricing");
    expect(memberBHtml).not.toContain("Clarify support ownership");
  });

  it("adds personal advice requests while quiet briefings still reach scheduled recipients", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { id: "member-a", newspaperCadence: "DAILY", roleAssignments: [], user: { id: "user-a", email: "a@example.com", displayName: "A" } },
      { id: "member-b", newspaperCadence: "DAILY", roleAssignments: [], user: { id: "user-b", email: "b@example.com", displayName: "B" } },
    ]);
    prismaMock.adviceRequest.findMany.mockResolvedValue([
      {
        id: "request-selected",
        audienceType: "MEMBERS",
        targetCircleId: null,
        messageMd: "Please advise on the pricing decision.",
        deadlineAt: null,
        reminderAt: null,
        preferredChannel: "IN_APP",
        createdAt: new Date("2026-04-30T08:00:00.000Z"),
        requestedBy: { email: "requester@example.com", displayName: "Requester" },
        targetCircle: null,
        recipients: [{ memberId: "member-a" }],
        process: { subjectType: "PROPOSAL", subjectId: "proposal-1" },
      },
    ]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "proposal-1", title: "Approve pricing" }]);
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) return { output: {} };
      if (instruction.startsWith("Personalize this structured")) return { output: {} };
      return { output: {} };
    });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 2,
      skippedEmails: 0,
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "a@example.com",
      html: expect.stringContaining("Advice request: Proposal - Approve pricing"),
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "b@example.com",
    }));
    const htmlByRecipient = new Map(sendEmailMock.mock.calls.map(([request]) => [request.to, request.html]));
    expect(htmlByRecipient.get("b@example.com")).not.toContain("Approve pricing");
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ memberId: "member-a", status: "SENT" }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ memberId: "member-b", status: "SENT" }));
  });

  it("records skipped deliveries when email is not configured", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    sendEmailMock.mockResolvedValue({ status: "SKIPPED", reason: "RESEND_API_KEY is not configured." });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 0,
      skippedEmails: 1,
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "SKIPPED",
      error: "RESEND_API_KEY is not configured.",
    }));
  });

  it("sends a quiet briefing for true no-input runs", async () => {
    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 1,
      skippedEmails: 0,
    }));
    expect(extractMock.mock.calls.some(([request]) => request.instruction.startsWith("Generate a structured"))).toBe(false);
    expect(upsertWorkspaceBriefingMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Weekly Newspaper - 2026-04-30",
    }));
    expect(upsertNewspaperEditionMock).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      subject: "Weekly Newspaper - 2026-04-30 - Your Personal Briefing",
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-1",
      cadence: "WEEKLY",
      status: "SENT",
    }));
  });

  it("uses collected briefing candidates when there are no transcript inputs", async () => {
    collectWorkspaceBriefingCandidatesMock.mockResolvedValue([{
      sourceType: "GOAL",
      sourceId: "goal-1",
      title: "Customer rollout goal needs attention",
      summaryMd: "The customer rollout goal is active and should anchor the workspace briefing.",
      whyItMattersMd: "This is durable operating context even when the day has no new transcript inputs.",
      href: "/workspaces/workspace-1/goals/goal-1",
      sourceRefs: [{
        type: "GOAL",
        id: "goal-1",
        label: "Customer rollout goal",
        href: "/workspaces/workspace-1/goals/goal-1",
      }],
      occurredAt: new Date("2026-04-30T10:00:00.000Z"),
      updatedAt: new Date("2026-04-30T10:00:00.000Z"),
      score: 17,
      importanceScore: 4,
      freshnessScore: 2,
      actionabilityScore: 2,
      strategicScore: 5,
      evidenceScore: 2,
      contextDepthScore: 2,
      confidence: 0.86,
    }]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    expect(extractMock.mock.calls.some(([request]) => request.instruction.startsWith("Generate a structured"))).toBe(false);
    expect(upsertWorkspaceBriefingMock).toHaveBeenCalledWith(expect.objectContaining({
      briefing: expect.objectContaining({
        introMd: "Here is what matters most.",
        items: [expect.objectContaining({
          kind: "GOAL",
          title: "Customer rollout goal needs attention",
          summaryMd: "The customer rollout goal is active and should anchor the workspace briefing.",
          href: "/workspaces/workspace-1/goals/goal-1",
        })],
      }),
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining("customer rollout goal is active"),
    }));
  });

  it("generates the daily workspace briefing even when no members receive daily email", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      briefingId: "briefing-1",
      sentEmails: 0,
      skippedEmails: 0,
    }));
    expect(upsertWorkspaceBriefingMock).toHaveBeenCalledWith(expect.objectContaining({
      period: "DAILY",
      title: "Daily Newspaper - 2026-04-30",
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(recordNewspaperDeliveryMock).not.toHaveBeenCalled();
    expect(upsertNewspaperEditionMock).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(rebuildBacklinksMock).not.toHaveBeenCalled();
  });

  it("falls back to candidate briefing when the structured newspaper is empty", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) {
        return { output: {} };
      }
      return { output: {} };
    });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 1,
      skippedEmails: 0,
    }));
    expect(upsertWorkspaceBriefingMock).toHaveBeenCalled();
    expect(upsertNewspaperEditionMock).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      subject: "Daily Newspaper - 2026-04-30 - Your Personal Briefing",
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-1",
      status: "SENT",
    }));
  });

  it("records failed deliveries when sending fails", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    sendEmailMock.mockRejectedValue(new Error("provider unavailable"));

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 0,
      failedEmails: 1,
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      error: "provider unavailable",
    }));
    expect(loggerMock.error).toHaveBeenCalledWith("newspaper_delivery_failed", expect.objectContaining({
      error: "provider unavailable",
    }));
  });

  it("uses a seven-day lookback for weekly newspapers", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 50,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/50",
        branchName: "feat/weekly",
        title: "Weekly operating summary",
        summaryMd: "Weekly shipped work.",
        status: "MERGED",
        mergedAt: new Date("2026-04-29T12:00:00.000Z"),
        closedAt: new Date("2026-04-29T12:00:00.000Z"),
        updatedAt: new Date("2026-04-29T12:00:00.000Z"),
        assets: [],
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "WEEKLY",
    });

    expect(batchIngestDailyConversationsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      since: new Date("2026-04-23T12:00:00.000Z"),
    });
    expect(createArticleMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      slug: "weekly-newspaper-2026-04-30",
      title: "Weekly Newspaper - 2026-04-30",
    }));
  });

  it("updates an existing draft newspaper article instead of creating a duplicate slug", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.brainArticle.findUnique
      .mockResolvedValueOnce({
        id: "digest-1",
        slug: "daily-newspaper-2026-04-30",
        authority: "DRAFT",
        sourceIds: [],
        bodyMd: "Old digest",
      })
      .mockResolvedValue({ bodyMd: "Member profile" });

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      slug: "daily-newspaper-2026-04-30",
      title: "Daily Newspaper - 2026-04-30",
      bodyMd: expect.stringContaining("## Built / Shipped Work"),
    }));
  });

  it("skips writing over an existing non-draft newspaper article and still sends the digest", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.brainArticle.findUnique
      .mockResolvedValueOnce({
        id: "digest-1",
        slug: "daily-newspaper-2026-04-30",
        authority: "REFERENCE",
        sourceIds: [],
        bodyMd: "Published digest",
      })
      .mockResolvedValue({ bodyMd: "Member profile" });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sentEmails: 1,
    }));
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_digest_article_write_skipped", expect.objectContaining({
      reason: "non_draft_article",
      slug: "daily-newspaper-2026-04-30",
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
    }));
  });

  it("sends the curated demo welcome newspaper once and records a CRM activity", async () => {
    prismaMock.demoLead.findFirst.mockResolvedValue({
      id: "lead-1",
      workspaceId: "workspace-1",
      email: "lead@example.com",
      convertedContactId: "contact-1",
      welcomeEmailSentAt: null,
      workspace: { name: "Corgtex" },
    });

    const { sendDemoWelcomeNewspaper } = await import("./daily-digest");
    await expect(sendDemoWelcomeNewspaper({
      workspaceId: "workspace-1",
      demoLeadId: "lead-1",
    })).resolves.toEqual({ success: true, skipped: false });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "lead@example.com",
      subject: "Welcome to Corgtex - your first newspaper",
      html: expect.stringContaining("Ownership and control"),
      tracking: expect.objectContaining({
        emailType: "newspaper.demo_welcome",
        workspaceId: "workspace-1",
        metadata: expect.objectContaining({
          kind: "DEMO_WELCOME",
          demoLeadId: "lead-1",
        }),
      }),
    }));
    expect(txMock.demoLead.update).toHaveBeenCalledWith({
      where: { id: "lead-1" },
      data: { welcomeEmailSentAt: expect.any(Date) },
    });
    expect(txMock.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        contactId: "contact-1",
	        type: "EMAIL",
	        title: "Sent welcome newspaper",
	        bodyMd: expect.stringContaining("ownership and control"),
	      }),
	    });
    expect(txMock.newspaperDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        demoLeadId: "lead-1",
        kind: "DEMO_WELCOME",
        status: "SENT",
        providerMessageId: "email-1",
      }),
    });
  });

  it("does not resend the demo welcome newspaper when it already has a sent timestamp", async () => {
    prismaMock.demoLead.findFirst.mockResolvedValue({
      id: "lead-1",
      workspaceId: "workspace-1",
      email: "lead@example.com",
      welcomeEmailSentAt: new Date("2026-04-30T12:00:00.000Z"),
      workspace: { name: "Corgtex" },
    });

    const { sendDemoWelcomeNewspaper } = await import("./daily-digest");
    await sendDemoWelcomeNewspaper({
      workspaceId: "workspace-1",
      demoLeadId: "lead-1",
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(txMock.demoLead.update).not.toHaveBeenCalled();
  });
});
