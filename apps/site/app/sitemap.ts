import type { MetadataRoute } from "next";
import { absoluteSiteUrl } from "../lib/site";
import { pathAlternates } from "../i18n/routing";

const routes: { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/about", changeFrequency: "monthly", priority: 0.8 },
  { path: "/faq", changeFrequency: "monthly", priority: 0.9 },
  { path: "/how-we-work", changeFrequency: "monthly", priority: 0.9 },
  { path: "/demo", changeFrequency: "monthly", priority: 0.9 },
  { path: "/facts", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.9 },
  { path: "/blog/what-is-organizational-operating-system", changeFrequency: "monthly", priority: 0.8 },
  { path: "/blog/corgtex-vs-glassfrog-vs-peerdom", changeFrequency: "monthly", priority: 0.8 },
  { path: "/blog/self-management-with-ai", changeFrequency: "monthly", priority: 0.8 },
  { path: "/blog/ai-used-to-be-your-intern", changeFrequency: "monthly", priority: 0.8 },
  { path: "/blog/automation-is-just-table-stakes", changeFrequency: "monthly", priority: 0.8 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.9 },
  { path: "/updates", changeFrequency: "weekly", priority: 0.8 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.flatMap((route) => {
    const alternates = pathAlternates(route.path);
    const languages = {
      en: absoluteSiteUrl(alternates.en),
      es: absoluteSiteUrl(alternates.es),
      "x-default": absoluteSiteUrl(alternates["x-default"]),
    };

    return [
      {
        url: absoluteSiteUrl(alternates.en),
        lastModified: new Date(),
        changeFrequency: route.changeFrequency,
        priority: route.priority,
        alternates: { languages },
      },
      {
        url: absoluteSiteUrl(alternates.es),
        lastModified: new Date(),
        changeFrequency: route.changeFrequency,
        priority: Math.max(route.priority - 0.05, 0.1),
        alternates: { languages },
      },
    ];
  });
}
