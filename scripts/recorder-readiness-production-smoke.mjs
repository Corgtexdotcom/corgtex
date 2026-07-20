#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  parseValidationPrNumbers,
  recordArtifact,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  healthConfiguredReleaseDrift,
  healthReleaseMismatch,
} from "./lib/release-health-validation.mjs";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_CONTROL_PLANE_URL = "https://ops.corgtex.com";
const DEFAULT_OUT_DIR = ".artifacts/recorder-readiness-production-smoke";
const DEFAULT_TARGETS = "managed-recorder-validation";
const HARD_BLOCKER_GATE_KEYS = new Set(["control_plane", "tenant_config", "vendor", "calendar"]);
const DEFAULT_TEMP_MEETING_LEAD_MINUTES = 120;
const DEFAULT_TEMP_MEETING_DURATION_MINUTES = 30;

function usage() {
  return [
    "usage: npx tsx scripts/recorder-readiness-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs read-only production recorder readiness validation for customer deployments.",
    "",
    "Environment:",
    "  RECORDER_READINESS_SMOKE_DEPLOYMENTS        comma-separated deployment ids, slugs, labels, or managed workspace slugs",
    "  RECORDER_READINESS_SMOKE_EXPECTED_GIT_SHA   optional /api/health release SHA to require",
    "  RECORDER_READINESS_SMOKE_PR_NUMBERS         comma-separated PR numbers covered by this validation run",
    "  RECORDER_READINESS_SMOKE_TEMP_MEETINGS      true to create and clean up tagged temporary Corgtex scheduled meetings when needed",
    "  RECORDER_READINESS_SMOKE_TEMP_MEETING_URL   supported live meeting URL used only when temp meetings are enabled",
    "  RECORDER_READINESS_SMOKE_TEMP_JOIN_AT       optional timezone-aware future ISO timestamp for temp meetings",
    "  RECORDER_READINESS_SMOKE_PROVIDER           optional RECALL_AI or MEETING_BAAS override for temp recorder scheduling",
    "  CONTROL_PLANE_URL                           optional control-plane URL; defaults to https://ops.corgtex.com",
    "  CONTROL_PLANE_AGENT_API_KEY                 required to read inventory and readiness from the control plane",
  ].join("\n");
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Math.round(parsed);
}

function parseOptionalFutureDate(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  if (parsed <= new Date()) {
    throw new Error(`${label} must be in the future.`);
  }
  return parsed;
}

function normalizeProvider(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw === "RECALL_AI" || raw === "MEETING_BAAS") return raw;
  throw new Error("RECORDER_READINESS_SMOKE_PROVIDER must be RECALL_AI or MEETING_BAAS.");
}

function validationRunLabel(prNumbers, runId, date = new Date()) {
  const datePart = date.toISOString().slice(0, 10);
  const prPart = prNumbers.length > 0
    ? `PR-${prNumbers.join("-")}`
    : "PR-unscoped";
  return `PROD-VERIFY ${datePart} ${prPart} ${runId}`;
}

export function normalizeTempMeetingSetup(input = {}, now = new Date()) {
  const enabled = booleanOption(input.enabled, false);
  if (!enabled) {
    return {
      enabled: false,
      meetingUrl: "",
      joinAt: null,
      scheduledEndAt: null,
      durationMinutes: null,
      provider: null,
    };
  }
  const leadMinutes = parsePositiveInteger(input.leadMinutes, DEFAULT_TEMP_MEETING_LEAD_MINUTES, "temp meeting lead minutes");
  const durationMinutes = parsePositiveInteger(input.durationMinutes, DEFAULT_TEMP_MEETING_DURATION_MINUTES, "temp meeting duration minutes");
  const fallbackJoinAt = new Date(now.getTime() + leadMinutes * 60_000);
  const joinAt = parseOptionalFutureDate(input.joinAt, fallbackJoinAt, "temp meeting joinAt");
  const scheduledEndAt = new Date(joinAt.getTime() + durationMinutes * 60_000);
  const meetingUrl = String(input.meetingUrl ?? "").trim();
  if (meetingUrl) {
    try {
      const url = new URL(meetingUrl);
      if (url.protocol !== "https:") throw new Error("not https");
    } catch {
      throw new Error("RECORDER_READINESS_SMOKE_TEMP_MEETING_URL must be a valid https URL.");
    }
  }
  return {
    enabled,
    meetingUrl,
    joinAt,
    scheduledEndAt,
    durationMinutes,
    provider: normalizeProvider(input.provider),
  };
}

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function normalizeControlPlaneUrl(value) {
  return String(value || DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, "");
}

export function normalizeRecorderReadinessTargets(value = DEFAULT_TARGETS) {
  const targets = String(value || DEFAULT_TARGETS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(targets.length ? targets : DEFAULT_TARGETS.split(","))];
}

function comparable(value) {
  return String(value ?? "").trim().toLowerCase();
}

function comparableUrlParts(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  try {
    const url = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
    return [
      url.origin,
      url.hostname,
      url.hostname.replace(/\.corgtex\.com$/, ""),
      url.href.replace(/\/$/, ""),
    ].map(comparable).filter(Boolean);
  } catch {
    return [normalized.replace(/^https?:\/\//i, "").replace(/\/$/, "")].map(comparable).filter(Boolean);
  }
}

function fieldMatchesTarget(target, ...values) {
  const normalizedTarget = comparable(target);
  return values.some((value) => comparable(value) === normalizedTarget);
}

function urlFieldMatchesTarget(target, ...values) {
  const normalizedTarget = comparable(target);
  const targetParts = new Set(comparableUrlParts(target));
  return values.some((value) => {
    const valueParts = new Set([
      comparable(value),
      ...comparableUrlParts(value),
    ].filter(Boolean));
    return valueParts.has(normalizedTarget) || [...targetParts].some((part) => valueParts.has(part));
  });
}

function recorderReadinessDeploymentOperationalScore(deployment) {
  let score = 0;
  const primaryDeploymentId = deployment.primaryDeploymentId ?? deployment.customerAccount?.primaryDeploymentId ?? null;
  if (primaryDeploymentId === deployment.id) score += 400;

  switch (comparable(deployment.deploymentStatus)) {
    case "active":
      score += 250;
      break;
    case "degraded":
      score += 75;
      break;
    case "bootstrapping":
    case "provisioning":
      score += 25;
      break;
    case "draft":
      score -= 100;
      break;
    case "retired":
    case "suspended":
      score -= 700;
      break;
    default:
      break;
  }

  switch (comparable(deployment.provisioningStatus)) {
    case "active":
    case "completed":
    case "deployed":
    case "provisioned":
    case "ready":
      score += 75;
      break;
    case "draft":
      score -= 50;
      break;
    case "archived":
    case "retired":
    case "suspended":
      score -= 700;
      break;
    default:
      break;
  }

  if (comparable(deployment.environment) === "production") score += 100;

  switch (comparable(deployment.lastHealthStatus)) {
    case "healthy":
    case "ok":
    case "pass":
    case "ready":
    case "up":
      score += 50;
      break;
    case "down":
    case "error":
    case "failed":
    case "unhealthy":
      score -= 100;
      break;
    default:
      break;
  }

  switch (comparable(deployment.supportConnectorStatus)) {
    case "connected":
    case "managed":
    case "ready":
      score += 25;
      break;
    case "not_configured":
      score -= 25;
      break;
    default:
      break;
  }

  return score;
}

function recorderReadinessDeploymentScore(baseScore, deployment) {
  return Math.max(1, baseScore + recorderReadinessDeploymentOperationalScore(deployment));
}

export function deploymentMatchesRecorderReadinessTarget(deployment, target) {
  return recorderReadinessDeploymentMatchScore(deployment, target) > 0;
}

export function recorderReadinessDeploymentMatchScore(deployment, target) {
  const normalizedTarget = comparable(target);
  if (!normalizedTarget) return 0;
  if (deployment.hasDeployment === false) return 0;
  if (fieldMatchesTarget(target, deployment.id)) return 10_000;
  if (fieldMatchesTarget(target, deployment.managedWorkspaceId, deployment.managedWorkspace?.id)) {
    return recorderReadinessDeploymentScore(950, deployment);
  }
  if (fieldMatchesTarget(target, deployment.managedWorkspaceSlug, deployment.managedWorkspace?.slug)) {
    return recorderReadinessDeploymentScore(925, deployment);
  }
  if (fieldMatchesTarget(target, deployment.label)) {
    return recorderReadinessDeploymentScore(900, deployment);
  }
  if (fieldMatchesTarget(target, deployment.managedWorkspaceName, deployment.managedWorkspace?.name)) {
    return recorderReadinessDeploymentScore(875, deployment);
  }
  if (fieldMatchesTarget(target, deployment.remoteWorkspaceId)) {
    return recorderReadinessDeploymentScore(850, deployment);
  }
  if (fieldMatchesTarget(target, deployment.remoteWorkspaceSlug)) {
    return recorderReadinessDeploymentScore(825, deployment);
  }
  if (urlFieldMatchesTarget(target, deployment.customDomain)) {
    return recorderReadinessDeploymentScore(800, deployment);
  }
  if (urlFieldMatchesTarget(target, deployment.url)) {
    return recorderReadinessDeploymentScore(775, deployment);
  }
  if (fieldMatchesTarget(target, deployment.customerSlug)) {
    return recorderReadinessDeploymentScore(700, deployment);
  }
  return 0;
}

export function resolveRecorderReadinessTargets(deployments, targets) {
  return targets.map((target) => {
    const deployment = deployments
      .map((candidate) => ({ candidate, score: recorderReadinessDeploymentMatchScore(candidate, target) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || comparable(left.candidate.label).localeCompare(comparable(right.candidate.label)))[0]?.candidate ?? null;
    return { target, deployment };
  });
}

export function recorderReadinessHealthReleaseBlocker(health, expectedGitSha = null) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? healthConfiguredReleaseDrift(health, expectedGitSha);
}

export function recorderReadinessGateList(recorder) {
  const gates = recorder?.gates;
  if (!gates || typeof gates !== "object") return [];
  return Object.values(gates)
    .filter((gate) => gate && typeof gate === "object" && typeof gate.key === "string")
    .map((gate) => ({
      key: String(gate.key),
      label: String(gate.label ?? gate.key),
      status: String(gate.status ?? "unknown"),
      detail: String(gate.detail ?? "No detail recorded."),
      checks: Array.isArray(gate.checks) ? gate.checks : [],
    }));
}

function summarizeGates(gates) {
  return gates
    .map((gate) => `${gate.label}: ${gate.detail}`)
    .slice(0, 4)
    .join(" ");
}

export function recorderReadinessValidationOutcome(recorder) {
  const gates = recorderReadinessGateList(recorder);
  if (gates.length === 0) {
    return {
      result: "partial",
      blocker: "Recorder readiness response did not include normalized readiness gates.",
      gates,
    };
  }

  const hardBlocked = gates.filter((gate) => gate.status === "blocked" && HARD_BLOCKER_GATE_KEYS.has(gate.key));
  if (hardBlocked.length > 0) {
    return {
      result: "blocked",
      blocker: summarizeGates(hardBlocked),
      gates,
    };
  }

  const liveVendorProof = gates.find((gate) => gate.key === "live_vendor_proof");
  if (!liveVendorProof || liveVendorProof.status !== "pass") {
    return {
      result: "partial",
      blocker: liveVendorProof
        ? `Live vendor proof: ${liveVendorProof.detail}`
        : "Live vendor proof gate was not returned.",
      gates,
    };
  }

  const meetingState = gates.find((gate) => gate.key === "meeting_state");
  if (meetingState?.status === "blocked") {
    return {
      result: "partial",
      blocker: `Scheduled meetings: ${meetingState.detail}`,
      gates,
    };
  }

  const unknown = gates.filter((gate) => gate.status === "unknown");
  if (unknown.length > 0) {
    return {
      result: "partial",
      blocker: summarizeGates(unknown),
      gates,
    };
  }

  return { result: "pass", blocker: null, gates };
}

export function recorderReadinessCanUseTempMeetingSetup(outcome) {
  const gates = Array.isArray(outcome?.gates) ? outcome.gates : [];
  if (outcome?.result === "pass") return false;
  const blockedHardGates = gates.filter((gate) => gate.status === "blocked" && HARD_BLOCKER_GATE_KEYS.has(gate.key));
  if (blockedHardGates.some((gate) => gate.key !== "calendar")) return false;
  return gates.some((gate) => gate.key === "calendar" && gate.status === "blocked")
    || gates.some((gate) => gate.key === "live_vendor_proof" && gate.status !== "pass");
}

function tenantForDeployment(deployment, fallbackTarget) {
  return {
    id: deployment?.managedWorkspaceId ?? deployment?.managedWorkspace?.id ?? deployment?.id ?? null,
    slug: deployment?.managedWorkspaceSlug ?? deployment?.managedWorkspace?.slug ?? deployment?.customerSlug ?? fallbackTarget,
    label: deployment?.label ?? deployment?.managedWorkspaceName ?? deployment?.managedWorkspace?.name ?? fallbackTarget,
  };
}

function compactGateForArtifact(gate) {
  return {
    key: gate.key,
    label: gate.label,
    status: gate.status,
    detail: gate.detail,
    checks: (gate.checks ?? []).map((check) => ({
      key: check.key,
      label: check.label,
      status: check.status,
      detail: check.detail,
    })),
  };
}

export function sanitizeRecorderReadinessForArtifact(readiness) {
  const recorder = readiness?.recorder ?? {};
  const gates = recorderReadinessGateList(recorder).map(compactGateForArtifact);
  return {
    deploymentId: readiness?.deploymentId ?? null,
    managedWorkspaceId: readiness?.managedWorkspaceId ?? null,
    accessMode: readiness?.accessMode ?? null,
    agenda: readiness?.agenda
      ? {
        status: readiness.agenda.status ?? null,
        ready: readiness.agenda.ready ?? null,
        detail: readiness.agenda.detail ?? null,
      }
      : null,
    recorder: {
      status: recorder.status ?? null,
      ready: recorder.ready ?? null,
      configured: recorder.configured ?? null,
      provider: recorder.provider ?? null,
      fallbackProvider: recorder.fallbackProvider ?? null,
      detail: recorder.detail ?? null,
      failedChecks: (recorder.failedChecks ?? []).map((check) => ({
        key: check.key,
        label: check.label,
        detail: check.detail,
      })),
      gates: Object.fromEntries(gates.map((gate) => [gate.key, gate])),
      upcomingCoverage: recorder.upcomingCoverage
        ? {
          window: recorder.upcomingCoverage.window ?? null,
          counts: recorder.upcomingCoverage.counts ?? null,
        }
        : null,
      lastSmokeRun: recorder.lastSmokeRun
        ? {
          status: recorder.lastSmokeRun.status ?? null,
          createdAt: recorder.lastSmokeRun.createdAt ?? null,
          completedAt: recorder.lastSmokeRun.completedAt ?? null,
        }
        : null,
      lastSuccessfulRecording: recorder.lastSuccessfulRecording
        ? {
          provider: recorder.lastSuccessfulRecording.provider ?? null,
          status: recorder.lastSuccessfulRecording.status ?? null,
          observedAt: recorder.lastSuccessfulRecording.observedAt ?? null,
        }
        : null,
      lastProviderAuthFailure: recorder.lastProviderAuthFailure
        ? {
          provider: recorder.lastProviderAuthFailure.provider ?? null,
          status: recorder.lastProviderAuthFailure.status ?? null,
          failureCode: recorder.lastProviderAuthFailure.failureCode ?? null,
          detail: recorder.lastProviderAuthFailure.detail ?? null,
          updatedAt: recorder.lastProviderAuthFailure.updatedAt ?? null,
        }
        : null,
    },
  };
}

function textContentJson(body) {
  const text = body?.result?.content?.find?.((item) => item?.type === "text")?.text;
  if (!text) {
    throw new Error("Control Plane response did not include JSON text content.");
  }
  return JSON.parse(text);
}

async function fetchHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/api/health`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`/api/health returned HTTP ${response.status}.`);
  }
  return response.json();
}

export class RecorderReadinessProductionSmoke {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    outDir = DEFAULT_OUT_DIR,
    targets = normalizeRecorderReadinessTargets(process.env.RECORDER_READINESS_SMOKE_DEPLOYMENTS),
    expectedGitSha = process.env.RECORDER_READINESS_SMOKE_EXPECTED_GIT_SHA || process.env.PRODUCTION_VALIDATION_EXPECTED_GIT_SHA || null,
    prNumbers = parseValidationPrNumbers(process.env.RECORDER_READINESS_SMOKE_PR_NUMBERS || process.env.PRODUCTION_VALIDATION_PR_NUMBERS || ""),
    controlPlaneUrl = process.env.CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL,
    controlPlaneToken = process.env.CONTROL_PLANE_AGENT_API_KEY || null,
    tempMeetingSetup = {
      enabled: process.env.RECORDER_READINESS_SMOKE_TEMP_MEETINGS,
      meetingUrl: process.env.RECORDER_READINESS_SMOKE_TEMP_MEETING_URL || process.env.PRODUCTION_VALIDATION_RECORDER_MEETING_URL,
      joinAt: process.env.RECORDER_READINESS_SMOKE_TEMP_JOIN_AT,
      durationMinutes: process.env.RECORDER_READINESS_SMOKE_TEMP_DURATION_MINUTES,
      provider: process.env.RECORDER_READINESS_SMOKE_PROVIDER,
    },
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.controlPlaneUrl = normalizeControlPlaneUrl(controlPlaneUrl);
    this.outDir = path.resolve(outDir);
    this.targets = Array.isArray(targets)
      ? normalizeRecorderReadinessTargets(targets.join(","))
      : normalizeRecorderReadinessTargets(targets);
    this.expectedGitSha = expectedGitSha;
    this.controlPlaneToken = String(controlPlaneToken ?? "").trim();
    this.tempMeetingSetupError = null;
    try {
      this.tempMeetingSetup = normalizeTempMeetingSetup(tempMeetingSetup);
    } catch (error) {
      this.tempMeetingSetup = { enabled: true, meetingUrl: "", joinAt: null, scheduledEndAt: null, durationMinutes: null, provider: null };
      this.tempMeetingSetupError = error instanceof Error ? error.message : String(error);
    }
    this.runId = `recorder-readiness-${Date.now().toString(36)}`;
    this.details = [];
    this.hardFailure = null;
    this.validationRun = createValidationRun({
      runId: this.runId,
      tenant: { slug: "fleet-recorder-readiness", label: "Fleet recorder readiness" },
      prNumbers,
      baseUrl: this.baseUrl,
      environment: "production",
      metadata: {
        script: "recorder-readiness-production-smoke",
        targets: this.targets,
        controlPlaneUrl: this.controlPlaneUrl,
        tempMeetingSetup: {
          enabled: Boolean(this.tempMeetingSetup.enabled),
          hasMeetingUrl: Boolean(this.tempMeetingSetup.meetingUrl),
          provider: this.tempMeetingSetup.provider ?? null,
        },
      },
    });
    this.cleanup = createValidationCleanupRegistry(this.validationRun);
  }

  recordResult({
    target,
    deployment = null,
    readiness = null,
    result,
    blocker = null,
    evidence = [],
    createdRecordIds = [],
    cleanupActionIds = [],
    temporarySetup = null,
  }) {
    const tenant = tenantForDeployment(deployment, target);
    const intent = `Recorder readiness contract for ${tenant.label}: control-plane, tenant config, vendor, Corgtex recording schedule, scheduled meetings, and live vendor proof`;
    const resultPrNumbers = this.validationRun.prNumbers.length > 0 ? this.validationRun.prNumbers : [null];
    for (const prNumber of resultPrNumbers) {
      recordValidationResult(this.validationRun, {
        ...(prNumber ? { prNumber } : {}),
        intent,
        tenant,
        method: "recorder-readiness-production-smoke",
        result,
        blocker,
        evidence,
        createdRecordIds,
        cleanupActionIds,
      });
    }
    this.details.push({
      target,
      deployment: deployment
        ? {
          id: deployment.id,
          label: deployment.label,
          customerSlug: deployment.customerSlug,
          url: deployment.url ?? null,
          customDomain: deployment.customDomain ?? null,
          deploymentStatus: deployment.deploymentStatus ?? null,
          environment: deployment.environment ?? null,
          provisioningStatus: deployment.provisioningStatus ?? null,
          lastHealthStatus: deployment.lastHealthStatus ?? null,
          remoteWorkspaceSlug: deployment.remoteWorkspaceSlug ?? null,
          managedWorkspaceId: deployment.managedWorkspaceId,
          managedWorkspaceSlug: deployment.managedWorkspaceSlug ?? deployment.managedWorkspace?.slug ?? null,
          managedWorkspaceName: deployment.managedWorkspaceName ?? deployment.managedWorkspace?.name ?? null,
          supportAccessMode: deployment.supportAccessMode ?? null,
          supportConnectorStatus: deployment.supportConnectorStatus ?? null,
        }
        : null,
      temporarySetup,
      result,
      blocker,
      readiness: readiness ? sanitizeRecorderReadinessForArtifact(readiness) : null,
    });
  }

  recordBlockedForAllTargets(blocker, { hard = false, evidence = [] } = {}) {
    for (const target of this.targets) {
      this.recordResult({
        target,
        result: "blocked",
        blocker,
        evidence,
      });
    }
    if (hard) this.hardFailure = new Error(blocker);
  }

  async fetchControlPlaneTool(name, args = {}) {
    const response = await fetch(`${this.controlPlaneUrl}/api/control-plane/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer cp-${this.controlPlaneToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${this.runId}-${name}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Control Plane ${name} request returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    if (body.error) {
      throw new Error(body.error.message ?? `Control Plane ${name} request failed.`);
    }
    return textContentJson(body);
  }

  async loadDeployments() {
    const deployments = await this.fetchControlPlaneTool("list_customers", { includeAllDeployments: true, uncapped: true });
    if (!Array.isArray(deployments)) {
      throw new Error("Control Plane list_customers response did not return an array.");
    }
    return deployments;
  }

  async fetchReadinessFromControlPlane(deploymentId) {
    return this.fetchControlPlaneTool("check_meeting_operations_readiness", { deploymentId });
  }

  async runSupportOperation(deployment, action, reason, args = {}) {
    const operation = await this.fetchControlPlaneTool("run_customer_support_operation", {
      deploymentId: deployment.id,
      action,
      reason,
      arguments: args,
    });
    if (operation?.status && operation.status !== "COMPLETED") {
      throw new Error(`${action} support operation finished with ${operation.status}.`);
    }
    return operation;
  }

  async setupTemporaryMeeting(deployment) {
    if (!this.tempMeetingSetup.enabled) return null;
    if (!this.tempMeetingSetup.meetingUrl) {
      throw new Error("RECORDER_READINESS_SMOKE_TEMP_MEETING_URL is required when temporary recorder setup is needed.");
    }
    const tenant = tenantForDeployment(deployment, deployment.id);
    const label = validationRunLabel(this.validationRun.prNumbers, this.runId);
    const setup = {
      enabled: true,
      label,
      createdRecordIds: [],
      cleanupActionIds: [],
      supportOperationIds: [],
    };
    const reason = `${label}: recorder readiness temporary scheduled meeting setup.`;
    const scheduled = await this.runSupportOperation(deployment, "meetings.schedule", reason, {
      title: label,
      description: "Temporary production validation meeting. Created by recorder readiness smoke; safe to archive during cleanup.",
      startsAt: this.tempMeetingSetup.joinAt.toISOString(),
      scheduledEndAt: this.tempMeetingSetup.scheduledEndAt.toISOString(),
      meetingUrl: this.tempMeetingSetup.meetingUrl,
      participantEmails: [],
    });
    setup.supportOperationIds.push(scheduled.id);
    const summary = scheduled.resultSummary && typeof scheduled.resultSummary === "object"
      ? scheduled.resultSummary
      : {};
    const meetingId = typeof summary.firstMeetingId === "string"
      ? summary.firstMeetingId
      : Array.isArray(summary.meetingIds) && typeof summary.meetingIds[0] === "string"
        ? summary.meetingIds[0]
        : null;
    if (!meetingId) {
      throw new Error("Temporary scheduled meeting operation did not return a meeting id.");
    }
    setup.createdRecordIds.push(meetingId);

    const archiveCleanup = this.cleanup.add({
      action: "archive-temporary-meeting",
      target: { type: "Meeting", id: meetingId, label },
      tenant,
      runner: async () => {
        const archive = await this.runSupportOperation(deployment, "meetings.archive", `${label}: archive recorder readiness temporary meeting.`, { meetingId });
        return { message: `Archived temporary meeting through support operation ${archive.id}.` };
      },
    });
    setup.cleanupActionIds.push(archiveCleanup.id);

    const scheduleArgs = {
      meetingId,
      ...(this.tempMeetingSetup.provider ? { provider: this.tempMeetingSetup.provider } : {}),
    };
    const recorder = await this.runSupportOperation(deployment, "meeting_recorders.schedule_meeting", `${label}: schedule recorder for temporary meeting.`, scheduleArgs);
    setup.supportOperationIds.push(recorder.id);
    const recorderSummary = recorder.resultSummary && typeof recorder.resultSummary === "object"
      ? recorder.resultSummary
      : {};
    const recordingStatus = recorderSummary.recording && typeof recorderSummary.recording === "object"
      ? String(recorderSummary.recording.status ?? "")
      : "";
    if (recordingStatus === "FAILED") {
      throw new Error(`Temporary recorder scheduling failed${recorderSummary.recording?.failureCode ? `: ${recorderSummary.recording.failureCode}` : "."}`);
    }
    if (recordingStatus) {
      const cancelCleanup = this.cleanup.add({
        action: "cancel-temporary-recorder",
        target: { type: "MeetingRecording", id: meetingId, label },
        tenant,
        recordCreated: false,
        runner: async () => {
          try {
            const cancel = await this.runSupportOperation(deployment, "meeting_recorders.cancel", `${label}: cancel recorder for temporary meeting.`, { meetingId });
            return { message: `Cancelled temporary recorder through support operation ${cancel.id}.` };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/No active recorder is scheduled|NOT_FOUND/i.test(message)) {
              return { message: "No active temporary recorder remained during cleanup." };
            }
            throw error;
          }
        },
      });
      setup.cleanupActionIds.push(cancelCleanup.id);
    }

    return setup;
  }

  async run() {
    await mkdir(this.outDir, { recursive: true });
    const detailsPath = path.join(this.outDir, "recorder-readiness-production-smoke.json");
    recordArtifact(this.validationRun, {
      type: "readiness-json",
      path: detailsPath,
      summary: "Recorder readiness gate details",
    });

    try {
      const health = await fetchHealth(this.baseUrl);
      const releaseBlocker = recorderReadinessHealthReleaseBlocker(health, this.expectedGitSha);
      if (releaseBlocker) {
        this.recordBlockedForAllTargets(releaseBlocker, {
          hard: true,
          evidence: [{ type: "health", summary: `/api/health release validation failed: ${releaseBlocker}` }],
        });
      }

      if (!this.hardFailure && !this.controlPlaneToken) {
        this.recordBlockedForAllTargets("CONTROL_PLANE_AGENT_API_KEY is required to read recorder readiness from the control plane.");
      }

      if (!this.hardFailure && this.tempMeetingSetupError) {
        this.recordBlockedForAllTargets(this.tempMeetingSetupError);
      }

      if (!this.hardFailure && this.validationRun.results.length === 0) {
        const deployments = await this.loadDeployments();
        const resolved = resolveRecorderReadinessTargets(deployments, this.targets);

        for (const item of resolved) {
          if (!item.deployment) {
            this.recordResult({
              target: item.target,
              result: "blocked",
              blocker: `No control-plane deployment matched recorder readiness target "${item.target}". See the private readiness artifact for available identifiers.`,
            });
            continue;
          }

          try {
            let readiness = await this.fetchReadinessFromControlPlane(item.deployment.id);
            let outcome = recorderReadinessValidationOutcome(readiness.recorder);
            let temporarySetup = null;
            const evidence = [
              { type: "deployment", summary: `CustomerDeployment ${item.deployment.id}` },
              { type: "readiness-gates", path: detailsPath, summary: `${outcome.gates.length} recorder readiness gate(s) evaluated.` },
            ];

            if (
              outcome.result !== "pass"
              && this.tempMeetingSetup.enabled
              && recorderReadinessCanUseTempMeetingSetup(outcome)
            ) {
              temporarySetup = await this.setupTemporaryMeeting(item.deployment);
              readiness = await this.fetchReadinessFromControlPlane(item.deployment.id);
              outcome = recorderReadinessValidationOutcome(readiness.recorder);
              evidence.push({
                type: "temporary-setup",
                summary: `Created a tagged Corgtex scheduled meeting and scheduled recorder coverage through ${temporarySetup.supportOperationIds.length} audited support operation(s); cleanup is recorded in this artifact.`,
              });
            }

            this.recordResult({
              target: item.target,
              deployment: item.deployment,
              readiness,
              result: outcome.result,
              blocker: outcome.blocker,
              evidence,
              createdRecordIds: temporarySetup?.createdRecordIds ?? [],
              cleanupActionIds: temporarySetup?.cleanupActionIds ?? [],
              temporarySetup,
            });
          } catch (error) {
            const blocker = error instanceof Error ? error.message : String(error);
            this.recordResult({
              target: item.target,
              deployment: item.deployment,
              result: "blocked",
              blocker,
              evidence: [{ type: "runtime-error", summary: blocker }],
            });
          }
        }
      }
    } catch (error) {
      const blocker = error instanceof Error ? error.message : String(error);
      this.recordBlockedForAllTargets(blocker, { hard: true });
    } finally {
      await this.cleanup.runAll({ throwOnFailure: false });
      await writeFile(detailsPath, `${JSON.stringify({
        runId: this.runId,
        targets: this.targets,
        expectedGitSha: this.expectedGitSha,
        controlPlaneUrl: this.controlPlaneUrl,
        details: this.details,
        error: this.hardFailure ? { message: this.hardFailure.message, stack: this.hardFailure.stack } : null,
      }, null, 2)}\n`);
      await writeValidationArtifacts(this.validationRun, this.outDir, {
        jsonFileName: "recorder-readiness-production-smoke.matrix.json",
        markdownFileName: "recorder-readiness-production-smoke.report.md",
      });
    }

    if (this.hardFailure) throw this.hardFailure;
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const smoke = new RecorderReadinessProductionSmoke({
    baseUrl: process.argv[2] || DEFAULT_BASE_URL,
    outDir: process.argv[3] || DEFAULT_OUT_DIR,
    targets: normalizeRecorderReadinessTargets(process.env.RECORDER_READINESS_SMOKE_DEPLOYMENTS || DEFAULT_TARGETS),
  });
  await smoke.run();
  console.log(`Recorder readiness validation artifacts written to ${smoke.outDir}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
