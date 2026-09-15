import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  changeWorkspaceSupportGrant: vi.fn(), listWorkspaceSupportGrants: vi.fn(),
  getSupportSetup: vi.fn(), updateSupportSetup: vi.fn(),
  resolveRequestActor: vi.fn(), workspace: { findUnique: vi.fn() },
}));
vi.mock("@corgtex/domain", async () => ({
  ...mocks,
  AppError: (await import("../../../../../../../packages/domain/src/errors")).AppError,
  supportConnectorPreparationSchema: (await import("../../../../../../../packages/domain/src/workspace-support-access")).supportConnectorPreparationSchema,
}));
vi.mock("@corgtex/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/shared")>(),
  prisma: { workspace: mocks.workspace },
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.resolveRequestActor }));

import { PUT } from "./route";
import { PATCH } from "../support-setup/route";
const actor = { kind: "user", user: { id: "named-actor" } };
const context = () => ({ params: Promise.resolve({ workspaceId: "ws" }) });
const checklist = { configurationPrepared: true, consentRequested: false, handoffReady: false };
const cases = [
  { name: "owner Full grant", method: "PUT", path: "support-access", handler: PUT, mutation: mocks.changeWorkspaceSupportGrant,
    body: { email: "support@example.test", role: "FULL", isActive: true, expectedVersion: 0 } },
  { name: "owner Setup grant", method: "PUT", path: "support-access", handler: PUT, mutation: mocks.changeWorkspaceSupportGrant,
    body: { email: "support@example.test", role: "SETUP", isActive: true, expectedVersion: 1 } },
  { name: "owner revocation", method: "PUT", path: "support-access", handler: PUT, mutation: mocks.changeWorkspaceSupportGrant,
    body: { email: "support@example.test", role: "SETUP", isActive: false, expectedVersion: 2 } },
  { name: "support preparation", method: "PATCH", path: "support-setup", handler: PATCH, mutation: mocks.updateSupportSetup,
    body: { expectedVersion: 1, checklist } },
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveRequestActor.mockResolvedValue(actor);
  mocks.workspace.findUnique.mockResolvedValue({ slug: "ordinary" });
});
describe("support mutation demo boundary", () => {
  it.each(cases)("preserves $name outside demo", async ({ method, path, handler, mutation, body }) => {
    mutation.mockResolvedValue({ saved: true });
    const response = await handler(new NextRequest(`https://app.example.test/api/workspaces/ws/${path}`, { method, body: JSON.stringify(body) }), context());
    expect(response.status).toBe(200);
    expect(mocks.workspace.findUnique).toHaveBeenCalledWith({ where: { id: "ws" }, select: { slug: true } });
    expect(mutation).toHaveBeenCalledExactlyOnceWith(actor, { workspaceId: "ws", ...body });
    expect(mocks.workspace.findUnique.mock.invocationCallOrder[0]).toBeLessThan(mutation.mock.invocationCallOrder[0]);
  });
  it.each(cases)("denies $name in the actual demo guard before mutation", async ({ method, path, handler, body }) => {
    mocks.workspace.findUnique.mockResolvedValue({ slug: "jnj-demo" });
    const response = await handler(new NextRequest(`https://app.example.test/api/workspaces/ws/${path}`, { method, body: JSON.stringify(body) }), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "DEMO_MODE" } });
    expect(mocks.changeWorkspaceSupportGrant).not.toHaveBeenCalled();
    expect(mocks.updateSupportSetup).not.toHaveBeenCalled();
  });
});
