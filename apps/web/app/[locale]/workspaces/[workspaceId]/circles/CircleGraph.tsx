"use client";

import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
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
  const shellRef = useRef<HTMLDivElement>(null);
  const dragStartPositionsRef = useRef<Record<string, GraphPoint>>({});
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [expandedCircleIds, setExpandedCircleIds] = useState<Set<string>>(new Set());
  const [manualPositions, setManualPositions] = useState<Record<string, GraphPoint>>({});
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
    const updateViewportMode = () => setIsCompactViewport(window.innerWidth < 760);
    updateViewportMode();
    window.addEventListener("resize", updateViewportMode);
    return () => window.removeEventListener("resize", updateViewportMode);
  }, []);

  useEffect(() => {
    if (!shellRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(shellRef.current);
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

  const handleCollapse = useCallback((id: string) => {
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const expandCircle = useCallback((id: string) => {
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setSelectedCircleId(id);
  }, []);

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
    layoutRevision,
  ]);

  const onNodeDoubleClick = useCallback((_: any, node: Node) => {
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setNodes((nds: Node[]) => 
      nds.map((n: Node) => ({
        ...n,
        selected: n.id === node.id
      }))
    );
    setSelectedCircleId(node.data.circleId as string);
  }, [setNodes]);

  const handleNodeDragStart = useCallback((_: any, node: Node) => {
    dragStartPositionsRef.current[node.id] = node.position;
  }, []);

  const handleNodeDragStop = useCallback((_: any, node: Node) => {
    const startPosition = dragStartPositionsRef.current[node.id];
    delete dragStartPositionsRef.current[node.id];
    if (!startPosition || Math.hypot(node.position.x - startPosition.x, node.position.y - startPosition.y) < CIRCLE_SNAP_GRID[0]) {
      return;
    }

    const candidateNodes = nodes.map((item) => item.id === node.id ? node : item);
    const nextPosition = findNearestFreePosition(node.id, candidateNodes, {
      viewportWidth: containerWidth,
      isCompactViewport: isCompactGraph,
      isFullscreen,
      manualPositions,
    });
    setManualPositions((prev) => ({ ...prev, [node.id]: nextPosition }));
  }, [containerWidth, isCompactGraph, isFullscreen, manualPositions, nodes]);

  const handleResetLayout = useCallback(() => {
    setManualPositions({});
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
      ref={shellRef}
      className={`circle-graph-shell ${isFullscreen ? "circle-graph-shell-fullscreen" : ""}`}
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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
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
  );
}
