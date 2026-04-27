import { env } from "@corgtex/shared";

const SLACK_CALLBACK_PATH = "/api/integrations/slack/callback";

function appOrigin(request: Request) {
  return (env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
}

function isNextRedirectError(error: unknown): error is { digest: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT")
  );
}

export function slackCallbackRedirectUri(request: Request) {
  return `${appOrigin(request)}${SLACK_CALLBACK_PATH}`;
}

export function appRedirectUrl(request: Request, path: string) {
  return new URL(path, `${appOrigin(request)}/`);
}

export function rethrowNextRedirectError(error: unknown) {
  if (isNextRedirectError(error)) {
    throw error;
  }
}
