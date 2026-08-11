import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
export const REVIEWER_LOGIN = "beepto-codex";
export const ATTESTATION_VERSION = "rsi/v1";
export const STATUS_CONTEXT = "Review Snapshot Integrity";
export const STATUS_DESCRIPTIONS = {
  pending: "Evaluating review snapshot integrity",
  success: "Review snapshot verified",
  failure: "Review snapshot integrity check failed",
};
const MAX_STATUSES_PER_CONTEXT = 1000;
const STATUS_CREATOR = "github-actions[bot]";
const PUBLISHER_ACTIONS = new Set(["opened", "reopened", "synchronize", "edited", "labeled", "unlabeled", "ready_for_review", "converted_to_draft"]);
const MUTATING_EVENTS = new Set(["labeled", "unlabeled", "synchronize", "ready_for_review", "converted_to_draft", "reopened"]);
const DOC_EXT = new Set([".md", ".mdx"]);
const RISK_CAPS = { low: [1200, 50], standard: [800, 25], high: [700, 15], critical: [400, 15] };
const FORBIDDEN_PATHS = [/^deploy\//, /^\.github\/workflows\//, /^prisma\/migrations\//, /^packages\/domain\/src\/auth.*\.ts$/, /^apps\/web\/lib\/auth\.ts$/];
const POLICY_PATHS = [/^AGENTS\.md$/, /^\.agents\/plan-template\.md$/, /^\.codex\/review\.md$/, /^\.codex\/ops\/.*\.md$/, /^\.github\/pull_request_template\.md$/, /^docs\/contributing\/agent-pipeline\.mdx$/, /^docs\/contributing\/pull-requests\.mdx$/, /^scripts\/check-plan(?:-policy(?:\.test)?)?\.mjs$/, /^scripts\/review-snapshot-integrity\.mjs$/];
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
export function selectLatestReviewerReview(reviews) {
  const eligible = (reviews ?? []).filter((r) => r && r.user?.login === REVIEWER_LOGIN && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) && Number.isFinite(Date.parse(r.submitted_at)) && Number.isFinite(r.id));
  eligible.sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id);
  return eligible[0] ?? null;
}
export function isSnapshotMutatingEvent(action, changes) {
  if (action === "edited") return Boolean(changes && (changes.body || changes.base));
  return MUTATING_EVENTS.has(action);
}
export function resolveMergeGroupPrNumbers(mergeGroup, connection) {
  const entries = connection?.nodes;
  invariant(/^[0-9a-f]{40}$/.test(mergeGroup?.head_sha) && /^refs\/heads\/.+/.test(mergeGroup?.base_ref) && Array.isArray(entries) && entries.length > 0 && connection.pageInfo?.hasPreviousPage === false, "missing authoritative merge-group membership");
  const tail = entries.filter((e) => e?.headCommit?.oid === mergeGroup.head_sha);
  invariant(tail.length === 1, "ambiguous authoritative merge-group membership");
  const members = entries.filter((e) => e?.position <= tail[0].position).sort((a, b) => a.position - b.position);
  const numbers = members.map((e) => e?.pullRequest?.number);
  invariant(members.every((e) => Number.isSafeInteger(e.position) && e.pullRequest?.state === "OPEN") && new Set(members.map((e) => e.position)).size === members.length && numbers.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(numbers).size === numbers.length, "ambiguous authoritative merge-group membership");
  return numbers;
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
export function decide({ action, changes = null, eventUpdatedAt, pr, reviews, files, filesTruncated }) {
  invariant(Array.isArray(reviews) && reviews.every((r) => r && Number.isSafeInteger(r.id) && typeof r.user?.login === "string" && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(r.state) && (r.body === null || typeof r.body === "string") && (r.submitted_at === null || Number.isFinite(Date.parse(r.submitted_at))) && typeof r.commit_id === "string") && typeof filesTruncated === "boolean" && (!action || (["opened", "edited", ...MUTATING_EVENTS].includes(action) && Number.isFinite(Date.parse(eventUpdatedAt)) && (action === "edited" ? changes && typeof changes === "object" : changes === null || typeof changes === "object"))), "unexpected live API state");
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
  const effectiveReview = selectLatestReviewerReview(reviews);
  const approval = effectiveReview?.state === "APPROVED" ? effectiveReview : null;
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
  if (approval && isSnapshotMutatingEvent(action, changes)) {
    const delta = Date.parse(approval.submitted_at) - Date.parse(eventUpdatedAt);
    if (delta === 0) failures.push("approval and snapshot mutation order is ambiguous");
    if (delta < 0) {
      failures.push("approval predates snapshot mutation");
      writes.dismissReviewIds = reviews.filter((r) => r?.user?.login === REVIEWER_LOGIN && r.state === "APPROVED" && Date.parse(r.submitted_at) < Date.parse(eventUpdatedAt)).map((r) => r.id);
      writes.disableAutoMerge = Boolean(pr.auto_merge); writes.dequeue = true;
    }
  }
  return { pass: failures.length === 0, noop: false, snapshot, payload, failures, writes };
}
export async function api(path, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "unexpected API timeout");
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(`https://api.github.com${path}`, { method, signal, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (err) { if (attempt === 2) throw err; last = err; continue; }
    if (res.status === 429 || res.status >= 500) {
      last = new Error(`${method} ${path} -> ${res.status}`);
      if (attempt === 2) throw last;
      const seconds = Number(res.headers?.get?.("retry-after"));
      if (Number.isFinite(seconds) && seconds > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(seconds * 1000, 10_000)));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    const json = await res.json();
    if (json && Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`${method} ${path} graphql error: ${json.errors[0].message}`);
    return json;
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
export function validatePublisherEvent(event, repo) {
  const pr = event?.pull_request;
  invariant(PUBLISHER_ACTIONS.has(event?.action), "unsupported pull_request_target action");
  invariant(event?.repository?.full_name === repo, "unexpected event repository");
  invariant(pr && Number.isSafeInteger(pr.number) && pr.number > 0, "unexpected pull_request event");
  invariant(/^[0-9a-f]{40}$/.test(pr.head?.sha) && /^[0-9a-f]{40}$/.test(pr.base?.sha), "unexpected event sha");
  invariant(pr.base?.ref === "main", "unexpected event base ref");
  invariant(pr.base?.repo?.full_name === repo, "unexpected event base repository");
  invariant(typeof pr.head?.repo?.full_name === "string" && pr.head.repo.full_name.length > 0, "unexpected event head repository");
  invariant(Number.isFinite(Date.parse(pr.updated_at)), "unexpected event updated_at");
  return pr;
}
export async function postStatus(repo, sha, state) {
  invariant(/^[0-9a-f]{40}$/.test(sha) && Object.hasOwn(STATUS_DESCRIPTIONS, state), "unexpected status write");
  const created = await api(`/repos/${repo}/statuses/${sha}`, { method: "POST", body: { state, context: STATUS_CONTEXT, description: STATUS_DESCRIPTIONS[state] } });
  invariant(Number.isSafeInteger(created?.id) && created.state === state && created.context === STATUS_CONTEXT && created.creator?.login === STATUS_CREATOR, "unexpected status write response");
  return created;
}
async function contextStatuses(repo, sha) {
  const { items, truncated } = await apiAll(`/repos/${repo}/commits/${sha}/statuses`);
  invariant(!truncated, "status pagination truncated");
  invariant(items.every((s) => s && typeof s.context === "string" && ["pending", "success", "failure", "error"].includes(s.state) && Number.isSafeInteger(s.id) && typeof s.creator?.login === "string"), "unexpected status readback schema");
  return items.filter((s) => s.context === STATUS_CONTEXT);
}
export async function confirmStatus(repo, sha, expected) {
  const ours = await contextStatuses(repo, sha);
  invariant(ours.length <= MAX_STATUSES_PER_CONTEXT, "status count ceiling reached");
  const written = ours.find((status) => status.id === expected.id);
  invariant(written?.state === expected.state && written.creator.login === STATUS_CREATOR, `unconfirmed ${expected.state} status write`);
}
export async function printAttestation(repo, prNumber) {
  const pr = await api(`/repos/${repo}/pulls/${prNumber}`);
  console.log(buildAttestationPayload(pr.number, computeSnapshot(pr)));
}
async function evaluatePullRequest(repo, number, action, changes, eventUpdatedAt) {
  const pr = await api(`/repos/${repo}/pulls/${number}`);
  const files = await apiAll(`/repos/${repo}/pulls/${number}/files`);
  const reviews = await apiAll(`/repos/${repo}/pulls/${number}/reviews`);
  const verdict = decide({ action, changes, eventUpdatedAt, pr, reviews: reviews.items, files: files.items.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })), filesTruncated: files.truncated || reviews.truncated });
  return { pr, verdict };
}
async function applyEnforcement(repo, number, pr, writes, action) {
  const errors = [];
  for (const id of writes.dismissReviewIds) { try { await api(`/repos/${repo}/pulls/${number}/reviews/${id}/dismissals`, { method: "PUT", body: { message: `Review snapshot changed (${action}); approval dismissed by Review Snapshot Integrity.` } }); } catch (e) { errors.push(e.message); } }
  if (writes.disableAutoMerge) { try { await graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}", { id: pr.node_id }, "disablePullRequestAutoMerge"); } catch (e) { errors.push(e.message); } }
  if (writes.dequeue) { try {
    const node = await graphql("query($id:ID!){node(id:$id){...on PullRequest{mergeQueueEntry{id}}}}", { id: pr.node_id }, "node");
    invariant(Object.hasOwn(node, "mergeQueueEntry") && (node.mergeQueueEntry === null || typeof node.mergeQueueEntry?.id === "string"), "unexpected GraphQL mergeQueueEntry response");
    if (node.mergeQueueEntry) await graphql("mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}", { id: pr.node_id }, "dequeuePullRequest");
  } catch (e) { errors.push(e.message); } }
  invariant(errors.length === 0, `enforcement write failure: ${errors.join("; ")}`);
}
export async function publishPullRequestStatus(repo, event) {
  const eventPr = validatePublisherEvent(event, repo);
  const sha = eventPr.head.sha;
  const summary = [];
  let state = "failure";
  try {
    invariant((await contextStatuses(repo, sha)).length <= MAX_STATUSES_PER_CONTEXT - 3, "status count ceiling reserve reached");
    const pending = await postStatus(repo, sha, "pending");
    await confirmStatus(repo, sha, pending);
    const { pr, verdict } = await evaluatePullRequest(repo, eventPr.number, event.action, event.changes ?? null, eventPr.updated_at);
    summary.push(`### PR #${eventPr.number} (event pull_request_target/${event.action})`, `- rsi/v1 payload: \`${verdict.payload}\``, `- headSha: ${verdict.snapshot.headSha}`, `- baseSha: ${verdict.snapshot.baseSha}`, `- bodyDigest: ${verdict.snapshot.bodyDigest}`, `- labelDigest: ${verdict.snapshot.labelDigest}`, `- verdict: ${verdict.pass ? "pass" : `FAIL (${verdict.failures.length} reason(s))`}`);
    invariant(pr.head.sha === sha, "event head is no longer current");
    const beforeWrites = await api(`/repos/${repo}/pulls/${eventPr.number}`);
    invariant(JSON.stringify(computeSnapshot(beforeWrites)) === JSON.stringify(verdict.snapshot), "snapshot drifted before enforcement");
    await applyEnforcement(repo, eventPr.number, pr, verdict.writes, event.action);
    if (verdict.pass && !verdict.noop) {
      const refetch = await api(`/repos/${repo}/pulls/${eventPr.number}`);
      invariant(JSON.stringify(computeSnapshot(refetch)) === JSON.stringify(verdict.snapshot), "snapshot drifted before success write");
      const success = await postStatus(repo, sha, "success");
      await confirmStatus(repo, sha, success);
      state = "success";
    }
  } catch (err) {
    summary.push(`- publisher error: ${err.message}`);
  }
  if (state !== "success") {
    try {
      const failure = await postStatus(repo, sha, "failure");
      await confirmStatus(repo, sha, failure);
    } catch (err) {
      summary.push(`- failure status write error: ${err.message}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  console.log(summary.join("\n"));
  if (state !== "success") process.exitCode = 1;
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error("missing GITHUB_REPOSITORY or GITHUB_TOKEN");
  if (process.argv[2] === "--attest") {
    const prNumber = Number(process.argv[3]);
    invariant(Number.isSafeInteger(prNumber) && prNumber > 0, "unexpected --attest PR number");
    return printAttestation(repo, prNumber);
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (eventName === "pull_request_target") return publishPullRequestStatus(repo, event);
  if (eventName !== "merge_group") throw new Error(`unsupported event ${eventName}`);
  const action = null;
  const changes = null;
  const eventUpdatedAt = null;
  const [owner, name] = repo.split("/");
  const repository = await graphql("query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){entries(first:100){nodes{position headCommit{oid} pullRequest{number state}}pageInfo{hasPreviousPage hasNextPage}}}}}", { owner, name, branch: String(event.merge_group?.base_ref ?? "").replace(/^refs\/heads\//, "") }, "repository");
  const prNumbers = resolveMergeGroupPrNumbers(event.merge_group, repository?.mergeQueue?.entries);
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
    try { await applyEnforcement(repo, n, pr, writes, action); } catch (e) { failed = true; summary.push(`### PR #${n} enforcement write failure`); }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  console.log(summary.join("\n"));
  if (failed) process.exit(1);
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch((err) => {
  console.error(`review-snapshot-integrity: ${err.message}`); process.exit(1);
});
