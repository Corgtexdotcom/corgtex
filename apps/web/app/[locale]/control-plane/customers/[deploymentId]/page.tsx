import { redirect } from "next/navigation";
import { localizedControlPlanePath, normalizeControlPlaneLocale } from "@/lib/control-plane-path";

export const dynamic = "force-dynamic";

export default async function LegacyControlPlaneCustomerPage({
  params,
}: {
  params: Promise<{ locale: string; deploymentId: string }>;
}) {
  const { locale, deploymentId } = await params;
  redirect(localizedControlPlanePath(`/control-plane/deployments/${deploymentId}`, normalizeControlPlaneLocale(locale)));
}
