"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Check, CircleHelp, FileSearch, GitBranch, RefreshCcw } from "lucide-react";

import {
  applyContextGraphProposedDiffAction,
  buildSelectedRegionContextAction,
  createRegionProposalAction,
  saveContextMapLayoutAction,
} from "./actions";

type EvidenceRef = {
  id: string;
  objectId: string | null;
  relationshipId: string | null;
  sourceType: string;
  sourceId: string;
  quote: string | null;
  relevanceScore: number | null;
};

type ContextGraphObject = {
  id: string;
  objectType: string;
  title: string;
  summary: string | null;
  confidence: number | null;
  status: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  validFrom: string | null;
  validTo: string | null;
  lastVerifiedAt: string | null;
  evidenceRefs: EvidenceRef[];
};

type ContextGraphRelationship = {
  id: string;
  sourceObjectId: string;
  targetObjectId: string;
  relationshipType: string;
  confidence: number | null;
  status: string;
  evidenceRefs: EvidenceRef[];
};

type ContextMapLayoutItem = {
  objectId: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
};

type ContextGraphProposedDiff = {
  id: string;
  reason: string | null;
  status: string;
  createdAt: string;
  diffJson: unknown;
};

export type ContextMapClientData = {
  mapView: {
    id: string;
    name: string;
    viewType: string;
  };
  objects: ContextGraphObject[];
  relationships: ContextGraphRelationship[];
  layoutItems: ContextMapLayoutItem[];
  proposedDiffs: ContextGraphProposedDiff[];
};

type RegionContext = Awaited<ReturnType<typeof buildSelectedRegionContextAction>>;

const NODE_COLORS: Record<string, { border: string; background: string }> = {
  Process: { border: "#2563eb", background: "#eff6ff" },
  ProcessStep: { border: "#0f766e", background: "#ecfdf5" },
  Decision: { border: "#7c3aed", background: "#f5f3ff" },
  Task: { border: "#ca8a04", background: "#fefce8" },
  Risk: { border: "#dc2626", background: "#fef2f2" },
  Team: { border: "#0891b2", background: "#ecfeff" },
  Role: { border: "#4f46e5", background: "#eef2ff" },
  Meeting: { border: "#475569", background: "#f8fafc" },
  Question: { border: "#9333ea", background: "#faf5ff" },
};

function positionForIndex(index: number) {
  const columns = 4;
  return {
    x: (index % columns) * 280,
    y: Math.floor(index / columns) * 170,
  };
}

function nodeStyle(object: ContextGraphObject) {
  const colors = NODE_COLORS[object.objectType] ?? { border: "#64748b", background: "#f8fafc" };
  return {
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    background: colors.background,
    color: "#111827",
    width: 230,
    padding: 12,
    boxShadow: object.status === "disputed" || object.status === "stale" ? "0 0 0 3px rgba(220,38,38,0.15)" : "0 10px 24px rgba(15,23,42,0.08)",
  };
}

function confidenceLabel(value: number | null) {
  if (value == null) return "confidence unknown";
  return `${Math.round(value * 100)}% confidence`;
}

function stableDateLabel(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

function objectMeta(object: ContextGraphObject) {
  return [object.objectType, object.status, confidenceLabel(object.confidence)].join(" · ");
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export default function ContextMapClient({ workspaceId, data }: { workspaceId: string; data: ContextMapClientData }) {
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(data.objects[0]?.id ?? null);
  const [regionContext, setRegionContext] = useState<RegionContext | null>(null);
  const [regionContextStatus, setRegionContextStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isPending, startTransition] = useTransition();

  const layoutByObjectId = useMemo(() => new Map(data.layoutItems.map((item) => [item.objectId, item])), [data.layoutItems]);
  const objectById = useMemo(() => new Map(data.objects.map((object) => [object.id, object])), [data.objects]);

  const initialNodes = useMemo<Node[]>(() => data.objects.map((object, index) => {
    const layout = layoutByObjectId.get(object.id);
    const position = layout ? { x: layout.x, y: layout.y } : positionForIndex(index);
    return {
      id: object.id,
      type: "default",
      position,
      data: {
        label: (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#475569" }}>{object.objectType}</div>
            <strong style={{ fontSize: 14, lineHeight: 1.25 }}>{object.title}</strong>
            <span style={{ fontSize: 11, color: "#64748b" }}>{object.status}</span>
          </div>
        ),
      },
      style: nodeStyle(object),
    };
  }), [data.objects, layoutByObjectId]);

  const initialEdges = useMemo<Edge[]>(() => data.relationships
    .filter((relationship) => objectById.has(relationship.sourceObjectId) && objectById.has(relationship.targetObjectId))
    .map((relationship) => ({
      id: relationship.id,
      source: relationship.sourceObjectId,
      target: relationship.targetObjectId,
      label: relationship.relationshipType,
      animated: relationship.status === "proposed",
      style: {
        stroke: relationship.status === "stale" || relationship.status === "disputed" ? "#dc2626" : "#64748b",
        strokeWidth: 1.7,
      },
    })), [data.relationships, objectById]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    const updateLayout = () => setIsCompactLayout(window.innerWidth < 920);
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setEdges, setNodes]);

  const selectedObject = selectedObjectId ? objectById.get(selectedObjectId) ?? null : null;
  const selectedRegionIds = useMemo(() => (
    selectedObjectIds.length > 0 ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : []
  ), [selectedObjectId, selectedObjectIds]);
  const selectedRegionKey = selectedRegionIds.join("|");
  const selectedRelationships = selectedObject
    ? data.relationships.filter((relationship) => relationship.sourceObjectId === selectedObject.id || relationship.targetObjectId === selectedObject.id)
    : [];

  useEffect(() => {
    if (selectedRegionIds.length === 0) {
      setRegionContext(null);
      setRegionContextStatus("idle");
      return;
    }

    let cancelled = false;
    setRegionContextStatus("loading");
    buildSelectedRegionContextAction({
      workspaceId,
      mapViewId: data.mapView.id,
      objectIds: selectedRegionIds,
    }).then((context) => {
      if (cancelled) return;
      setRegionContext(context);
      setRegionContextStatus("ready");
    }).catch(() => {
      if (cancelled) return;
      setRegionContext(null);
      setRegionContextStatus("error");
    });

    return () => {
      cancelled = true;
    };
  }, [data.mapView.id, selectedRegionKey, selectedRegionIds, workspaceId]);

  function loadRegionContext(ids: string[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      setMessage(null);
      setRegionContextStatus("loading");
      try {
        const context = await buildSelectedRegionContextAction({
          workspaceId,
          mapViewId: data.mapView.id,
          objectIds: ids,
        });
        setRegionContext(context);
        setRegionContextStatus("ready");
      } catch {
        setRegionContext(null);
        setRegionContextStatus("error");
      }
    });
  }

  function createProposal() {
    const ids = selectedObjectIds.length > 0 ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : [];
    if (ids.length === 0) {
      setMessage("Select at least one node before creating a proposed graph diff.");
      return;
    }
    startTransition(async () => {
      await createRegionProposalAction({
        workspaceId,
        mapViewId: data.mapView.id,
        objectIds: ids,
      });
      setMessage("Created a proposed graph diff for this selected region.");
    });
  }

  function applyDiff(proposedDiffId: string) {
    startTransition(async () => {
      await applyContextGraphProposedDiffAction({ workspaceId, proposedDiffId });
      setMessage("Applied proposed graph diff.");
    });
  }

  return (
    <section className="ws-section" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: isCompactLayout ? "1fr" : "minmax(0, 1fr) 340px", minHeight: 720 }}>
        <div style={{ minWidth: 0, borderRight: isCompactLayout ? "none" : "1px solid var(--border)", borderBottom: isCompactLayout ? "1px solid var(--border)" : "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            <div>
              <strong>{data.mapView.name}</strong>
              <div className="nr-item-meta">{data.objects.length} objects · {data.relationships.length} relationships · {data.mapView.viewType} view</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="secondary small"
                type="button"
                onClick={() => loadRegionContext(selectedRegionIds)}
                disabled={isPending || regionContextStatus === "loading"}
              >
                <FileSearch size={14} aria-hidden="true" /> {regionContextStatus === "loading" ? "Loading" : "Context"}
              </button>
              <button className="secondary small" type="button" onClick={createProposal} disabled={isPending}>
                <GitBranch size={14} aria-hidden="true" /> Propose
              </button>
            </div>
          </div>
          <div style={{ height: isCompactLayout ? 560 : 660 }}>
            {nodes.length === 0 ? (
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#64748b", textAlign: "center", padding: 32 }}>
                <div>
                  <CircleHelp size={32} aria-hidden="true" style={{ marginBottom: 12 }} />
                  <h3 style={{ margin: "0 0 8px" }}>No context graph objects yet</h3>
                  <p style={{ margin: 0, maxWidth: 460 }}>Run meeting intelligence, sync source records, or seed the demo workspace to populate this map.</p>
                </div>
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_, node) => {
                  setSelectedObjectId(node.id);
                  setSelectedObjectIds((current) => sameIds(current, [node.id]) ? current : [node.id]);
                }}
                onSelectionChange={({ nodes: selectedNodes }) => {
                  const ids = selectedNodes.map((node) => node.id);
                  setSelectedObjectIds((current) => sameIds(current, ids) ? current : ids);
                  if (ids.length > 0) {
                    setSelectedObjectId((current) => current === ids[0] ? current : ids[0]);
                  }
                }}
                onNodeDragStop={(_, node) => {
                  void saveContextMapLayoutAction({
                    workspaceId,
                    mapViewId: data.mapView.id,
                    items: [{ objectId: node.id, x: node.position.x, y: node.position.y }],
                  });
                }}
                fitView
                minZoom={0.2}
                maxZoom={1.7}
              >
                <Background />
                <Controls />
              </ReactFlow>
            )}
          </div>
        </div>
        <aside style={{ padding: 18, display: "grid", gap: 18, alignContent: "start", background: "#f8fafc" }}>
          {message && <div className="tag info" style={{ justifyContent: "flex-start" }}>{message}</div>}
          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Selection</h2>
            {selectedObject ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div>
                  <div className="nr-item-meta">{objectMeta(selectedObject)}</div>
                  <strong>{selectedObject.title}</strong>
                </div>
                {selectedObject.summary && <p style={{ margin: 0, color: "#334155", lineHeight: 1.45 }}>{selectedObject.summary.slice(0, 420)}</p>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {selectedObject.sourceEntityType && <span className="tag neutral">{selectedObject.sourceEntityType}</span>}
                  {selectedObject.lastVerifiedAt && <span className="tag neutral">verified {stableDateLabel(selectedObject.lastVerifiedAt)}</span>}
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Select a node to inspect its evidence and neighbors.</p>
            )}
          </div>

          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Evidence</h2>
            {selectedObject?.evidenceRefs.length ? (
              <div style={{ display: "grid", gap: 10 }}>
                {selectedObject.evidenceRefs.map((evidence) => (
                  <div key={evidence.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div className="nr-item-meta">{evidence.sourceType} · {confidenceLabel(evidence.relevanceScore)}</div>
                    <p style={{ margin: "4px 0 0", color: "#334155" }}>{evidence.quote ?? evidence.sourceId}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No evidence refs attached yet.</p>
            )}
          </div>

          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Neighbors</h2>
            {selectedRelationships.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {selectedRelationships.slice(0, 8).map((relationship) => {
                  const otherId = relationship.sourceObjectId === selectedObject?.id ? relationship.targetObjectId : relationship.sourceObjectId;
                  return (
                    <button
                      key={relationship.id}
                      type="button"
                      className="secondary small"
                      style={{ justifyContent: "flex-start", textAlign: "left" }}
                      onClick={() => {
                        setSelectedObjectId(otherId);
                        setSelectedObjectIds([otherId]);
                      }}
                    >
                      {relationship.relationshipType}: {objectById.get(otherId)?.title ?? otherId}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No graph relationships connected to this object.</p>
            )}
          </div>

          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Region Context</h2>
            {regionContextStatus === "loading" ? (
              <p className="muted" style={{ margin: 0 }} aria-live="polite">Loading selected-region context...</p>
            ) : regionContextStatus === "error" ? (
              <p className="form-message form-message-error" role="alert" style={{ margin: 0 }}>Could not build context for this selection. Try refreshing the context.</p>
            ) : regionContext ? (
              <div style={{ display: "grid", gap: 8 }}>
                <span className="tag neutral">{regionContext.objects.length} objects</span>
                <span className="tag neutral">{regionContext.relationships.length} relationships</span>
                <span className="tag neutral">{regionContext.evidenceRefs.length} evidence refs</span>
                <span className="tag neutral">{regionContext.permissions.canPropose ? "can propose" : "read only"}</span>
                {regionContext.staleOrDisputed.length > 0 && <span className="tag danger">{regionContext.staleOrDisputed.length} stale/disputed facts</span>}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Build context from the selected node or multi-node region.</p>
            )}
          </div>

          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Proposed Diffs</h2>
            {data.proposedDiffs.length ? (
              <div style={{ display: "grid", gap: 10 }}>
                {data.proposedDiffs.map((diff) => (
                  <div key={diff.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div className="nr-item-meta">{diff.status} · {stableDateLabel(diff.createdAt)}</div>
                    <p style={{ margin: "4px 0 8px", color: "#334155" }}>{diff.reason ?? "Proposed graph change"}</p>
                    <button className="secondary small" type="button" onClick={() => applyDiff(diff.id)} disabled={isPending}>
                      <Check size={14} aria-hidden="true" /> Approve and apply
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No pending graph diffs.</p>
            )}
          </div>

          <button
            className="secondary small"
            type="button"
            onClick={() => {
              setRegionContext(null);
              setMessage(null);
            }}
          >
            <RefreshCcw size={14} aria-hidden="true" /> Clear panel state
          </button>
        </aside>
      </div>
    </section>
  );
}
