import { revalidatePath } from "next/cache";
import type { DuplicateGuardOptions, DuplicateGuardResolution } from "@corgtex/domain";

export function asString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

export function asOptional(formData: FormData, key: string) {
  const value = asString(formData, key).trim();
  return value.length > 0 ? value : null;
}

export function asOptionalInt(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  if (value === null) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

const DUPLICATE_GUARD_RESOLUTIONS: DuplicateGuardResolution[] = [
  "use_existing",
  "update_existing",
  "create_new",
];

export function duplicateGuardFromFormData(formData: FormData): DuplicateGuardOptions | undefined {
  const resolution = asOptional(formData, "duplicateResolution");
  const duplicateGuardEnabled = asString(formData, "duplicateGuardEnabled") === "true";
  if (!DUPLICATE_GUARD_RESOLUTIONS.includes(resolution as DuplicateGuardResolution)) {
    if (!duplicateGuardEnabled) return undefined;
    return {};
  }
  return {
    resolution: resolution as DuplicateGuardResolution,
    targetEntityId: asOptional(formData, "duplicateTargetEntityId"),
  };
}

export function refresh(workspaceId: string) {
  revalidatePath("/");
  revalidatePath(`/workspaces/${workspaceId}`, "layout");
}
