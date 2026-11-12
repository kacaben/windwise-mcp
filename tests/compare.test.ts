import { describe, expect, it } from "vitest";
import { type LocationScore, rankLocations, sharedGridCells } from "../src/domain/compare.js";

describe("rankLocations", () => {
  const score = (location: string, overrides: Partial<LocationScore>): LocationScore => ({
    location,
    matchingHours: 0,
    longestWindowHours: 0,
    avgWindKn: 10,
    maxGustKn: 15,
    direction: "W",
    maxWaveHeightM: 0.5,
    ...overrides,
  });

  it("prefers more rideable hours, then longer windows, then steadier wind", () => {
    const ranked = rankLocations([
      score("gusty", { matchingHours: 4, longestWindowHours: 4, avgWindKn: 15, maxGustKn: 30 }),
      score("most-hours", { matchingHours: 6, longestWindowHours: 3 }),
      score("steady", { matchingHours: 4, longestWindowHours: 4, avgWindKn: 15, maxGustKn: 18 }),
    ]);
    expect(ranked.map((r) => [r.location, r.rank])).toEqual([
      ["most-hours", 1],
      ["steady", 2],
      ["gusty", 3],
    ]);
  });

  it("falls back to the windier spot when nothing reaches the minimum", () => {
    const ranked = rankLocations([score("calm", { avgWindKn: 3 }), score("breezy", { avgWindKn: 8 })]);
    expect(ranked[0]!.location).toBe("breezy");
  });
});

describe("sharedGridCells", () => {
  it("finds locations that share a forecast grid cell", () => {
    expect(
      sharedGridCells([
        { location: "Bucerias", gridPoint: "20.703,-105.273" },
        { location: "La Cruz", gridPoint: "20.703,-105.273" },
        { location: "Sayulita", gridPoint: "20.869,-105.441" },
      ]),
    ).toEqual([["Bucerias", "La Cruz"]]);
  });
});

describe("rankLocations tie-breakers", () => {
  const tied = (location: string, maxWaveHeightM: number | null): LocationScore => ({
    location,
    matchingHours: 4,
    longestWindowHours: 4,
    avgWindKn: 15,
    maxGustKn: 19,
    direction: "W",
    maxWaveHeightM,
  });

  it("uses smaller waves as the last tie-breaker, with unknown waves last", () => {
    const ranked = rankLocations([tied("big", 1.5), tied("unknown", null), tied("small", 0.4)]);
    expect(ranked.map((r) => r.location)).toEqual(["small", "big", "unknown"]);
  });
});
