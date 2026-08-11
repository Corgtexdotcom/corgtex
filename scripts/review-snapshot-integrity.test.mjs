import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { api, buildAttestationPayload, computeSnapshot, confirmStatus, decide, encodeLabelSet, evaluatePolicy, isSnapshotMutatingEvent, matchesAllowlist, parseAttestation, postStatus, publishPullRequestStatus, resolveMergeGroupPrNumbers, selectLatestReviewerReview, sha256Bytes, STATUS_CONTEXT, validatePublisherEvent } from "./review-snapshot-integrity.mjs";
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
  it("requires complete, unambiguous API membership for merge groups", () => {
    const group = { head_sha: "a".repeat(40), base_ref: "refs/heads/main", head_ref: "gh-readonly-queue/main/pr-2-tail" }; const entry = (position, number, oid = "b".repeat(40)) => ({ position, headCommit: { oid }, pullRequest: { number, state: "OPEN" } });
    const connection = { nodes: [entry(1, 1), entry(2, 2, group.head_sha), entry(3, 3)], pageInfo: { hasPreviousPage: false, hasNextPage: true } };
    expect(resolveMergeGroupPrNumbers(group, connection)).toEqual([1, 2]);
    for (const bad of [{}, { ...connection, nodes: [] }, { ...connection, nodes: [entry(1, 1), entry(1, 2, group.head_sha)] }, { ...connection, nodes: [entry(1, 1)] }]) expect(() => resolveMergeGroupPrNumbers(group, bad)).toThrow();
  });
  it("fails on halt-agents and force-merge labels", () => {
    expect(decide(state({}, { labels: [{ name: "halt-agents" }] })).pass).toBe(false);
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
  it("enforces forbidden-path label, critical-cap escalation, and doc exclusion", () => {
    const plan2 = PLAN.replace("- `scripts/x.mjs`", "- `scripts/x.mjs`\n- `.github/workflows/**`\n- `docs/**`");
    const base = { body: plan2, labels: [], draft: true };
    const wf = { filename: ".github/workflows/x.yml", additions: 1, deletions: 0 };
    expect(evaluatePolicy({ ...base, files: [wf] })).toContain("forbidden path changed without forbidden-path-approved");
    expect(evaluatePolicy({ body: "garbage", labels: ["auto-revert"], draft: false, files: [wf] })).toContain("forbidden path changed without forbidden-path-approved");
    expect(evaluatePolicy({ ...base, labels: ["forbidden-path-approved"], files: [wf] })).toEqual([]);
    expect(evaluatePolicy({ ...base, labels: ["forbidden-path-approved"], files: [{ ...wf, additions: 401 }] })[0]).toMatch("critical cap");
    expect(evaluatePolicy({ ...base, files: [{ filename: "docs/x.md", additions: 5000, deletions: 0 }] })).toEqual([]);
    const guardedPlan = PLAN.replace("scripts/x.mjs", "scripts/review-snapshot-integrity.mjs");
    const guarded = { filename: "scripts/review-snapshot-integrity.mjs", additions: 401, deletions: 0 };
    expect(evaluatePolicy({ body: guardedPlan, labels: [], draft: true, files: [guarded] })[0]).toMatch("critical cap");
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
