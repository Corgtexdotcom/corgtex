import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { api, computeSnapshot, decide, encodeLabelSet, evaluateMergeGroup, evaluatePolicy, resolveMergeGroupMembers, resolveMergeGroupPrNumbers, selectLatestReviewerReview, sha256Bytes, validateMergeGroupEvent } from "./review-snapshot-integrity.mjs";
const PLAN = "## Outcome\n\nDeliver the complete feature.\n\n## Risk tier\n\n- `low`\n\n## Acceptance criteria\n\n- [x] done\n\n## Test plan\n\nFocused regression tests passed.\n\n## Risk and rollback\n\nRevert the change if needed.\n";
const FILES = [{ filename: "scripts/x.mjs", additions: 1, deletions: 1 }];
const makePr = (over = {}) => ({ number: 7, state: "open", draft: false, body: PLAN, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) }, labels: [{ name: "ok" }], auto_merge: null, ...over });
const approvalFor = (pr, over = {}) => ({ id: 1, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", commit_id: pr.head.sha, user: { login: "beepto-codex" }, body: "Independent QA passed.", ...over });
const state = (over = {}, prOver = {}) => { const pr = makePr(prOver); return { pr, reviews: [approvalFor(pr)], files: FILES, filesTruncated: false, ...over }; };

describe("merge-group delivery policy", () => {
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
  it("accepts native current-head approval after ordinary valid metadata edits", () => {
    const reviews = [approvalFor(makePr())];
    const run = (prOver) => decide(state({ reviews }, prOver));
    expect(run({ body: `${PLAN}Additional valid context.` }).pass).toBe(true);
    expect(run({ labels: [{ name: "ok" }, { name: "new" }] }).pass).toBe(true);
    expect(run({ head: { sha: "c".repeat(40) } }).pass).toBe(false);
    expect(decide(state({ reviews: [approvalFor(makePr(), { state: "DISMISSED" })] })).pass).toBe(false);
  });
  it("requires concise delivery evidence without file allowlists, size caps or prescribed proof files", () => {
    const base = { body: PLAN, labels: [], draft: false };
    const files = [
      { filename: "packages/domain/src/feature.ts", additions: 5000, deletions: 0 },
      { filename: "apps/web/app/api/feature/route.ts", additions: 100, deletions: 0 },
    ];
    expect(evaluatePolicy({ ...base, files })).toEqual([]);
    for (const title of ["Outcome", "Test plan", "Risk and rollback"]) {
      expect(evaluatePolicy({ ...base, body: PLAN.replace(`## ${title}`, "## Other"), files })).toContain(`plan has no "${title}" section`);
    }
    expect(evaluatePolicy({ ...base, body: PLAN.replace("[x]", "[ ]"), files })).toContain("unticked criterion: done");
    expect(evaluatePolicy({ ...base, body: PLAN.replace("`low`", "`unknown`"), files })).toContain("plan has no parseable risk tier");
    const protectedFiles = [{ filename: ".github/workflows/ci.yml", additions: 5000, deletions: 0 }];
    expect(evaluatePolicy({ ...base, files: protectedFiles })).toContain("protected paths require critical risk");
    const critical = PLAN.replace("`low`", "`critical`");
    expect(evaluatePolicy({ ...base, body: critical, files: protectedFiles })).toContain('protected paths require a substantive "Scope" justification');
    for (const scope of ["TBD", "<!-- explanation -->", "What changes, what intentionally does not, and why this is one coherent PR."]) {
      expect(evaluatePolicy({ ...base, body: `${critical}\n## Scope\n\n${scope}`, files: protectedFiles })).toContain('protected paths require a substantive "Scope" justification');
    }
    expect(evaluatePolicy({ ...base, body: `${critical}\n## Scope\n\nReplace the workflow checks to implement the delivery policy.`, files: protectedFiles })).toEqual([]);
  });
  it("uses the reviewer's latest decisive state by submitted_at then id", () => {
    expect(selectLatestReviewerReview([approvalFor(makePr(), { user: { login: "puncar-dev" } })])).toBeNull();
    expect(selectLatestReviewerReview([approvalFor(makePr(), { id: 1 }), approvalFor(makePr(), { id: 2 })]).id).toBe(2);
    expect(selectLatestReviewerReview([approvalFor(makePr(), { id: 9, submitted_at: "2025-01-01T00:00:00Z" }), approvalFor(makePr(), { id: 1 })]).id).toBe(1);
    expect(decide(state({ reviews: [approvalFor(makePr()), approvalFor(makePr(), { id: 2, state: "CHANGES_REQUESTED" })] })).pass).toBe(false);
    expect(decide(state({ reviews: [approvalFor(makePr(), { state: "CHANGES_REQUESTED" }), approvalFor(makePr(), { id: 2 })] })).pass).toBe(true);
    expect(decide(state({ reviews: [approvalFor(makePr(), { user: { login: "puncar-dev" } })] })).pass).toBe(false);
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
    const run = (prOver, revPr = null) => { const pr = makePr({ body: "garbage", labels: [{ name: "auto-revert" }], ...prOver }); return decide({ pr, reviews: [approvalFor(revPr ?? pr)], files, filesTruncated: false }); };
    expect(run().pass).toBe(true);
    expect(run({}, makePr({ head: { sha: "c".repeat(40) } })).pass).toBe(false);
    expect(run({ labels: [{ name: "auto-revert" }, { name: "force-merge" }] }).pass).toBe(false);
    expect(run({ labels: [{ name: "auto-revert" }, { name: "halt-agents" }] }).pass).toBe(false);
    expect(evaluatePolicy({ body: `x ${"ghp_" + "a".repeat(36)}`, labels: ["auto-revert"], draft: false, files: [] })).toContain("plan body contains credential material");
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

describe("merge-group live validation", () => {
  const repo = "o/r";
  const group = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-2-tail" };
  const event = { action: "checks_requested", repository: { full_name: repo }, merge_group: group };
  const queueEntries = (numbers) => numbers.map((number, index) => { const prHead = String(number + 10).padStart(40, "0"); return { position: index + 1, baseCommit: { oid: String(number + 100).padStart(40, "0") }, headCommit: { oid: String(number + 200).padStart(40, "0") }, pullRequest: { number, state: "OPEN", headRefOid: prHead, baseRefOid: group.base_sha } }; });
  const queuePr = (number) => makePr({ number, updated_at: "2026-01-02T00:00:00Z", head: { sha: String(number + 10).padStart(40, "0"), repo: { full_name: `fork${number}/r` } }, base: { sha: group.base_sha, ref: "main", repo: { full_name: repo } } });
  const stub = (entries, { truncateFiles = false, paginatedProtectedFile = false, reviewOverrides = {}, finalLabelDriftPr = null, finalHeadDriftPr = null, finalBaseDrift = false, driftPr = null, finalBodyDriftPr = null, finalReviewDriftPr = null, memberCount = entries.length, malformedGroupCommit = false } = {}) => {
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
        return reply({ data: { repository: Object.fromEntries(liveEntries.slice(0, memberCount).map((entry, index) => { const pr = queuePr(entry.pullRequest.number); const review = approvalFor(pr, entry.pullRequest.number === finalReviewDriftPr ? { state: "CHANGES_REQUESTED" } : {}); return [`p${index}`, { number: pr.number, state: "OPEN", isDraft: pr.draft, body: pr.number === finalBodyDriftPr ? `${pr.body}drift` : pr.body, headRefOid: pr.number === finalHeadDriftPr ? "c".repeat(40) : entry.pullRequest.headRefOid, baseRefOid: finalBaseDrift ? "d".repeat(40) : group.base_sha, labels: { nodes: pr.number === finalLabelDriftPr ? [...pr.labels, { name: "halt-agents" }] : pr.labels, pageInfo: { hasPreviousPage: false, hasNextPage: false } }, reviews: { nodes: [{ fullDatabaseId: String(review.id), state: review.state, submittedAt: review.submitted_at, body: review.body, commit: { oid: review.commit_id }, author: review.user }], pageInfo: { hasPreviousPage: false, hasNextPage: false } } }]; })) } });
      }
      if (u.includes("/git/commits/")) return reply(groupCommits.get(u.split("/").at(-1)));
      const number = Number(u.match(/\/pulls\/(\d+)/)?.[1]); const pr = queuePr(number);
      if (u.endsWith(`/pulls/${number}`)) { const reads = (pullReads.get(number) ?? 0) + 1; pullReads.set(number, reads); return reply(number === driftPr && reads > 1 ? { ...pr, body: `${pr.body}drift` } : pr); }
      if (u.includes(`/pulls/${number}/files`)) {
        if (paginatedProtectedFile) return reply(new URL(u).searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, index) => ({ ...FILES[0], filename: `scripts/file${index}.mjs` })) : [{ filename: ".github/workflows/ci.yml", additions: 1, deletions: 0 }]);
        return reply(truncateFiles ? Array.from({ length: 100 }, () => FILES[0]) : FILES);
      }
      if (u.includes(`/pulls/${number}/reviews`)) return reply([approvalFor(pr, reviewOverrides)]);
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
  it("rejects label, head and base drift after concurrent evaluation", async () => {
    for (const options of [{ finalLabelDriftPr: 1 }, { finalHeadDriftPr: 1 }, { finalBaseDrift: true }]) {
      stub(queueEntries([1]), options);
      await expect(evaluateMergeGroup(repo, event, group.head_sha)).rejects.toThrow("snapshot drifted");
      vi.unstubAllGlobals();
    }
  });
  it("rejects stale-head, dismissed, changes-requested and other-identity approvals", async () => {
    for (const reviewOverrides of [{ commit_id: "f".repeat(40) }, { state: "DISMISSED" }, { state: "CHANGES_REQUESTED" }, { user: { login: "builder" } }]) {
      const seen = stub(queueEntries([1]), { reviewOverrides });
      expect((await evaluateMergeGroup(repo, event, group.head_sha)).failed).toBe(true);
      expect(seen.some((request) => /mutation|statuses|dismissals/.test(request.body ?? request.u))).toBe(false);
      vi.unstubAllGlobals();
    }
  });
  it("evaluates protected changes found on later Files API pages", async () => {
    const seen = stub(queueEntries([1]), { paginatedProtectedFile: true });
    expect((await evaluateMergeGroup(repo, event, group.head_sha)).failed).toBe(true);
    expect(seen.filter((request) => request.u.includes("/files")).map((request) => new URL(request.u).searchParams.get("page"))).toEqual(["1", "2"]);
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
