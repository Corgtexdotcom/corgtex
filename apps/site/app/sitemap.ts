import type { MetadataRoute } from "next";
import { absoluteSiteUrl } from "../lib/site";

const routes: { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/about", changeFrequency: "monthly", priority: 0.8 },
  { path: "/faq", changeFrequency: "monthly", priority: 0.9 },
  { path: "/how-we-work", changeFrequency: "monthly", priority: 0.9 },
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
  return routes.map((route) => ({
    url: absoluteSiteUrl(route.path),
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
