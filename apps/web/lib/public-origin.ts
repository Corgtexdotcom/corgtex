function firstHeaderValue(headers: Headers, name: string) {
  const value = headers.get(name)?.split(",")[0]?.trim();
  return value || null;
}

function isLocalOrInternalHost(hostname: string) {
  return hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    !hostname.includes(".");
}

function normalizeOrigin(value: string | undefined, allowLocal: boolean) {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!allowLocal && isLocalOrInternalHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function hostnameFromHost(protocol: string, host: string) {
  try {
    return new URL(`${protocol}//${host}`).hostname;
  } catch {
    return "";
  }
}

function configuredPublicOrigin(allowLocal: boolean) {
  return normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL, allowLocal) ||
    normalizeOrigin(process.env.APP_URL, allowLocal);
}

export function getPublicOrigin(request: Request) {
  const allowLocal = process.env.NODE_ENV !== "production";
  const requestUrl = new URL(request.url);
  const host =
    firstHeaderValue(request.headers, "x-forwarded-host") ||
    firstHeaderValue(request.headers, "host") ||
    requestUrl.host;
  const hostname = hostnameFromHost(requestUrl.protocol, host);
  const protocol =
    firstHeaderValue(request.headers, "x-forwarded-proto") ||
    (process.env.NODE_ENV === "production" && !isLocalOrInternalHost(hostname)
      ? "https"
      : requestUrl.protocol.replace(/:$/, ""));
  const requestOrigin = normalizeOrigin(`${protocol}://${host}`, allowLocal);
  if (requestOrigin) return requestOrigin;

  const configured = configuredPublicOrigin(allowLocal);
  if (configured) return configured;

  return `${protocol}://${host}`;
}

export function getPublicRequestUrl(request: Request) {
  const requestUrl = new URL(request.url);
  return `${getPublicOrigin(request)}${requestUrl.pathname}${requestUrl.search}`;
}
