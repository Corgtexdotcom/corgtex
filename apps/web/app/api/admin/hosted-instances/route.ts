import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listExternalInstances,
  provisionHostedCustomerInstance,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const provisionHostedInstanceSchema = z.object({
  label: z.string().trim().min(1),
  customerSlug: z.string().trim().min(1),
  region: z.string().trim().min(1),
  dataResidency: z.string().trim().min(1),
  customDomain: z.string().trim().min(1).nullable().optional(),
  supportOwnerEmail: z.string().trim().email().nullable().optional(),
  releaseVersion: z.string().trim().min(1).nullable().optional(),
  releaseImageTag: z.string().trim().min(1),
  webImage: z.string().trim().min(1).nullable().optional(),
  workerImage: z.string().trim().min(1).nullable().optional(),
  webSource: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable().optional(),
    commitSha: z.string().trim().min(1).nullable().optional(),
    rootDirectory: z.string().trim().min(1).nullable().optional(),
    dockerfilePath: z.string().trim().min(1).nullable().optional(),
    startCommand: z.string().trim().min(1).nullable().optional(),
    builder: z.enum(["HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"]).nullable().optional(),
  }).nullable().optional(),
  workerSource: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable().optional(),
    commitSha: z.string().trim().min(1).nullable().optional(),
    rootDirectory: z.string().trim().min(1).nullable().optional(),
    dockerfilePath: z.string().trim().min(1).nullable().optional(),
    startCommand: z.string().trim().min(1).nullable().optional(),
    builder: z.enum(["HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"]).nullable().optional(),
  }).nullable().optional(),
  bootstrapBundleUri: z.string().trim().url().nullable().optional(),
  bootstrapBundleChecksum: z.string().trim().min(1).nullable().optional(),
  bootstrapBundleSchemaVersion: z.string().trim().min(1).nullable().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const instances = await listExternalInstances(actor);
    return NextResponse.json({ instances });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, provisionHostedInstanceSchema);
    const instance = await provisionHostedCustomerInstance(actor, body);
    return NextResponse.json({ instance }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
