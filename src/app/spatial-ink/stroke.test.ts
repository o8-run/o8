import { expect, it } from 'vitest';
import { inkOutline, inkPath } from './stroke';

// A left-to-right mark that slows down toward its end, as a hand does.
const mark = Array.from({ length: 24 }, (_, i) => ({ x: 100 + i * (12 - i * 0.4), y: 200 }));
const halfWidthNear = (outline: number[][], x: number) =>
  Math.max(...outline.filter(point => Math.abs(point[0] - x) < 6).map(point => Math.abs(point[1] - 200)));

it('tapers the tail into a fuller head instead of a fixed-width line', () => {
  const outline = inkOutline(mark, 6, true);
  expect(outline.length).toBeGreaterThan(mark.length);
  const tail = halfWidthNear(outline, mark[1].x);
  const head = halfWidthNear(outline, mark[mark.length - 2].x);
  expect(head).toBeGreaterThan(tail * 2);
  expect(head).toBeLessThanOrEqual(3);
});

it('draws the outline as one closed, curved path', () => {
  const path = inkPath(inkOutline(mark, 6, true));
  expect(path.startsWith('M')).toBe(true);
  expect(path).toContain(' Q');
  expect(path.endsWith('Z')).toBe(true);
});

it('leaves too-short outlines to the single-point dot', () => {
  expect(inkPath([])).toBe('');
  expect(inkPath([[0, 0], [1, 1], [2, 2]])).toBe('');
});
