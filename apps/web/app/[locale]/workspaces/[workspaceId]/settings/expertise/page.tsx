import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { createExpertiseTagAction, addMemberExpertiseAction } from "../../actions";
import { listExpertiseTags } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function ExpertiseSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();

  // Make sure to load the member profile for the actor so they can manage their own
  const member = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.kind === "user" ? actor.user.id : "" } },
    include: { expertise: { include: { expertiseTag: true } } },
  });

  const allTags = await listExpertiseTags(actor, workspaceId);
  const t = await getTranslations("settings");

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("expertisePageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("expertisePageDescription")}</span>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <section className="ws-section stack">
          <h2 className="nr-section-header">{t("sectionWorkspaceTags")}</h2>
          <p className="muted">{t("descWorkspaceTags")}</p>
          
          <div className="nr-filter-bar" style={{ flexWrap: "wrap" }}>
            {allTags.length === 0 && <span className="muted">{t("noTags")}</span>}
            {allTags.map(tag => (
              <span key={tag.id} className="nr-filter-item" title={tag.description || tag.slug}>
                {tag.label}
              </span>
            ))}
          </div>

          <details>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)", marginTop: 16 }}>
              {t("btnAddTag")}
            </summary>
            <form action={createExpertiseTagAction} className="stack nr-form-section">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("labelTopic")}
                <input name="label" required placeholder={t("placeholderTopic")} />
              </label>
              <label>
                {t("labelDescription")}
                <input name="description" placeholder={t("placeholderDescription")} />
              </label>
              <button type="submit">{t("btnCreateTag")}</button>
            </form>
          </details>
        </section>

        <section className="ws-section stack">
          <h2 className="nr-section-header">{t("sectionMyExpertise")}</h2>
          {member ? (
            <>
              {member.expertise.length === 0 && <p className="muted">{t("noClaimedExpertise")}</p>}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {member.expertise.map(exp => (
                  <div key={exp.id} className="nr-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{exp.expertiseTag.label}</span>
                    <span className={`tag ${exp.level === "AUTHORITY" ? "danger" : exp.level === "EXPERT" ? "warning" : "info"}`}>{exp.level}</span>
                  </div>
                ))}
              </div>

              <details>
                <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)", marginTop: 16 }}>
                  {t("btnClaimExpertise")}
                </summary>
                {allTags.length > 0 ? (
                  <form action={addMemberExpertiseAction} className="stack nr-form-section">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="memberId" value={member.id} />
                    <label>
                      {t("labelExpertiseArea")}
                      <select name="tagId" required>
                        <option value="">{t("selectTag")}</option>
                        {allTags.map(tag => (
                          <option key={tag.id} value={tag.id}>{tag.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("labelLevel")}
                      <select name="level" required defaultValue="PRACTITIONER">
                        <option value="LEARNING">{t("levelLearning")}</option>
                        <option value="PRACTITIONER">{t("levelPractitioner")}</option>
                        <option value="EXPERT">{t("levelExpert")}</option>
                        <option value="AUTHORITY">{t("levelAuthority")}</option>
                      </select>
                    </label>
                    <button type="submit">{t("btnAddToProfile")}</button>
                  </form>
                ) : (
                  <p className="muted">{t("createTagsFirst")}</p>
                )}
              </details>
            </>
          ) : (
            <p className="muted">{t("profileUnavailable")}</p>
          )}
        </section>
      </div>
    </>
  );
}
