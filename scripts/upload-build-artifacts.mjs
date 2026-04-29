#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
]);

function usage() {
  console.error(`Usage:
  node scripts/upload-build-artifacts.mjs \\
    --base-url http://localhost:3000 \\
    --workspace-id <workspace-id> \\
    --repo owner/name \\
    --pr 123 \\
    --title "Tools directory proof" \\
    --summary "Visual proof for list/grid/create/reveal" \\
    --file /path/list.png:list:"List view"

Auth:
  CORGTEX_API_BEARER may contain the full bearer token value.
  Or set AGENT_API_KEY and this helper sends agent-<AGENT_API_KEY>.`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    index += 1;
    if (key === "file") files.push(value);
    else args[key] = value;
  }
  return { args, files };
}

function parseFileSpec(spec) {
  const [filePath, label, caption] = spec.split(":");
  if (!filePath) usage();
  return {
    filePath,
    label: label || path.basename(filePath),
    caption: caption || "",
  };
}

function mimeFor(filePath) {
  return MIME_BY_EXT.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function bearerToken() {
  if (process.env.CORGTEX_API_BEARER) return process.env.CORGTEX_API_BEARER;
  if (process.env.AGENT_API_KEY) return `agent-${process.env.AGENT_API_KEY}`;
  console.error("Missing CORGTEX_API_BEARER or AGENT_API_KEY.");
  process.exit(1);
}

const { args, files } = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"]?.replace(/\/$/, "");
const workspaceId = args["workspace-id"];
const repo = args.repo;
const prNumber = args.pr ? Number.parseInt(args.pr, 10) : null;
const title = args.title;

if (!baseUrl || !workspaceId || !repo || !title || files.length === 0) usage();
const [repositoryOwner, repositoryName] = repo.split("/");
if (!repositoryOwner || !repositoryName) usage();

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${bearerToken()}`,
};

const artifactRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/build-artifacts`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    repositoryOwner,
    repositoryName,
    pullRequestNumber: prNumber,
    pullRequestUrl: args["pr-url"] ?? null,
    branchName: args.branch ?? null,
    commitSha: args.commit ?? null,
    title,
    summaryMd: args.summary ?? null,
    classification: args.classification ?? "OPEN_CORE",
    visibility: args.visibility ?? "PUBLIC_REVIEW",
    noPrivateDataConfirmed: true,
  }),
});

if (!artifactRes.ok) {
  console.error(await artifactRes.text());
  process.exit(1);
}

let artifact = await artifactRes.json();

for (const spec of files.map(parseFileSpec)) {
  const bytes = await readFile(spec.filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeFor(spec.filePath) }), path.basename(spec.filePath));
  form.append("kind", mimeFor(spec.filePath).startsWith("video/") ? "VIDEO" : "SCREENSHOT");
  form.append("label", spec.label);
  form.append("captionMd", spec.caption);

  const uploadRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/build-artifacts/${artifact.id}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken()}` },
    body: form,
  });
  if (!uploadRes.ok) {
    console.error(await uploadRes.text());
    process.exit(1);
  }
  const upload = await uploadRes.json();
  artifact = upload.artifact;
}

const markdown = artifact.assets
  .filter((asset) => asset.publicUrl)
  .map((asset) => `- [${asset.label}](${asset.publicUrl})`)
  .join("\n");

console.log(markdown || "No public proof links were generated for this artifact.");
