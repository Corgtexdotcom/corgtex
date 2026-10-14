import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, workspaceId, alpha, sharedEnv, domainExports } from "./agents/model-consumer.test-fixture";

const { createDailyQuestionsMock } = vi.hoisted(() => ({ createDailyQuestionsMock: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: sharedEnv,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", async () => {
  const domain = await domainExports();
  createDailyQuestionsMock.mockImplementation(domain.createDailyCompanyUnderstandingQuestions);
  return { ...domain, createDailyCompanyUnderstandingQuestions: createDailyQuestionsMock };
});
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model", defaultModelGateway: { chat: fixture.chat } }));
import { runDailyCheckInAgent } from "./agents/daily-check-in";
import { readableArtifactIds } from "../../domain/src/source-lineage";

beforeEach(resetFixture);
describe("runDailyCheckInAgent", () => {
  it("creates receipted daily questions without requiring a database", async () => {
    const result = await runDailyCheckInAgent({ workspaceId, triggerRef: "trigger-1", memberId: "member-alpha", triggerType: "SCHEDULE" });
    expect(createDailyQuestionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent", label: "CHECKIN_GENERATION" }),
      expect.objectContaining({ workspaceId, memberId: "member-alpha", lineageRoots: expect.arrayContaining([
        expect.objectContaining({ kind: "Member", id: "member-alpha" }),
        expect.objectContaining({ kind: "User", id: "alpha" }),
      ]) }),
    );
    expect(result).toMatchObject({ status: "COMPLETED", resultJson: { created: 3, cap: 3 } });
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", fixture.rows.checkIn)).toEqual(new Set(fixture.rows.checkIn.map((row: any) => row.id)));
    expect(fixture.rows.checkIn.every((row: any) => fixture.manifest("CheckIn", row.id).origin === "DERIVED")).toBe(true);
    expect(fixture.chat).not.toHaveBeenCalled();
  });
});
