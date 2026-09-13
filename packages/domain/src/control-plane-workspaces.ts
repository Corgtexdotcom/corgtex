import type { CustomerDeploymentStatus, Prisma, WorkspacePlan } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";

import { requireControlPlaneAccess } from "./control-plane";
import { invariant } from "./errors";

export type ControlPlaneWorkspaceDirectoryParams = {
  query?: string;
  cursor?: string;
  pageSize?: number;
  scope?: "all" | "local" | "remote";
};

export type ControlPlaneWorkspaceDirectoryRow = {
  key: string;
  name: string;
  slug: string | null;
  accountId: string | null;
  accountLabel: string | null;
  workspaceId: string;
  observedStatus: CustomerDeploymentStatus | null;
  freshness: {
    workspaceUpdatedAt: string | null;
    registrationUpdatedAt: string | null;
    liveChecked: false;
  };
} & ({ source: "local"; deploymentId?: string; plan: WorkspacePlan }
  | { source: "remote"; deploymentId: string; plan?: never });

export type ControlPlaneWorkspaceDirectory = {
  rows: ControlPlaneWorkspaceDirectoryRow[];
  query: string;
  pageSize: number;
  scope: "all" | "local" | "remote";
  nextCursor: string | null;
  coverage: {
    directory: "partial";
    local: "authoritative-local-database";
    remote: "registered-shared-workspaces-only";
    remoteInventory: "unverified";
    remoteTrialStatus: "unknown";
    counts: { scope: "returned-page"; local: number; remote: number };
    pagination: "live-keyset-not-snapshot";
    unreconciledSources: {
      kind: "self-serve-registry-snapshots";
      status: "not-reconciled";
      href: "/control-plane/self-serve";
      latestSync: { eventId: string; sourceDeploymentId: string | null; recordedAt: string } | null;
    };
  };
};

type DirectoryCursor = { version: 1; source: "local" | "remote"; id: string; query: string; scope: "all" | "local" | "remote" };

const deploymentSelect = {
  id: true,
  deploymentStatus: true,
  updatedAt: true,
  customerAccount: { select: { id: true, displayName: true } },
} satisfies Prisma.CustomerDeploymentSelect;

const localSelect = {
  id: true, name: true, slug: true, plan: true, updatedAt: true,
  managedCustomerDeployment: { select: deploymentSelect },
} satisfies Prisma.WorkspaceSelect;

const remoteSelect = {
  ...deploymentSelect, label: true, remoteWorkspaceId: true, remoteWorkspaceSlug: true,
} satisfies Prisma.CustomerDeploymentSelect;

function readCursor(cursor: string | undefined, query: string, scope: DirectoryCursor["scope"]): DirectoryCursor | null {
  if (cursor === undefined) return null;
  invariant(typeof cursor === "string" && cursor.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(cursor),
    400, "INVALID_WORKSPACE_DIRECTORY_CURSOR", "Invalid workspace directory cursor.");
  let value: Partial<DirectoryCursor> | null = null;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* Validated below. */ }
  invariant(value?.version === 1 && (value.source === "local" || value.source === "remote")
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128 && value.query === query && value.scope === scope
    && (scope === "all" || scope === value.source),
  400, "INVALID_WORKSPACE_DIRECTORY_CURSOR", "Invalid cursor or changed search; restart directory pagination.");
  return value as DirectoryCursor;
}

export async function listControlPlaneWorkspaces(
  actor: AppActor,
  params: ControlPlaneWorkspaceDirectoryParams = {},
): Promise<ControlPlaneWorkspaceDirectory> {
  // Global directory access only: deployment-scoped access must not enumerate it.
  await requireControlPlaneAccess(actor);
  invariant(params.query === undefined || typeof params.query === "string", 400, "INVALID_INPUT", "Search must be text.");
  const query = (params.query ?? "").trim();
  const pageSize = params.pageSize ?? 25;
  const scope = params.scope ?? "all";
  invariant(scope === "all" || scope === "local" || scope === "remote", 400, "INVALID_INPUT", "Unknown workspace directory scope.");
  invariant(query.length <= 120, 400, "INVALID_INPUT", "Search must be at most 120 characters.");
  invariant(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100,
    400, "INVALID_INPUT", "Page size must be an integer from 1 to 100.");
  const cursor = readCursor(params.cursor, query, scope);
  const rows: ControlPlaneWorkspaceDirectoryRow[] = [];
  const search = { contains: query, mode: "insensitive" as const };

  if (scope !== "remote" && cursor?.source !== "remote") {
    const workspaces = await prisma.workspace.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor.id } } : {}),
        ...(query ? { OR: [
          { name: search }, { slug: search },
          { managedCustomerDeployment: { is: { customerAccount: { is: { displayName: search } } } } },
        ] } : {}),
      },
      select: localSelect,
      orderBy: { id: "asc" },
      take: pageSize + 1,
    });
    for (const workspace of workspaces) {
      const deployment = workspace.managedCustomerDeployment;
      rows.push({
        key: `local:${workspace.id}`, name: workspace.name, slug: workspace.slug, source: "local",
        workspaceId: workspace.id,
        ...(deployment ? { deploymentId: deployment.id } : {}),
        accountId: deployment?.customerAccount?.id ?? null,
        accountLabel: deployment?.customerAccount?.displayName ?? null,
        plan: workspace.plan,
        observedStatus: deployment?.deploymentStatus ?? null,
        freshness: { workspaceUpdatedAt: workspace.updatedAt.toISOString(),
          registrationUpdatedAt: deployment?.updatedAt.toISOString() ?? null, liveChecked: false },
      });
    }
  }

  if (scope !== "local" && rows.length <= pageSize) {
    const deployments = await prisma.customerDeployment.findMany({
      where: {
        deploymentKind: "SHARED_WORKSPACE",
        managedWorkspaceId: null,
        remoteWorkspaceId: { not: null },
        NOT: { remoteWorkspaceId: "" },
        ...(cursor?.source === "remote" ? { id: { gt: cursor.id } } : {}),
        ...(query ? { OR: [
          { label: search }, { remoteWorkspaceSlug: search },
          { customerAccount: { is: { displayName: search } } },
        ] } : {}),
      },
      select: remoteSelect,
      orderBy: { id: "asc" },
      take: pageSize + 1 - rows.length,
    });
    for (const deployment of deployments) {
      // The registration ID, not the remote workspace UUID or account, identifies
      // this source. Equal workspace IDs on different runtimes are not duplicates.
      invariant(deployment.remoteWorkspaceId, 500, "INVALID_REMOTE_WORKSPACE_REGISTRATION", "Remote registration has no workspace ID.");
      rows.push({
        key: `remote:${deployment.id}`, name: deployment.label, slug: deployment.remoteWorkspaceSlug, source: "remote",
        workspaceId: deployment.remoteWorkspaceId, deploymentId: deployment.id,
        accountId: deployment.customerAccount?.id ?? null,
        accountLabel: deployment.customerAccount?.displayName ?? null,
        observedStatus: deployment.deploymentStatus,
        freshness: { workspaceUpdatedAt: null, registrationUpdatedAt: deployment.updatedAt.toISOString(), liveChecked: false },
      });
    }
  }

  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    version: 1, source: last.source, id: last.source === "local" ? last.workspaceId : last.deploymentId, query, scope,
  } satisfies DirectoryCursor)).toString("base64url") : null;
  // Only the indexed sync marker is read. Snapshot JSON is trial-derived and has
  // no authoritative latest-per-source identity index; preserve its triage entry.
  const latestSync = await prisma.customerDeploymentEvent.findFirst({
    where: { action: "self_serve.registry_synced" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, deploymentId: true, createdAt: true },
  });
  return {
    rows: page, query, pageSize, scope, nextCursor,
    coverage: {
      directory: "partial",
      local: "authoritative-local-database", remote: "registered-shared-workspaces-only",
      remoteInventory: "unverified", remoteTrialStatus: "unknown", pagination: "live-keyset-not-snapshot",
      unreconciledSources: { kind: "self-serve-registry-snapshots", status: "not-reconciled", href: "/control-plane/self-serve",
        latestSync: latestSync ? { eventId: latestSync.id, sourceDeploymentId: latestSync.deploymentId, recordedAt: latestSync.createdAt.toISOString() } : null },
      counts: { scope: "returned-page", local: page.filter((row) => row.source === "local").length,
        remote: page.filter((row) => row.source === "remote").length },
    },
  };
}

export type ControlPlaneWorkspaceSummary = {
  workspaceId: string;
  name: string;
  slug: string;
  plan: WorkspacePlan;
  createdAt: string;
  updatedAt: string;
  trialEndsAt: string | null;
  memberCount: number;
  managedDeployment: {
    deploymentId: string;
    label: string;
    accountId: string | null;
    accountLabel: string | null;
  } | null;
};

export async function getControlPlaneWorkspaceSummary(actor: AppActor, workspaceId: string): Promise<ControlPlaneWorkspaceSummary> {
  await requireControlPlaneAccess(actor);
  invariant(typeof workspaceId === "string" && workspaceId.length > 0 && workspaceId.length <= 128,
    400, "INVALID_INPUT", "A workspace ID is required.");
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true, name: true, slug: true, plan: true, createdAt: true, updatedAt: true, trialEndsAt: true,
      _count: { select: { members: true } },
      managedCustomerDeployment: { select: { id: true, label: true, customerAccount: { select: { id: true, displayName: true } } } },
    },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");
  const deployment = workspace.managedCustomerDeployment;
  return {
    workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, plan: workspace.plan,
    createdAt: workspace.createdAt.toISOString(), updatedAt: workspace.updatedAt.toISOString(), trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
    memberCount: workspace._count.members,
    managedDeployment: deployment ? { deploymentId: deployment.id, label: deployment.label,
      accountId: deployment.customerAccount?.id ?? null, accountLabel: deployment.customerAccount?.displayName ?? null } : null,
  };
}
