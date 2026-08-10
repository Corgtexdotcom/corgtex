import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { api, buildAttestationPayload, computeSnapshot, decide, encodeLabelSet, evaluatePolicy, isSnapshotMutatingEvent, matchesAllowlist, parseAttestation, parseMergeGroupPrNumbers, selectLatestReviewerApproval, sha256Bytes } from "./review-snapshot-integrity.mjs";
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
  it("rejects non-beepto-codex approvers; selects latest by submitted_at then highest id", () => {
    expect(selectLatestReviewerApproval([approvalFor(makePr(), { user: { login: "puncar-dev" } })])).toBeNull();
    expect(selectLatestReviewerApproval([approvalFor(makePr(), { state: "DISMISSED" })])).toBeNull();
    expect(selectLatestReviewerApproval([approvalFor(makePr(), { id: 1 }), approvalFor(makePr(), { id: 2 })]).id).toBe(2);
    expect(selectLatestReviewerApproval([approvalFor(makePr(), { id: 9, submitted_at: "2025-01-01T00:00:00Z" }), approvalFor(makePr(), { id: 1 })]).id).toBe(1);
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
    expect(decide({ ...state({ action: "synchronize", reviews: [approvalFor(pr, { submitted_at: "2026-01-04T00:00:00Z" })] }), pr, eventUpdatedAt: "2026-01-03T00:00:00Z" }).writes.dismissReviewIds).toEqual([]);
  });
  it("parses merge-group PR numbers, empty parse included", () => {
    expect(parseMergeGroupPrNumbers("gh-readonly-queue/main/pr-12-abcdef")).toEqual([12]);
    expect(parseMergeGroupPrNumbers("gh-readonly-queue/main/pr-1-a/pr-2-b")).toEqual([1, 2]);
    expect(parseMergeGroupPrNumbers("gh-readonly-queue/main/")).toEqual([]);
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
  });
  it("fails closed on truncated pagination, closed-PR no-ops, and api retries then throws", async () => {
    expect(decide(state({ filesTruncated: true })).pass).toBe(false);
    expect(decide(state({}, { state: "closed" })).noop).toBe(true);
    expect(() => decide(state({}, { labels: [{}] }))).toThrow("unexpected PR labels");
    expect(() => decide(state({ reviews: [approvalFor(makePr(), { state: "UNKNOWN" })] }))).toThrow("unexpected live API state");
    const statuses = [429, 500, 500]; vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: statuses.shift() })));
    await expect(api("/x")).rejects.toThrow("500");
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
