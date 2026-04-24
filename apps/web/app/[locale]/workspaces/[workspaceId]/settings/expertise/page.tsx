import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { createExpertiseTagAction, addMemberExpertiseAction } from "../../actions";
import { listExpertiseTags } from "@corgtex/domain";

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

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Expertise Tracking</h1>
        <div className="nr-masthead-meta">
          <span>Manage workspace expertise tags and self-declare your own skills.</span>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <section className="ws-section stack">
          <h2 className="nr-section-header">Workspace Tags</h2>
          <p className="muted">These tags help Corgtex route proposals to the right advisors.</p>
          
          <div className="nr-filter-bar" style={{ flexWrap: "wrap" }}>
            {allTags.length === 0 && <span className="muted">No tags defined yet.</span>}
            {allTags.map(tag => (
              <span key={tag.id} className="nr-filter-item" title={tag.description || tag.slug}>
                {tag.label}
              </span>
            ))}
          </div>

          <details>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)", marginTop: 16 }}>
              + Add new tag
            </summary>
            <form action={createExpertiseTagAction} className="stack nr-form-section">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                Label / Topic
                <input name="label" required placeholder="e.g. React.js, HR Policies, Legal" />
              </label>
              <label>
                Description (Optional)
                <input name="description" placeholder="Brief explanation of this expertise" />
              </label>
              <button type="submit">Create Tag</button>
            </form>
          </details>
        </section>

        <section className="ws-section stack">
          <h2 className="nr-section-header">My Declared Expertise</h2>
          {member ? (
            <>
              {member.expertise.length === 0 && <p className="muted">You haven&apos;t claimed any expertise yet.</p>}
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
                  + Claim Expertise
                </summary>
                {allTags.length > 0 ? (
                  <form action={addMemberExpertiseAction} className="stack nr-form-section">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="memberId" value={member.id} />
                    <label>
                      Expertise Area
                      <select name="tagId" required>
                        <option value="">-- Select Tag --</option>
                        {allTags.map(tag => (
                          <option key={tag.id} value={tag.id}>{tag.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      My Level
                      <select name="level" required defaultValue="PRACTITIONER">
                        <option value="LEARNING">Learning (Some familiarity)</option>
                        <option value="PRACTITIONER">Practitioner (Competent, daily use)</option>
                        <option value="EXPERT">Expert (Go-to person)</option>
                        <option value="AUTHORITY">Authority (Thought leader)</option>
                      </select>
                    </label>
                    <button type="submit">Add to Profile</button>
                  </form>
                ) : (
                  <p className="muted">Create some workspace tags first.</p>
                )}
              </details>
            </>
          ) : (
            <p className="muted">Unable to load your profile.</p>
          )}
        </section>
      </div>
    </>
  );
}
