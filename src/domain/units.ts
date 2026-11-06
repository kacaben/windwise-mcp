export const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** Meteorological convention: the direction the wind is coming FROM. */
export function degreesToCompass(degrees: number): CompassPoint {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16]!;
}

/**
 * Average of angles. A plain mean of 350° and 10° is 180° (wrong);
 * averaging unit vectors gives 0° (right).
 */
export function circularMeanDegrees(degrees: readonly number[]): number | null {
  if (degrees.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const deg of degrees) {
    const rad = (deg * Math.PI) / 180;
    x += Math.cos(rad);
    y += Math.sin(rad);
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return null;
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Upper bound (exclusive, knots) of each Beaufort force 0-11. Force 4 is 11-16 kn, etc. */
const BEAUFORT: ReadonlyArray<[belowKn: number, description: string]> = [
  [1, "calm"],
  [4, "light air"],
  [7, "light breeze"],
  [11, "gentle breeze"],
  [17, "moderate breeze"],
  [22, "fresh breeze"],
  [28, "strong breeze"],
  [34, "near gale"],
  [41, "gale"],
  [48, "strong gale"],
  [56, "storm"],
  [64, "violent storm"],
];

export function beaufort(knots: number): { force: number; description: string } {
  const index = BEAUFORT.findIndex(([belowKn]) => knots < belowKn);
  return index === -1
    ? { force: 12, description: "hurricane force" }
    : { force: index, description: BEAUFORT[index]![1] };
}

export const KMH_PER_KNOT = 1.852;
export const knotsToKmh = (knots: number) => knots * KMH_PER_KNOT;
export const kmhToKnots = (kmh: number) => kmh / KMH_PER_KNOT;

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
