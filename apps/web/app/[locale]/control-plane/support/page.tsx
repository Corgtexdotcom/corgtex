import { requireGlobalOperator } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import SupportWorkspacesPage from "../../support/page";

export const dynamic = "force-dynamic";

export default async function ControlPlaneSupportPage() {
  requireGlobalOperator(await requirePageActor());
  return <SupportWorkspacesPage />;
}
