#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
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
const DEFAULT_OUT_DIR = ".artifacts/recorder-readiness-production-smoke";
const DEFAULT_TARGETS = "managed-recorder-validation";
const HARD_BLOCKER_GATE_KEYS = new Set(["control_plane", "tenant_config", "vendor", "calendar"]);

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
    "  CONTROL_PLANE_AGENT_API_KEY                 required to read readiness from the deployed runtime",
    "  DATABASE_URL                                required production database connection for target resolution",
  ].join("\n");
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, "");
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

function deploymentLabels(deployment) {
  return [
    deployment.id,
    deployment.label,
    deployment.customerSlug,
    deployment.managedWorkspaceId,
    deployment.managedWorkspace?.id,
    deployment.managedWorkspace?.slug,
    deployment.managedWorkspace?.name,
  ].map(comparable).filter(Boolean);
}

export function deploymentMatchesRecorderReadinessTarget(deployment, target) {
  return recorderReadinessDeploymentMatchScore(deployment, target) > 0;
}

export function recorderReadinessDeploymentMatchScore(deployment, target) {
  const normalizedTarget = comparable(target);
  if (!normalizedTarget) return 0;
  if (comparable(deployment.id) === normalizedTarget) return 1_000;
  if (comparable(deployment.managedWorkspaceId) === normalizedTarget || comparable(deployment.managedWorkspace?.id) === normalizedTarget) return 950;
  if (comparable(deployment.managedWorkspace?.slug) === normalizedTarget) return 925;
  if (comparable(deployment.label) === normalizedTarget) return 900;
  if (comparable(deployment.managedWorkspace?.name) === normalizedTarget) return 875;
  if (comparable(deployment.customerSlug) !== normalizedTarget) return 0;

  let score = 700;
  if (deployment.customerAccount?.primaryDeploymentId === deployment.id) score += 200;
  if (deployment.deploymentStatus === "ACTIVE") score += 50;
  if (comparable(deployment.environment) === "production") score += 25;
  return score;
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

function tenantForDeployment(deployment, fallbackTarget) {
  return {
    id: deployment?.managedWorkspaceId ?? deployment?.managedWorkspace?.id ?? deployment?.id ?? null,
    slug: deployment?.managedWorkspace?.slug ?? deployment?.customerSlug ?? fallbackTarget,
    label: deployment?.label ?? deployment?.managedWorkspace?.name ?? fallbackTarget,
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
    throw new Error("Control Plane readiness response did not include JSON text content.");
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
    controlPlaneToken = process.env.CONTROL_PLANE_AGENT_API_KEY || null,
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir);
    this.targets = Array.isArray(targets)
      ? normalizeRecorderReadinessTargets(targets.join(","))
      : normalizeRecorderReadinessTargets(targets);
    this.expectedGitSha = expectedGitSha;
    this.controlPlaneToken = String(controlPlaneToken ?? "").trim();
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
      },
    });
  }

  recordResult({ target, deployment = null, readiness = null, result, blocker = null, evidence = [] }) {
    const tenant = tenantForDeployment(deployment, target);
    const intent = `Recorder readiness contract for ${tenant.label}: control-plane, tenant config, vendor, calendar, scheduled meetings, and live vendor proof`;
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
      });
    }
    this.details.push({
      target,
      deployment: deployment
        ? {
          id: deployment.id,
          label: deployment.label,
          customerSlug: deployment.customerSlug,
          managedWorkspaceId: deployment.managedWorkspaceId,
          managedWorkspaceSlug: deployment.managedWorkspace?.slug ?? null,
          supportConnectorStatus: deployment.supportConnectorStatus ?? null,
        }
        : null,
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

  async loadDeployments(prisma) {
    return prisma.customerDeployment.findMany({
      orderBy: { label: "asc" },
      select: {
        id: true,
        label: true,
        customerSlug: true,
        managedWorkspaceId: true,
        supportConnectorStatus: true,
        deploymentStatus: true,
        environment: true,
        customerAccount: {
          select: {
            primaryDeploymentId: true,
          },
        },
        managedWorkspace: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
    });
  }

  async fetchReadinessFromDeployedRuntime(deploymentId) {
    const response = await fetch(`${this.baseUrl}/api/control-plane/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer cp-${this.controlPlaneToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${this.runId}-${deploymentId}`,
        method: "tools/call",
        params: {
          name: "check_meeting_operations_readiness",
          arguments: { deploymentId },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Control Plane readiness request returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    if (body.error) {
      throw new Error(body.error.message ?? "Control Plane readiness request failed.");
    }
    return textContentJson(body);
  }

  async run() {
    await mkdir(this.outDir, { recursive: true });
    let prisma = null;
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

      if (!this.hardFailure && !process.env.DATABASE_URL) {
        this.recordBlockedForAllTargets("PRODUCTION_DATABASE_URL/DATABASE_URL is required for read-only control-plane recorder readiness.");
      }

      if (!this.hardFailure && !this.controlPlaneToken) {
        this.recordBlockedForAllTargets("CONTROL_PLANE_AGENT_API_KEY is required to read recorder readiness from the deployed runtime.");
      }

      if (!this.hardFailure && this.validationRun.results.length === 0) {
        const shared = await import("@corgtex/shared");
        prisma = shared.prisma;
        const deployments = await this.loadDeployments(prisma);
        const resolved = resolveRecorderReadinessTargets(deployments, this.targets);

        for (const item of resolved) {
          if (!item.deployment) {
            this.recordResult({
              target: item.target,
              result: "blocked",
              blocker: `No CustomerDeployment matched recorder readiness target "${item.target}".`,
            });
            continue;
          }

          try {
            const readiness = await this.fetchReadinessFromDeployedRuntime(item.deployment.id);
            const outcome = recorderReadinessValidationOutcome(readiness.recorder);
            this.recordResult({
              target: item.target,
              deployment: item.deployment,
              readiness,
              result: outcome.result,
              blocker: outcome.blocker,
              evidence: [
                { type: "deployment", summary: `CustomerDeployment ${item.deployment.id}` },
                { type: "readiness-gates", path: detailsPath, summary: `${outcome.gates.length} recorder readiness gate(s) evaluated.` },
              ],
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
      await writeFile(detailsPath, `${JSON.stringify({
        runId: this.runId,
        targets: this.targets,
        expectedGitSha: this.expectedGitSha,
        details: this.details,
        error: this.hardFailure ? { message: this.hardFailure.message, stack: this.hardFailure.stack } : null,
      }, null, 2)}\n`);
      await writeValidationArtifacts(this.validationRun, this.outDir, {
        jsonFileName: "recorder-readiness-production-smoke.matrix.json",
        markdownFileName: "recorder-readiness-production-smoke.report.md",
      });
      if (typeof prisma?.$disconnect === "function") {
        await prisma.$disconnect();
      }
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
