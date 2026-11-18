#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  parseValidationPrNumbers,
  productionValidationTag,
  recordArtifact,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  requireInternalValidationWorkspace,
  selectWorkspaceForValidation,
  validationWorkspaceSelectorFromEnv,
  workspaceTenant,
} from "./lib/validation-workspace.mjs";
import {
  healthConfiguredReleaseDrift,
  healthReleaseMismatch,
} from "./lib/release-health-validation.mjs";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_OUT_DIR = ".artifacts/briefing-fixture-production-smoke";
const SMOKE_BRIEFING_MODEL = "production-validation-fixture";
const BRIEFING_FIXTURE_TOP_PRIORITY = 1_000_000;

function usage() {
  return [
    "usage: npx tsx scripts/briefing-fixture-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs a production-safe deterministic briefing fixture smoke against the internal validation workspace.",
    "",
    "Environment:",
    "  BRIEFING_FIXTURE_SMOKE_EXPECTED_GIT_SHA  optional /api/health release SHA to require",
    "  BRIEFING_FIXTURE_SMOKE_WORKSPACE_SLUG    workspace slug to select after login",
    "  BRIEFING_FIXTURE_SMOKE_EMAIL             login email; falls back to PRODUCTION_VALIDATION_ADMIN_EMAIL or ADMIN_EMAIL",
    "  BRIEFING_FIXTURE_SMOKE_PASSWORD          login password; falls back to PRODUCTION_VALIDATION_ADMIN_PASSWORD or ADMIN_PASSWORD",
    "  BRIEFING_FIXTURE_SMOKE_PR_NUMBERS        comma-separated PR numbers covered by this validation run",
    "  DATABASE_URL                              required production database connection for briefing generation and cleanup",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function parseSetCookie(setCookie) {
  assert(setCookie, "Missing session cookie.");
  return setCookie.split(", ").find((part) => part.includes("corgtex"))?.split(";")[0] ?? setCookie.split(";")[0];
}

function validationRecordPrefix(run, fallback) {
  if (run.prNumbers.length === 0) return `${fallback} ${run.runId}`;
  return productionValidationTag({
    date: run.startedAt,
    prNumber: run.prNumbers[0],
    runId: run.runId,
  });
}

function dateKeyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

export function briefingFixtureHealthReleaseBlocker(health, expectedGitSha = null) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? healthConfiguredReleaseDrift(health, expectedGitSha);
}

export function briefingFixtureTimestamps(generatedAt) {
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  assert(!Number.isNaN(generated.getTime()), "generatedAt must be a valid date.");
  return {
    generatedAt: generated,
    freshAt: new Date(generated.getTime() - 1_000),
    staleAt: new Date(generated.getTime() - 45 * 24 * 60 * 60 * 1000),
    overdueAt: new Date(generated.getTime() - 365 * 24 * 60 * 60 * 1000),
  };
}

function sourceRefMatches(ref, type, id) {
  return ref?.type === type && ref?.id === id;
}

function itemForSource(briefing, type, id) {
  return briefing?.items?.find?.((item) => item.sourceRefs?.some((ref) => sourceRefMatches(ref, type, id))) ?? null;
}

function narrativeText(briefing) {
  return [
    briefing?.leadMd,
    briefing?.bodyMd,
    briefing?.attentionMd,
    briefing?.continuingContextMd,
  ].filter(Boolean).join("\n");
}

export function assertBriefingFixturePayload(briefing, fixture) {
  assert(briefing && typeof briefing === "object", "Stored briefing payload was missing.");
  assert(briefing.period === "DAILY", `Expected DAILY briefing, got ${briefing.period ?? "<missing>"}.`);
  assert(briefing.dateKey === fixture.dateKey, `Expected briefing dateKey ${fixture.dateKey}, got ${briefing.dateKey ?? "<missing>"}.`);
  assert(briefing.editorialMode === "daily_homepage", `Expected daily_homepage editorial mode, got ${briefing.editorialMode ?? "<missing>"}.`);

  const actionItem = itemForSource(briefing, "ACTION", fixture.action.id);
  const proposalItem = itemForSource(briefing, "PROPOSAL", fixture.proposal.id);
  const articleItem = itemForSource(briefing, "BRAIN_ARTICLE", fixture.article.id);
  assert(actionItem, `Briefing did not include fixture action ${fixture.action.id}.`);
  assert(proposalItem, `Briefing did not include fixture proposal ${fixture.proposal.id}.`);
  assert(articleItem, `Briefing did not include fixture knowledge article ${fixture.article.id}.`);

  assert(
    briefing.items?.[0]?.sourceRefs?.some((ref) => sourceRefMatches(ref, "ACTION", fixture.action.id)),
    `Fresh action ${fixture.action.id} was not the lead briefing item.`,
  );

  const text = narrativeText(briefing);
  assert(text.includes(fixture.action.title), `Briefing narrative did not include fresh action "${fixture.action.title}".`);
  assert(text.includes(fixture.proposal.title), `Briefing narrative did not include stale proposal "${fixture.proposal.title}".`);
  assert(!(briefing.bodyMd ?? "").includes(fixture.proposal.title), "Stale proposal was presented as fresh body content.");
  assert(
    [briefing.attentionMd, briefing.continuingContextMd].filter(Boolean).join("\n").includes(fixture.proposal.title),
    "Stale proposal was not framed as attention or continuing context.",
  );

  for (const [type, record] of [
    ["ACTION", fixture.action],
    ["PROPOSAL", fixture.proposal],
    ["BRAIN_ARTICLE", fixture.article],
  ]) {
    assert(
      briefing.sourceRefs?.some?.((ref) => ref.type === type && ref.id === record.id && ref.label === record.title),
      `Source trail did not preserve ${type} label "${record.title}".`,
    );
  }

  return {
    actionItem,
    proposalItem,
    articleItem,
    sourceCounts: briefing.sourceCounts ?? {},
  };
}

export function assertDashboardBriefingHtml(html, fixture) {
  const text = String(html ?? "");
  assert(text.includes(fixture.title), `Dashboard did not render briefing title "${fixture.title}".`);
  assert(text.includes(fixture.action.title), `Dashboard did not render fresh action "${fixture.action.title}".`);
  assert(text.includes(fixture.proposal.title), `Dashboard did not render stale proposal "${fixture.proposal.title}".`);
  return true;
}

export function cleanupFailureMessage(cleanup) {
  const failed = cleanup?.failed ?? [];
  if (failed.length === 0) return null;
  return `Validation cleanup failed for ${failed.map(({ entry }) => entry.id).join(", ")}`;
}

function snapshotWorkspaceBriefing(record) {
  if (!record) return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workflowJobId: record.workflowJobId,
    period: record.period,
    dateKey: record.dateKey,
    runKey: record.runKey,
    title: record.title,
    status: record.status,
    modelUsed: record.modelUsed,
    introMd: record.introMd,
    bodyMd: record.bodyMd,
    briefingJson: record.briefingJson,
    sourceRefsJson: record.sourceRefsJson,
    sourceCounts: record.sourceCounts,
    generatedAt: record.generatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function timestampMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function isSmokeOwnedBriefing(current, expected) {
  if (!current || !expected) return false;
  return current.id === expected.id
    && current.title === expected.title
    && current.modelUsed === SMOKE_BRIEFING_MODEL
    && timestampMs(current.generatedAt) === timestampMs(expected.generatedAt);
}

export function smokeOwnedBriefingWhere(expected) {
  assert(expected?.id, "Expected briefing cleanup row must include an id.");
  assert(expected?.title, "Expected briefing cleanup row must include a title.");
  const generatedAt = expected.generatedAt instanceof Date ? expected.generatedAt : new Date(expected.generatedAt);
  assert(!Number.isNaN(generatedAt.getTime()), "Expected briefing cleanup row must include a valid generatedAt timestamp.");
  return {
    id: expected.id,
    title: expected.title,
    modelUsed: SMOKE_BRIEFING_MODEL,
    generatedAt,
  };
}

export function isSmokeOwnedBriefingSnapshot(record) {
  return Boolean(record)
    && record.modelUsed === SMOKE_BRIEFING_MODEL
    && timestampMs(record.generatedAt) !== null;
}

function fixtureCandidateKey(type, id) {
  return `${type}:${id}`;
}

export function filterBriefingFixtureCandidates(candidates, fixture) {
  const expected = new Set([
    fixtureCandidateKey("ACTION", fixture.action.id),
    fixtureCandidateKey("PROPOSAL", fixture.proposal.id),
    fixtureCandidateKey("BRAIN_ARTICLE", fixture.article.id),
  ]);
  return candidates.filter((candidate) => expected.has(fixtureCandidateKey(candidate.sourceType, candidate.sourceId)));
}

export function assertBriefingFixtureCandidateCoverage(candidates, fixture) {
  const keys = new Set(candidates.map((candidate) => fixtureCandidateKey(candidate.sourceType, candidate.sourceId)));
  for (const [type, record] of [
    ["ACTION", fixture.action],
    ["PROPOSAL", fixture.proposal],
    ["BRAIN_ARTICLE", fixture.article],
  ]) {
    assert(keys.has(fixtureCandidateKey(type, record.id)), `Canonical briefing collector did not include fixture ${type} ${record.id}.`);
  }
  return {
    candidateCount: candidates.length,
    candidateTypes: candidates.map((candidate) => candidate.sourceType),
  };
}

export class BriefingFixtureSmoke {
  constructor({
    baseUrl,
    outDir,
    expectedGitSha,
    workspaceSelector,
    authEmail,
    authPassword,
    prNumbers,
    prisma,
    generatedAt,
    loadDomain = () => import("@corgtex/domain"),
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSelector = workspaceSelector ?? validationWorkspaceSelectorFromEnv(process.env, "BRIEFING_FIXTURE_SMOKE");
    this.workspaceSlug = this.workspaceSelector.workspaceSlug;
    this.authEmail = authEmail || null;
    this.authPassword = authPassword || null;
    this.prisma = prisma ?? new PrismaClient();
    this.loadDomain = loadDomain;
    this.generatedAt = generatedAt ? new Date(generatedAt) : new Date();
    this.dateKey = dateKeyFromDate(this.generatedAt);
    this.runId = `briefing-fixture-${Date.now().toString(36)}`;
    this.validationRun = createValidationRun({
      runId: this.runId,
      tenant: { slug: this.workspaceSlug, label: this.workspaceSlug },
      prNumbers,
      baseUrl: this.baseUrl,
      environment: "production",
      metadata: {
        script: "briefing-fixture-production-smoke",
        workspaceSelector: this.workspaceSelector,
        strictInternalValidationWorkspace: true,
      },
    });
    this.cleanupRegistry = createValidationCleanupRegistry(this.validationRun);
    this.validationTag = validationRecordPrefix(this.validationRun, "briefing-fixture-production-smoke");
    this.cookie = null;
    this.workspace = null;
    this.results = [];
    this.created = {
      inputAnchor: null,
      action: null,
      proposal: null,
      article: null,
      briefing: null,
    };
    this.previousBriefing = null;
    this.fixture = null;
  }

  record(name, detail = {}) {
    this.results.push({ name, status: "ok", ...detail });
    console.log(`OK   ${name}`);
  }

  async sessionFetch(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(url, { ...init, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${url} failed ${response.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
    }
    return { response, body, text };
  }

  async verifyHealth() {
    const health = await this.sessionFetch("/api/health");
    const blocker = briefingFixtureHealthReleaseBlocker(health.body, this.expectedGitSha);
    assert(!blocker, blocker);
    this.record("health release metadata", {
      runtimeGitSha: health.body?.release?.gitSha ?? null,
      configuredGitSha: health.body?.release?.configuredGitSha ?? null,
    });
  }

  async login() {
    assert(this.authEmail && this.authPassword, "Briefing fixture smoke requires BRIEFING_FIXTURE_SMOKE_EMAIL/PASSWORD or production validation admin credentials.");
    const login = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.authEmail, password: this.authPassword }),
      redirect: "manual",
    });
    const text = await login.text();
    assert(login.ok, `/api/auth/login failed ${login.status}: ${text.slice(0, 300)}`);
    this.cookie = parseSetCookie(login.headers.get("set-cookie"));

    const session = await this.sessionFetch("/api/session");
    const workspace = selectWorkspaceForValidation(session.body?.workspaces ?? [], {
      workspaceId: this.workspaceSelector.workspaceId,
      workspaceSlug: this.workspaceSelector.workspaceSlug,
      purpose: "briefing fixture production smoke",
    });
    requireInternalValidationWorkspace(workspace, { purpose: "briefing fixture production smoke writes" });
    assert(session.body?.actor?.kind === "user" && session.body.actor.user?.id,
      "Briefing fixture requires an authenticated user session.");
    this.actor = session.body.actor;
    this.workspace = workspace;
    this.validationRun.tenant = workspaceTenant(workspace);
    this.record("password login", { workspaceId: workspace.id, workspaceSlug: workspace.slug ?? null });
  }

  addApiArchiveCleanup({ type, id, title, endpoint }) {
    const cleanupActionId = `archive:${type}:${id}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: "archive",
      target: { type, id, label: title },
      runner: async () => {
        await this.sessionFetch(endpoint, { method: "DELETE" });
        return `${type} archived through product API.`;
      },
    });
    return cleanupActionId;
  }

  async resolveValidationActor() {
    const email = String(this.authEmail || "").trim().toLowerCase();
    assert(email, "Briefing fixture smoke requires a login email before fixture creation.");
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true },
    });
    assert(user, `Validation admin user ${email} was not found in production.`);
    assert(this.actor?.kind === "user" && this.actor.user?.id === user.id,
      "Validation session user does not match the fixture author.");
    const member = await this.prisma.member.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: this.workspace.id,
          userId: user.id,
        },
      },
      select: { id: true, isActive: true },
    });
    assert(member?.isActive, `Validation admin user ${user.email} is not an active member of workspace ${this.workspace.slug ?? this.workspace.id}.`);
    return { user, member };
  }

  async createFixtureRecords() {
    const workspaceId = this.workspace.id;
    const { user, member } = await this.resolveValidationActor();
    const { freshAt, staleAt, overdueAt } = briefingFixtureTimestamps(this.generatedAt);
    const slugSafeRunId = this.runId.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const actionTitle = `${this.validationTag} critical blocker briefing action`;
    const proposalTitle = `${this.validationTag} strategic stale briefing proposal`;
    const articleTitle = `${this.validationTag} briefing knowledge label`;

    const { recordArtifactInputLineage } = await this.loadDomain();
    const records = await this.prisma.$transaction(async (tx) => {
      const action = await tx.action.create({
        data: {
          workspaceId,
          authorUserId: user.id,
          title: actionTitle,
          bodyMd: "Temporary briefing validation action. Critical blocker decision needs an owner today.",
          status: "OPEN",
          priority: BRIEFING_FIXTURE_TOP_PRIORITY,
          dueAt: overdueAt,
          isPrivate: false,
          publishedAt: freshAt,
          createdAt: freshAt,
          updatedAt: freshAt,
        },
      });
      const proposal = await tx.proposal.create({
        data: {
          workspaceId,
          authorUserId: user.id,
          ownerMemberId: null,
          title: proposalTitle,
          summary: "Temporary stale proposal that should remain visible as continuing context.",
          bodyMd: "Temporary briefing validation proposal. It is intentionally stale but strategically relevant.",
          status: "OPEN",
          isPrivate: false,
          priority: BRIEFING_FIXTURE_TOP_PRIORITY,
          publishedAt: staleAt,
          createdAt: staleAt,
          updatedAt: staleAt,
        },
      });
      const article = await tx.brainArticle.create({
        data: {
          workspaceId,
          title: articleTitle,
          slug: `briefing-fixture-${slugSafeRunId}`,
          type: "RUNBOOK",
          authority: "REFERENCE",
          bodyMd: "Temporary briefing validation knowledge fixture. It proves source labels and dashboard presentation.",
          frontmatterJson: {},
          isPrivate: false,
          publishedAt: freshAt,
          lastVerifiedAt: freshAt,
          staleAfterDays: 90,
          sourceIds: [],
          createdAt: freshAt,
          updatedAt: freshAt,
        },
      });

      // These literal run-owned inputs are private to the authenticated producer.
      // Native ancestry keeps scheduled publishers from treating the public fixture
      // projections as shared inputs. No ingestion or publishing events are emitted.
      const inputAnchor = await tx.brainArticle.create({ data: {
        workspaceId, ownerMemberId: member.id, title: `${this.validationTag} briefing fixture inputs`,
        slug: `briefing-fixture-inputs-${slugSafeRunId}`, type: "RUNBOOK", authority: "REFERENCE",
        bodyMd: JSON.stringify({ action, proposal, article }), frontmatterJson: {},
        isPrivate: true, sourceIds: [],
      } });
      await recordArtifactInputLineage({ tx, actor: this.actor, workspaceId,
        artifact: { kind: "BrainArticle", id: inputAnchor.id }, content: inputAnchor,
        origin: "HUMAN_ORIGINAL", inputs: [] });
      for (const [kind, record] of [["Action", action], ["Proposal", proposal], ["BrainArticle", article]]) {
        await recordArtifactInputLineage({ tx, actor: this.actor, workspaceId,
          artifact: { kind, id: record.id }, content: record, origin: "DERIVED",
          inputs: [{ kind: "BrainArticle", id: inputAnchor.id }] });
      }
      return { inputAnchor, action, proposal, article };
    });
    for (const [key, type, title, endpoint] of [
      // Cleanup runs in reverse: restore the prior briefing and remove outputs first.
      ["inputAnchor", "BrainArticle", records.inputAnchor.title, `brain/articles/${records.inputAnchor.slug}`],
      ["action", "Action", actionTitle, `actions/${records.action.id}`],
      ["proposal", "Proposal", proposalTitle, `proposals/${records.proposal.id}`],
      ["article", "BrainArticle", articleTitle, `brain/articles/${records.article.slug}`],
    ]) {
      this.created[key] = records[key];
      this.created[key].cleanupActionId = this.addApiArchiveCleanup({ type, title, id: records[key].id,
        endpoint: `/api/workspaces/${workspaceId}/${endpoint}` });
    }

    this.fixture = {
      title: `Daily Workspace Briefing - ${this.dateKey}`,
      dateKey: this.dateKey,
      action: { id: this.created.action.id, title: actionTitle },
      proposal: { id: this.created.proposal.id, title: proposalTitle },
      article: { id: this.created.article.id, title: articleTitle },
    };
    this.record("fixture records created", {
      actionId: this.created.action.id,
      proposalId: this.created.proposal.id,
      articleId: this.created.article.id,
      actorUserId: user.id,
      creationMode: "atomic-private-input-derived-fixtures-no-product-events",
      inputAnchorId: this.created.inputAnchor.id,
      fixturePriority: BRIEFING_FIXTURE_TOP_PRIORITY,
      freshAt: freshAt.toISOString(),
      staleAt: staleAt.toISOString(),
      generatedAt: this.generatedAt.toISOString(),
    });
  }

  async snapshotExistingBriefing() {
    const { captureArtifactInputSnapshotProof, lineageContentFingerprint } = await this.loadDomain();
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.workspaceBriefing.findUnique({ where: {
        workspaceId_period_dateKey: { workspaceId: this.workspace.id, period: "DAILY", dateKey: this.dateKey },
      } });
      this.previousBriefing = snapshotWorkspaceBriefing(previous);
      this.previousBriefingProof = null;
      this.previousBriefingManifest = null;
      if (previous) {
        const manifest = await tx.artifactInputLineage.findFirst({ where: {
          workspaceId: this.workspace.id, artifactType: "WorkspaceBriefing", artifactId: previous.id,
        }, orderBy: { revision: "desc" } });
        this.previousBriefingManifest = manifest;
        if (manifest && manifest.origin !== "UNKNOWN") {
          this.previousBriefingProof = await captureArtifactInputSnapshotProof(this.actor, this.workspace.id,
            { kind: "WorkspaceBriefing", id: previous.id, fingerprint: lineageContentFingerprint("WorkspaceBriefing", previous) }, tx);
        }
      }
    });
    assert(
      !isSmokeOwnedBriefingSnapshot(this.previousBriefing),
      `Existing ${this.dateKey} workspace briefing is owned by another production validation run; wait for that run to clean up before retrying.`,
    );
  }

  registerBriefingCleanup(briefing) {
    const hadPreviousBriefing = Boolean(this.previousBriefing);
    const cleanupActionId = `${hadPreviousBriefing ? "restore" : "delete"}:WorkspaceBriefing:${briefing.id}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: hadPreviousBriefing ? "restore" : "delete",
      target: { type: "WorkspaceBriefing", id: briefing.id, label: briefing.title },
      runner: async () => {
        const domain = await this.loadDomain();
        return this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "WorkspaceBriefing" WHERE id = ${briefing.id} AND "workspaceId" = ${this.workspace.id} FOR UPDATE`;
          const currentManifest = await tx.artifactInputLineage.findFirst({ where: {
            workspaceId: this.workspace.id, artifactType: "WorkspaceBriefing", artifactId: briefing.id,
          }, orderBy: { revision: "desc" } });
          if (!this.fixtureBriefingManifest) {
            // A committed upsert may outlive its diagnostic read. Re-observe its
            // exact expected native head before cleanup; never invent a receipt.
            assert(currentManifest?.revision === (this.previousBriefingManifest?.revision ?? 0) + 1
              && currentManifest.origin === "DERIVED"
              && currentManifest.contentHash === domain.lineageContentFingerprint("WorkspaceBriefing", briefing),
            "Committed briefing fixture input proof could not be reconciled for cleanup.");
          } else if (!isDeepStrictEqual(currentManifest, this.fixtureBriefingManifest)) {
            return "Skipped workspace briefing cleanup because another producer changed its input proof.";
          }
          const ownershipWhere = { ...smokeOwnedBriefingWhere(briefing), workspaceId: this.workspace.id };
          if (this.previousBriefing) {
            const result = await tx.workspaceBriefing.updateMany({
              where: ownershipWhere,
              data: {
                workflowJobId: this.previousBriefing.workflowJobId,
                runKey: this.previousBriefing.runKey,
                title: this.previousBriefing.title,
                status: this.previousBriefing.status,
                modelUsed: this.previousBriefing.modelUsed,
                introMd: this.previousBriefing.introMd,
                bodyMd: this.previousBriefing.bodyMd,
                briefingJson: this.previousBriefing.briefingJson,
                sourceRefsJson: this.previousBriefing.sourceRefsJson,
                sourceCounts: this.previousBriefing.sourceCounts,
                generatedAt: this.previousBriefing.generatedAt,
                createdAt: this.previousBriefing.createdAt,
                updatedAt: this.previousBriefing.updatedAt,
              },
            });
            if (result.count === 0) {
              return "Skipped workspace briefing cleanup because another producer changed the row after validation.";
            }
            const restored = await tx.workspaceBriefing.findUniqueOrThrow({ where: { id: briefing.id } });
            if (this.previousBriefingProof) {
              await domain.recordArtifactInputLineage({ tx, actor: this.actor, workspaceId: this.workspace.id,
                artifact: { kind: "WorkspaceBriefing", id: briefing.id }, content: restored,
                origin: "DERIVED", inputs: [], inheritedRoots: this.previousBriefingProof });
            } else {
              await domain.invalidateArtifactInputLineage({ tx, workspaceId: this.workspace.id,
                artifact: { kind: "WorkspaceBriefing", id: briefing.id }, content: restored });
            }
            return "Previous workspace briefing and its native input proof restored.";
          }
          const result = await tx.workspaceBriefing.deleteMany({ where: ownershipWhere });
          if (result.count === 0) {
            return "Skipped workspace briefing cleanup because another producer changed the row after validation.";
          }
          return `Temporary workspace briefing deleted (${result.count}).`;
        }, { isolationLevel: "Serializable" });
      },
    });
    return cleanupActionId;
  }

  async publishFixtureBriefing(params) {
    const { renderWorkspaceBriefingMarkdown, recordArtifactInputLineage } = await this.loadDomain();
    const json = (value) => JSON.parse(JSON.stringify(value));
    // Match the native producer's persisted representation, while this temporary
    // replacement also requires the exact prior row/head captured for restoration.
    const refs = params.briefing.sourceRefs.length ? params.briefing.sourceRefs
      : [...new Map(params.briefing.items.flatMap(item => item.sourceRefs)
        .map(ref => [`${ref.type}:${ref.id}`, ref])).values()];
    const data = { workflowJobId: null, runKey: params.runKey, title: params.title,
      status: "GENERATED", modelUsed: params.modelUsed, introMd: params.briefing.introMd,
      bodyMd: renderWorkspaceBriefingMarkdown(params.briefing), briefingJson: json(params.briefing),
      sourceRefsJson: json(refs), sourceCounts: json(params.briefing.sourceCounts),
      generatedAt: new Date(params.briefing.generatedAt) };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkspaceBriefing" WHERE "workspaceId" = ${params.workspaceId} AND period = ${params.period}::"WorkspaceBriefingPeriod" AND "dateKey" = ${params.dateKey} FOR UPDATE`;
      const current = await tx.workspaceBriefing.findUnique({ where: { workspaceId_period_dateKey: {
        workspaceId: params.workspaceId, period: params.period, dateKey: params.dateKey,
      } } });
      const manifest = current ? await tx.artifactInputLineage.findFirst({ where: {
        workspaceId: params.workspaceId, artifactType: "WorkspaceBriefing", artifactId: current.id,
      }, orderBy: { revision: "desc" } }) : null;
      assert(isDeepStrictEqual(current, this.previousBriefing)
        && isDeepStrictEqual(manifest, this.previousBriefingManifest),
      "Workspace briefing changed since the restoration snapshot; no fixture replacement was written.");
      const stored = current
        ? await tx.workspaceBriefing.update({ where: { id: current.id }, data })
        : await tx.workspaceBriefing.create({ data: { workspaceId: params.workspaceId,
          period: params.period, dateKey: params.dateKey, ...data } });
      await recordArtifactInputLineage({ tx, actor: this.actor, workspaceId: params.workspaceId,
        artifact: { kind: "WorkspaceBriefing", id: stored.id }, content: stored, origin: "DERIVED",
        inputs: [], inheritedRoots: params.lineageRoots });
      return stored;
    }, { isolationLevel: "Serializable" });
  }

  async generateBriefing() {
    const {
      buildWorkspaceBriefingFromCandidates,
      collectWorkspaceBriefingCandidates,
      normalizeWorkspaceBriefingPayload,
      workspaceBriefingContextSince, captureArtifactInputProof, mergeArtifactInputProofs, lineageContentFingerprint,
    } = await this.loadDomain();
    const period = "DAILY";
    const title = `Daily Workspace Briefing - ${this.dateKey}`;
    const candidates = await collectWorkspaceBriefingCandidates({
      actor: this.actor,
      workspaceId: this.workspace.id,
      since: workspaceBriefingContextSince(period, this.generatedAt),
      now: this.generatedAt,
      until: this.generatedAt,
    });
    const fixtureCandidates = filterBriefingFixtureCandidates(candidates, this.fixture);
    const candidateSummary = assertBriefingFixtureCandidateCoverage(fixtureCandidates, this.fixture);
    const generatedBriefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: this.workspace.id,
      period,
      dateKey: this.dateKey,
      title,
      candidates: fixtureCandidates,
      generatedAt: this.generatedAt,
      editorialMode: "daily_homepage",
    });
    const workspaceRoots = await captureArtifactInputProof(this.actor, this.workspace.id,
      [{ kind: "Workspace", id: this.workspace.id }]);
    const stored = await this.publishFixtureBriefing({
      actor: this.actor,
      lineageRoots: mergeArtifactInputProofs(workspaceRoots, ...fixtureCandidates.map((candidate) => candidate.lineageRoots ?? [])),
      workspaceId: this.workspace.id,
      period,
      dateKey: this.dateKey,
      runKey: `${this.workspace.id}:daily-workspace-briefing:${this.dateKey}`,
      title,
      modelUsed: SMOKE_BRIEFING_MODEL,
      briefing: generatedBriefing,
    });
    const cleanupActionId = this.registerBriefingCleanup(stored);
    const briefing = normalizeWorkspaceBriefingPayload(stored.briefingJson);
    this.created.briefing = {
      id: stored.id,
      title: stored.title,
      cleanupActionId,
      payload: briefing,
    };
    const observedManifest = await this.prisma.artifactInputLineage.findFirst({ where: {
      workspaceId: this.workspace.id, artifactType: "WorkspaceBriefing", artifactId: stored.id,
    }, orderBy: { revision: "desc" } });
    assert(observedManifest?.revision === (this.previousBriefingManifest?.revision ?? 0) + 1
      && observedManifest.origin === "DERIVED"
      && observedManifest.contentHash === lineageContentFingerprint("WorkspaceBriefing", stored),
    "Workspace briefing input proof changed during fixture generation.");
    this.fixtureBriefingManifest = observedManifest;

    this.record("canonical workspace briefing generated", {
      briefingId: stored.id,
      dateKey: briefing.dateKey,
      previousBriefingRestorable: Boolean(this.previousBriefing),
      fixtureCandidateCount: candidateSummary.candidateCount,
      fixtureCandidateTypes: candidateSummary.candidateTypes,
    });
    return briefing;
  }

  async verifyDashboardDisplay() {
    const dashboard = await this.sessionFetch(`/workspaces/${this.workspace.id}`);
    assertDashboardBriefingHtml(dashboard.text, this.fixture);
    const dashboardPath = path.join(this.outDir, "briefing-dashboard.html");
    await writeFile(dashboardPath, dashboard.text);
    recordArtifact(this.validationRun, {
      type: "dashboard-html",
      path: dashboardPath,
      summary: "Authenticated workspace dashboard HTML showing the generated briefing fixture.",
    });
    this.record("dashboard displayed stored briefing", { path: dashboardPath });
  }

  recordValidationOutcome(result) {
    const coveredPrNumbers = this.validationRun.prNumbers.length > 0
      ? this.validationRun.prNumbers
      : [null];
    for (const prNumber of coveredPrNumbers) {
      recordValidationResult(this.validationRun, {
        ...(prNumber ? { prNumber } : {}),
        ...result,
      });
    }
  }

  recordValidationPass() {
    this.recordValidationOutcome({
      intent: "Deterministic workspace briefing fixture proves ranking, recency, stale context, source labels, and dashboard display",
      method: "briefing-fixture-production-smoke",
      result: "pass",
      evidence: [
        { type: "health", summary: "Production release metadata matched expected SHA." },
        { type: "database", summary: "Canonical workspace briefing generator ran against controlled internal validation records." },
        { type: "briefing-json", summary: "Stored briefing payload ranked the fresh action first and framed the stale proposal as continuing context." },
        { type: "dashboard", summary: "Authenticated workspace dashboard rendered the generated briefing title and fixture items." },
      ],
      createdRecordIds: [
        this.created.inputAnchor?.id,
        this.created.action?.id,
        this.created.proposal?.id,
        this.created.article?.id,
        this.created.briefing?.id,
      ].filter(Boolean),
      cleanupActionIds: this.cleanupRegistry.entries().map((entry) => entry.id),
    });
  }

  recordValidationFailure(error) {
    if (this.validationRun.results.length > 0) return;
    this.recordValidationOutcome({
      intent: "Deterministic workspace briefing fixture proves ranking, recency, stale context, source labels, and dashboard display",
      method: "briefing-fixture-production-smoke",
      result: "partial",
      blocker: error instanceof Error ? error.message : String(error),
      evidence: this.results.map((item) => ({ type: "step", summary: `${item.name}: ${item.status}` })),
      createdRecordIds: [
        this.created.inputAnchor?.id,
        this.created.action?.id,
        this.created.proposal?.id,
        this.created.article?.id,
        this.created.briefing?.id,
      ].filter(Boolean),
      cleanupActionIds: this.cleanupRegistry.entries().map((entry) => entry.id),
    });
  }

  async run() {
    let runError = null;
    await mkdir(this.outDir, { recursive: true });
    try {
      await this.verifyHealth();
      await this.login();
      await this.snapshotExistingBriefing();
      await this.createFixtureRecords();
      const briefing = await this.generateBriefing();
      const payloadSummary = assertBriefingFixturePayload(briefing, this.fixture);
      this.record("briefing payload verified", payloadSummary);
      await this.verifyDashboardDisplay();
      this.recordValidationPass();
    } catch (error) {
      runError = error;
      this.recordValidationFailure(error);
    } finally {
      const cleanup = await this.cleanupRegistry.runAll({ throwOnFailure: false });
      const cleanupErrorMessage = cleanupFailureMessage(cleanup);
      if (cleanupErrorMessage && !runError) {
        runError = new Error(cleanupErrorMessage);
        this.validationRun.results = [];
        this.recordValidationFailure(runError);
      }
      const resultsPath = path.join(this.outDir, "briefing-fixture-production-smoke.json");
      await writeFile(resultsPath, `${JSON.stringify({
        runId: this.runId,
        results: this.results,
        cleanup,
        created: this.created,
        fixture: this.fixture,
        previousBriefing: this.previousBriefing ? { id: this.previousBriefing.id, title: this.previousBriefing.title } : null,
        error: runError ? { message: runError.message, stack: runError.stack } : null,
      }, null, 2)}\n`);
      await writeValidationArtifacts(this.validationRun, this.outDir, {
        jsonFileName: "briefing-fixture-production-smoke.matrix.json",
        markdownFileName: "briefing-fixture-production-smoke.report.md",
      });
      if (typeof this.prisma?.$disconnect === "function") {
        await this.prisma.$disconnect();
      }
    }
    if (runError) throw runError;
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const baseUrl = process.argv[2] || DEFAULT_BASE_URL;
  const outDir = process.argv[3] || DEFAULT_OUT_DIR;
  const smoke = new BriefingFixtureSmoke({
    baseUrl,
    outDir,
    expectedGitSha: process.env.BRIEFING_FIXTURE_SMOKE_EXPECTED_GIT_SHA || process.env.PRODUCTION_VALIDATION_EXPECTED_GIT_SHA || null,
    workspaceSelector: validationWorkspaceSelectorFromEnv(process.env, "BRIEFING_FIXTURE_SMOKE"),
    authEmail: process.env.BRIEFING_FIXTURE_SMOKE_EMAIL || process.env.PRODUCTION_VALIDATION_ADMIN_EMAIL || process.env.ADMIN_EMAIL,
    authPassword: process.env.BRIEFING_FIXTURE_SMOKE_PASSWORD || process.env.PRODUCTION_VALIDATION_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD,
    prNumbers: parseValidationPrNumbers(process.env.BRIEFING_FIXTURE_SMOKE_PR_NUMBERS || process.env.PRODUCTION_VALIDATION_PR_NUMBERS || ""),
  });
  await smoke.run();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
