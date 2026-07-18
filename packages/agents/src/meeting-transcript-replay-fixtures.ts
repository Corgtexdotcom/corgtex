type ReplayBlockKind = "check_in" | "update" | "tension" | "proposal_discussion" | "decision" | "planning" | "custom";
type ReplayInsightType = "DECISION" | "TENSION" | "ACTION_ITEM" | "PROPOSAL" | "FOLLOW_UP" | "DELIBERATION_ENTRY";
type ReplayInsightOperation = "CREATE" | "RESOLVE";
type ReplayInsightStatus = "SUGGESTED" | "CONFIRMED";

export type MeetingTranscriptReplayFixture = {
  id: string;
  workspaceId: string;
  meetingId: string;
  title: string;
  source: string;
  recordedAt: string;
  ingestionGuidanceMd: string;
  transcript: string;
  expectedBlocks: Array<{
    sequence: number;
    title: string;
    kind: ReplayBlockKind;
    summaryMd: string;
    sourceQuote: string;
  }>;
  expectedInsights: Array<{
    type: ReplayInsightType;
    operation: ReplayInsightOperation;
    status: ReplayInsightStatus;
    title: string;
    bodyMd: string;
    assigneeHint: string | null;
    confidence: number;
    sourceQuote: string;
    targetEntityType: string | null;
    targetEntityId: string | null;
  }>;
  expectedSummaryMd: string;
  expectedSummaryPhrases: string[];
  expectedAutoApply: {
    applied: number;
    failed: number;
    skipped: number;
    threshold: number;
  };
};

export const operationsTacticalReplayFixture: MeetingTranscriptReplayFixture = {
  id: "operations-tactical-2026-07-15",
  workspaceId: "ws-replay",
  meetingId: "meeting-replay-operations",
  title: "Operations Tactical Replay",
  source: "transcript-upload",
  recordedAt: "2026-07-15T16:00:00.000Z",
  ingestionGuidanceMd: "Use Corgtex, not Cortex. Preserve explicit owners, deadlines, and scope decisions.",
  transcript: [
    "Jan: This is the Corgtex operations tactical on July 15, 2026.",
    "Milan: The onboarding checklist is missing evidence owners. I will publish the checklist by Friday.",
    "Rhea: The renewal-risk tension needs resolution notes before the customer retest.",
    "Sam: Decision: keep notifications out of this release and leave them on the separate notifications track.",
    "Jan: Action item: Rhea owns the customer retest evidence matrix after deployment.",
  ].join("\n"),
  expectedBlocks: [
    {
      sequence: 1,
      title: "Onboarding checklist ownership",
      kind: "update",
      summaryMd: "Milan committed to publish the onboarding checklist with evidence owners by Friday.",
      sourceQuote: "I will publish the checklist by Friday.",
    },
    {
      sequence: 2,
      title: "Renewal-risk tension follow-up",
      kind: "tension",
      summaryMd: "Rhea said the renewal-risk tension needs resolution notes before customer retest.",
      sourceQuote: "The renewal-risk tension needs resolution notes before the customer retest.",
    },
    {
      sequence: 3,
      title: "Notification scope decision",
      kind: "decision",
      summaryMd: "Sam decided notifications stay out of this release and remain on the separate notifications track.",
      sourceQuote: "keep notifications out of this release",
    },
  ],
  expectedInsights: [
    {
      type: "ACTION_ITEM",
      operation: "CREATE",
      status: "SUGGESTED",
      title: "Publish onboarding evidence-owner checklist",
      bodyMd: "Milan will publish the onboarding checklist with evidence owners by Friday.",
      assigneeHint: "Milan",
      confidence: 0.91,
      sourceQuote: "I will publish the checklist by Friday.",
      targetEntityType: null,
      targetEntityId: null,
    },
    {
      type: "TENSION",
      operation: "CREATE",
      status: "SUGGESTED",
      title: "Renewal-risk tension needs resolution notes",
      bodyMd: "The renewal-risk tension needs resolution notes before the customer retest.",
      assigneeHint: "Rhea",
      confidence: 0.87,
      sourceQuote: "The renewal-risk tension needs resolution notes before the customer retest.",
      targetEntityType: null,
      targetEntityId: null,
    },
    {
      type: "DECISION",
      operation: "CREATE",
      status: "CONFIRMED",
      title: "Keep notifications out of this release",
      bodyMd: "Notifications remain out of this release and stay on the separate notifications track.",
      assigneeHint: null,
      confidence: 0.78,
      sourceQuote: "keep notifications out of this release",
      targetEntityType: null,
      targetEntityId: null,
    },
  ],
  expectedSummaryMd: [
    "## Operations tactical",
    "- Milan will publish the onboarding checklist with evidence owners by Friday.",
    "- Rhea owns the customer retest evidence matrix after deployment.",
    "- Notifications remain out of this release and stay on the separate notifications track.",
  ].join("\n"),
  expectedSummaryPhrases: [
    "Milan will publish the onboarding checklist",
    "Rhea owns the customer retest evidence matrix",
    "Notifications remain out of this release",
  ],
  expectedAutoApply: {
    applied: 2,
    failed: 0,
    skipped: 1,
    threshold: 0.8,
  },
};

export function meetingContextFromReplayFixture(fixture: MeetingTranscriptReplayFixture) {
  return {
    contextualIntelligenceEnabled: true,
    meeting: {
      id: fixture.meetingId,
      workspaceId: fixture.workspaceId,
      title: fixture.title,
      source: fixture.source,
      transcript: fixture.transcript,
      summaryMd: null,
      blocksJson: null,
      agendaJson: null,
      ingestionGuidanceMd: fixture.ingestionGuidanceMd,
      recordedAt: new Date(fixture.recordedAt),
    },
    previousMeetings: [],
    actions: [],
    tensions: [],
    proposals: [],
    deliberationEntries: [],
    followUps: [],
    knowledge: [],
  };
}

export function meetingRecordFromReplayFixture(fixture: MeetingTranscriptReplayFixture) {
  const timestamp = new Date(fixture.recordedAt);

  return {
    id: fixture.meetingId,
    workspaceId: fixture.workspaceId,
    title: fixture.title,
    source: fixture.source,
    transcript: fixture.transcript,
    summaryMd: fixture.expectedSummaryMd,
    recordedAt: new Date(fixture.recordedAt),
    insights: fixture.expectedInsights.map((insight, index) => ({
      id: `${fixture.id}-insight-${index + 1}`,
      workspaceId: fixture.workspaceId,
      meetingId: fixture.meetingId,
      type: insight.type,
      operation: insight.operation,
      status: insight.status,
      title: insight.title,
      bodyMd: insight.bodyMd,
      assigneeHint: insight.assigneeHint,
      dueAt: null,
      confidence: insight.confidence,
      sourceQuote: insight.sourceQuote,
      appliedEntityType: null,
      appliedEntityId: null,
      targetEntityType: insight.targetEntityType,
      targetEntityId: insight.targetEntityId,
      deliberationEntryType: null,
      resolutionOutcome: null,
      dedupeKey: `${fixture.id}:${insight.type}:${index + 1}`,
      metadataJson: { replayFixtureId: fixture.id },
      autoAppliedAt: null,
      autoApplyError: null,
      reviewedByUserId: null,
      reviewedAt: null,
      sourceRecordId: null,
      sourceRecordedAt: timestamp,
      supersededAt: null,
      supersededByInsightId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  };
}
