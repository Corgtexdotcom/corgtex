import type {
  BuildArtifactAssetKind,
  BuildArtifactClassification,
  BuildArtifactStatus,
  BuildArtifactVisibility,
  MemberRole,
  Prisma,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { defaultStorage } from "@corgtex/storage";
import {
  decryptSecret,
  encryptSecret,
  env,
  prisma,
  randomOpaqueToken,
  sha256,
} from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";

const ARTIFACT_MANAGER_ROLES = new Set<MemberRole>(["ADMIN", "FACILITATOR"]);
const PUBLIC_PROOF_URL_TTL_SECONDS = 60 * 10;
const OPERATIONAL_ARTIFACT_FILTER = {
  repositoryOwner: "Corgtexdotcom",
  repositoryName: "corgtex-ops",
  pullRequestNumber: null,
} as const;

const buildArtifactAssetSelect = {
  id: true,
  artifactId: true,
  kind: true,
  label: true,
  captionMd: true,
  storageKey: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  sha256: true,
  sortOrder: true,
  createdAt: true,
} satisfies Prisma.BuildArtifactAssetSelect;

const buildArtifactSelect = {
  id: true,
  workspaceId: true,
  createdByUserId: true,
  brainSourceId: true,
  repositoryOwner: true,
  repositoryName: true,
  pullRequestNumber: true,
  pullRequestUrl: true,
  branchName: true,
  commitSha: true,
  mergeCommitSha: true,
  title: true,
  summaryMd: true,
  status: true,
  classification: true,
  visibility: true,
  publicTokenHash: true,
  publicTokenEnc: true,
  publicEnabledAt: true,
  publicRevokedAt: true,
  mergedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  assets: {
    select: buildArtifactAssetSelect,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.BuildArtifactSelect;

type BuildArtifactRecord = Prisma.BuildArtifactGetPayload<{ select: typeof buildArtifactSelect }>;
type BuildArtifactAssetRecord = Prisma.BuildArtifactAssetGetPayload<{ select: typeof buildArtifactAssetSelect }>;

type ArtifactInput = {
  workspaceId: string;
  artifactId?: string | null;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  mergeCommitSha?: string | null;
  title: string;
  summaryMd?: string | null;
  status?: BuildArtifactStatus;
  classification?: BuildArtifactClassification;
  visibility?: BuildArtifactVisibility;
  noPrivateDataConfirmed?: boolean;
};

type ArtifactUpdateInput = Partial<Omit<ArtifactInput, "workspaceId" | "artifactId">> & {
  workspaceId: string;
  artifactId: string;
};

type GitHubPullRequestInput = {
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number;
  pullRequestUrl?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  title: string;
  bodyMd?: string | null;
  isDraft?: boolean;
};

function normalizeString(value: string | null | undefined, maxLength?: number) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeRequired(value: string, label: string, maxLength: number) {
  const normalized = normalizeString(value, maxLength);
  invariant(normalized, 400, "INVALID_INPUT", `${label} is required.`);
  return normalized;
}

function normalizeRepoPart(value: string, label: string) {
  const normalized = normalizeRequired(value, label, 120).toLowerCase();
  invariant(/^[a-z0-9_.-]+$/.test(normalized), 400, "INVALID_INPUT", `${label} contains unsupported characters.`);
  return normalized;
}

function normalizeRepositoryFullName(value: unknown) {
  if (typeof value !== "string") return null;
  const [owner, name, ...rest] = value.trim().split("/");
  if (!owner || !name || rest.length > 0) return null;
  try {
    return `${normalizeRepoPart(owner, "Repository owner")}/${normalizeRepoPart(name, "Repository name")}`;
  } catch {
    return null;
  }
}

function normalizePrNumber(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  invariant(Number.isInteger(value) && value > 0, 400, "INVALID_INPUT", "PR number must be a positive integer.");
  return value;
}

function normalizeUrl(value: string | null | undefined) {
  const raw = normalizeString(value);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "PR URL must be a valid URL.");
  }
  invariant(parsed.protocol === "https:" || parsed.protocol === "http:", 400, "INVALID_INPUT", "PR URL must use http or https.");
  parsed.hash = "";
  return parsed.toString();
}

function canManageArtifact(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  artifact: { createdByUserId: string | null },
) {
  if (actor.kind === "agent") return true;
  if (membership && ARTIFACT_MANAGER_ROLES.has(membership.role as MemberRole)) return true;
  return Boolean(artifact.createdByUserId && artifact.createdByUserId === actor.user.id);
}

function brainSourceAuthorMemberId(membership: MembershipSummary | null | undefined) {
  return membership?.id === "global-operator" ? null : membership?.id ?? null;
}

function publicBaseUrl() {
  return env.APP_URL.replace(/\/$/, "");
}

function publicAssetUrl(token: string, assetId: string) {
  return `${publicBaseUrl()}/public/build-artifacts/${encodeURIComponent(token)}/assets/${encodeURIComponent(assetId)}`;
}

function decryptPublicToken(artifact: Pick<BuildArtifactRecord, "visibility" | "classification" | "publicTokenEnc">) {
  if (artifact.visibility !== "PUBLIC_REVIEW" || artifact.classification !== "OPEN_CORE" || !artifact.publicTokenEnc) {
    return null;
  }
  return decryptSecret(artifact.publicTokenEnc);
}

function serializeAsset(asset: BuildArtifactAssetRecord, publicToken: string | null) {
  return {
    id: asset.id,
    kind: asset.kind,
    label: asset.label,
    captionMd: asset.captionMd,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    sortOrder: asset.sortOrder,
    createdAt: asset.createdAt,
    hasPublicUrl: Boolean(publicToken),
    publicUrl: publicToken ? publicAssetUrl(publicToken, asset.id) : null,
  };
}

function serializeArtifact(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  artifact: BuildArtifactRecord,
) {
  const publicToken = decryptPublicToken(artifact);
  return {
    id: artifact.id,
    workspaceId: artifact.workspaceId,
    repositoryOwner: artifact.repositoryOwner,
    repositoryName: artifact.repositoryName,
    pullRequestNumber: artifact.pullRequestNumber,
    pullRequestUrl: artifact.pullRequestUrl,
    branchName: artifact.branchName,
    commitSha: artifact.commitSha,
    mergeCommitSha: artifact.mergeCommitSha,
    title: artifact.title,
    summaryMd: artifact.summaryMd,
    status: artifact.status,
    classification: artifact.classification,
    visibility: artifact.visibility,
    publicEnabledAt: artifact.publicEnabledAt,
    publicRevokedAt: artifact.publicRevokedAt,
    mergedAt: artifact.mergedAt,
    closedAt: artifact.closedAt,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    createdBy: artifact.createdBy,
    canManage: canManageArtifact(actor, membership, artifact),
    assets: artifact.assets.map((asset) => serializeAsset(asset, publicToken)),
  };
}

function publicTokenData() {
  const token = randomOpaqueToken(24);
  return {
    token,
    publicTokenHash: sha256(token),
    publicTokenEnc: encryptSecret(token),
  };
}

function enforcePublicReviewRules(params: {
  visibility: BuildArtifactVisibility;
  classification: BuildArtifactClassification;
  requiresConfirmation: boolean;
  noPrivateDataConfirmed?: boolean;
}) {
  if (params.visibility !== "PUBLIC_REVIEW") return;
  invariant(params.classification === "OPEN_CORE", 400, "INVALID_INPUT", "Public proof links are only allowed for open-core artifacts.");
  if (params.requiresConfirmation) {
    invariant(params.noPrivateDataConfirmed === true, 400, "INVALID_INPUT", "Public proof links require explicit no-private-data confirmation.");
  }
}

function repositoryConfigMatches(config: Prisma.JsonValue | null, repositoryFullName: string) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const repositories = (config as Record<string, unknown>).githubRepositories;
  if (!Array.isArray(repositories)) return false;
  return repositories.some((repository) => normalizeRepositoryFullName(repository) === repositoryFullName);
}

function artifactContent(artifact: BuildArtifactRecord) {
  const repo = `${artifact.repositoryOwner}/${artifact.repositoryName}`;
  const pr = artifact.pullRequestNumber ? `#${artifact.pullRequestNumber}` : "unlinked PR";
  const assetLines = artifact.assets.map((asset) => {
    const caption = asset.captionMd ? `: ${asset.captionMd}` : "";
    return `- ${asset.label} (${asset.kind}, ${asset.mimeType})${caption}`;
  });
  return [
    `PR artifact: ${artifact.title}`,
    `Repository: ${repo}`,
    `Pull request: ${pr}`,
    artifact.pullRequestUrl ? `PR URL: ${artifact.pullRequestUrl}` : null,
    artifact.branchName ? `Branch: ${artifact.branchName}` : null,
    artifact.commitSha ? `Commit: ${artifact.commitSha}` : null,
    artifact.mergeCommitSha ? `Merge commit: ${artifact.mergeCommitSha}` : null,
    `Status: ${artifact.status}`,
    `Classification: ${artifact.classification}`,
    artifact.summaryMd ? `Summary:\n${artifact.summaryMd}` : null,
    assetLines.length > 0 ? `Proof assets:\n${assetLines.join("\n")}` : "Proof assets: none yet.",
  ].filter(Boolean).join("\n\n");
}

function artifactExternalId(artifact: Pick<BuildArtifactRecord, "repositoryOwner" | "repositoryName" | "pullRequestNumber" | "id">) {
  return artifact.pullRequestNumber
    ? `github:${artifact.repositoryOwner}/${artifact.repositoryName}#${artifact.pullRequestNumber}`
    : `build-artifact:${artifact.id}`;
}

async function syncBrainSource(
  tx: Prisma.TransactionClient,
  artifactId: string,
  authorMemberId?: string | null,
) {
  const artifact = await tx.buildArtifact.findUnique({
    where: { id: artifactId },
    select: buildArtifactSelect,
  });
  invariant(artifact, 404, "NOT_FOUND", "Build artifact not found.");

  const data = {
    workspaceId: artifact.workspaceId,
    sourceType: "PR" as const,
    tier: 2,
    externalId: artifactExternalId(artifact),
    channel: "build-artifacts",
    title: artifact.title,
    content: artifactContent(artifact),
    metadata: {
      artifactId: artifact.id,
      repository: `${artifact.repositoryOwner}/${artifact.repositoryName}`,
      pullRequestNumber: artifact.pullRequestNumber,
      pullRequestUrl: artifact.pullRequestUrl,
      status: artifact.status,
      classification: artifact.classification,
      visibility: artifact.visibility,
      assetCount: artifact.assets.length,
    } satisfies Prisma.InputJsonObject,
  };

  if (artifact.brainSourceId) {
    await tx.brainSource.update({
      where: { id: artifact.brainSourceId },
      data,
    });
    return artifact.brainSourceId;
  }

  const source = await tx.brainSource.create({
    data: {
      ...data,
      authorMemberId: authorMemberId ?? null,
    },
  });
  await tx.buildArtifact.update({
    where: { id: artifact.id },
    data: { brainSourceId: source.id },
  });
  return source.id;
}

async function getArtifactOrThrow(tx: Prisma.TransactionClient, workspaceId: string, artifactId: string) {
  const artifact = await tx.buildArtifact.findFirst({
    where: { id: artifactId, workspaceId },
    select: buildArtifactSelect,
  });
  invariant(artifact, 404, "NOT_FOUND", "Build artifact not found.");
  return artifact;
}

function githubPullRequestSummary(params: GitHubPullRequestInput) {
  const lines = [
    params.isDraft ? "GitHub review state: draft PR" : "GitHub review state: ready for review",
    params.branchName ? `Source branch: ${params.branchName}` : null,
    params.commitSha ? `Head commit: ${params.commitSha}` : null,
    params.bodyMd ? `PR description:\n${params.bodyMd.trim()}` : "PR description: none provided.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

export async function listBuildArtifacts(actor: AppActor, params: {
  workspaceId: string;
  status?: BuildArtifactStatus;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const artifacts = await prisma.buildArtifact.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.status ? { status: params.status } : {}),
      NOT: OPERATIONAL_ARTIFACT_FILTER,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: buildArtifactSelect,
  });

  return artifacts.map((artifact) => serializeArtifact(actor, membership, artifact));
}

export async function listBuildArtifactWorkspaceIdsForGithubRepository(params: {
  repositoryOwner: string;
  repositoryName: string;
}) {
  const repositoryOwner = normalizeRepoPart(params.repositoryOwner, "Repository owner");
  const repositoryName = normalizeRepoPart(params.repositoryName, "Repository name");
  const repositoryFullName = `${repositoryOwner}/${repositoryName}`;
  const records = await prisma.workspaceFeatureFlag.findMany({
    where: {
      flag: "BUILD_ARTIFACTS",
      enabled: true,
    },
    select: {
      workspaceId: true,
      config: true,
    },
  });

  return records
    .filter((record) => repositoryConfigMatches(record.config, repositoryFullName))
    .map((record) => record.workspaceId);
}

export async function getBuildArtifact(actor: AppActor, params: {
  workspaceId: string;
  artifactId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const artifact = await prisma.buildArtifact.findFirst({
    where: { id: params.artifactId, workspaceId: params.workspaceId },
    select: buildArtifactSelect,
  });
  invariant(artifact, 404, "NOT_FOUND", "Build artifact not found.");
  return serializeArtifact(actor, membership, artifact);
}

export async function upsertBuildArtifact(actor: AppActor, params: ArtifactInput) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  const repositoryOwner = normalizeRepoPart(params.repositoryOwner, "Repository owner");
  const repositoryName = normalizeRepoPart(params.repositoryName, "Repository name");
  const pullRequestNumber = normalizePrNumber(params.pullRequestNumber);
  const classification = params.classification ?? "INTERNAL";
  const visibility = params.visibility ?? "PRIVATE";

  return prisma.$transaction(async (tx) => {
    const existing = params.artifactId
      ? await tx.buildArtifact.findFirst({
        where: { id: params.artifactId, workspaceId: params.workspaceId },
        select: { id: true, createdByUserId: true, publicTokenEnc: true },
      })
      : pullRequestNumber
        ? await tx.buildArtifact.findFirst({
          where: {
            workspaceId: params.workspaceId,
            repositoryOwner,
            repositoryName,
            pullRequestNumber,
          },
          select: { id: true, createdByUserId: true, publicTokenEnc: true },
        })
        : null;

    if (existing) {
      invariant(canManageArtifact(actor, membership, existing), 403, "FORBIDDEN", "Only the uploader, facilitators, or admins can manage this build artifact.");
    }

    enforcePublicReviewRules({
      visibility,
      classification,
      requiresConfirmation: !existing?.publicTokenEnc,
      noPrivateDataConfirmed: params.noPrivateDataConfirmed,
    });

    const token = visibility === "PUBLIC_REVIEW" && !existing?.publicTokenEnc ? publicTokenData() : null;
    const data = {
      repositoryOwner,
      repositoryName,
      pullRequestNumber,
      pullRequestUrl: normalizeUrl(params.pullRequestUrl),
      branchName: normalizeString(params.branchName, 160),
      commitSha: normalizeString(params.commitSha, 80),
      mergeCommitSha: normalizeString(params.mergeCommitSha, 80),
      title: normalizeRequired(params.title, "Artifact title", 200),
      summaryMd: normalizeString(params.summaryMd),
      status: params.status ?? "OPEN",
      classification,
      visibility,
      ...(visibility === "PUBLIC_REVIEW"
        ? {
          publicTokenHash: token?.publicTokenHash,
          publicTokenEnc: token?.publicTokenEnc,
          publicEnabledAt: new Date(),
          publicRevokedAt: null,
        }
        : visibility === "PRIVATE"
          ? {
            publicTokenHash: null,
            publicTokenEnc: null,
            publicEnabledAt: null,
            publicRevokedAt: null,
          }
          : {
            publicTokenHash: null,
            publicTokenEnc: null,
            publicRevokedAt: new Date(),
          }),
    } satisfies Prisma.BuildArtifactUncheckedUpdateInput;

    const artifact = existing
      ? await tx.buildArtifact.update({
        where: { id: existing.id },
        data,
        select: buildArtifactSelect,
      })
      : await tx.buildArtifact.create({
        data: {
          workspaceId: params.workspaceId,
          createdByUserId,
          ...data,
        },
        select: buildArtifactSelect,
      });

    await syncBrainSource(tx, artifact.id, brainSourceAuthorMemberId(membership));
    const refreshed = await getArtifactOrThrow(tx, params.workspaceId, artifact.id);

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: existing ? "build_artifact.updated" : "build_artifact.created",
      entityType: "BuildArtifact",
      entityId: artifact.id,
      meta: {
        repository: `${repositoryOwner}/${repositoryName}`,
        pullRequestNumber,
        status: artifact.status,
        classification: artifact.classification,
        visibility: artifact.visibility,
        hasPublicToken: Boolean(artifact.publicTokenHash),
      },
    });

    return serializeArtifact(actor, membership, refreshed);
  });
}

export async function updateBuildArtifact(actor: AppActor, params: ArtifactUpdateInput) {
  const current = await getBuildArtifact(actor, {
    workspaceId: params.workspaceId,
    artifactId: params.artifactId,
  });
  return upsertBuildArtifact(actor, {
    workspaceId: params.workspaceId,
    artifactId: params.artifactId,
    repositoryOwner: params.repositoryOwner ?? current.repositoryOwner,
    repositoryName: params.repositoryName ?? current.repositoryName,
    pullRequestNumber: params.pullRequestNumber ?? current.pullRequestNumber,
    pullRequestUrl: params.pullRequestUrl ?? current.pullRequestUrl,
    branchName: params.branchName ?? current.branchName,
    commitSha: params.commitSha ?? current.commitSha,
    mergeCommitSha: params.mergeCommitSha ?? current.mergeCommitSha,
    title: params.title ?? current.title,
    summaryMd: params.summaryMd ?? current.summaryMd,
    status: params.status ?? current.status,
    classification: params.classification ?? current.classification,
    visibility: params.visibility ?? current.visibility,
    noPrivateDataConfirmed: params.noPrivateDataConfirmed,
  });
}

export async function upsertBuildArtifactsFromGitHubPullRequest(params: GitHubPullRequestInput) {
  const repositoryOwner = normalizeRepoPart(params.repositoryOwner, "Repository owner");
  const repositoryName = normalizeRepoPart(params.repositoryName, "Repository name");
  const pullRequestNumber = normalizePrNumber(params.pullRequestNumber);
  invariant(pullRequestNumber, 400, "INVALID_INPUT", "PR number is required.");
  const workspaceIds = await listBuildArtifactWorkspaceIdsForGithubRepository({
    repositoryOwner,
    repositoryName,
  });
  const summaryMd = githubPullRequestSummary(params);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const updated = [];

    for (const workspaceId of workspaceIds) {
      const existing = await tx.buildArtifact.findFirst({
        where: {
          workspaceId,
          repositoryOwner,
          repositoryName,
          pullRequestNumber,
        },
        select: buildArtifactSelect,
      });
      const data = {
        repositoryOwner,
        repositoryName,
        pullRequestNumber,
        pullRequestUrl: normalizeUrl(params.pullRequestUrl),
        branchName: normalizeString(params.branchName, 160),
        commitSha: normalizeString(params.commitSha, 80),
        mergeCommitSha: null,
        title: normalizeRequired(params.title, "Artifact title", 200),
        summaryMd: normalizeString(summaryMd),
        status: "OPEN" as const,
        classification: existing?.classification ?? "INTERNAL",
        visibility: existing?.visibility ?? "PRIVATE",
        closedAt: null,
        mergedAt: null,
      } satisfies Prisma.BuildArtifactUncheckedUpdateInput;

      const artifact = existing
        ? await tx.buildArtifact.update({
          where: { id: existing.id },
          data,
          select: buildArtifactSelect,
        })
        : await tx.buildArtifact.create({
          data: {
            workspaceId,
            createdByUserId: null,
            ...data,
          },
          select: buildArtifactSelect,
        });

      await syncBrainSource(tx, artifact.id);
      const refreshed = await getArtifactOrThrow(tx, workspaceId, artifact.id);
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          action: existing ? "build_artifact.github_updated" : "build_artifact.github_created",
          entityType: "BuildArtifact",
          entityId: artifact.id,
          meta: {
            repository: `${repositoryOwner}/${repositoryName}`,
            pullRequestNumber,
            isDraft: params.isDraft === true,
            syncedAt: now.toISOString(),
          },
        },
      });
      updated.push(refreshed.id);
    }

    return { updatedCount: updated.length, artifactIds: updated };
  });
}

export async function addBuildArtifactAsset(actor: AppActor, params: {
  workspaceId: string;
  artifactId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  kind?: BuildArtifactAssetKind;
  label?: string | null;
  captionMd?: string | null;
  sortOrder?: number | null;
  width?: number | null;
  height?: number | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const artifact = await prisma.buildArtifact.findFirst({
    where: { id: params.artifactId, workspaceId: params.workspaceId },
    select: { id: true, workspaceId: true, createdByUserId: true },
  });
  invariant(artifact, 404, "NOT_FOUND", "Build artifact not found.");
  invariant(canManageArtifact(actor, membership, artifact), 403, "FORBIDDEN", "Only the uploader, facilitators, or admins can upload build artifact assets.");
  invariant(params.fileBuffer.byteLength > 0, 400, "INVALID_INPUT", "Asset file is required.");
  invariant(params.fileBuffer.byteLength <= 50 * 1024 * 1024, 400, "INVALID_INPUT", "Artifact assets must be 50MB or smaller.");

  const assetId = randomUUID();
  const cleanName = normalizeRequired(params.fileName, "File name", 180).replace(/[^\w.\- ]+/g, "_");
  const storageKey = `workspaces/${params.workspaceId}/build-artifacts/${params.artifactId}/${assetId}/${cleanName}`;
  const sha = createHash("sha256").update(params.fileBuffer).digest("hex");
  await defaultStorage.put(storageKey, params.fileBuffer, {
    contentType: params.mimeType || "application/octet-stream",
  });

  return prisma.$transaction(async (tx) => {
    const asset = await tx.buildArtifactAsset.create({
      data: {
        id: assetId,
        artifactId: params.artifactId,
        kind: params.kind ?? "SCREENSHOT",
        label: normalizeString(params.label, 120) ?? cleanName,
        captionMd: normalizeString(params.captionMd),
        storageKey,
        mimeType: params.mimeType || "application/octet-stream",
        sizeBytes: params.fileBuffer.byteLength,
        width: params.width ?? null,
        height: params.height ?? null,
        sha256: sha,
        sortOrder: params.sortOrder ?? 0,
      },
      select: buildArtifactAssetSelect,
    });

    await syncBrainSource(tx, params.artifactId, brainSourceAuthorMemberId(membership));

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "build_artifact_asset.created",
      entityType: "BuildArtifactAsset",
      entityId: asset.id,
      meta: {
        artifactId: params.artifactId,
        kind: asset.kind,
        label: asset.label,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        storageKey,
      },
    });

    const refreshed = await getArtifactOrThrow(tx, params.workspaceId, params.artifactId);
    return {
      asset: serializeAsset(asset, decryptPublicToken(refreshed)),
      artifact: serializeArtifact(actor, membership, refreshed),
    };
  });
}

export async function getBuildArtifactAssetSignedUrl(actor: AppActor, params: {
  workspaceId: string;
  artifactId: string;
  assetId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const asset = await prisma.buildArtifactAsset.findFirst({
    where: {
      id: params.assetId,
      artifactId: params.artifactId,
      artifact: { workspaceId: params.workspaceId },
    },
    select: { id: true, storageKey: true },
  });
  invariant(asset, 404, "NOT_FOUND", "Build artifact asset not found.");
  const signedUrl = await defaultStorage.getSignedUrl(asset.storageKey, PUBLIC_PROOF_URL_TTL_SECONDS);
  return { signedUrl };
}

export async function revokeBuildArtifactPublicAccess(actor: AppActor, params: {
  workspaceId: string;
  artifactId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const existing = await tx.buildArtifact.findFirst({
      where: { id: params.artifactId, workspaceId: params.workspaceId },
      select: { id: true, createdByUserId: true },
    });
    invariant(existing, 404, "NOT_FOUND", "Build artifact not found.");
    invariant(canManageArtifact(actor, membership, existing), 403, "FORBIDDEN", "Only the uploader, facilitators, or admins can revoke build artifact public links.");

    const artifact = await tx.buildArtifact.update({
      where: { id: existing.id },
      data: {
        visibility: "REVOKED",
        publicTokenEnc: null,
        publicRevokedAt: new Date(),
      },
      select: buildArtifactSelect,
    });
    await syncBrainSource(tx, artifact.id, brainSourceAuthorMemberId(membership));

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "build_artifact.public_revoked",
      entityType: "BuildArtifact",
      entityId: artifact.id,
      meta: {
        reason: normalizeString(params.reason, 240),
        hadPublicAccess: true,
      },
    });

    const refreshed = await getArtifactOrThrow(tx, params.workspaceId, artifact.id);
    return serializeArtifact(actor, membership, refreshed);
  });
}

export async function resolvePublicBuildArtifactAsset(params: {
  publicToken: string;
  assetId: string;
}) {
  const tokenHash = sha256(params.publicToken);
  const artifact = await prisma.buildArtifact.findFirst({
    where: {
      publicTokenHash: tokenHash,
    },
    select: {
      id: true,
      visibility: true,
      classification: true,
      publicRevokedAt: true,
      assets: {
        where: { id: params.assetId },
        select: {
          id: true,
          storageKey: true,
        },
        take: 1,
      },
    },
  });

  if (!artifact) {
    throw new AppError(404, "NOT_FOUND", "Public proof link not found.");
  }

  if (artifact.visibility === "REVOKED" || artifact.publicRevokedAt) {
    throw new AppError(410, "PUBLIC_LINK_REVOKED", "This public proof link has been revoked.");
  }
  invariant(artifact.visibility === "PUBLIC_REVIEW" && artifact.classification === "OPEN_CORE", 404, "NOT_FOUND", "Public proof link not found.");
  const asset = artifact.assets[0];
  invariant(asset, 404, "NOT_FOUND", "Public proof asset not found.");
  const signedUrl = await defaultStorage.getSignedUrl(asset.storageKey, PUBLIC_PROOF_URL_TTL_SECONDS);
  return { signedUrl };
}

export async function markBuildArtifactClosedFromGitHub(params: {
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number;
  merged: boolean;
  mergeCommitSha?: string | null;
  closedAt?: Date | null;
}) {
  const repositoryOwner = normalizeRepoPart(params.repositoryOwner, "Repository owner");
  const repositoryName = normalizeRepoPart(params.repositoryName, "Repository name");
  const pullRequestNumber = normalizePrNumber(params.pullRequestNumber);
  invariant(pullRequestNumber, 400, "INVALID_INPUT", "PR number is required.");

  return prisma.$transaction(async (tx) => {
    const artifacts = await tx.buildArtifact.findMany({
      where: {
        repositoryOwner,
        repositoryName,
        pullRequestNumber,
      },
      select: buildArtifactSelect,
    });

    const updated = [];
    for (const artifact of artifacts) {
      const next = await tx.buildArtifact.update({
        where: { id: artifact.id },
        data: {
          status: params.merged ? "MERGED" : "CLOSED",
          visibility: artifact.visibility === "PUBLIC_REVIEW" ? "REVOKED" : artifact.visibility,
          publicTokenEnc: artifact.visibility === "PUBLIC_REVIEW" ? null : artifact.publicTokenEnc,
          publicRevokedAt: artifact.visibility === "PUBLIC_REVIEW" ? new Date() : artifact.publicRevokedAt,
          mergeCommitSha: params.mergeCommitSha ?? artifact.mergeCommitSha,
          mergedAt: params.merged ? (params.closedAt ?? new Date()) : artifact.mergedAt,
          closedAt: params.closedAt ?? new Date(),
        },
        select: buildArtifactSelect,
      });
      await syncBrainSource(tx, next.id);
      await tx.auditLog.create({
        data: {
          workspaceId: next.workspaceId,
          actorUserId: null,
          action: params.merged ? "build_artifact.github_merged" : "build_artifact.github_closed",
          entityType: "BuildArtifact",
          entityId: next.id,
          meta: {
            repository: `${repositoryOwner}/${repositoryName}`,
            pullRequestNumber,
            publicAccessRevoked: artifact.visibility === "PUBLIC_REVIEW",
          },
        },
      });
      updated.push(next.id);
    }

    return { updatedCount: updated.length, artifactIds: updated };
  });
}
