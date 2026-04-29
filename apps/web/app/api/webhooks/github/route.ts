import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { markBuildArtifactClosedFromGitHub } from "@corgtex/domain";

export const dynamic = "force-dynamic";

function verifyGithubSignature(rawBody: string, headers: Headers) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[github-webhook] GITHUB_WEBHOOK_SECRET is not configured. Rejecting webhook.");
    return false;
  }

  const signature = headers.get("x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (!verifyGithubSignature(rawBody, request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = request.headers.get("x-github-event");
  if (event !== "pull_request") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const body = asRecord(payload);
  const action = asString(body?.action);
  if (action !== "closed") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const pullRequest = asRecord(body?.pull_request);
  const repository = asRecord(body?.repository);
  const owner = asRecord(repository?.owner);
  const pullRequestNumber = typeof pullRequest?.number === "number" ? pullRequest.number : null;
  const repositoryName = asString(repository?.name);
  const repositoryOwner = asString(owner?.login);

  if (!pullRequestNumber || !repositoryName || !repositoryOwner) {
    return NextResponse.json({ error: "Missing pull request metadata" }, { status: 400 });
  }

  const closedAtRaw = asString(pullRequest?.closed_at);
  const result = await markBuildArtifactClosedFromGitHub({
    repositoryOwner,
    repositoryName,
    pullRequestNumber,
    merged: pullRequest?.merged === true,
    mergeCommitSha: asString(pullRequest?.merge_commit_sha),
    closedAt: closedAtRaw ? new Date(closedAtRaw) : null,
  });

  return NextResponse.json({ ok: true, ...result });
}
