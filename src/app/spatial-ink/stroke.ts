import { getStroke } from 'perfect-freehand';

export interface InkPoint { x: number; y: number }

/**
 * The filled outline of one ink stroke. perfect-freehand (MIT) simulates pressure
 * from pointer speed, so a fast flick thins out and a slow mark fills in; the tail
 * tapers into the round head of the comet trail. `complete` is false while the
 * stroke is still being drawn, so its leading edge stays open to the pointer.
 */
export function inkOutline(points: readonly InkPoint[], size: number, complete: boolean): number[][] {
  return getStroke(points.map(point => [point.x, point.y]), {
    size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: true,
    start: { taper: true },
    end: { taper: false },
    last: complete,
  });
}

const average = (a: number, b: number) => (a + b) / 2;

/** SVG path data for an outline, smoothed with quadratic curves through the
 * midpoints (getSvgPathFromStroke in the perfect-freehand README). */
export function inkPath(outline: readonly number[][]): string {
  if (outline.length < 4) return '';
  const fixed = (value: number) => value.toFixed(2);
  let [a, b] = outline;
  const c = outline[2];
  let path = `M${fixed(a[0])},${fixed(a[1])} Q${fixed(b[0])},${fixed(b[1])} ${fixed(average(b[0], c[0]))},${fixed(average(b[1], c[1]))} T`;
  for (let i = 2; i < outline.length - 1; i++) {
    a = outline[i];
    b = outline[i + 1];
    path += `${fixed(average(a[0], b[0]))},${fixed(average(a[1], b[1]))} `;
  }
  return `${path}Z`;
}
