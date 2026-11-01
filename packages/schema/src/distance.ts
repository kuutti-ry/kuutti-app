import { z } from "zod";

/**
 * How far two homes are, in the only words Kuutti has for it (ADR-061 §5):
 * the straight line between two kept places' centres, said as a band, never
 * in kilometres (ADR-019 §8). The band is written on a round's entry when the
 * entry is, and a card's line reads it from there. A closed list, mirrored in
 * the database's distance_band.
 */
export const DISTANCE_BANDS = ["nearby", "close", "around", "far"] as const;
export const DistanceBand = z.enum(DISTANCE_BANDS).meta({ id: "DistanceBand" });
export type DistanceBand = z.infer<typeof DistanceBand>;

/** What a distance filter may accept (ADR-061 §7): `far` accepted is no filter. */
export const DISTANCE_FILTER_BANDS = ["nearby", "close", "around"] as const;

/** Each band's outer edge in kilometres, from matching_config; far has none. */
export type DistanceEdges = { nearby: number; close: number; around: number };

/**
 * Total over every number and any edges: the panel holds an edge to being a
 * number and no more, so they may stand in any order, and a band left with no
 * width is simply never said. The nearest band whose edge the distance is
 * under wins, so a longer distance never reads as a nearer band.
 */
export function distanceBand(km: number, edges: DistanceEdges): DistanceBand {
  if (km < edges.nearby) return "nearby";
  if (km < edges.close) return "close";
  if (km < edges.around) return "around";
  return "far";
}
