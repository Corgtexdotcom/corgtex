"use client";

import { useEffect, useRef, useState, useCallback, type CSSProperties, type MouseEvent } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronsDown, Crosshair, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import CircleNode from "./CircleNode";
import ExpandedCircleNode from "./ExpandedCircleNode";
import {
  CIRCLE_SNAP_GRID,
  findNearestFreePosition,
  layoutCircleGraph,
  type GraphBounds,
  type GraphPoint,
} from "./circleLayout";
import {
  collectCircleMembers,
  countAccountabilities,
  type CircleGraphCircle,
} from "./circleGraphHelpers";
import "./circle-graph.css";

const nodeTypes = {
  circleNode: CircleNode,
  expandedCircleNode: ExpandedCircleNode,
};

const DEFAULT_GRAPH_BOUNDS: GraphBounds = { minX: 0, minY: 0, maxX: 1200, maxY: 800, width: 1200, height: 800 };
const DEFAULT_EXTENT: [[number, number], [number, number]] = [[-2000, -2000], [6000, 6000]];

export default function CircleGraph({ treeData }: { treeData: CircleGraphCircle[]; isDemo: boolean }) {
  const t = useTranslations("circles");
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartPositionsRef = useRef<Record<string, GraphPoint>>({});
  const skipNextNodeClickRef = useRef(false);
  const nodesRef = useRef<Node[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [expandedCircleIds, setExpandedCircleIds] = useState<Set<string>>(new Set());
  const [manualPositions, setManualPositions] = useState<Record<string, GraphPoint>>({});
  const [layoutAnchorCircleId, setLayoutAnchorCircleId] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => typeof window !== "undefined" ? window.innerWidth : 1200);
  const [graphBounds, setGraphBounds] = useState<GraphBounds>(DEFAULT_GRAPH_BOUNDS);
  const [nodeExtent, setNodeExtent] = useState<[[number, number], [number, number]]>(DEFAULT_EXTENT);
  const [translateExtent, setTranslateExtent] = useState<[[number, number], [number, number]]>(DEFAULT_EXTENT);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [isCompactViewport, setIsCompactViewport] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 760,
  );
  const isCompactGraph = isCompactViewport || containerWidth < 760;

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    const updateViewportMode = () => setIsCompactViewport(window.innerWidth < 760);
    updateViewportMode();
    window.addEventListener("resize", updateViewportMode);
    return () => window.removeEventListener("resize", updateViewportMode);
  }, []);

  useEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  const flattenTree = useCallback((nodes: CircleGraphCircle[]): CircleGraphCircle[] => {
    let result: CircleGraphCircle[] = [];
    nodes.forEach(node => {
      result.push(node);
      if (node.childCircles && node.childCircles.length > 0) {
        result = result.concat(flattenTree(node.childCircles));
      }
    });
    return result;
  }, []);

  const anchorNodeAtCurrentPosition = useCallback((id: string) => {
    const currentNode = nodesRef.current.find((node) => node.id === id);
    if (!currentNode) return;
    setManualPositions((prev) => {
      if (prev[id]) return prev;
      return { ...prev, [id]: currentNode.position };
    });
    setLayoutAnchorCircleId(id);
  }, []);

  const handleCollapse = useCallback((id: string) => {
    anchorNodeAtCurrentPosition(id);
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelectedCircleId(id);
  }, [anchorNodeAtCurrentPosition]);

  const expandCircle = useCallback((id: string) => {
    anchorNodeAtCurrentPosition(id);
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setSelectedCircleId(id);
  }, [anchorNodeAtCurrentPosition]);

  const toggleCircle = useCallback((id: string) => {
    anchorNodeAtCurrentPosition(id);
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setSelectedCircleId(id);
  }, [anchorNodeAtCurrentPosition]);

  useEffect(() => {
    const flatData = flattenTree(treeData);

    const initialNodes: Node[] = flatData.map((item) => {
      const isExpanded = expandedCircleIds.has(item.id);
      const members = collectCircleMembers(item);
      const accountabilityCount = countAccountabilities(item);
      return {
        id: item.id,
        type: isExpanded ? "expandedCircleNode" : "circleNode",
        position: { x: 0, y: 0 },
        data: {
          circleId: item.id,
          workspaceId: item.workspaceId,
          name: item.name,
          purposeMd: item.purposeMd,
          domainMd: item.domainMd,
          maturityStage: item.maturityStage,
          roleCount: item.roles?.length || 0,
          memberCount: members.length,
          childCircleCount: item.childCircles?.length || 0,
          accountabilityCount,
          members,
          roles: item.roles || [],
          onCollapse: handleCollapse,
          onExpand: expandCircle,
          onToggle: toggleCircle,
        },
      };
    });

    const initialEdges: Edge[] = flatData
      .filter((item): item is CircleGraphCircle & { parentCircleId: string } => Boolean(item.parentCircleId))
      .map((item) => ({
        id: `e-${item.parentCircleId}-${item.id}`,
        source: item.parentCircleId,
        target: item.id,
        type: "smoothstep",
        animated: true,
        style: { stroke: "var(--circle-edge)", strokeWidth: 2 },
      }));

    if (initialNodes.length > 0) {
      const layout = layoutCircleGraph(
        initialNodes,
        initialEdges,
        {
          viewportWidth: containerWidth,
          isCompactViewport: isCompactGraph,
          isFullscreen,
          manualPositions,
          anchorNodeId: layoutAnchorCircleId,
        },
      );
      const layoutedNodes = layout.nodes.map((node) => {
        const isSelected = node.id === selectedCircleId;
        const isExpanded = expandedCircleIds.has(node.id);
        return {
          ...node,
          selected: isSelected,
          zIndex: isSelected ? 30 : isExpanded ? 20 : 1,
        };
      });
      setNodes(layoutedNodes);
      setEdges(layout.edges);
      setGraphBounds(layout.bounds);
      setNodeExtent(layout.nodeExtent);
      setTranslateExtent(layout.translateExtent);
    } else {
      setNodes([]);
      setEdges([]);
      setGraphBounds(DEFAULT_GRAPH_BOUNDS);
      setNodeExtent(DEFAULT_EXTENT);
      setTranslateExtent(DEFAULT_EXTENT);
    }
  }, [
    treeData,
    flattenTree,
    setNodes,
    setEdges,
    expandedCircleIds,
    handleCollapse,
    selectedCircleId,
    expandCircle,
    containerWidth,
    isCompactGraph,
    isFullscreen,
    manualPositions,
    layoutAnchorCircleId,
    layoutRevision,
    toggleCircle,
  ]);

  const isInteractiveTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("a,button,input,select,textarea,label,[contenteditable='true'],[data-no-node-toggle='true']"));
  }, []);

  const onNodeClick = useCallback((event: MouseEvent, node: Node) => {
    if (skipNextNodeClickRef.current) {
      skipNextNodeClickRef.current = false;
      return;
    }
    if (isInteractiveTarget(event.target)) return;
    setNodes((nds: Node[]) => 
      nds.map((n: Node) => ({
        ...n,
        selected: n.id === node.id
      }))
    );
    toggleCircle(node.id);
  }, [isInteractiveTarget, setNodes, toggleCircle]);

  const handleNodeDragStart = useCallback((_: any, node: Node) => {
    dragStartPositionsRef.current[node.id] = node.position;
  }, []);

  const handleNodeDragStop = useCallback((_: any, node: Node) => {
    const startPosition = dragStartPositionsRef.current[node.id];
    delete dragStartPositionsRef.current[node.id];
    if (!startPosition || Math.hypot(node.position.x - startPosition.x, node.position.y - startPosition.y) < CIRCLE_SNAP_GRID[0]) {
      return;
    }
    skipNextNodeClickRef.current = true;
    window.setTimeout(() => {
      skipNextNodeClickRef.current = false;
    }, 0);

    const candidateNodes = nodes.map((item) => item.id === node.id ? node : item);
    const nextPosition = findNearestFreePosition(node.id, candidateNodes, {
      viewportWidth: containerWidth,
      isCompactViewport: isCompactGraph,
      isFullscreen,
      manualPositions,
      anchorNodeId: node.id,
    });
    setManualPositions((prev) => ({ ...prev, [node.id]: nextPosition }));
    setLayoutAnchorCircleId(node.id);
  }, [containerWidth, isCompactGraph, isFullscreen, manualPositions, nodes]);

  const handleResetLayout = useCallback(() => {
    setManualPositions({});
    setLayoutAnchorCircleId(null);
    setLayoutRevision((value) => value + 1);
    window.requestAnimationFrame(() => {
      if (!flowInstance) return;
      if (isCompactGraph) {
        flowInstance.setViewport({ x: 24, y: 86, zoom: 0.95 }, { duration: 250 });
      } else {
        flowInstance.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 250 });
      }
    });
  }, [flowInstance, isCompactGraph, isFullscreen]);

  const handleCollapseAll = useCallback(() => {
    setExpandedCircleIds(new Set());
    setManualPositions({});
    setLayoutAnchorCircleId(null);
    setSelectedCircleId(null);
    setLayoutRevision((value) => value + 1);
  }, []);

  const handleFitView = useCallback(() => {
    if (!flowInstance) return;
    if (isCompactGraph) {
      flowInstance.setViewport({ x: 24, y: 86, zoom: 0.95 }, { duration: 250 });
    } else {
      flowInstance.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 250 });
    }
  }, [flowInstance, isCompactGraph, isFullscreen]);

  useEffect(() => {
    if (!flowInstance) return;
    const frame = window.requestAnimationFrame(() => {
      if (isCompactGraph) {
        flowInstance.setViewport({ x: 24, y: 86, zoom: 0.95 }, { duration: 250 });
      } else {
        flowInstance.fitView({ padding: isFullscreen ? 0.12 : 0.18, duration: 250 });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flowInstance, isCompactGraph, isFullscreen, layoutRevision]);

  return (
    <div
      ref={panelRef}
      className={`circle-graph-panel ${isFullscreen ? "circle-graph-panel-fullscreen" : ""}`}
      style={{ "--circle-graph-width": `${Math.ceil(graphBounds.width)}px` } as CSSProperties}
    >
      <div className="circle-graph-toolbar">
        <button type="button" className="circle-toolbar-button" onClick={handleFitView}>
          <Crosshair size={15} strokeWidth={1.8} />
          <span>{t("graphFitView")}</span>
        </button>
        <button type="button" className="circle-toolbar-button" onClick={handleResetLayout}>
          <RotateCcw size={15} strokeWidth={1.8} />
          <span>{t("graphResetLayout")}</span>
        </button>
        <button type="button" className="circle-toolbar-button" onClick={handleCollapseAll}>
          <ChevronsDown size={15} strokeWidth={1.8} />
          <span>{t("graphCollapseAll")}</span>
        </button>
        <button type="button" className="circle-toolbar-button circle-toolbar-button-primary" onClick={() => setIsFullscreen(prev => !prev)}>
          {isFullscreen ? <Minimize2 size={15} strokeWidth={1.8} /> : <Maximize2 size={15} strokeWidth={1.8} />}
          <span>{isFullscreen ? t("graphExitFullscreen") : t("graphFullscreen")}</span>
        </button>
      </div>
      <div className={`circle-graph-shell ${isFullscreen ? "circle-graph-shell-fullscreen" : ""}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onInit={setFlowInstance}
          nodeTypes={nodeTypes}
          fitView={!isCompactGraph}
          defaultViewport={isCompactGraph ? { x: 24, y: 86, zoom: 0.95 } : undefined}
          fitViewOptions={{ padding: 0.18 }}
          nodeExtent={nodeExtent}
          translateExtent={translateExtent}
          snapToGrid
          snapGrid={CIRCLE_SNAP_GRID}
          minZoom={0.2}
          maxZoom={2}
          attributionPosition="bottom-right"
        >
          <Controls />
          <Background gap={28} size={1} color="var(--circle-grid)" />
        </ReactFlow>
      </div>
    </div>
  );
}
