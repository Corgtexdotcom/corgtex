import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError } from "@corgtex/domain";
import { captureTelemetryEvent, env, resolveReleaseMetadata } from "@corgtex/shared";
import { z } from "zod";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const telemetrySmokeSchema = z.object({
  expectedGitSha: z.string().trim().min(1).optional().nullable(),
  runId: z.string().trim().min(1).max(120),
}).strict();

function bearerSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function requireSmokeSecret(request: NextRequest) {
  if (!env.SMOKE_EMAIL_CAPTURE_SECRET) {
    throw new AppError(503, "SMOKE_CAPTURE_NOT_CONFIGURED", "Smoke capture is not configured.");
  }
  if (bearerSecret(request) !== env.SMOKE_EMAIL_CAPTURE_SECRET) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid smoke capture secret.");
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSmokeSecret(request);
    const body = await validateBody(request, telemetrySmokeSchema);
    const release = resolveReleaseMetadata(process.env, { service: "web" });
    if (body.expectedGitSha && release.gitSha !== body.expectedGitSha) {
      throw new AppError(409, "RELEASE_MISMATCH", `Release git SHA ${release.gitSha ?? "missing"} did not match expected ${body.expectedGitSha}.`);
    }

    const telemetry = await captureTelemetryEvent({
      distinctId: `smoke:${body.runId}`,
      event: "corgtex_release_telemetry_smoke",
      properties: {
        release_git_sha: release.gitSha,
        release_git_sha_source: release.source.gitSha,
        release_image_tag: release.imageTag,
        release_version: release.version,
        run_id: body.runId,
        smoke_kind: "release_telemetry",
      },
      sampleRate: 1,
    });

    return NextResponse.json({
      release,
      telemetry,
    });
  } catch (error) {
    return handleRouteError(error, { request, surface: "internal_smoke" });
  }
}
