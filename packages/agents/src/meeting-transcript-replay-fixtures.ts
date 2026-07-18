type ReplayBlockKind = "check_in" | "update" | "tension" | "proposal_discussion" | "decision" | "planning" | "custom";

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
  return {
    id: fixture.meetingId,
    workspaceId: fixture.workspaceId,
    title: fixture.title,
    source: fixture.source,
    transcript: fixture.transcript,
    summaryMd: fixture.expectedSummaryMd,
    recordedAt: new Date(fixture.recordedAt),
    insights: fixture.expectedBlocks.map((block) => ({
      id: `${fixture.id}-${block.sequence}`,
      kind: block.kind,
      title: block.title,
      summaryMd: block.summaryMd,
      confidence: block.kind === "decision" ? 0.9 : 0.86,
      status: "SUGGESTED",
    })),
  };
}
