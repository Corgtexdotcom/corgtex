import type {
  CustomerAccount,
  CustomerDeployment,
  CustomerAccountStatus,
  CustomerDeploymentCloudProvider,
  CustomerDeploymentKind,
  CustomerDeploymentStatus,
  CustomerManagementAuthority,
  Prisma,
} from "@prisma/client";
import { env, prisma } from "@corgtex/shared";
import { invariant } from "./errors";

type DbClient = Prisma.TransactionClient | typeof prisma;

const CUSTOMER_ACCOUNT_STATUSES = new Set<CustomerAccountStatus>([
  "PROSPECT",
  "TRIAL",
  "ONBOARDING",
  "ACTIVE",
  "SUSPENDED",
  "CHURNED",
  "INTERNAL",
  "DEMO",
]);

const CUSTOMER_MANAGEMENT_AUTHORITIES = new Set<CustomerManagementAuthority>([
  "CORGTEX",
  "CUSTOMER_CONTROL_PLANE",
  "SELF_MANAGED",
]);

const CUSTOMER_DEPLOYMENT_KINDS = new Set<CustomerDeploymentKind>([
  "SHARED_WORKSPACE",
  "HOSTED_DEDICATED",
  "REMOTE_MANAGED",
  "SELF_HOSTED",
  "CUSTOMER_CONTROL_PLANE",
  "INTERNAL",
  "DEMO",
]);

const CUSTOMER_DEPLOYMENT_STATUSES = new Set<CustomerDeploymentStatus>([
  "DRAFT",
  "PROVISIONING",
  "BOOTSTRAPPING",
  "ACTIVE",
  "DEGRADED",
  "SUSPENDED",
  "RETIRED",
]);

const CUSTOMER_DEPLOYMENT_CLOUD_PROVIDERS = new Set<CustomerDeploymentCloudProvider>([
  "RAILWAY",
  "AZURE",
  "SELF_HOSTED",
  "UNKNOWN",
]);

function dbClient(tx?: Prisma.TransactionClient): DbClient {
  return tx ?? prisma;
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeCustomerSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  invariant(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug), 400, "INVALID_INPUT", "Customer slug must be a DNS-safe slug.");
  return slug;
}

export function customerSlugFromText(value: string, fallback = "customer") {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(normalized)) {
    return normalized;
  }
  return normalizeCustomerSlug(fallback);
}

export function deploymentStatusFromProvisioningStatus(status: string | null | undefined): CustomerDeploymentStatus {
  switch (status?.trim().toLowerCase()) {
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
    case "retired":
      return "RETIRED";
    default:
      return "DRAFT";
  }
}

export function provisioningStatusFromDeploymentStatus(status: CustomerDeploymentStatus) {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "BOOTSTRAPPING":
      return "bootstrapping";
    case "PROVISIONING":
      return "provisioning";
    case "DEGRADED":
      return "degraded";
    case "SUSPENDED":
      return "suspended";
    case "RETIRED":
      return "suspended";
    case "DRAFT":
    default:
      return "draft";
  }
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  invariant(trimmed.length > 0, 400, "INVALID_INPUT", "Deployment URL is required.");
  return trimmed.replace(/\/$/, "");
}

function assertAccountStatus(status: CustomerAccountStatus) {
  invariant(CUSTOMER_ACCOUNT_STATUSES.has(status), 400, "INVALID_INPUT", "Invalid customer account status.");
  return status;
}

function assertManagementAuthority(authority: CustomerManagementAuthority) {
  invariant(CUSTOMER_MANAGEMENT_AUTHORITIES.has(authority), 400, "INVALID_INPUT", "Invalid customer management authority.");
  return authority;
}

function assertDeploymentKind(kind: CustomerDeploymentKind) {
  invariant(CUSTOMER_DEPLOYMENT_KINDS.has(kind), 400, "INVALID_INPUT", "Invalid customer deployment kind.");
  return kind;
}

function assertDeploymentStatus(status: CustomerDeploymentStatus) {
  invariant(CUSTOMER_DEPLOYMENT_STATUSES.has(status), 400, "INVALID_INPUT", "Invalid customer deployment status.");
  return status;
}

function assertCloudProvider(provider: CustomerDeploymentCloudProvider) {
  invariant(CUSTOMER_DEPLOYMENT_CLOUD_PROVIDERS.has(provider), 400, "INVALID_INPUT", "Invalid customer deployment cloud provider.");
  return provider;
}

function customerWorkspaceUrl(workspaceId: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/workspaces/${workspaceId}`;
}

async function setPrimaryDeploymentIfMissing(db: DbClient, params: {
  customerAccountId: string;
  deploymentId: string;
  forcePrimary?: boolean;
}) {
  const account = await db.customerAccount.findUnique({
    where: { id: params.customerAccountId },
    select: { primaryDeploymentId: true },
  });
  if (!account) return;
  if (params.forcePrimary === false) return;
  if (!account.primaryDeploymentId || params.forcePrimary) {
    await db.customerAccount.update({
      where: { id: params.customerAccountId },
      data: { primaryDeploymentId: params.deploymentId },
    });
  }
}

export async function ensureCustomerAccount(params: {
  slug: string;
  displayName: string;
  status?: CustomerAccountStatus;
  managementAuthority?: CustomerManagementAuthority;
  supportOwnerEmail?: string | null;
  notes?: string | null;
}, tx?: Prisma.TransactionClient) {
  const db = dbClient(tx);
  const slug = normalizeCustomerSlug(params.slug);
  const displayName = params.displayName.trim();
  invariant(displayName.length > 0, 400, "INVALID_INPUT", "Customer display name is required.");

  const update: Prisma.CustomerAccountUpdateInput = {
    displayName,
  };
  if (params.status) {
    update.status = assertAccountStatus(params.status);
  }
  if (params.managementAuthority) {
    update.managementAuthority = assertManagementAuthority(params.managementAuthority);
  }
  if (params.supportOwnerEmail !== undefined) {
    update.supportOwnerEmail = normalizeOptionalText(params.supportOwnerEmail);
  }
  if (params.notes !== undefined) {
    update.notes = normalizeOptionalText(params.notes);
  }

  return db.customerAccount.upsert({
    where: { slug },
    update,
    create: {
      slug,
      displayName,
      status: params.status ? assertAccountStatus(params.status) : "PROSPECT",
      managementAuthority: params.managementAuthority ? assertManagementAuthority(params.managementAuthority) : "CORGTEX",
      supportOwnerEmail: normalizeOptionalText(params.supportOwnerEmail),
      notes: normalizeOptionalText(params.notes),
    },
  });
}

export async function registerCustomerDeployment(params: {
  accountSlug: string;
  accountDisplayName: string;
  accountStatus?: CustomerAccountStatus;
  managementAuthority?: CustomerManagementAuthority;
  label?: string;
  url: string;
  environment?: string | null;
  notes?: string | null;
  deploymentKind: CustomerDeploymentKind;
  deploymentStatus: CustomerDeploymentStatus;
  cloudProvider?: CustomerDeploymentCloudProvider | null;
  customerSlug?: string | null;
  region?: string | null;
  dataResidency?: string | null;
  customDomain?: string | null;
  supportOwnerEmail?: string | null;
  releaseVersion?: string | null;
  releaseImageTag?: string | null;
  storageBucketName?: string | null;
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
  managedWorkspaceId?: string | null;
  remoteWorkspaceSlug?: string | null;
  remoteWorkspaceId?: string | null;
  providerSubscriptionId?: string | null;
  providerResourceGroup?: string | null;
  providerProjectId?: string | null;
  providerEnvironmentId?: string | null;
  providerWebServiceId?: string | null;
  providerWorkerServiceId?: string | null;
  providerPostgresServiceId?: string | null;
  providerRedisServiceId?: string | null;
  providerStorageResourceId?: string | null;
  providerLogsUrl?: string | null;
  providerCostUrl?: string | null;
  provisioningStatus?: string | null;
  bootstrapStatus?: string | null;
  primary?: boolean;
}, tx?: Prisma.TransactionClient) {
  const db = dbClient(tx);
  const accountSlug = normalizeCustomerSlug(params.accountSlug);
  const legacyCustomerSlug = normalizeCustomerSlug(params.customerSlug ?? accountSlug);
  const deploymentStatus = assertDeploymentStatus(params.deploymentStatus);
  const deploymentKind = assertDeploymentKind(params.deploymentKind);
  const cloudProvider = params.cloudProvider ? assertCloudProvider(params.cloudProvider) : "RAILWAY";
  const supportOwnerEmail = normalizeOptionalText(params.supportOwnerEmail);
  const account = await ensureCustomerAccount({
    slug: accountSlug,
    displayName: params.accountDisplayName,
    status: params.accountStatus,
    managementAuthority: params.managementAuthority,
    supportOwnerEmail,
  }, tx);

  const deploymentData = {
    label: normalizeOptionalText(params.label) ?? params.accountDisplayName,
    url: normalizeUrl(params.url),
    environment: normalizeOptionalText(params.environment) ?? "production",
    notes: normalizeOptionalText(params.notes),
    customerSlug: legacyCustomerSlug,
    customerAccountId: account.id,
    deploymentKind,
    deploymentStatus,
    cloudProvider,
    region: normalizeOptionalText(params.region),
    dataResidency: normalizeOptionalText(params.dataResidency),
    customDomain: normalizeOptionalText(params.customDomain),
    supportOwnerEmail,
    releaseVersion: normalizeOptionalText(params.releaseVersion),
    releaseImageTag: normalizeOptionalText(params.releaseImageTag),
    storageBucketName: normalizeOptionalText(params.storageBucketName),
    bootstrapBundleUri: normalizeOptionalText(params.bootstrapBundleUri),
    bootstrapBundleChecksum: normalizeOptionalText(params.bootstrapBundleChecksum),
    bootstrapBundleSchemaVersion: normalizeOptionalText(params.bootstrapBundleSchemaVersion),
    managedWorkspaceId: normalizeOptionalText(params.managedWorkspaceId),
    remoteWorkspaceSlug: normalizeOptionalText(params.remoteWorkspaceSlug),
    remoteWorkspaceId: normalizeOptionalText(params.remoteWorkspaceId),
    providerSubscriptionId: normalizeOptionalText(params.providerSubscriptionId),
    providerResourceGroup: normalizeOptionalText(params.providerResourceGroup),
    providerProjectId: normalizeOptionalText(params.providerProjectId),
    providerEnvironmentId: normalizeOptionalText(params.providerEnvironmentId),
    providerWebServiceId: normalizeOptionalText(params.providerWebServiceId),
    providerWorkerServiceId: normalizeOptionalText(params.providerWorkerServiceId),
    providerPostgresServiceId: normalizeOptionalText(params.providerPostgresServiceId),
    providerRedisServiceId: normalizeOptionalText(params.providerRedisServiceId),
    providerStorageResourceId: normalizeOptionalText(params.providerStorageResourceId),
    providerLogsUrl: normalizeOptionalText(params.providerLogsUrl),
    providerCostUrl: normalizeOptionalText(params.providerCostUrl),
    provisioningStatus: params.provisioningStatus
      ? params.provisioningStatus.trim().toLowerCase()
      : provisioningStatusFromDeploymentStatus(deploymentStatus),
    bootstrapStatus: params.bootstrapStatus
      ? params.bootstrapStatus.trim().toLowerCase()
      : deploymentStatus === "BOOTSTRAPPING" ? "pending" : "not_started",
  } satisfies Prisma.CustomerDeploymentUncheckedCreateInput;

  const existingByUrl = await db.customerDeployment.findUnique({
    where: { url: deploymentData.url },
    select: { id: true, customerAccountId: true, customerSlug: true },
  });
  invariant(
    !existingByUrl
      || (
        existingByUrl.customerAccountId === account.id
        && existingByUrl.customerSlug === legacyCustomerSlug
      ),
    409,
    "CUSTOMER_DEPLOYMENT_URL_CONFLICT",
    "Deployment URL is already registered to another customer.",
  );

  const deployment = await db.customerDeployment.upsert({
    where: { url: deploymentData.url },
    update: deploymentData,
    create: deploymentData,
  });

  await setPrimaryDeploymentIfMissing(db, {
    customerAccountId: account.id,
    deploymentId: deployment.id,
    forcePrimary: params.primary,
  });

  return { account, deployment };
}

export type RemoteSharedWorkspaceRegistration = {
  infrastructureDeploymentId: string;
  remoteWorkspaceId: string;
  remoteWorkspaceSlug: string;
  workspaceUrl: string;
  supportMcpUrl: string;
};

function explicitHttpsUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { invariant(false, 400, "INVALID_INPUT", "An explicit HTTPS URL is required."); }
  invariant(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    400, "INVALID_INPUT", "An explicit HTTPS URL without credentials, query or fragment is required.");
  return url;
}

// Registers a destination claim only. Runtime identity, held import and cutover require separate evidence.
export async function registerRemoteSharedWorkspaceDeployment(params: RemoteSharedWorkspaceRegistration & {
  customerAccountId: string;
}, tx?: Prisma.TransactionClient): Promise<{ account: CustomerAccount; deployment: CustomerDeployment }> {
  if (!tx) return prisma.$transaction((transaction) => registerRemoteSharedWorkspaceDeployment(params, transaction));
  const account = await tx.customerAccount.findUnique({ where: { id: params.customerAccountId } });
  invariant(account, 404, "NOT_FOUND", "Customer account not found.");
  const infrastructure = await tx.customerDeployment.findUnique({ where: { id: params.infrastructureDeploymentId } });
  invariant(infrastructure && infrastructure.cloudProvider === "AZURE" && ["SHARED_WORKSPACE", "REMOTE_MANAGED"].includes(infrastructure.deploymentKind)
    && !infrastructure.managedWorkspaceId && !infrastructure.remoteWorkspaceId
    && infrastructure.providerSubscriptionId && infrastructure.providerResourceGroup
    && infrastructure.providerEnvironmentId && infrastructure.providerWebServiceId && infrastructure.providerWorkerServiceId,
  400, "SHARED_INFRASTRUCTURE_REQUIRED", "Select the existing Azure shared infrastructure deployment with its web and worker identities.");
  const origin = explicitHttpsUrl(infrastructure.url);
  invariant(origin.pathname === "/", 400, "SHARED_INFRASTRUCTURE_REQUIRED", "Shared infrastructure must have a root deployment URL.");
  invariant(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.remoteWorkspaceId),
    400, "INVALID_INPUT", "The destination workspace UUID is required.");
  invariant(normalizeCustomerSlug(params.remoteWorkspaceSlug) === params.remoteWorkspaceSlug,
    400, "INVALID_INPUT", "The exact destination workspace slug is required.");
  const workspaceUrl = explicitHttpsUrl(params.workspaceUrl);
  const supportMcpUrl = explicitHttpsUrl(params.supportMcpUrl);
  invariant(workspaceUrl.href === `${origin.origin}/workspaces/${params.remoteWorkspaceId}`,
    400, "REMOTE_WORKSPACE_URL_MISMATCH", "Workspace URL must identify this workspace on the selected shared infrastructure.");
  invariant(supportMcpUrl.href === `${origin.origin}/api/mcp`,
    400, "REMOTE_SUPPORT_URL_MISMATCH", "Support MCP URL must be the shared infrastructure root /api/mcp endpoint.");
  const existing = await tx.customerDeployment.findUnique({ where: { url: workspaceUrl.href } });
  if (existing) {
    const metadata = existing.providerMetadata as Record<string, unknown> | null;
    invariant(existing.customerAccountId === account.id && existing.deploymentKind === "SHARED_WORKSPACE"
      && existing.cloudProvider === "AZURE" && existing.managedWorkspaceId === null
      && existing.remoteWorkspaceId === params.remoteWorkspaceId && existing.remoteWorkspaceSlug === params.remoteWorkspaceSlug
      && existing.supportMcpUrl === supportMcpUrl.href
      && metadata?.sharedInfrastructureDeploymentId === infrastructure.id,
    409, "REMOTE_SHARED_REGISTRATION_CONFLICT", "This remote workspace already has a different registration. Reconcile it before continuing.");
    return { account, deployment: existing };
  }
  const deployment = await tx.customerDeployment.create({
    data: {
      customerAccountId: account.id,
      customerSlug: account.slug,
      label: account.displayName,
      url: workspaceUrl.href,
      environment: "production",
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "DRAFT",
      cloudProvider: "AZURE",
      managedWorkspaceId: null,
      remoteWorkspaceId: params.remoteWorkspaceId,
      remoteWorkspaceSlug: params.remoteWorkspaceSlug,
      supportBaseUrl: origin.origin,
      supportMcpUrl: supportMcpUrl.href,
      supportAccessMode: "workspace",
      provisioningStatus: "migration_pending_verification",
      providerMetadata: { sharedInfrastructureDeploymentId: infrastructure.id },
    },
  });
  return { account, deployment };
}

export async function linkManagedWorkspaceDeployment(params: {
  workspaceId?: string;
  workspaceSlug?: string;
  accountStatus?: CustomerAccountStatus;
  deploymentKind?: CustomerDeploymentKind;
  deploymentStatus?: CustomerDeploymentStatus;
  managementAuthority?: CustomerManagementAuthority;
  supportOwnerEmail?: string | null;
  notes?: string | null;
  primary?: boolean;
}, tx?: Prisma.TransactionClient) {
  const db = dbClient(tx);
  invariant(params.workspaceId || params.workspaceSlug, 400, "INVALID_INPUT", "Workspace ID or slug is required.");
  const workspace = await db.workspace.findFirst({
    where: params.workspaceId ? { id: params.workspaceId } : { slug: params.workspaceSlug },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  return registerCustomerDeployment({
    accountSlug: workspace.slug,
    accountDisplayName: workspace.name,
    accountStatus: params.accountStatus ?? "ACTIVE",
    managementAuthority: params.managementAuthority ?? "CORGTEX",
    label: workspace.name,
    url: customerWorkspaceUrl(workspace.id),
    environment: "production",
    notes: params.notes ?? workspace.description,
    deploymentKind: params.deploymentKind ?? "SHARED_WORKSPACE",
    deploymentStatus: params.deploymentStatus ?? "ACTIVE",
    customerSlug: workspace.slug,
    supportOwnerEmail: params.supportOwnerEmail,
    managedWorkspaceId: workspace.id,
    primary: params.primary ?? true,
  }, tx);
}

export async function resolvePrimaryCustomerDeployment(params: {
  customerAccountId?: string;
  customerSlug?: string;
}, tx?: Prisma.TransactionClient) {
  const db = dbClient(tx);
  invariant(params.customerAccountId || params.customerSlug, 400, "INVALID_INPUT", "Customer account ID or slug is required.");
  const account = await db.customerAccount.findFirst({
    where: params.customerAccountId
      ? { id: params.customerAccountId }
      : { slug: normalizeCustomerSlug(params.customerSlug!) },
    include: {
      primaryDeployment: {
        include: {
          managedWorkspace: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      },
      deployments: {
        orderBy: [
          { deploymentStatus: "asc" },
          { createdAt: "desc" },
        ],
        include: {
          managedWorkspace: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      },
    },
  });
  invariant(account, 404, "NOT_FOUND", "Customer account not found.");
  const activeDeployment = account.deployments.find((deployment) => deployment.deploymentStatus === "ACTIVE");
  return {
    account,
    deployment: account.primaryDeployment ?? activeDeployment ?? account.deployments[0] ?? null,
  };
}
