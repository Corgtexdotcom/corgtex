import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // We only want unhandled exceptions, no APM tracing
  tracesSampleRate: 0.0,
  debug: false,
});
