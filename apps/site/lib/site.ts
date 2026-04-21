export type SiteConfig = {
  appUrl: string;
  bookDemoUrl: string;
  demoUrl: string;
  siteUrl: string;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function publicUrl(name: string, fallback: string) {
  return trimTrailingSlash(process.env[name]?.trim() || fallback);
}

export function getSiteConfig(): SiteConfig {
  const siteUrl = publicUrl("NEXT_PUBLIC_SITE_URL", process.env.NODE_ENV === "production" ? "https://corgtex.com" : "http://localhost:3008");
  const appUrl = publicUrl("NEXT_PUBLIC_APP_URL", process.env.NODE_ENV === "production" ? "https://app.corgtex.com" : "http://localhost:3000");
  const demoUrl = publicUrl("NEXT_PUBLIC_DEMO_URL", `${appUrl}/demo`);
  const bookDemoUrl = process.env.NEXT_PUBLIC_BOOK_DEMO_URL?.trim() || "https://calendly.com/corgtex/demo";

  return {
    siteUrl,
    appUrl,
    demoUrl,
    bookDemoUrl,
  };
}

export function absoluteSiteUrl(path = "/") {
  const { siteUrl } = getSiteConfig();
  return new URL(path, `${siteUrl}/`).toString();
}
