"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { localizedPath } from "../i18n/routing";
import { enterpriseLoginUrlForLocale, getSiteConfig, signupUrlForLocale } from "../lib/site";

const NAV_LINKS: { href: string; labelKey: string }[] = [
  { href: "/about", labelKey: "about" },
  { href: "/pricing", labelKey: "pricing" },
  { href: "/how-we-work", labelKey: "howWeWork" },
  { href: "/blog", labelKey: "blog" },
  { href: "/faq", labelKey: "faq" },
];

function unprefixedPath(pathname: string) {
  return pathname.replace(/^\/(en|es)(?=\/|$)/, "") || "/";
}

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const locale = useLocale();
  const pathname = usePathname() ?? "/";
  const t = useTranslations("nav");
  const { bookDemoUrl } = getSiteConfig();

  const signupUrl = signupUrlForLocale(locale);
  const loginUrl = enterpriseLoginUrlForLocale(locale);
  const localePath = (path: string) => localizedPath(path, locale);
  const switchLocaleHref = localizedPath(unprefixedPath(pathname), locale === "es" ? "en" : "es");

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      <nav
        className="navbar"
        style={scrolled ? { boxShadow: "0 1px 4px rgba(0,0,0,0.06)" } : undefined}
      >
        <div className="navbar-inner">
          <a href={localePath("/")} className="navbar-logo">Corgtex</a>

          <ul className="navbar-links">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={localePath(link.href)}>{t(link.labelKey)}</a>
              </li>
            ))}
          </ul>

          <div className="navbar-cta">
            <a
              href={loginUrl}
              className="navbar-login"
            >
              {t("login")}
            </a>
            <a
              href={signupUrl}
              className="btn btn-primary"
            >
              {t("startTrial")}
            </a>
            <a
              href={bookDemoUrl}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("briefing")}
            </a>
            <a href={switchLocaleHref} className="navbar-login" aria-label={t("language")}>
              {locale === "es" ? "EN" : "ES"}
            </a>
          </div>

          <button
            className="navbar-toggle"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={t("toggle")}
            aria-controls="site-mobile-menu"
            aria-expanded={mobileOpen}
          >
            <span
              style={
                mobileOpen
                  ? { transform: "rotate(45deg) translateY(7px)" }
                  : undefined
              }
            />
            <span style={mobileOpen ? { opacity: 0 } : undefined} />
            <span
              style={
                mobileOpen
                  ? { transform: "rotate(-45deg) translateY(-7px)" }
                  : undefined
              }
            />
          </button>
        </div>
      </nav>

      <div id="site-mobile-menu" className={`mobile-menu ${mobileOpen ? "open" : ""}`}>
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={localePath(link.href)}
            onClick={() => setMobileOpen(false)}
          >
            {t(link.labelKey)}
          </a>
        ))}
        <a
          href={loginUrl}
          onClick={() => setMobileOpen(false)}
        >
          {t("login")}
        </a>
        <a
          href={signupUrl}
          className="btn btn-primary"
          onClick={() => setMobileOpen(false)}
        >
          {t("startTrial")}
        </a>
        <a
          href={bookDemoUrl}
          className="btn btn-secondary"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setMobileOpen(false)}
        >
          {t("briefing")}
        </a>
        <a href={switchLocaleHref} onClick={() => setMobileOpen(false)}>
          {locale === "es" ? "English" : "Español"}
        </a>
      </div>
    </>
  );
}
