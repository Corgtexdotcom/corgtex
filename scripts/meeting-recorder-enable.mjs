#!/usr/bin/env node

import process from "node:process";
import prismaPackage from "@prisma/client";

const { Prisma, PrismaClient } = prismaPackage;

const FEATURE_FLAG = "MEETING_RECORDERS";
const DEFAULT_BOT_NAME = "Corgtex Recorder";
const DEFAULT_ENTRY_MESSAGE = "Corgtex Recorder is joining to transcribe this meeting for the workspace.";
const DEFAULT_MONTHLY_MINUTE_CAP = 6000;

function usage(exitCode = 1) {
  const message = [
    "Usage:",
    "  node scripts/meeting-recorder-enable.mjs --workspace <id-or-slug> [options]",
    "",
    "Options:",
    "  --enabled | --disabled",
    "  --auto-record-enabled | --auto-record-disabled",
    "  --default-provider recall|baas",
    "  --fallback-provider recall|baas|none",
    "  --bot-name <name>",
    "  --entry-message <message>",
    "  --monthly-minute-cap <minutes>",
  ].join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (rawValue !== undefined) {
      args[key] = rawValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function parseProvider(value, { allowNone = false } = {}) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[._\s]+/g, "-");
  if (allowNone && normalized === "none") return null;
  if (normalized === "recall" || normalized === "recall-ai") return "RECALL_AI";
  if (normalized === "baas" || normalized === "meeting-baas") return "MEETING_BAAS";
  throw new Error(`Unknown provider "${value}". Use recall, baas, or none where allowed.`);
}

function parseBooleanPair(args, enabledKey, disabledKey, fallback) {
  if (args[enabledKey] === true && args[disabledKey] === true) {
    throw new Error(`Use either --${enabledKey} or --${disabledKey}, not both.`);
  }
  if (args[disabledKey] === true) return false;
  if (args[enabledKey] === true) return true;
  return fallback;
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return Math.round(parsed);
}

function baseUrlFromEnv() {
  const raw = process.env.MEETING_RECORDER_PUBLIC_BASE_URL
    || process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || "";
  return raw.replace(/\/$/, "");
}

function envStatus(defaultProvider, fallbackProvider) {
  const baseUrl = baseUrlFromEnv();
  const warnings = [];
  const status = {
    meetingRecorderPublicBaseUrl: Boolean(baseUrl),
    recallApiKey: Boolean(process.env.RECALL_API_KEY),
    recallWebhookSecret: Boolean(process.env.RECALL_WEBHOOK_SECRET),
    meetingBaasApiKey: Boolean(process.env.MEETING_BAAS_API_KEY),
    meetingBaasWebhookSecret: Boolean(process.env.MEETING_BAAS_WEBHOOK_SECRET),
  };
  const providers = new Set([defaultProvider, fallbackProvider].filter(Boolean));
  if (!baseUrl) warnings.push("MEETING_RECORDER_PUBLIC_BASE_URL or APP_URL is not set; vendor webhooks cannot be configured.");
  if (providers.has("RECALL_AI") && !status.recallApiKey) warnings.push("RECALL_API_KEY is missing.");
  if (providers.has("RECALL_AI") && !status.recallWebhookSecret) warnings.push("RECALL_WEBHOOK_SECRET is missing.");
  if (providers.has("MEETING_BAAS") && !status.meetingBaasApiKey) warnings.push("MEETING_BAAS_API_KEY is missing.");
  if (providers.has("MEETING_BAAS") && !status.meetingBaasWebhookSecret) warnings.push("MEETING_BAAS_WEBHOOK_SECRET is missing.");

  return {
    status,
    webhookUrls: baseUrl
      ? {
        recall: `${baseUrl}/api/integrations/meeting-recorders/recall/webhook`,
        meetingBaas: `${baseUrl}/api/integrations/meeting-recorders/baas/webhook`,
      }
      : null,
    warnings,
  };
}

async function resolveWorkspace(prisma, ref) {
  const workspace = await prisma.workspace.findFirst({
    where: {
      OR: [
        { id: ref },
        { slug: ref },
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
    },
  });
  if (!workspace) {
    throw new Error(`Workspace "${ref}" was not found.`);
  }
  return workspace;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) usage(0);

  const workspaceRef = args.workspace ?? args._[0];
  if (!workspaceRef) usage();

  const enabled = parseBooleanPair(args, "enabled", "disabled", true);
  const autoRecordEnabled = parseBooleanPair(args, "autoRecordEnabled", "autoRecordDisabled", true);
  const defaultProvider = parseProvider(args.defaultProvider) ?? "RECALL_AI";
  const fallbackProvider = args.fallbackProvider === undefined
    ? "MEETING_BAAS"
    : parseProvider(args.fallbackProvider, { allowNone: true });
  const botName = typeof args.botName === "string" && args.botName.trim()
    ? args.botName.trim()
    : DEFAULT_BOT_NAME;
  const entryMessage = typeof args.entryMessage === "string" && args.entryMessage.trim()
    ? args.entryMessage.trim()
    : DEFAULT_ENTRY_MESSAGE;
  const monthlyMinuteCap = parsePositiveInteger(args.monthlyMinuteCap, DEFAULT_MONTHLY_MINUTE_CAP, "--monthly-minute-cap");

  const prisma = new PrismaClient();
  try {
    const workspace = await resolveWorkspace(prisma, workspaceRef);
    const [featureFlag, config] = await prisma.$transaction([
      prisma.workspaceFeatureFlag.upsert({
        where: {
          workspaceId_flag: {
            workspaceId: workspace.id,
            flag: FEATURE_FLAG,
          },
        },
        update: { enabled },
        create: {
          workspaceId: workspace.id,
          flag: FEATURE_FLAG,
          enabled,
        },
      }),
      prisma.workspaceMeetingRecorderConfig.upsert({
        where: { workspaceId: workspace.id },
        update: {
          enabled,
          defaultProvider,
          fallbackProvider,
          botName,
          entryMessage,
          autoRecordEnabled,
          monthlyMinuteCap,
        },
        create: {
          workspaceId: workspace.id,
          enabled,
          defaultProvider,
          fallbackProvider,
          botName,
          entryMessage,
          autoRecordEnabled,
          monthlyMinuteCap,
          providerSettings: Prisma.JsonNull,
        },
      }),
    ]);

    let reconcileJob = null;
    if (enabled) {
      reconcileJob = await prisma.workflowJob.upsert({
        where: { dedupeKey: `meeting-recorders:reconcile:${workspace.id}:operator-enable` },
        update: {},
        create: {
          workspaceId: workspace.id,
          type: "meeting-recorders.reconcile",
          payload: {},
          dedupeKey: `meeting-recorders:reconcile:${workspace.id}:operator-enable`,
        },
        select: {
          id: true,
          status: true,
          dedupeKey: true,
        },
      });
    }

    const env = envStatus(defaultProvider, fallbackProvider);
    console.log(JSON.stringify({
      workspace,
      featureFlag: {
        flag: featureFlag.flag,
        enabled: featureFlag.enabled,
      },
      config: {
        enabled: config.enabled,
        defaultProvider: config.defaultProvider,
        fallbackProvider: config.fallbackProvider,
        botName: config.botName,
        entryMessage: config.entryMessage,
        autoRecordEnabled: config.autoRecordEnabled,
        monthlyMinuteCap: config.monthlyMinuteCap,
      },
      reconcileJob,
      env: env.status,
      webhookUrls: env.webhookUrls,
      warnings: env.warnings,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
