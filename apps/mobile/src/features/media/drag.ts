/**
 * The arithmetic of dragging a tile across the photo grid (#179): which slot
 * the finger is over, where every other tile stands meanwhile, and the order a
 * drop leaves. Pure, so the gesture code of useDragOrder stays thin.
 */

/** A tile's place in the grid, as onLayout reports it: relative to the grid's top left. */
export type Box = { x: number; y: number; width: number; height: number };

/** The slot whose box holds the point, or null in a gap or off the grid. */
export function slotAt(boxes: ReadonlyArray<Box | undefined>, x: number, y: number): number | null {
  const found = boxes.findIndex(
    (box) =>
      box !== undefined &&
      x >= box.x &&
      x < box.x + box.width &&
      y >= box.y &&
      y < box.y + box.height,
  );
  return found === -1 ? null : found;
}

/**
 * The slot the tile of `index` stands in while the tile lifted from `from`
 * hovers over `to`: the tiles between the two step aside by one, the rest
 * stay, and the lifted one is over `to`.
 */
export function slotWhile(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < index && index <= to) return index - 1;
  if (to <= index && index < from) return index + 1;
  return index;
}

/** The items with the one at `from` placed at `to`, the others keeping their order. */
export function placed<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
