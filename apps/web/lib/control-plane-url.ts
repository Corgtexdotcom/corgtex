import { env } from "@corgtex/shared";
import {
  localizedControlPlanePath,
  normalizeControlPlaneLocale,
  type ControlPlaneLocale,
} from "@/lib/control-plane-path";

export const DEFAULT_CONTROL_PLANE_ORIGIN = "https://ops.corgtex.com";
export const RAW_OPS_RAILWAY_HOST = "web-production-6a3ab.up.railway.app";

export function normalizeOrigin(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function configuredControlPlaneOrigin() {
  const configuredOrigin = normalizeOrigin(env.CONTROL_PLANE_URL);
  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (env.CONTROL_PLANE_MODE) {
    return normalizeOrigin(env.APP_URL);
  }

  return env.NODE_ENV === "production" ? DEFAULT_CONTROL_PLANE_ORIGIN : null;
}

export function controlPlanePath(pathname = "/control-plane", locale: string | ControlPlaneLocale = "en") {
  return localizedControlPlanePath(pathname, normalizeControlPlaneLocale(locale));
}

export function getControlPlaneHref(pathname = "/control-plane", locale: string | ControlPlaneLocale = "en") {
  const path = controlPlanePath(pathname, locale);
  if (env.CONTROL_PLANE_MODE) {
    return path;
  }

  const origin = configuredControlPlaneOrigin();
  return origin ? `${origin}${path}` : path;
}

export function getCanonicalControlPlaneHref(pathname = "/control-plane", locale: string | ControlPlaneLocale = "en") {
  const path = controlPlanePath(pathname, locale);
  const origin = configuredControlPlaneOrigin();
  return origin ? `${origin}${path}` : path;
}
