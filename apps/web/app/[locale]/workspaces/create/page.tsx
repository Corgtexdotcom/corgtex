import { createWorkspaceAction } from "@/lib/workspace-actions";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function CreateWorkspacePage() {
  await requirePageActor();
  const t = await getTranslations("common");

  return (
    <main className="login-shell" style={{ maxWidth: 600, margin: "auto", paddingTop: 80 }}>
      <section className="panel">
        <span className="tag">{t("unifiedInterface")}</span>
        <h1>{t("createWorkspace")}</h1>
        <p className="muted">{t("setupWorkspace")}</p>
        
        <form action={createWorkspaceAction} className="stack" style={{ marginTop: 24 }}>
          <label>
            {t("name")}
            <input name="name" required placeholder={t("myAwesomeTeam")} />
          </label>
          <label>
            {t("slug")}
            <input name="slug" required pattern="[a-z0-9-]+" placeholder={t("teamSlug")} />
          </label>
          <label>
            {t("description")}
            <textarea name="description" placeholder={t("whatIsThisWorkspaceFor")} />
          </label>
          <button type="submit">{t("createWorkspace")}</button>
        </form>
      </section>
    </main>
  );
}
