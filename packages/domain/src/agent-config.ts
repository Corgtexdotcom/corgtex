import { env, prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AGENT_REGISTRY, type RegisteredAgentKey } from "./agent-registry";
import { AppError } from "./errors";
import type { MemberKind, NewspaperCadence, Prisma } from "@prisma/client";
import { isHumanMemberIdentity } from "./member-identity";

export type AgentConfigSummary = {
  agentKey: RegisteredAgentKey;
  label: string;
  description: string;
  category: string;
  canDisable: boolean;
  costTier: "free" | "low" | "medium" | "high" | "very-high";
  defaultModelTier: "fast" | "standard" | "quality" | "excellent" | "none";
  inputs: readonly string[];
  outputs: readonly string[];
  enabled: boolean;
  modelOverride: string | null;
  governancePolicy: string | null;
  configJson: any;
};

export const DEFAULT_NEWSPAPER_CADENCE: NewspaperCadence = "WEEKLY";
export type NewspaperWeekday = "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
export const DEFAULT_NEWSPAPER_WEEKDAY: NewspaperWeekday = "MONDAY";
export const DEFAULT_NEWSPAPER_LOCAL_TIME = "08:00";
export const DEFAULT_NEWSPAPER_TIME_ZONE = "UTC";
const NEWSPAPER_CADENCES = new Set<NewspaperCadence>(["DAILY", "WEEKLY", "OFF"]);
const NEWSPAPER_WEEKDAYS = new Set<NewspaperWeekday>([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
export type CompanyUnderstandingGoalApplyMode = "AUTO" | "MANUAL";
export const DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE: CompanyUnderstandingGoalApplyMode = "AUTO";
const COMPANY_UNDERSTANDING_GOAL_APPLY_MODES = new Set<CompanyUnderstandingGoalApplyMode>(["AUTO", "MANUAL"]);
const DEFAULT_SLACK_AGENT_CONFIG = {
  publicIngestionEnabled: true,
  rawMessageRetentionDays: 3650,
  proactiveEnabled: true,
  proactiveConfidenceThreshold: 0.9,
  unansweredFollowupDelayMinutes: 1440,
  unansweredActionCreationDelayMinutes: 1440,
  staleActionFollowupDelayMinutes: 4320,
  mutedChannelIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAzureDirectProvider() {
  return env.MODEL_PROVIDER === "azure-openai" || env.MODEL_PROVIDER === "azure-foundry";
}

function configuredProviderRouteModels() {
  const raw = env.MODEL_PROVIDER_ROUTES_JSON;
  if (!raw) {
    return new Set<string>();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(500, "CONFIGURATION_ERROR", "MODEL_PROVIDER_ROUTES_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(500, "CONFIGURATION_ERROR", "MODEL_PROVIDER_ROUTES_JSON must be an array.");
  }

  return new Set(parsed.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const model = entry.model;
    return typeof model === "string" && model.trim() ? [model.trim()] : [];
  }));
}

function assertAgentModelOverrideSupported(modelOverride: string | null | undefined) {
  if (
    modelOverride
    && isAzureDirectProvider()
    && modelOverride.includes("/")
    && !configuredProviderRouteModels().has(modelOverride)
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      `Model override ${modelOverride} is not configured for direct Azure routing. Clear the override or add an explicit MODEL_PROVIDER_ROUTES_JSON route before enabling Azure model traffic.`,
    );
  }
}

export function normalizeNewspaperCadence(value: unknown, fallback: NewspaperCadence = DEFAULT_NEWSPAPER_CADENCE): NewspaperCadence {
  return typeof value === "string" && NEWSPAPER_CADENCES.has(value as NewspaperCadence)
    ? value as NewspaperCadence
    : fallback;
}

export type NewspaperScheduleConfig = {
  cadence: NewspaperCadence;
  weekday: NewspaperWeekday;
  localTime: string;
  timeZone: string;
};

function normalizeNewspaperWeekday(value: unknown, fallback: NewspaperWeekday = DEFAULT_NEWSPAPER_WEEKDAY): NewspaperWeekday {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return NEWSPAPER_WEEKDAYS.has(normalized as NewspaperWeekday)
    ? normalized as NewspaperWeekday
    : fallback;
}

function normalizeNewspaperLocalTime(value: unknown, fallback = DEFAULT_NEWSPAPER_LOCAL_TIME) {
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return fallback;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

const newspaperTimeZoneValidity = new Map<string, boolean>();

function isValidTimeZone(value: string) {
  const known = newspaperTimeZoneValidity.get(value);
  if (known !== undefined) return known;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    newspaperTimeZoneValidity.set(value, true);
    return true;
  } catch {
    newspaperTimeZoneValidity.set(value, false);
    return false;
  }
}

function normalizeNewspaperTimeZone(value: unknown, fallback = DEFAULT_NEWSPAPER_TIME_ZONE) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed && isValidTimeZone(trimmed) ? trimmed : fallback;
}

export function normalizeNewspaperScheduleConfig(configJson: unknown): NewspaperScheduleConfig {
  const config = isRecord(configJson) ? configJson : {};
  return {
    cadence: normalizeNewspaperCadence(config.newspaperCadence),
    weekday: normalizeNewspaperWeekday(config.newspaperWeekday),
    localTime: normalizeNewspaperLocalTime(config.newspaperLocalTime),
    timeZone: normalizeNewspaperTimeZone(config.newspaperTimeZone),
  };
}

const newspaperFormatters = new Map<string, Intl.DateTimeFormat>();

export function getNewspaperLocalDateParts(now: Date, timeZone: string) {
  const normalizedTimeZone = normalizeNewspaperTimeZone(timeZone);
  let formatter = newspaperFormatters.get(normalizedTimeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: normalizedTimeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    newspaperFormatters.set(normalizedTimeZone, formatter);
  }
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = normalizeNewspaperWeekday(parts.get("weekday"));
  return {
    dateKey: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    weekday,
    hour: Number(parts.get("hour") ?? "0"),
    minute: Number(parts.get("minute") ?? "0"),
    timeZone: normalizedTimeZone,
  };
}

function newspaperScheduledInstant(dateKey: string, localTime: string, timeZone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const wallClockUTC = Date.UTC(year, month - 1, day, hour, minute);
  const localAt = (timestamp: number) => getNewspaperLocalDateParts(new Date(timestamp), timeZone);
  const offsets = new Set<number>();
  for (const sample of [wallClockUTC - 24 * 60 * 60_000, wallClockUTC, wallClockUTC + 24 * 60 * 60_000]) {
    const local = localAt(sample);
    const [localYear, localMonth, localDay] = local.dateKey.split("-").map(Number);
    offsets.add(Date.UTC(localYear, localMonth - 1, localDay, local.hour, local.minute) - sample);
  }
  const candidates = [...offsets].map((offset) => wallClockUTC - offset).sort((a, b) => a - b);
  const exact = candidates.find((timestamp) => {
    const local = localAt(timestamp);
    return local.dateKey === dateKey && local.hour === hour && local.minute === minute;
  });
  if (exact !== undefined) return new Date(exact);

  // In a spring gap use the first representable local instant after the requested
  // wall time. A wholly skipped local date has no occurrence.
  if (candidates.length < 2) return null;
  let low = Math.floor(candidates[0] / 60_000);
  let high = Math.ceil(candidates.at(-1)! / 60_000);
  const atOrAfter = (timestamp: number) => {
    const local = localAt(timestamp);
    return local.dateKey > dateKey || (local.dateKey === dateKey
      && (local.hour > hour || (local.hour === hour && local.minute >= minute)));
  };
  if (atOrAfter(low * 60_000) || !atOrAfter(high * 60_000)) return null;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (atOrAfter(middle * 60_000)) high = middle;
    else low = middle;
  }
  return localAt(high * 60_000).dateKey === dateKey ? new Date(high * 60_000) : null;
}

/** A five-minute scheduler retains same-day late eligibility and carries an
 * occurrence across local midnight for at most fifteen minutes. */
export function getNewspaperDueOccurrence(params: {
  now: Date;
  schedule: NewspaperScheduleConfig;
  cadence: Exclude<NewspaperCadence, "OFF">;
}) {
  const currentDateKey = getNewspaperLocalDateParts(params.now, params.schedule.timeZone).dateKey;
  const [year, month, day] = currentDateKey.split("-").map(Number);
  const previousDateKey = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
  for (const dateKey of [previousDateKey, currentDateKey]) {
    const weekday = (["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const)[
      new Date(`${dateKey}T12:00:00Z`).getUTCDay()
    ];
    if (params.cadence === "WEEKLY" && weekday !== params.schedule.weekday) continue;
    const scheduledAt = newspaperScheduledInstant(dateKey, params.schedule.localTime, params.schedule.timeZone);
    if (!scheduledAt || scheduledAt > params.now) continue;
    if (dateKey !== currentDateKey && params.now.getTime() - scheduledAt.getTime() > 15 * 60_000) continue;
    return { scheduledAt, dateKey, cadence: params.cadence };
  }
  return null;
}

export function isNewspaperScheduleDue(params: {
  now: Date;
  schedule: NewspaperScheduleConfig;
  cadence: Exclude<NewspaperCadence, "OFF">;
}) {
  const local = getNewspaperLocalDateParts(params.now, params.schedule.timeZone);
  const [scheduleHour, scheduleMinute] = params.schedule.localTime.split(":").map((part) => Number(part));
  const isAfterLocalSendTime = local.hour > scheduleHour || (local.hour === scheduleHour && local.minute >= scheduleMinute);
  if (!isAfterLocalSendTime) return false;
  if (params.cadence === "DAILY") return true;
  return local.weekday === params.schedule.weekday;
}

export function getNextNewspaperRunISO(params: {
  from: Date;
  schedule: NewspaperScheduleConfig;
  cadence?: NewspaperCadence;
}) {
  const cadence = params.cadence ?? params.schedule.cadence;
  if (cadence === "OFF") return null;

  const stepMs = 15 * 60 * 1000;
  let cursor = new Date(Math.ceil(params.from.getTime() / stepMs) * stepMs);
  const horizon = new Date(params.from.getTime() + 15 * 24 * 60 * 60 * 1000);
  while (cursor <= horizon) {
    if (isNewspaperScheduleDue({ now: cursor, schedule: params.schedule, cadence })) {
      return cursor.toISOString();
    }
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return null;
}

export function isHumanNewspaperRecipientIdentity(identity: {
  kind?: MemberKind | null;
  user?: { email?: string | null; displayName?: string | null } | null;
  email?: string | null;
  displayName?: string | null;
}) {
  const user = identity.user ?? identity;
  if (!user.email?.trim()) return false;
  return isHumanMemberIdentity(identity);
}

export function normalizeCompanyUnderstandingGoalApplyMode(
  value: unknown,
  fallback: CompanyUnderstandingGoalApplyMode = DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE,
): CompanyUnderstandingGoalApplyMode {
  return typeof value === "string" && COMPANY_UNDERSTANDING_GOAL_APPLY_MODES.has(value as CompanyUnderstandingGoalApplyMode)
    ? value as CompanyUnderstandingGoalApplyMode
    : fallback;
}

function normalizeAgentConfigJson(agentKey: string, configJson: unknown): Prisma.InputJsonObject {
  const config = isRecord(configJson) ? { ...configJson } : {};

  if (agentKey === "daily-digest") {
    const schedule = normalizeNewspaperScheduleConfig(config);
    config.newspaperCadence = schedule.cadence;
    config.newspaperWeekday = schedule.weekday;
    config.newspaperLocalTime = schedule.localTime;
    config.newspaperTimeZone = schedule.timeZone;
  }
  if (agentKey === "company-understanding") {
    config.goalApplyMode = normalizeCompanyUnderstandingGoalApplyMode(config.goalApplyMode);
  }
  if (agentKey === "slack-agent") {
    const mutedChannelIds = Array.isArray(config.mutedChannelIds)
      ? config.mutedChannelIds.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean)
      : DEFAULT_SLACK_AGENT_CONFIG.mutedChannelIds;
    return toInputJson({
      ...DEFAULT_SLACK_AGENT_CONFIG,
      ...config,
      proactiveConfidenceThreshold: typeof config.proactiveConfidenceThreshold === "number"
        ? Math.max(0, Math.min(1, config.proactiveConfidenceThreshold))
        : DEFAULT_SLACK_AGENT_CONFIG.proactiveConfidenceThreshold,
      unansweredFollowupDelayMinutes: typeof config.unansweredFollowupDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.unansweredFollowupDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.unansweredFollowupDelayMinutes,
      unansweredActionCreationDelayMinutes: typeof config.unansweredActionCreationDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.unansweredActionCreationDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.unansweredActionCreationDelayMinutes,
      staleActionFollowupDelayMinutes: typeof config.staleActionFollowupDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.staleActionFollowupDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.staleActionFollowupDelayMinutes,
      mutedChannelIds,
    }) as Prisma.InputJsonObject;
  }

  return toInputJson(config) as Prisma.InputJsonObject;
}

function defaultConfigJson(agentKey: string) {
  if (agentKey === "slack-agent") return DEFAULT_SLACK_AGENT_CONFIG;
  if (agentKey === "company-understanding") {
    return { goalApplyMode: DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE };
  }
  if (agentKey === "daily-digest") {
    return {
      newspaperCadence: DEFAULT_NEWSPAPER_CADENCE,
      newspaperWeekday: DEFAULT_NEWSPAPER_WEEKDAY,
      newspaperLocalTime: DEFAULT_NEWSPAPER_LOCAL_TIME,
      newspaperTimeZone: DEFAULT_NEWSPAPER_TIME_ZONE,
    };
  }
  return {};
}

export async function listAgentConfigs(actor: AppActor, workspaceId: string): Promise<AgentConfigSummary[]> {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  const overrides = await prisma.workspaceAgentConfig.findMany({
    where: { workspaceId },
  });

  const overrideMap = new Map(overrides.map((o) => [o.agentKey, o]));

  const summaries: AgentConfigSummary[] = [];

  for (const [key, meta] of Object.entries(AGENT_REGISTRY)) {
    const override = overrideMap.get(key);
    const configJson = override
      ? normalizeAgentConfigJson(key, override.configJson)
      : defaultConfigJson(key);
    summaries.push({
      agentKey: key as RegisteredAgentKey,
      label: meta.label,
      description: meta.description,
      category: meta.category,
      canDisable: meta.canDisable,
      costTier: meta.costTier,
      defaultModelTier: meta.defaultModelTier,
      inputs: meta.inputs,
      outputs: meta.outputs,
      enabled: override?.enabled ?? ("defaultEnabled" in meta ? meta.defaultEnabled : true),
      modelOverride: override?.modelOverride ?? null,
      governancePolicy: override?.governancePolicy ?? null,
      configJson,
    });
  }

  return summaries;
}

export async function updateAgentConfig(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentKey: string;
    enabled?: boolean;
    modelOverride?: string | null;
    governancePolicy?: string | null;
    configJson?: any;
  }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const meta = AGENT_REGISTRY[params.agentKey as RegisteredAgentKey];
  if (!meta) {
    throw new AppError(400, "INVALID_INPUT", `Unknown agent: ${params.agentKey}`);
  }

  if (params.enabled === false && !meta.canDisable) {
    throw new AppError(400, "INVALID_INPUT", `Agent ${params.agentKey} cannot be disabled.`);
  }

  assertAgentModelOverrideSupported(params.modelOverride);

  const configJson = params.configJson === undefined
    ? undefined
    : normalizeAgentConfigJson(params.agentKey, params.configJson);

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: params.agentKey,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: params.agentKey,
      enabled: params.enabled ?? ("defaultEnabled" in meta ? meta.defaultEnabled : true),
      modelOverride: params.modelOverride ?? null,
      governancePolicy: params.governancePolicy ?? null,
      configJson: configJson ?? {},
    },
    update: {
      ...(params.enabled !== undefined && { enabled: params.enabled }),
      ...(params.modelOverride !== undefined && { modelOverride: params.modelOverride }),
      ...(params.governancePolicy !== undefined && { governancePolicy: params.governancePolicy }),
      ...(configJson !== undefined && { configJson }),
    },
  });
}

export async function getWorkspaceNewspaperCadence(workspaceId: string): Promise<NewspaperCadence> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey: "daily-digest" },
    },
    select: { configJson: true },
  });

  return normalizeNewspaperScheduleConfig(config?.configJson).cadence;
}

export async function getCompanyUnderstandingGoalApplyMode(
  workspaceId: string,
): Promise<CompanyUnderstandingGoalApplyMode> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey: "company-understanding" },
    },
    select: { configJson: true },
  });

  return normalizeCompanyUnderstandingGoalApplyMode(
    isRecord(config?.configJson) ? config.configJson.goalApplyMode : undefined,
  );
}

export type WorkspaceDigestSetting = {
  enabled: boolean;
  disabledReason?: "ai_paused";
} & NewspaperScheduleConfig;

/**
 * Batched equivalent of calling `isAgentEnabled(id, "daily-digest")` and
 * `getWorkspaceNewspaperCadence(id)` for many workspaces at once. Issues a
 * single `workspaceAgentConfig.findMany` rather than two `findUnique`
 * round-trips per workspace, while preserving identical semantics: the
 * registry `canDisable` handling from `isAgentEnabled` and the
 * `normalizeNewspaperCadence` fallback from `getWorkspaceNewspaperCadence`.
 * Workspaces with no config row default to enabled + DEFAULT_NEWSPAPER_CADENCE.
 */
export async function getWorkspaceDigestSettings(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceDigestSetting>> {
  const settings = new Map<string, WorkspaceDigestSetting>();
  if (workspaceIds.length === 0) {
    return settings;
  }

  const meta = AGENT_REGISTRY["daily-digest" as RegisteredAgentKey];
  const canDisable = meta?.canDisable ?? true;

  const [configs, budgets] = await Promise.all([
    prisma.workspaceAgentConfig.findMany({
      where: { agentKey: "daily-digest", workspaceId: { in: workspaceIds }, archivedAt: null },
      select: { workspaceId: true, enabled: true, configJson: true },
    }),
    prisma.modelUsageBudget.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { workspaceId: true, monthlyCostCapUsd: true },
    }),
  ]);
  const aiPausedWorkspaceIds = new Set(
    budgets
      .filter((budget) => Number(budget.monthlyCostCapUsd) === 0)
      .map((budget) => budget.workspaceId),
  );
  const configByWorkspace = new Map(configs.map((config) => [config.workspaceId, config]));

  for (const workspaceId of workspaceIds) {
    const config = configByWorkspace.get(workspaceId);
    const schedule = normalizeNewspaperScheduleConfig(config?.configJson);
    const agentEnabled = canDisable ? (config?.enabled ?? true) : true;
    const aiPaused = agentEnabled && aiPausedWorkspaceIds.has(workspaceId);
    settings.set(workspaceId, {
      enabled: agentEnabled && !aiPaused,
      ...(aiPaused ? { disabledReason: "ai_paused" as const } : {}),
      ...schedule,
    });
  }

  return settings;
}

export async function updateWorkspaceNewspaperSchedule(
  actor: AppActor,
  params: {
    workspaceId: string;
    cadence?: NewspaperCadence;
    weekday?: NewspaperWeekday;
    localTime?: string;
    timeZone?: string;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const existing = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId: params.workspaceId, agentKey: "daily-digest" },
    },
    select: { configJson: true },
  });
  const currentConfig = isRecord(existing?.configJson)
    ? existing.configJson as Prisma.InputJsonObject
    : {};
  const currentSchedule = normalizeNewspaperScheduleConfig(currentConfig);
  const schedule = normalizeNewspaperScheduleConfig({
    ...currentConfig,
    newspaperCadence: params.cadence === undefined
      ? currentSchedule.cadence
      : normalizeNewspaperCadence(params.cadence, currentSchedule.cadence),
    newspaperWeekday: params.weekday === undefined
      ? currentSchedule.weekday
      : normalizeNewspaperWeekday(params.weekday, currentSchedule.weekday),
    newspaperLocalTime: params.localTime === undefined
      ? currentSchedule.localTime
      : normalizeNewspaperLocalTime(params.localTime, currentSchedule.localTime),
    newspaperTimeZone: params.timeZone === undefined
      ? currentSchedule.timeZone
      : normalizeNewspaperTimeZone(params.timeZone, currentSchedule.timeZone),
  });
  const configJson = toInputJson({
    ...currentConfig,
    newspaperCadence: schedule.cadence,
    newspaperWeekday: schedule.weekday,
    newspaperLocalTime: schedule.localTime,
    newspaperTimeZone: schedule.timeZone,
  }) as Prisma.InputJsonObject;

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: "daily-digest",
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: "daily-digest",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      configJson,
    },
    update: {
      configJson,
    },
  });
}

export async function updateWorkspaceNewspaperCadence(
  actor: AppActor,
  params: {
    workspaceId: string;
    cadence: NewspaperCadence;
  },
) {
  return updateWorkspaceNewspaperSchedule(actor, params);
}

export async function updateCompanyUnderstandingGoalApplyMode(
  actor: AppActor,
  params: {
    workspaceId: string;
    mode: CompanyUnderstandingGoalApplyMode;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const mode = normalizeCompanyUnderstandingGoalApplyMode(params.mode);
  const existing = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId: params.workspaceId, agentKey: "company-understanding" },
    },
    select: { configJson: true },
  });
  const currentConfig = isRecord(existing?.configJson)
    ? existing.configJson as Prisma.InputJsonObject
    : {};
  const configJson = toInputJson({
    ...currentConfig,
    goalApplyMode: mode,
  }) as Prisma.InputJsonObject;

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: "company-understanding",
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: "company-understanding",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      configJson,
    },
    update: {
      configJson,
    },
  });
}

export async function isAgentEnabled(workspaceId: string, agentKey: string): Promise<boolean> {
  const meta = AGENT_REGISTRY[agentKey as RegisteredAgentKey];
  if (meta && !meta.canDisable) {
    return true;
  }

  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { enabled: true },
  });

  return config?.enabled ?? (meta && "defaultEnabled" in meta ? meta.defaultEnabled : true);
}

export async function getAgentModelOverride(workspaceId: string, agentKey: string): Promise<string | null> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { modelOverride: true },
  });

  return config?.modelOverride ?? null;
}

export async function getAgentGovernancePolicy(workspaceId: string, agentKey: string): Promise<string | null> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { governancePolicy: true },
  });

  return config?.governancePolicy ?? null;
}
