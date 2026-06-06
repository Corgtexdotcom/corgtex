"use client";

type AnalyticsPayload = {
  anonymousId?: string;
  href?: string;
  name: string;
  path?: string;
};

const ANONYMOUS_ID_KEY = "corgtex_site_anonymous_id";

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function anonymousId() {
  try {
    const existing = window.localStorage.getItem(ANONYMOUS_ID_KEY);
    if (existing) return existing;

    const created = randomId();
    window.localStorage.setItem(ANONYMOUS_ID_KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

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
    anonymousId: anonymousId(),
    name,
    ...payload,
  });
}
