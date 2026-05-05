import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

export default async function ControlPlaneCustomerNotFound() {
  const t = await getTranslations("controlPlane");

  return (
    <main className="control-plane-shell">
      <div className="control-plane-content stack" style={{ maxWidth: 720, margin: "48px auto" }}>
        <section className="panel stack" style={{ padding: 24 }}>
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>{t("customerNotFound.eyebrow")}</p>
            <h1 className="title-lg" style={{ margin: 0 }}>{t("customerNotFound.title")}</h1>
            <p className="muted" style={{ margin: "8px 0 0" }}>{t("customerNotFound.description")}</p>
          </div>
          <div className="actions-inline">
            <Link className="link-button small" href="/control-plane">
              {t("customerNotFound.backToFleet")}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
