import type { LineageRoot } from "@corgtex/domain";
import type { WikiLookupCursor } from "../../domain/src/brain-maintenance-links";

export const MAINTENANCE_PAGE_SIZE = 25;
export const MAINTENANCE_PHASES = ["LINKS", "ORPHANS", "SOURCES", "DISCUSSIONS", "RETENTION"] as const;
export type MaintenancePhase = typeof MAINTENANCE_PHASES[number];
/** Internal durable workflow state. Never embed this in an AgentRun, event,
 * model prompt or public result. IDs do not confer source permission. */
export type MaintenanceRelationScan = {
  edgeId: string;
  otherId: string;
  original: LineageRoot[];
  heads: Array<[string, string]>;
  refOffset: number;
  lookup?: WikiLookupCursor;
};
export type MaintenanceState = {
  version: 1;
  cohortId: string;
  admittedAt: string;
  phase: MaintenancePhase;
  upperId: string | null;
  afterId: string | null;
  selectedIds: string[];
  pageLastId: string | null;
  pageComplete: boolean;
  index: number;
  source?: {
    id: string;
    original: LineageRoot[];
    heads: Array<[string, string]>;
    refOffset: number;
    lookup?: WikiLookupCursor;
    stage: "REFERENCES" | "CLEANUP";
    edgeAfterId?: string;
    edge?: MaintenanceRelationScan;
  };
  orphan?: {id: string; original: LineageRoot[]; heads: Array<[string, string]>; edgeAfterId?: string; edge?: MaintenanceRelationScan};
  comment?: {threadId: string; original: LineageRoot[]; heads: Array<[string, string]>; afterCreatedAt: string; afterId: string};
};
export type MaintenanceBatchReport = {
  scope: "BATCH";
  phase: MaintenancePhase;
  observation: string;
  status: "OBSERVED" | "OPERATION_COMPLETED" | "RETAINED_UNSUPPORTED_CUSTODY";
  staleArticleCount?: number;
  unresolvedReferenceCount?: number;
  unresolvedReferences?: Array<{articleSlug: string; reference: string}>;
  backlinksWritten?: number;
  obsoleteBacklinksRemoved?: number;
  orphanCount?: number;
  orphans?: string[];
  tier3CleanupCandidates?: number;
  staleThreadCount?: number;
  absorbedThreadCount?: number;
};
