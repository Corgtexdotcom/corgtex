"use client";

import { useLocale, useTranslations } from "next-intl";
import { localizedPath } from "../i18n/routing";
import { demoGatePathForLocale } from "../lib/site";

export function Footer() {
  const year = new Date().getFullYear();
  const locale = useLocale();
  const t = useTranslations("footer");
  const localePath = (path: string) => localizedPath(path, locale);

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <a href={localePath("/")} className="navbar-logo">Corgtex</a>
            <p>
              {t("tagline")}
            </p>
          </div>

          <div className="footer-col">
            <h4>{t("product")}</h4>
            <ul>
              <li><a href={demoGatePathForLocale(locale)}>{t("liveDemo")}</a></li>
              <li><a href={localePath("/pricing")}>{t("pricing")}</a></li>
              <li><a href={localePath("/faq")}>{t("faq")}</a></li>
              <li><a href={localePath("/how-we-work")}>{t("howWeWork")}</a></li>
              <li><a href={localePath("/facts")}>{t("facts")}</a></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>{t("company")}</h4>
            <ul>
              <li><a href={localePath("/about")}>{t("about")}</a></li>
              <li><a href={localePath("/blog")}>{t("blog")}</a></li>
              <li><a href={localePath("/updates")}>{t("updates")}</a></li>
              <li><a href="https://github.com/Corgtexdotcom/corgtex" rel="noreferrer" target="_blank">{t("github")}</a></li>
              <li><a href="mailto:hello@corgtex.com">{t("contact")}</a></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>{t("legal")}</h4>
            <ul>
              <li><a href={localePath("/privacy")}>{t("privacy")}</a></li>
              <li><a href={localePath("/terms")}>{t("terms")}</a></li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <span>&copy; {year} Corgtex. {t("rights")}</span>
          <span>{t("bottom")}</span>
        </div>
      </div>
    </footer>
  );
}
