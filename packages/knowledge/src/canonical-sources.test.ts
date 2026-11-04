import { describe, expect, it, vi } from "vitest";
import { loadCanonicalKnowledgeSource } from "./canonical-sources";

const createdAt = new Date("2026-10-17T00:00:00Z");
const user = { id: "author", displayName: "Ada", email: "ada@example.test" };
const circle = { id: "circle", workspaceId: "workspace", name: "Product", purposeMd: "Serve", domainMd: "Product work", archivedAt: null };
const member = { id: "member", workspaceId: "workspace", userId: user.id, user, isActive: true };
const base = { id: "source", workspaceId: "workspace", title: "Canonical", status: "OPEN", priority: 2, createdAt, bodyMd: "Original body",
  author: user, assigneeMember: member, raisedByMember: member, circle, dueAt: null };
function database(model: string, row: unknown) {
  return { [model]: { findMany: vi.fn(async () => [row]) } };
}

describe("canonical joined source renderers", () => {
  it.each(["ACTION", "TENSION"] as const)("renders %s exact canonical body and retains all label contributors", async sourceType => {
    const db = database(sourceType.toLowerCase(), base);
    const result = await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType, sourceId: base.id }, db as never);
    expect(result?.content).toBe(sourceType === "ACTION"
      ? "# Action: Canonical\n**Status:** OPEN | **Due:** None\n**Author:** Ada\n**Circle:** Product | **Assigned to:** Ada\n**Created:** 2026-10-17T00:00:00.000Z\n\nOriginal body"
      : "# Tension: Canonical\n**Status:** OPEN | **Priority:** 2\n**Author:** Ada\n**Raised by:** Ada\n**Circle:** Product | **Assigned to:** Ada\n**Created:** 2026-10-17T00:00:00.000Z\n\nOriginal body");
    expect(result?.inputs.map(input => `${input.kind}:${input.id}`)).toEqual([`${sourceType === "ACTION" ? "Action" : "Tension"}:source`, "User:author", "Member:member", "Circle:circle"]);
    expect(result?.metadata).toEqual({ status: "OPEN" });
    expect(db[sourceType.toLowerCase()].findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "workspace", id: { in: ["source"] }, archivedAt: null }, take: 1 }));
  });
  it("renders Circle and Role with the original Circle contributor and scoped relation", async () => {
    const circleResult = await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType: "CIRCLE", sourceId: circle.id }, database("circle", circle) as never);
    expect(circleResult?.content).toBe("# Circle: Product\n\n**Purpose:**\nServe\n\n**Domain:**\nProduct work");
    const db = database("role", { id: "role", circleId: circle.id, name: "Maker", purposeMd: null, accountabilities: ["Ship", "Learn"], circle });
    const role = await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType: "ROLE", sourceId: "role" }, db as never);
    expect(role?.content).toBe("# Role: Maker\n\n**Circle:** Product\n\n**Purpose:**\nNot specified\n\n**Accountabilities:**\n- Ship\n- Learn");
    expect(role?.inputs.map(input => input.kind)).toEqual(["Role", "Circle"]);
    expect(db.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["role"] }, archivedAt: null, circle: { workspaceId: "workspace", archivedAt: null } } }));
  });
  it.each(["ACTION", "TENSION"] as const)("rejects foreign joined %s labels", async sourceType => {
    expect(await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType, sourceId: base.id },
      database(sourceType.toLowerCase(), { ...base, circle: { ...circle, workspaceId: "foreign" } }) as never)).toBeNull();
  });
  it("renders Slack with the channel content proof, omits unproved installation annotations, and requires active public ingress", async () => {
    const message = { id: "message", installationId: "installation", externalChannelId: "C1", externalMessageId: "M1", externalUserId: "U1", threadExternalId: null,
      messageTs: createdAt, text: "Original message", permalink: "https://example.test/slack" };
    const channel = { id: "channel", installationId: "installation", externalChannelId: "C1", name: "general" };
    const db = { ...database("communicationMessage", message), ...database("communicationChannel", channel) };
    const result = await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType: "SLACK", sourceId: "message" }, db as never);
    expect(result?.content).toBe("Slack message in #general\nPosted at 2026-10-17T00:00:00.000Z\nAuthor: U1\n\nOriginal message");
    expect(result?.inputs.map(input => input.kind)).toEqual(["CommunicationMessage", "CommunicationChannel"]);
    expect(result?.metadata).not.toHaveProperty("externalTeamName");
    expect(db.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "workspace", provider: "SLACK", installation: { workspaceId: "workspace", status: "ACTIVE", disconnectedAt: null } }) }));
    expect(db.communicationChannel.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({ workspaceId: "workspace", kind: "PUBLIC", isIngestEnabled: true, isArchived: false }) });
    db.communicationChannel.findMany.mockResolvedValue([]);
    expect(await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType: "SLACK", sourceId: "message" }, db as never)).toBeNull();
  });
  it("leaves Event unsupported instead of inventing lineage", async () => {
    expect(await loadCanonicalKnowledgeSource({ workspaceId: "workspace", sourceType: "EVENT", sourceId: "event" }, {} as never)).toBeNull();
  });
});
