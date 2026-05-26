import { describe, expect, it } from "vitest";

import {
  buildRoutedEdgePath,
  nearestSourceSide,
  oppositeSide,
  routeIntersectsObstacles,
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
});
