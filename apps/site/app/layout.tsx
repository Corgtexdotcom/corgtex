import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getSiteConfig } from "../lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteConfig().siteUrl),
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
