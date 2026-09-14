import { canManageWorkspaceSupport, listWorkspaceSupportGrants, requireWorkspaceMembership, supportConnectorPreparationSchema } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { SupportAccessManager } from "./SupportAccessManager";

export const dynamic = "force-dynamic";
export default async function SupportAccessPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const actor = await requirePageActor();
  const { workspaceId } = await params;
  await requireWorkspaceMembership({ actor, workspaceId });
  if (!(await canManageWorkspaceSupport(actor, workspaceId))) {
    return <div className="space-y-4"><h1 className="text-2xl font-semibold">Support Access</h1>
      <p>Support access is available only to the verified workspace owner. Ownership is not inferred from an administrator role.</p>
      <a href={`/workspaces/${workspaceId}/settings`}>Back to settings</a></div>;
  }
  const grants = await listWorkspaceSupportGrants(actor, workspaceId);
  return <div className="space-y-6">
    <h1 className="text-2xl font-semibold">Support Access</h1>
    <SupportAccessManager workspaceId={workspaceId} initialGrants={grants.map((grant) => ({
      id: grant.id, email: grant.user.email, role: grant.role, isActive: grant.isActive, version: grant.version,
    }))} />
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Prepared Connections</h2>
      {grants.filter((grant) => grant.isActive).flatMap((grant) => {
        const parsed = supportConnectorPreparationSchema.safeParse(grant.setupConnectors ?? []);
        return (parsed.success ? parsed.data : []).map((preparation) => {
          const query = new URLSearchParams({ workspaceId, preparationId: grant.id, preparationRevision: String(grant.setupRevision) });
          return <div key={`${grant.id}:${preparation.provider}`} className="space-y-2 border-b border-[var(--line-subtle)] py-3 text-sm">
            <h3 className="font-semibold">{preparation.provider === "slack" ? "Slack" : preparation.provider === "google" ? "Google" : "Microsoft"}</h3>
            <p>{preparation.intent === "selected_channels" ? "Selected channels only; broad archive import off." : preparation.intent === "documents" ? "Selected Drive documents; owner selects documents after consent." : `Calendar import after consent: ${preparation.calendarImport ? "events with meeting links" : "off"}. Automatic recording unchanged.`}</p>
            <p className="text-[var(--text-muted)]">Prepared by {grant.user.email}. Revision {grant.setupRevision}.</p>
            <a className="inline-block underline" href={`/api/integrations/${preparation.provider}/${preparation.provider === "slack" ? "install" : "connect"}?${query}`}>Approve configuration and continue to provider consent</a>
          </div>;
        });
      })}
    </section>
  </div>;
}
