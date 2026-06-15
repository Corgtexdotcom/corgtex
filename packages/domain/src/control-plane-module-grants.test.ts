import { describe, expect, it } from "vitest";
import type { AppActor } from "@corgtex/shared";

import { deleteControlPlaneModuleGrant, setControlPlaneModuleGrant } from "./control-plane";

// A plain user actor passes the control-plane scope check (only control-plane
// agents are scope-restricted), so the mutation-reason guard runs next and
// throws before any database access - letting us assert it without DB mocks.
const userActor = {
  kind: "user",
  user: { id: "user-1", email: "admin@example.com", displayName: "Admin" },
} as unknown as AppActor;

describe("control-plane module grant mutations require a reason", () => {
  it("rejects setControlPlaneModuleGrant without a reason", async () => {
    await expect(
      setControlPlaneModuleGrant(userActor, {
        deploymentId: "deployment-1",
        moduleKey: "finance",
        principalType: "MEMBER_ROLE",
        principalId: "FINANCE_STEWARD",
        accessLevel: "write",
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "CONTROL_PLANE_REASON_REQUIRED" });
  });

  it("rejects deleteControlPlaneModuleGrant without a reason", async () => {
    await expect(
      deleteControlPlaneModuleGrant(userActor, {
        deploymentId: "deployment-1",
        grantId: "grant-1",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "CONTROL_PLANE_REASON_REQUIRED" });
  });
});
