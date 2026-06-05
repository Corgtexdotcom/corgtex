"use client";

import { MessageSquare } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

type IntercomFunction = ((command: string, ...args: unknown[]) => void) & {
  q?: unknown[][];
};

type IntercomTokenResponse =
  | { enabled: false }
  | {
      enabled: true;
      appId: string;
      apiBase: string;
      intercomUserJwt: string;
      expiresAt: string;
    };

declare global {
  interface Window {
    Intercom?: IntercomFunction;
    intercomSettings?: Record<string, unknown>;
  }
}

const configuredAppId = process.env.NEXT_PUBLIC_INTERCOM_APP_ID;
const SCRIPT_ID = "intercom-widget-script";

function installIntercomScript(appId: string) {
  if (typeof window === "undefined") return;

  if (typeof window.Intercom !== "function") {
    const intercom = ((...args: unknown[]) => {
      intercom.q = intercom.q || [];
      intercom.q.push(args);
    }) as IntercomFunction;
    intercom.q = [];
    window.Intercom = intercom;
  }

  if (document.getElementById(SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.type = "text/javascript";
  script.async = true;
  script.src = `https://widget.intercom.io/widget/${appId}`;
  document.head.appendChild(script);
}

async function fetchIntercomToken(workspaceId: string, locale: string, signal?: AbortSignal) {
  const response = await fetch(`/api/workspaces/${workspaceId}/intercom-token?locale=${encodeURIComponent(locale)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error("Unable to load Intercom support.");
  }
  return response.json() as Promise<IntercomTokenResponse>;
}

export function WorkspaceIntercomMessenger({
  locale,
  workspaceId,
}: {
  locale: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const tNav = useTranslations("nav");
  const bootedRef = useRef(false);
  const [isEnabled, setIsEnabled] = useState(Boolean(configuredAppId));

  const bootOrUpdate = useCallback(async (mode: "boot" | "update", signal?: AbortSignal) => {
    if (!configuredAppId) {
      setIsEnabled(false);
      return false;
    }

    const tokenResponse = await fetchIntercomToken(workspaceId, locale, signal);
    if (!tokenResponse.enabled) {
      setIsEnabled(false);
      if (bootedRef.current) {
        window.Intercom?.("shutdown");
        bootedRef.current = false;
      }
      return false;
    }

    installIntercomScript(tokenResponse.appId);
    const settings = {
      app_id: tokenResponse.appId,
      api_base: tokenResponse.apiBase,
      intercom_user_jwt: tokenResponse.intercomUserJwt,
      hide_default_launcher: true,
      language_override: locale === "es" ? "es" : "en",
    };
    window.intercomSettings = settings;

    if (!bootedRef.current || mode === "boot") {
      if (bootedRef.current) {
        window.Intercom?.("shutdown");
      }
      window.Intercom?.("boot", settings);
      bootedRef.current = true;
    } else {
      window.Intercom?.("update", settings);
    }

    setIsEnabled(true);
    return true;
  }, [locale, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void bootOrUpdate("boot", controller.signal).catch(() => {
      setIsEnabled(false);
    });

    return () => {
      controller.abort();
      if (bootedRef.current) {
        window.Intercom?.("shutdown");
        bootedRef.current = false;
      }
    };
  }, [bootOrUpdate]);

  useEffect(() => {
    if (!bootedRef.current) return;
    const controller = new AbortController();
    void bootOrUpdate("update", controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [bootOrUpdate, pathname]);

  async function openSupport() {
    if (!bootedRef.current) {
      const booted = await bootOrUpdate("boot").catch(() => false);
      if (!booted) return;
    }
    window.Intercom?.("show");
  }

  if (!configuredAppId || !isEnabled) {
    return null;
  }

  return (
    <button type="button" className="ws-nav-link ws-logout-btn mt-1" onClick={openSupport}>
      <MessageSquare aria-hidden="true" className="ws-nav-icon" strokeWidth={1.9} />
      {tNav("support")}
    </button>
  );
}
