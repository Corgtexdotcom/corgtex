import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { getProposal, listProposals } from "./proposals";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" } }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: {} }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: typeof alpha) =>
  actor.kind === "user" ? fixture.domains.get(actor.user.id) ?? [] : [] }));

beforeEach(async () => {
  await resetFixture();
  fixture.rows.circle = [];
  fixture.prisma.circle = { findFirst: vi.fn(async ({ where }: any) => fixture.rows.circle.find((row: any) =>
    row.id === where.id && row.workspaceId === where.workspaceId) ?? null) };
  const baseFindFirst = vi.mocked(fixture.prisma.proposal.findFirst).getMockImplementation()!;
  vi.mocked(fixture.prisma.proposal.findFirst).mockImplementation(async (args: any) => {
    if (!args.include) return baseFindFirst(args);
    const row = fixture.rows.proposal.find((item: any) => item.id === args.where.id && item.workspaceId === args.where.workspaceId);
    return row && (row.isPrivate !== true || row.authorUserId === (args.where.OR?.[1]?.authorUserId ?? ""))
      ? withRelations(row) : null;
  });
  vi.mocked(fixture.prisma.proposal.findMany).mockImplementation(async (args: any) => {
    const where = args.where.AND?.[0] ?? args.where;
    const selectedIds = args.where.AND?.find((clause: any) => clause.id?.in)?.id.in;
    const rows = fixture.rows.proposal.filter((row: any) => row.workspaceId === where.workspaceId && (!selectedIds || selectedIds.includes(row.id))
      && (where.circleId == null || row.circleId === where.circleId)
      && (where.status == null || row.status === where.status)
      && (where.archivedAt !== null || row.archivedAt == null)
      && (!row.isPrivate || row.authorUserId === where.OR?.[1]?.authorUserId));
    return rows.sort((left: any, right: any) => right.id.localeCompare(left.id))
      .slice(0, args.take ?? rows.length).map(withRelations);
  });
});

function withRelations(row: any) {
  const user = fixture.rows.user.find((candidate: any) => candidate.id === row.authorUserId);
  const owner = fixture.rows.member.find((candidate: any) => candidate.id === row.ownerMemberId);
  return { ...row,
    author: user ? { ...user } : null,
    ownerMember: owner ? { ...owner, user: { ...fixture.rows.user.find((candidate: any) => candidate.id === owner.userId) } } : null,
    circle: fixture.rows.circle.find((candidate: any) => candidate.id === row.circleId) ?? null,
    actions: fixture.rows.action.filter((candidate: any) => candidate.proposalId === row.id && !candidate.isPrivate),
    tensions: fixture.rows.tension.filter((candidate: any) => candidate.proposalId === row.id && !candidate.isPrivate),
    adviceProcess: row.adviceProcess ?? null,
  };
}

async function seed() {
  const privateInput = fixture.add("action", { id: "private-input", workspaceId, title: "Beta private input",
    bodyMd: "Restricted source body", authorUserId: "beta", assigneeMemberId: "member-beta",
    isPrivate: true, status: "DRAFT", archivedAt: null });
  await known("Action", privateInput, [], beta);
  const circle = fixture.add("circle", { id: "private-circle", workspaceId, name: "Restricted circle label",
    purposeMd: "Restricted purpose", archivedAt: null });
  await known("Circle", circle, [{ kind: "Action", id: privateInput.id }], beta);
  const betaUser = fixture.rows.user.find((row: any) => row.id === "beta");
  betaUser.displayName = "Restricted author label";
  await known("User", betaUser, [{ kind: "Action", id: privateInput.id }], beta);
  const betaMember = fixture.rows.member.find((row: any) => row.id === "member-beta");
  await known("Member", { ...betaMember, user: { id: betaUser.id, email: betaUser.email, displayName: betaUser.displayName } },
    [{ kind: "Action", id: privateInput.id }], beta);
  const meeting = fixture.add("meeting", { id: "restricted-meeting", workspaceId, title: "Restricted meeting title",
    source: "manual", transcript: "Restricted meeting transcript", archivedAt: null });
  await known("Meeting", meeting, [{ kind: "Action", id: privateInput.id }], beta);
  const visible = fixture.add("proposal", { id: "c-visible", workspaceId, title: "Public proposal", bodyMd: "Public body",
    authorUserId: "beta", ownerMemberId: betaMember.id, circleId: circle.id, meetingId: meeting.id, status: "OPEN", isPrivate: false,
    archivedAt: null, adviceProcess: { id: "process-secret", subjectId: "restricted-process-id",
      ownerMemberId: "restricted-owner", status: "GATHERING", requests: [] } });
  await known("Proposal", visible, [], beta);
  const hiddenChildParent = fixture.add("proposal", { id: "b-hidden-child-parent", workspaceId,
    title: "Parent only linked by a restricted child", bodyMd: "Public body", authorUserId: "beta",
    ownerMemberId: null, circleId: null, status: "OPEN", isPrivate: false, archivedAt: null });
  await known("Proposal", hiddenChildParent, [], beta);
  const privateParent = fixture.add("proposal", { id: "a-private-parent", workspaceId,
    title: "Restricted derived parent", bodyMd: "Restricted copied proposal", authorUserId: "beta",
    ownerMemberId: null, circleId: null, status: "OPEN", isPrivate: false, archivedAt: null });
  await known("Proposal", privateParent, [{ kind: "Action", id: privateInput.id }], beta);
  const visibleChild = fixture.add("action", { id: "action-visible", workspaceId, proposalId: visible.id,
    title: "Visible child", bodyMd: "Public child body", authorUserId: "beta", assigneeMemberId: "member-alpha",
    isPrivate: false, status: "OPEN", archivedAt: null });
  await known("Action", visibleChild, [], beta);
  const hiddenChild = fixture.add("action", { id: "action-hidden", workspaceId, proposalId: hiddenChildParent.id,
    title: "Restricted child", bodyMd: "Restricted child body", authorUserId: "beta", assigneeMemberId: "member-alpha",
    isPrivate: false, status: "OPEN", archivedAt: null });
  await known("Action", hiddenChild, [{ kind: "Action", id: privateInput.id }], beta);
  fixture.add("proposal", { id: "foreign-parent", workspaceId: "ws-b", title: "Foreign proposal",
    bodyMd: "Foreign workspace body", authorUserId: "beta", isPrivate: false, status: "OPEN", archivedAt: null });
  return { visible, hiddenChildParent, privateParent };
}

describe("Proposal reader source admission", () => {
  it("counts and pages only parents matched by readable member relations", async () => {
    const { visible } = await seed();
    const alphaPage = await listProposals(alpha, workspaceId, { memberId: "member-alpha", take: 1 });
    expect(alphaPage.total).toBe(1);
    expect(alphaPage.items.map((row) => row.id)).toEqual([visible.id]);
    expect((await listProposals(alpha, workspaceId, { memberId: "member-alpha", take: 1, skip: 1 })).items).toEqual([]);
    expect((await listProposals(alpha, workspaceId, { take: 1 })).total).toBe(2);
    expect((await listProposals(beta, workspaceId, { take: 10 })).total).toBe(3);
    expect((await listProposals(alpha, workspaceId, { circleId: "private-circle", take: 10 })).total).toBe(0);
    expect((await listProposals(beta, workspaceId, { circleId: "private-circle", take: 10 })).items.map((row) => row.id)).toEqual([visible.id]);
    expect(JSON.stringify(alphaPage)).not.toContain("Restricted child");
    expect(JSON.stringify(alphaPage)).not.toContain("Foreign workspace");
  });

  it("independently gates labels, linked children and process metadata on the returned row", async () => {
    const { visible, privateParent } = await seed();
    const proposal = await getProposal(alpha, { workspaceId, proposalId: visible.id });
    expect(proposal.circle).toBeNull();
    expect(proposal.circleId).toBeNull();
    expect(proposal.ownerMember).toBeNull();
    expect(proposal.ownerMemberId).toBeNull();
    expect(proposal.meetingId).toBeNull();
    expect(proposal.author).toEqual({ id: "", email: "", displayName: null });
    expect(proposal.actions.map((row) => row.title)).toEqual(["Visible child"]);
    expect(proposal.adviceProcess).toEqual({ requests: [] });
    expect(JSON.stringify(proposal)).not.toContain("Restricted");
    const permitted = await getProposal(beta, { workspaceId, proposalId: visible.id });
    expect(permitted.circle).toEqual({ id: "private-circle", name: "Restricted circle label" });
    expect(permitted.ownerMember?.user.displayName).toBe("Restricted author label");
    expect(permitted.author.displayName).toBe("Restricted author label");
    expect(permitted.meetingId).toBe("restricted-meeting");
    await expect(getProposal(alpha, { workspaceId, proposalId: privateParent.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getProposal(beta, { workspaceId, proposalId: privateParent.id })).resolves.toMatchObject({ id: privateParent.id });
  });

  it("rejects a parent whose content changes after its list row was read", async () => {
    const { visible } = await seed();
    const read = vi.mocked(fixture.prisma.proposal.findMany).getMockImplementation()!;
    vi.mocked(fixture.prisma.proposal.findMany).mockImplementationOnce(async (args: any) => {
      const rows = await read(args);
      visible.bodyMd = "Changed after the candidate read";
      return rows;
    });
    const result = await listProposals(alpha, workspaceId, { take: 10 });
    expect(result.items.every((row) => row.id !== visible.id)).toBe(true);
    expect(result.total).toBe(1);
  });
});
