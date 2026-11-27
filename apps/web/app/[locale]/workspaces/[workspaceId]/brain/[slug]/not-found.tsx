import { getTranslations } from "next-intl/server";

export default async function BrainArticleNotFound() {
  const t = await getTranslations("brain");

  return (
    <section className="panel stack" aria-labelledby="brain-article-not-found">
      <h1 id="brain-article-not-found">{t("articleNotFoundTitle")}</h1>
      <p className="muted">{t("articleNotFoundDescription")}</p>
    </section>
  );
}
