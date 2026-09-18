import { describe, expect, it } from 'vitest';
import { clipOrthogonalMotion, workflowGutter } from '../workflow-edge-motion';

describe('workflow motion clipping', () => {
  const view = { left: 0, top: 0, right: 100, bottom: 80 };
  it('keeps visible gutter motion even when both agent endpoints are offscreen', () => {
    expect(clipOrthogonalMotion([{ x: 20, y: -10000 }, { x: 20, y: 20000 }], view)).toBe('M 20 0 L 20 80');
  });
  it('preserves direction and corners, without drawing connectors across clipped gaps', () => {
    expect(clipOrthogonalMotion([{ x: 90, y: 1000 }, { x: 90, y: 40 }, { x: 10, y: 40 }, { x: 10, y: -1000 }], view))
      .toBe('M 90 80 L 90 40 M 90 40 L 10 40 M 10 40 L 10 0');
  });
  it('does not animate invisible edges or degenerate segments', () => {
    expect(clipOrthogonalMotion([{ x: -1, y: -1000 }, { x: -1, y: 1000 }], view)).toBe('');
    expect(clipOrthogonalMotion([{ x: 0, y: -10 }, { x: 0, y: 0 }], view)).toBe('');
  });
  it('retains exact geometry when the full path is visible', () => {
    expect(clipOrthogonalMotion([{ x: 0, y: 40 }, { x: 90, y: 40 }], view)).toBe('M 0 40 L 90 40');
  });

  const lanes = { agentX: 24, toolX: 350, agentStride: 356 };
  it.each(['synthesis', 'tool:read_url'])('bounds long %s relationships when both ends are offscreen', target => {
    const points = workflowGutter('agent:review', target, { x: 277.5, y: -10000 }, { x: 346.5, y: 20000 }, lanes)!;
    expect(points).toHaveLength(4);
    expect(clipOrthogonalMotion(points, { left: 0, top: 0, right: 400, bottom: 700 })).toBe('M 312 0 L 312 700');
    expect(points[0].y).toBe(-10000);
    expect(points.at(-1)?.y).toBe(20000);
  });
  it('retains reverse direction for long forward-lane links', () => {
    const points = workflowGutter('agent:review', 'synthesis', { x: 277.5, y: 20000 }, { x: 346.5, y: -10000 }, lanes)!;
    expect(clipOrthogonalMotion(points, { left: 0, top: 0, right: 400, bottom: 700 })).toBe('M 312 700 L 312 0');
  });
  it('keeps short tool links curved and does not reroute unrelated relationships', () => {
    expect(workflowGutter('agent:review', 'tool:read_url', { x: 277.5, y: 346 }, { x: 346.5, y: 464 }, lanes)).toBeUndefined();
    expect(workflowGutter('unknown', 'synthesis', { x: 0, y: 0 }, { x: 400, y: 20000 }, lanes)).toBeUndefined();
  });
  it.each(['agent:child', 'governance'])('preserves the outer gutter for %s', target => {
    const points = workflowGutter('agent:parent', target, { x: 277.5, y: 346 }, { x: 20.5, y: 20000 }, lanes)!;
    expect(points).toEqual([{ x: 277.5, y: 346 }, { x: 297.5, y: 346 }, { x: 297.5, y: 524 },
      { x: -12, y: 524 }, { x: -12, y: 20000 }, { x: 20.5, y: 20000 }]);
  });
});
