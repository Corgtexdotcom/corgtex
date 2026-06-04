import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

export function envFlag(name) {
  return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true";
}

export function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function firstAllowedSmokeEmailDomain() {
  return (process.env.SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)[0] ?? null;
}

export async function writeJsonArtifact(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function pollCapturedSetupEmail({
  baseUrl,
  secret,
  toEmail,
  runId = null,
  consume = true,
  timeoutMs = 90_000,
}) {
  const deadline = Date.now() + timeoutMs;
  const url = new URL("/api/internal/smoke/email-captures/latest", baseUrl);
  url.searchParams.set("to", toEmail);
  if (runId) url.searchParams.set("runId", runId);
  if (consume) url.searchParams.set("consume", "true");

  let lastBody = null;
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${secret}`,
      },
    });
    const body = await readJson(response);
    if (response.ok && body.capture?.setupUrl) {
      return body.capture;
    }
    lastBody = body;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }

  throw new Error(`Timed out waiting for setup-email capture for ${toEmail}: ${JSON.stringify(lastBody)}`);
}

export async function recordSmokeRun({
  baseUrl,
  secret,
  run,
}) {
  if (!secret) return null;
  const response = await fetch(new URL("/api/internal/smoke/runs", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(run),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`Unable to record self-serve smoke run (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.run;
}
