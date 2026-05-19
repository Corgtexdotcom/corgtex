import { AppError, getRole } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ workspaceId: string; roleId: string }>;
}

function getInitials(name?: string | null, email?: string | null) {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default async function RoleDetailPage({ params }: PageProps) {
  const { workspaceId, roleId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("roles");

  let role;
  try {
    role = await getRole(actor, { workspaceId, roleId });
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) {
      notFound();
    }
    throw error;
  }

  const circleHref = `/workspaces/${workspaceId}/circles?view=list&circleId=${role.circle.id}#circle-${role.circle.id}`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <Link
          href={circleHref}
          style={{ textDecoration: "none", color: "var(--muted)", fontSize: "0.85rem", marginBottom: 16, display: "inline-block" }}
        >
          {t("backToCircle", { name: role.circle.name })}
        </Link>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{role.name}</h1>
        <div className="nr-masthead-meta" style={{ marginTop: 10 }}>
          <Link href={circleHref} style={{ color: "var(--accent)", textDecoration: "none" }}>
            {t("circleMeta", { name: role.circle.name })}
          </Link>
          {role.coreRoleType && <span>{t("coreRoleMeta", { type: role.coreRoleType })}</span>}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 32 }}>
        <div>
          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">{t("purpose")}</h2>
            <div className="nr-item">
              {role.purposeMd ? <p className="nr-excerpt" style={{ margin: 0 }}>{role.purposeMd}</p> : <p className="muted italic">{t("noPurpose")}</p>}
            </div>
          </section>

          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">{t("accountabilities")}</h2>
            {role.accountabilities.length === 0 ? (
              <p className="muted italic">{t("noAccountabilities")}</p>
            ) : (
              <div className="nr-item">
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {role.accountabilities.map((accountability, index) => (
                    <li key={`${role.id}-accountability-${index}`} style={{ marginBottom: 6 }}>{accountability}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">{t("artifacts")}</h2>
            {role.artifacts.length === 0 ? (
              <p className="muted italic">{t("noArtifacts")}</p>
            ) : (
              <div className="nr-item">
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {role.artifacts.map((artifact, index) => (
                    <li key={`${role.id}-artifact-${index}`} style={{ marginBottom: 6 }}>{artifact}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        <aside>
          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">{t("assignedMembers")}</h2>
            {role.assignments.length === 0 ? (
              <p className="muted italic">{t("unassigned")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {role.assignments.map((assignment) => {
                  const user = assignment.member.user;
                  const displayName = user.displayName || user.email;
                  return (
                    <Link
                      key={assignment.id}
                      href={`/workspaces/${workspaceId}/members/${assignment.member.id}`}
                      className="nr-item"
                      style={{ textDecoration: "none", color: "inherit", display: "flex", gap: 12, alignItems: "center" }}
                    >
                      <span
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          background: "var(--accent-soft)",
                          backgroundImage: user.avatarUrl ? `url(${JSON.stringify(user.avatarUrl)})` : undefined,
                          backgroundPosition: "center",
                          backgroundSize: "cover",
                          color: "var(--accent)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 600,
                          flex: "0 0 auto",
                        }}
                        aria-hidden="true"
                      >
                        {!user.avatarUrl && getInitials(user.displayName, user.email)}
                      </span>
                      <span>
                        <strong style={{ display: "block" }}>{displayName}</strong>
                        <span className="muted" style={{ fontSize: "0.8rem" }}>{user.email}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">{t("circle")}</h2>
            <Link href={circleHref} className="nr-item" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
              <strong className="nr-item-title">{role.circle.name}</strong>
              {role.circle.purposeMd && <div className="nr-excerpt" style={{ marginTop: 6 }}>{role.circle.purposeMd}</div>}
              {role.circle.domainMd && <div className="nr-item-meta" style={{ marginTop: 6 }}>{role.circle.domainMd}</div>}
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
