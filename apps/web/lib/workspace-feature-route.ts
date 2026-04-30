import { NextResponse } from "next/server";

import { isWorkspaceFeatureEnabled, type WorkspaceFeatureFlag } from "@/lib/workspace-feature-flags";

export async function disabledWorkspaceFeatureResponse(workspaceId: string, flag: WorkspaceFeatureFlag) {
  if (await isWorkspaceFeatureEnabled(workspaceId, flag)) {
    return null;
  }

  return NextResponse.json(
    { error: { code: "NOT_FOUND", message: "Not found." } },
    { status: 404 },
  );
}
