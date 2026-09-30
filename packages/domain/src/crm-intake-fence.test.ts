import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const lead = { id: "synthetic-lead", workspaceId: "synthetic-corgtex", email: "lead@example.invalid" };
  const writes = vi.fn();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ enabled: true }]),
    workspace: { upsert: vi.fn().mockResolvedValue({ id: lead.workspaceId }) },
    demoLead: { findFirst: vi.fn().mockResolvedValue(lead), upsert: writes },
    crmQualification: { create: writes }, crmConversation: { findFirst: writes },
  };
  return { lead, writes, tx };
});
vi.mock("@corgtex/shared", () => ({
  prisma: {
    demoLead: { findUnique: vi.fn().mockResolvedValue(mocks.lead), findFirst: vi.fn().mockResolvedValue(mocks.lead) },
    $transaction: vi.fn((fn) => fn(mocks.tx)),
  },
  env: {},
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(), requireGlobalOperator: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));

import { captureDemoLead, receiveEmailReply, recordInboundEmailReply, submitQualification, syncEmailReplyToConversation } from "./crm";

describe("public CRM cutover fence", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const reply = { fromEmail: "lead@example.invalid", subject: "Synthetic", bodyText: "Synthetic" };
  it.each([
    ["capture", () => captureDemoLead({ email: reply.fromEmail })],
    ["qualification", () => submitQualification({ token: "synthetic-token", companyName: "Synthetic", website: "example.invalid", aiExperience: "none", helpNeeded: "planning" })],
    ["reply", () => receiveEmailReply(reply)],
    ["atomic inbound reply", () => recordInboundEmailReply(reply)],
    ["conversation", () => syncEmailReplyToConversation(reply)],
  ])("holds %s before lead, qualification or conversation writes", async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ status: 503, code: "CRM_PUBLIC_WRITES_PAUSED" });
    expect(mocks.writes).not.toHaveBeenCalled();
    const [sql, workspaceId] = mocks.tx.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toContain("FOR SHARE");
    expect(sql.join("?")).toContain("crm_public_writes_paused");
    expect(workspaceId).toBe(mocks.lead.workspaceId);
  });
});
