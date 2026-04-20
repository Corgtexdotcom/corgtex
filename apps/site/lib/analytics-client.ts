"use client";

type AnalyticsPayload = {
  href?: string;
  name: string;
  path?: string;
};

function send(payload: AnalyticsPayload) {
  const body = JSON.stringify(payload);

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon("/api/analytics", new Blob([body], { type: "application/json" }));
    return;
  }

  void fetch("/api/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

export function trackEvent(name: string, payload: Omit<AnalyticsPayload, "name"> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  send({
    name,
    ...payload,
  });
}
