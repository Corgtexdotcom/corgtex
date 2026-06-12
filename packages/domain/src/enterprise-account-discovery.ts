import { env, prisma } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

export type EnterpriseAccountMatchSource = "central_membership" | "central_sso" | "directory";
export type EnterpriseAccountMatchKind = "exact_email" | "email_domain";

export type EnterpriseAccountMatch = {
  slug: string;
  label: string;
  loginUrl: string;
  source: EnterpriseAccountMatchSource;
  matchKind: EnterpriseAccountMatchKind;
  workspaceId?: string;
};

export type EnterpriseAccountDiscoveryResult = {
  email: string;
  matches: EnterpriseAccountMatch[];
};

type DirectoryEntry = {
  slug: string;
  label: string;
  loginUrl: string;
  domains: string[];
  status: "active" | "inactive";
};

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  invariant(normalized.length > 0, 400, "INVALID_INPUT", "Email is required.");
  invariant(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized), 400, "INVALID_INPUT", "Enter a valid email address.");
  return normalized;
}

function emailDomain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDomains(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((domain) => normalizeString(domain).toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

function normalizeDirectoryUrl(value: unknown) {
  const raw = normalizeString(value);
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Enterprise account URL must be absolute.");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseEnterpriseAccountDirectory(raw = env.ENTERPRISE_ACCOUNT_DIRECTORY_JSON): DirectoryEntry[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(500, "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID", "Enterprise account directory config is not valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(500, "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID", "Enterprise account directory config must be an array.");
  }

  return parsed.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!record) {
      throw new AppError(500, "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID", `Enterprise account directory entry ${index + 1} is invalid.`);
    }

    const slug = normalizeString(record.slug).toLowerCase();
    const label = normalizeString(record.label);
    const domains = normalizeDomains(record.domains);
    const status = normalizeString(record.status).toLowerCase() || "active";

    if (!slug || !label || domains.length === 0 || (status !== "active" && status !== "inactive")) {
      throw new AppError(500, "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID", `Enterprise account directory entry ${index + 1} is invalid.`);
    }

    let loginUrl: string;
    try {
      loginUrl = normalizeDirectoryUrl(record.loginUrl);
    } catch {
      throw new AppError(500, "ENTERPRISE_ACCOUNT_DIRECTORY_INVALID", `Enterprise account directory entry ${index + 1} is invalid.`);
    }

    return {
      slug,
      label,
      loginUrl,
      domains,
      status,
    };
  });
}

function appUrl(path: string, params: Record<string, string>) {
  const url = new URL(path, `${env.APP_URL.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function directoryLoginUrl(baseUrl: string, email: string) {
  const url = new URL(baseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/login";
  }
  url.searchParams.set("email", email);
  return url.toString();
}

function addMatch(matches: Map<string, EnterpriseAccountMatch>, match: EnterpriseAccountMatch) {
  const key = match.workspaceId ? `workspace:${match.workspaceId}` : `directory:${match.slug}:${match.loginUrl}`;
  if (!matches.has(key)) {
    matches.set(key, match);
  }
}

export async function findEnterpriseAccountsForEmail(inputEmail: string): Promise<EnterpriseAccountDiscoveryResult> {
  const email = normalizeEmail(inputEmail);
  const domain = emailDomain(email);
  const matches = new Map<string, EnterpriseAccountMatch>();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      memberships: {
        where: { isActive: true },
        select: {
          workspace: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  for (const membership of user?.memberships ?? []) {
    addMatch(matches, {
      slug: membership.workspace.slug,
      label: membership.workspace.name,
      loginUrl: appUrl("/login", { email }),
      source: "central_membership",
      matchKind: "exact_email",
      workspaceId: membership.workspace.id,
    });
  }

  const ssoConfigs = await prisma.workspaceSsoConfig.findMany({
    where: { isEnabled: true },
    include: {
      workspace: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
  });

  for (const config of ssoConfigs) {
    if (!config.allowedDomains.some((allowedDomain) => allowedDomain.toLowerCase() === domain)) {
      continue;
    }
    addMatch(matches, {
      slug: config.workspace.slug,
      label: config.workspace.name,
      loginUrl: appUrl("/api/auth/sso/init", { email, workspaceId: config.workspaceId }),
      source: "central_sso",
      matchKind: "email_domain",
      workspaceId: config.workspaceId,
    });
  }

  for (const entry of parseEnterpriseAccountDirectory()) {
    if (entry.status !== "active" || !entry.domains.includes(domain)) {
      continue;
    }
    addMatch(matches, {
      slug: entry.slug,
      label: entry.label,
      loginUrl: directoryLoginUrl(entry.loginUrl, email),
      source: "directory",
      matchKind: "email_domain",
    });
  }

  return {
    email,
    matches: [...matches.values()],
  };
}
