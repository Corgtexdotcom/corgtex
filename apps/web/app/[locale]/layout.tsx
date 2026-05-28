import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, Source_Serif_4, IBM_Plex_Mono } from "next/font/google";
import "../globals.css";
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { notFound } from 'next/navigation';
import { ThemeProvider } from "../ThemeProvider";
import { ToastProvider } from "@/lib/components/Toast";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap" });
const sourceSerif = Source_Serif_4({ subsets: ["latin"], variable: "--font-document", display: "swap" });
const ibmPlexMono = IBM_Plex_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");

  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as any)) {
    notFound();
  }
  const messages = await getMessages();

  return (
    <html lang={locale} className={`${inter.variable} ${playfair.variable} ${sourceSerif.variable} ${ibmPlexMono.variable}`} suppressHydrationWarning>
      <body
        className={`${inter.variable} ${playfair.variable} ${sourceSerif.variable} ${ibmPlexMono.variable} font-sans`}
        style={{ background: "var(--bg)" }}
      >
        <ThemeProvider>
          <ToastProvider>
            <NextIntlClientProvider messages={messages}>
              {children}
            </NextIntlClientProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
