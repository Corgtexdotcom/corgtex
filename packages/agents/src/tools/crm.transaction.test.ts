import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
const f = vi.hoisted(() => ({ create: vi.fn(), complete: vi.fn(), suggest: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({
  AppError: (await import("../../../domain/src/errors")).AppError,
  createActivity: f.create, completeActivity: f.complete, createCommunicationSuggestion: f.suggest,
  listCrmActivities: vi.fn(),
}));
import { CRM_WRITE_TOOL_NAMES, normalizeCrmWriteToolArgs, recordRelationshipActivityAction,
  completeRelationshipActivityAction, createCommunicationSuggestionAction } from "./crm";
const actor = { kind: "user", user: { id: "requester", email: "requester@synthetic.test" } } as AppActor;
const cases = [
  ["record_relationship_activity", recordRelationshipActivityAction, f.create, { title: "Activity" }],
  ["complete_relationship_activity", completeRelationshipActivityAction, f.complete, { activityId: "activity" }],
  ["create_communication_suggestion", createCommunicationSuggestionAction, f.suggest, { title: "Suggestion", bodyMd: "Synthetic" }],
] as const;
describe("CRM tool caller transaction capability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    f.create.mockResolvedValue({ id: "activity", title: "Activity", type: "NOTE", accountId: "account" });
    f.complete.mockResolvedValue({ id: "activity", title: "Activity", type: "NOTE", accountId: "account", completedAt: new Date() });
    f.suggest.mockResolvedValue({ id: "suggestion", title: "Suggestion", status: "SUGGESTED", accountId: "account" });
  });
  it.each(cases)("passes the server transaction and exact receipts for %s", async (_name, handler, domain, args) => {
    const tx = { nativeCapability: true } as unknown as Prisma.TransactionClient;
    const roots = [{ kind: "McpToolInput" as const, id: "native-request", fingerprint: "exact" }];
    await handler(actor, { workspaceId: "ws", tx, lineageRoots: roots }, { ...args, tx: { malicious: true } });
    expect(domain).toHaveBeenCalledWith(actor, expect.objectContaining({ workspaceId: "ws", tx, lineageRoots: roots }));
    expect(domain.mock.calls[0][1].tx).toBe(tx);
  });
  it.each(cases)("ignores model supplied transaction JSON for %s", async (name, handler, domain, args) => {
    await handler(actor, { workspaceId: "ws" }, { ...args, tx: { forged: true } });
    expect(domain.mock.calls[0][1].tx).toBeUndefined();
    const normalized = normalizeCrmWriteToolArgs(name, { workspaceId: "ws" }, { ...args, tx: { forged: true } });
    expect(normalized).not.toHaveProperty("tx");
    expect(CRM_WRITE_TOOL_NAMES.has(name)).toBe(true);
  });
});
