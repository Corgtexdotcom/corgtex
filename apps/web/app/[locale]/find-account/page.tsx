import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { listActorWorkspaces, resolveSessionActor } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { FindAccountForm } from "./FindAccountForm";

export const dynamic = "force-dynamic";

function localizedPath(path: string, locale: string) {
  return locale === "es" ? `/es${path}` : path;
}

async function optionalSessionActor() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) return null;

  try {
    return await resolveSessionActor(token);
  } catch {
    return null;
  }
}

export default async function FindAccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("auth");
  const actor = await optionalSessionActor();
  const workspaces = actor ? await listActorWorkspaces(actor).catch(() => []) : [];

  return (
    <main className="login-shell">
      <section className="panel login-card" style={{ width: "min(100%, 560px)" }}>
        <span className="tag">Corgtex</span>
        <h1>{t("findAccountTitle")}</h1>
        <p className="muted" style={{ marginBottom: "20px" }}>
          {t("findAccountSubtitle")}
        </p>

        {workspaces.length > 0 ? (
          <div className="stack" style={{ marginTop: 20, marginBottom: 20 }}>
            <p className="muted" style={{ fontSize: 14 }}>
              {t("findAccountSignedIn")}
            </p>
            {workspaces.map((workspace) => (
              <Link
                key={workspace.id}
                href={localizedPath(`/workspaces/${workspace.id}`, locale)}
                className="button-outline"
                style={{ display: "block", textAlign: "left", textDecoration: "none" }}
              >
                <strong>{workspace.name}</strong>
                <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                  {workspace.slug}
                </span>
              </Link>
            ))}
          </div>
        ) : null}

        <FindAccountForm />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20, fontSize: 14 }}>
          <Link href={localizedPath("/login", locale)} className="muted">
            {t("findAccountPasswordLogin")}
          </Link>
          <Link href={localizedPath("/signup", locale)} className="muted">
            {t("findAccountStartTrial")}
          </Link>
        </div>
      </section>
    </main>
  );
}
