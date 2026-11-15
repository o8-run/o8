/** Desktop points beyond any real display arrangement, and the largest frame
 * the classic shell gives the dictation HUD (820×220 today). */
export const PLACEMENT_LIMITS = { origin: 100_000, width: 2048, height: 1024 };

/** A finite HUD rectangle within the limits; the route and the page both enforce it. */
export function validPlacement(value: { x: unknown; y: unknown; width: unknown; height: unknown }): boolean {
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))) return false;
  const [px, py, w, h] = [x, y, width, height] as number[];
  return Math.abs(px) <= PLACEMENT_LIMITS.origin && Math.abs(py) <= PLACEMENT_LIMITS.origin
    && w > 0 && w <= PLACEMENT_LIMITS.width && h > 0 && h <= PLACEMENT_LIMITS.height;
}
