import { NextResponse } from "next/server";
import { env } from "@corgtex/shared";

export function controlPlaneModeUnavailableResponse() {
  return NextResponse.json(
    {
      error: {
        code: "CONTROL_PLANE_NOT_AVAILABLE",
        message: "Use the dedicated Ops control plane for control-plane operations.",
      },
    },
    { status: 404 },
  );
}

export function requireControlPlaneDeploymentMode() {
  return env.CONTROL_PLANE_MODE ? null : controlPlaneModeUnavailableResponse();
}
