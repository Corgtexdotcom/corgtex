import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  findNearestFreePosition,
  layoutCircleGraph,
  type CircleLayoutOptions,
  type GraphPoint,
  type NodeDimensions,
} from "./circleLayout";

const defaultOptions: CircleLayoutOptions = {
  viewportWidth: 1180,
  isCompactViewport: false,
  isFullscreen: false,
};

function makeNode(id: string, type: "circleNode" | "expandedCircleNode" = "circleNode", roleCount = 3): Node {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      roleCount,
      roles: Array.from({ length: roleCount }, (_, index) => ({ id: `${id}-${index}` })),
    },
  };
}

function getDimensions(node: Node): NodeDimensions {
  const data = node.data as { nodeWidth?: number; nodeHeight?: number };
  return {
    width: data.nodeWidth ?? 0,
    height: data.nodeHeight ?? 0,
  };
}

function overlaps(aPosition: GraphPoint, aDimensions: NodeDimensions, bPosition: GraphPoint, bDimensions: NodeDimensions) {
  return !(
    aPosition.x + aDimensions.width + 24 <= bPosition.x ||
    bPosition.x + bDimensions.width + 24 <= aPosition.x ||
    aPosition.y + aDimensions.height + 24 <= bPosition.y ||
    bPosition.y + bDimensions.height + 24 <= aPosition.y
  );
}

function expectNoOverlap(nodes: Node[]) {
  for (let outerIndex = 0; outerIndex < nodes.length; outerIndex += 1) {
    for (let innerIndex = outerIndex + 1; innerIndex < nodes.length; innerIndex += 1) {
      const outerNode = nodes[outerIndex];
      const innerNode = nodes[innerIndex];
      expect(
        overlaps(outerNode.position, getDimensions(outerNode), innerNode.position, getDimensions(innerNode)),
      ).toBe(false);
    }
  }
}

describe("circle graph layout", () => {
  it("lays out collapsed root circles without overlap", () => {
    const result = layoutCircleGraph(
      Array.from({ length: 6 }, (_, index) => makeNode(`circle-${index + 1}`)),
      [],
      defaultOptions,
    );

    expectNoOverlap(result.nodes);
  });

  it("lays out multiple expanded root circles without overlap", () => {
    const result = layoutCircleGraph(
      [
        makeNode("executive", "expandedCircleNode", 3),
        makeNode("medicine", "expandedCircleNode", 5),
        makeNode("medtech", "expandedCircleNode", 2),
        makeNode("operations"),
      ],
      [],
      defaultOptions,
    );

    expectNoOverlap(result.nodes);
  });

  it("uses expanded row heights when collapsed and expanded circles are mixed", () => {
    const result = layoutCircleGraph(
      [
        makeNode("expanded", "expandedCircleNode", 3),
        makeNode("collapsed-a"),
        makeNode("collapsed-b"),
      ],
      [],
      { ...defaultOptions, viewportWidth: 900 },
    );

    const expanded = result.nodes.find((node) => node.id === "expanded");
    const wrapped = result.nodes.find((node) => node.id === "collapsed-b");
    expect(expanded).toBeDefined();
    expect(wrapped).toBeDefined();
    expect(wrapped!.position.y).toBeGreaterThan(expanded!.position.y + getDimensions(expanded!).height);
    expectNoOverlap(result.nodes);
  });

  it("snaps a dragged node away from another node when they overlap", () => {
    const result = layoutCircleGraph(
      [makeNode("a", "expandedCircleNode", 3), makeNode("b")],
      [],
      defaultOptions,
    );
    const first = result.nodes[0];
    const overlappingNodes = result.nodes.map((node) => (
      node.id === "b" ? { ...node, position: first.position } : node
    ));

    const nextPosition = findNearestFreePosition("b", overlappingNodes, defaultOptions);
    const draggedNode = overlappingNodes.find((node) => node.id === "b")!;

    expect(
      overlaps(nextPosition, getDimensions(draggedNode), first.position, getDimensions(first)),
    ).toBe(false);
  });

  it("returns bounds that contain every positioned node", () => {
    const edges: Edge[] = [{ id: "a-b", source: "a", target: "b" }];
    const result = layoutCircleGraph(
      [makeNode("a", "expandedCircleNode", 2), makeNode("b"), makeNode("c")],
      edges,
      defaultOptions,
    );

    for (const node of result.nodes) {
      const dimensions = getDimensions(node);
      expect(node.position.x).toBeGreaterThanOrEqual(result.bounds.minX);
      expect(node.position.y).toBeGreaterThanOrEqual(result.bounds.minY);
      expect(node.position.x + dimensions.width).toBeLessThanOrEqual(result.bounds.maxX);
      expect(node.position.y + dimensions.height).toBeLessThanOrEqual(result.bounds.maxY);
    }
  });
});
