import React from "react";
import { WorkspacePageHeader } from "@/lib/components/ControlPrimitives";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return <WorkspacePageHeader title={title} description={subtitle} />;
}
