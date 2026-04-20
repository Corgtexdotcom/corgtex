"use server";

import { redirect } from "next/navigation";
import { createWorkspace } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

function asString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function asOptional(formData: FormData, key: string) {
  const value = asString(formData, key).trim();
  return value.length > 0 ? value : null;
}

export async function createWorkspaceAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspace = await createWorkspace(actor, {
    name: asString(formData, "name"),
    slug: asString(formData, "slug"),
    description: asOptional(formData, "description"),
  });
  redirect(`/workspaces/${workspace.id}`);
}
