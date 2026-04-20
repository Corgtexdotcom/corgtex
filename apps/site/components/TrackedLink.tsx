"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { trackEvent } from "../lib/analytics-client";

type TrackedLinkProps = {
  children: ReactNode;
  className?: string;
  eventName?: string;
  href: string;
  newTab?: boolean;
};

function isExternalHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:");
}

export function TrackedLink({ href, children, className, eventName, newTab = false }: TrackedLinkProps) {
  const handleClick = () => {
    if (eventName) {
      trackEvent(eventName, { href });
    }
  };

  if (isExternalHref(href)) {
    return (
      <a
        href={href}
        className={className}
        onClick={handleClick}
        rel={newTab ? "noreferrer" : undefined}
        target={newTab ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className} onClick={handleClick}>
      {children}
    </Link>
  );
}
