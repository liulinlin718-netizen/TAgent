export type Point = { x: number; y: number };
export type ViewRect = { left: number; top: number; right: number; bottom: number };

export function workflowGutter(sourceId: string, targetId: string, source: Point, target: Point,
  lanes: { agentX: number; toolX: number; agentStride: number }): Point[] | undefined {
  const targetInAgentLane = targetId.startsWith('agent:') || targetId === 'governance';
  if (sourceId === 'orchestrator') {
    const exitY = source.y + 20;
    const x = targetInAgentLane ? lanes.agentX - 36 : lanes.toolX - 30;
    return [source, { x: source.x, y: exitY }, { x, y: exitY }, { x, y: target.y }, target];
  }
  if (sourceId.startsWith('agent:') && targetInAgentLane) {
    const exitX = source.x + 20;
    const exitY = source.y + (target.y > source.y ? lanes.agentStride / 2 : -lanes.agentStride / 2);
    const x = lanes.agentX - 36;
    return [source, { x: exitX, y: source.y }, { x: exitX, y: exitY }, { x, y: exitY }, { x, y: target.y }, target];
  }
  // Long tool/summary links need clipping too; their smooth curves otherwise animate far offscreen.
  if (sourceId.startsWith('agent:') && (targetId === 'synthesis' || targetId.startsWith('tool:'))
    && Math.abs(target.y - source.y) > lanes.agentStride) {
    const x = (source.x + target.x) / 2;
    return [source, { x, y: source.y }, { x, y: target.y }, target];
  }
  return undefined;
}

// Clip paint geometry, not graph data; retain visible gutters even with both endpoints offscreen.
export function clipOrthogonalMotion(points: Point[], view: ViewRect): string {
  const paths: string[] = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    if (Math.max(a.x, b.x) < view.left || Math.min(a.x, b.x) > view.right
      || Math.max(a.y, b.y) < view.top || Math.min(a.y, b.y) > view.bottom) continue;
    const x = (value: number) => Math.max(view.left, Math.min(view.right, value));
    const y = (value: number) => Math.max(view.top, Math.min(view.bottom, value));
    if (a.x !== b.x && a.y !== b.y) throw new Error('Workflow gutter must be orthogonal');
    if (x(a.x) === x(b.x) && y(a.y) === y(b.y)) continue;
    paths.push(`M ${x(a.x)} ${y(a.y)} L ${x(b.x)} ${y(b.y)}`);
  }
  return paths.join(' ');
}
