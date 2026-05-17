"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

function formatLocalDate(value: Date | string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
  }).format(date);
}

export function RecentUploads({ documents }: { documents: any[] }) {
  const locale = useLocale();
  const t = useTranslations("settings");
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  return (
    <section className="stack" style={{ marginTop: 40 }}>
      <h2 className="nr-section-header">{t("sectionRecentUploads")}</h2>
      {documents.length === 0 ? (
         <p className="nr-item-meta">{t("noRecentUploads")}</p>
      ) : (
        <div>
          {documents.map(doc => (
            <div className="nr-item" key={doc.id} style={{ padding: "12px 16px", marginBottom: 8 }}>
              <div className="row" style={{ display: "flex", justifyContent: "space-between" }}>
                <strong className="nr-item-title">{doc.title}</strong>
              </div>
              <div className="nr-item-meta" style={{ marginTop: 4, fontSize: "0.85rem" }} suppressHydrationWarning>
                 <span className="tag">{doc.source}</span>
                 <span style={{ marginLeft: 8 }}>{isHydrated ? formatLocalDate(doc.createdAt, locale) : ""}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
