import type { CompassPoint } from "./units.js";

export interface LocationScore {
  location: string;
  /** Hours in the requested range that meet the wind criteria. */
  matchingHours: number;
  /** Length of the longest continuous rideable window. */
  longestWindowHours: number;
  avgWindKn: number | null;
  maxGustKn: number | null;
  direction: CompassPoint | null;
  maxWaveHeightM: number | null;
}

/**
 * Rank locations for a session: most rideable hours first, then the longest
 * continuous window, then steadier wind (smaller gust spread), then calmer water.
 */
export function rankLocations<T extends LocationScore>(scores: readonly T[]): Array<T & { rank: number }> {
  const gustSpread = (s: LocationScore) =>
    s.maxGustKn !== null && s.avgWindKn !== null ? s.maxGustKn - s.avgWindKn : Infinity;

  return [...scores]
    .sort(
      (a, b) =>
        b.matchingHours - a.matchingHours ||
        b.longestWindowHours - a.longestWindowHours ||
        // Nobody reaches the minimum: the windier spot is the better bet.
        (a.matchingHours === 0 ? (b.avgWindKn ?? -1) - (a.avgWindKn ?? -1) : 0) ||
        gustSpread(a) - gustSpread(b) ||
        (a.maxWaveHeightM ?? Infinity) - (b.maxWaveHeightM ?? Infinity),
    )
    .map((score, index) => ({ ...score, rank: index + 1 }));
}

/**
 * Nearby towns often fall in the same weather-model grid cell and get identical
 * forecasts. Ranking them against each other would be noise, so say so.
 */
export function sharedGridCells(
  scores: ReadonlyArray<{ location: string; gridPoint: string }>,
): string[][] {
  const byCell = new Map<string, string[]>();
  for (const { location, gridPoint } of scores) {
    byCell.set(gridPoint, [...(byCell.get(gridPoint) ?? []), location]);
  }
  return [...byCell.values()].filter((group) => group.length > 1);
}
