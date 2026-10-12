-- Bind authored feedback to the exact immutable draft displayed to the requester.
-- Legacy inputs without this binding remain ineligible for replay.
ALTER TABLE "AgentFeedbackInput" ADD COLUMN "priorRunSnapshotId" TEXT;
