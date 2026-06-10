export type NodeSide = "top" | "right" | "bottom" | "left";

export type Point = {
  x: number;
  y: number;
};

export type NodeRect = Point & {
  id: string;
  width: number;
  height: number;
};

const EDGE_EXIT_GAP = 26;
const EDGE_OBSTACLE_GAP = 16;
const EDGE_CORRIDOR_MARGIN = 96;

export function handleId(type: "source" | "target", side: NodeSide) {
  return `${type}-${side}`;
}

export function oppositeSide(side: NodeSide): NodeSide {
  if (side === "top") return "bottom";
  if (side === "right") return "left";
  if (side === "bottom") return "top";
  return "right";
}

function offsetPoint(point: Point, side: NodeSide, distance: number): Point {
  if (side === "top") return { x: point.x, y: point.y - distance };
  if (side === "right") return { x: point.x + distance, y: point.y };
  if (side === "bottom") return { x: point.x, y: point.y + distance };
  return { x: point.x - distance, y: point.y };
}

function rectCenter(rect: NodeRect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function nearestSourceSide(sourceRect: NodeRect, targetRect: NodeRect): NodeSide {
  const source = rectCenter(sourceRect);
  const target = rectCenter(targetRect);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function rangesOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number) {
  return Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd);
}

function inflateRect(rect: NodeRect, gap: number): NodeRect {
  return {
    id: rect.id,
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  };
}

function rectsIntersect(left: NodeRect, right: NodeRect) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function scopeObstaclesForEdge(
  sourceRect: NodeRect,
  targetRect: NodeRect,
  obstacles: NodeRect[],
  margin = EDGE_CORRIDOR_MARGIN,
): NodeRect[] {
  const minX = Math.min(sourceRect.x, targetRect.x) - margin;
  const minY = Math.min(sourceRect.y, targetRect.y) - margin;
  const maxX = Math.max(sourceRect.x + sourceRect.width, targetRect.x + targetRect.width) + margin;
  const maxY = Math.max(sourceRect.y + sourceRect.height, targetRect.y + targetRect.height) + margin;
  const corridor: NodeRect = {
    id: "__corridor__",
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
  return obstacles.filter((obstacle) => (
    obstacle.id !== sourceRect.id
    && obstacle.id !== targetRect.id
    && rectsIntersect(obstacle, corridor)
  ));
}

function mergeIntervals(intervals: Array<[number, number]>) {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1]) {
      merged.push([...interval]);
    } else {
      previous[1] = Math.max(previous[1], interval[1]);
    }
  }
  return merged;
}

function laneCandidates(ideal: number, intervals: Array<[number, number]>) {
  const merged = mergeIntervals(intervals);
  const candidates = [ideal, ideal - EDGE_EXIT_GAP, ideal + EDGE_EXIT_GAP];
  for (let index = 0; index < merged.length - 1; index += 1) {
    const left = merged[index];
    const right = merged[index + 1];
    if (right[0] - left[1] > EDGE_OBSTACLE_GAP * 2) candidates.push((left[1] + right[0]) / 2);
  }
  if (merged[0]) candidates.push(merged[0][0] - EDGE_EXIT_GAP);
  const last = merged.at(-1);
  if (last) candidates.push(last[1] + EDGE_EXIT_GAP);
  return [...new Set(candidates.map((value) => Math.round(value * 100) / 100))]
    .sort((left, right) => Math.abs(left - ideal) - Math.abs(right - ideal));
}

function verticalLaneCandidates(ideal: number, yStart: number, yEnd: number, obstacles: NodeRect[]) {
  const minY = Math.min(yStart, yEnd);
  const maxY = Math.max(yStart, yEnd);
  return laneCandidates(ideal, obstacles
    .map((obstacle) => inflateRect(obstacle, EDGE_OBSTACLE_GAP))
    .filter((obstacle) => rangesOverlap(minY, maxY, obstacle.y, obstacle.y + obstacle.height))
    .map((obstacle) => [obstacle.x, obstacle.x + obstacle.width]));
}

function horizontalLaneCandidates(ideal: number, xStart: number, xEnd: number, obstacles: NodeRect[]) {
  const minX = Math.min(xStart, xEnd);
  const maxX = Math.max(xStart, xEnd);
  return laneCandidates(ideal, obstacles
    .map((obstacle) => inflateRect(obstacle, EDGE_OBSTACLE_GAP))
    .filter((obstacle) => rangesOverlap(minX, maxX, obstacle.x, obstacle.x + obstacle.width))
    .map((obstacle) => [obstacle.y, obstacle.y + obstacle.height]));
}

function compactRoutePoints(points: Point[]) {
  const withoutDuplicates = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  return withoutDuplicates.filter((point, index) => {
    const previous = withoutDuplicates[index - 1];
    const next = withoutDuplicates[index + 1];
    if (!previous || !next) return true;
    return !(previous.x === point.x && point.x === next.x) && !(previous.y === point.y && point.y === next.y);
  });
}

function segmentIntersectsRect(start: Point, end: Point, rect: NodeRect) {
  if (start.x === end.x) {
    const x = start.x;
    if (x <= rect.x || x >= rect.x + rect.width) return false;
    return rangesOverlap(Math.min(start.y, end.y), Math.max(start.y, end.y), rect.y, rect.y + rect.height);
  }
  if (start.y === end.y) {
    const y = start.y;
    if (y <= rect.y || y >= rect.y + rect.height) return false;
    return rangesOverlap(Math.min(start.x, end.x), Math.max(start.x, end.x), rect.x, rect.x + rect.width);
  }
  return false;
}

export function routeIntersectsObstacles(points: Point[], obstacles: NodeRect[]) {
  const inflatedObstacles = obstacles.map((obstacle) => inflateRect(obstacle, EDGE_OBSTACLE_GAP));
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (inflatedObstacles.some((obstacle) => segmentIntersectsRect(start, end, obstacle))) return true;
  }
  return false;
}

function routeLength(points: Point[]) {
  return points.reduce((sum, point, index) => {
    const previous = points[index - 1];
    if (!previous) return sum;
    return sum + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  }, 0);
}

function routeLabelPoint(points: Point[]) {
  const total = routeLength(points);
  if (total === 0) return points[0] ?? { x: 0, y: 0 };
  let covered = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (covered + length >= total / 2) {
      const remaining = total / 2 - covered;
      const ratio = length === 0 ? 0 : remaining / length;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
    covered += length;
  }
  return points.at(-1) ?? { x: 0, y: 0 };
}

function pointsToPath(points: Point[]) {
  const [first, ...rest] = points;
  if (!first) return "";
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
}

function routeScore(points: Point[]) {
  return routeLength(points) + Math.max(points.length - 2, 0) * 8;
}

export function buildRoutedEdgePath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceSide,
  targetSide,
  obstacles,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceSide: NodeSide;
  targetSide: NodeSide;
  obstacles: NodeRect[];
}) {
  const sourcePoint = { x: sourceX, y: sourceY };
  const targetPoint = { x: targetX, y: targetY };
  const sourceOut = offsetPoint(sourcePoint, sourceSide, EDGE_EXIT_GAP);
  const targetOut = offsetPoint(targetPoint, targetSide, EDGE_EXIT_GAP);
  const candidates: Point[][] = [];
  const verticalIdeal = (sourceOut.x + targetOut.x) / 2;
  const horizontalIdeal = (sourceOut.y + targetOut.y) / 2;

  for (const laneX of verticalLaneCandidates(verticalIdeal, sourceOut.y, targetOut.y, obstacles)) {
    candidates.push(compactRoutePoints([
      sourcePoint,
      sourceOut,
      { x: laneX, y: sourceOut.y },
      { x: laneX, y: targetOut.y },
      targetOut,
      targetPoint,
    ]));
  }

  for (const laneY of horizontalLaneCandidates(horizontalIdeal, sourceOut.x, targetOut.x, obstacles)) {
    candidates.push(compactRoutePoints([
      sourcePoint,
      sourceOut,
      { x: sourceOut.x, y: laneY },
      { x: targetOut.x, y: laneY },
      targetOut,
      targetPoint,
    ]));
  }

  const validCandidates = candidates.filter((candidate) => !routeIntersectsObstacles(candidate, obstacles));
  const points = (validCandidates.length > 0 ? validCandidates : candidates)
    .sort((left, right) => routeScore(left) - routeScore(right))[0]
    ?? [sourcePoint, targetPoint];
  const labelPoint = routeLabelPoint(points);
  return {
    labelX: labelPoint.x,
    labelY: labelPoint.y,
    path: pointsToPath(points),
    points,
  };
}
