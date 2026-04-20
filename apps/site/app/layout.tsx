import type { Metadata } from "next";
import { Inter, Playfair_Display, Montserrat } from "next/font/google";
import { Navbar } from "../components/Navbar";
import { Footer } from "../components/Footer";
import { PageViewTracker } from "../components/PageViewTracker";
import { StructuredData } from "../components/StructuredData";
import { getSiteConfig } from "../lib/site";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});

const montserrat = Montserrat({
  weight: ["900"],
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
});

const { siteUrl } = getSiteConfig();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Corgtex — Run Your AI Workforce Like an Accountable Team",
    template: "%s | Corgtex",
  },
  description:
    "Corgtex gives you total visibility into your AI workforce — what every agent is doing, governed by your rules, with costs you can see. Live in weeks, yours to own.",
  openGraph: {
    title: "Corgtex — Run Your AI Workforce Like an Accountable Team",
    description:
      "See what every agent is doing. Govern it with your rules. Know what it costs.",
    type: "website",
    siteName: "Corgtex",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://corgtex.com/#organization",
      "name": "Corgtex",
      "url": "https://corgtex.com",
      "description": "Governed AI workforce platform — see, govern, and afford every AI agent in your organization.",
      "founder": { "@id": "https://corgtex.com/#founder" },
      "contactPoint": {
        "@type": "ContactPoint",
        "email": "hello@corgtex.com",
      },
    },
    {
      "@type": "Person",
      "@id": "https://corgtex.com/#founder",
      "name": "Jan Brezina",
      "alternateName": "Puncar",
      "jobTitle": "Founder & CEO",
      "description": "Author of 'How to DAO' (Penguin Random House), decade-long practitioner of decentralized governance and self-management. Expert in Holacracy, Sociocracy, and Teal organizations.",
      "url": "https://corgtex.com/about",
    },
    {
      "@type": "Book",
      "@id": "https://corgtex.com/#book",
      "name": "How to DAO",
      "author": { "@id": "https://corgtex.com/#founder" },
      "publisher": { "@type": "Organization", "name": "Penguin Random House" },
      "url": "https://www.amazon.com/dp/059371377X",
      "description": "A comprehensive guide to decentralized organizational governance.",
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://corgtex.com/#product",
      "name": "Corgtex",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "Governed AI workforce platform that gives total visibility into AI agents, enforces organizational policies, and tracks AI costs attributed to real work.",
      "offers": {
        "@type": "Offer",
        "category": "Enterprise",
        "priceSpecification": {
          "@type": "PriceSpecification",
          "description": "Custom pricing based on organization size and capabilities implemented",
        },
      },
      "creator": { "@id": "https://corgtex.com/#organization" },
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${montserrat.variable}`}>
      <head>
        <StructuredData data={structuredData} />
      </head>
      <body>
        <PageViewTracker />
        <Navbar />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
