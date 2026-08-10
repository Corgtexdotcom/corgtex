import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
export const REVIEWER_LOGIN = "beepto-codex";
export const ATTESTATION_VERSION = "rsi/v1";
const MUTATING_EVENTS = new Set(["labeled", "unlabeled", "synchronize", "ready_for_review", "converted_to_draft", "reopened"]);
const DOC_EXT = new Set([".md", ".mdx"]);
const RISK_CAPS = { low: [1200, 50], standard: [800, 25], high: [700, 15], critical: [400, 15] };
const FORBIDDEN_PATHS = [/^deploy\//, /^\.github\/workflows\//, /^prisma\/migrations\//, /^packages\/domain\/src\/auth.*\.ts$/, /^apps\/web\/lib\/auth\.ts$/];
const POLICY_PATHS = [/^AGENTS\.md$/, /^\.agents\/plan-template\.md$/, /^\.codex\/review\.md$/, /^\.codex\/ops\/.*\.md$/, /^\.github\/pull_request_template\.md$/, /^docs\/contributing\/agent-pipeline\.mdx$/, /^docs\/contributing\/pull-requests\.mdx$/, /^scripts\/check-plan(?:-policy(?:\.test)?)?\.mjs$/];
const SECRET_PATTERNS = [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, /-----BEGIN OPENSSH PRIVATE KEY-----/, /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/];
const ATTESTATION_KEYS = ["v", "pr", "headSha", "baseSha", "bodyDigest", "labelDigest"];
export function sha256Bytes(buf) { return createHash("sha256").update(buf).digest("hex"); }
function invariant(ok, message) { if (!ok) throw new Error(message); }
export function encodeLabelSet(names) {
  invariant(Array.isArray(names) && names.every((n) => typeof n === "string"), "unexpected label names");
  const sorted = names.map((n) => Buffer.from(n, "utf8")).sort(Buffer.compare);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(sorted.length, 0);
  const len = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return l; };
  return Buffer.concat([count, ...sorted.flatMap((b) => [len(b), b])]);
}
export function computeSnapshot(pr) {
  invariant(pr && Number.isSafeInteger(pr.number) && pr.number > 0, "missing PR number");
  invariant(["open", "closed"].includes(pr.state) && typeof pr.draft === "boolean" && (pr.auto_merge === null || typeof pr.auto_merge === "object"), "unexpected PR state");
  invariant(pr.body === null || typeof pr.body === "string", "unexpected PR body");
  invariant(/^[0-9a-f]{40}$/.test(pr.head?.sha) && /^[0-9a-f]{40}$/.test(pr.base?.sha), "unexpected PR sha");
  invariant(Array.isArray(pr.labels) && pr.labels.every((l) => l && typeof l.name === "string"), "unexpected PR labels");
  const bodyNull = pr.body === null || pr.body === undefined;
  return {
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    bodyDigest: bodyNull ? null : sha256Bytes(Buffer.from(pr.body, "utf8")),
    labelDigest: sha256Bytes(encodeLabelSet((pr.labels ?? []).map((l) => l.name))),
    bodyNull,
  };
}
export function buildAttestationPayload(prNumber, s) {
  return JSON.stringify({ v: ATTESTATION_VERSION, pr: prNumber, headSha: s.headSha, baseSha: s.baseSha, bodyDigest: s.bodyDigest, labelDigest: s.labelDigest });
}
export function parseAttestation(reviewBody, prNumber) {
  const text = String(reviewBody ?? ""); const markers = text.match(/```review-snapshot-attestation\b/g) ?? [];
  if (markers.length !== 1) return { error: `expected exactly one attestation block, found ${markers.length}` };
  const block = text.match(/```review-snapshot-attestation\r?\n([^\r\n]+)\r?\n```/);
  if (!block) return { error: "attestation block must contain exactly one JSON line" };
  let a;
  try { a = JSON.parse(block[1]); } catch { return { error: "attestation block is not valid JSON" }; }
  const keys = a && typeof a === "object" ? Object.keys(a) : [];
  if (keys.length !== ATTESTATION_KEYS.length || !ATTESTATION_KEYS.every((k, i) => keys[i] === k)) return { error: "attestation has missing, extra, or unordered keys" };
  if (a.v !== ATTESTATION_VERSION) return { error: `attestation v is not ${ATTESTATION_VERSION}` };
  if (a.pr !== prNumber) return { error: "attestation pr does not match this PR" };
  if (!/^[0-9a-f]{40}$/.test(a.headSha) || !/^[0-9a-f]{40}$/.test(a.baseSha)) return { error: "attestation sha is not 40 lowercase hex" };
  if (!/^[0-9a-f]{64}$/.test(a.bodyDigest) || !/^[0-9a-f]{64}$/.test(a.labelDigest)) return { error: "attestation digest is not 64 lowercase hex" };
  return { attestation: a };
}
export function selectLatestReviewerApproval(reviews) {
  const eligible = (reviews ?? []).filter((r) => r && r.user?.login === REVIEWER_LOGIN && r.state === "APPROVED" && Number.isFinite(Date.parse(r.submitted_at)) && Number.isFinite(r.id));
  eligible.sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id);
  return eligible[0] ?? null;
}
export function isSnapshotMutatingEvent(action, changes) {
  if (action === "edited") return Boolean(changes && (changes.body || changes.base));
  return MUTATING_EVENTS.has(action);
}
export function parseMergeGroupPrNumbers(headRef) {
  return [...String(headRef ?? "").matchAll(/pr-(\d+)-/g)].map((m) => Number(m[1]));
}
function planSection(planText, title) {
  const out = [];
  let inside = false;
  for (const line of String(planText).split("\n")) {
    if (new RegExp(`^#{2,3}\\s+${title}\\s*$`).test(line)) { inside = true; continue; }
    if (inside && /^#{1,3}\s+\S/.test(line)) break;
    if (inside) out.push(line);
  }
  return out;
}
export function parseAllowlist(planText) {
  return planSection(planText, "Files to touch").map((l) => l.match(/^\s*[-*]\s+`?([^`\s]+)`?\s*$/)?.[1]).filter(Boolean);
}
export function parseRiskTier(planText) {
  for (const line of String(planText).split("\n")) {
    const inline = line.match(/risk tier\s*[:—-]\s*`?(low|standard|high|critical)`?/i);
    if (inline) return inline[1].toLowerCase();
  }
  for (const line of planSection(planText, "Risk tier")) {
    const v = line.match(/^\s*(?:[-*]\s+)?`?(low|standard|high|critical)`?\s*$/i);
    if (v) return v[1].toLowerCase();
  }
  return null;
}
export function parseAcceptanceCriteria(planText) {
  return planSection(planText, "Acceptance criteria").map((l) => l.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/)).filter(Boolean).map((m) => ({ checked: m[1].toLowerCase() === "x", text: m[2] }));
}
export function matchesAllowlist(file, allowlist) {
  for (const pattern of allowlist) {
    if (pattern === file) return true;
    if (pattern.endsWith("/**") && file.startsWith(pattern.slice(0, -2))) return true;
    if (pattern.endsWith("/*") && file.startsWith(pattern.slice(0, -1)) && !file.slice(pattern.length - 1).includes("/")) return true;
    if (pattern.endsWith("*") && file.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}
export function evaluatePolicy({ body, labels, files, draft }) {
  invariant(typeof body === "string" && Array.isArray(labels) && labels.every((l) => typeof l === "string"), "unexpected policy input");
  invariant(Array.isArray(files) && files.every((f) => typeof f?.filename === "string" && Number.isInteger(f.additions) && f.additions >= 0 && Number.isInteger(f.deletions) && f.deletions >= 0), "unexpected Files API response");
  const failures = [];
  const has = (l) => labels.includes(l);
  if (SECRET_PATTERNS.some((p) => p.test(body))) failures.push("plan body contains credential material");
  if (!has("auto-revert")) {
    const allowlist = parseAllowlist(body);
    if (!parseRiskTier(body)) failures.push("plan has no parseable risk tier");
    if (allowlist.length === 0) failures.push('plan has no "Files to touch" entries');
    for (const f of files) if (!matchesAllowlist(f.filename, allowlist)) failures.push(`out-of-scope file: ${f.filename}`);
    if (!draft) {
      const criteria = parseAcceptanceCriteria(body);
      if (criteria.length === 0) failures.push("plan has no acceptance criteria");
      for (const c of criteria) if (!c.checked) failures.push(`unticked criterion: ${c.text}`);
    }
  }
  if (files.some((f) => FORBIDDEN_PATHS.some((p) => p.test(f.filename))) && !has("forbidden-path-approved")) failures.push("forbidden path changed without forbidden-path-approved");
  if (!has("large-change-approved")) {
    const tier = parseRiskTier(body) ?? "critical";
    const effective = files.some((f) => [...FORBIDDEN_PATHS, ...POLICY_PATHS].some((p) => p.test(f.filename))) ? "critical" : tier;
    const [codeCap, fileCap] = RISK_CAPS[effective];
    const loc = files.filter((f) => !DOC_EXT.has(f.filename.slice(f.filename.lastIndexOf(".")))).reduce((n, f) => n + f.additions + f.deletions, 0);
    if (files.length > fileCap) failures.push(`${files.length} files exceed ${effective} cap of ${fileCap}`);
    if (loc > codeCap) failures.push(`${loc} non-doc LOC exceed ${effective} cap of ${codeCap}`);
  }
  return failures;
}
export function decide({ action, changes, eventUpdatedAt, pr, reviews, files, filesTruncated }) {
  invariant(Array.isArray(reviews) && reviews.every((r) => r && Number.isSafeInteger(r.id) && typeof r.user?.login === "string" && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(r.state) && (r.body === null || typeof r.body === "string") && (r.submitted_at === null || Number.isFinite(Date.parse(r.submitted_at))) && typeof r.commit_id === "string") && typeof filesTruncated === "boolean" && (!action || (["opened", "edited", ...MUTATING_EVENTS].includes(action) && Number.isFinite(Date.parse(eventUpdatedAt)) && (changes === null || typeof changes === "object"))), "unexpected live API state");
  const failures = [];
  const writes = { dismissReviewIds: [], disableAutoMerge: false, dequeue: false };
  const snapshot = computeSnapshot(pr);
  const payload = buildAttestationPayload(pr.number, snapshot);
  if (pr.state !== "open") return { pass: true, noop: true, snapshot, payload, failures, writes };
  const labelNames = (pr.labels ?? []).map((l) => l.name);
  if (pr.draft) failures.push("PR is draft");
  if (snapshot.bodyNull) failures.push("PR body is null");
  if (filesTruncated) failures.push("API pagination truncated (3000-file cap or review truncation)");
  if (labelNames.includes("halt-agents")) failures.push("halt-agents label present");
  if (labelNames.includes("force-merge")) failures.push("force-merge label present");
  const approval = selectLatestReviewerApproval(reviews);
  if (!approval) {
    failures.push("no non-dismissed beepto-codex APPROVED review");
  } else {
    const parsed = parseAttestation(approval.body, pr.number);
    if (parsed.error) {
      failures.push(parsed.error);
    } else {
      for (const k of ["headSha", "baseSha", "bodyDigest", "labelDigest"]) if (parsed.attestation[k] !== snapshot[k]) failures.push(`attested ${k} does not match live value`);
      if (approval.commit_id !== pr.head.sha || approval.commit_id !== parsed.attestation.headSha) failures.push("review commit_id disagrees with head sha or attested headSha");
    }
  }
  failures.push(...evaluatePolicy({ body: pr.body ?? "", labels: labelNames, files, draft: pr.draft }));
  const eventApprovals = reviews.filter((r) => r?.user?.login === REVIEWER_LOGIN && r.state === "APPROVED" && Number.isFinite(r.id) && Date.parse(r.submitted_at) <= Date.parse(eventUpdatedAt));
  if (eventApprovals.length > 0 && isSnapshotMutatingEvent(action, changes)) {
    writes.dismissReviewIds = eventApprovals.map((r) => r.id);
    writes.disableAutoMerge = Boolean(pr.auto_merge);
    writes.dequeue = true;
  }
  return { pass: failures.length === 0, noop: false, snapshot, payload, failures, writes };
}
export async function api(path, { method = "GET", body } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (res.status === 429 || res.status >= 500) { last = new Error(`${method} ${path} -> ${res.status}`); continue; }
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
      const json = await res.json();
      if (json && Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`${method} ${path} graphql error: ${json.errors[0].message}`);
      return json;
    } catch (err) { if (attempt === 2) throw err; last = err; }
  }
  throw last;
}
async function apiAll(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`unexpected non-array response for ${path}`);
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
    if (items.length >= 3000) return { items, truncated: true };
  }
}
async function graphql(query, variables, field) {
  const json = await api("/graphql", { method: "POST", body: { query, variables } });
  invariant(json?.data && Object.hasOwn(json.data, field) && json.data[field] !== null, `unexpected GraphQL ${field} response`);
  return json.data[field];
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error("missing GITHUB_REPOSITORY or GITHUB_TOKEN");
  let prNumbers;
  let action = null;
  let changes = null;
  let eventUpdatedAt = null;
  if (eventName === "pull_request_target") { prNumbers = [event.pull_request?.number]; action = event.action; changes = event.changes; eventUpdatedAt = event.pull_request?.updated_at; } else if (eventName === "merge_group") {
    prNumbers = parseMergeGroupPrNumbers(event.merge_group?.head_ref);
    if (prNumbers.length === 0) throw new Error("no pr-<N>- segments in merge_group.head_ref");
  } else {
    throw new Error(`unsupported event ${eventName}`);
  }
  if (prNumbers.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("unresolvable PR number");
  const summary = [];
  let failed = false;
  const pending = [];
  for (const n of prNumbers) {
    const pr = await api(`/repos/${repo}/pulls/${n}`);
    const files = await apiAll(`/repos/${repo}/pulls/${n}/files`);
    const reviews = await apiAll(`/repos/${repo}/pulls/${n}/reviews`);
    const verdict = decide({ action, changes, eventUpdatedAt, pr, reviews: reviews.items, files: files.items.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })), filesTruncated: files.truncated || reviews.truncated });
    summary.push(`### PR #${n} (event ${eventName}${action ? `/${action}` : ""})`, `- rsi/v1 payload: \`${verdict.payload}\``, `- headSha: ${verdict.snapshot.headSha}`, `- baseSha: ${verdict.snapshot.baseSha}`, `- bodyDigest: ${verdict.snapshot.bodyDigest}`, `- labelDigest: ${verdict.snapshot.labelDigest}`, `- verdict: ${verdict.pass ? "pass" : `FAIL: ${verdict.failures.join("; ")}`}`);
    if (!verdict.pass) failed = true;
    if (!verdict.noop) pending.push({ n, pr, writes: verdict.writes });
  }
  for (const { n, pr, writes } of pending) {
    const errors = [];
    for (const id of writes.dismissReviewIds) { try { await api(`/repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, { method: "PUT", body: { message: `Review snapshot changed (${action}); approval dismissed by Review Snapshot Integrity.` } }); } catch (e) { errors.push(e.message); } }
    if (writes.disableAutoMerge) {
      try { await graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}", { id: pr.node_id }, "disablePullRequestAutoMerge"); } catch (e) { errors.push(e.message); }
    }
    if (writes.dequeue) {
      try {
        const node = await graphql("query($id:ID!){node(id:$id){...on PullRequest{mergeQueueEntry{id}}}}", { id: pr.node_id }, "node");
        invariant(Object.hasOwn(node, "mergeQueueEntry") && (node.mergeQueueEntry === null || (typeof node.mergeQueueEntry === "object" && typeof node.mergeQueueEntry.id === "string")), "unexpected GraphQL mergeQueueEntry response");
        if (node.mergeQueueEntry) await graphql("mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}", { id: pr.node_id }, "dequeuePullRequest");
      } catch (e) { errors.push(e.message); }
    }
    if (errors.length > 0) { failed = true; summary.push(`### PR #${n} enforcement write failures: ${errors.join("; ")}`); }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  console.log(summary.join("\n"));
  if (failed) process.exit(1);
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch((err) => {
  console.error(`review-snapshot-integrity: ${err.message}`); process.exit(1);
});
