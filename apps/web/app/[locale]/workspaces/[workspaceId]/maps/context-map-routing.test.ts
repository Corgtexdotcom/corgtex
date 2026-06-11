import { describe, expect, it } from "vitest";

import {
  buildRoutedEdgePath,
  nearestSourceSide,
  oppositeSide,
  routeIntersectsObstacles,
  scopeObstaclesForEdge,
  type NodeRect,
} from "./context-map-routing";

describe("context map routing", () => {
  it("chooses the nearest attachment sides from node geometry", () => {
    const source: NodeRect = { id: "source", x: 0, y: 0, width: 250, height: 128 };
    const target: NodeRect = { id: "target", x: 360, y: 30, width: 250, height: 128 };

    const sourceSide = nearestSourceSide(source, target);

    expect(sourceSide).toBe("right");
    expect(oppositeSide(sourceSide)).toBe("left");
  });

  it("routes around an intervening process card instead of crossing it", () => {
    const obstacle: NodeRect = { id: "middle-step", x: 120, y: -50, width: 120, height: 100 };

    const route = buildRoutedEdgePath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 0,
      sourceSide: "right",
      targetSide: "left",
      obstacles: [obstacle],
    });

    expect(routeIntersectsObstacles(route.points, [obstacle])).toBe(false);
    expect(route.points.some((point) => point.y < obstacle.y || point.y > obstacle.y + obstacle.height)).toBe(true);
  });

  it("scopes routing obstacles to the corridor around an edge", () => {
    const source: NodeRect = { id: "source", x: 0, y: 0, width: 250, height: 128 };
    const target: NodeRect = { id: "target", x: 600, y: 0, width: 250, height: 128 };
    const between: NodeRect = { id: "between", x: 320, y: 20, width: 250, height: 128 };
    const nearby: NodeRect = { id: "nearby", x: 320, y: 200, width: 250, height: 128 };
    const farAway: NodeRect = { id: "far-away", x: 320, y: 2000, width: 250, height: 128 };

    const scoped = scopeObstaclesForEdge(source, target, [source, target, between, nearby, farAway]);

    const scopedIds = scoped.map((rect) => rect.id);
    expect(scopedIds).toContain("between");
    expect(scopedIds).toContain("nearby");
    expect(scopedIds).not.toContain("far-away");
    expect(scopedIds).not.toContain("source");
    expect(scopedIds).not.toContain("target");
  });

  it("honors a custom corridor margin when scoping obstacles", () => {
    const source: NodeRect = { id: "source", x: 0, y: 0, width: 100, height: 100 };
    const target: NodeRect = { id: "target", x: 400, y: 0, width: 100, height: 100 };
    const justOutside: NodeRect = { id: "just-outside", x: 200, y: 130, width: 100, height: 100 };

    expect(scopeObstaclesForEdge(source, target, [justOutside], 10).map((rect) => rect.id)).toEqual([]);
    expect(scopeObstaclesForEdge(source, target, [justOutside], 60).map((rect) => rect.id)).toEqual(["just-outside"]);
  });
});
