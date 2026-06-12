import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, envMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
    workspaceSsoConfig: {
      findMany: vi.fn(),
    },
  },
  envMock: {
    APP_URL: "https://selfserve.corgtex.com",
    ENTERPRISE_ACCOUNT_DIRECTORY_JSON: undefined as string | undefined,
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: envMock,
  prisma: prismaMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  envMock.APP_URL = "https://selfserve.corgtex.com";
  envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = undefined;
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.workspaceSsoConfig.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.resetModules();
});

describe("enterprise account discovery", () => {
  it("finds active central memberships by exact email", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      memberships: [
        {
          workspace: {
            id: "workspace-1",
            slug: "acme",
            name: "Acme",
          },
        },
      ],
    });

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    await expect(findEnterpriseAccountsForEmail(" Admin@Acme.com ")).resolves.toEqual({
      email: "admin@acme.com",
      matches: [
        {
          slug: "acme",
          label: "Acme",
          loginUrl: "https://selfserve.corgtex.com/login?email=admin%40acme.com",
          source: "central_membership",
          matchKind: "exact_email",
          workspaceId: "workspace-1",
        },
      ],
    });
  });

  it("finds enabled central SSO configs by email domain", async () => {
    prismaMock.workspaceSsoConfig.findMany.mockResolvedValue([
      {
        workspaceId: "workspace-sso",
        allowedDomains: ["acme.com"],
        workspace: {
          id: "workspace-sso",
          slug: "acme",
          name: "Acme",
        },
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    const result = await findEnterpriseAccountsForEmail("person@acme.com");

    expect(result.matches).toEqual([
      {
        slug: "acme",
        label: "Acme",
        loginUrl: "https://selfserve.corgtex.com/api/auth/sso/init?email=person%40acme.com&workspaceId=workspace-sso",
        source: "central_sso",
        matchKind: "email_domain",
        workspaceId: "workspace-sso",
      },
    ]);
  });

  it("finds configured dedicated account directory entries by email domain", async () => {
    envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = JSON.stringify([
      {
        slug: "atlas",
        label: "Atlas",
        loginUrl: "https://atlas.corgtex.com",
        domains: ["atlas.example"],
        status: "active",
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    const result = await findEnterpriseAccountsForEmail("operator@atlas.example");

    expect(result.matches).toEqual([
      {
        slug: "atlas",
        label: "Atlas",
        loginUrl: "https://atlas.corgtex.com/login?email=operator%40atlas.example",
        source: "directory",
        matchKind: "email_domain",
      },
    ]);
  });

  it("returns multiple matches when the email belongs to multiple accounts", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      memberships: [
        {
          workspace: {
            id: "workspace-1",
            slug: "acme",
            name: "Acme",
          },
        },
      ],
    });
    envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = JSON.stringify([
      {
        slug: "acme-dedicated",
        label: "Acme Dedicated",
        loginUrl: "https://acme.corgtex.com",
        domains: ["acme.com"],
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    const result = await findEnterpriseAccountsForEmail("admin@acme.com");

    expect(result.matches.map((match) => match.label)).toEqual(["Acme", "Acme Dedicated"]);
  });

  it("returns no matches when membership, SSO, and directory do not match", async () => {
    envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = JSON.stringify([
      {
        slug: "atlas",
        label: "Atlas",
        loginUrl: "https://atlas.corgtex.com",
        domains: ["atlas.example"],
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    await expect(findEnterpriseAccountsForEmail("person@example.com")).resolves.toEqual({
      email: "person@example.com",
      matches: [],
    });
  });

  it("deduplicates SSO and exact membership matches for the same workspace", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      memberships: [
        {
          workspace: {
            id: "workspace-1",
            slug: "acme",
            name: "Acme",
          },
        },
      ],
    });
    prismaMock.workspaceSsoConfig.findMany.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        allowedDomains: ["acme.com"],
        workspace: {
          id: "workspace-1",
          slug: "acme",
          name: "Acme",
        },
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    const result = await findEnterpriseAccountsForEmail("admin@acme.com");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.source).toBe("central_membership");
  });

  it("rejects invalid directory config", async () => {
    envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = JSON.stringify([
      {
        slug: "atlas",
        label: "Atlas",
        loginUrl: "https://atlas.corgtex.com",
        domains: [],
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    await expect(findEnterpriseAccountsForEmail("operator@atlas.example")).rejects.toMatchObject({
      code: "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID",
    });
  });

  it("ignores inactive directory entries", async () => {
    envMock.ENTERPRISE_ACCOUNT_DIRECTORY_JSON = JSON.stringify([
      {
        slug: "atlas",
        label: "Atlas",
        loginUrl: "https://atlas.corgtex.com",
        domains: ["atlas.example"],
        status: "inactive",
      },
    ]);

    const { findEnterpriseAccountsForEmail } = await import("./enterprise-account-discovery");
    const result = await findEnterpriseAccountsForEmail("operator@atlas.example");

    expect(result.matches).toEqual([]);
  });
});
