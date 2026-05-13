import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

export type GraphPoint = {
  x: number;
  y: number;
};

export type NodeDimensions = {
  width: number;
  height: number;
};

export type GraphBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

export type CircleLayoutOptions = {
  viewportWidth: number;
  isCompactViewport: boolean;
  isFullscreen: boolean;
  manualPositions?: Record<string, GraphPoint>;
};

export type CircleLayoutResult = {
  nodes: Node[];
  edges: Edge[];
  bounds: GraphBounds;
  nodeExtent: [[number, number], [number, number]];
  translateExtent: [[number, number], [number, number]];
};

export const CIRCLE_SNAP_GRID: [number, number] = [16, 16];

const COLLAPSED_NODE_WIDTH = 284;
const COLLAPSED_NODE_HEIGHT = 320;
const EXPANDED_NODE_WIDTH = 460;
const MIN_COMPACT_EXPANDED_WIDTH = 320;
const MAX_COMPACT_EXPANDED_WIDTH = 420;
const COLLISION_GAP = 24;

function getRoleCount(node: Node) {
  const data = node.data as { roleCount?: number; roles?: unknown[] } | undefined;
  if (typeof data?.roleCount === "number") return data.roleCount;
  return data?.roles?.length ?? 0;
}

function isExpandedNode(node: Node) {
  return node.type === "expandedCircleNode";
}

function getSafeViewportWidth(options: Pick<CircleLayoutOptions, "viewportWidth" | "isCompactViewport">) {
  if (Number.isFinite(options.viewportWidth) && options.viewportWidth > 0) return options.viewportWidth;
  return options.isCompactViewport ? 390 : 1100;
}

export function getCircleNodeDimensions({
  isExpanded,
  roleCount,
  viewportWidth,
  isCompactViewport,
}: {
  isExpanded: boolean;
  roleCount: number;
  viewportWidth: number;
  isCompactViewport: boolean;
  isFullscreen: boolean;
}): NodeDimensions {
  const safeViewportWidth = getSafeViewportWidth({ viewportWidth, isCompactViewport });
  const compactExpandedWidth = Math.min(
    MAX_COMPACT_EXPANDED_WIDTH,
    Math.max(MIN_COMPACT_EXPANDED_WIDTH, safeViewportWidth - 64),
  );

  if (!isExpanded) {
    return {
      width: isCompactViewport ? Math.min(COLLAPSED_NODE_WIDTH, Math.max(260, safeViewportWidth - 64)) : COLLAPSED_NODE_WIDTH,
      height: COLLAPSED_NODE_HEIGHT,
    };
  }

  return {
    width: isCompactViewport ? compactExpandedWidth : EXPANDED_NODE_WIDTH,
    height: Math.min(isCompactViewport ? 560 : 620, 260 + roleCount * 132),
  };
}

function getDimensionsForNode(node: Node, options: CircleLayoutOptions): NodeDimensions {
  const data = node.data as { nodeWidth?: number; nodeHeight?: number } | undefined;
  if (typeof data?.nodeWidth === "number" && typeof data?.nodeHeight === "number") {
    return { width: data.nodeWidth, height: data.nodeHeight };
  }

  return getCircleNodeDimensions({
    isExpanded: isExpandedNode(node),
    roleCount: getRoleCount(node),
    viewportWidth: options.viewportWidth,
    isCompactViewport: options.isCompactViewport,
    isFullscreen: options.isFullscreen,
  });
}

function withMeasuredData(node: Node, dimensions: NodeDimensions): Node {
  return {
    ...node,
    data: {
      ...node.data,
      nodeWidth: dimensions.width,
      nodeHeight: dimensions.height,
    },
  };
}

function snapPosition(position: GraphPoint): GraphPoint {
  return {
    x: Math.round(position.x / CIRCLE_SNAP_GRID[0]) * CIRCLE_SNAP_GRID[0],
    y: Math.round(position.y / CIRCLE_SNAP_GRID[1]) * CIRCLE_SNAP_GRID[1],
  };
}

function snapUp(value: number, gridSize: number) {
  return Math.ceil(value / gridSize) * gridSize;
}

function rectanglesOverlap(
  aPosition: GraphPoint,
  aDimensions: NodeDimensions,
  bPosition: GraphPoint,
  bDimensions: NodeDimensions,
  gap = COLLISION_GAP,
) {
  return !(
    aPosition.x + aDimensions.width + gap <= bPosition.x ||
    bPosition.x + bDimensions.width + gap <= aPosition.x ||
    aPosition.y + aDimensions.height + gap <= bPosition.y ||
    bPosition.y + bDimensions.height + gap <= aPosition.y
  );
}

function getDimensionMap(nodes: Node[], options: CircleLayoutOptions) {
  return new Map(nodes.map((node) => [node.id, getDimensionsForNode(node, options)]));
}

function isFreePosition(
  nodeId: string,
  position: GraphPoint,
  nodes: Node[],
  dimensionsById: Map<string, NodeDimensions>,
) {
  const nodeDimensions = dimensionsById.get(nodeId);
  if (!nodeDimensions) return true;

  return nodes.every((node) => {
    if (node.id === nodeId) return true;
    const otherDimensions = dimensionsById.get(node.id);
    if (!otherDimensions) return true;
    return !rectanglesOverlap(position, nodeDimensions, node.position, otherDimensions);
  });
}

export function findNearestFreePosition(
  nodeId: string,
  nodes: Node[],
  options: CircleLayoutOptions,
): GraphPoint {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return { x: 0, y: 0 };

  const dimensionsById = getDimensionMap(nodes, options);
  const start = snapPosition(node.position);
  if (isFreePosition(nodeId, start, nodes, dimensionsById)) return start;

  const stepX = CIRCLE_SNAP_GRID[0] * 5;
  const stepY = CIRCLE_SNAP_GRID[1] * 5;
  const candidates: GraphPoint[] = [];

  for (let radius = 1; radius <= 18; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        candidates.push(snapPosition({ x: start.x + dx * stepX, y: start.y + dy * stepY }));
      }
    }
    candidates.sort((a, b) => {
      const distanceA = Math.hypot(a.x - start.x, a.y - start.y);
      const distanceB = Math.hypot(b.x - start.x, b.y - start.y);
      return distanceA - distanceB;
    });

    const match = candidates.find((candidate) => isFreePosition(nodeId, candidate, nodes, dimensionsById));
    if (match) return match;
  }

  const maxOccupiedBottom = nodes.reduce((maxBottom, item) => {
    if (item.id === nodeId) return maxBottom;
    const dimensions = dimensionsById.get(item.id);
    if (!dimensions) return maxBottom;
    return Math.max(maxBottom, item.position.y + dimensions.height);
  }, start.y);
  let fallback = {
    x: start.x,
    y: snapUp(maxOccupiedBottom + COLLISION_GAP, CIRCLE_SNAP_GRID[1]),
  };

  while (!isFreePosition(nodeId, fallback, nodes, dimensionsById)) {
    fallback = {
      x: fallback.x,
      y: fallback.y + CIRCLE_SNAP_GRID[1],
    };
  }
  return fallback;
}

function resolveCollisions(nodes: Node[], options: CircleLayoutOptions) {
  const resolved: Node[] = [];

  for (const node of nodes) {
    const candidate = { ...node };
    const position = findNearestFreePosition(candidate.id, [candidate, ...resolved], options);
    resolved.push({ ...candidate, position });
  }

  return resolved;
}

function layoutFlatNodes(nodes: Node[], options: CircleLayoutOptions) {
  const safeViewportWidth = getSafeViewportWidth(options);
  const padding = options.isCompactViewport ? 24 : options.isFullscreen ? 72 : 48;
  const gapX = options.isCompactViewport ? 28 : options.isFullscreen ? 56 : 40;
  const gapY = options.isCompactViewport ? 36 : 48;
  const availableWidth = Math.max(options.isCompactViewport ? 320 : 640, safeViewportWidth - padding * 2);

  let cursorX = padding;
  let cursorY = padding;
  let rowHeight = 0;

  return nodes.map((node) => {
    const dimensions = getDimensionsForNode(node, options);
    if (
      !options.isCompactViewport &&
      cursorX > padding &&
      cursorX + dimensions.width > padding + availableWidth
    ) {
      cursorX = padding;
      cursorY += rowHeight + gapY;
      rowHeight = 0;
    }

    const positionedNode = withMeasuredData(node, dimensions);
    positionedNode.position = { x: cursorX, y: cursorY };

    if (options.isCompactViewport) {
      cursorX = padding;
      cursorY += dimensions.height + gapY;
      rowHeight = 0;
    } else {
      cursorX += dimensions.width + gapX;
      rowHeight = Math.max(rowHeight, dimensions.height);
    }

    return positionedNode;
  });
}

function layoutDagreNodes(nodes: Node[], edges: Edge[], options: CircleLayoutOptions) {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: "TB",
    nodesep: options.isCompactViewport ? 56 : 88,
    ranksep: options.isCompactViewport ? 96 : 132,
    marginx: options.isCompactViewport ? 24 : 48,
    marginy: options.isCompactViewport ? 24 : 48,
  });

  nodes.forEach((node) => {
    const dimensions = getDimensionsForNode(node, options);
    dagreGraph.setNode(node.id, dimensions);
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  return nodes.map((node) => {
    const dimensions = getDimensionsForNode(node, options);
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...withMeasuredData(node, dimensions),
      position: {
        x: nodeWithPosition.x - dimensions.width / 2,
        y: nodeWithPosition.y - dimensions.height / 2,
      },
    };
  });
}

function applyManualPositions(nodes: Node[], manualPositions: Record<string, GraphPoint> | undefined) {
  if (!manualPositions) return nodes;
  return nodes.map((node) => {
    const manualPosition = manualPositions[node.id];
    if (!manualPosition) return node;
    return { ...node, position: snapPosition(manualPosition) };
  });
}

export function getGraphBounds(nodes: Node[], options: CircleLayoutOptions): GraphBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  }

  const dimensionsById = getDimensionMap(nodes, options);
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + (dimensionsById.get(node.id)?.width ?? 0)));
  const maxY = Math.max(...nodes.map((node) => node.position.y + (dimensionsById.get(node.id)?.height ?? 0)));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function getExtents(bounds: GraphBounds, options: CircleLayoutOptions) {
  const panPadding = options.isFullscreen ? 260 : options.isCompactViewport ? 140 : 200;
  const nodePadding = options.isFullscreen ? 2200 : 1600;
  const nodeExtent: [[number, number], [number, number]] = [
    [bounds.minX - nodePadding, bounds.minY - nodePadding],
    [bounds.maxX + nodePadding, bounds.maxY + nodePadding],
  ];
  const translateExtent: [[number, number], [number, number]] = [
    [bounds.minX - panPadding, bounds.minY - panPadding],
    [bounds.maxX + panPadding, bounds.maxY + panPadding],
  ];

  return { nodeExtent, translateExtent };
}

export function layoutCircleGraph(
  nodes: Node[],
  edges: Edge[],
  options: CircleLayoutOptions,
): CircleLayoutResult {
  const autoNodes = edges.length === 0
    ? layoutFlatNodes(nodes, options)
    : layoutDagreNodes(nodes, edges, options);
  const manuallyPositionedNodes = applyManualPositions(autoNodes, options.manualPositions);
  const collisionFreeNodes = resolveCollisions(manuallyPositionedNodes, options);
  const bounds = getGraphBounds(collisionFreeNodes, options);
  const { nodeExtent, translateExtent } = getExtents(bounds, options);

  return {
    nodes: collisionFreeNodes,
    edges,
    bounds,
    nodeExtent,
    translateExtent,
  };
}
