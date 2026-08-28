import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, defaultStorageMock, encryptSecretMock, decryptSecretMock, sha256Mock } = vi.hoisted(() => ({
  defaultStorageMock: {
    put: vi.fn(),
    getSignedUrl: vi.fn(),
  },
  encryptSecretMock: vi.fn((value: string) => `enc:${value}`),
  decryptSecretMock: vi.fn((value: string) => value.replace(/^enc:/, "")),
  sha256Mock: vi.fn((value: string) => `sha:${value}`),
  prismaMock: {
    $transaction: vi.fn(),
    buildArtifact: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    buildArtifactAsset: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    workspaceFeatureFlag: {
      findMany: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();
const actorUserIdForWorkspace = vi.fn();
const recordAudit = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
  randomOpaqueToken: vi.fn(() => "public-token"),
  sha256: sha256Mock,
  env: {
    APP_URL: "https://app.corgtex.test",
  },
}));

vi.mock("@corgtex/storage", () => ({
  defaultStorage: defaultStorageMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace,
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

function artifactFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    createdByUserId: "user-1",
    brainSourceId: null,
    repositoryOwner: "puncar-dev",
    repositoryName: "corgtex",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
    branchName: "codex/build-artifacts",
    commitSha: "abc123",
    mergeCommitSha: null,
    title: "Tools directory",
    summaryMd: "Adds shared tool links.",
    status: "OPEN",
    classification: "OPEN_CORE",
    visibility: "PUBLIC_REVIEW",
    publicTokenHash: "sha:public-token",
    publicTokenEnc: "enc:public-token",
    publicEnabledAt: new Date("2026-04-29T10:00:00.000Z"),
    publicRevokedAt: null,
    mergedAt: null,
    closedAt: null,
    createdAt: new Date("2026-04-29T10:00:00.000Z"),
    updatedAt: new Date("2026-04-29T10:10:00.000Z"),
    createdBy: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
    },
    assets: [],
    ...overrides,
  };
}

function assetFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    artifactId: "artifact-1",
    kind: "SCREENSHOT",
    label: "List view",
    captionMd: "Shows the list view.",
    storageKey: "workspaces/workspace-1/build-artifacts/artifact-1/asset-1/list.png",
    mimeType: "image/png",
    sizeBytes: 12,
    width: null,
    height: null,
    sha256: "asset-sha",
    sortOrder: 0,
    createdAt: new Date("2026-04-29T10:12:00.000Z"),
    ...overrides,
  };
}

describe("build artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    actorUserIdForWorkspace.mockResolvedValue("user-1");
    recordAudit.mockResolvedValue(undefined);
    prismaMock.brainSource.create.mockResolvedValue({ id: "brain-1" });
    prismaMock.buildArtifact.update.mockResolvedValue(artifactFixture({ brainSourceId: "brain-1" }));
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([]);
    defaultStorageMock.put.mockResolvedValue({ key: "stored", size: 12 });
    defaultStorageMock.getSignedUrl.mockResolvedValue("https://signed.example/proof");
  });

  it("creates an open-core public review artifact without returning raw public tokens", async () => {
    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce(null);
    prismaMock.buildArtifact.create.mockResolvedValue(artifactFixture());
    prismaMock.buildArtifact.findUnique.mockResolvedValue(artifactFixture());
    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce(artifactFixture({ brainSourceId: "brain-1" }));

    const { upsertBuildArtifact } = await import("./build-artifacts");
    const result = await upsertBuildArtifact(actor, {
      workspaceId: "workspace-1",
      repositoryOwner: "Puncar-Dev",
      repositoryName: "CORGTEX",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42#hash",
      title: "Tools directory",
      summaryMd: "Adds shared tool links.",
      classification: "OPEN_CORE",
      visibility: "PUBLIC_REVIEW",
      noPrivateDataConfirmed: true,
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("public-token");
    expect(sha256Mock).toHaveBeenCalledWith("public-token");
    expect(prismaMock.buildArtifact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        publicTokenHash: "sha:public-token",
        publicTokenEnc: "enc:public-token",
      }),
    }));
    expect(result.assets).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("public-token");
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("public-token");
  });

  it("indexes global-operator-created artifacts without a synthetic Brain author member", async () => {
    prismaMock.buildArtifact.findFirst.mockReset();
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "workspace-1",
      userId: "operator-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.buildArtifact.findFirst
      .mockResolvedValueOnce(artifactFixture({ classification: "INTERNAL", visibility: "PRIVATE", brainSourceId: "brain-1" }));
    prismaMock.buildArtifact.create.mockResolvedValue(artifactFixture({ classification: "INTERNAL", visibility: "PRIVATE" }));
    prismaMock.buildArtifact.findUnique.mockResolvedValue(artifactFixture({ classification: "INTERNAL", visibility: "PRIVATE" }));

    const { upsertBuildArtifact } = await import("./build-artifacts");
    await expect(upsertBuildArtifact({
      kind: "user",
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    }, {
      workspaceId: "workspace-1",
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      title: "Private proof",
      classification: "INTERNAL",
      visibility: "PRIVATE",
    })).resolves.toMatchObject({
      id: "artifact-1",
      classification: "INTERNAL",
      visibility: "PRIVATE",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authorMemberId: null,
      }),
    }));
  });

  it("blocks public links unless the artifact is explicitly open-core and clean", async () => {
    const { upsertBuildArtifact } = await import("./build-artifacts");

    await expect(upsertBuildArtifact(actor, {
      workspaceId: "workspace-1",
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      title: "Client proof",
      classification: "CLIENT_PRIVATE",
      visibility: "PUBLIC_REVIEW",
      noPrivateDataConfirmed: true,
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    await expect(upsertBuildArtifact(actor, {
      workspaceId: "workspace-1",
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      title: "General proof",
      classification: "OPEN_CORE",
      visibility: "PUBLIC_REVIEW",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });

  it("allows ordinary updates to an artifact that already has public review enabled", async () => {
    const existing = artifactFixture();
    prismaMock.buildArtifact.findFirst
      .mockResolvedValueOnce({ id: "artifact-1", createdByUserId: "user-1", publicTokenEnc: "enc:public-token" })
      .mockResolvedValueOnce(artifactFixture({ title: "Updated proof", brainSourceId: "brain-1" }));
    prismaMock.buildArtifact.update.mockResolvedValue(artifactFixture({ title: "Updated proof", brainSourceId: "brain-1" }));
    prismaMock.buildArtifact.findUnique.mockResolvedValue(artifactFixture({ ...existing, title: "Updated proof", brainSourceId: "brain-1" }));
    prismaMock.brainSource.update.mockResolvedValue({ id: "brain-1" });

    const { upsertBuildArtifact } = await import("./build-artifacts");
    await expect(upsertBuildArtifact(actor, {
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      title: "Updated proof",
      classification: "OPEN_CORE",
      visibility: "PUBLIC_REVIEW",
    })).resolves.toMatchObject({
      id: "artifact-1",
      title: "Updated proof",
      visibility: "PUBLIC_REVIEW",
    });

    expect(encryptSecretMock).not.toHaveBeenCalled();
  });

  it("uploads an asset to object storage, indexes Brain metadata, and returns a public Corgtex URL", async () => {
    const asset = assetFixture();
    const refreshed = artifactFixture({ brainSourceId: "brain-1", assets: [asset] });
    prismaMock.buildArtifact.findFirst
      .mockResolvedValueOnce({ id: "artifact-1", workspaceId: "workspace-1", createdByUserId: "user-1" })
      .mockResolvedValueOnce(refreshed);
    prismaMock.buildArtifactAsset.create.mockResolvedValue(asset);
    prismaMock.buildArtifact.findUnique.mockResolvedValue(refreshed);
    prismaMock.brainSource.update.mockResolvedValue({ id: "brain-1" });

    const { addBuildArtifactAsset } = await import("./build-artifacts");
    const result = await addBuildArtifactAsset(actor, {
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      fileBuffer: Buffer.from("proof"),
      fileName: "list.png",
      mimeType: "image/png",
      label: "List view",
      captionMd: "Shows the list view.",
    });

    expect(defaultStorageMock.put).toHaveBeenCalledWith(
      expect.stringContaining("workspaces/workspace-1/build-artifacts/artifact-1/"),
      Buffer.from("proof"),
      { contentType: "image/png" },
    );
    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceType: "PR",
        channel: "build-artifacts",
        metadata: expect.objectContaining({
          artifactId: "artifact-1",
          assetCount: 1,
        }),
      }),
    }));
    expect(result.asset.publicUrl).toBe("https://app.corgtex.test/public/build-artifacts/public-token/assets/asset-1");
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("https://signed.example");
  });

  it("resolves, rejects, and revokes public proof asset links correctly", async () => {
    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce({
      id: "artifact-1",
      visibility: "PUBLIC_REVIEW",
      classification: "OPEN_CORE",
      publicRevokedAt: null,
      assets: [{ id: "asset-1", storageKey: "stored/key.png" }],
    });

    const { resolvePublicBuildArtifactAsset } = await import("./build-artifacts");
    await expect(resolvePublicBuildArtifactAsset({
      publicToken: "public-token",
      assetId: "asset-1",
    })).resolves.toEqual({ signedUrl: "https://signed.example/proof" });

    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce(null);
    await expect(resolvePublicBuildArtifactAsset({
      publicToken: "bad-token",
      assetId: "asset-1",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce({
      id: "artifact-1",
      visibility: "REVOKED",
      classification: "OPEN_CORE",
      publicRevokedAt: new Date("2026-04-29T11:00:00.000Z"),
      assets: [{ id: "asset-1", storageKey: "stored/key.png" }],
    });
    await expect(resolvePublicBuildArtifactAsset({
      publicToken: "public-token",
      assetId: "asset-1",
    })).rejects.toMatchObject({ status: 410, code: "PUBLIC_LINK_REVOKED" });
  });

  it("revokes public access when GitHub reports a PR merged", async () => {
    const asset = assetFixture();
    const open = artifactFixture({ brainSourceId: "brain-1", assets: [asset] });
    const merged = artifactFixture({
      brainSourceId: "brain-1",
      assets: [asset],
      status: "MERGED",
      visibility: "REVOKED",
      publicTokenEnc: null,
      publicRevokedAt: new Date("2026-04-29T12:00:00.000Z"),
    });
    prismaMock.buildArtifact.findMany.mockResolvedValue([open]);
    prismaMock.buildArtifact.update.mockResolvedValue(merged);
    prismaMock.buildArtifact.findUnique.mockResolvedValue(merged);
    prismaMock.brainSource.update.mockResolvedValue({ id: "brain-1" });

    const { markBuildArtifactClosedFromGitHub } = await import("./build-artifacts");
    const result = await markBuildArtifactClosedFromGitHub({
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      merged: true,
      mergeCommitSha: "merge123",
      closedAt: new Date("2026-04-29T12:00:00.000Z"),
    });

    expect(result).toEqual({ updatedCount: 1, artifactIds: ["artifact-1"] });
    expect(prismaMock.buildArtifact.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "MERGED",
        visibility: "REVOKED",
        publicTokenEnc: null,
        mergeCommitSha: "merge123",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "build_artifact.github_merged",
        meta: expect.objectContaining({ publicAccessRevoked: true }),
      }),
    }));
  });

  it("resolves GitHub repository allowlists from build artifact feature config", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        config: { githubRepositories: ["puncar-dev/CORGTEX", "other/repo"] },
      },
      {
        workspaceId: "workspace-2",
        config: { githubRepositories: ["Puncar-Dev/corgtex"] },
      },
      {
        workspaceId: "workspace-3",
        config: { githubRepositories: ["bad-format", 42] },
      },
    ]);

    const { listBuildArtifactWorkspaceIdsForGithubRepository } = await import("./build-artifacts");
    await expect(listBuildArtifactWorkspaceIdsForGithubRepository({
      repositoryOwner: "Puncar-Dev",
      repositoryName: "CORGTEX",
    })).resolves.toEqual(["workspace-1", "workspace-2"]);

    expect(prismaMock.workspaceFeatureFlag.findMany).toHaveBeenCalledWith({
      where: {
        flag: "BUILD_ARTIFACTS",
        enabled: true,
      },
      select: {
        workspaceId: true,
        config: true,
      },
    });
  });

  it("creates open build artifacts from mapped GitHub pull requests", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        config: { githubRepositories: ["puncar-dev/corgtex"] },
      },
    ]);
    prismaMock.buildArtifact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(artifactFixture({
        brainSourceId: "brain-1",
        classification: "INTERNAL",
        visibility: "PRIVATE",
        summaryMd: "GitHub review state: draft PR",
      }));
    prismaMock.buildArtifact.create.mockResolvedValue(artifactFixture({
      createdByUserId: null,
      classification: "INTERNAL",
      visibility: "PRIVATE",
      summaryMd: "GitHub review state: draft PR",
    }));
    prismaMock.buildArtifact.findUnique.mockResolvedValue(artifactFixture({
      createdByUserId: null,
      classification: "INTERNAL",
      visibility: "PRIVATE",
      summaryMd: "GitHub review state: draft PR",
    }));

    const { upsertBuildArtifactsFromGitHubPullRequest } = await import("./build-artifacts");
    const result = await upsertBuildArtifactsFromGitHubPullRequest({
      repositoryOwner: "Puncar-Dev",
      repositoryName: "CORGTEX",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
      branchName: "feat/outcome-board",
      commitSha: "abc123",
      title: "Built outcome board",
      bodyMd: "Plan and acceptance criteria.",
      isDraft: true,
    });

    expect(result).toEqual({ updatedCount: 1, artifactIds: ["artifact-1"] });
    expect(prismaMock.buildArtifact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        createdByUserId: null,
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 42,
        branchName: "feat/outcome-board",
        commitSha: "abc123",
        status: "OPEN",
        classification: "INTERNAL",
        visibility: "PRIVATE",
        summaryMd: expect.stringContaining("PR description:\nPlan and acceptance criteria."),
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "build_artifact.github_created",
        meta: expect.objectContaining({ isDraft: true }),
      }),
    }));
  });
});
