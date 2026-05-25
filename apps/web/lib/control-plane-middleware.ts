import { NextResponse, type NextRequest } from "next/server";
import {
  getControlPlaneDefaultLocale,
  localizedControlPlanePath,
  normalizeControlPlaneLocale,
  type ControlPlaneLocale,
} from "@/lib/control-plane-path";

const DEFAULT_CONTROL_PLANE_ORIGIN = "https://ops.corgtex.com";
const RAW_OPS_RAILWAY_HOST = "web-production-6a3ab.up.railway.app";

function booleanEnv(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function normalizeOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function middlewareControlPlaneOrigin() {
  const configuredOrigin = normalizeOrigin(process.env.CONTROL_PLANE_URL);
  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (booleanEnv("CONTROL_PLANE_MODE")) {
    return normalizeOrigin(process.env.APP_URL) ?? normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  }

  return process.env.NODE_ENV === "production" ? DEFAULT_CONTROL_PLANE_ORIGIN : null;
}

function splitLocale(pathname: string): { locale: ControlPlaneLocale; pathnameWithoutLocale: string } {
  const match = pathname.match(/^\/(en|es)(?=\/|$)/);
  if (!match) {
    return { locale: getControlPlaneDefaultLocale(), pathnameWithoutLocale: pathname || "/" };
  }

  const pathnameWithoutLocale = pathname.slice(match[0].length) || "/";
  return {
    locale: normalizeControlPlaneLocale(match[1]),
    pathnameWithoutLocale,
  };
}

function legacyCustomerPath(pathname: string) {
  const match = pathname.match(/^\/control-plane\/customers\/([^/]+)(\/.*)?$/);
  if (!match) {
    return null;
  }

  return `/control-plane/deployments/${match[1]}${match[2] ?? ""}`;
}

function requestHost(request: NextRequest) {
  return request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.nextUrl.host;
}

export function controlPlaneUiRedirect(request: NextRequest) {
  const { locale, pathnameWithoutLocale } = splitLocale(request.nextUrl.pathname);
  if (!pathnameWithoutLocale.startsWith("/control-plane")) {
    return null;
  }

  const origin = middlewareControlPlaneOrigin();
  const legacyTargetPath = legacyCustomerPath(pathnameWithoutLocale);
  const targetPath = legacyTargetPath ?? pathnameWithoutLocale;
  const localizedTargetPath = localizedControlPlanePath(targetPath, normalizeControlPlaneLocale(locale));
  const canonicalHost = origin ? new URL(origin).host : null;
  const host = requestHost(request);
  const controlPlaneMode = booleanEnv("CONTROL_PLANE_MODE");
  const rawRailwayHostNeedsCanonicalRedirect = controlPlaneMode
    && canonicalHost
    && host === RAW_OPS_RAILWAY_HOST
    && host !== canonicalHost;
  const nonOpsDeploymentNeedsCanonicalRedirect = !controlPlaneMode && Boolean(origin);

  if (!legacyTargetPath && !rawRailwayHostNeedsCanonicalRedirect && !nonOpsDeploymentNeedsCanonicalRedirect) {
    return null;
  }

  const target = rawRailwayHostNeedsCanonicalRedirect || nonOpsDeploymentNeedsCanonicalRedirect
    ? new URL(`${localizedTargetPath}${request.nextUrl.search}`, origin ?? request.nextUrl.origin)
    : request.nextUrl.clone();

  target.pathname = localizedTargetPath;
  target.search = request.nextUrl.search;

  return NextResponse.redirect(target, legacyTargetPath ? 308 : 307);
}
