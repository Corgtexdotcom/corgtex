import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", () => ({
  prisma: {},
}));

import {
  crmPendingOperationIntent,
  crmPendingOperationNotice,
  type PendingOperationRecord,
} from "./pending-crm-operations";

function operation(overrides: Partial<PendingOperationRecord> = {}): PendingOperationRecord {
  return {
    id: "123e4567-e89b-12d3-a456-426614174000",
    workspaceId: "ws-1",
    conversationId: "session-1",
    userId: "user-1",
    agentKey: "assistant",
    toolName: "record_relationship_activity",
    argsJson: { title: "Follow up" },
    argsHash: "hash",
    idempotencyKey: "crm-pending:test",
    relatedEntityType: "CrmAccount",
    relatedEntityId: "account-1",
    riskLabel: "crm-write:record-activity",
    status: "PENDING",
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    proposedAt: new Date("2026-07-16T10:00:00.000Z"),
    expiresAt: new Date("2026-07-16T10:15:00.000Z"),
    executedAt: null,
    canceledAt: null,
    ...overrides,
  };
}

describe("CRM pending operation helpers", () => {
  it("detects explicit confirm and cancel intents with operation IDs", () => {
    expect(crmPendingOperationIntent("confirm 123e4567-e89b-12d3-a456-426614174000")).toEqual({
      kind: "confirm",
      pendingOperationId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(crmPendingOperationIntent("cancel 123e4567-e89b-12d3-a456-426614174000")).toEqual({
      kind: "cancel",
      pendingOperationId: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("does not treat unrelated text as pending-operation confirmation", () => {
    expect(crmPendingOperationIntent("what changed in the CRM today?")).toBeNull();
  });

  it("renders a deterministic confirmation contract notice", () => {
    const notice = crmPendingOperationNotice(operation());

    expect(notice).toContain("Pending operation ID: 123e4567-e89b-12d3-a456-426614174000");
    expect(notice).toContain("CRM operation: record_relationship_activity");
    expect(notice).toContain("Risk: crm-write:record-activity");
  });
});
