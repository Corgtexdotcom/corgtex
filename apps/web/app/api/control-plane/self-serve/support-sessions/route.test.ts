import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), mode: vi.fn() }));
vi.mock("@/lib/auth", () => ({ resolveControlPlaneRequestActor: mocks.actor }));
vi.mock("@/lib/control-plane-guard", () => ({ requireControlPlaneDeploymentMode: mocks.mode }));
vi.mock("@/lib/http", () => ({ handleRouteError: () => NextResponse.json({ error: "unauthorized" }, { status: 401 }) }));
import { POST } from "./route";
import { POST as deploymentPOST } from "../../deployments/[deploymentId]/support-sessions/route";

describe("retired support session APIs", () => {
  it("preserves deployment and authentication guards before returning explicit retirement", async () => {
    for (const handler of [POST, deploymentPOST]) {
      mocks.actor.mockReset();
      mocks.mode.mockReturnValue(new NextResponse(null, { status: 404 }));
      const request = new NextRequest("https://ops.example.test/api/retired", { method: "POST" });
      expect((await handler(request)).status).toBe(404);
      expect(mocks.actor).not.toHaveBeenCalled();
      mocks.mode.mockReturnValue(null);
      mocks.actor.mockRejectedValueOnce(new Error("unauthenticated"));
      expect((await handler(request)).status).toBe(401);
      mocks.actor.mockResolvedValue({ kind: "user", user: { id: "fixture" } });
      const retired = await handler(request);
      expect(retired.status).toBe(410);
      expect(await retired.json()).toMatchObject({ code: "SUPPORT_SESSION_RETIRED" });
      expect(retired.headers.has("set-cookie")).toBe(false);
    }
  });
});
