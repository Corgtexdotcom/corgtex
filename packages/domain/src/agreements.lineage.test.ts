import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument } from "../../agents/src/agents/model-consumer.test-fixture";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
import { listWorkspaceAgreements } from "./agreements";

beforeEach(resetFixture);
async function seed() {
  const constitution = fixture.add("constitution", { id: "constitution", workspaceId, version: 1, bodyMd: "# Safe public principle" });
  await known("Constitution", constitution, [], alpha);
  const proposal = fixture.add("proposal", { id: "proposal", workspaceId, title: "Public proposal", bodyMd: "Public content", isPrivate: false, publishedAt: fixture.timestamp, archivedAt: null, status: "ACCEPTED", authorUserId: "alpha" });
  await known("Proposal", proposal, [], alpha);
  const finance = fixture.add("document", { id: "finance", workspaceId, title: "Private", textContent: "Finance body", accessDomain: "FINANCE", archivedAt: null });
  await knownCopiedDocument(finance, beta);
  const privateRef = fixture.add("constitutionSourceReference", { id: "private-reference", workspaceId, constitutionId: constitution.id, pointKey: "principle", pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", proposalId: proposal.id, tensionId: null, policyCorpusId: null, labelSnapshot: "Private copied label" });
  await known("ConstitutionSourceReference", privateRef, [{ kind: "Document", id: finance.id }, { kind: "Proposal", id: proposal.id }], beta);
  const publicRef = fixture.add("constitutionSourceReference", { ...privateRef, id: "public-reference", sourceOrder: 2, labelSnapshot: "Public label" });
  await known("ConstitutionSourceReference", publicRef, [{ kind: "Proposal", id: proposal.id }], alpha);
  fixture.add("constitutionSourceReference", { ...privateRef, id: "unknown-reference", sourceOrder: 3, labelSnapshot: "Unknown old label" });
  return { constitution, finance, privateRef };
}

describe("Agreement reference real source permissions", () => {
  it("admits only currently proven reference rows and recomputes visible source positions", async () => {
    await seed();
    const result = await listWorkspaceAgreements(alpha, { workspaceId });
    expect(result.currentConstitution?.sourceReferences).toEqual([{ pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", targetId: "proposal", title: "Public proposal" }]);
    expect(JSON.stringify(result)).not.toContain("Private copied label");
    expect(JSON.stringify(result)).not.toContain("unknown-reference");
    expect((await listWorkspaceAgreements(beta, { workspaceId })).currentConstitution?.sourceReferences).toHaveLength(2);
    fixture.domains.set("beta", ["WORKSPACE"]);
    expect((await listWorkspaceAgreements(beta, { workspaceId })).currentConstitution?.sourceReferences).toHaveLength(1);
  });
  it("captures current holder labels independently despite a populated profile and hides departed owners", async () => {
    await seed();
    const user = fixture.rows.user.find((row: any) => row.id === "alpha");
    Object.assign(user, { avatarUrl: "https://synthetic.test/avatar", linkedinUrl: "https://synthetic.test/profile", websiteUrl: "https://synthetic.test" });
    const article = fixture.add("brainArticle", { id: "article", workspaceId, ownerMemberId: "member-alpha", isPrivate: false, archivedAt: null, authority: "AUTHORITATIVE", type: "STRATEGY", title: "Known public strategy", bodyMd: "Public content" });
    await known("BrainArticle", article, [], alpha);
    expect((await listWorkspaceAgreements(beta, { workspaceId })).brainArticles[0].ownerMember).toEqual({ user: { displayName: "Alpha", email: "alpha@example.test" } });
    fixture.rows.member.find((row: any) => row.id === "member-alpha").isActive = false;
    expect((await listWorkspaceAgreements(beta, { workspaceId })).brainArticles[0].ownerMember).toBeNull();
  });
  it("withholds a constitution and reference metadata when parent ancestry is no longer permitted", async () => {
    const { constitution, finance } = await seed();
    await known("Constitution", constitution, [{ kind: "Document", id: finance.id }], beta);
    expect((await listWorkspaceAgreements(beta, { workspaceId })).currentConstitution).not.toBeNull();
    fixture.domains.set("beta", ["WORKSPACE"]);
    const result = await listWorkspaceAgreements(beta, { workspaceId });
    expect(result.currentConstitution).toBeNull();
    expect(result.constitutionVersions).toEqual([]);
    expect(result.counts.constitutionVersions).toBe(0);
    expect(JSON.stringify(result)).not.toContain("Public proposal");
  });
});
