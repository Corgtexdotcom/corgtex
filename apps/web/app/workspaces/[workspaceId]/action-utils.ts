import { revalidatePath } from "next/cache";

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

export function refresh(workspaceId: string) {
  revalidatePath("/");
  revalidatePath(`/workspaces/${workspaceId}`, "layout");
}
