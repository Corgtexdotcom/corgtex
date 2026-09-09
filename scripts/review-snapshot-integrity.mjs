import { PROTECTED_PATHS, hasSubstantiveScopeJustification } from "./check-plan.mjs";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
export const REVIEWER_LOGIN = "beepto-codex";
const SECRET_PATTERNS = [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, /-----BEGIN OPENSSH PRIVATE KEY-----/, /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/];
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
export function selectLatestReviewerReview(reviews) {
  const eligible = (reviews ?? []).filter((r) => r && r.user?.login === REVIEWER_LOGIN && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) && Number.isFinite(Date.parse(r.submitted_at)) && Number.isFinite(r.id));
  eligible.sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id);
  return eligible[0] ?? null;
}
export function resolveMergeGroupMembers(mergeGroup, connection, groupSteps) {
  const entries = connection?.nodes;
  const isSha = (value) => /^[0-9a-f]{40}$/.test(value);
  invariant(isSha(mergeGroup?.head_sha) && isSha(mergeGroup?.base_sha) && mergeGroup?.base_ref === "refs/heads/main" && Array.isArray(entries) && entries.length > 0 && entries.length <= 100 && connection.pageInfo?.hasPreviousPage === false && connection.pageInfo?.hasNextPage === false && Array.isArray(groupSteps) && groupSteps.length > 0 && groupSteps.length <= 100 && groupSteps.every((step) => isSha(step?.baseSha) && isSha(step?.headSha) && isSha(step?.prHeadSha)), "missing authoritative merge-group membership");
  invariant(groupSteps[0].baseSha === mergeGroup.base_sha && groupSteps.at(-1).headSha === mergeGroup.head_sha && groupSteps.every((step, index) => index === 0 || step.baseSha === groupSteps[index - 1].headSha) && new Set(groupSteps.map((step) => step.headSha)).size === groupSteps.length, "ambiguous authoritative merge-group membership");
  invariant(entries.every((e) => Number.isSafeInteger(e?.position) && e.position >= 0 && isSha(e.baseCommit?.oid) && isSha(e.headCommit?.oid) && Number.isSafeInteger(e.pullRequest?.number) && e.pullRequest.number > 0 && e.pullRequest.state === "OPEN" && isSha(e.pullRequest.headRefOid) && isSha(e.pullRequest.baseRefOid)) && new Set(entries.map((e) => e.position)).size === entries.length && new Set(entries.map((e) => e.headCommit.oid)).size === entries.length && new Set(entries.map((e) => e.pullRequest.number)).size === entries.length, "ambiguous authoritative merge-group membership");
  const members = groupSteps.map((step) => entries.filter((entry) => entry.baseCommit.oid === step.baseSha && entry.headCommit.oid === step.headSha && entry.pullRequest.headRefOid === step.prHeadSha && entry.pullRequest.baseRefOid === mergeGroup.base_sha));
  invariant(members.every((matches) => matches.length === 1) && members.every((matches, index) => index === 0 || matches[0].position > members[index - 1][0].position), "ambiguous authoritative merge-group membership");
  const resolved = members.map(([entry]) => ({ number: entry.pullRequest.number, headSha: entry.pullRequest.headRefOid }));
  return resolved;
}
export function resolveMergeGroupPrNumbers(mergeGroup, connection, groupSteps) { return resolveMergeGroupMembers(mergeGroup, connection, groupSteps).map((member) => member.number); }
function planSection(planText, title) {
  const out = [];
  let inside = false;
  for (const line of String(planText).split("\n")) {
    if (new RegExp(`^#{2,3}\\s+${title}\\s*$`, "i").test(line)) { inside = true; continue; }
    if (inside && /^#{1,3}\s+\S/.test(line)) break;
    if (inside) out.push(line);
  }
  return out;
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
export function evaluatePolicy({ body, labels, files, draft }) {
  invariant(typeof body === "string" && Array.isArray(labels) && labels.every((l) => typeof l === "string"), "unexpected policy input");
  invariant(Array.isArray(files) && files.every((f) => typeof f?.filename === "string" && Number.isInteger(f.additions) && f.additions >= 0 && Number.isInteger(f.deletions) && f.deletions >= 0), "unexpected Files API response");
  const failures = [];
  const has = (l) => labels.includes(l);
  if (SECRET_PATTERNS.some((p) => p.test(body))) failures.push("plan body contains credential material");
  if (!has("auto-revert")) {
    const tier = parseRiskTier(body);
    if (!tier) failures.push("plan has no parseable risk tier");
    for (const title of ["Outcome", "Test plan", "Risk and rollback"]) {
      if (!planSection(body, title).join("\n").trim()) failures.push(`plan has no "${title}" section`);
    }
    const protectedFiles = files.filter((file) => PROTECTED_PATHS.some((pattern) => pattern.test(file.filename) || (typeof file.previous_filename === "string" && pattern.test(file.previous_filename))));
    if (protectedFiles.length > 0) {
      if (tier !== "critical") failures.push("protected paths require critical risk");
      if (!hasSubstantiveScopeJustification(body)) failures.push('protected paths require a substantive "Scope" justification');
    }
    if (!draft) {
      const criteria = parseAcceptanceCriteria(body);
      if (criteria.length === 0) failures.push("plan has no acceptance criteria");
      for (const c of criteria) if (!c.checked) failures.push(`unticked criterion: ${c.text}`);
    }
  }
  return failures;
}
export function decide({ pr, reviews, files, filesTruncated }) {
  invariant(Array.isArray(reviews) && reviews.every((r) => r && Number.isSafeInteger(r.id) && typeof r.user?.login === "string" && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(r.state) && (r.body === null || typeof r.body === "string") && (r.submitted_at === null || Number.isFinite(Date.parse(r.submitted_at))) && typeof r.commit_id === "string") && typeof filesTruncated === "boolean", "unexpected live API state");
  const failures = [];
  const snapshot = computeSnapshot(pr);
  if (pr.state !== "open") return { pass: true, noop: true, snapshot, failures };
  const labelNames = pr.labels.map((label) => label.name);
  if (pr.draft) failures.push("PR is draft");
  if (snapshot.bodyNull) failures.push("PR body is null");
  if (filesTruncated) failures.push("API pagination truncated (3000-file cap or review truncation)");
  for (const label of ["halt-agents", "needs-replan", "force-merge"]) {
    if (labelNames.includes(label)) failures.push(`${label} label present`);
  }
  const review = selectLatestReviewerReview(reviews);
  if (review?.state !== "APPROVED") failures.push("no non-dismissed beepto-codex APPROVED review");
  else if (review.commit_id !== pr.head.sha) failures.push("review commit_id disagrees with current head sha");
  failures.push(...evaluatePolicy({ body: pr.body ?? "", labels: labelNames, files, draft: pr.draft }));
  return { pass: failures.length === 0, noop: false, snapshot, failures };
}
export async function api(path, { method = "GET", body, timeoutMs = 10_000, attempts = 3 } = {}) {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 3, "unexpected API retry configuration");
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(`https://api.github.com${path}`, { method, signal, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (err) { if (attempt === attempts - 1) throw err; last = err; continue; }
    if (res.status === 429 || res.status >= 500) {
      last = new Error(`${method} ${path} -> ${res.status}`);
      if (attempt === attempts - 1) throw last;
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
export function validateMergeGroupEvent(event, repo, runSha) {
  const group = event?.merge_group;
  invariant(event?.action === "checks_requested", "unsupported merge_group action");
  invariant(event?.repository?.full_name === repo && repo.split("/").length === 2, "unexpected event repository");
  invariant(/^[0-9a-f]{40}$/.test(group?.head_sha) && /^[0-9a-f]{40}$/.test(group?.base_sha) && group.head_sha !== group.base_sha, "unexpected merge_group sha");
  invariant(group.base_ref === "refs/heads/main" && /^refs\/heads\/gh-readonly-queue\/main\/.+/.test(group.head_ref), "unexpected merge_group refs");
  invariant(runSha === group.head_sha, "workflow run sha disagrees with merge_group head");
  return group;
}
async function evaluatePullRequest(repo, number) {
  const pr = await api(`/repos/${repo}/pulls/${number}`);
  const files = await apiAll(`/repos/${repo}/pulls/${number}/files`);
  const reviews = await apiAll(`/repos/${repo}/pulls/${number}/reviews`);
  const verdict = decide({ pr, reviews: reviews.items, files: files.items.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, additions: f.additions, deletions: f.deletions })), filesTruncated: files.truncated || reviews.truncated });
  return { pr, verdict, reviewerReview: selectLatestReviewerReview(reviews.items) };
}
async function readMergeGroupMembers(repo, group) {
  const [owner, name] = repo.split("/");
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [repository, groupSteps] = await Promise.all([
        graphql("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:\"main\"){entries(first:100){nodes{position baseCommit{oid} headCommit{oid} pullRequest{number state headRefOid baseRefOid}}pageInfo{hasPreviousPage hasNextPage}}}}}", { owner, name }, "repository"),
        readMergeGroupSteps(repo, group),
      ]);
      return resolveMergeGroupMembers(group, repository?.mergeQueue?.entries, groupSteps);
    }
    catch (err) {
      if (!/authoritative merge-group membership/.test(err.message) || attempt === 2) throw err;
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw last;
}
async function readMergeGroupSteps(repo, group) {
  const reversed = [];
  let current = group.head_sha;
  for (let depth = 0; depth < 100; depth++) {
    const commit = await api(`/repos/${repo}/git/commits/${current}`);
    invariant(commit?.sha === current && Array.isArray(commit.parents) && commit.parents.length === 2 && commit.parents.every((parent) => /^[0-9a-f]{40}$/.test(parent?.sha)), "missing authoritative merge-group membership");
    reversed.push({ baseSha: commit.parents[0].sha, headSha: current, prHeadSha: commit.parents[1].sha });
    current = commit.parents[0].sha;
    if (current === group.base_sha) return reversed.reverse();
    invariant(!reversed.some((step) => step.headSha === current), "ambiguous authoritative merge-group membership");
  }
  throw new Error("missing authoritative merge-group membership");
}
export async function evaluateMergeGroup(repo, event, runSha) {
  const group = validateMergeGroupEvent(event, repo, runSha);
  const members = await readMergeGroupMembers(repo, group);
  const prNumbers = members.map((member) => member.number);
  const summary = [];
  const snapshots = [];
  let failed = false;
  for (const { number, headSha } of members) {
    const { pr, verdict } = await evaluatePullRequest(repo, number);
    invariant(pr.number === number && pr.state === "open" && pr.head?.sha === headSha && pr.base?.sha === group.base_sha && pr.base?.ref === "main" && pr.base?.repo?.full_name === repo && typeof pr.head?.repo?.full_name === "string" && Number.isFinite(Date.parse(pr.updated_at)), "unexpected merge-group PR state");
    summary.push(`### PR #${number} (event merge_group/checks_requested)`, `- verdict: ${verdict.pass ? "pass" : `FAIL (${verdict.failures.length} reason(s))`}`);
    snapshots.push(JSON.stringify(verdict.snapshot));
    if (!verdict.pass) failed = true;
  }
  if (!failed) {
    const [latestMembers, ...latestEvaluations] = await Promise.all([readMergeGroupMembers(repo, group), ...members.map(({ number }) => evaluatePullRequest(repo, number))]);
    invariant(JSON.stringify(latestMembers) === JSON.stringify(members), "merge-group membership drifted before success");
    const finalStates = await readMergeGroupFinalStates(repo, members);
    for (const [index, latest] of latestEvaluations.entries()) {
      const final = finalStates[index];
      invariant(final.number === members[index].number && final.state === "OPEN" && final.isDraft === latest.pr.draft && final.headRefOid === members[index].headSha && final.baseRefOid === group.base_sha && latest.pr.head?.sha === members[index].headSha && latest.pr.base?.sha === group.base_sha && JSON.stringify(final.snapshot) === JSON.stringify(latest.verdict.snapshot) && JSON.stringify(final.reviewerReview) === JSON.stringify(reviewIdentity(latest.reviewerReview)) && latest.verdict.pass && !latest.verdict.noop && JSON.stringify(latest.verdict.snapshot) === snapshots[index], "merge-group PR snapshot drifted before success");
    }
  }
  return { failed, prNumbers, summary };
}
function reviewIdentity(review) {
  return review ? { id: String(review.id), state: review.state, submittedAt: review.submitted_at, body: review.body, commitOid: review.commit_id, author: review.user.login } : null;
}
async function readMergeGroupFinalStates(repo, members) {
  const [owner, name] = repo.split("/");
  const selections = members.map(({ number }, index) => `p${index}:pullRequest(number:${number}){number state isDraft body headRefOid baseRefOid labels(first:100){nodes{name}pageInfo{hasPreviousPage hasNextPage}}reviews(last:100,author:"${REVIEWER_LOGIN}",states:[APPROVED,CHANGES_REQUESTED,DISMISSED]){nodes{fullDatabaseId state submittedAt body commit{oid}author{login}}pageInfo{hasPreviousPage hasNextPage}}}`).join(" ");
  const repository = await graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${selections}}}`, { owner, name }, "repository");
  return members.map((_, index) => {
    const state = repository?.[`p${index}`];
    invariant(Number.isSafeInteger(state?.number) && typeof state.state === "string" && typeof state.isDraft === "boolean" && typeof state.body === "string" && /^[0-9a-f]{40}$/.test(state.headRefOid) && /^[0-9a-f]{40}$/.test(state.baseRefOid) && Array.isArray(state.labels?.nodes) && state.labels.nodes.every((label) => typeof label?.name === "string") && state.labels.pageInfo?.hasPreviousPage === false && state.labels.pageInfo?.hasNextPage === false && Array.isArray(state.reviews?.nodes) && state.reviews.nodes.every((review) => /^\d+$/.test(review?.fullDatabaseId) && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state) && Number.isFinite(Date.parse(review.submittedAt)) && typeof review.body === "string" && /^[0-9a-f]{40}$/.test(review.commit?.oid) && review.author?.login === REVIEWER_LOGIN) && state.reviews.pageInfo?.hasPreviousPage === false && state.reviews.pageInfo?.hasNextPage === false, "unexpected final merge-group PR state");
    const reviews = state.reviews.nodes.map((review) => ({ id: Number(review.fullDatabaseId), state: review.state, submitted_at: review.submittedAt, body: review.body, commit_id: review.commit.oid, user: review.author }));
    invariant(reviews.every((review) => Number.isSafeInteger(review.id)), "unexpected final merge-group PR state");
    return { ...state, snapshot: computeSnapshot({ number: state.number, state: state.state.toLowerCase(), draft: state.isDraft, body: state.body, head: { sha: state.headRefOid }, base: { sha: state.baseRefOid }, labels: state.labels.nodes, auto_merge: null }), reviewerReview: reviewIdentity(selectLatestReviewerReview(reviews)) };
  });
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error("missing GITHUB_REPOSITORY or GITHUB_TOKEN");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (eventName !== "merge_group") throw new Error(`unsupported event ${eventName}`);
  const { failed, summary } = await evaluateMergeGroup(repo, event, process.env.GITHUB_SHA);
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`); } catch { summary.push("- step summary write failed"); } }
  console.log(summary.join("\n"));
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch((err) => {
  console.error(`review-snapshot-integrity: ${err.message}`); process.exit(1);
});
