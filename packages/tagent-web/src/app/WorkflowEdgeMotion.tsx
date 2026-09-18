'use client';

import { useEffect, useRef } from 'react';
import styles from './WorkflowDrawer.module.css';

// React Flow owns the geometry. Batch only its decorative motion into a viewport-sized canvas.
export function WorkflowEdgeMotion({ layer }: { layer: SVGGElement | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !layer) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, dirty = true, width = 0, height = 0, ratio = 1, lineWidth = 1.8;
    let path = new Path2D(), color = '';
    const clear = () => context.clearRect(0, 0, width, height);
    const rebuild = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const matrix = layer.transform.baseVal.consolidate()?.matrix;
      path = new Path2D();
      if (matrix) {
        for (const edge of layer.querySelectorAll<SVGPathElement>('path[data-full-path]')) {
          const geometry = edge.getAttribute('d');
          if (geometry) path.addPath(new Path2D(geometry), matrix);
        }
      }
      lineWidth = 1.8 * Math.min(1, Math.sqrt(matrix?.a || 1));
      color = getComputedStyle(canvas).color;
      dirty = false;
    };
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || reducedMotion.matches) { clear(); return; }
      if (dirty || ratio !== window.devicePixelRatio) rebuild();
      clear();
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.setLineDash([10, 8]);
      context.lineDashOffset = -(now % 1600) / 1600 * 36;
      context.stroke(path);
      frame = requestAnimationFrame(tick);
    };
    const refresh = () => {
      dirty = true;
      if (document.hidden || reducedMotion.matches) {
        cancelAnimationFrame(frame); frame = 0; clear();
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    const geometry = new MutationObserver(refresh);
    geometry.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ['d', 'transform'] });
    const theme = new MutationObserver(refresh);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const size = new ResizeObserver(refresh);
    size.observe(canvas);
    document.addEventListener('visibilitychange', refresh);
    reducedMotion.addEventListener('change', refresh);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      geometry.disconnect(); theme.disconnect(); size.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      reducedMotion.removeEventListener('change', refresh);
      clear();
    };
  }, [layer]);

  return <canvas ref={canvasRef} className={styles.workflowMotionCanvas} aria-hidden="true" />;
}
