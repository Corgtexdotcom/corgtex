#!/usr/bin/env node

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function readListFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name && args[index + 1]) {
      values.push(...args[index + 1].split(","));
      index += 1;
    } else if (arg.startsWith(`${name}=`)) {
      values.push(...arg.slice(name.length + 1).split(","));
    }
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizeSlug(value, fallback = "customer") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    return slug;
  }
  return fallback;
}

function deploymentStatusFromProvisioningStatus(status) {
  switch (String(status || "").trim().toLowerCase()) {
    case "active":
      return "ACTIVE";
    case "awaiting_dns":
    case "bootstrapping":
      return "BOOTSTRAPPING";
    case "provisioning":
      return "PROVISIONING";
    case "degraded":
      return "DEGRADED";
    case "suspended":
      return "SUSPENDED";
    default:
      return "DRAFT";
  }
}

function accountStatusFromDeployment(deployment) {
  if (deployment.environment === "internal") return "INTERNAL";
  if (deployment.environment === "demo") return "DEMO";
  if (deployment.provisioningStatus === "active") return "ACTIVE";
  if (deployment.provisioningStatus === "suspended") return "SUSPENDED";
  return "ONBOARDING";
}

function deploymentKind(deployment) {
  if (deployment.environment === "internal") return "INTERNAL";
  if (deployment.environment === "demo") return "DEMO";
  if (deployment.railwayProjectId) return "HOSTED_DEDICATED";
  if (deployment.managedWorkspaceId) return "SHARED_WORKSPACE";
  return "REMOTE_MANAGED";
}

async function ensureDeploymentAccount(tx, deployment, dryRun) {
  const slug = deployment.customerSlug
    ? normalizeSlug(deployment.customerSlug)
    : normalizeSlug(deployment.label || deployment.url, `deployment-${deployment.id.slice(0, 8)}`);
  const displayName = deployment.label || slug;
  const status = accountStatusFromDeployment(deployment);
  const kind = deploymentKind(deployment);
  const deploymentStatus = deploymentStatusFromProvisioningStatus(deployment.provisioningStatus);
  if (dryRun) {
    return { slug, displayName, status, kind, deploymentStatus };
  }

  const account = await tx.customerAccount.upsert({
    where: { slug },
    update: {
      displayName,
      status,
      supportOwnerEmail: deployment.supportOwnerEmail,
    },
    create: {
      slug,
      displayName,
      status,
      managementAuthority: "CORGTEX",
      supportOwnerEmail: deployment.supportOwnerEmail,
    },
  });

  await tx.customerDeployment.update({
    where: { id: deployment.id },
    data: {
      customerSlug: deployment.customerSlug || slug,
      customerAccountId: account.id,
      deploymentKind: kind,
      deploymentStatus,
    },
  });

  if (!account.primaryDeploymentId) {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: { primaryDeploymentId: deployment.id },
    });
  }
  return { slug, displayName, status, kind, deploymentStatus };
}

async function ensureWorkspaceAccount(tx, workspace, dryRun) {
  const appUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const url = `${appUrl}/workspaces/${workspace.id}`;
  if (dryRun) {
    return {
      slug: workspace.slug,
      displayName: workspace.name,
      status: "ACTIVE",
      kind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      url,
    };
  }

  const account = await tx.customerAccount.upsert({
    where: { slug: workspace.slug },
    update: {
      displayName: workspace.name,
      status: "ACTIVE",
    },
    create: {
      slug: workspace.slug,
      displayName: workspace.name,
      status: "ACTIVE",
      managementAuthority: "CORGTEX",
    },
  });
  const deployment = await tx.customerDeployment.upsert({
    where: { customerSlug: workspace.slug },
    update: {
      label: workspace.name,
      url,
      customerAccountId: account.id,
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      provisioningStatus: "active",
      managedWorkspaceId: workspace.id,
    },
    create: {
      label: workspace.name,
      url,
      environment: "production",
      customerSlug: workspace.slug,
      customerAccountId: account.id,
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      provisioningStatus: "active",
      bootstrapStatus: "not_started",
      managedWorkspaceId: workspace.id,
    },
  });
  await tx.customerAccount.update({
    where: { id: account.id },
    data: { primaryDeploymentId: deployment.id },
  });
  return {
    slug: workspace.slug,
    displayName: workspace.name,
    status: "ACTIVE",
    kind: "SHARED_WORKSPACE",
    deploymentStatus: "ACTIVE",
    url,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceIds = readListFlag(args, "--workspace-id");
  const workspaceSlugs = readListFlag(args, "--workspace-slug");
  const dryRun = hasFlag(args, "--dry-run");

  const result = await prisma.$transaction(async (tx) => {
    const deploymentRows = workspaceIds.length || workspaceSlugs.length
      ? []
      : await tx.customerDeployment.findMany({ orderBy: { createdAt: "asc" } });
    const workspaceRows = workspaceIds.length || workspaceSlugs.length
      ? await tx.workspace.findMany({
          where: {
            OR: [
              workspaceIds.length ? { id: { in: workspaceIds } } : undefined,
              workspaceSlugs.length ? { slug: { in: workspaceSlugs } } : undefined,
            ].filter(Boolean),
          },
          orderBy: { createdAt: "asc" },
        })
      : [];

    const deployments = [];
    for (const deployment of deploymentRows) {
      deployments.push(await ensureDeploymentAccount(tx, deployment, dryRun));
    }
    const workspaces = [];
    for (const workspace of workspaceRows) {
      workspaces.push(await ensureWorkspaceAccount(tx, workspace, dryRun));
    }
    return { dryRun, deployments, workspaces };
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
