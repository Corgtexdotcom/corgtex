"use client";

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Ban,
  Check,
  CircleHelp,
  Copy,
  Crosshair,
  FileSearch,
  GitBranch,
  ListChecks,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  X,
} from "lucide-react";

import {
  applyContextGraphProposedDiffAction,
  buildSelectedRegionContextAction,
  createMissingRegionFactsProposalAction,
  createPersonalContextMapViewAction,
  createRegionProposalAction,
  reviewContextGraphProposedDiffAction,
  saveContextMapLayoutAction,
  updateContextGraphProposedDiffAction,
} from "./actions";
import "./context-map.css";

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
  properties: Record<string, unknown>;
  confidence: number | null;
  status: string;
  createdByType: string;
  createdByUserId: string | null;
  createdByAgentRunId: string | null;
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
  properties: Record<string, unknown>;
  confidence: number | null;
  status: string;
  createdByType: string;
  createdByUserId: string | null;
  createdByAgentRunId: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  validFrom: string | null;
  validTo: string | null;
  lastVerifiedAt: string | null;
  evidenceRefs: EvidenceRef[];
};

type ContextMapLayoutItem = {
  objectId: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
};

type ContextMapView = {
  id: string;
  name: string;
  viewType: string;
  createdByUserId: string | null;
  query: Record<string, unknown>;
};

type ContextGraphProposedDiff = {
  id: string;
  reason: string | null;
  status: string;
  createdAt: string;
  diffJson: unknown;
};

type DiffObjectInput = {
  ref?: string;
  objectType?: string;
  title?: string;
  summary?: string | null;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
};

type DiffRelationshipInput = {
  sourceObjectId?: string;
  sourceRef?: string;
  targetObjectId?: string;
  targetRef?: string;
  relationshipType?: string;
  status?: string;
};

type DiffEvidenceInput = {
  objectId?: string;
  objectRef?: string;
  relationshipId?: string;
  relationshipRef?: string;
  sourceType?: string;
  sourceId?: string;
};

type DiffLayoutInput = {
  mapViewId?: string;
  items?: Array<{ objectId?: string; x?: number; y?: number }>;
};

type DiffJsonInput = {
  objects?: DiffObjectInput[];
  relationships?: DiffRelationshipInput[];
  evidenceRefs?: DiffEvidenceInput[];
  mapLayoutUpdates?: DiffLayoutInput[];
};

export type ContextMapClientData = {
  mapView: ContextMapView;
  mapViews: ContextMapView[];
  objects: ContextGraphObject[];
  relationships: ContextGraphRelationship[];
  layoutItems: ContextMapLayoutItem[];
  proposedDiffs: ContextGraphProposedDiff[];
  permissions: {
    canSavePersonalView: boolean;
    canUpdateMasterView: boolean;
    canRequestMasterUpdate: boolean;
  };
};

type RegionContext = Awaited<ReturnType<typeof buildSelectedRegionContextAction>>;
type InspectorDock = "right" | "bottom";
type StatusFilter = "active" | "approved" | "needs-review" | "all";

const NODE_COLORS: Record<string, { border: string; background: string; accent: string }> = {
  Process: { border: "#2563eb", background: "#eff6ff", accent: "#1d4ed8" },
  ProcessStep: { border: "#0f766e", background: "#ecfdf5", accent: "#0f766e" },
  Decision: { border: "#7c3aed", background: "#f5f3ff", accent: "#6d28d9" },
  Task: { border: "#ca8a04", background: "#fefce8", accent: "#a16207" },
  Risk: { border: "#dc2626", background: "#fef2f2", accent: "#b91c1c" },
  Team: { border: "#0891b2", background: "#ecfeff", accent: "#0e7490" },
  Role: { border: "#4f46e5", background: "#eef2ff", accent: "#4338ca" },
  Meeting: { border: "#475569", background: "#f8fafc", accent: "#334155" },
  Question: { border: "#9333ea", background: "#faf5ff", accent: "#7e22ce" },
  Tool: { border: "#059669", background: "#ecfdf5", accent: "#047857" },
  Agent: { border: "#0d9488", background: "#f0fdfa", accent: "#0f766e" },
  Policy: { border: "#334155", background: "#f8fafc", accent: "#1e293b" },
  Document: { border: "#2563eb", background: "#eff6ff", accent: "#1d4ed8" },
  Evidence: { border: "#64748b", background: "#f8fafc", accent: "#475569" },
  Metric: { border: "#b45309", background: "#fffbeb", accent: "#92400e" },
};

function positionForIndex(index: number) {
  const columns = 4;
  return {
    x: (index % columns) * 300,
    y: Math.floor(index / columns) * 180,
  };
}

function confidenceLabel(value: number | null) {
  if (value == null) return "confidence unknown";
  return `${Math.round(value * 100)}% confidence`;
}

function stableDateLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function objectMeta(object: ContextGraphObject) {
  return [object.objectType, object.status, confidenceLabel(object.confidence)].join(" - ");
}

function propertyText(properties: Record<string, unknown> | null | undefined, key: string) {
  const value = properties?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function propertyStringArray(properties: Record<string, unknown> | null | undefined, key: string) {
  const value = properties?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function titleizeMachineValue(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function statusClass(status: string) {
  if (status === "stale" || status === "disputed") return "problem";
  if (status === "proposed" || status === "draft") return "pending";
  if (status === "approved") return "approved";
  return "neutral";
}

function relationshipColor(relationship: ContextGraphRelationship) {
  if (relationship.status === "stale" || relationship.status === "disputed") return "#dc2626";
  if (relationship.status === "proposed" || relationship.status === "draft") return "#ca8a04";
  return "#64748b";
}

function shouldShowStatus(status: string, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "approved") return status === "approved";
  if (filter === "needs-review") return ["draft", "proposed", "stale", "disputed"].includes(status);
  return status !== "archived";
}

function sourceLabel(value: { sourceEntityType: string | null; sourceEntityId: string | null; createdByType: string }) {
  if (value.sourceEntityType) return `${value.sourceEntityType}${value.sourceEntityId ? ` - ${value.sourceEntityId}` : ""}`;
  return `created by ${value.createdByType}`;
}

function viewScopeLabel(view: ContextMapView) {
  return view.createdByUserId ? "Personal" : "Master";
}

function mapViewUrl(viewId: string, includeStale: boolean) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", viewId);
  if (includeStale) url.searchParams.set("stale", "1");
  else url.searchParams.delete("stale");
  return `${url.pathname}${url.search}`;
}

function directNeighborHeading(viewType: string) {
  if (viewType === "org") return "Direct roles, people, and reporting links";
  if (viewType === "agent") return "Direct inputs, policies, tools, and outputs";
  return "Direct blockers, owners, dependencies";
}

function diffJsonRecord(value: unknown): DiffJsonInput {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DiffJsonInput : {};
}

function normalizeProposedDiff(value: {
  id: string;
  reason: string | null;
  status: string;
  createdAt: string | Date;
  diffJson: unknown;
}): ContextGraphProposedDiff {
  return {
    id: value.id,
    reason: value.reason,
    status: value.status,
    createdAt: value.createdAt instanceof Date ? value.createdAt.toISOString() : value.createdAt,
    diffJson: value.diffJson,
  };
}

function diffCountLabel(diffJson: unknown) {
  const diff = diffJsonRecord(diffJson);
  const parts = [
    `${diff.objects?.length ?? 0} objects`,
    `${diff.relationships?.length ?? 0} relationships`,
    `${diff.evidenceRefs?.length ?? 0} evidence refs`,
    `${diff.mapLayoutUpdates?.reduce((sum, update) => sum + (update.items?.length ?? 0), 0) ?? 0} layout moves`,
  ];
  return parts.join(" - ");
}

function objectTitleFromId(objects: Map<string, ContextGraphObject>, objectId: string | undefined) {
  return objectId ? objects.get(objectId)?.title ?? objectId : "new object";
}

function relationshipEndpointLabel(value: DiffRelationshipInput, key: "source" | "target", objects: Map<string, ContextGraphObject>) {
  const objectId = key === "source" ? value.sourceObjectId : value.targetObjectId;
  const ref = key === "source" ? value.sourceRef : value.targetRef;
  return objectId ? objectTitleFromId(objects, objectId) : ref ? `new: ${ref}` : "unknown";
}

function diffPreviewLines(diffJson: unknown, objects: Map<string, ContextGraphObject>, mapViews: ContextMapView[]) {
  const diff = diffJsonRecord(diffJson);
  const before: string[] = [];
  const after: string[] = [];
  for (const object of diff.objects ?? []) {
    before.push(`${object.objectType ?? "Object"}: no approved change until applied`);
    after.push(`${object.objectType ?? "Object"}: ${object.title ?? object.ref ?? "Untitled"} (${object.status ?? "approved on apply"})`);
  }
  for (const relationship of diff.relationships ?? []) {
    const source = relationshipEndpointLabel(relationship, "source", objects);
    const target = relationshipEndpointLabel(relationship, "target", objects);
    before.push(`${relationship.relationshipType ?? "relationship"}: not present as approved truth`);
    after.push(`${source} ${relationship.relationshipType ?? "relates to"} ${target}`);
  }
  for (const evidence of diff.evidenceRefs ?? []) {
    before.push(`Evidence: ${evidence.sourceType ?? "source"} not attached`);
    after.push(`Attach ${evidence.sourceType ?? "source"}:${evidence.sourceId ?? "record"} to ${evidence.objectId ?? evidence.objectRef ?? evidence.relationshipId ?? evidence.relationshipRef ?? "fact"}`);
  }
  for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
    const viewName = mapViews.find((view) => view.id === layoutUpdate.mapViewId)?.name ?? layoutUpdate.mapViewId ?? "map view";
    const count = layoutUpdate.items?.length ?? 0;
    before.push(`${viewName}: current saved layout`);
    after.push(`${viewName}: ${count} node positions updated`);
  }
  if (before.length === 0 && after.length === 0) {
    before.push("No graph truth changes encoded.");
    after.push("No graph truth changes encoded.");
  }
  return { before: before.slice(0, 6), after: after.slice(0, 6) };
}

export default function ContextMapClient({ workspaceId, data, includeStale = false }: { workspaceId: string; data: ContextMapClientData; includeStale?: boolean }) {
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>(data.objects[0]?.id ? [data.objects[0].id] : []);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(data.objects[0]?.id ?? null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
  const [regionContext, setRegionContext] = useState<RegionContext | null>(null);
  const [regionContextStatus, setRegionContextStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [inspectorDock, setInspectorDock] = useState<InspectorDock>("right");
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [expandedDiffId, setExpandedDiffId] = useState<string | null>(data.proposedDiffs[0]?.id ?? null);
  const [editingDiffId, setEditingDiffId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editDiffJson, setEditDiffJson] = useState("");
  const [proposedDiffs, setProposedDiffs] = useState<ContextGraphProposedDiff[]>(data.proposedDiffs);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [isPending, startTransition] = useTransition();

  const isMasterView = data.mapView.createdByUserId === null;
  const currentViewIsEditable = !isMasterView || data.permissions.canUpdateMasterView;
  const layoutSaveLabel = isMasterView
    ? data.permissions.canUpdateMasterView ? "Update master" : "Request master update"
    : "Save view";

  const layoutByObjectId = useMemo(() => new Map(data.layoutItems.map((item) => [item.objectId, item])), [data.layoutItems]);
  const objectById = useMemo(() => new Map(data.objects.map((object) => [object.id, object])), [data.objects]);
  const relationshipById = useMemo(() => new Map(data.relationships.map((relationship) => [relationship.id, relationship])), [data.relationships]);
  const objectTypes = useMemo(() => [...new Set(data.objects.map((object) => object.objectType))].sort(), [data.objects]);

  const filteredObjects = useMemo(() => data.objects.filter((object) => {
    if (typeFilter !== "all" && object.objectType !== typeFilter) return false;
    return shouldShowStatus(object.status, statusFilter);
  }), [data.objects, statusFilter, typeFilter]);
  const visibleObjectIds = useMemo(() => new Set(filteredObjects.map((object) => object.id)), [filteredObjects]);

  const initialNodes = useMemo<Node[]>(() => filteredObjects.map((object, index) => {
    const layout = layoutByObjectId.get(object.id);
    const position = layout ? { x: layout.x, y: layout.y } : positionForIndex(index);
    const colors = NODE_COLORS[object.objectType] ?? { border: "#64748b", background: "#f8fafc", accent: "#475569" };
    const workState = propertyText(object.properties, "workState");
    const pathStage = propertyText(object.properties, "pathStage");
    const staffingState = propertyText(object.properties, "staffingState");
    return {
      id: object.id,
      type: "default",
      position,
      data: {
        label: (
          <div
            className={`context-map-node-card context-map-node-card--${statusClass(object.status)}`}
            style={{ "--node-border": colors.border, "--node-bg": colors.background, "--node-accent": colors.accent } as CSSProperties}
          >
            <div className="context-map-node-topline">
              <span>{object.objectType}</span>
              <span className={`context-map-status context-map-status--${statusClass(object.status)}`}>{object.status}</span>
            </div>
            <strong>{object.title}</strong>
            <div className="context-map-node-meta">
              <span>{confidenceLabel(object.confidence)}</span>
              {workState && <span>{titleizeMachineValue(workState)}</span>}
              {pathStage && <span>{pathStage}</span>}
              {staffingState && <span>{titleizeMachineValue(staffingState)}</span>}
              {object.evidenceRefs.length > 0 && <span>{object.evidenceRefs.length} evidence</span>}
            </div>
          </div>
        ),
      },
      style: {
        width: 250,
        border: 0,
        padding: 0,
        background: "transparent",
        boxShadow: "none",
      },
    };
  }), [filteredObjects, layoutByObjectId]);

  const initialEdges = useMemo<Edge[]>(() => data.relationships
    .filter((relationship) => (
      visibleObjectIds.has(relationship.sourceObjectId)
      && visibleObjectIds.has(relationship.targetObjectId)
      && shouldShowStatus(relationship.status, statusFilter)
    ))
    .map((relationship) => {
      const stroke = relationshipColor(relationship);
      return {
        id: relationship.id,
        source: relationship.sourceObjectId,
        target: relationship.targetObjectId,
        type: "smoothstep",
        label: relationship.relationshipType,
        animated: relationship.status === "proposed",
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: relationship.status === "stale" || relationship.status === "disputed" ? 2.4 : 1.8,
        },
        labelStyle: { fill: "#334155", fontWeight: 700, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.88 },
        labelBgPadding: [6, 3],
      };
    }), [data.relationships, statusFilter, visibleObjectIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    const updateLayout = () => {
      const compact = window.innerWidth < 920;
      setIsCompactLayout(compact);
      if (compact) setInspectorDock("bottom");
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setLayoutDirty(false);
  }, [initialNodes, initialEdges, setEdges, setNodes]);

  useEffect(() => {
    setProposedDiffs(data.proposedDiffs);
    setExpandedDiffId((current) => current ?? data.proposedDiffs[0]?.id ?? null);
  }, [data.proposedDiffs]);

  const selectedObject = selectedObjectId ? objectById.get(selectedObjectId) ?? null : null;
  const selectedRelationship = selectedRelationshipId ? relationshipById.get(selectedRelationshipId) ?? null : null;
  const selectedRegionIds = useMemo(() => {
    if (selectedObjectIds.length > 0) return selectedObjectIds;
    if (selectedRelationship) return [selectedRelationship.sourceObjectId, selectedRelationship.targetObjectId];
    if (selectedObjectId) return [selectedObjectId];
    return [];
  }, [selectedObjectId, selectedObjectIds, selectedRelationship]);
  const selectedRegionKey = selectedRegionIds.join("|");
  const selectedRelationships = selectedObject
    ? data.relationships.filter((relationship) => relationship.sourceObjectId === selectedObject.id || relationship.targetObjectId === selectedObject.id)
    : [];
  const selectedAccountabilities = selectedObject ? propertyStringArray(selectedObject.properties, "accountabilities") : [];
  const selectedControls = selectedObject ? propertyStringArray(selectedObject.properties, "governanceControls") : [];
  const selectedAllowedActions = selectedObject ? propertyStringArray(selectedObject.properties, "allowedActions") : [];
  const selectedOrgKind = selectedObject ? propertyText(selectedObject.properties, "orgKind") : null;

  useEffect(() => {
    setNodes((currentNodes) => {
      let changed = false;
      const nextNodes = currentNodes.map((node) => {
        const selected = selectedRegionIds.includes(node.id);
        const baseClassName = (node.className ?? "").replace(/\bcontext-map-flow-node--selected\b/g, "").trim();
        const className = selected ? `${baseClassName} context-map-flow-node--selected`.trim() : baseClassName;
        if ((node.className ?? "") === className) return node;
        changed = true;
        return { ...node, className };
      });
      return changed ? nextNodes : currentNodes;
    });
    setEdges((currentEdges) => {
      let changed = false;
      const nextEdges = currentEdges.map((edge) => {
        const selected = edge.id === selectedRelationshipId;
        const baseClassName = (edge.className ?? "").replace(/\bcontext-map-flow-edge--selected\b/g, "").trim();
        const className = selected ? `${baseClassName} context-map-flow-edge--selected`.trim() : baseClassName;
        if ((edge.className ?? "") === className) return edge;
        changed = true;
        return { ...edge, className };
      });
      return changed ? nextEdges : currentEdges;
    });
  }, [selectedRegionIds, selectedRelationshipId, setEdges, setNodes]);

  useEffect(() => {
    if (selectedRegionIds.length === 0) {
      setRegionContext(null);
      setRegionContextStatus("idle");
      return;
    }

    let cancelled = false;
    setRegionContextStatus("loading");
    const timeoutId = window.setTimeout(() => {
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
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [data.mapView.id, selectedRegionKey, selectedRegionIds, workspaceId]);

  function currentLayoutItems() {
    return nodes.map((node) => ({
      objectId: node.id,
      x: node.position.x,
      y: node.position.y,
      width: 250,
      height: 112,
    }));
  }

  function fitMap() {
    flowInstance?.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 220 });
  }

  function resetLocalLayout() {
    setNodes(initialNodes);
    setLayoutDirty(false);
    window.requestAnimationFrame(fitMap);
  }

  function navigateToView(viewId: string) {
    window.location.href = mapViewUrl(viewId, includeStale);
  }

  function toggleIncludeStale(next: boolean) {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("stale", "1");
    else url.searchParams.delete("stale");
    window.location.href = `${url.pathname}${url.search}`;
  }

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

  function saveLayout() {
    const items = currentLayoutItems();
    if (items.length === 0) return;
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await saveContextMapLayoutAction({
          workspaceId,
          mapViewId: data.mapView.id,
          items,
        });
        setLayoutDirty(false);
        setMessage({
          tone: "info",
          text: result.mode === "proposed" ? "Created a master map update request for admin review." : "Saved the current map layout.",
        });
      } catch {
        setMessage({ tone: "error", text: "Could not save this map layout." });
      }
    });
  }

  function savePersonalView() {
    const defaultName = data.mapView.createdByUserId ? data.mapView.name : `${data.mapView.name} - personal`;
    const name = window.prompt("Name this personal map view", defaultName);
    if (name === null) return;
    startTransition(async () => {
      setMessage(null);
      try {
        const mapView = await createPersonalContextMapViewAction({
          workspaceId,
          sourceMapViewId: data.mapView.id,
          name,
          items: currentLayoutItems(),
        });
        window.location.href = mapViewUrl(mapView.id, includeStale);
      } catch {
        setMessage({ tone: "error", text: "Could not save a personal map view." });
      }
    });
  }

  function createProposal() {
    const ids = selectedRegionIds;
    if (ids.length === 0) {
      setMessage({ tone: "error", text: "Select at least one node before creating a proposed graph diff." });
      return;
    }
    startTransition(async () => {
      try {
        const diff = await createRegionProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          objectIds: ids,
        });
        setProposedDiffs((current) => [normalizeProposedDiff(diff), ...current]);
        setExpandedDiffId(diff.id);
        setMessage({ tone: "info", text: "Created a proposed graph diff for this selected region." });
      } catch {
        setMessage({ tone: "error", text: "Could not create a proposed graph diff." });
      }
    });
  }

  function createMissingFactsProposal() {
    const ids = selectedRegionIds;
    if (ids.length === 0) {
      setMessage({ tone: "error", text: "Select at least one node before proposing missing facts." });
      return;
    }
    startTransition(async () => {
      try {
        const diff = await createMissingRegionFactsProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          objectIds: ids,
        });
        setProposedDiffs((current) => [normalizeProposedDiff(diff), ...current]);
        setExpandedDiffId(diff.id);
        setMessage({ tone: "info", text: "Proposed missing tasks, risks, or owners for this region." });
      } catch {
        setMessage({ tone: "error", text: "Could not propose missing tasks, risks, or owners." });
      }
    });
  }

  function applyDiff(proposedDiffId: string) {
    startTransition(async () => {
      try {
        await applyContextGraphProposedDiffAction({ workspaceId, proposedDiffId });
        setProposedDiffs((current) => current.filter((diff) => diff.id !== proposedDiffId));
        setMessage({ tone: "info", text: "Applied proposed graph diff." });
      } catch {
        setMessage({ tone: "error", text: "You do not have permission to apply this proposed diff." });
      }
    });
  }

  function reviewDiff(proposedDiffId: string, status: "approved" | "rejected") {
    startTransition(async () => {
      try {
        const result = await reviewContextGraphProposedDiffAction({ workspaceId, proposedDiffId, status });
        setProposedDiffs((current) => status === "rejected"
          ? current.filter((diff) => diff.id !== proposedDiffId)
          : current.map((diff) => diff.id === proposedDiffId ? { ...diff, status: result.status } : diff));
        setMessage({ tone: "info", text: status === "approved" ? "Approved proposed graph diff." : "Rejected proposed graph diff." });
      } catch {
        setMessage({ tone: "error", text: "Could not review this proposed diff." });
      }
    });
  }

  function startEditingDiff(diff: ContextGraphProposedDiff) {
    setEditingDiffId(diff.id);
    setExpandedDiffId(diff.id);
    setEditReason(diff.reason ?? "");
    setEditDiffJson(JSON.stringify(diffJsonRecord(diff.diffJson), null, 2));
  }

  function saveEditedDiff(diff: ContextGraphProposedDiff) {
    let parsedDiff: unknown;
    try {
      parsedDiff = JSON.parse(editDiffJson);
    } catch {
      setMessage({ tone: "error", text: "Diff JSON is not valid." });
      return;
    }
    startTransition(async () => {
      try {
        const updated = await updateContextGraphProposedDiffAction({
          workspaceId,
          proposedDiffId: diff.id,
          reason: editReason,
          diff: parsedDiff,
        });
        setProposedDiffs((current) => current.map((item) => item.id === diff.id
          ? { ...item, reason: updated.reason, diffJson: updated.diffJson, status: updated.status }
          : item));
        setEditingDiffId(null);
        setMessage({ tone: "info", text: "Updated proposed graph diff." });
      } catch {
        setMessage({ tone: "error", text: "Could not update this proposed diff." });
      }
    });
  }

  const shellClass = [
    "context-map-shell",
    isFullscreen ? "context-map-shell--fullscreen" : "",
    inspectorDock === "bottom" ? "context-map-shell--bottom-inspector" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className={shellClass} data-context-map-shell>
      <div className="context-map-toolbar">
        <div className="context-map-view-controls">
          <label className="context-map-view-select">
            <span>View</span>
            <select value={data.mapView.id} onChange={(event) => navigateToView(event.target.value)}>
              {data.mapViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name} ({viewScopeLabel(view)})
                </option>
              ))}
            </select>
          </label>
          <div className="context-map-title-block">
            <strong>{data.mapView.name}</strong>
            <span>{data.objects.length} objects - {data.relationships.length} relationships - {data.mapView.viewType} view - {viewScopeLabel(data.mapView)}</span>
          </div>
        </div>

        <div className="context-map-toolbar-actions">
          <button className="secondary small" type="button" onClick={() => setShowFilters((value) => !value)} title="Filter visible facts">
            <SlidersHorizontal size={14} aria-hidden="true" /> Filters
          </button>
          <button className="secondary small" type="button" onClick={fitMap} title="Fit map to view">
            <Crosshair size={14} aria-hidden="true" /> Fit
          </button>
          <button className="secondary small" type="button" onClick={resetLocalLayout} title="Reset unsaved layout changes">
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </button>
          <button
            className="secondary small"
            type="button"
            onClick={() => loadRegionContext(selectedRegionIds)}
            disabled={isPending || regionContextStatus === "loading"}
            title="Refresh selected-region context"
          >
            <FileSearch size={14} aria-hidden="true" /> {regionContextStatus === "loading" ? "Loading" : "Context"}
          </button>
          <button className="secondary small" type="button" onClick={createProposal} disabled={isPending} title="Create an agent-ready graph proposal">
            <GitBranch size={14} aria-hidden="true" /> Propose
          </button>
          <button className="secondary small" type="button" onClick={createMissingFactsProposal} disabled={isPending} title="Propose missing tasks, risks, or owners from this region">
            <ListChecks size={14} aria-hidden="true" /> Suggest gaps
          </button>
          {data.permissions.canSavePersonalView && (
            <button className="secondary small" type="button" onClick={savePersonalView} disabled={isPending} title="Save as a personal map view">
              <Copy size={14} aria-hidden="true" /> Save copy
            </button>
          )}
          <button
            className={`secondary small ${layoutDirty ? "context-map-dirty-action" : ""}`}
            type="button"
            onClick={saveLayout}
            disabled={isPending || nodes.length === 0}
            title={currentViewIsEditable ? "Save this layout" : "Request a master layout update"}
          >
            <Save size={14} aria-hidden="true" /> {layoutSaveLabel}
          </button>
          <button className="secondary small" type="button" onClick={() => setIsFullscreen((value) => !value)} title={isFullscreen ? "Exit full screen" : "Full screen"}>
            {isFullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            {isFullscreen ? "Exit" : "Full screen"}
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="context-map-filter-bar">
          <label>
            <span>Type</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">All types</option>
              {objectTypes.map((objectType) => <option key={objectType} value={objectType}>{objectType}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="active">Active facts</option>
              <option value="needs-review">Needs review</option>
              <option value="approved">Approved</option>
              <option value="all">All loaded</option>
            </select>
          </label>
          <label className="context-map-checkbox">
            <input type="checkbox" checked={includeStale} onChange={(event) => toggleIncludeStale(event.target.checked)} />
            <span>Load stale facts</span>
          </label>
        </div>
      )}

      <div className="context-map-stage">
        <div className="context-map-canvas">
          {nodes.length === 0 ? (
            <div className="context-map-empty">
              <CircleHelp size={32} aria-hidden="true" />
              <h3>No context graph objects in this view</h3>
              <p>Run meeting intelligence, sync source records, seed the demo workspace, or adjust filters to populate this map.</p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={setFlowInstance}
              onNodeClick={(_, node) => {
                setSelectedRelationshipId(null);
                setSelectedObjectId(node.id);
                setSelectedObjectIds((current) => sameIds(current, [node.id]) ? current : [node.id]);
              }}
              onEdgeClick={(_, edge) => {
                const relationship = relationshipById.get(edge.id);
                setSelectedRelationshipId(edge.id);
                if (relationship) {
                  setSelectedObjectIds([relationship.sourceObjectId, relationship.targetObjectId]);
                  setSelectedObjectId(relationship.sourceObjectId);
                }
              }}
              onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
                const ids = selectedNodes.map((node) => node.id);
                if (ids.length > 0) {
                  setSelectedObjectIds((current) => sameIds(current, ids) ? current : ids);
                  setSelectedRelationshipId(null);
                  setSelectedObjectId((current) => current === ids[0] ? current : ids[0]);
                } else if (selectedEdges.length > 0) {
                  const relationship = relationshipById.get(selectedEdges[0].id);
                  setSelectedRelationshipId(selectedEdges[0].id);
                  if (relationship) {
                    const edgeObjectIds = [relationship.sourceObjectId, relationship.targetObjectId];
                    setSelectedObjectIds((current) => sameIds(current, edgeObjectIds) ? current : edgeObjectIds);
                    setSelectedObjectId((current) => current === relationship.sourceObjectId ? current : relationship.sourceObjectId);
                  } else {
                    setSelectedObjectIds([]);
                    setSelectedObjectId(null);
                  }
                }
              }}
              onNodeDragStop={() => setLayoutDirty(true)}
              fitView
              minZoom={0.2}
              maxZoom={1.8}
              attributionPosition="bottom-right"
            >
              <Background gap={24} size={1} color="#d7dee8" />
              <Controls />
            </ReactFlow>
          )}
        </div>

        <aside className={`context-map-inspector context-map-inspector--${inspectorDock}`}>
          <div className="context-map-inspector-header">
            <div>
              <span className="context-map-eyebrow">Inspector</span>
              <strong>{selectedRelationship ? "Relationship" : "Selection"}</strong>
            </div>
            <div className="context-map-inspector-actions">
              <button type="button" className="secondary small" onClick={() => setInspectorDock(inspectorDock === "right" ? "bottom" : "right")}>
                {inspectorDock === "right" ? "Bottom" : "Right"}
              </button>
              {message && (
                <button type="button" className="secondary small context-map-icon-button" onClick={() => setMessage(null)} aria-label="Clear message">
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {message && <div className={`context-map-message context-map-message--${message.tone}`}>{message.text}</div>}

          <div className="context-map-inspector-scroll">
            {selectedRelationship ? (
              <section className="context-map-inspector-section">
                <h2>{selectedRelationship.relationshipType}</h2>
                <p className="context-map-selection-title">
                  {objectById.get(selectedRelationship.sourceObjectId)?.title ?? selectedRelationship.sourceObjectId}
                  <span> to </span>
                  {objectById.get(selectedRelationship.targetObjectId)?.title ?? selectedRelationship.targetObjectId}
                </p>
                <div className="context-map-pill-row">
                  <span className={`context-map-status context-map-status--${statusClass(selectedRelationship.status)}`}>{selectedRelationship.status}</span>
                  <span className="tag neutral">{confidenceLabel(selectedRelationship.confidence)}</span>
                  {selectedRelationship.lastVerifiedAt && <span className="tag neutral">verified {stableDateLabel(selectedRelationship.lastVerifiedAt)}</span>}
                </div>
                <dl className="context-map-definition-list">
                  <div><dt>Why</dt><dd>{sourceLabel(selectedRelationship)}</dd></div>
                  <div><dt>Created by</dt><dd>{selectedRelationship.createdByType}</dd></div>
                </dl>
              </section>
            ) : (
              <section className="context-map-inspector-section">
                <h2>Selection</h2>
                {selectedObject ? (
                  <div className="context-map-selection-stack">
                    <div>
                      <div className="nr-item-meta">{objectMeta(selectedObject)}</div>
                      <strong className="context-map-selection-title">{selectedObject.title}</strong>
                    </div>
                    {selectedObject.summary && <p>{selectedObject.summary.slice(0, 520)}</p>}
                    <div className="context-map-pill-row">
                      {selectedObject.sourceEntityType && <span className="tag neutral">{selectedObject.sourceEntityType}</span>}
                      {selectedOrgKind && selectedOrgKind !== selectedObject.sourceEntityType && <span className="tag neutral">{selectedOrgKind}</span>}
                      {propertyText(selectedObject.properties, "workState") && <span className="tag neutral">{titleizeMachineValue(propertyText(selectedObject.properties, "workState") ?? "")}</span>}
                      {propertyText(selectedObject.properties, "staffingState") && <span className="tag neutral">{titleizeMachineValue(propertyText(selectedObject.properties, "staffingState") ?? "")}</span>}
                      {propertyText(selectedObject.properties, "nextAction") && <span className="tag neutral">next action</span>}
                      <span className="tag neutral">created by {selectedObject.createdByType}</span>
                      {selectedObject.lastVerifiedAt && <span className="tag neutral">verified {stableDateLabel(selectedObject.lastVerifiedAt)}</span>}
                    </div>
                    {propertyText(selectedObject.properties, "nextAction") && (
                      <p className="context-map-next-action">{propertyText(selectedObject.properties, "nextAction")}</p>
                    )}
                    {propertyText(selectedObject.properties, "approvalRule") && (
                      <p className="context-map-next-action">Approval: {propertyText(selectedObject.properties, "approvalRule")}</p>
                    )}
                    {selectedAccountabilities.length > 0 && (
                      <div className="context-map-property-list">
                        <strong>Accountabilities</strong>
                        <ul>
                          {selectedAccountabilities.slice(0, 5).map((accountability) => (
                            <li key={accountability}>{accountability}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selectedControls.length > 0 && (
                      <div className="context-map-property-list">
                        <strong>Governance controls</strong>
                        <ul>
                          {selectedControls.slice(0, 5).map((control) => (
                            <li key={control}>{control}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selectedAllowedActions.length > 0 && (
                      <div className="context-map-property-list">
                        <strong>Allowed actions</strong>
                        <ul>
                          {selectedAllowedActions.slice(0, 5).map((action) => (
                            <li key={action}>{action}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted">Select a node or relationship to inspect evidence and provenance.</p>
                )}
              </section>
            )}

            <section className="context-map-inspector-section">
              <h2>Evidence</h2>
              {(selectedRelationship?.evidenceRefs ?? selectedObject?.evidenceRefs ?? []).length ? (
                <div className="context-map-evidence-list">
                  {(selectedRelationship?.evidenceRefs ?? selectedObject?.evidenceRefs ?? []).slice(0, 5).map((evidence) => (
                    <div key={evidence.id} className="context-map-evidence-item">
                      <div className="nr-item-meta">{evidence.sourceType} - {confidenceLabel(evidence.relevanceScore)}</div>
                      <p>{evidence.quote ?? evidence.sourceId}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No evidence refs attached yet.</p>
              )}
            </section>

            <section className="context-map-inspector-section">
              <h2>Neighbors</h2>
              {selectedRelationships.length ? (
                <div className="context-map-neighbor-list">
                  {selectedRelationships.slice(0, 8).map((relationship) => {
                    const otherId = relationship.sourceObjectId === selectedObject?.id ? relationship.targetObjectId : relationship.sourceObjectId;
                    return (
                      <button
                        key={relationship.id}
                        type="button"
                        className="secondary small"
                        onClick={() => {
                          setSelectedRelationshipId(null);
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
                <p className="muted">No graph relationships connected to this object.</p>
              )}
            </section>

            <section className="context-map-inspector-section">
              <h2>Region Context</h2>
              {regionContextStatus === "loading" ? (
                <p className="muted" aria-live="polite">Loading selected-region context...</p>
              ) : regionContextStatus === "error" ? (
                <p className="form-message form-message-error" role="alert">Could not build context for this selection.</p>
              ) : regionContext ? (
                <div className="context-map-context-stack">
                  <div className="context-map-pill-row">
                    <span className="tag neutral">{regionContext.objects.length} objects</span>
                    <span className="tag neutral">{regionContext.relationships.length} relationships</span>
                    <span className="tag neutral">{regionContext.evidenceRefs.length} evidence refs</span>
                    <span className="tag neutral">{regionContext.directNeighbors.length} direct neighbors</span>
                    <span className="tag neutral">{regionContext.permissions.canPropose ? "can propose" : "read only"}</span>
                    {regionContext.staleOrDisputed.length > 0 && <span className="tag danger">{regionContext.staleOrDisputed.length} stale/disputed</span>}
                  </div>
                  {regionContext.directNeighbors.length > 0 && (
                    <div>
                      <strong>{directNeighborHeading(data.mapView.viewType)}</strong>
                      <ul>
                        {regionContext.directNeighbors.slice(0, 4).map((neighbor) => (
                          <li key={`${neighbor.relationshipId}-${neighbor.objectId}`}>
                            {neighbor.relationshipType}: {neighbor.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {regionContext.contextGaps.length > 0 && (
                    <div>
                      <strong>Gaps</strong>
                      <ul>
                        {regionContext.contextGaps.slice(0, 4).map((gap) => (
                          <li key={gap.id}>{gap.title}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {regionContext.likelyNextActions.length > 0 && (
                    <div>
                      <strong>Likely next actions</strong>
                      <ul>
                        {regionContext.likelyNextActions.slice(0, 4).map((action) => (
                          <li key={action.id}>{action.title}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {regionContext.rankedFacts.length > 0 && (
                    <div>
                      <strong>Ranked facts</strong>
                      <ul>
                        {regionContext.rankedFacts.slice(0, 5).map((fact) => (
                          <li key={`${fact.kind}-${fact.id}`}>{fact.type}: {fact.title}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {regionContext.sourceRecords.length > 0 && (
                    <div>
                      <strong>Source records</strong>
                      <ul>
                        {regionContext.sourceRecords.slice(0, 4).map((record) => (
                          <li key={`${record.sourceType}-${record.sourceId}`}>
                            {record.sourceType}: {record.sourceTitle ?? record.sourceId}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {regionContext.openQuestions.length > 0 && (
                    <div>
                      <strong>Open questions</strong>
                      <ul>
                        {regionContext.openQuestions.slice(0, 3).map((question) => <li key={question.id}>{question.title}</li>)}
                      </ul>
                    </div>
                  )}
                  {regionContext.knowledgeChunks.length > 0 && (
                    <div>
                      <strong>Source snippets</strong>
                      <ul>
                        {regionContext.knowledgeChunks.slice(0, 3).map((chunk) => <li key={chunk.id}>{chunk.sourceTitle ?? chunk.sourceId}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="muted">Select a node, edge, or multi-node region to build scoped context.</p>
              )}
            </section>

            <section className="context-map-inspector-section">
              <h2>Proposed Diffs</h2>
              {proposedDiffs.length ? (
                <div className="context-map-diff-list">
                  {proposedDiffs.map((diff) => {
                    const preview = diffPreviewLines(diff.diffJson, objectById, data.mapViews);
                    const expanded = expandedDiffId === diff.id;
                    const editing = editingDiffId === diff.id;
                    return (
                      <div key={diff.id} className="context-map-diff-item">
                        <div className="context-map-diff-heading">
                          <div>
                            <div className="nr-item-meta">{diff.status} - {stableDateLabel(diff.createdAt)}</div>
                            <p>{diff.reason ?? "Proposed graph change"}</p>
                          </div>
                          <button className="secondary small" type="button" onClick={() => setExpandedDiffId(expanded ? null : diff.id)}>
                            {expanded ? "Hide" : "Compare"}
                          </button>
                        </div>
                        <div className="context-map-pill-row">
                          <span className={`context-map-status context-map-status--${diff.status === "approved" ? "approved" : diff.status === "pending" ? "pending" : "neutral"}`}>{diff.status}</span>
                          <span className="tag neutral">{diffCountLabel(diff.diffJson)}</span>
                        </div>
                        {expanded && (
                          <div className="context-map-diff-compare">
                            <div>
                              <strong>Before</strong>
                              <ul>
                                {preview.before.map((line, index) => <li key={`before-${index}-${line}`}>{line}</li>)}
                              </ul>
                            </div>
                            <div>
                              <strong>After approval</strong>
                              <ul>
                                {preview.after.map((line, index) => <li key={`after-${index}-${line}`}>{line}</li>)}
                              </ul>
                            </div>
                          </div>
                        )}
                        {editing && (
                          <div className="context-map-diff-editor">
                            <label>
                              <span>Reason</span>
                              <input value={editReason} onChange={(event) => setEditReason(event.target.value)} />
                            </label>
                            <label>
                              <span>Diff JSON</span>
                              <textarea value={editDiffJson} onChange={(event) => setEditDiffJson(event.target.value)} rows={8} spellCheck={false} />
                            </label>
                          </div>
                        )}
                        <div className="context-map-diff-actions">
                          {data.permissions.canUpdateMasterView ? (
                            <>
                              {diff.status === "pending" && (
                                <button className="secondary small" type="button" onClick={() => reviewDiff(diff.id, "approved")} disabled={isPending}>
                                  <Check size={14} aria-hidden="true" /> Approve
                                </button>
                              )}
                              <button className="secondary small" type="button" onClick={() => applyDiff(diff.id)} disabled={isPending || !["pending", "approved"].includes(diff.status)}>
                                <Check size={14} aria-hidden="true" /> {diff.status === "approved" ? "Apply approved" : "Approve and apply"}
                              </button>
                              {diff.status === "pending" && (
                                <button className="secondary small" type="button" onClick={() => editing ? saveEditedDiff(diff) : startEditingDiff(diff)} disabled={isPending}>
                                  {editing ? <Save size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
                                  {editing ? "Save edit" : "Edit"}
                                </button>
                              )}
                              {editing && (
                                <button className="secondary small" type="button" onClick={() => setEditingDiffId(null)} disabled={isPending}>
                                  <X size={14} aria-hidden="true" /> Cancel
                                </button>
                              )}
                              {diff.status === "pending" && (
                                <button className="secondary small context-map-danger-action" type="button" onClick={() => reviewDiff(diff.id, "rejected")} disabled={isPending}>
                                  <Ban size={14} aria-hidden="true" /> Reject
                                </button>
                              )}
                            </>
                          ) : (
                            <p className="muted">Admins and facilitators can approve, edit, apply, or reject this proposed diff.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">No pending graph diffs.</p>
              )}
            </section>

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
          </div>
        </aside>
      </div>
    </section>
  );
}
