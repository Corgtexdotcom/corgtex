import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { api, buildAttestationPayload, computeSnapshot, confirmStatus, decide, encodeLabelSet, evaluateMergeGroup, evaluatePolicy, isSnapshotMutatingEvent, matchesAllowlist, parseAttestation, postStatus, publishPullRequestStatus, resolveMergeGroupMembers, resolveMergeGroupPrNumbers, selectLatestReviewerReview, sha256Bytes, STATUS_CONTEXT, validateMergeGroupEvent, validatePublisherEvent } from "./review-snapshot-integrity.mjs";
const PLAN = "## Risk tier\n\n- `low`\n\n## Files to touch\n\n- `scripts/x.mjs`\n\n## Acceptance criteria\n\n- [x] done\n";
const FILES = [{ filename: "scripts/x.mjs", additions: 1, deletions: 1 }];
const makePr = (over = {}) => ({ number: 7, state: "open", draft: false, body: PLAN, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) }, labels: [{ name: "ok" }], auto_merge: null, ...over });
const approvalFor = (pr, over = {}) => ({ id: 1, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", commit_id: pr.head.sha, user: { login: "beepto-codex" }, body: `looks good\n\`\`\`review-snapshot-attestation\n${buildAttestationPayload(pr.number, computeSnapshot(pr))}\n\`\`\``, ...over });
const state = (over = {}, prOver = {}) => { const pr = makePr(prOver); return { action: "opened", eventUpdatedAt: "2026-01-02T00:00:00Z", pr, reviews: [approvalFor(pr)], files: FILES, filesTruncated: false, ...over }; };

describe("review snapshot integrity", () => {
  it("hashes exact body bytes; CRLF/whitespace/newline variants differ", () => {
    expect(computeSnapshot(makePr()).bodyDigest).toBe(createHash("sha256").update(PLAN, "utf8").digest("hex"));
    const ds = ["a", "a\r\n", "a\n", " a", "a "].map((b) => computeSnapshot(makePr({ body: b })).bodyDigest);
    expect(new Set(ds).size).toBe(5);
    expect(decide(state({}, { body: null })).pass).toBe(false);
  });
  it("label digest preserves case, byte order, duplicates; empty set is the zero-count constant", () => {
    const d = (names) => sha256Bytes(encodeLabelSet(names));
    expect(d(["Ab"])).not.toBe(d(["ab"]));
    expect(encodeLabelSet(["a", "B"])[8]).toBe(66);
    expect(d(["a", "a"])).not.toBe(d(["a"]));
    expect(Buffer.compare(encodeLabelSet(["ab", "c"]), encodeLabelSet(["a", "bc"]))).not.toBe(0);
    expect(d([])).toBe(sha256Bytes(Buffer.alloc(4)));
  });
  it("parseAttestation accepts one valid block and rejects every malformed variant", () => {
    const good = buildAttestationPayload(7, computeSnapshot(makePr()));
    const wrap = (p) => `\`\`\`review-snapshot-attestation\n${p}\n\`\`\``;
    const mod = (fn) => { const a = JSON.parse(good); fn(a); return wrap(JSON.stringify(a)); };
    expect(parseAttestation(wrap(good), 7).attestation.pr).toBe(7);
    expect(parseAttestation("no block", 7).error).toMatch("exactly one");
    expect(parseAttestation(wrap(good) + "```review-snapshot-attestation\n{}\nextra\n```", 7).error).toMatch("exactly one");
    expect(parseAttestation(wrap("{"), 7).error).toMatch("not valid JSON");
    expect(parseAttestation(mod((a) => { a.v = "rsi/v0"; }), 7).error).toMatch("v is not");
    expect(parseAttestation(mod((a) => { delete a.pr; }), 7).error).toMatch("keys");
    expect(parseAttestation(mod((a) => { a.extra = 1; }), 7).error).toMatch("keys");
    expect(parseAttestation(mod((a) => { a.headSha = "abc"; }), 7).error).toMatch("40");
    expect(parseAttestation(mod((a) => { a.bodyDigest = "zz"; }), 7).error).toMatch("64");
    expect(parseAttestation(mod((a) => { a.labelDigest = "g".repeat(64); }), 7).error).toMatch("64");
    expect(parseAttestation(mod((a) => { a.pr = 8; }), 7).error).toMatch("pr does not match");
    expect(parseAttestation(wrap(good.replace('{"v":"rsi/v1","pr":7', '{"pr":7,"v":"rsi/v1"')), 7).error).toMatch("unordered");
  });
  it("passes on a matching attestation; any field or commit_id mismatch fails", () => {
    expect(decide(state()).pass).toBe(true);
    const reviews = [approvalFor(makePr())];
    const run = (prOver, rev = reviews) => decide({ action: "opened", changes: null, eventUpdatedAt: "2026-01-02T00:00:00Z", pr: makePr(prOver), reviews: rev, files: FILES, filesTruncated: false });
    expect(run({ head: { sha: "c".repeat(40) } }).pass).toBe(false);
    expect(run({ base: { sha: "c".repeat(40) } }).pass).toBe(false);
    expect(run({ body: `${PLAN}x` }).pass).toBe(false);
    expect(run({ labels: [{ name: "ok" }, { name: "new" }] }).pass).toBe(false);
    expect(run({}, [approvalFor(makePr(), { commit_id: "d".repeat(40) })]).pass).toBe(false);
  });
  it("uses the reviewer's latest decisive state by submitted_at then id", () => {
    expect(selectLatestReviewerReview([approvalFor(makePr(), { user: { login: "puncar-dev" } })])).toBeNull();
    expect(selectLatestReviewerReview([approvalFor(makePr(), { id: 1 }), approvalFor(makePr(), { id: 2 })]).id).toBe(2);
    expect(selectLatestReviewerReview([approvalFor(makePr(), { id: 9, submitted_at: "2025-01-01T00:00:00Z" }), approvalFor(makePr(), { id: 1 })]).id).toBe(1);
    expect(decide(state({ reviews: [approvalFor(makePr()), approvalFor(makePr(), { id: 2, state: "CHANGES_REQUESTED" })] })).pass).toBe(false);
    expect(decide(state({ reviews: [approvalFor(makePr(), { state: "CHANGES_REQUESTED" }), approvalFor(makePr(), { id: 2 })] })).pass).toBe(true);
    expect(decide(state({ reviews: [approvalFor(makePr(), { user: { login: "puncar-dev" } })] })).pass).toBe(false);
  });
  it("classifies snapshot-mutating events including title-only edited", () => {
    for (const e of ["opened", "reopened", "labeled", "unlabeled", "synchronize", "ready_for_review", "converted_to_draft"]) { expect(() => decide(state({ action: e }))).not.toThrow(); expect(isSnapshotMutatingEvent(e, null)).toBe(e !== "opened"); }
    expect(isSnapshotMutatingEvent("edited", { body: {} })).toBe(true);
    expect(isSnapshotMutatingEvent("edited", { base: {} })).toBe(true);
    expect(isSnapshotMutatingEvent("edited", { title: {} })).toBe(false);
    expect(() => decide(state({ action: "edited" }))).toThrow("unexpected live API state");
  });
  it("mutating events dismiss every beepto-codex approval, disable auto-merge, dequeue, and fail; title-only does not", () => {
    const reviews = [approvalFor(makePr()), approvalFor(makePr(), { id: 2, submitted_at: "2026-01-02T00:00:00Z" })];
    const pr = makePr({ labels: [{ name: "ok" }, { name: "x" }], auto_merge: { merge_method: "squash" } });
    const v = decide({ action: "labeled", changes: null, eventUpdatedAt: "2026-01-03T00:00:00Z", pr, reviews, files: FILES, filesTruncated: false });
    expect(v.pass).toBe(false);
    expect(v.writes).toEqual({ dismissReviewIds: [1, 2], disableAutoMerge: true, dequeue: true });
    const v2 = decide({ action: "edited", changes: { title: {} }, eventUpdatedAt: "2026-01-03T00:00:00Z", pr, reviews, files: FILES, filesTruncated: false });
    expect(v2.writes.dismissReviewIds).toEqual([]);
    expect(decide({ ...state({ action: "synchronize", reviews: [approvalFor(pr, { submitted_at: "2026-01-04T00:00:00Z" })] }), pr, eventUpdatedAt: "2026-01-03T00:00:00Z" }).pass).toBe(true);
    const tie = decide({ ...state({ action: "reopened", reviews: [approvalFor(makePr(), { submitted_at: "2026-01-03T00:00:00Z" })] }), eventUpdatedAt: "2026-01-03T00:00:00Z" });
    expect(tie.pass).toBe(false); expect(tie.writes.dismissReviewIds).toEqual([]);
    const stale = decide({ ...state({ action: "reopened" }), eventUpdatedAt: "2026-01-03T00:00:00Z" });
    expect(stale.pass).toBe(false); expect(stale.writes.dismissReviewIds).toEqual([1]);
  });
  it("resolves exact ordered merge-group batches of 1, 2, and 5", () => {
    const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main", head_ref: "gh-readonly-queue/main/pr-2-tail" };
    const fixture = (count) => { let baseSha = group.base_sha; const steps = Array.from({ length: count }, (_, i) => { const step = { baseSha, headSha: i + 1 === count ? group.head_sha : String(i + 1).padStart(40, "0"), prHeadSha: String(i + 101).padStart(40, "0") }; baseSha = step.headSha; return step; }); return { steps, connection: { nodes: steps.map((step, i) => ({ position: i + 1, baseCommit: { oid: step.baseSha }, headCommit: { oid: step.headSha }, pullRequest: { number: i + 1, state: "OPEN", headRefOid: step.prHeadSha, baseRefOid: group.base_sha } })), pageInfo: { hasPreviousPage: false, hasNextPage: false } } }; };
    for (const count of [1, 2, 5]) { const { connection, steps } = fixture(count); expect(resolveMergeGroupPrNumbers(group, connection, steps)).toEqual(Array.from({ length: count }, (_, i) => i + 1)); }
  });
  it("binds the observed #888 queue entry's cumulative head separately from its PR head", () => {
    const baseSha = "1ac7808372b8d314f4b3687450f057a0703ee366";
    const headSha = "705b3a7821177f059343dda658b095aede963819";
    const prHeadSha = "61318e4996acde8a5a84f5b78df3871a25db1589";
    const group = { head_sha: headSha, base_sha: baseSha, base_ref: "refs/heads/main" };
    const entry = { position: 1, baseCommit: { oid: baseSha }, headCommit: { oid: headSha }, pullRequest: { number: 888, state: "OPEN", headRefOid: prHeadSha, baseRefOid: baseSha } };
    expect(resolveMergeGroupMembers(group, { nodes: [entry], pageInfo: { hasPreviousPage: false, hasNextPage: false } }, [{ baseSha, headSha, prHeadSha }])).toEqual([{ number: 888, headSha: prHeadSha }]);
  });
  it("rejects partial, duplicate, malformed, closed, or ambiguous merge-queue membership", () => {
    const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main" };
    const steps = [{ baseSha: group.base_sha, headSha: "1".repeat(40), prHeadSha: "c".repeat(40) }, { baseSha: "1".repeat(40), headSha: group.head_sha, prHeadSha: "d".repeat(40) }];
    const entry = (position, number, step, state = "OPEN") => ({ position, baseCommit: { oid: step.baseSha }, headCommit: { oid: step.headSha }, pullRequest: { number, state, headRefOid: step.prHeadSha, baseRefOid: group.base_sha } });
    const good = { nodes: [entry(1, 1, steps[0]), entry(2, 2, steps[1])], pageInfo: { hasPreviousPage: false, hasNextPage: false } };
    for (const bad of [
      {}, { ...good, nodes: [] }, { ...good, pageInfo: { ...good.pageInfo, hasPreviousPage: true } }, { ...good, pageInfo: { ...good.pageInfo, hasNextPage: true } },
      { ...good, nodes: Array.from({ length: 101 }, (_, i) => ({ position: i, baseCommit: { oid: String(i + 200).padStart(40, "0") }, headCommit: { oid: String(i + 400).padStart(40, "0") }, pullRequest: { number: i + 1, state: "OPEN", headRefOid: String(i + 600).padStart(40, "0"), baseRefOid: group.base_sha } })) },
      { ...good, nodes: [good.nodes[0], { ...good.nodes[1], position: 1 }] }, { ...good, nodes: [good.nodes[0], { ...good.nodes[1], pullRequest: { ...good.nodes[1].pullRequest, number: 1 } }] },
      { ...good, nodes: [good.nodes[0], { ...good.nodes[1], pullRequest: { ...good.nodes[1].pullRequest, state: "CLOSED" } }] }, { ...good, nodes: [good.nodes[0], { ...good.nodes[1], headCommit: { ...good.nodes[1].headCommit, oid: "bad" } }] },
      { ...good, nodes: [{ ...good.nodes[0], position: undefined }, good.nodes[1]] }, { ...good, nodes: [{ ...good.nodes[0], pullRequest: { ...good.nodes[0].pullRequest, number: undefined } }, good.nodes[1]] },
      { ...good, nodes: [good.nodes[0]] }, { ...good, nodes: [good.nodes[0], { ...good.nodes[1], headCommit: { oid: good.nodes[0].headCommit.oid } }] },
    ]) expect(() => resolveMergeGroupPrNumbers(group, bad, steps)).toThrow();
    for (const bad of [
      { ...good.nodes[1], baseCommit: { oid: "e".repeat(40) } },
      { ...good.nodes[1], headCommit: { oid: "e".repeat(40) } },
      { ...good.nodes[1], pullRequest: { ...good.nodes[1].pullRequest, headRefOid: "e".repeat(40) } },
      { ...good.nodes[1], pullRequest: { ...good.nodes[1].pullRequest, baseRefOid: "e".repeat(40) } },
    ]) expect(() => resolveMergeGroupMembers(group, { ...good, nodes: [good.nodes[0], bad] }, steps)).toThrow();
    expect(() => resolveMergeGroupMembers(group, { ...good, nodes: [good.nodes[0], { ...good.nodes[1], position: 0 }] }, steps)).toThrow();
    expect(() => resolveMergeGroupMembers(group, good, [...steps].reverse())).toThrow();
    const unrelated = { position: 3, baseCommit: { oid: "e".repeat(40) }, headCommit: { oid: "f".repeat(40) }, pullRequest: { number: 3, state: "OPEN", headRefOid: "0".repeat(40), baseRefOid: "9".repeat(40) } };
    expect(resolveMergeGroupPrNumbers(group, { ...good, nodes: [...good.nodes, unrelated] }, steps)).toEqual([1, 2]);
  });
  it("allows an unrelated queue PR to share a selected member's PR head commit", () => {
    const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main" };
    const step = { baseSha: group.base_sha, headSha: group.head_sha, prHeadSha: "c".repeat(40) };
    const selected = { position: 1, baseCommit: { oid: step.baseSha }, headCommit: { oid: step.headSha }, pullRequest: { number: 1, state: "OPEN", headRefOid: step.prHeadSha, baseRefOid: group.base_sha } };
    const unrelated = { position: 2, baseCommit: { oid: "d".repeat(40) }, headCommit: { oid: "e".repeat(40) }, pullRequest: { number: 2, state: "OPEN", headRefOid: step.prHeadSha, baseRefOid: "f".repeat(40) } };
    expect(resolveMergeGroupMembers(group, { nodes: [selected, unrelated], pageInfo: { hasPreviousPage: false, hasNextPage: false } }, [step])).toEqual([{ number: 1, headSha: step.prHeadSha }]);
  });
  it("allows distinct selected queue PRs to share a PR head commit", () => {
    const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main" };
    const sharedPrHead = "c".repeat(40);
    const steps = [{ baseSha: group.base_sha, headSha: "d".repeat(40), prHeadSha: sharedPrHead }, { baseSha: "d".repeat(40), headSha: group.head_sha, prHeadSha: sharedPrHead }];
    const nodes = steps.map((step, index) => ({ position: index + 1, baseCommit: { oid: step.baseSha }, headCommit: { oid: step.headSha }, pullRequest: { number: index + 1, state: "OPEN", headRefOid: step.prHeadSha, baseRefOid: group.base_sha } }));
    expect(resolveMergeGroupPrNumbers(group, { nodes, pageInfo: { hasPreviousPage: false, hasNextPage: false } }, steps)).toEqual([1, 2]);
  });
  it("fails on halt-agents, needs-replan, and force-merge labels", () => {
    expect(decide(state({}, { labels: [{ name: "halt-agents" }] })).pass).toBe(false);
    expect(decide(state({}, { labels: [{ name: "needs-replan" }] })).pass).toBe(false);
    expect(decide(state({}, { labels: [{ name: "force-merge" }] })).pass).toBe(false);
  });
  it("auto-revert relaxes plan/scope/criteria only", () => {
    const files = [{ filename: "anywhere/z.ts", additions: 1, deletions: 1 }];
    const run = (prOver, revPr = null) => { const pr = makePr({ body: "garbage", labels: [{ name: "auto-revert" }], ...prOver }); return decide({ action: "opened", changes: null, eventUpdatedAt: "2026-01-02T00:00:00Z", pr, reviews: [approvalFor(revPr ?? pr)], files, filesTruncated: false }); };
    expect(run().pass).toBe(true);
    expect(run({}, makePr()).pass).toBe(false);
    expect(run({ labels: [{ name: "auto-revert" }, { name: "force-merge" }] }).pass).toBe(false);
    expect(run({ labels: [{ name: "auto-revert" }, { name: "halt-agents" }] }).pass).toBe(false);
    expect(evaluatePolicy({ body: `x ${"ghp_" + "a".repeat(36)}`, labels: ["auto-revert"], draft: false, files: [] })).toContain("plan body contains credential material");
  });
  it("allowlist matches literal, /**, /*, and trailing-* semantics", () => {
    expect(matchesAllowlist("a/b.ts", ["a/b.ts"])).toBe(true);
    expect(matchesAllowlist("a/b/c.ts", ["a/**"])).toBe(true);
    expect(matchesAllowlist("a/b.ts", ["a/*"])).toBe(true);
    expect(matchesAllowlist("a/b/c.ts", ["a/*"])).toBe(true);
    expect(matchesAllowlist("ab/c.ts", ["a/*"])).toBe(false);
    expect(matchesAllowlist("a/bcd.ts", ["a/b*"])).toBe(true);
  });
  it("does not restore retired size caps or approval labels", () => {
    const plan2 = PLAN.replace("- `scripts/x.mjs`", "- `scripts/x.mjs`\n- `.github/workflows/**`\n- `docs/**`");
    const base = { body: plan2, labels: [], draft: true };
    const wf = { filename: ".github/workflows/x.yml", additions: 1, deletions: 0 };
    expect(evaluatePolicy({ ...base, files: [wf] })).toEqual([]);
    expect(evaluatePolicy({ body: "garbage", labels: ["auto-revert"], draft: false, files: [wf] })).toEqual([]);
    expect(evaluatePolicy({ ...base, files: [{ ...wf, additions: 5000 }] })).toEqual([]);
    expect(evaluatePolicy({ ...base, files: [{ filename: "docs/x.md", additions: 5000, deletions: 0 }] })).toEqual([]);
    const guardedPlan = PLAN.replace("scripts/x.mjs", "scripts/review-snapshot-integrity.mjs");
    const guarded = { filename: "scripts/review-snapshot-integrity.mjs", additions: 5000, deletions: 0 };
    expect(evaluatePolicy({ body: guardedPlan, labels: [], draft: true, files: [guarded] })).toEqual([]);
    expect(evaluatePolicy({ ...base, files: [{ filename: "outside.ts", additions: 1, deletions: 0 }] })).toContain("out-of-scope file: outside.ts");
  });
  it("fails closed on truncated pagination, closed-PR no-ops, and api retries then throws", async () => {
    expect(decide(state({ filesTruncated: true })).pass).toBe(false);
    expect(decide(state({}, { state: "closed" })).noop).toBe(true);
    expect(() => decide(state({}, { labels: [{}] }))).toThrow("unexpected PR labels");
    expect(() => decide(state({ reviews: [approvalFor(makePr(), { state: "UNKNOWN" })] }))).toThrow("unexpected live API state");
    const statuses = [429, 500, 500]; vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: statuses.shift() })));
    await expect(api("/x")).rejects.toThrow("500");
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422 })));
    await expect(api("/bad-request")).rejects.toThrow("422");
    expect(fetch).toHaveBeenCalledTimes(1);
    const signals = [];
    vi.stubGlobal("fetch", vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    await expect(api("/stalled", { timeoutMs: 5 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("review snapshot integrity merge group", () => {
  const repo = "o/r";
  const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-2-tail" };
  const event = { action: "checks_requested", repository: { full_name: repo }, merge_group: group };
  const queueEntries = (numbers) => numbers.map((number, index) => { const prHead = String(number + 10).padStart(40, "0"); return { position: index + 1, baseCommit: { oid: String(number + 100).padStart(40, "0") }, headCommit: { oid: String(number + 200).padStart(40, "0") }, pullRequest: { number, state: "OPEN", headRefOid: prHead, baseRefOid: group.base_sha } }; });
  const queuePr = (number) => makePr({ number, updated_at: "2026-01-02T00:00:00Z", head: { sha: String(number + 10).padStart(40, "0"), repo: { full_name: `fork${number}/r` } }, base: { sha: group.base_sha, ref: "main", repo: { full_name: repo } } });
  it("disables setup-node automatic package-manager caching in both RSI workflows", () => {
    for (const name of ["review-snapshot-integrity-pr.yml", "review-snapshot-integrity-merge-group.yml"]) {
      const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
      expect(workflow).toContain("package-manager-cache: false");
    }
  });
  const stub = (entries, { truncateFiles = false, driftPr = null, finalBodyDriftPr = null, finalReviewDriftPr = null, memberCount = entries.length, malformedGroupCommit = false } = {}) => {
    const seen = [];
    const pullReads = new Map();
    const groupCommits = new Map(); let base = group.base_sha;
    const liveEntries = entries.map((entry, index) => {
      if (index >= memberCount) return entry;
      const sha = index + 1 === memberCount ? group.head_sha : String(index + 1).padStart(40, "0");
      const live = { ...entry, baseCommit: { oid: base }, headCommit: { oid: sha } };
      groupCommits.set(sha, { sha, parents: malformedGroupCommit && index === 0 ? [{ sha: base }] : [{ sha: base }, { sha: entry.pullRequest.headRefOid }] }); base = sha;
      return live;
    });
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      const u = String(url); const method = opts.method ?? "GET"; seen.push({ u, method, body: opts.body });
      const reply = (json) => ({ ok: true, status: 200, json: async () => json });
      if (u.endsWith("/graphql")) {
        const query = JSON.parse(opts.body).query;
        if (query.includes("mergeQueue")) return reply({ data: { repository: { mergeQueue: { entries: { nodes: liveEntries, pageInfo: { hasPreviousPage: false, hasNextPage: false } } } } } });
        return reply({ data: { repository: Object.fromEntries(liveEntries.slice(0, memberCount).map((entry, index) => { const pr = queuePr(entry.pullRequest.number); const review = approvalFor(pr, entry.pullRequest.number === finalReviewDriftPr ? { state: "CHANGES_REQUESTED" } : {}); return [`p${index}`, { number: pr.number, state: "OPEN", isDraft: pr.draft, body: pr.number === finalBodyDriftPr ? `${pr.body}drift` : pr.body, headRefOid: entry.pullRequest.headRefOid, baseRefOid: group.base_sha, labels: { nodes: pr.labels, pageInfo: { hasPreviousPage: false, hasNextPage: false } }, reviews: { nodes: [{ fullDatabaseId: String(review.id), state: review.state, submittedAt: review.submitted_at, body: review.body, commit: { oid: review.commit_id }, author: review.user }], pageInfo: { hasPreviousPage: false, hasNextPage: false } } }]; })) } });
      }
      if (u.includes("/git/commits/")) return reply(groupCommits.get(u.split("/").at(-1)));
      const number = Number(u.match(/\/pulls\/(\d+)/)?.[1]); const pr = queuePr(number);
      if (u.endsWith(`/pulls/${number}`)) { const reads = (pullReads.get(number) ?? 0) + 1; pullReads.set(number, reads); return reply(number === driftPr && reads > 1 ? { ...pr, body: `${pr.body}drift` } : pr); }
      if (u.includes(`/pulls/${number}/files`)) return reply(truncateFiles ? Array.from({ length: 100 }, () => FILES[0]) : FILES);
      if (u.includes(`/pulls/${number}/reviews`)) return reply([approvalFor(pr)]);
      throw new Error(`unexpected fetch ${u}`);
    }));
    return seen;
  };
  it("validates action, repository, refs, SHAs, and the native run SHA", () => {
    expect(validateMergeGroupEvent(event, repo, group.head_sha)).toBe(group);
    for (const bad of [
      { ...event, action: "destroy" }, { ...event, repository: { full_name: "evil/r" } },
      { ...event, merge_group: { ...group, head_sha: "bad" } }, { ...event, merge_group: { ...group, base_sha: group.head_sha } },
      { ...event, merge_group: { ...group, base_ref: "refs/heads/dev" } }, { ...event, merge_group: { ...group, head_ref: "refs/heads/main" } },
    ]) expect(() => validateMergeGroupEvent(bad, repo, group.head_sha)).toThrow();
    expect(() => validateMergeGroupEvent(event, repo, "c".repeat(40))).toThrow("run sha");
  });
  it("evaluates every exact member in order through read-only API calls", async () => {
    const entries = queueEntries([1, 2, 3]); const seen = stub(entries, { memberCount: 2 });
    const result = await evaluateMergeGroup(repo, event, group.head_sha);
    expect(result).toMatchObject({ failed: false, prNumbers: [1, 2] });
    expect(seen.filter((r) => r.u.includes("/pulls/") && !r.u.includes("/files") && !r.u.includes("/reviews")).map((r) => r.u)).toEqual(["https://api.github.com/repos/o/r/pulls/1", "https://api.github.com/repos/o/r/pulls/2", "https://api.github.com/repos/o/r/pulls/1", "https://api.github.com/repos/o/r/pulls/2"]);
    expect(seen.every((r) => r.method === "GET" || (r.u.endsWith("/graphql") && r.method === "POST" && JSON.parse(r.body).query.startsWith("query(")))).toBe(true);
    expect(seen.some((r) => /statuses|dismissals/.test(r.u) || /mutation/i.test(r.body ?? ""))).toBe(false);
    vi.unstubAllGlobals();
  });
  it("fails if same-SHA PR metadata drifts before native success", async () => {
    stub(queueEntries([1]), { driftPr: 1 });
    await expect(evaluateMergeGroup(repo, event, group.head_sha)).rejects.toThrow("snapshot drifted");
    vi.unstubAllGlobals();
  });
  it("fails if any PR changes after its concurrent evaluation but before native success", async () => {
    stub(queueEntries([1, 2]), { finalBodyDriftPr: 1 });
    await expect(evaluateMergeGroup(repo, event, group.head_sha)).rejects.toThrow("snapshot drifted");
    vi.unstubAllGlobals();
    stub(queueEntries([1, 2]), { finalReviewDriftPr: 1 });
    await expect(evaluateMergeGroup(repo, event, group.head_sha)).rejects.toThrow("snapshot drifted");
    vi.unstubAllGlobals();
  });
  it("fails closed when the synthetic merge chain is not a two-parent chain to the event base", async () => {
    stub(queueEntries([1]), { malformedGroupCommit: true });
    await expect(evaluateMergeGroup(repo, event, group.head_sha)).rejects.toThrow("authoritative merge-group membership");
    vi.unstubAllGlobals();
  });
  it("fails closed at the PR pagination bound without attempting a write", async () => {
    const seen = stub(queueEntries([1]), { truncateFiles: true });
    const result = await evaluateMergeGroup(repo, event, group.head_sha);
    expect(result.failed).toBe(true);
    expect(seen.filter((r) => r.u.includes("/files")).length).toBe(30);
    expect(seen.every((r) => r.method === "GET" || r.u.endsWith("/graphql"))).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("review snapshot integrity publisher", () => {
  const repo = "o/r";
  const creator = { login: "github-actions[bot]" };
  const eventFor = (pr, over = {}) => ({ action: "opened", changes: null, repository: { full_name: repo }, pull_request: { number: pr.number, updated_at: "2026-01-02T00:00:00Z", head: { sha: pr.head.sha, repo: { full_name: repo } }, base: { sha: pr.base.sha, ref: "main", repo: { full_name: repo } } }, ...over });
  const stubPublisherApi = (pr, { reviews = [approvalFor(pr)], files = FILES, statuses = [], failStatus = null, failStatusRead = false, loseStatusResponse = null, hideStatusWrites = false, refetchPr = null } = {}) => {
    const posts = [];
    posts.mutations = [];
    let statusList = statuses;
    let pullsGets = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      const u = String(url);
      const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
      if (u.includes(`/statuses/`) && opts.method === "POST") {
        const body = JSON.parse(opts.body);
        if (failStatus === body.state) return reply(422, { message: "nope" });
        const created = { id: Math.max(0, ...statusList.map((status) => status.id)) + 1, context: body.context, state: body.state, creator };
        posts.push({ url: u, body });
        if (!hideStatusWrites) statusList = [...statusList, created];
        if (loseStatusResponse === body.state) throw new TypeError("status response lost");
        return reply(201, created);
      }
      if (u.includes("/commits/") && u.includes("/statuses")) { if (failStatusRead) return reply(500, {}); const page = Number(u.match(/[?&]page=(\d+)/)?.[1] ?? 1); return reply(200, statusList.slice((page - 1) * 100, page * 100)); }
      if (u.endsWith(`/pulls/${pr.number}`)) { pullsGets += 1; return reply(200, typeof refetchPr === "function" ? refetchPr(pullsGets) : pullsGets > 1 && refetchPr ? refetchPr : pr); }
      if (u.includes(`/pulls/${pr.number}/files`)) return reply(200, files);
      if (u.includes("/dismissals") && opts.method === "PUT") { posts.mutations.push("dismiss"); return reply(200, {}); }
      if (u.includes(`/pulls/${pr.number}/reviews`)) return reply(200, reviews);
      if (u.endsWith("/graphql")) {
        const query = JSON.parse(opts.body).query;
        if (query.includes("disablePullRequestAutoMerge")) { posts.mutations.push("disable"); return reply(200, { data: { disablePullRequestAutoMerge: { clientMutationId: null } } }); }
        if (query.includes("mergeQueueEntry")) { posts.mutations.push("inspect-queue"); return reply(200, { data: { node: { mergeQueueEntry: { id: "queue-id" } } } }); }
        if (query.includes("dequeuePullRequest")) { posts.mutations.push("dequeue"); return reply(200, { data: { dequeuePullRequest: { clientMutationId: null } } }); }
      }
      throw new Error(`unexpected fetch ${u}`);
    }));
    return posts;
  };
  const run = async (pr, opts, eventOver) => {
    process.exitCode = undefined;
    const posts = stubPublisherApi(pr, opts);
    await publishPullRequestStatus(repo, eventFor(pr, eventOver));
    vi.unstubAllGlobals();
    return posts;
  };
  it("validates event action, SHAs, base ref/repository, and head repository", () => {
    const pr = makePr();
    expect(validatePublisherEvent(eventFor(pr), repo).number).toBe(7);
    expect(validatePublisherEvent(eventFor(pr), repo).head.sha).toBe(pr.head.sha);
    expect(validatePublisherEvent(eventFor(pr, { pull_request: { ...eventFor(pr).pull_request, head: { sha: pr.head.sha, repo: { full_name: "fork/r" } } } }), repo).head.repo.full_name).toBe("fork/r");
    for (const bad of [
      eventFor(pr, { action: "closed" }),
      eventFor(pr, { repository: { full_name: "evil/r" } }),
      eventFor(pr, { pull_request: { ...eventFor(pr).pull_request, head: { sha: "zzz", repo: { full_name: repo } } } }),
      eventFor(pr, { pull_request: { ...eventFor(pr).pull_request, base: { sha: pr.base.sha, ref: "dev", repo: { full_name: repo } } } }),
      eventFor(pr, { pull_request: { ...eventFor(pr).pull_request, base: { sha: pr.base.sha, ref: "main", repo: { full_name: "evil/r" } } } }),
      eventFor(pr, { pull_request: { ...eventFor(pr).pull_request, head: { sha: pr.head.sha, repo: null } } }),
      { action: "opened" },
    ]) expect(() => validatePublisherEvent(bad, repo)).toThrow();
  });
  it("writes pending then success on the immutable event head SHA after a stable pass", async () => {
    const posts = await run(makePr());
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "success"]);
    expect(posts.every((p) => p.url.includes(`/statuses/${"a".repeat(40)}`))).toBe(true);
    expect(posts.every((p) => p.body.context === STATUS_CONTEXT)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
  it("keeps a valid success when advisory step-summary I/O fails", async () => {
    process.env.GITHUB_STEP_SUMMARY = "/dev/null/unwritable";
    const posts = await run(makePr());
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "success"]);
  });
  it("writes pending then failure and exits nonzero when evaluation fails", async () => {
    const posts = await run(makePr(), { reviews: [] });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("pending write failure attempts failure and can never emit success", async () => {
    const posts = await run(makePr(), { failStatus: "pending" });
    expect(posts.map((p) => p.body.state)).toEqual(["failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("attempts a one-shot failure write when status preflight cannot be read", async () => {
    const posts = await run(makePr(), { failStatusRead: true });
    expect(posts.map((p) => p.body.state)).toEqual(["failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("recovers one ambiguous committed status by readback without replaying the POST", async () => {
    const posts = await run(makePr(), { loseStatusResponse: "pending" });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "success"]);
  });
  it("ambiguous pending write readback attempts failure, never success", async () => {
    const pr = makePr();
    const posts = await run(pr, { hideStatusWrites: true });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("snapshot drift on the post-evaluation refetch blocks success", async () => {
    const pr = makePr();
    const posts = await run(pr, { refetchPr: makePr({ body: `${PLAN}edited` }) });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "failure"]);
    expect(process.exitCode).toBe(1);
    expect((await run(pr, { refetchPr: makePr({ draft: true }) })).map((p) => p.body.state)).toEqual(["pending", "failure"]);
  });
  it("overwrites success with failure when the complete post-write refetch drifts", async () => {
    const pr = makePr();
    const posts = await run(pr, { refetchPr: (count) => count >= 4 ? makePr({ draft: true }) : pr });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "success", "failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("uses a valid event head for failure when later source validation rejects", async () => {
    const pr = makePr();
    const posts = await run(pr, {}, { pull_request: { ...eventFor(pr).pull_request, head: { sha: pr.head.sha, repo: null } } });
    expect(posts.map((p) => p.body.state)).toEqual(["failure"]);
  });
  it("stale-head runs target only the event head SHA and fail on head drift", async () => {
    const stale = makePr();
    const live = makePr({ head: { sha: "c".repeat(40) } });
    const posts = await run(live, { reviews: [approvalFor(live)] }, { pull_request: { ...eventFor(stale).pull_request, number: live.number } });
    expect(posts.every((p) => p.url.includes(`/statuses/${"a".repeat(40)}`))).toBe(true);
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("same-head rerun recomputes current metadata instead of trusting the event", async () => {
    const pr = makePr({ labels: [{ name: "ok" }, { name: "halt-agents" }] });
    const posts = await run(pr, { reviews: [approvalFor(pr)] });
    expect(posts.map((p) => p.body.state)).toEqual(["pending", "failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("reserves capacity for a fail-closed final status near the API ceiling", async () => {
    const statuses = Array.from({ length: 998 }, (_, i) => ({ id: i + 1, context: STATUS_CONTEXT, state: "success", creator }));
    const posts = await run(makePr(), { statuses });
    expect(posts.map((p) => p.body.state)).toEqual(["failure"]);
    expect(process.exitCode).toBe(1);
  });
  it("performs stale-approval enforcement only while the event head is current", async () => {
    const pr = makePr({ node_id: "pr-id", labels: [{ name: "ok" }, { name: "changed" }], auto_merge: { merge_method: "SQUASH" } });
    const posts = await run(pr, { reviews: [approvalFor(makePr())] }, { action: "labeled", pull_request: { ...eventFor(pr).pull_request, updated_at: "2026-01-03T00:00:00Z" } });
    expect(posts.mutations).toEqual(["dismiss", "disable", "inspect-queue", "dequeue"]);
    const live = makePr({ head: { sha: "c".repeat(40) }, node_id: "pr-id" });
    const stale = await run(live, { reviews: [approvalFor(live)] }, { pull_request: eventFor(makePr()).pull_request });
    expect(stale.mutations).toEqual([]);
  });
  it("enforces the status-count ceiling, readback schema, and confirmation", async () => {
    process.exitCode = undefined;
    process.env.GITHUB_TOKEN = "t";
    const ceiling = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, context: STATUS_CONTEXT, state: "failure", creator }));
    vi.stubGlobal("fetch", vi.fn(async (url) => { const page = Number(String(url).match(/[?&]page=(\d+)/)[1]); return { ok: true, status: 200, json: async () => ceiling.slice((page - 1) * 100, page * 100) }; }));
    await expect(confirmStatus(repo, "a".repeat(40), { id: 1001, state: "pending" })).rejects.toThrow("unconfirmed");
    const overflow = [...ceiling, { id: 1001, context: STATUS_CONTEXT, state: "failure", creator }];
    vi.stubGlobal("fetch", vi.fn(async (url) => { const page = Number(String(url).match(/[?&]page=(\d+)/)[1]); return { ok: true, status: 200, json: async () => overflow.slice((page - 1) * 100, page * 100) }; }));
    await expect(confirmStatus(repo, "a".repeat(40), { id: 1001, state: "failure" })).rejects.toThrow("ceiling");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 1, context: STATUS_CONTEXT, state: "bogus" }] })));
    await expect(confirmStatus(repo, "a".repeat(40), { id: 1, state: "pending" })).rejects.toThrow("schema");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 1, context: "other", state: "success", creator }] })));
    await expect(confirmStatus(repo, "a".repeat(40), { id: 1, state: "pending" })).rejects.toThrow("unconfirmed");
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("page=2")
      ? { ok: true, status: 200, json: async () => [] }
      : { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, context: "x", state: "success", creator })) }));
    await expect(confirmStatus(repo, "a".repeat(40), { id: 1, state: "pending" })).rejects.toThrow("unconfirmed");
    vi.unstubAllGlobals();
  });
  it("postStatus validates SHA/state and sends the exact context", async () => {
    await expect(postStatus(repo, "nope", "pending")).rejects.toThrow("unexpected status write");
    await expect(postStatus(repo, "a".repeat(40), "error")).rejects.toThrow("unexpected status write");
    process.env.GITHUB_TOKEN = "t";
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => { if (opts.method !== "POST") return { ok: true, status: 200, json: async () => [] }; const body = JSON.parse(opts.body); seen.push({ url, body }); return { ok: true, status: 201, json: async () => ({ id: 1, context: body.context, state: body.state, creator }) }; }));
    await postStatus(repo, "a".repeat(40), "failure");
    expect(seen[0].body).toEqual({ state: "failure", context: "Review Snapshot Integrity", description: "Review snapshot integrity check failed" });
    vi.stubGlobal("fetch", vi.fn(async (_url, opts = {}) => opts.method !== "POST" ? { ok: true, status: 200, json: async () => [] } : { ok: true, status: 201, json: async () => ({ id: 2, context: STATUS_CONTEXT, state: "failure", creator: { login: "other-bot" } }) }));
    await expect(postStatus(repo, "a".repeat(40), "failure")).rejects.toThrow("write response");
    vi.unstubAllGlobals();
  });
});
