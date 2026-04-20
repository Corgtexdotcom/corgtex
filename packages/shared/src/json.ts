import type { Prisma } from "@prisma/client";

export function toInputJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value ?? null));
}
