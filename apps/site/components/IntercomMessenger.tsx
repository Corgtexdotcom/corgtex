"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

type IntercomQueueItem = IArguments | unknown[];

type IntercomFunction = ((command: string, ...args: unknown[]) => void) & {
  c?: (args: IArguments) => void;
  q?: IntercomQueueItem[];
};

declare global {
  interface Window {
    Intercom?: IntercomFunction;
    intercomSettings?: Record<string, unknown>;
  }
}

const appId = process.env.NEXT_PUBLIC_INTERCOM_APP_ID;
const apiBase = process.env.NEXT_PUBLIC_INTERCOM_API_BASE || "https://api-iam.intercom.io";
const SCRIPT_ID = "intercom-widget-script";

function installIntercomScript(intercomAppId: string) {
  if (typeof window === "undefined") return;

  if (typeof window.Intercom !== "function") {
    let intercom: IntercomFunction;
    intercom = (function () {
      intercom.c?.(arguments);
    }) as IntercomFunction;
    intercom.q = [];
    intercom.c = (args) => {
      intercom.q = intercom.q || [];
      intercom.q.push(args);
    };
    window.Intercom = intercom;
  }

  if (document.getElementById(SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.type = "text/javascript";
  script.async = true;
  script.src = `https://widget.intercom.io/widget/${intercomAppId}`;
  document.head.appendChild(script);
}

export function IntercomMessenger({ locale }: { locale: string }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!appId) return;

    installIntercomScript(appId);
    const settings = {
      app_id: appId,
      api_base: apiBase,
      language_override: locale === "es" ? "es" : "en",
      corgtex_surface: "site",
    };
    window.intercomSettings = settings;
    window.Intercom?.("boot", settings);

    return () => {
      window.Intercom?.("shutdown");
    };
  }, [locale]);

  useEffect(() => {
    if (!appId || !window.Intercom) return;
    window.Intercom("update", {
      app_id: appId,
      api_base: apiBase,
      language_override: locale === "es" ? "es" : "en",
      corgtex_surface: "site",
      page_path: pathname,
    });
  }, [locale, pathname]);

  return null;
}
