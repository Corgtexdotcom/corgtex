import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import type { SlackAttemptControls } from "./communication";
import { deliverNotificationDelivery } from "./notifications";
import { recordArtifactInputLineage } from "./source-lineage";

const slack = vi.hoisted(() => ({ send: vi.fn(), resolve: vi.fn(), email: vi.fn() }));
vi.mock("@corgtex/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/shared")>(), sendEmail: slack.email,
}));
vi.mock("./communication", () => ({ sendSlackMessage: slack.send, resolveSlackNotificationRecipient: slack.resolve }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const localFixture = database.hostname === "127.0.0.1" && database.port === "63971" && database.pathname === "/notification_delivery_test";
const hostedFixture = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost"
  && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!localFixture && !hostedFixture) || database.searchParams.get("schema") !== "public") {
  throw new Error("Slack attempt tests require their assigned disposable database or the documented hosted CI fixture.");
}
beforeEach(async () => {
  await truncateAllTables();
  slack.send.mockReset();
  slack.email.mockReset();
  slack.resolve.mockReset().mockResolvedValue({ installationId: "synthetic-slack", externalUserId: "synthetic-recipient" });
});

async function fixture(channel: "SLACK" | "EMAIL" = "SLACK") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Slack attempt", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id,
    sourceType: "DOC", tier: 1, content: "Synthetic original notification source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const notification = await prisma.notification.create({ data: { workspaceId: workspace.id, userId: user.id,
    type: "deliberation.mention", title: "Synthetic notice", bodyMd: "Synthetic source body" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Notification", id: notification.id }, content: notification, origin: "DERIVED",
    inputs: [{ kind: "BrainSource", id: source.id }] }));
  const delivery = await prisma.notificationDelivery.create({ data: { workspaceId: workspace.id,
    notificationId: notification.id, userId: user.id, channel } });
  const installation = await prisma.communicationInstallation.create({ data: {
    workspaceId: workspace.id, provider: "SLACK", externalWorkspaceId: randomUUID(), botTokenEnc: "synthetic-no-provider",
  } });
  const mapping = await prisma.communicationExternalUser.create({ data: {
    workspaceId: workspace.id, installationId: installation.id, provider: "SLACK", externalUserId: randomUUID(),
    userId: user.id, memberId: member.id, email: user.email,
  } });
  slack.resolve.mockResolvedValue({ installationId: installation.id, externalUserId: mapping.externalUserId });
  return { workspace, user, member, source, notification, delivery, installation, mapping };
}

it.each(["credentials", "retry"] as const)("retains original source, recipient and selected head across %s waits", async boundary => {
  // Each variant has fresh persisted lineage; restoring the body/access must not restore the old receipt.
  for (const change of ["source", "recipient", "head", "none"] as const) {
    const f = await fixture();
    let sends = 0;
    let rejected = false;
    let aborted = false;
    slack.send.mockImplementation(async (_id, _target, _blocks, _token, controls?: SlackAttemptControls) => {
      if (boundary === "retry") { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
      if (change === "source") {
        await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
        await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
      } else if (change === "recipient") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else if (change === "head") {
        const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
          artifactType: "Notification", artifactId: f.notification.id }, orderBy: { revision: "desc" } });
        const { id: _id, ...data } = head;
        await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
          inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
          permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull } });
      }
      try { await controls?.authorizeAttempt({ signal: controls.signal }); }
      catch (error) { rejected = true; aborted = controls?.signal.aborted ?? false; throw error; }
      sends++;
      return { ts: "synthetic-sent" };
    });
    const result = await deliverNotificationDelivery(f.delivery.id).catch(error => error);
    const current = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } });
    if (change === "none") {
      expect(result).toEqual({ status: "SENT" }); expect(current.status).toBe("SENT");
      expect(sends).toBe(boundary === "retry" ? 2 : 1);
    } else {
      expect(result).toBeInstanceOf(Error); expect(rejected).toBe(true); expect(aborted).toBe(true);
      expect(sends).toBe(boundary === "retry" ? 1 : 0); expect(current.status).toBe("PENDING");
      expect(await prisma.notificationDelivery.count({ where: { notificationId: f.notification.id, channel: "EMAIL" } })).toBe(0);
    }
  }
});

it("does not mark SENT or create fallback when an adapter swallows a real revoked proof", async () => {
  const f = await fixture(); let rejected = false;
  slack.send.mockImplementation(async (_id, _target, _blocks, _token, controls?: SlackAttemptControls) => {
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    try { await controls?.authorizeAttempt({ signal: controls.signal }); } catch { rejected = true; }
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    return { ts: "ignored-guard" };
  });
  const result = await deliverNotificationDelivery(f.delivery.id).catch(error => error);
  expect(rejected).toBe(true); expect(result).toBeInstanceOf(Error);
  expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).status).toBe("PENDING");
  expect(await prisma.notificationDelivery.count({ where: { notificationId: f.notification.id } })).toBe(1);
});


it.each(["credentials", "retry"] as const)("retains selected installation and mapping through %s", async boundary => {
  for (const change of ["installation", "replacement", "mapping", "external-user", "none"] as const) {
    const f = await fixture(); let sends = 0; let denied = false;
    slack.send.mockImplementation(async (_id, _target, _blocks, _token, controls: SlackAttemptControls) => {
      if (boundary === "retry") { await controls.authorizeAttempt({ signal: controls.signal }); sends++; }
      if (change === "installation") {
        await prisma.communicationInstallation.update({ where: { id: f.installation.id }, data: { status: "DISCONNECTED" } });
        await prisma.communicationInstallation.update({ where: { id: f.installation.id }, data: { status: "ACTIVE" } });
      } else if (change === "replacement") {
        await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id, provider: "SLACK",
          externalWorkspaceId: randomUUID(), botTokenEnc: "synthetic-new", installedAt: new Date(Date.now() + 1000) } });
      } else if (change === "mapping") {
        await prisma.communicationExternalUser.update({ where: { id: f.mapping.id }, data: { userId: null } });
        await prisma.communicationExternalUser.update({ where: { id: f.mapping.id }, data: { userId: f.user.id } });
      } else if (change === "external-user") {
        await prisma.communicationExternalUser.update({ where: { id: f.mapping.id }, data: { externalUserId: randomUUID() } });
        await prisma.communicationExternalUser.update({ where: { id: f.mapping.id }, data: { externalUserId: f.mapping.externalUserId } });
      }
      try { await controls.authorizeAttempt({ signal: controls.signal }); }
      catch (error) { denied = true; throw error; }
      sends++; return { ts: "synthetic" };
    });
    const result = await deliverNotificationDelivery(f.delivery.id).catch(error => error);
    expect(denied).toBe(change !== "none");
    expect(sends).toBe((boundary === "retry" ? 1 : 0) + (change === "none" ? 1 : 0));
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).status)
      .toBe(change === "none" ? "SENT" : "PENDING");
    if (change === "none") expect(result).toEqual({ status: "SENT" }); else expect(result).toBeInstanceOf(Error);
    expect(await prisma.notificationDelivery.count({ where: { notificationId: f.notification.id } })).toBe(1);
  }
});

it.each(["credentials", "retry"] as const)("retains original email source, member, head and address through %s", async boundary => {
  for (const change of ["source", "recipient", "head", "email", "none"] as const) {
    const f = await fixture("EMAIL"); let sends = 0; let denied = false;
    slack.email.mockImplementation(async (_params, controls: SlackAttemptControls) => {
      if (boundary === "retry") { await controls.authorizeAttempt({ signal: controls.signal }); sends++; }
      if (change === "source") {
        await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
        await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
      } else if (change === "recipient") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else if (change === "email") {
        await prisma.user.update({ where: { id: f.user.id }, data: { email: `${randomUUID()}@example.test` } });
      } else if (change === "head") {
        const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
          artifactType: "Notification", artifactId: f.notification.id }, orderBy: { revision: "desc" } });
        const { id: _id, ...data } = head;
        await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
          inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
          permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull } });
      }
      try { await controls.authorizeAttempt({ signal: controls.signal }); }
      catch (error) { denied = true; throw error; }
      sends++; return { status: "SENT", providerMessageId: "synthetic-email" };
    });
    const result = await deliverNotificationDelivery(f.delivery.id).catch(error => error);
    expect(denied).toBe(change !== "none");
    expect(sends).toBe((boundary === "retry" ? 1 : 0) + (change === "none" ? 1 : 0));
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).status)
      .toBe(change === "none" ? "SENT" : "PENDING");
    if (change === "none") expect(result).toEqual({ status: "SENT" }); else expect(result).toBeInstanceOf(Error);
  }
});
