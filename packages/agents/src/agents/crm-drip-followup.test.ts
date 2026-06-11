import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: vi.fn(),
  },
}));

vi.mock("../runtime", () => ({
  executeAgentRun: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {},
  sendEmail: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  recordDripFollowUp: vi.fn(),
}));

describe("CRM drip follow-up prompt", () => {
  it("keeps follow-up outreach aligned with ownership and control positioning", async () => {
    const { buildCrmDripFollowupSystemPrompt } = await import("./crm-drip-followup");
    const prompt = buildCrmDripFollowupSystemPrompt(2);

    expect(prompt).toContain("follow-up #2");
    expect(prompt).toContain("low pressure");
    expect(prompt).toContain("human judgment");
    expect(prompt).toContain("employee trust");
    expect(prompt).toContain("organizational control");
    expect(prompt).toContain("daily operating picture");
    expect(prompt).toContain("Mention employee-owned, self-managed, or mission-driven fit only when the lead context supports it");
    expect(prompt).toContain("do not invent those traits");
  });
});
