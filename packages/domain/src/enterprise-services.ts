import { Prisma } from "@prisma/client";
import type {
  EnterpriseServiceHealthStatus,
  EnterpriseServiceOwnershipMode,
  WorkspaceEnterpriseService,
} from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  ENTERPRISE_SERVICE_DB_VALUES,
  ENTERPRISE_SERVICE_REGISTRY,
  enterpriseServiceToDb,
  isEnterpriseServiceKey,
  listEnterpriseServices,
  requireEnterpriseService,
  type EnterpriseServiceKey,
} from "./ai-workspaces";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { getMeetingRecorderEnterpriseServiceSnapshot } from "./meeting-recorders";

export type EnterpriseServiceReadinessCheckView = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type WorkspaceEnterpriseServiceState = {
  key: EnterpriseServiceKey;
  label: string;
  outcome: string;
  description: string;
  defaultOwnershipMode: EnterpriseServiceOwnershipMode;
  persistedId: string | null;
  ownershipMode: EnterpriseServiceOwnershipMode;
  healthStatus: EnterpriseServiceHealthStatus;
  providerKey: string | null;
  lastHealthCheckAt: Date | null;
  lastSuccessfulHealthCheckAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastError: string | null;
  usageJson: unknown;
  usageLabel: string | null;
  usageDetail: string | null;
  supportEscalationStatus: string | null;
  supportEscalatedAt: Date | null;
  supportNotesMd: string | null;
  readinessChecks: EnterpriseServiceReadinessCheckView[];
};

const SERVICE_KEYS_BY_DB_VALUE = Object.fromEntries(
  Object.entries(ENTERPRISE_SERVICE_DB_VALUES).map(([key, value]) => [value, key]),
) as Record<string, EnterpriseServiceKey>;

function enterpriseServiceKeyFromDb(value: string): EnterpriseServiceKey | null {
  const key = SERVICE_KEYS_BY_DB_VALUE[value];
  return key && isEnterpriseServiceKey(key) ? key : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function serviceUsageSummary(key: EnterpriseServiceKey, usageJson: unknown) {
  if (key !== "meeting_recorder" || !isRecord(usageJson)) return { label: null, detail: null };
  const recorder = isRecord(usageJson.recorder) ? usageJson.recorder : null;
  if (!recorder) return { label: null, detail: null };
  const usedMinutes = typeof recorder.usedMinutes === "number" ? recorder.usedMinutes : null;
  const cap = typeof recorder.monthlyMinuteCap === "number" ? recorder.monthlyMinuteCap : null;
  if (usedMinutes === null) return { label: null, detail: null };
  return {
    label: `${usedMinutes} min this month`,
    detail: cap === null ? `${usedMinutes} recorder minutes used in the current billing period.` : `${usedMinutes} of ${cap} recorder minutes used in the current billing period.`,
  };
}

function baseState(row: WorkspaceEnterpriseService | null, key: EnterpriseServiceKey): WorkspaceEnterpriseServiceState {
  const definition = ENTERPRISE_SERVICE_REGISTRY[key];
  const usage = serviceUsageSummary(key, row?.usageJson);

  return {
    key,
    label: definition.label,
    outcome: definition.outcome,
    description: definition.description,
    defaultOwnershipMode: definition.defaultOwnershipMode,
    persistedId: row?.id ?? null,
    ownershipMode: row?.ownershipMode ?? definition.defaultOwnershipMode,
    healthStatus: row?.healthStatus ?? "NEEDS_SETUP",
    providerKey: row?.providerKey ?? null,
    lastHealthCheckAt: row?.lastHealthCheckAt ?? null,
    lastSuccessfulHealthCheckAt: row?.lastSuccessfulHealthCheckAt ?? null,
    lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt ?? null,
    lastError: row?.lastError ?? null,
    usageJson: row?.usageJson ?? null,
    usageLabel: usage.label,
    usageDetail: usage.detail,
    supportEscalationStatus: row?.supportEscalationStatus ?? null,
    supportEscalatedAt: row?.supportEscalatedAt ?? null,
    supportNotesMd: row?.supportNotesMd ?? null,
    readinessChecks: [],
  };
}

function applyRecorderSnapshot(
  state: WorkspaceEnterpriseServiceState,
  snapshot: Awaited<ReturnType<typeof getMeetingRecorderEnterpriseServiceSnapshot>>,
) {
  return {
    ...state,
    ownershipMode: state.persistedId ? state.ownershipMode : snapshot.ownershipMode,
    healthStatus: snapshot.healthStatus,
    providerKey: snapshot.providerKey,
    lastHealthCheckAt: snapshot.lastHealthCheckAt,
    lastSuccessfulHealthCheckAt: snapshot.lastSuccessfulHealthCheckAt,
    lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
    lastError: snapshot.lastError,
    usageJson: snapshot.usageJson,
    usageLabel: snapshot.usageLabel,
    usageDetail: snapshot.usageDetail,
    readinessChecks: snapshot.readinessChecks,
  };
}

export async function listWorkspaceEnterpriseServiceStates(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const [rows, recorderSnapshot] = await Promise.all([
    prisma.workspaceEnterpriseService.findMany({
      where: { workspaceId },
      orderBy: { serviceKey: "asc" },
    }),
    getMeetingRecorderEnterpriseServiceSnapshot(workspaceId).catch(() => null),
  ]);
  const rowsByKey = new Map<EnterpriseServiceKey, WorkspaceEnterpriseService>();
  for (const row of rows) {
    const key = enterpriseServiceKeyFromDb(row.serviceKey);
    if (key) rowsByKey.set(key, row);
  }

  return listEnterpriseServices().map((definition) => {
    const state = baseState(rowsByKey.get(definition.key) ?? null, definition.key);
    if (definition.key === "meeting_recorder" && recorderSnapshot) {
      return applyRecorderSnapshot(state, recorderSnapshot);
    }
    return state;
  });
}

export async function requestManagedEnterpriseService(actor: AppActor, params: {
  workspaceId: string;
  serviceKey: EnterpriseServiceKey;
  noteMd?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const definition = requireEnterpriseService(params.serviceKey);
  const note = params.noteMd?.trim() || null;
  const dbServiceKey = enterpriseServiceToDb(params.serviceKey);

  return prisma.$transaction(async (tx) => {
    const service = await tx.workspaceEnterpriseService.upsert({
      where: {
        workspaceId_serviceKey: {
          workspaceId: params.workspaceId,
          serviceKey: dbServiceKey,
        },
      },
      update: {
        ownershipMode: "CORGTEX_MANAGED",
        displayName: definition.label,
        healthStatus: "NEEDS_SETUP",
        supportEscalationStatus: "REQUESTED",
        supportEscalatedAt: new Date(),
        supportNotesMd: note,
      },
      create: {
        workspaceId: params.workspaceId,
        serviceKey: dbServiceKey,
        ownershipMode: "CORGTEX_MANAGED",
        displayName: definition.label,
        healthStatus: "NEEDS_SETUP",
        supportEscalationStatus: "REQUESTED",
        supportEscalatedAt: new Date(),
        supportNotesMd: note,
      },
    });

    await recordAudit(tx as Prisma.TransactionClient, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_service.request_managed",
      entityType: "workspace_enterprise_service",
      entityId: service.id,
      meta: {
        serviceKey: params.serviceKey,
        ownershipMode: "CORGTEX_MANAGED",
        supportEscalationStatus: "REQUESTED",
      },
    });

    return service;
  });
}
