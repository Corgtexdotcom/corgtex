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
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  DEMO_WORKSPACE_SLUG,
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
const DEFAULT_OUT_DIR = ".artifacts/source-intake-production-smoke";
const SOURCE_WORKFLOW_SUPPRESSION_PASSES = 3;
const SOURCE_WORKFLOW_SUPPRESSION_DELAY_MS = 350;

function usage() {
  return [
    "usage: node scripts/source-intake-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs a production-safe source-intake smoke against the internal validation workspace.",
    "",
    "Environment:",
    "  SOURCE_INTAKE_SMOKE_EXPECTED_GIT_SHA  optional /api/health release SHA to require",
    "  SOURCE_INTAKE_SMOKE_WORKSPACE_SLUG    workspace slug to select after login",
    "  SOURCE_INTAKE_SMOKE_EMAIL             login email; falls back to PRODUCTION_VALIDATION_ADMIN_EMAIL or ADMIN_EMAIL",
    "  SOURCE_INTAKE_SMOKE_PASSWORD          login password; falls back to PRODUCTION_VALIDATION_ADMIN_PASSWORD or ADMIN_PASSWORD",
    "  SOURCE_INTAKE_SMOKE_HEADLESS          false to show Chromium, default true",
    "  SOURCE_INTAKE_SMOKE_PR_NUMBERS        comma-separated PR numbers covered by this validation run",
    "  DATABASE_URL                          required cleanup connection for source workflow/job suppression",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function parseSetCookie(setCookie) {
  assert(setCookie, "Missing session cookie.");
  return setCookie.split(", ").find((part) => part.includes("corgtex"))?.split(";")[0] ?? setCookie.split(";")[0];
}

function sourceIntakeAddRouteSuffix(workspacePath, {
  kind = "paste_text",
  returnTo = `${workspacePath}/settings?tab=data-sources`,
} = {}) {
  return `/add?kind=${encodeURIComponent(kind)}&returnTo=${encodeURIComponent(returnTo)}`;
}

function sourceIntakeRoutePath(workspaceId, options = {}) {
  const workspacePath = `/workspaces/${workspaceId}`;
  return `${workspacePath}${sourceIntakeAddRouteSuffix(workspacePath, options)}`;
}

function sourceIntakeScreenshotFileName(name) {
  return `${String(name).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}.png`;
}

function validationRecordPrefix(run, fallback) {
  if (run.prNumbers.length === 0) return `${fallback} ${run.runId}`;
  return productionValidationTag({
    date: run.startedAt,
    prNumber: run.prNumbers[0],
    runId: run.runId,
  });
}

function sourceIntakeHealthReleaseBlocker(health, expectedGitSha = null) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? healthConfiguredReleaseDrift(health, expectedGitSha);
}

function eventPayloadFilter(key, value) {
  return {
    payload: {
      path: [key],
      equals: value,
    },
  };
}

function workflowJobPayloadFilter(key, value) {
  return {
    payload: {
      path: [key],
      equals: value,
    },
  };
}

function sourceWorkflowEventWhere(workspaceId, sourceId) {
  return {
    workspaceId,
    OR: [
      { aggregateId: sourceId },
      eventPayloadFilter("sourceId", sourceId),
    ],
  };
}

function sourceWorkflowJobWhere(workspaceId, sourceId, eventIds = []) {
  return {
    workspaceId,
    OR: [
      eventIds.length > 0 ? { eventId: { in: eventIds } } : null,
      workflowJobPayloadFilter("sourceId", sourceId),
    ].filter(Boolean),
  };
}

function sourceAgentRunWhere(workspaceId, sourceId, jobIds = []) {
  return {
    workspaceId,
    OR: [
      jobIds.length > 0 ? { triggerRef: { in: jobIds } } : null,
      { planJson: { path: ["payload", "sourceId"], equals: sourceId } },
      { contextJson: { path: ["sourceId"], equals: sourceId } },
    ].filter(Boolean),
  };
}

function tagTextFilter(tag) {
  return [
    { title: { contains: tag } },
    { bodyMd: { contains: tag } },
  ];
}

function cleanupSummaryMessage(summary) {
  return [
    `${summary.eventsDeleted} event(s)`,
    `${summary.workflowJobsDeleted} workflow job(s)`,
    `${summary.agentRunsDeleted} agent run(s)`,
    `${summary.knowledgeChunksDeleted} knowledge chunk(s)`,
    `${summary.articleSourceRefsRemoved} article source ref(s)`,
    `${summary.brainArticlesDeleted} brain article(s)`,
    `${summary.contextGraphRecordsDeleted} context graph record(s)`,
    `${summary.companyUnderstandingRecordsDeleted} company-understanding record(s)`,
  ].join(", ");
}

function emptyCleanupSummary() {
  return {
    eventsDeleted: 0,
    workflowJobsDeleted: 0,
    workflowJobIds: [],
    runningOrCompletedWorkflowJobs: 0,
    agentRunsDeleted: 0,
    knowledgeChunksDeleted: 0,
    articleSourceRefsRemoved: 0,
    brainArticlesDeleted: 0,
    contextGraphRecordsDeleted: 0,
    companyUnderstandingRecordsDeleted: 0,
  };
}

function mergeCleanupSummaries(left, right) {
  return {
    eventsDeleted: left.eventsDeleted + right.eventsDeleted,
    workflowJobsDeleted: left.workflowJobsDeleted + right.workflowJobsDeleted,
    workflowJobIds: [...left.workflowJobIds, ...right.workflowJobIds],
    runningOrCompletedWorkflowJobs: left.runningOrCompletedWorkflowJobs + right.runningOrCompletedWorkflowJobs,
    agentRunsDeleted: left.agentRunsDeleted + right.agentRunsDeleted,
    knowledgeChunksDeleted: left.knowledgeChunksDeleted + right.knowledgeChunksDeleted,
    articleSourceRefsRemoved: left.articleSourceRefsRemoved + right.articleSourceRefsRemoved,
    brainArticlesDeleted: left.brainArticlesDeleted + right.brainArticlesDeleted,
    contextGraphRecordsDeleted: left.contextGraphRecordsDeleted + right.contextGraphRecordsDeleted,
    companyUnderstandingRecordsDeleted: left.companyUnderstandingRecordsDeleted + right.companyUnderstandingRecordsDeleted,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteSourceWorkflowArtifacts(prisma, { workspaceId, sourceId }) {
  const eventWhere = sourceWorkflowEventWhere(workspaceId, sourceId);
  const events = await prisma.event.findMany({
    where: eventWhere,
    select: { id: true },
  });
  const eventIds = events.map((event) => event.id);
  const jobWhere = sourceWorkflowJobWhere(workspaceId, sourceId, eventIds);
  const workflowJobs = await prisma.workflowJob.findMany({
    where: jobWhere,
    select: { id: true, status: true, type: true },
  });
  const workflowJobIds = workflowJobs.map((job) => job.id);

  if (workflowJobIds.length > 0) {
    await prisma.workflowJob.deleteMany({ where: { id: { in: workflowJobIds } } });
  }
  if (eventIds.length > 0) {
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  }

  return {
    eventsDeleted: eventIds.length,
    workflowJobsDeleted: workflowJobIds.length,
    workflowJobIds,
    runningOrCompletedWorkflowJobs: workflowJobs.filter((job) => job.status === "RUNNING" || job.status === "COMPLETED").length,
  };
}

async function cleanupSourceDerivedArtifacts(prisma, { workspaceId, sourceId, tag, workflowJobIds = [] }) {
  const agentRuns = await prisma.agentRun.findMany({
    where: sourceAgentRunWhere(workspaceId, sourceId, workflowJobIds),
    select: { id: true },
  });
  const agentRunIds = agentRuns.map((run) => run.id);

  const sourceKnowledge = await prisma.knowledgeChunk.deleteMany({
    where: { workspaceId, sourceId },
  });
  const contextGraphEvidence = await prisma.contextGraphEvidenceRef.deleteMany({
    where: { workspaceId, sourceId },
  });
  const contextGraphRelationships = await prisma.contextGraphRelationship.deleteMany({
    where: { workspaceId, sourceEntityId: sourceId },
  });
  const contextGraphObjects = await prisma.contextGraphObject.deleteMany({
    where: { workspaceId, sourceEntityId: sourceId },
  });

  let contextGraphDiffCount = 0;
  if (agentRunIds.length > 0) {
    const contextGraphDiffs = await prisma.contextGraphProposedDiff.deleteMany({
      where: { workspaceId, proposedByAgentRunId: { in: agentRunIds } },
    });
    contextGraphDiffCount += contextGraphDiffs.count;
  }

  const sourceQuestions = await prisma.checkIn.deleteMany({
    where: {
      workspaceId,
      relatedEntityType: "BrainSource",
      relatedEntityId: sourceId,
      questionSource: "company-understanding",
    },
  });

  const goalLinks = await prisma.goalLink.findMany({
    where: {
      entityType: "BrainSource",
      entityId: sourceId,
      source: "company-understanding",
    },
    select: { id: true, goalId: true },
  });
  const goalLinkIds = goalLinks.map((link) => link.id);
  if (goalLinkIds.length > 0) {
    await prisma.goalLink.deleteMany({ where: { id: { in: goalLinkIds } } });
  }

  const smokeTextFilters = tagTextFilter(tag);
  const smokeActions = await prisma.action.deleteMany({
    where: { workspaceId, OR: smokeTextFilters },
  });
  const smokeTensions = await prisma.tension.deleteMany({
    where: { workspaceId, OR: smokeTextFilters },
  });
  const smokeProposals = await prisma.proposal.findMany({
    where: {
      workspaceId,
      OR: [
        ...smokeTextFilters,
        { summary: { contains: tag } },
      ],
    },
    select: { id: true },
  });
  const proposalIds = smokeProposals.map((proposal) => proposal.id);
  if (proposalIds.length > 0) {
    await prisma.policyCorpus.deleteMany({ where: { proposalId: { in: proposalIds } } });
    await prisma.proposal.deleteMany({ where: { workspaceId, id: { in: proposalIds } } });
  }

  const articles = await prisma.brainArticle.findMany({
    where: { workspaceId, sourceIds: { has: sourceId } },
    select: { id: true, title: true, bodyMd: true, sourceIds: true },
  });
  let brainArticlesDeleted = 0;
  let articleSourceRefsRemoved = 0;
  for (const article of articles) {
    const isSmokeArticle = article.title.includes(tag) || article.bodyMd.includes(tag);
    if (isSmokeArticle && article.sourceIds.length <= 1) {
      await prisma.knowledgeChunk.deleteMany({ where: { workspaceId, sourceId: article.id } });
      await prisma.brainArticle.delete({ where: { id: article.id } });
      brainArticlesDeleted += 1;
      continue;
    }
    await prisma.brainArticle.update({
      where: { id: article.id },
      data: { sourceIds: article.sourceIds.filter((id) => id !== sourceId) },
    });
    articleSourceRefsRemoved += 1;
  }

  if (agentRunIds.length > 0) {
    await prisma.agentRun.deleteMany({ where: { workspaceId, id: { in: agentRunIds } } });
  }

  return {
    agentRunsDeleted: agentRunIds.length,
    knowledgeChunksDeleted: sourceKnowledge.count,
    articleSourceRefsRemoved,
    brainArticlesDeleted,
    contextGraphRecordsDeleted: contextGraphEvidence.count + contextGraphRelationships.count + contextGraphObjects.count + contextGraphDiffCount,
    companyUnderstandingRecordsDeleted: sourceQuestions.count + goalLinkIds.length + smokeActions.count + smokeTensions.count + proposalIds.length,
  };
}

async function cleanupSourceProcessingArtifacts(prisma, { workspaceId, sourceId, tag }) {
  const workflow = await deleteSourceWorkflowArtifacts(prisma, { workspaceId, sourceId });
  const derived = await cleanupSourceDerivedArtifacts(prisma, {
    workspaceId,
    sourceId,
    tag,
    workflowJobIds: workflow.workflowJobIds,
  });
  return {
    ...workflow,
    ...derived,
  };
}

async function countSourceWorkflowArtifacts(prisma, { workspaceId, sourceId }) {
  const events = await prisma.event.findMany({
    where: sourceWorkflowEventWhere(workspaceId, sourceId),
    select: { id: true },
  });
  const jobs = await prisma.workflowJob.findMany({
    where: sourceWorkflowJobWhere(workspaceId, sourceId, events.map((event) => event.id)),
    select: { id: true },
  });
  return { events: events.length, workflowJobs: jobs.length };
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return { text, body: null };
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: text };
  }
}

class SourceIntakeSmoke {
  constructor({
    baseUrl,
    outDir,
    expectedGitSha,
    workspaceSelector,
    authEmail,
    authPassword,
    headless,
    prNumbers,
    prisma = null,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSelector = workspaceSelector ?? validationWorkspaceSelectorFromEnv(process.env, "SOURCE_INTAKE_SMOKE");
    this.workspaceSlug = this.workspaceSelector.workspaceSlug || "corgtex-validation";
    this.authEmail = authEmail || null;
    this.authPassword = authPassword || null;
    this.headless = headless;
    this.runId = `source-intake-smoke-${Date.now().toString(36)}`;
    this.validationRun = createValidationRun({
      runId: this.runId,
      tenant: { slug: this.workspaceSlug, label: this.workspaceSlug },
      prNumbers,
      baseUrl: this.baseUrl,
      environment: "production",
      metadata: {
        script: "source-intake-production-smoke",
        workspaceSelector: this.workspaceSelector,
        strictInternalValidationWorkspace: true,
      },
    });
    this.cleanupRegistry = createValidationCleanupRegistry(this.validationRun);
    this.validationTag = validationRecordPrefix(this.validationRun, "source-intake-production-smoke");
    this.validationResultRecorded = false;
    this.cookie = null;
    this.workspace = null;
    this.demoWorkspace = null;
    this.results = [];
    this.prisma = prisma;
    this.ownsPrisma = false;
  }

  record(name, detail = {}) {
    this.results.push({ name, status: "ok", ...detail });
    console.log(`OK   ${name}`);
  }

  async request(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(url, { ...init, headers });
    const { text, body } = await readResponseBody(response);
    return { response, text, body, url };
  }

  async requestJson(pathOrUrl, init = {}) {
    const result = await this.request(pathOrUrl, init);
    if (!result.response.ok) {
      const detail = typeof result.body === "string" ? result.body.slice(0, 500) : JSON.stringify(result.body);
      throw new Error(`${init.method ?? "GET"} ${result.url} failed ${result.response.status}: ${detail}`);
    }
    return result;
  }

  async verifyHealth() {
    const { body } = await this.requestJson("/api/health");
    const blocker = sourceIntakeHealthReleaseBlocker(body, this.expectedGitSha);
    assert(!blocker, blocker);
    this.record("health release metadata", { gitSha: body?.release?.gitSha ?? null });
  }

  async login() {
    assert(
      this.authEmail && this.authPassword,
      "Source-intake validation requires SOURCE_INTAKE_SMOKE_EMAIL/PASSWORD, PRODUCTION_VALIDATION_ADMIN_EMAIL/PASSWORD, or ADMIN_EMAIL/PASSWORD.",
    );
    const login = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.authEmail, password: this.authPassword }),
      redirect: "manual",
    });
    const text = await login.text();
    assert(login.ok, `/api/auth/login failed ${login.status}: ${text.slice(0, 300)}`);
    this.cookie = parseSetCookie(login.headers.get("set-cookie"));

    const session = await this.requestJson("/api/session");
    const workspace = selectWorkspaceForValidation(session.body?.workspaces ?? [], {
      workspaceId: this.workspaceSelector.workspaceId,
      workspaceSlug: this.workspaceSlug,
      purpose: "source-intake production smoke",
    });
    requireInternalValidationWorkspace(workspace, {
      purpose: "source-intake production smoke writes",
    });

    this.workspace = workspace;
    this.demoWorkspace = (session.body?.workspaces ?? []).find((item) => item.slug === DEMO_WORKSPACE_SLUG) ?? null;
    this.validationRun.tenant = workspaceTenant(workspace);
    this.record("password login", {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug ?? null,
      demoWorkspaceId: this.demoWorkspace?.id ?? null,
    });
  }

  openDatabase() {
    if (this.prisma) return this.prisma;
    assert(
      process.env.DATABASE_URL,
      "DATABASE_URL is required so source-intake validation can suppress workflow jobs and clean temporary production records.",
    );
    this.prisma = new PrismaClient();
    this.ownsPrisma = true;
    return this.prisma;
  }

  async suppressSourceProcessing(sourceId, { reason }) {
    assert(this.workspace?.id, "Workspace must be selected before source workflow suppression.");
    const prisma = this.openDatabase();
    let summary = emptyCleanupSummary();
    for (let pass = 1; pass <= SOURCE_WORKFLOW_SUPPRESSION_PASSES; pass += 1) {
      const passSummary = await cleanupSourceProcessingArtifacts(prisma, {
        workspaceId: this.workspace.id,
        sourceId,
        tag: this.validationTag,
      });
      summary = mergeCleanupSummaries(summary, passSummary);
      if (pass < SOURCE_WORKFLOW_SUPPRESSION_PASSES) {
        await sleep(SOURCE_WORKFLOW_SUPPRESSION_DELAY_MS);
      }
    }
    this.results.push({
      name: "source workflow suppression",
      status: "ok",
      sourceId,
      reason,
      summary,
    });
    return summary;
  }

  async assertSourceWorkflowArtifactsCleared(sourceId) {
    assert(this.workspace?.id, "Workspace must be selected before source workflow artifact checks.");
    const prisma = this.openDatabase();
    const counts = await countSourceWorkflowArtifacts(prisma, {
      workspaceId: this.workspace.id,
      sourceId,
    });
    assert(
      counts.events === 0 && counts.workflowJobs === 0,
      `source workflow artifacts remained after cleanup: ${JSON.stringify(counts)}`,
    );
  }

  async assertRouteStatus({ name, path: routePath, expectedStatus, mustContain = null }) {
    const result = await this.request(routePath, {
      headers: {
        "user-agent": "corgtex-source-intake-smoke/1.0",
      },
    });
    const status = result.response.status;
    assert(
      status === expectedStatus,
      `${name} returned ${status}, expected ${expectedStatus}. Route: ${routePath}`,
    );
    if (mustContain) {
      assert(
        result.text.includes(mustContain),
        `${name} did not include expected text '${mustContain}'. Route: ${routePath}`,
      );
    }
    this.record(name, { route: routePath, status });
    return result;
  }

  async verifyRouteContracts() {
    assert(this.workspace?.id, "Workspace must be selected before route checks.");
    const workspacePath = `/workspaces/${this.workspace.id}`;

    await this.assertRouteStatus({
      name: "desktop paste-text source-intake route",
      path: sourceIntakeRoutePath(this.workspace.id, {
        kind: "paste_text",
        returnTo: `${workspacePath}/settings?tab=data-sources`,
      }),
      expectedStatus: 200,
      mustContain: "Ingest text",
    });
    await this.assertRouteStatus({
      name: "desktop upload-file source-intake route",
      path: sourceIntakeRoutePath(this.workspace.id, {
        kind: "upload_file",
        returnTo: `${workspacePath}/brain`,
      }),
      expectedStatus: 200,
      mustContain: "Upload files from this device",
    });
    await this.assertRouteStatus({
      name: "invalid source-intake kind guard",
      path: sourceIntakeRoutePath(this.workspace.id, {
        kind: "not_a_real_source_kind",
        returnTo: `${workspacePath}/brain`,
      }),
      expectedStatus: 404,
    });

    assert(
      this.demoWorkspace?.id,
      `The smoke account must be a member of ${DEMO_WORKSPACE_SLUG} to prove demo add/source guard behavior.`,
    );
    const demoWorkspacePath = `/workspaces/${this.demoWorkspace.id}`;
    await this.assertRouteStatus({
      name: "demo add/source guard",
      path: sourceIntakeRoutePath(this.demoWorkspace.id, {
        kind: "upload_file",
        returnTo: `${demoWorkspacePath}/brain`,
      }),
      expectedStatus: 404,
    });
  }

  async verifyMobilePasteTextRoute() {
    assert(this.workspace?.id, "Workspace must be selected before mobile route checks.");
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: this.headless });
    const screenshotName = sourceIntakeScreenshotFileName("mobile-paste-text-source-intake");
    const screenshotPath = path.join(this.outDir, screenshotName);
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        userAgent: "corgtex-source-intake-smoke/1.0 Mobile",
      });
      const [cookiePart] = this.cookie.split(";");
      const eq = cookiePart.indexOf("=");
      await context.addCookies([{ name: cookiePart.slice(0, eq), value: cookiePart.slice(eq + 1), url: this.baseUrl }]);
      const page = await context.newPage();
      const workspacePath = `/workspaces/${this.workspace.id}`;
      const targetPath = sourceIntakeRoutePath(this.workspace.id, {
        kind: "paste_text",
        returnTo: `${workspacePath}/settings?tab=data-sources`,
      });
      const response = await page.goto(`${this.baseUrl}${targetPath}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
      assert(response?.status() === 200, `mobile paste-text source-intake route returned ${response?.status() ?? 0}`);
      await page.locator("button", { hasText: /Ingest text|Ingest meeting transcript/ }).first().waitFor({
        state: "visible",
        timeout: 5000,
      });
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert(
        overflow.scrollWidth <= overflow.clientWidth + 2,
        `mobile source-intake route has horizontal overflow: ${JSON.stringify(overflow)}`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true, caret: "initial" });
      this.record("mobile paste-text source-intake route", {
        route: targetPath,
        screenshot: screenshotPath,
      });
    } finally {
      await browser.close().catch(() => null);
    }
  }

  async createTextSource() {
    assert(this.workspace?.id, "Workspace must be selected before source ingest.");
    this.openDatabase();
    const title = `${this.validationTag} source-intake text source`;
    const guidance = `Preserve source-intake validation guidance for ${this.validationTag}.`;
    const create = await this.requestJson(`/api/workspaces/${this.workspace.id}/data-sources/text-ingest`, {
      method: "POST",
      body: JSON.stringify({
        sourceType: "DOC",
        title,
        channel: "source-intake-production-smoke",
        content: `Temporary source-intake production validation content for ${this.validationTag}.`,
        ingestionGuidanceMd: ` ${guidance} `,
      }),
    });
    const source = create.body;
    assert(source?.id, "text-ingest did not return a BrainSource id.");

    const cleanupActionId = `archive:BrainSource:${source.id}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: "archive",
      target: { type: "BrainSource", id: source.id, label: title },
      runner: async () => {
        const beforeArchive = await this.suppressSourceProcessing(source.id, { reason: "cleanup-before-archive" });
        await this.requestJson(`/api/workspaces/${this.workspace.id}/brain/sources/${source.id}`, {
          method: "DELETE",
        });
        const afterArchive = await this.suppressSourceProcessing(source.id, { reason: "cleanup-after-archive" });
        await this.assertSourceWorkflowArtifactsCleared(source.id);
        const archived = await this.requestJson(`/api/workspaces/${this.workspace.id}/brain/sources?archiveFilter=archived&take=25`);
        const archivedSource = archived.body?.items?.find((item) => item.id === source.id);
        assert(archivedSource?.archivedAt, "BrainSource cleanup did not leave an archived source record.");
        return [
          "Temporary BrainSource archived through the source delete API.",
          `Suppressed before archive: ${cleanupSummaryMessage(beforeArchive)}.`,
          `Suppressed after archive: ${cleanupSummaryMessage(afterArchive)}.`,
        ].join(" ");
      },
    });
    await this.suppressSourceProcessing(source.id, { reason: "post-create-before-assertions" });

    assert(source.title === title, "text-ingest did not persist the expected title.");
    assert(source.ingestionGuidanceMd === guidance, "text-ingest did not persist trimmed ingestion guidance.");

    const activeSources = await this.requestJson(`/api/workspaces/${this.workspace.id}/brain/sources?take=25`);
    assert(
      activeSources.body?.items?.some((item) => item.id === source.id),
      "created source was not visible in active brain sources before cleanup.",
    );
    this.record("text source ingested", {
      sourceId: source.id,
      title,
      cleanupActionId,
    });
  }

  async cleanup() {
    let cleanupError = null;
    try {
      const cleanup = await this.cleanupRegistry.runAll({ throwOnFailure: false });
      for (const entry of [...cleanup.completed, ...cleanup.skipped]) {
        this.results.push({
          name: `cleanup ${entry.action}`,
          status: "ok",
          cleanupActionId: entry.id,
          target: entry.target,
          message: entry.message,
        });
      }
      for (const { entry, error } of cleanup.failed) {
        this.results.push({
          name: `cleanup ${entry.action}`,
          status: "failed",
          cleanupActionId: entry.id,
          target: entry.target,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (cleanup.failed.length > 0) {
        cleanupError = new Error(`Validation cleanup failed for ${cleanup.failed.map(({ entry }) => entry.id).join(", ")}`);
      }
    } finally {
      if (this.ownsPrisma && this.prisma) {
        await this.prisma.$disconnect();
        this.prisma = null;
        this.ownsPrisma = false;
      }
    }
    if (cleanupError) throw cleanupError;
  }

  recordValidationOutcome(status, error, smokeResultPath) {
    if (this.validationResultRecorded) return;
    this.validationResultRecorded = true;
    const coveredPrNumbers = this.validationRun.prNumbers.length > 0
      ? this.validationRun.prNumbers
      : [null];
    const screenshotEvidence = this.results
      .filter((item) => item.screenshot)
      .map((item) => ({
        type: "screenshot",
        path: item.screenshot,
        summary: item.name,
      }));

    for (const prNumber of coveredPrNumbers) {
      recordValidationResult(this.validationRun, {
        ...(prNumber ? { prNumber } : {}),
        intent: "Add/source-intake route contract, demo guard, internal validation write, mobile render, and cleanup",
        method: "source-intake-production-smoke",
        result: status === "passed" ? "pass" : "partial",
        blocker: status === "passed" ? null : (error?.message ?? "Source-intake production smoke failed."),
        evidence: [
          { type: "json", path: smokeResultPath, summary: "Source-intake production smoke output" },
          ...screenshotEvidence,
        ],
        createdRecordIds: this.validationRun.createdRecords.map((record) => record.id),
        cleanupActionIds: this.validationRun.cleanupActions.map((entry) => entry.id),
      });
    }
  }

  async writeResult(status, error = null) {
    await mkdir(this.outDir, { recursive: true });
    const smokeResultPath = path.join(this.outDir, "source-intake-production-smoke.json");
    this.recordValidationOutcome(status, error, smokeResultPath);
    const validationArtifacts = await writeValidationArtifacts(this.validationRun, this.outDir);
    await writeFile(smokeResultPath, `${JSON.stringify({
      status,
      runId: this.runId,
      baseUrl: this.baseUrl,
      workspaceId: this.workspace?.id ?? null,
      workspaceSlug: this.workspace?.slug ?? null,
      demoWorkspaceId: this.demoWorkspace?.id ?? null,
      checkedAt: new Date().toISOString(),
      results: this.results,
      validation: {
        run: this.validationRun,
        artifacts: validationArtifacts,
      },
      error: error ? { message: error.message, stack: error.stack } : null,
    }, null, 2)}\n`);
  }

  async run() {
    await mkdir(this.outDir, { recursive: true });
    await this.verifyHealth();
    await this.login();
    await this.verifyRouteContracts();
    await this.verifyMobilePasteTextRoute();
    await this.createTextSource();
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const [, , baseUrlArg, outDirArg] = process.argv;
  const workspaceSelector = validationWorkspaceSelectorFromEnv(process.env, "SOURCE_INTAKE_SMOKE");
  const smoke = new SourceIntakeSmoke({
    baseUrl: baseUrlArg || process.env.SOURCE_INTAKE_SMOKE_BASE_URL || DEFAULT_BASE_URL,
    outDir: outDirArg || process.env.SOURCE_INTAKE_SMOKE_OUT_DIR || DEFAULT_OUT_DIR,
    expectedGitSha: process.env.SOURCE_INTAKE_SMOKE_EXPECTED_GIT_SHA?.trim() || null,
    workspaceSelector,
    authEmail: process.env.SOURCE_INTAKE_SMOKE_EMAIL?.trim()
      || process.env.PRODUCTION_VALIDATION_ADMIN_EMAIL?.trim()
      || process.env.ADMIN_EMAIL?.trim()
      || null,
    authPassword: process.env.SOURCE_INTAKE_SMOKE_PASSWORD?.trim()
      || process.env.PRODUCTION_VALIDATION_ADMIN_PASSWORD?.trim()
      || process.env.ADMIN_PASSWORD?.trim()
      || null,
    headless: process.env.SOURCE_INTAKE_SMOKE_HEADLESS !== "false",
    prNumbers: parseValidationPrNumbers(process.env.SOURCE_INTAKE_SMOKE_PR_NUMBERS ?? process.env.PRODUCTION_VALIDATION_PR_NUMBERS),
  });

  let failed = false;
  let fatalError = null;
  try {
    await smoke.run();
  } catch (error) {
    failed = true;
    fatalError = error;
    console.error(error);
  } finally {
    try {
      await smoke.cleanup();
    } catch (error) {
      failed = true;
      fatalError ??= error;
      console.error(error);
    }
    await smoke.writeResult(failed ? "failed" : "passed", fatalError);
  }

  if (failed) process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  SourceIntakeSmoke,
  normalizeBaseUrl,
  parseSetCookie,
  sourceIntakeAddRouteSuffix,
  sourceIntakeHealthReleaseBlocker,
  sourceIntakeRoutePath,
  sourceIntakeScreenshotFileName,
  cleanupSourceProcessingArtifacts,
  countSourceWorkflowArtifacts,
  sourceWorkflowEventWhere,
  sourceWorkflowJobWhere,
  usage,
};
