"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Connection, Edge, EdgeProps, EdgeTypes, Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Ban,
  Check,
  CircleHelp,
  Copy,
  Crosshair,
  FileSearch,
  Maximize2,
  MessageSquare,
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
  createContextMapManualEditProposalAction,
  createPersonalContextMapViewAction,
  reviewContextGraphProposedDiffAction,
  saveContextMapLayoutAction,
  updateContextGraphProposedDiffAction,
} from "./actions";
import { openWorkspaceChat, type WorkspaceChatPageContext } from "../chat/page-context";
import "./context-map.css";
import {
  buildRoutedEdgePath,
  handleId,
  nearestSourceSide,
  oppositeSide,
  scopeObstaclesForEdge,
  type NodeRect,
  type NodeSide,
} from "./context-map-routing";

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
  id?: string;
  objectType?: string;
  title?: string;
  summary?: string | null;
  properties?: Record<string, unknown>;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
};

type DiffRelationshipInput = {
  ref?: string;
  id?: string;
  sourceObjectId?: string;
  sourceRef?: string;
  targetObjectId?: string;
  targetRef?: string;
  relationshipType?: string;
  properties?: Record<string, unknown>;
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
  items?: Array<{
    objectId?: string;
    objectRef?: string;
    x?: number;
    y?: number;
    width?: number | null;
    height?: number | null;
    visualState?: Record<string, unknown>;
  }>;
};

type DiffJsonInput = {
  objects?: DiffObjectInput[];
  objectUpdates?: DiffObjectInput[];
  relationships?: DiffRelationshipInput[];
  relationshipUpdates?: DiffRelationshipInput[];
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
  guidance: {
    evidenceBacked: boolean;
    defaultMapKey: string | null;
    description: string;
    missingEvidencePrompt: string;
    emptyTitle: string;
    emptyDescription: string;
  };
  permissions: {
    canSavePersonalView: boolean;
    canUpdateMasterView: boolean;
    canRequestMasterUpdate: boolean;
  };
};

type RegionContext = Awaited<ReturnType<typeof buildSelectedRegionContextAction>>;
type InspectorDock = "right" | "bottom";
type StatusFilter = "active" | "approved" | "needs-review" | "all";
type ContextMapNodeVariant = "standard" | "alert";
type ContextMapManualCardKind = "standard" | "alert";
type ContextMapManualRelationIntent = "enables" | "blocks" | "supports" | "needs_approval_from";

type ContextMapMenuState =
  | { kind: "pane"; x: number; y: number; position: { x: number; y: number } }
  | { kind: "node"; x: number; y: number; nodeId: string }
  | { kind: "edge"; x: number; y: number; edgeId: string };

type ContextMapCardDraft = {
  cardKind: ContextMapManualCardKind;
  title: string;
  position: { x: number; y: number };
  sourceObjectId?: string | null;
  relationIntent?: ContextMapManualRelationIntent | null;
};

type ContextMapConnectionDraft = {
  sourceObjectId: string;
  targetObjectId: string;
  relationIntent?: ContextMapManualRelationIntent | null;
};

type ContextMapEdgeDraft = {
  relationshipId: string;
  relationIntent?: ContextMapManualRelationIntent | null;
};

type NodeColors = {
  border: string;
  background: string;
  accent: string;
};

type ContextMapNodeData = Record<string, unknown> & {
  object: ContextGraphObject;
  colors: NodeColors;
  variant: ContextMapNodeVariant;
  preview: boolean;
  connectable: boolean;
  workState: string | null;
  pathStage: string | null;
  staffingState: string | null;
  viewType: string;
};

type ContextMapEdgeData = Record<string, unknown> & {
  label: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  preview: boolean;
  relationshipType: string;
  sourceSide: NodeSide;
  targetSide: NodeSide;
  obstacles: NodeRect[];
};

type ContextMapFlowNode = Node<ContextMapNodeData, "contextMapNode">;
type ContextMapFlowEdge = Edge<ContextMapEdgeData, "contextMapRouted">;

const INSPECTOR_DOCK_STORAGE_KEY = "corgtex.contextMap.inspectorDock";
const INSPECTOR_WIDTH_STORAGE_KEY = "corgtex.contextMap.inspectorWidth";
const INSPECTOR_DEFAULT_WIDTH = 430;
const INSPECTOR_MIN_WIDTH = 340;
const INSPECTOR_MAX_WIDTH = 680;
const CONTEXT_MAP_NODE_WIDTH = 250;
const CONTEXT_MAP_NODE_HEIGHT = 128;

const NODE_SIDES: NodeSide[] = ["top", "right", "bottom", "left"];

const SIDE_POSITION: Record<NodeSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

const NODE_COLORS: Record<string, NodeColors> = {
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
  Metric: { border: "var(--warning)", background: "var(--warning-soft)", accent: "var(--warning)" },
};

const PROCESS_DETAIL_TYPES = new Set(["Risk", "Metric", "Question", "Hypothesis"]);
const STRUCTURAL_PROCESS_TYPES = new Set(["Process", "ProcessStep", "Team"]);
const ALERT_CARD_TYPES = new Set(["Risk", "Question", "Hypothesis"]);
const PREVIEW_ID_PREFIX = "proposal:";
const RELATION_INTENT_OPTIONS: Array<{ intent: ContextMapManualRelationIntent; label: string }> = [
  { intent: "enables", label: "Enables" },
  { intent: "blocks", label: "Blocks" },
  { intent: "supports", label: "Supports" },
  { intent: "needs_approval_from", label: "Needs approval from" },
];

function mapObjectDisplayRole(object: ContextGraphObject, view: ContextMapView) {
  const explicitRole = propertyText(object.properties, "contextMapDisplay") ?? propertyText(object.properties, "displayRole");
  const mapRole = propertyText(object.properties, "mapRole");
  if (explicitRole === "canvas" || explicitRole === "detail" || explicitRole === "context") return explicitRole;
  if (explicitRole === "embedded") return "detail";
  if (mapRole === "context") return "context";
  if (view.viewType === "process" && PROCESS_DETAIL_TYPES.has(object.objectType)) return "detail";
  return "canvas";
}

function isDetailObject(object: ContextGraphObject | undefined, view: ContextMapView) {
  return Boolean(object && mapObjectDisplayRole(object, view) === "detail");
}

function isCanvasObject(object: ContextGraphObject, view: ContextMapView) {
  if (mapObjectDisplayRole(object, view) !== "canvas") return false;
  const explicitRole = propertyText(object.properties, "contextMapDisplay") ?? propertyText(object.properties, "displayRole");
  if (explicitRole === "canvas") return true;
  if (view.viewType !== "process") return true;
  return STRUCTURAL_PROCESS_TYPES.has(object.objectType) || !PROCESS_DETAIL_TYPES.has(object.objectType);
}

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

function clampInspectorWidth(value: number) {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(value)));
}

function storedInspectorDock() {
  if (typeof window === "undefined") return "right";
  return window.localStorage.getItem(INSPECTOR_DOCK_STORAGE_KEY) === "bottom" ? "bottom" : "right";
}

function storedInspectorWidth() {
  if (typeof window === "undefined") return INSPECTOR_DEFAULT_WIDTH;
  const value = Number(window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY));
  return Number.isFinite(value) ? clampInspectorWidth(value) : INSPECTOR_DEFAULT_WIDTH;
}

function humanStatusLabel(status: string) {
  const labels: Record<string, string> = {
    approved: "Approved",
    proposed: "Needs review",
    draft: "Draft",
    stale: "Needs refresh",
    disputed: "Disputed",
    archived: "Archived",
  };
  return labels[status] ?? titleizeMachineValue(status);
}

function humanObjectTypeLabel(objectType: string, viewType?: string) {
  if (viewType === "org" && objectType === "Team") return "Circle or team";
  if (viewType === "agent" && objectType === "Document") return "Source or output";
  const labels: Record<string, string> = {
    ProcessStep: "Process step",
    Evidence: "Audit evidence",
    Metric: "Metric",
  };
  return labels[objectType] ?? objectType;
}

function humanRelationshipLabel(type: string) {
  const labels: Record<string, string> = {
    assigned_to: "Assigned to",
    blocks: "Blocks",
    created_in: "Created in",
    decided_in: "Decided in",
    depends_on: "Depends on",
    has_evidence: "Supported by evidence",
    input_to: "Feeds",
    member_of: "Member of",
    needs_approval_from: "Needs approval from",
    output_of: "Output of",
    owns: "Owns",
    part_of: "Part of",
    reports_to: "Reports to",
    supports: "Supports",
    uses: "Uses",
  };
  return labels[type] ?? titleizeMachineValue(type);
}

function humanRelationshipSentence(
  relationship: ContextGraphRelationship,
  selectedObjectId: string | null,
  objects: Map<string, ContextGraphObject>,
) {
  const source = objects.get(relationship.sourceObjectId)?.title ?? "This item";
  const target = objects.get(relationship.targetObjectId)?.title ?? "another item";
  const selectedIsSource = selectedObjectId === relationship.sourceObjectId;
  const selectedIsTarget = selectedObjectId === relationship.targetObjectId;
  const otherTitle = selectedIsSource ? target : source;

  switch (relationship.relationshipType) {
    case "owns":
      return selectedIsTarget ? `${source} owns this.` : `Owns ${target}.`;
    case "assigned_to":
      return selectedIsSource ? `Assigned to ${target}.` : `${source} is assigned here.`;
    case "needs_approval_from":
      return selectedIsSource ? `Needs approval from ${target}.` : `${source} needs this approval.`;
    case "depends_on":
      return selectedIsSource ? `Depends on ${target}.` : `${source} depends on this.`;
    case "blocks":
      return selectedIsSource ? `Blocks ${target}.` : `Blocked by ${source}.`;
    case "supports":
      return selectedIsSource ? `Supports ${target}.` : `Supported by ${source}.`;
    case "part_of":
      return selectedIsSource ? `Part of ${target}.` : `Includes ${source}.`;
    case "member_of":
      return selectedIsSource ? `Member of ${target}.` : `${source} is a member here.`;
    case "reports_to":
      return selectedIsSource ? `Reports to ${target}.` : `${source} reports here.`;
    case "uses":
      return selectedIsSource ? `Uses ${target}.` : `Used by ${source}.`;
    case "input_to":
      return selectedIsSource ? `Feeds into ${target}.` : `Receives input from ${source}.`;
    case "output_of":
      return selectedIsSource ? `Output from ${target}.` : `Produces ${source}.`;
    case "created_in":
      return selectedIsSource ? `Created in ${target}.` : `Created ${source}.`;
    case "decided_in":
      return selectedIsSource ? `Decided in ${target}.` : `Includes decision: ${source}.`;
    case "has_evidence":
      return selectedIsSource ? `Supported by ${target}.` : `Supports ${source}.`;
    default:
      return selectedIsSource || selectedIsTarget
        ? `${humanRelationshipLabel(relationship.relationshipType)} ${otherTitle}.`
        : `${source} ${humanRelationshipLabel(relationship.relationshipType).toLowerCase()} ${target}.`;
  }
}

function evidenceSourceLabel(sourceType: string) {
  const labels: Record<string, string> = {
    AGENT_IDENTITY: "Agent",
    AGENT_RUN: "Agent run",
    AUDIT_TRAIL: "Audit trail",
    BRAIN_ARTICLE: "Brain article",
    CONTEXT_PACKET: "Selected map brief",
    DOCUMENT: "Document",
    MCP_TOOL: "Tool",
    MEETING: "Meeting",
    MEETING_INSIGHT: "Meeting note",
    MEMBER_RECORD: "Member record",
    POLICY_RECORD: "Policy",
    PROPOSED_DIFF: "Proposed change",
    REGION_CONTEXT: "Selected map context",
    RISK_REGISTER: "Risk record",
    ROLE_RECORD: "Role record",
    SOURCE_RECORD: "Record",
  };
  return labels[sourceType] ?? titleizeMachineValue(sourceType);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreviewId(id: string) {
  return id.startsWith(PREVIEW_ID_PREFIX);
}

function isPreviewObject(object: ContextGraphObject) {
  return object.sourceEntityType === "ContextGraphProposedDiff" || isPreviewId(object.id);
}

function cardVariantForObject(object: ContextGraphObject): ContextMapNodeVariant {
  const explicitKind = propertyText(object.properties, "cardKind");
  if (explicitKind === "alert") return "alert";
  if (object.status === "stale" || object.status === "disputed") return "alert";
  return ALERT_CARD_TYPES.has(object.objectType) ? "alert" : "standard";
}

function relationIntentLabel(intent: ContextMapManualRelationIntent) {
  return RELATION_INTENT_OPTIONS.find((option) => option.intent === intent)?.label ?? titleizeMachineValue(intent);
}

function relationshipVisualStyle(relationship: ContextGraphRelationship) {
  const pending = relationship.status === "proposed" || relationship.status === "draft" || isPreviewId(relationship.id);
  if (relationship.status === "stale" || relationship.status === "disputed") {
    return { stroke: "#dc2626", strokeWidth: 2.4, strokeDasharray: pending ? "7 5" : undefined };
  }
  if (pending) {
    return { stroke: "#ca8a04", strokeWidth: 2, strokeDasharray: "7 5" };
  }
  if (relationship.relationshipType === "blocks") {
    return { stroke: "#dc2626", strokeWidth: 2.6 };
  }
  if (relationship.relationshipType === "depends_on") {
    return { stroke: "#0f766e", strokeWidth: 2 };
  }
  if (relationship.relationshipType === "needs_approval_from") {
    return { stroke: "#ca8a04", strokeWidth: 2, strokeDasharray: "7 5" };
  }
  if (["supports", "has_evidence", "created_in", "decided_in"].includes(relationship.relationshipType)) {
    return { stroke: "#64748b", strokeWidth: 1.8, strokeDasharray: "6 5" };
  }
  if (["uses", "input_to", "output_of"].includes(relationship.relationshipType)) {
    return { stroke: "#2563eb", strokeWidth: 1.8 };
  }
  return { stroke: "#64748b", strokeWidth: 1.8 };
}

function nodeRectFromFlowNode(node: ContextMapFlowNode): NodeRect {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? node.initialWidth ?? styleWidth ?? CONTEXT_MAP_NODE_WIDTH,
    height: Math.max(node.height ?? node.initialHeight ?? styleHeight ?? CONTEXT_MAP_NODE_HEIGHT, CONTEXT_MAP_NODE_HEIGHT),
  };
}

function visualRelationshipEndpoints(relationship: ContextGraphRelationship) {
  if (relationship.relationshipType === "depends_on") {
    return {
      sourceObjectId: relationship.targetObjectId,
      targetObjectId: relationship.sourceObjectId,
      label: "Enables",
    };
  }
  return {
    sourceObjectId: relationship.sourceObjectId,
    targetObjectId: relationship.targetObjectId,
    label: humanRelationshipLabel(relationship.relationshipType),
  };
}

function ContextMapNode({ data }: NodeProps<ContextMapFlowNode>) {
  const object = data.object;
  return (
    <>
      {NODE_SIDES.map((side) => (
        <Handle
          key={`source-${side}`}
          className="context-map-node-handle context-map-node-handle--source"
          id={handleId("source", side)}
          isConnectable={data.connectable}
          position={SIDE_POSITION[side]}
          type="source"
        />
      ))}
      {NODE_SIDES.map((side) => (
        <Handle
          key={`target-${side}`}
          className="context-map-node-handle context-map-node-handle--target"
          id={handleId("target", side)}
          isConnectable={data.connectable}
          position={SIDE_POSITION[side]}
          type="target"
        />
      ))}
      <div
        className={[
          "context-map-node-card",
          `context-map-node-card--${statusClass(object.status)}`,
          `context-map-node-card--${data.variant}`,
          data.preview ? "context-map-node-card--preview" : "",
        ].filter(Boolean).join(" ")}
        style={{ "--node-border": data.colors.border, "--node-bg": data.colors.background, "--node-accent": data.colors.accent } as CSSProperties}
      >
        <div className="context-map-node-topline">
          <span>{humanObjectTypeLabel(object.objectType, data.viewType)}</span>
          <span className={`context-map-status context-map-status--${statusClass(object.status)}`}>{humanStatusLabel(object.status)}</span>
        </div>
        <strong>{object.title}</strong>
        <div className="context-map-node-meta">
          {data.workState && <span>{titleizeMachineValue(data.workState)}</span>}
          {data.pathStage && <span>{data.pathStage}</span>}
          {data.staffingState && <span>{titleizeMachineValue(data.staffingState)}</span>}
        </div>
      </div>
    </>
  );
}

function ContextMapRoutedEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  selected,
  data,
  label,
}: EdgeProps<ContextMapFlowEdge>) {
  const edgeData = data ?? {
    label: typeof label === "string" ? label : "",
    stroke: "#64748b",
    strokeWidth: 1.8,
    preview: false,
    relationshipType: "relates_to",
    sourceSide: "right" as const,
    targetSide: "left" as const,
    obstacles: [],
  };
  const obstacles = edgeData.obstacles.filter((obstacle) => obstacle.id !== source && obstacle.id !== target);
  const route = buildRoutedEdgePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceSide: edgeData.sourceSide,
    targetSide: edgeData.targetSide,
    obstacles,
  });
  const labelText = edgeData.label || label;

  return (
    <>
      <BaseEdge
        id={id}
        className={selected ? "context-map-flow-edge-path context-map-flow-edge-path--selected" : "context-map-flow-edge-path"}
        interactionWidth={24}
        markerEnd={markerEnd}
        path={route.path}
        style={{
          ...style,
          stroke: edgeData.stroke,
          strokeWidth: selected ? Math.max(edgeData.strokeWidth + 0.6, 3) : edgeData.strokeWidth,
          strokeDasharray: edgeData.strokeDasharray,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
      {labelText && (
        <EdgeLabelRenderer>
          <div
            className={[
              "context-map-flow-edge-label",
              `context-map-flow-edge-label--${edgeData.relationshipType}`,
              edgeData.preview ? "context-map-flow-edge-label--preview" : "",
            ].filter(Boolean).join(" ")}
            data-edge-id={id}
            style={{
              transform: `translate(-50%, -50%) translate(${route.labelX}px, ${route.labelY}px)`,
            }}
          >
            {labelText}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const CONTEXT_MAP_NODE_TYPES = {
  contextMapNode: ContextMapNode,
} satisfies NodeTypes;

const CONTEXT_MAP_EDGE_TYPES = {
  contextMapRouted: ContextMapRoutedEdge,
} satisfies EdgeTypes;

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

function mapViewUrl(viewId: string, includeStale: boolean, fullscreen = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", viewId);
  if (includeStale) url.searchParams.set("stale", "1");
  else url.searchParams.delete("stale");
  if (fullscreen) url.searchParams.set("fullscreen", "1");
  else url.searchParams.delete("fullscreen");
  return `${url.pathname}${url.search}`;
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

function normalizeManualEditProposal(value: {
  proposedDiffId: string;
  reason: string | null;
  status: string;
  createdAt: string | Date;
  diffJson: unknown;
}): ContextGraphProposedDiff {
  return normalizeProposedDiff({
    id: value.proposedDiffId,
    reason: value.reason,
    status: value.status,
    createdAt: value.createdAt,
    diffJson: value.diffJson,
  });
}

function previewObjectId(diffId: string, ref: string) {
  return `${PREVIEW_ID_PREFIX}${diffId}:${ref}`;
}

function previewRelationshipId(diffId: string, ref: string) {
  return `${PREVIEW_ID_PREFIX}${diffId}:relationship:${ref}`;
}

function finiteLayoutItem(item: { x?: number; y?: number } | undefined) {
  return item && Number.isFinite(item.x) && Number.isFinite(item.y);
}

function buildPendingMapPreview(
  proposedDiffs: ContextGraphProposedDiff[],
  mapView: ContextMapView,
  baseObjectsById: Map<string, ContextGraphObject>,
  baseRelationshipsById: Map<string, ContextGraphRelationship>,
) {
  const objects: ContextGraphObject[] = [];
  const relationships: ContextGraphRelationship[] = [];
  const layoutItems: ContextMapLayoutItem[] = [];

  for (const proposedDiff of proposedDiffs) {
    if (!["pending", "approved"].includes(proposedDiff.status)) continue;
    const diff = diffJsonRecord(proposedDiff.diffJson);
    const refToPreviewId = new Map<string, string>();
    const layoutByRef = new Map<string, NonNullable<DiffLayoutInput["items"]>[number]>();
    const layoutById = new Map<string, NonNullable<DiffLayoutInput["items"]>[number]>();

    for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
      if (layoutUpdate.mapViewId !== mapView.id) continue;
      for (const item of layoutUpdate.items ?? []) {
        if (!finiteLayoutItem(item)) continue;
        if (item.objectRef) layoutByRef.set(item.objectRef, item);
        if (item.objectId) layoutById.set(item.objectId, item);
      }
    }

    for (const [index, object] of (diff.objects ?? []).entries()) {
      const ref = object.ref ?? object.id ?? `object-${index}`;
      const layout = object.ref ? layoutByRef.get(object.ref) : object.id ? layoutById.get(object.id) : undefined;
      if (!layout || !finiteLayoutItem(layout)) continue;
      const id = previewObjectId(proposedDiff.id, ref);
      refToPreviewId.set(ref, id);
      if (object.ref) refToPreviewId.set(object.ref, id);
      const properties = isRecord(object.properties) ? object.properties : {};
      objects.push({
        id,
        objectType: object.objectType ?? "ProcessStep",
        title: humanDiffTitle(object.title ?? "Untitled card"),
        summary: object.summary ?? null,
        properties: {
          ...properties,
          contextMapDisplay: "canvas",
        },
        confidence: null,
        status: object.status ?? "proposed",
        createdByType: "human",
        createdByUserId: null,
        createdByAgentRunId: null,
        sourceEntityType: "ContextGraphProposedDiff",
        sourceEntityId: proposedDiff.id,
        validFrom: null,
        validTo: null,
        lastVerifiedAt: null,
        evidenceRefs: [],
      });
      layoutItems.push({
        objectId: id,
        x: layout.x ?? 0,
        y: layout.y ?? 0,
        width: layout.width ?? CONTEXT_MAP_NODE_WIDTH,
        height: layout.height ?? CONTEXT_MAP_NODE_HEIGHT,
      });
    }

    const resolveEndpoint = (objectId?: string, ref?: string) => {
      if (objectId && baseObjectsById.has(objectId)) return objectId;
      if (objectId && refToPreviewId.has(objectId)) return refToPreviewId.get(objectId);
      if (ref && refToPreviewId.has(ref)) return refToPreviewId.get(ref);
      return undefined;
    };

    for (const [index, relationship] of (diff.relationships ?? []).entries()) {
      const sourceObjectId = resolveEndpoint(relationship.sourceObjectId, relationship.sourceRef);
      const targetObjectId = resolveEndpoint(relationship.targetObjectId, relationship.targetRef);
      if (!sourceObjectId || !targetObjectId) continue;
      const ref = relationship.ref ?? `${sourceObjectId}:${relationship.relationshipType ?? "relates_to"}:${targetObjectId}:${index}`;
      relationships.push({
        id: previewRelationshipId(proposedDiff.id, ref),
        sourceObjectId,
        targetObjectId,
        relationshipType: relationship.relationshipType ?? "supports",
        properties: isRecord(relationship.properties) ? relationship.properties : {},
        confidence: null,
        status: relationship.status ?? "proposed",
        createdByType: "human",
        createdByUserId: null,
        createdByAgentRunId: null,
        sourceEntityType: "ContextGraphProposedDiff",
        sourceEntityId: proposedDiff.id,
        validFrom: null,
        validTo: null,
        lastVerifiedAt: null,
        evidenceRefs: [],
      });
    }

    for (const [index, relationshipUpdate] of (diff.relationshipUpdates ?? []).entries()) {
      if (!relationshipUpdate.id) continue;
      const baseRelationship = baseRelationshipsById.get(relationshipUpdate.id);
      if (!baseRelationship) continue;
      const sourceObjectId = relationshipUpdate.sourceObjectId ?? baseRelationship.sourceObjectId;
      const targetObjectId = relationshipUpdate.targetObjectId ?? baseRelationship.targetObjectId;
      if (!baseObjectsById.has(sourceObjectId) || !baseObjectsById.has(targetObjectId)) continue;
      relationships.push({
        ...baseRelationship,
        id: previewRelationshipId(proposedDiff.id, `${relationshipUpdate.id}:${index}`),
        sourceObjectId,
        targetObjectId,
        relationshipType: relationshipUpdate.relationshipType ?? baseRelationship.relationshipType,
        properties: {
          ...baseRelationship.properties,
          ...(isRecord(relationshipUpdate.properties) ? relationshipUpdate.properties : {}),
          previewUpdate: true,
          previewArchive: relationshipUpdate.status === "archived",
        },
        status: relationshipUpdate.status === "archived" ? "proposed" : relationshipUpdate.status ?? "proposed",
        sourceEntityType: "ContextGraphProposedDiff",
        sourceEntityId: proposedDiff.id,
      });
    }
  }

  return { objects, relationships, layoutItems };
}

function diffTechnicalCountLabel(diffJson: unknown) {
  const diff = diffJsonRecord(diffJson);
  const parts = [
    `${diff.objects?.length ?? 0} objects`,
    `${diff.objectUpdates?.length ?? 0} object updates`,
    `${diff.relationships?.length ?? 0} relationships`,
    `${diff.relationshipUpdates?.length ?? 0} relationship updates`,
    `${diff.evidenceRefs?.length ?? 0} evidence refs`,
    `${diff.mapLayoutUpdates?.reduce((sum, update) => sum + (update.items?.length ?? 0), 0) ?? 0} layout moves`,
  ];
  return parts.join(" - ");
}

function objectTitleFromId(objects: Map<string, ContextGraphObject>, objectId: string | undefined) {
  return objectId ? objects.get(objectId)?.title ?? objectId : "new object";
}

function proposedObjectLabel(object: DiffObjectInput | undefined) {
  if (!object) return "the new item";
  return `${humanObjectTypeLabel(object.objectType ?? "Item").toLowerCase()} ${humanDiffTitle(object.title)}`;
}

function humanDiffTitle(title: string | null | undefined) {
  if (!title) return "Untitled";
  return title
    .replace(/^Review fact:\s*/i, "Review what is known about ")
    .replace(/^Clarify blocker:\s*/i, "Clarify blocker: ")
    .replace(/^Resolve blocker:\s*/i, "Resolve blocker: ");
}

function relationshipEndpointLabel(
  value: DiffRelationshipInput,
  key: "source" | "target",
  objects: Map<string, ContextGraphObject>,
  proposedObjects: Map<string, DiffObjectInput>,
) {
  const objectId = key === "source" ? value.sourceObjectId : value.targetObjectId;
  const ref = key === "source" ? value.sourceRef : value.targetRef;
  return objectId ? objectTitleFromId(objects, objectId) : ref ? proposedObjectLabel(proposedObjects.get(ref)) : "an item";
}

function diffHumanPreview(diffJson: unknown, objects: Map<string, ContextGraphObject>, mapViews: ContextMapView[]) {
  const diff = diffJsonRecord(diffJson);
  const proposedObjects = new Map((diff.objects ?? []).flatMap((object) => object.ref ? [[object.ref, object] as const] : []));
  const currentMap: string[] = [];
  const ifApproved: string[] = [];
  const adds: string[] = [];
  const connects: string[] = [];
  const updates: string[] = [];
  const needsApproval: string[] = [];

  for (const object of diff.objects ?? []) {
    const label = `${humanObjectTypeLabel(object.objectType ?? "Item")}: ${humanDiffTitle(object.title ?? object.ref)}`;
    currentMap.push(`${label} is not on the approved map yet.`);
    ifApproved.push(`Add ${label}.`);
    adds.push(`Add ${label}.`);
  }
  for (const objectUpdate of diff.objectUpdates ?? []) {
    const currentTitle = objectTitleFromId(objects, objectUpdate.id);
    const nextTitle = objectUpdate.title ? humanDiffTitle(objectUpdate.title) : currentTitle;
    const label = `${currentTitle}${nextTitle !== currentTitle ? ` -> ${nextTitle}` : ""}`;
    currentMap.push(`${currentTitle} keeps its current details.`);
    ifApproved.push(`Update ${label}${objectUpdate.status ? ` (${humanStatusLabel(objectUpdate.status)})` : ""}.`);
    updates.push(`Update ${label}.`);
  }
  for (const relationship of diff.relationships ?? []) {
    const source = relationshipEndpointLabel(relationship, "source", objects, proposedObjects);
    const target = relationshipEndpointLabel(relationship, "target", objects, proposedObjects);
    const label = `${source} ${humanRelationshipLabel(relationship.relationshipType ?? "relates to").toLowerCase()} ${target}`;
    currentMap.push(`${label} is not connected on the approved map yet.`);
    ifApproved.push(`Connect ${label}.`);
    connects.push(`Connect ${label}.`);
  }
  for (const relationshipUpdate of diff.relationshipUpdates ?? []) {
    const label = relationshipUpdate.id ?? "connection";
    currentMap.push(`${label} keeps its current connection details.`);
    ifApproved.push(`Update ${label}${relationshipUpdate.status ? ` (${humanStatusLabel(relationshipUpdate.status)})` : ""}.`);
    updates.push(`Update ${label}.`);
  }
  for (const evidence of diff.evidenceRefs ?? []) {
    currentMap.push("The supporting evidence is not attached yet.");
    ifApproved.push(`Attach ${evidenceSourceLabel(evidence.sourceType ?? "source")} evidence.`);
    updates.push(`Attach ${evidenceSourceLabel(evidence.sourceType ?? "source")} evidence.`);
  }
  for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
    const viewName = mapViews.find((view) => view.id === layoutUpdate.mapViewId)?.name ?? layoutUpdate.mapViewId ?? "map view";
    const count = layoutUpdate.items?.length ?? 0;
    currentMap.push(`${viewName} keeps its current layout.`);
    ifApproved.push(`Move ${count} map card${count === 1 ? "" : "s"} in ${viewName}.`);
    updates.push(`Move ${count} map card${count === 1 ? "" : "s"}.`);
  }
  if (currentMap.length === 0 && ifApproved.length === 0) {
    currentMap.push("No visible map change is included.");
    ifApproved.push("Nothing changes on approval.");
  }
  if (adds.length + connects.length + updates.length > 0) {
    needsApproval.push("A human must approve this before it changes company truth.");
  }

  const addedTitles = (diff.objects ?? [])
    .map((object) => object.title)
    .filter((title): title is string => typeof title === "string" && title.trim().length > 0)
    .map((title) => humanDiffTitle(title))
    .slice(0, 2);
  const firstExistingTarget = (diff.relationships ?? [])
    .map((relationship) => relationship.targetObjectId ? objectTitleFromId(objects, relationship.targetObjectId) : null)
    .find((title): title is string => Boolean(title));
  const topic = firstExistingTarget ?? addedTitles[0] ?? "the selected map area";

  return {
    summary: adds.length || connects.length || updates.length
      ? `This proposes clarifying ${topic}${addedTitles.length > 0 ? ` by adding ${addedTitles.join(" and ")}` : ""}${connects.length > 0 ? " and connecting the follow-up work" : ""}.`
      : "This proposal is waiting for human review.",
    currentMap: currentMap.slice(0, 6),
    ifApproved: ifApproved.slice(0, 6),
    groups: {
      adds: adds.slice(0, 5),
      connects: connects.slice(0, 5),
      updates: updates.slice(0, 5),
      needsApproval,
    },
  };
}

export default function ContextMapClient({
  workspaceId,
  data,
  includeStale = false,
  mapAiEnabled = false,
}: {
  workspaceId: string;
  data: ContextMapClientData;
  includeStale?: boolean;
  mapAiEnabled?: boolean;
}) {
  const initialSelectedObjectId = data.objects.find((object) => isCanvasObject(object, data.mapView))?.id ?? null;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>(initialSelectedObjectId ? [initialSelectedObjectId] : []);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(initialSelectedObjectId);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
  const [regionContext, setRegionContext] = useState<RegionContext | null>(null);
  const [regionContextStatus, setRegionContextStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URL(window.location.href).searchParams.get("fullscreen") === "1";
  });
  const [showFilters, setShowFilters] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [inspectorDock, setInspectorDock] = useState<InspectorDock>(storedInspectorDock);
  const [inspectorWidth, setInspectorWidth] = useState(storedInspectorWidth);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [expandedDiffId, setExpandedDiffId] = useState<string | null>(data.proposedDiffs[0]?.id ?? null);
  const [editingDiffId, setEditingDiffId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editDiffJson, setEditDiffJson] = useState("");
  const [proposedDiffs, setProposedDiffs] = useState<ContextGraphProposedDiff[]>(data.proposedDiffs);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<ContextMapFlowNode, ContextMapFlowEdge> | null>(null);
  const [addPaletteOpen, setAddPaletteOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMapMenuState | null>(null);
  const [cardDraft, setCardDraft] = useState<ContextMapCardDraft | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ContextMapConnectionDraft | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<ContextMapEdgeDraft | null>(null);
  const [manualConnectSourceId, setManualConnectSourceId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isMasterView = data.mapView.createdByUserId === null;
  const currentViewIsEditable = !isMasterView || data.permissions.canUpdateMasterView;
  const layoutSaveLabel = isMasterView
    ? data.permissions.canUpdateMasterView ? "Update master" : "Request master update"
    : "Save view";

  const baseObjectById = useMemo(() => new Map(data.objects.map((object) => [object.id, object])), [data.objects]);
  const baseRelationshipById = useMemo(() => new Map(data.relationships.map((relationship) => [relationship.id, relationship])), [data.relationships]);
  const pendingPreview = useMemo(
    () => buildPendingMapPreview(proposedDiffs, data.mapView, baseObjectById, baseRelationshipById),
    [baseObjectById, baseRelationshipById, data.mapView, proposedDiffs],
  );
  const allObjects = useMemo(() => [...data.objects, ...pendingPreview.objects], [data.objects, pendingPreview.objects]);
  const allRelationships = useMemo(() => [...data.relationships, ...pendingPreview.relationships], [data.relationships, pendingPreview.relationships]);
  const allLayoutItems = useMemo(() => [...data.layoutItems, ...pendingPreview.layoutItems], [data.layoutItems, pendingPreview.layoutItems]);
  const layoutByObjectId = useMemo(() => new Map(allLayoutItems.map((item) => [item.objectId, item])), [allLayoutItems]);
  const objectById = useMemo(() => new Map(allObjects.map((object) => [object.id, object])), [allObjects]);
  const relationshipById = useMemo(() => new Map(allRelationships.map((relationship) => [relationship.id, relationship])), [allRelationships]);
  const canvasObjects = useMemo(() => allObjects.filter((object) => isCanvasObject(object, data.mapView)), [allObjects, data.mapView]);
  const objectTypes = useMemo(() => [...new Set(canvasObjects.map((object) => object.objectType))].sort(), [canvasObjects]);

  const filteredObjects = useMemo(() => canvasObjects.filter((object) => {
    if (typeFilter !== "all" && object.objectType !== typeFilter) return false;
    return shouldShowStatus(object.status, statusFilter);
  }), [canvasObjects, statusFilter, typeFilter]);
  const visibleObjectIds = useMemo(() => new Set(filteredObjects.map((object) => object.id)), [filteredObjects]);

  const initialNodes = useMemo<ContextMapFlowNode[]>(() => filteredObjects.map((object, index) => {
    const layout = layoutByObjectId.get(object.id);
    const position = layout ? { x: layout.x, y: layout.y } : positionForIndex(index);
    const colors = NODE_COLORS[object.objectType] ?? { border: "#64748b", background: "#f8fafc", accent: "#475569" };
    const workState = propertyText(object.properties, "workState");
    const pathStage = propertyText(object.properties, "pathStage");
    const staffingState = propertyText(object.properties, "staffingState");
    return {
      id: object.id,
      type: "contextMapNode",
      position,
      data: {
        object,
        colors,
        variant: cardVariantForObject(object),
        preview: isPreviewObject(object),
        connectable: !isPreviewObject(object),
        workState,
        pathStage,
        staffingState,
        viewType: data.mapView.viewType,
      },
      initialWidth: CONTEXT_MAP_NODE_WIDTH,
      initialHeight: CONTEXT_MAP_NODE_HEIGHT,
      style: {
        width: CONTEXT_MAP_NODE_WIDTH,
        border: 0,
        padding: 0,
        background: "transparent",
        boxShadow: "none",
      },
    };
  }), [data.mapView.viewType, filteredObjects, layoutByObjectId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ContextMapFlowNode>(initialNodes);
  const nodeRectsById = useMemo(() => new Map(nodes.map((node) => [node.id, nodeRectFromFlowNode(node)])), [nodes]);

  // Routing rects are frozen while a node is dragged so the whole edge set is
  // not re-routed on every drag frame; connected edges follow live endpoints
  // from React Flow and everything re-routes once on drop.
  const [isDraggingNodes, setIsDraggingNodes] = useState(false);
  const [routingRects, setRoutingRects] = useState<Map<string, NodeRect>>(
    () => new Map(initialNodes.map((node) => [node.id, nodeRectFromFlowNode(node)])),
  );
  useEffect(() => {
    if (isDraggingNodes) return;
    setRoutingRects(nodeRectsById);
  }, [isDraggingNodes, nodeRectsById]);
  const routingObstacles = useMemo(() => [...routingRects.values()], [routingRects]);

  const routedEdges = useMemo<ContextMapFlowEdge[]>(() => allRelationships.flatMap((relationship) => {
    const visual = visualRelationshipEndpoints(relationship);
    if (
      !visibleObjectIds.has(visual.sourceObjectId)
      || !visibleObjectIds.has(visual.targetObjectId)
      || !shouldShowStatus(relationship.status, statusFilter)
    ) {
      return [];
    }
    const sourceRect = routingRects.get(visual.sourceObjectId);
    const targetRect = routingRects.get(visual.targetObjectId);
    if (!sourceRect || !targetRect) return [];
    const sourceSide = nearestSourceSide(sourceRect, targetRect);
    const targetSide = oppositeSide(sourceSide);
    const visualStyle = relationshipVisualStyle(relationship);
    const stroke = visualStyle.stroke;
    const preview = isPreviewId(relationship.id);
    return [{
      id: relationship.id,
      source: visual.sourceObjectId,
      target: visual.targetObjectId,
      sourceHandle: handleId("source", sourceSide),
      targetHandle: handleId("target", targetSide),
      type: "contextMapRouted",
      animated: relationship.status === "proposed" || preview,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        label: visual.label,
        stroke,
        strokeWidth: visualStyle.strokeWidth,
        strokeDasharray: visualStyle.strokeDasharray,
        preview,
        relationshipType: relationship.relationshipType,
        sourceSide,
        targetSide,
        obstacles: scopeObstaclesForEdge(sourceRect, targetRect, routingObstacles),
      },
      className: [
        "context-map-flow-edge",
        `context-map-flow-edge--${relationship.relationshipType}`,
        preview ? "context-map-flow-edge--preview" : "",
      ].filter(Boolean).join(" "),
      style: {
        stroke,
        strokeWidth: visualStyle.strokeWidth,
        strokeDasharray: visualStyle.strokeDasharray,
      },
    }];
  }), [allRelationships, routingObstacles, routingRects, statusFilter, visibleObjectIds]);

  const [edges, setEdges, onEdgesChange] = useEdgesState<ContextMapFlowEdge>(routedEdges);

  useEffect(() => {
    const updateLayout = () => {
      const compact = window.innerWidth < 920;
      setIsCompactLayout(compact);
      setInspectorDock(compact ? "bottom" : storedInspectorDock());
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || isCompactLayout) return;
    window.localStorage.setItem(INSPECTOR_DOCK_STORAGE_KEY, inspectorDock);
  }, [inspectorDock, isCompactLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

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
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (isFullscreen) url.searchParams.set("fullscreen", "1");
    else url.searchParams.delete("fullscreen");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [isFullscreen]);

  useEffect(() => {
    setNodes(initialNodes);
    setLayoutDirty(false);
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(routedEdges);
  }, [routedEdges, setEdges]);

  useEffect(() => {
    setProposedDiffs(data.proposedDiffs);
    setExpandedDiffId((current) => current ?? data.proposedDiffs[0]?.id ?? null);
  }, [data.proposedDiffs]);

  const selectedObject = selectedObjectId ? objectById.get(selectedObjectId) ?? null : null;
  const selectedRelationship = selectedRelationshipId ? relationshipById.get(selectedRelationshipId) ?? null : null;
  const selectedRegionIds = useMemo(() => {
    const realSelectedObjectIds = selectedObjectIds.filter((id) => !isPreviewId(id));
    if (realSelectedObjectIds.length > 0) return realSelectedObjectIds;
    if (selectedRelationship && !isPreviewId(selectedRelationship.id)) return [selectedRelationship.sourceObjectId, selectedRelationship.targetObjectId].filter((id) => !isPreviewId(id));
    if (selectedObjectId && !isPreviewId(selectedObjectId)) return [selectedObjectId];
    return [];
  }, [selectedObjectId, selectedObjectIds, selectedRelationship]);
  const selectedRegionKey = selectedRegionIds.join("|");
  const selectedRelationships = selectedObject
    ? allRelationships.filter((relationship) => relationship.sourceObjectId === selectedObject.id || relationship.targetObjectId === selectedObject.id)
    : [];
  const selectedDetailEntries = selectedObject
    ? selectedRelationships
      .map((relationship) => {
        const otherId = relationship.sourceObjectId === selectedObject.id ? relationship.targetObjectId : relationship.sourceObjectId;
        const object = objectById.get(otherId);
        return object && isDetailObject(object, data.mapView) ? { object, relationship } : null;
      })
      .filter((entry): entry is { object: ContextGraphObject; relationship: ContextGraphRelationship } => Boolean(entry))
    : [];
  const structuralRelationships = selectedRelationships.filter((relationship) => {
    const source = objectById.get(relationship.sourceObjectId);
    const target = objectById.get(relationship.targetObjectId);
    return !isDetailObject(source, data.mapView) && !isDetailObject(target, data.mapView);
  });
  const selectedRiskDetails = selectedDetailEntries.filter((entry) => entry.object.objectType === "Risk" || entry.object.objectType === "Question");
  const selectedMetricDetails = selectedDetailEntries.filter((entry) => entry.object.objectType === "Metric");
  const selectedAssumptionDetails = selectedDetailEntries.filter((entry) => entry.object.objectType === "Hypothesis");
  const selectedAccountabilities = selectedObject ? propertyStringArray(selectedObject.properties, "accountabilities") : [];
  const selectedControls = selectedObject ? propertyStringArray(selectedObject.properties, "governanceControls") : [];
  const selectedAllowedActions = selectedObject ? propertyStringArray(selectedObject.properties, "allowedActions") : [];
  const selectedOrgKind = selectedObject ? propertyText(selectedObject.properties, "orgKind") : null;
  const selectedDataFlow = selectedObject ? propertyText(selectedObject.properties, "dataFlow") : null;
  const selectedApprovalRule = selectedObject ? propertyText(selectedObject.properties, "approvalRule") : null;
  const selectedNextAction = selectedObject ? propertyText(selectedObject.properties, "nextAction") : null;
  const selectedPathStage = selectedObject ? propertyText(selectedObject.properties, "pathStage") : null;
  const selectedWorkState = selectedObject ? propertyText(selectedObject.properties, "workState") : null;
  const selectedStaffingState = selectedObject ? propertyText(selectedObject.properties, "staffingState") : null;
  const selectedAgentHref = selectedObject?.sourceEntityType === "AgentIdentity" && selectedObject.sourceEntityId
    ? `/workspaces/${workspaceId}/agents/${selectedObject.sourceEntityId}`
    : null;
  const ownerRelationships = selectedObject
    ? structuralRelationships.filter((relationship) => ["owns", "assigned_to", "needs_approval_from"].includes(relationship.relationshipType))
    : [];
  const dependencyRelationships = selectedObject
    ? structuralRelationships.filter((relationship) => ["depends_on", "part_of", "member_of", "reports_to", "uses", "input_to", "output_of"].includes(relationship.relationshipType))
    : [];
  const blockerRelationships = selectedObject
    ? structuralRelationships.filter((relationship) => ["blocks", "contradicts"].includes(relationship.relationshipType))
    : [];
  const supportingRelationships = selectedObject
    ? structuralRelationships.filter((relationship) => ["supports", "created_in", "decided_in", "has_evidence"].includes(relationship.relationshipType))
    : [];

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
    return nodes
      .filter((node) => !isPreviewId(node.id))
      .map((node) => ({
        objectId: node.id,
        x: node.position.x,
        y: node.position.y,
        width: CONTEXT_MAP_NODE_WIDTH,
        height: CONTEXT_MAP_NODE_HEIGHT,
      }));
  }

  function fitMap() {
    flowInstance?.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 220 });
  }

  function scheduleFit() {
    const delays = [80, 240, 520];
    for (const delay of delays) {
      window.setTimeout(() => {
        flowInstance?.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 220 });
      }, delay);
    }
  }

  useEffect(() => {
    if (!flowInstance || nodes.length === 0) return;
    scheduleFit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowInstance, data.mapView.id, isFullscreen, statusFilter, typeFilter, includeStale, nodes.length, inspectorDock]);

  function resetLocalLayout() {
    setNodes(initialNodes);
    setLayoutDirty(false);
    window.requestAnimationFrame(scheduleFit);
  }

  function navigateToView(viewId: string) {
    window.location.href = mapViewUrl(viewId, includeStale, isFullscreen);
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
          text: result.mode === "proposed" ? "Created a map update request for admin review." : "Saved the current map layout.",
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
        window.location.href = mapViewUrl(mapView.id, includeStale, isFullscreen);
      } catch {
        setMessage({ tone: "error", text: "Could not save a personal map view." });
      }
    });
  }

  function applyDiff(proposedDiffId: string) {
    startTransition(async () => {
      try {
        await applyContextGraphProposedDiffAction({ workspaceId, proposedDiffId });
        setProposedDiffs((current) => current.filter((diff) => diff.id !== proposedDiffId));
        setMessage({ tone: "info", text: "Applied the proposed map change." });
      } catch {
        setMessage({ tone: "error", text: "You do not have permission to apply this proposed change." });
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
        setMessage({ tone: "info", text: status === "approved" ? "Approved the proposed change." : "Rejected the proposed change." });
      } catch {
        setMessage({ tone: "error", text: "Could not review this proposed change." });
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
        setMessage({ tone: "info", text: "Updated the proposed change." });
      } catch {
        setMessage({ tone: "error", text: "Could not update this proposed change." });
      }
    });
  }

  function buildChatPageContext(objectIds: string[] = selectedRegionIds): WorkspaceChatPageContext {
    const selectedIds = [...new Set(objectIds)].slice(0, 12);
    const selectedObjects = selectedIds
      .map((id) => objectById.get(id))
      .filter((object): object is ContextGraphObject => Boolean(object))
      .slice(0, 12)
      .map((object) => ({
        id: object.id,
        title: object.title,
        objectType: object.objectType,
        status: object.status,
      }));
    return {
      surface: "context-map",
      route: `${window.location.pathname}${window.location.search}`,
      workspaceId,
      mapView: {
        id: data.mapView.id,
        name: data.mapView.name,
        viewType: data.mapView.viewType,
      },
      includeStale,
      selectedObjectIds: selectedIds,
      selectedObjects,
      selectedRelationship: selectedRelationship
        ? {
            id: selectedRelationship.id,
            sourceObjectId: selectedRelationship.sourceObjectId,
            targetObjectId: selectedRelationship.targetObjectId,
            relationshipType: selectedRelationship.relationshipType,
            status: selectedRelationship.status,
          }
        : null,
    };
  }

  function openMapChat(objectIds: string[] = selectedRegionIds) {
    openWorkspaceChat({ pageContext: buildChatPageContext(objectIds) });
  }

  function closeMapMenus() {
    setAddPaletteOpen(false);
    setContextMenu(null);
  }

  function flowPositionFromClient(clientX: number, clientY: number) {
    if (flowInstance) {
      return flowInstance.screenToFlowPosition({ x: clientX, y: clientY });
    }
    const bounds = canvasRef.current?.getBoundingClientRect();
    return bounds ? { x: clientX - bounds.left, y: clientY - bounds.top } : { x: 0, y: 0 };
  }

  function flowCenterPosition() {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 120, y: 120 };
    return flowPositionFromClient(bounds.left + bounds.width / 2, bounds.top + Math.min(bounds.height / 2, 360));
  }

  function nextPositionFromNode(nodeId: string, offsetY = 0) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return flowCenterPosition();
    return {
      x: node.position.x + CONTEXT_MAP_NODE_WIDTH + 90,
      y: node.position.y + offsetY,
    };
  }

  function openCardDraft(
    cardKind: ContextMapManualCardKind,
    position: { x: number; y: number },
    sourceObjectId?: string | null,
    relationIntent?: ContextMapManualRelationIntent | null,
  ) {
    closeMapMenus();
    setCardDraft({ cardKind, position, sourceObjectId, relationIntent, title: "" });
  }

  function submitCardDraft() {
    if (!cardDraft) return;
    const title = cardDraft.title.trim();
    if (!title) {
      setMessage({ tone: "error", text: "Add a short card title first." });
      return;
    }
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await createContextMapManualEditProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          includeStale,
          edit: {
            action: "add-card",
            cardKind: cardDraft.cardKind,
            title,
            position: cardDraft.position,
            sourceObjectId: cardDraft.sourceObjectId,
            relationIntent: cardDraft.relationIntent,
          },
        });
        const proposedDiff = normalizeManualEditProposal(result);
        setProposedDiffs((current) => [proposedDiff, ...current.filter((diff) => diff.id !== proposedDiff.id)]);
        setExpandedDiffId(proposedDiff.id);
        setCardDraft(null);
        setMessage({ tone: "info", text: "Created a proposed card. It is shown on the map until review." });
      } catch {
        setMessage({ tone: "error", text: "Could not propose this card." });
      }
    });
  }

  function openConnectionDraft(sourceObjectId: string, targetObjectId: string) {
    if (sourceObjectId === targetObjectId || isPreviewId(sourceObjectId) || isPreviewId(targetObjectId)) return;
    closeMapMenus();
    setManualConnectSourceId(null);
    setConnectionDraft({ sourceObjectId, targetObjectId });
  }

  function submitConnectionDraft(intent: ContextMapManualRelationIntent) {
    if (!connectionDraft) return;
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await createContextMapManualEditProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          includeStale,
          edit: {
            action: "add-connection",
            sourceObjectId: connectionDraft.sourceObjectId,
            targetObjectId: connectionDraft.targetObjectId,
            relationIntent: intent,
          },
        });
        const proposedDiff = normalizeManualEditProposal(result);
        setProposedDiffs((current) => [proposedDiff, ...current.filter((diff) => diff.id !== proposedDiff.id)]);
        setExpandedDiffId(proposedDiff.id);
        setConnectionDraft(null);
        setMessage({ tone: "info", text: `Created a proposed ${relationIntentLabel(intent).toLowerCase()} connection.` });
      } catch {
        setMessage({ tone: "error", text: "Could not propose this connection." });
      }
    });
  }

  function submitEdgeUpdate(intent: ContextMapManualRelationIntent) {
    if (!edgeDraft) return;
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await createContextMapManualEditProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          includeStale,
          edit: {
            action: "update-connection",
            relationshipId: edgeDraft.relationshipId,
            relationIntent: intent,
          },
        });
        const proposedDiff = normalizeManualEditProposal(result);
        setProposedDiffs((current) => [proposedDiff, ...current.filter((diff) => diff.id !== proposedDiff.id)]);
        setExpandedDiffId(proposedDiff.id);
        setEdgeDraft(null);
        setMessage({ tone: "info", text: `Created a proposed connection change to ${relationIntentLabel(intent).toLowerCase()}.` });
      } catch {
        setMessage({ tone: "error", text: "Could not propose this connection change." });
      }
    });
  }

  function archiveConnection(relationshipId: string) {
    closeMapMenus();
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await createContextMapManualEditProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          includeStale,
          edit: { action: "update-connection", relationshipId, archive: true },
        });
        const proposedDiff = normalizeManualEditProposal(result);
        setProposedDiffs((current) => [proposedDiff, ...current.filter((diff) => diff.id !== proposedDiff.id)]);
        setExpandedDiffId(proposedDiff.id);
        setMessage({ tone: "info", text: "Created a proposed archive for this connection." });
      } catch {
        setMessage({ tone: "error", text: "Could not propose archiving this connection." });
      }
    });
  }

  function archiveCard(objectId: string) {
    closeMapMenus();
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await createContextMapManualEditProposalAction({
          workspaceId,
          mapViewId: data.mapView.id,
          includeStale,
          edit: { action: "archive-card", objectId },
        });
        const proposedDiff = normalizeManualEditProposal(result);
        setProposedDiffs((current) => [proposedDiff, ...current.filter((diff) => diff.id !== proposedDiff.id)]);
        setExpandedDiffId(proposedDiff.id);
        setMessage({ tone: "info", text: "Created a proposed archive for this card." });
      } catch {
        setMessage({ tone: "error", text: "Could not propose archiving this card." });
      }
    });
  }

  function handleConnect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    openConnectionDraft(connection.source, connection.target);
  }

  function startInspectorResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (inspectorDock !== "right" || isCompactLayout) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      setInspectorWidth(clampInspectorWidth(startWidth + startX - moveEvent.clientX));
    };
    const onPointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.requestAnimationFrame(scheduleFit);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  const shellClass = [
    "context-map-shell",
    isFullscreen ? "context-map-shell--fullscreen" : "",
    inspectorDock === "bottom" ? "context-map-shell--bottom-inspector" : "",
  ].filter(Boolean).join(" ");
  const shellStyle = {
    "--context-map-inspector-width": `${inspectorWidth}px`,
  } as CSSProperties;

  return (
    <section className={shellClass} style={shellStyle} data-context-map-shell>
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
            <span>{viewScopeLabel(data.mapView)} view for reviewing company context</span>
          </div>
        </div>

        <div className="context-map-toolbar-actions">
          <div className="context-map-add-wrapper">
            <button
              className="secondary small"
              type="button"
              onClick={() => {
                setContextMenu(null);
                setAddPaletteOpen((value) => !value);
              }}
              title="Add a proposed map card"
            >
              + Add
            </button>
            {addPaletteOpen && (
              <div className="context-map-palette" role="menu">
                <button type="button" onClick={() => openCardDraft("standard", flowCenterPosition())}>
                  Standard card
                </button>
                <button type="button" onClick={() => openCardDraft("alert", flowCenterPosition())}>
                  Alert card
                </button>
              </div>
            )}
          </div>
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
          {mapAiEnabled && (
            <button className="secondary small" type="button" onClick={() => openMapChat()} title="Open chat with this map context">
              <MessageSquare size={14} aria-hidden="true" /> Open chat
            </button>
          )}
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
        <div
          className="context-map-canvas"
          ref={canvasRef}
          onContextMenu={(event) => {
            event.preventDefault();
            const target = event.target instanceof Element ? event.target : null;
            const nodeElement = target?.closest(".react-flow__node");
            const edgeLabelElement = target?.closest("[data-edge-id]");
            const edgeElement = target?.closest(".react-flow__edge");
            setAddPaletteOpen(false);
            if (nodeElement) {
              const nodeId = nodeElement.getAttribute("data-id");
              if (nodeId && !isPreviewId(nodeId)) {
                setContextMenu({ kind: "node", x: event.clientX, y: event.clientY, nodeId });
              }
              return;
            }
            if (edgeLabelElement) {
              const edgeId = edgeLabelElement.getAttribute("data-edge-id");
              if (edgeId && !isPreviewId(edgeId)) {
                setContextMenu({ kind: "edge", x: event.clientX, y: event.clientY, edgeId });
              }
              return;
            }
            if (edgeElement) {
              const edgeId = edgeElement.getAttribute("data-id");
              if (edgeId && !isPreviewId(edgeId)) {
                setContextMenu({ kind: "edge", x: event.clientX, y: event.clientY, edgeId });
              }
              return;
            }
            setContextMenu({
              kind: "pane",
              x: event.clientX,
              y: event.clientY,
              position: flowPositionFromClient(event.clientX, event.clientY),
            });
          }}
        >
          {nodes.length === 0 ? (
            <div className="context-map-empty">
              <CircleHelp size={32} aria-hidden="true" />
              <h3>{data.guidance.emptyTitle}</h3>
              <p>{data.guidance.emptyDescription}</p>
            </div>
          ) : (
            <ReactFlow<ContextMapFlowNode, ContextMapFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={CONTEXT_MAP_NODE_TYPES}
              edgeTypes={CONTEXT_MAP_EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={setFlowInstance}
              onConnect={handleConnect}
              onPaneClick={() => {
                closeMapMenus();
                if (manualConnectSourceId) {
                  setManualConnectSourceId(null);
                  setMessage(null);
                }
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                setAddPaletteOpen(false);
                setContextMenu({
                  kind: "pane",
                  x: event.clientX,
                  y: event.clientY,
                  position: flowPositionFromClient(event.clientX, event.clientY),
                });
              }}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                if (isPreviewId(node.id)) return;
                setAddPaletteOpen(false);
                setContextMenu({ kind: "node", x: event.clientX, y: event.clientY, nodeId: node.id });
              }}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                if (isPreviewId(edge.id)) return;
                setAddPaletteOpen(false);
                setContextMenu({ kind: "edge", x: event.clientX, y: event.clientY, edgeId: edge.id });
              }}
              onNodeClick={(_, node) => {
                if (manualConnectSourceId && manualConnectSourceId !== node.id && !isPreviewId(node.id)) {
                  openConnectionDraft(manualConnectSourceId, node.id);
                  return;
                }
                closeMapMenus();
                setSelectedRelationshipId(null);
                setSelectedObjectId(node.id);
                setSelectedObjectIds((current) => sameIds(current, [node.id]) ? current : [node.id]);
              }}
              onEdgeClick={(_, edge) => {
                closeMapMenus();
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
              onNodeDragStart={() => setIsDraggingNodes(true)}
              onNodeDragStop={() => {
                setIsDraggingNodes(false);
                setLayoutDirty(true);
              }}
              onSelectionDragStart={() => setIsDraggingNodes(true)}
              onSelectionDragStop={() => {
                setIsDraggingNodes(false);
                setLayoutDirty(true);
              }}
              nodesConnectable
              connectionMode={ConnectionMode.Loose}
              connectionRadius={28}
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

        {manualConnectSourceId && (
          <div className="context-map-connect-hint" role="status">
            Choose another card for the new connection.
          </div>
        )}

        {contextMenu && (
          <div
            className="context-map-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.kind === "pane" && (
              <>
                <button type="button" onClick={() => openCardDraft("standard", contextMenu.position)}>
                  Add standard card here
                </button>
                <button type="button" onClick={() => openCardDraft("alert", contextMenu.position)}>
                  Add alert card here
                </button>
              </>
            )}
            {contextMenu.kind === "node" && (
              <>
                <button type="button" onClick={() => openCardDraft("standard", nextPositionFromNode(contextMenu.nodeId), contextMenu.nodeId, "enables")}>
                  Add next card
                </button>
                <button type="button" onClick={() => openCardDraft("alert", nextPositionFromNode(contextMenu.nodeId, 48), contextMenu.nodeId, "blocks")}>
                  Add alert/blocker
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setManualConnectSourceId(contextMenu.nodeId);
                    setContextMenu(null);
                    setMessage({ tone: "info", text: "Choose another card to connect." });
                  }}
                >
                  Connect from this card
                </button>
                <button type="button" className="context-map-menu-danger" onClick={() => archiveCard(contextMenu.nodeId)}>
                  Archive
                </button>
              </>
            )}
            {contextMenu.kind === "edge" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEdgeDraft({ relationshipId: contextMenu.edgeId });
                    setContextMenu(null);
                  }}
                >
                  Change connection type
                </button>
                <button type="button" className="context-map-menu-danger" onClick={() => archiveConnection(contextMenu.edgeId)}>
                  Archive connection
                </button>
              </>
            )}
          </div>
        )}

        {cardDraft && (
          <div className="context-map-floating-panel" role="dialog" aria-modal="false">
            <div>
              <span className="context-map-eyebrow">{cardDraft.cardKind === "alert" ? "Alert card" : "Standard card"}</span>
              <strong>{cardDraft.sourceObjectId ? "Add connected card" : "Add card"}</strong>
            </div>
            <label>
              <span>Title</span>
              <input
                autoFocus
                value={cardDraft.title}
                onChange={(event) => setCardDraft((current) => current ? { ...current, title: event.target.value } : current)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCardDraft();
                  }
                }}
                placeholder={cardDraft.cardKind === "alert" ? "Unresolved risk or blocker" : "Next step or context item"}
              />
            </label>
            <div className="context-map-dialog-actions">
              <button className="secondary small" type="button" onClick={() => setCardDraft(null)}>
                Cancel
              </button>
              <button className="primary small" type="button" onClick={submitCardDraft} disabled={isPending}>
                Propose
              </button>
            </div>
          </div>
        )}

        {connectionDraft && (
          <div className="context-map-floating-panel" role="dialog" aria-modal="false">
            <div>
              <span className="context-map-eyebrow">Connection</span>
              <strong>Choose relationship</strong>
            </div>
            <div className="context-map-relation-grid">
              {RELATION_INTENT_OPTIONS.map((option) => (
                <button key={option.intent} type="button" onClick={() => submitConnectionDraft(option.intent)} disabled={isPending}>
                  {option.label}
                </button>
              ))}
            </div>
            <div className="context-map-dialog-actions">
              <button className="secondary small" type="button" onClick={() => setConnectionDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {edgeDraft && (
          <div className="context-map-floating-panel" role="dialog" aria-modal="false">
            <div>
              <span className="context-map-eyebrow">Connection</span>
              <strong>Change relationship</strong>
            </div>
            <div className="context-map-relation-grid">
              {RELATION_INTENT_OPTIONS.map((option) => (
                <button key={option.intent} type="button" onClick={() => submitEdgeUpdate(option.intent)} disabled={isPending}>
                  {option.label}
                </button>
              ))}
            </div>
            <div className="context-map-dialog-actions">
              <button className="secondary small" type="button" onClick={() => setEdgeDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <aside className={`context-map-inspector context-map-inspector--${inspectorDock}`}>
          {inspectorDock === "right" && !isCompactLayout && (
            <button
              aria-label="Resize inspector"
              className="context-map-inspector-resize"
              type="button"
              onPointerDown={startInspectorResize}
            />
          )}
          <div className="context-map-inspector-header">
            <div>
              <span className="context-map-eyebrow">Inspector</span>
              <strong>{selectedRelationship ? "Connection" : "Selected item"}</strong>
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
              <>
                <section className="context-map-inspector-section">
                  <h2>What this connection means</h2>
                  <strong className="context-map-selection-title">
                    {humanRelationshipSentence(selectedRelationship, selectedObjectId, objectById)}
                  </strong>
                  <div className="context-map-pill-row">
                    <span className={`context-map-status context-map-status--${statusClass(selectedRelationship.status)}`}>{humanStatusLabel(selectedRelationship.status)}</span>
                    {selectedRelationship.lastVerifiedAt && <span className="tag neutral">Verified {stableDateLabel(selectedRelationship.lastVerifiedAt)}</span>}
                  </div>
                </section>

                <section className="context-map-inspector-section">
                  <h2>Evidence</h2>
                  {selectedRelationship.evidenceRefs.length ? (
                    <div className="context-map-evidence-list">
                      {selectedRelationship.evidenceRefs.slice(0, 5).map((evidence) => (
                        <div key={evidence.id} className="context-map-evidence-item">
                          <div className="nr-item-meta">{evidenceSourceLabel(evidence.sourceType)}</div>
                          <p>{evidence.quote ?? "Evidence is attached, but no excerpt is available."}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No supporting evidence is attached yet.</p>
                  )}
                </section>

                {mapAiEnabled && (
                  <section className="context-map-inspector-section">
                    <h2>Changes</h2>
                    <button className="secondary small" type="button" onClick={() => openMapChat(selectedRegionIds)} disabled={selectedRegionIds.length === 0}>
                      <MessageSquare size={14} aria-hidden="true" /> Open chat
                    </button>
                  </section>
                )}

                <details className="context-map-technical-details">
                  <summary>Technical details</summary>
                  <dl className="context-map-definition-list">
                    <div><dt>Type</dt><dd>{selectedRelationship.relationshipType}</dd></div>
                    <div><dt>Status</dt><dd>{selectedRelationship.status}</dd></div>
                    <div><dt>Confidence</dt><dd>{confidenceLabel(selectedRelationship.confidence)}</dd></div>
                    <div><dt>Source</dt><dd>{sourceLabel(selectedRelationship)}</dd></div>
                    <div><dt>ID</dt><dd>{selectedRelationship.id}</dd></div>
                  </dl>
                </details>
              </>
            ) : selectedObject ? (
              <>
                <section className="context-map-inspector-section">
                  <h2>{data.mapView.viewType === "agent" && selectedObject.objectType === "Agent" ? "What this agent does" : "What this is"}</h2>
                  <div className="context-map-selection-stack">
                    <div>
                      <div className="nr-item-meta">{humanObjectTypeLabel(selectedObject.objectType, data.mapView.viewType)}</div>
                      <strong className="context-map-selection-title">{selectedObject.title}</strong>
                    </div>
                    {selectedObject.summary && <p>{selectedObject.summary.slice(0, 520)}</p>}
                    {selectedDataFlow && <p>{selectedDataFlow}</p>}
                    <div className="context-map-pill-row">
                      <span className={`context-map-status context-map-status--${statusClass(selectedObject.status)}`}>{humanStatusLabel(selectedObject.status)}</span>
                      {selectedPathStage && <span className="tag neutral">{selectedPathStage}</span>}
                      {selectedOrgKind && <span className="tag neutral">{selectedOrgKind}</span>}
                      {selectedWorkState && <span className="tag neutral">{titleizeMachineValue(selectedWorkState)}</span>}
                      {selectedStaffingState && <span className="tag neutral">{titleizeMachineValue(selectedStaffingState)}</span>}
                    </div>
                  </div>
                </section>

                <section className="context-map-inspector-section">
                  <h2>Current state</h2>
                  <p>
                    {selectedWorkState
                      ? `This is ${titleizeMachineValue(selectedWorkState).toLowerCase()}.`
                      : selectedStaffingState
                        ? `Staffing is ${titleizeMachineValue(selectedStaffingState).toLowerCase()}.`
                        : `This is ${humanStatusLabel(selectedObject.status).toLowerCase()}.`}
                  </p>
                  {selectedApprovalRule && <p className="context-map-next-action">{selectedApprovalRule}</p>}
                </section>

                {data.mapView.viewType === "agent" && selectedObject.objectType === "Agent" ? (
                  <>
                    <section className="context-map-inspector-section">
                      <h2>What it can read or use</h2>
                      {dependencyRelationships.length || supportingRelationships.length ? (
                        <ul className="context-map-human-list">
                          {[...dependencyRelationships, ...supportingRelationships].slice(0, 6).map((relationship) => (
                            <li key={relationship.id}>{humanRelationshipSentence(relationship, selectedObject.id, objectById)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">No input or tool is shown for this agent yet.</p>
                      )}
                    </section>

                    <section className="context-map-inspector-section">
                      <h2>What it can propose</h2>
                      {selectedAllowedActions.length ? (
                        <ul className="context-map-human-list">
                          {selectedAllowedActions.slice(0, 5).map((action) => <li key={action}>{action}</li>)}
                        </ul>
                      ) : (
                        <p className="muted">This map does not list proposal actions yet.</p>
                      )}
                    </section>

                    <section className="context-map-inspector-section">
                      <h2>What needs human approval</h2>
                      {selectedControls.length || selectedApprovalRule ? (
                        <ul className="context-map-human-list">
                          {selectedApprovalRule && <li>{selectedApprovalRule}</li>}
                          {selectedControls.slice(0, 5).map((control) => <li key={control}>{control}</li>)}
                        </ul>
                      ) : (
                        <p className="muted">No approval rule is shown for this agent yet.</p>
                      )}
                      <p className="muted">Last run is available from the agent detail page.</p>
                      {selectedAgentHref && (
                        <a className="secondary small context-map-open-link" href={selectedAgentHref}>
                          Open agent
                        </a>
                      )}
                    </section>
                  </>
                ) : (
                  <>
                    <section className="context-map-inspector-section">
                      <h2>Owner / accountable team</h2>
                      {ownerRelationships.length ? (
                        <ul className="context-map-human-list">
                          {ownerRelationships.slice(0, 5).map((relationship) => (
                            <li key={relationship.id}>{humanRelationshipSentence(relationship, selectedObject.id, objectById)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">No owner is shown on this map yet.</p>
                      )}
                    </section>

                    <section className="context-map-inspector-section">
                      <h2>What it depends on</h2>
                      {dependencyRelationships.length || supportingRelationships.length ? (
                        <ul className="context-map-human-list">
                          {[...dependencyRelationships, ...supportingRelationships].slice(0, 6).map((relationship) => (
                            <li key={relationship.id}>{humanRelationshipSentence(relationship, selectedObject.id, objectById)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">No dependency is shown on this map yet.</p>
                      )}
                    </section>

                    <section className="context-map-inspector-section">
                      <h2>What is blocking it</h2>
                      {blockerRelationships.length ? (
                        <ul className="context-map-human-list">
                          {blockerRelationships.slice(0, 5).map((relationship) => (
                            <li key={relationship.id}>{humanRelationshipSentence(relationship, selectedObject.id, objectById)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">No blocker is shown on this map.</p>
                      )}
                    </section>

                    {selectedRiskDetails.length > 0 && (
                      <section className="context-map-inspector-section">
                        <h2>Risks and questions</h2>
                        <div className="context-map-detail-list">
                          {selectedRiskDetails.slice(0, 6).map(({ object, relationship }) => (
                            <div key={`${relationship.id}:${object.id}`} className="context-map-detail-item context-map-detail-item--risk">
                              <div className="nr-item-meta">{humanObjectTypeLabel(object.objectType)} - {humanRelationshipLabel(relationship.relationshipType)}</div>
                              <strong>{object.title}</strong>
                              {object.summary && <p>{object.summary.slice(0, 280)}</p>}
                              <div className="context-map-pill-row">
                                <span className={`context-map-status context-map-status--${statusClass(object.status)}`}>{humanStatusLabel(object.status)}</span>
                                {propertyText(object.properties, "severity") && <span className="tag neutral">{propertyText(object.properties, "severity")}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {selectedMetricDetails.length > 0 && (
                      <section className="context-map-inspector-section">
                        <h2>Metrics</h2>
                        <div className="context-map-detail-list">
                          {selectedMetricDetails.slice(0, 6).map(({ object, relationship }) => (
                            <div key={`${relationship.id}:${object.id}`} className="context-map-detail-item context-map-detail-item--metric">
                              <div className="nr-item-meta">{humanObjectTypeLabel(object.objectType)}</div>
                              <strong>{object.title}</strong>
                              {object.summary && <p>{object.summary.slice(0, 280)}</p>}
                              {propertyText(object.properties, "value") && <p className="context-map-next-action">{propertyText(object.properties, "value")}</p>}
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {selectedAssumptionDetails.length > 0 && (
                      <section className="context-map-inspector-section">
                        <h2>Assumptions</h2>
                        <div className="context-map-detail-list">
                          {selectedAssumptionDetails.slice(0, 6).map(({ object, relationship }) => (
                            <div key={`${relationship.id}:${object.id}`} className="context-map-detail-item">
                              <div className="nr-item-meta">{humanObjectTypeLabel(object.objectType)}</div>
                              <strong>{object.title}</strong>
                              {object.summary && <p>{object.summary.slice(0, 280)}</p>}
                              {propertyText(object.properties, "testMethod") && <p className="context-map-next-action">{propertyText(object.properties, "testMethod")}</p>}
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </>
                )}

                {mapAiEnabled && (
                  <section className="context-map-inspector-section">
                    <h2>Changes</h2>
                    <button className="secondary small" type="button" onClick={() => openMapChat(selectedRegionIds)} disabled={selectedRegionIds.length === 0}>
                      <MessageSquare size={14} aria-hidden="true" /> Open chat
                    </button>
                  </section>
                )}

                <section className="context-map-inspector-section">
                  <h2>Evidence</h2>
                  {selectedObject.evidenceRefs.length ? (
                    <div className="context-map-evidence-list">
                      {selectedObject.evidenceRefs.slice(0, 5).map((evidence) => (
                        <div key={evidence.id} className="context-map-evidence-item">
                          <div className="nr-item-meta">{evidenceSourceLabel(evidence.sourceType)}</div>
                          <p>{evidence.quote ?? "Evidence is attached, but no excerpt is available."}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No supporting evidence is attached yet.</p>
                  )}
                </section>

                <section className="context-map-inspector-section">
                  <h2>Recommended next step</h2>
                  {regionContextStatus === "loading" ? (
                    <p className="muted" aria-live="polite">Looking for the best next step...</p>
                  ) : regionContextStatus === "error" ? (
                    <p className="form-message form-message-error" role="alert">Could not load recommendations for this selection.</p>
                  ) : selectedNextAction ? (
                    <p className="context-map-next-action">{selectedNextAction}</p>
                  ) : regionContext?.likelyNextActions.length ? (
                    <p className="context-map-next-action">{regionContext.likelyNextActions[0].title}</p>
                  ) : regionContext?.contextGaps.length ? (
                    <p className="context-map-next-action">{regionContext.contextGaps[0].title}</p>
                  ) : (
                    <p className="muted">No recommended action is shown yet.</p>
                  )}
                </section>

                {selectedAccountabilities.length > 0 && (
                  <section className="context-map-inspector-section">
                    <h2>Responsibilities</h2>
                    <ul className="context-map-human-list">
                      {selectedAccountabilities.slice(0, 5).map((accountability) => (
                        <li key={accountability}>{accountability}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <details className="context-map-technical-details">
                  <summary>Technical details</summary>
                  <dl className="context-map-definition-list">
                    <div><dt>Type</dt><dd>{selectedObject.objectType}</dd></div>
                    <div><dt>Status</dt><dd>{selectedObject.status}</dd></div>
                    <div><dt>Confidence</dt><dd>{confidenceLabel(selectedObject.confidence)}</dd></div>
                    <div><dt>Source</dt><dd>{sourceLabel(selectedObject)}</dd></div>
                    <div><dt>ID</dt><dd>{selectedObject.id}</dd></div>
                  </dl>
                  {regionContext && (
                    <div className="context-map-technical-stack">
                      <strong>Agent context</strong>
                      <p>{regionContext.objects.length} objects, {regionContext.relationships.length} relationships, {regionContext.evidenceRefs.length} evidence refs.</p>
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
                    </div>
                  )}
                </details>
              </>
            ) : (
              <section className="context-map-inspector-section">
                <h2>What this is</h2>
                <p className="muted">Select a node or connection to inspect what it means, who owns it, what blocks it, and what can happen next.</p>
              </section>
            )}

            <section className="context-map-inspector-section">
              <h2>Pending changes</h2>
              {proposedDiffs.length ? (
                <div className="context-map-diff-list">
                  {proposedDiffs.map((diff) => {
                    const preview = diffHumanPreview(diff.diffJson, objectById, data.mapViews);
                    const expanded = expandedDiffId === diff.id;
                    const editing = editingDiffId === diff.id;
                    return (
                      <div key={diff.id} className="context-map-diff-item">
                        <div className="context-map-diff-heading">
                          <div>
                            <div className="nr-item-meta">{humanStatusLabel(diff.status)} - {stableDateLabel(diff.createdAt)}</div>
                            <p>{diff.reason ?? preview.summary}</p>
                          </div>
                          <button className="secondary small" type="button" onClick={() => setExpandedDiffId(expanded ? null : diff.id)}>
                            {expanded ? "Hide" : "Review"}
                          </button>
                        </div>
                        <p className="context-map-diff-summary">{preview.summary}</p>
                        <div className="context-map-pill-row">
                          <span className={`context-map-status context-map-status--${diff.status === "approved" ? "approved" : diff.status === "pending" ? "pending" : "neutral"}`}>{humanStatusLabel(diff.status)}</span>
                          <span className="tag neutral">Human review required</span>
                        </div>
                        {expanded && (
                          <div className="context-map-review-stack">
                            <div className="context-map-diff-groups">
                              {preview.groups.adds.length > 0 && (
                                <div>
                                  <strong>Adds</strong>
                                  <ul>{preview.groups.adds.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                              )}
                              {preview.groups.connects.length > 0 && (
                                <div>
                                  <strong>Connects</strong>
                                  <ul>{preview.groups.connects.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                              )}
                              {preview.groups.updates.length > 0 && (
                                <div>
                                  <strong>Updates</strong>
                                  <ul>{preview.groups.updates.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                              )}
                              {preview.groups.needsApproval.length > 0 && (
                                <div>
                                  <strong>Needs approval</strong>
                                  <ul>{preview.groups.needsApproval.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                              )}
                            </div>
                            <div className="context-map-diff-compare">
                              <div>
                                <strong>Current map</strong>
                                <ul>
                                  {preview.currentMap.map((line, index) => <li key={`before-${index}-${line}`}>{line}</li>)}
                                </ul>
                              </div>
                              <div>
                                <strong>If approved</strong>
                                <ul>
                                  {preview.ifApproved.map((line, index) => <li key={`after-${index}-${line}`}>{line}</li>)}
                                </ul>
                              </div>
                            </div>
                            <details className="context-map-technical-details context-map-diff-technical">
                              <summary>Technical details</summary>
                              <p>{diffTechnicalCountLabel(diff.diffJson)}</p>
                              <pre>{JSON.stringify(diffJsonRecord(diff.diffJson), null, 2)}</pre>
                            </details>
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
                <p className="muted">No pending changes.</p>
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
