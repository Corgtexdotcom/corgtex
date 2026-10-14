import { generateGraphSourceVariant, GRAPH_SOURCE_VARIANT_INSTRUCTION,
  GRAPH_VARIANT_OBJECT_TYPES, GRAPH_VARIANT_RELATIONSHIP_TYPES, type GraphVariantCandidate } from "@corgtex/domain";
import { defaultModelGateway, resolveModel } from "@corgtex/models";

/** Closed adapter: this gateway adds no variable agent behavior or workspace context. */
export async function runGraphSourceVariantJob(params: {
  workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string;
}) {
  return generateGraphSourceVariant({ ...params, generate: async (sources, _anchors, scope) => {
    const response = await defaultModelGateway.extract({ model: resolveModel("fast"), workspaceId: params.workspaceId,
      workflowJobId: params.jobId, instruction: GRAPH_SOURCE_VARIANT_INSTRUCTION,
      schemaHint: JSON.stringify({ objects: [{ ref: "local ref", objectType: GRAPH_VARIANT_OBJECT_TYPES,
        title: "string", summary: "optional string", properties: "optional object", confidence: "optional 0..1" }],
      relationships: [{ ref: "local ref", sourceRef: "local object ref", targetRef: "local object ref",
        relationshipType: GRAPH_VARIANT_RELATIONSHIP_TYPES, properties: "optional object", confidence: "optional 0..1" }],
      evidenceRefs: [{ objectRef: "optional local object ref", relationshipRef: "optional local relationship ref",
        sourceKind: "supplied source kind", sourceId: "supplied source id", quote: "optional exact source quote",
        relevanceScore: "optional 0..1", metadata: "optional object" }], reason: "optional string" }),
      input: JSON.stringify({ scope: scope.kind === "default" ? { kind: scope.kind, mapKey: scope.mapKey } : { kind: scope.kind },
        sources: sources.map(source => ({ kind: source.kind, id: source.id, title: source.title,
          content: source.content.slice(0, 12000), ingestionGuidanceMd: source.ingestionGuidanceMd?.slice(0, 4000) ?? null,
          ...(source.kind === "BrainSource" ? { sourceType: source.sourceType, tier: source.tier } : {}) })) }),
    });
    // The domain accepts no additional operations/IDs and verifies all returned references.
    return response.output as GraphVariantCandidate;
  } });
}
