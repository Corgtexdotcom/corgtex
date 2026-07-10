#!/usr/bin/env tsx

import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";
import {
  mergeWorkspaceMembers,
  requireWorkspaceMembership,
  resolveWorkspaceMemberByEmail,
} from "@corgtex/domain";
import { getPrismaClient, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";

const memberSummaryInclude = {
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      globalRole: true,
    },
  },
  emailAliases: {
    select: {
      email: true,
      source: true,
    },
  },
} satisfies Prisma.MemberInclude;

type CleanupMember = Prisma.MemberGetPayload<{ include: typeof memberSummaryInclude }>;

type CleanupWorkspace = {
  id: string;
  slug: string;
  name: string;
};

export type MemberCleanupPairInput = {
  sourceRef: string;
  targetRef: string;
};

export type MemberCleanupAliasInput = {
  sourceRef: string;
  email: string;
};

export type MemberCleanupArgs = {
  apply: boolean;
  workspaceRef: string;
  actorEmail: string;
  pairs: MemberCleanupPairInput[];
  aliases: MemberCleanupAliasInput[];
  reason: string | null;
};

export type MemberCleanupAdapters = {
  resolveWorkspace(ref: string): Promise<CleanupWorkspace | null>;
  resolveActor(actorEmail: string): Promise<AppActor | null>;
  ensureAdminAccess(actor: AppActor, workspaceId: string): Promise<void>;
  resolveMember(workspaceId: string, ref: string): Promise<CleanupMember | null>;
  mergeMembers(
    actor: AppActor,
    params: {
      workspaceId: string;
      sourceMemberId: string;
      targetMemberId: string;
      aliasEmails?: string[];
      reason?: string | null;
    },
  ): Promise<{
    sourceMemberId: string;
    targetMemberId: string;
    aliasEmails: string[];
    rewired: Record<string, number>;
  }>;
};

function usageText() {
  return [
    "Usage:",
    "  npm run member:cleanup -- --workspace <id-or-slug> --actor-email <admin-email> --pair <source-ref>=<target-ref> [options]",
    "",
    "Options:",
    "  --pair <source-ref>=<target-ref>   Merge source into target. May be repeated.",
    "  --alias <source-ref>=<email>       Extra email alias to carry onto the target. May be repeated.",
    "  --reason <text>                   Audit reason recorded on applied merges.",
    "  --apply                           Execute merges. Dry-run is the default.",
    "  --dry-run                         Explicit dry-run mode.",
    "",
    "Member refs may be active/inactive member IDs or primary/alias emails.",
  ].join("\n");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function requireOptionValue(argv: string[], index: number, label: string, inlineValue?: string) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function parseAssignment(value: string, label: string) {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`${label} must use source=target format.`);
  }
  const left = value.slice(0, separatorIndex).trim();
  const right = value.slice(separatorIndex + 1).trim();
  if (!left || !right) {
    throw new Error(`${label} must include both sides.`);
  }
  return { left, right };
}

export function parseArgs(argv: string[]): MemberCleanupArgs {
  const args: Partial<MemberCleanupArgs> & {
    dryRun?: boolean;
    pairs: MemberCleanupPairInput[];
    aliases: MemberCleanupAliasInput[];
  } = {
    apply: false,
    dryRun: false,
    pairs: [],
    aliases: [],
    reason: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--help" || entry === "-h") {
      throw new Error(usageText());
    }
    if (entry === "--apply") {
      args.apply = true;
      continue;
    }
    if (entry === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    const match = entry.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) {
      throw new Error(`Unknown argument: ${entry}`);
    }

    const [, rawKey, inlineValue] = match;
    const { value, nextIndex } = requireOptionValue(argv, index, `--${rawKey}`, inlineValue);
    index = nextIndex;

    if (rawKey === "workspace") {
      args.workspaceRef = value.trim();
      continue;
    }
    if (rawKey === "actor-email") {
      args.actorEmail = normalizeEmail(value);
      continue;
    }
    if (rawKey === "pair") {
      const parsed = parseAssignment(value, "--pair");
      args.pairs.push({ sourceRef: parsed.left, targetRef: parsed.right });
      continue;
    }
    if (rawKey === "alias") {
      const parsed = parseAssignment(value, "--alias");
      args.aliases.push({ sourceRef: parsed.left, email: normalizeEmail(parsed.right) });
      continue;
    }
    if (rawKey === "reason") {
      args.reason = value.trim() || null;
      continue;
    }

    throw new Error(`Unknown argument: --${rawKey}`);
  }

  if (args.apply && args.dryRun) {
    throw new Error("Use either --apply or --dry-run, not both.");
  }
  if (!args.workspaceRef) {
    throw new Error("--workspace is required.");
  }
  if (!args.actorEmail) {
    throw new Error("--actor-email is required.");
  }
  if (args.pairs.length === 0) {
    throw new Error("At least one --pair is required.");
  }

  return {
    apply: Boolean(args.apply),
    workspaceRef: args.workspaceRef,
    actorEmail: args.actorEmail,
    pairs: args.pairs,
    aliases: args.aliases,
    reason: args.reason ?? null,
  };
}

function memberLabel(member: CleanupMember) {
  return {
    id: member.id,
    email: member.user.email,
    displayName: member.user.displayName,
    kind: member.kind,
    role: member.role,
    isActive: member.isActive,
    mergedIntoMemberId: member.mergedIntoMemberId,
    aliases: member.emailAliases.map((alias) => alias.email).sort(),
  };
}

function aliasesForSource(args: MemberCleanupArgs, pair: MemberCleanupPairInput, source: CleanupMember) {
  const sourceRefs = new Set([
    pair.sourceRef.trim().toLowerCase(),
    source.id.toLowerCase(),
    normalizeEmail(source.user.email),
  ]);
  return [...new Set(args.aliases
    .filter((alias) => sourceRefs.has(alias.sourceRef.trim().toLowerCase()))
    .map((alias) => alias.email))];
}

function aliasMatchesSource(alias: MemberCleanupAliasInput, item: {
  pair: MemberCleanupPairInput;
  source: CleanupMember;
}) {
  const aliasSource = alias.sourceRef.trim().toLowerCase();
  return aliasSource === item.pair.sourceRef.trim().toLowerCase()
    || aliasSource === item.source.id.toLowerCase()
    || aliasSource === normalizeEmail(item.source.user.email);
}

function plannedAliasEmails(source: CleanupMember, target: CleanupMember, extraAliases: string[]) {
  const targetEmail = normalizeEmail(target.user.email);
  return [...new Set([
    source.user.email,
    ...source.emailAliases.map((alias) => alias.email),
    ...extraAliases,
  ].map(normalizeEmail).filter((email) => email && email !== targetEmail))].sort();
}

function assertPairIsValid(source: CleanupMember, target: CleanupMember) {
  if (source.id === target.id) {
    throw new Error(`Source and target both resolve to member ${source.id}.`);
  }
  if (source.workspaceId !== target.workspaceId) {
    throw new Error(`Source ${source.id} and target ${target.id} are not in the same workspace.`);
  }
  if (source.kind !== target.kind) {
    throw new Error(`Source ${source.id} and target ${target.id} have different member kinds.`);
  }
  if (source.mergedIntoMemberId) {
    throw new Error(`Source ${source.id} has already been merged.`);
  }
  if (!target.isActive || target.mergedIntoMemberId) {
    throw new Error(`Target ${target.id} must be active and unmerged.`);
  }
}

function assertBatchIsUnambiguous(items: Array<{ source: CleanupMember; target: CleanupMember }>) {
  const sourceIds = new Set<string>();
  const targetIds = new Set(items.map((item) => item.target.id));
  for (const item of items) {
    if (sourceIds.has(item.source.id)) {
      throw new Error(`Source member ${item.source.id} appears in multiple merge pairs.`);
    }
    sourceIds.add(item.source.id);
  }
  for (const sourceId of sourceIds) {
    if (targetIds.has(sourceId)) {
      throw new Error(`Member ${sourceId} cannot be both source and target in one cleanup run.`);
    }
  }
}

function assertAllAliasesAreUsed(args: MemberCleanupArgs, items: Array<{
  pair: MemberCleanupPairInput;
  source: CleanupMember;
}>) {
  const unusedAlias = args.aliases.find((alias) => !items.some((item) => aliasMatchesSource(alias, item)));
  if (unusedAlias) {
    throw new Error(`Alias source "${unusedAlias.sourceRef}" does not match any merge source.`);
  }
}

export async function runMemberCleanup(args: MemberCleanupArgs, adapters: MemberCleanupAdapters) {
  const workspace = await adapters.resolveWorkspace(args.workspaceRef);
  if (!workspace) {
    throw new Error(`Workspace "${args.workspaceRef}" was not found.`);
  }

  const actor = await adapters.resolveActor(args.actorEmail);
  if (!actor) {
    throw new Error(`Actor user "${args.actorEmail}" was not found.`);
  }
  await adapters.ensureAdminAccess(actor, workspace.id);

  const resolvedPairs = [];
  for (const pair of args.pairs) {
    const [source, target] = await Promise.all([
      adapters.resolveMember(workspace.id, pair.sourceRef),
      adapters.resolveMember(workspace.id, pair.targetRef),
    ]);
    if (!source) {
      throw new Error(`Source member "${pair.sourceRef}" was not found.`);
    }
    if (!target) {
      throw new Error(`Target member "${pair.targetRef}" was not found.`);
    }
    assertPairIsValid(source, target);
    resolvedPairs.push({ pair, source, target });
  }
  assertBatchIsUnambiguous(resolvedPairs);
  assertAllAliasesAreUsed(args, resolvedPairs);

  const merges = [];
  for (const item of resolvedPairs) {
    const extraAliases = aliasesForSource(args, item.pair, item.source);
    const plannedAliases = plannedAliasEmails(item.source, item.target, extraAliases);
    if (!args.apply) {
      merges.push({
        status: "planned",
        source: memberLabel(item.source),
        target: memberLabel(item.target),
        aliasEmails: plannedAliases,
      });
      continue;
    }

    const result = await adapters.mergeMembers(actor, {
      workspaceId: workspace.id,
      sourceMemberId: item.source.id,
      targetMemberId: item.target.id,
      aliasEmails: extraAliases,
      reason: args.reason,
    });
    merges.push({
      status: "merged",
      source: memberLabel(item.source),
      target: memberLabel(item.target),
      aliasEmails: result.aliasEmails,
      rewired: result.rewired,
    });
  }

  return {
    dryRun: !args.apply,
    workspace,
    actor: {
      id: actor.kind === "user" ? actor.user.id : null,
      email: actor.kind === "user" ? actor.user.email : null,
      kind: actor.kind,
    },
    planned: resolvedPairs.length,
    merged: merges.filter((item) => item.status === "merged").length,
    merges,
  };
}

export function createRuntimeAdapters(): MemberCleanupAdapters {
  return {
    async resolveWorkspace(ref) {
      return prisma.workspace.findFirst({
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
    },
    async resolveActor(actorEmail) {
      const user = await prisma.user.findUnique({
        where: { email: normalizeEmail(actorEmail) },
        select: {
          id: true,
          email: true,
          displayName: true,
          globalRole: true,
        },
      });
      return user ? { kind: "user", user } : null;
    },
    async ensureAdminAccess(actor, workspaceId) {
      await requireWorkspaceMembership({
        actor,
        workspaceId,
        allowedRoles: ["ADMIN"],
      });
    },
    async resolveMember(workspaceId, ref) {
      const trimmed = ref.trim();
      const byId = await prisma.member.findFirst({
        where: { workspaceId, id: trimmed },
        include: memberSummaryInclude,
      });
      if (byId) return byId;

      if (!trimmed.includes("@")) return null;
      const byEmail = await resolveWorkspaceMemberByEmail({
        workspaceId,
        email: trimmed,
        includeInactive: true,
      });
      if (!byEmail) return null;
      return prisma.member.findFirst({
        where: { workspaceId, id: byEmail.id },
        include: memberSummaryInclude,
      });
    },
    mergeMembers: mergeWorkspaceMembers,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usageText());
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await runMemberCleanup(args, createRuntimeAdapters());
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await getPrismaClient().$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
