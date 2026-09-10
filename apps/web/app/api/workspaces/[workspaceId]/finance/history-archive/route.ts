import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { defaultStorage } from "@corgtex/storage";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

// Retired financial applications may have had stricter access than today's
// Finance reader role. Their operator-preserved history is never indexed.
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    if (actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "An active workspace administrator is required.");
    await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
    const member = await prisma.member.findFirst({
      where: { workspaceId, userId: actor.user.id, isActive: true, kind: "HUMAN", role: "ADMIN" },
      select: { id: true },
    });
    if (!member) throw new AppError(403, "FORBIDDEN", "An active workspace administrator is required.");

    const archive = await prisma.workspaceFeatureFlag.findUnique({
      where: { workspaceId_flag: { workspaceId, flag: "operator_financial_history_archive" } },
      select: { enabled: true, config: true },
    });
    const config = archive?.config as { sha256?: unknown; bytes?: unknown } | null;
    if (!archive?.enabled || typeof config?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.sha256)
      || typeof config.bytes !== "number" || !Number.isSafeInteger(config.bytes) || config.bytes <= 0 || config.bytes > 16 * 1024 * 1024
      || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
      throw new AppError(404, "NOT_FOUND", "No financial history archive is available.");
    }
    // Derive the key from the authorized workspace, never an arbitrary flag URL
    // or a request-supplied storage key. Proxy bytes rather than sharing a SAS.
    const file = await defaultStorage.get(`imports/${workspaceId}/history/${config.sha256}.json.gz`);
    if (!file) throw new AppError(404, "NOT_FOUND", "Financial history archive not found.");
    if (file.data.length !== config.bytes || createHash("sha256").update(file.data).digest("hex") !== config.sha256) {
      throw new AppError(409, "ARCHIVE_INTEGRITY_MISMATCH", "Financial history archive verification failed.");
    }
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="financial-history.json.gz"',
        "Content-Length": String(file.data.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_history_archive" });
  }
}
