"use client";

import { useTranslations } from "next-intl";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatStableDate(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return DATE_FORMATTER.format(date);
}

export function RecentUploads({ documents }: { documents: any[] }) {
  const t = useTranslations("settings");

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
                 <span style={{ marginLeft: 8 }}>{formatStableDate(doc.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
