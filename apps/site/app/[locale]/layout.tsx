import type { Metadata } from "next";
import { Inter, Montserrat, Playfair_Display } from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import "../globals.css";
import { Footer } from "../../components/Footer";
import { Navbar } from "../../components/Navbar";
import { PageViewTracker } from "../../components/PageViewTracker";
import { StructuredData } from "../../components/StructuredData";
import { locales, normalizeSiteLocale, routing, type SiteLocale } from "../../i18n/routing";
import { absoluteSiteUrl, getSiteConfig } from "../../lib/site";

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

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

function structuredData(locale: SiteLocale) {
  const isSpanish = locale === "es";

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://corgtex.com/#organization",
        name: "Corgtex",
        url: "https://corgtex.com",
        description: isSpanish
          ? "Plataforma de fuerza laboral de IA gobernada: ve, gobierna y controla el costo de cada agente de IA en tu organización."
          : "Governed AI workforce platform - see, govern, and afford every AI agent in your organization.",
        founder: { "@id": "https://corgtex.com/#founder" },
        contactPoint: {
          "@type": "ContactPoint",
          email: "hello@corgtex.com",
        },
      },
      {
        "@type": "Person",
        "@id": "https://corgtex.com/#founder",
        name: "Jan Brezina",
        alternateName: "Puncar",
        jobTitle: "Founder & CEO",
        description: isSpanish
          ? "Autor de 'How to DAO' (Penguin Random House), con más de una década de práctica en gobernanza descentralizada, autogestión, Holacracy, Sociocracy y organizaciones Teal."
          : "Author of 'How to DAO' (Penguin Random House), decade-long practitioner of decentralized governance and self-management. Expert in Holacracy, Sociocracy, and Teal organizations.",
        url: absoluteSiteUrl(isSpanish ? "/es/about" : "/about"),
      },
      {
        "@type": "Book",
        "@id": "https://corgtex.com/#book",
        name: "How to DAO",
        author: { "@id": "https://corgtex.com/#founder" },
        publisher: { "@type": "Organization", name: "Penguin Random House" },
        url: "https://www.amazon.com/dp/059371377X",
        description: isSpanish
          ? "Una guía integral de gobernanza organizacional descentralizada."
          : "A comprehensive guide to decentralized organizational governance.",
      },
      {
        "@type": "SoftwareApplication",
        "@id": "https://corgtex.com/#product",
        name: "Corgtex",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description: isSpanish
          ? "Plataforma de fuerza laboral de IA gobernada que da visibilidad total sobre agentes de IA, aplica políticas organizacionales y atribuye costos de IA al trabajo real."
          : "Governed AI workforce platform that gives total visibility into AI agents, enforces organizational policies, and tracks AI costs attributed to real work.",
        offers: {
          "@type": "Offer",
          category: "Enterprise",
          priceSpecification: {
            "@type": "PriceSpecification",
            description: isSpanish
              ? "Precios personalizados según el tamaño de la organización y las capacidades implementadas"
              : "Custom pricing based on organization size and capabilities implemented",
          },
        },
        creator: { "@id": "https://corgtex.com/#organization" },
      },
    ],
  };
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const siteLocale = normalizeSiteLocale(locale);
  const t = await getTranslations({ locale: siteLocale, namespace: "metadata" });
  const { siteUrl } = getSiteConfig();

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: t("title"),
      template: "%s | Corgtex",
    },
    description: t("description"),
    alternates: {
      canonical: absoluteSiteUrl(siteLocale === "es" ? "/es" : "/"),
      languages: {
        en: absoluteSiteUrl("/"),
        es: absoluteSiteUrl("/es"),
        "x-default": absoluteSiteUrl("/"),
      },
    },
    openGraph: {
      title: t("title"),
      description: t("ogDescription"),
      type: "website",
      siteName: "Corgtex",
      locale: siteLocale === "es" ? "es_ES" : "en_US",
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
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: LayoutProps) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as never)) {
    notFound();
  }

  const siteLocale = normalizeSiteLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={siteLocale} className={`${inter.variable} ${playfair.variable} ${montserrat.variable}`}>
      <head>
        <StructuredData data={structuredData(siteLocale)} />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <PageViewTracker />
          <Navbar />
          <main>{children}</main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
