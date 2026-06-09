import type {
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
