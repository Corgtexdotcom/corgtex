#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
    freshAt: new Date(generated.getTime() - 15 * 60 * 1000),
    staleAt: new Date(generated.getTime() - 45 * 24 * 60 * 60 * 1000),
    overdueAt: new Date(generated.getTime() - 60 * 60 * 1000),
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
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSelector = workspaceSelector ?? validationWorkspaceSelectorFromEnv(process.env, "BRIEFING_FIXTURE_SMOKE");
    this.workspaceSlug = this.workspaceSelector.workspaceSlug;
    this.authEmail = authEmail || null;
    this.authPassword = authPassword || null;
    this.prisma = prisma ?? new PrismaClient();
    this.generatedAt = generatedAt ? new Date(generatedAt) : new Date(Date.now() + 90_000);
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

  async createFixtureRecords() {
    const workspaceId = this.workspace.id;
    const slugSafeRunId = this.runId.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const actionTitle = `${this.validationTag} critical blocker briefing action`;
    const proposalTitle = `${this.validationTag} strategic stale briefing proposal`;
    const articleTitle = `${this.validationTag} briefing knowledge label`;

    const action = await this.sessionFetch(`/api/workspaces/${workspaceId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        title: actionTitle,
        bodyMd: "Temporary briefing validation action. Critical blocker decision needs an owner today.",
        priorityLabel: "Urgent",
      }),
    });
    this.created.action = action.body.action;
    this.created.action.cleanupActionId = this.addApiArchiveCleanup({
      type: "Action",
      id: this.created.action.id,
      title: actionTitle,
      endpoint: `/api/workspaces/${workspaceId}/actions/${this.created.action.id}`,
    });

    const proposal = await this.sessionFetch(`/api/workspaces/${workspaceId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        title: proposalTitle,
        summary: "Temporary stale proposal that should remain visible as continuing context.",
        bodyMd: "Temporary briefing validation proposal. It is intentionally stale but strategically relevant.",
        isPrivate: false,
        priorityLabel: "Urgent",
      }),
    });
    this.created.proposal = proposal.body.proposal;
    this.created.proposal.cleanupActionId = this.addApiArchiveCleanup({
      type: "Proposal",
      id: this.created.proposal.id,
      title: proposalTitle,
      endpoint: `/api/workspaces/${workspaceId}/proposals/${this.created.proposal.id}`,
    });

    const article = await this.sessionFetch(`/api/workspaces/${workspaceId}/brain/articles`, {
      method: "POST",
      body: JSON.stringify({
        title: articleTitle,
        slug: `briefing-fixture-${slugSafeRunId}`,
        type: "RUNBOOK",
        authority: "REFERENCE",
        bodyMd: "Temporary briefing validation knowledge fixture. It proves source labels and dashboard presentation.",
      }),
    });
    this.created.article = article.body.article;
    this.created.article.cleanupActionId = this.addApiArchiveCleanup({
      type: "BrainArticle",
      id: this.created.article.id,
      title: articleTitle,
      endpoint: `/api/workspaces/${workspaceId}/brain/articles/${this.created.article.slug}`,
    });

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
    });
  }

  async pinFixtureTimestamps() {
    const { freshAt, staleAt, overdueAt } = briefingFixtureTimestamps(this.generatedAt);
    const workspaceId = this.workspace.id;

    await Promise.all([
      this.prisma.action.update({
        where: { id: this.created.action.id },
        data: {
          workspaceId,
          status: "OPEN",
          isPrivate: false,
          priority: 3,
          bodyMd: "Temporary briefing validation action. Critical blocker decision needs an owner today.",
          dueAt: overdueAt,
          publishedAt: freshAt,
          createdAt: freshAt,
          updatedAt: freshAt,
        },
      }),
      this.prisma.proposal.update({
        where: { id: this.created.proposal.id },
        data: {
          workspaceId,
          status: "OPEN",
          isPrivate: false,
          priority: 3,
          summary: "Temporary stale proposal that should remain visible as continuing context.",
          bodyMd: "Temporary briefing validation proposal. It is intentionally stale but strategically relevant.",
          publishedAt: staleAt,
          createdAt: staleAt,
          updatedAt: staleAt,
        },
      }),
      this.prisma.brainArticle.update({
        where: { id: this.created.article.id },
        data: {
          workspaceId,
          authority: "REFERENCE",
          isPrivate: false,
          publishedAt: freshAt,
          lastVerifiedAt: freshAt,
          createdAt: freshAt,
          updatedAt: freshAt,
        },
      }),
    ]);

    this.record("fixture timestamps pinned", {
      freshAt: freshAt.toISOString(),
      staleAt: staleAt.toISOString(),
      generatedAt: this.generatedAt.toISOString(),
    });
  }

  async snapshotExistingBriefing() {
    this.previousBriefing = snapshotWorkspaceBriefing(await this.prisma.workspaceBriefing.findUnique({
      where: {
        workspaceId_period_dateKey: {
          workspaceId: this.workspace.id,
          period: "DAILY",
          dateKey: this.dateKey,
        },
      },
    }));
  }

  registerBriefingCleanup(briefing) {
    const hadPreviousBriefing = Boolean(this.previousBriefing);
    const cleanupActionId = `${hadPreviousBriefing ? "restore" : "delete"}:WorkspaceBriefing:${briefing.id}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: hadPreviousBriefing ? "restore" : "delete",
      target: { type: "WorkspaceBriefing", id: briefing.id, label: briefing.title },
      runner: async () => {
        if (this.previousBriefing) {
          await this.prisma.workspaceBriefing.update({
            where: { id: this.previousBriefing.id },
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
            },
          });
          return "Previous workspace briefing restored.";
        }
        const result = await this.prisma.workspaceBriefing.deleteMany({ where: { id: briefing.id } });
        return `Temporary workspace briefing deleted (${result.count}).`;
      },
    });
    return cleanupActionId;
  }

  async generateBriefing() {
    await this.snapshotExistingBriefing();
    const { generateWorkspaceBriefing, normalizeWorkspaceBriefingPayload } = await import("@corgtex/domain");
    const stored = await generateWorkspaceBriefing({
      workspaceId: this.workspace.id,
      period: "DAILY",
      dateISO: this.generatedAt.toISOString(),
      model: "production-validation-fixture",
      editorialMode: "daily_homepage",
    });
    const cleanupActionId = this.registerBriefingCleanup(stored);
    const briefing = normalizeWorkspaceBriefingPayload(stored.briefingJson);
    this.created.briefing = {
      id: stored.id,
      title: stored.title,
      cleanupActionId,
      payload: briefing,
    };
    this.record("canonical workspace briefing generated", {
      briefingId: stored.id,
      dateKey: briefing.dateKey,
      previousBriefingRestorable: Boolean(this.previousBriefing),
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
      await this.createFixtureRecords();
      await this.pinFixtureTimestamps();
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
