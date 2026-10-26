import { createHash } from "node:crypto";

/** Keep the source prefix used by archive cleanup; encode the complete tuple
 * before hashing so SQL names and key values cannot collide on delimiters. */
export function sqlKnowledgeSourceId(sourceId: string, table: string, primaryKey: string): string {
  const tuple = JSON.stringify([sourceId, table, primaryKey]);
  return `byodb:${sourceId}:v2:${createHash("sha256").update(tuple).digest("hex")}`;
}
