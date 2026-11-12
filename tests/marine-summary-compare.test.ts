import { describe, expect, it } from "vitest";
import { type LocationScore, rankLocations, sharedGridCells } from "../src/domain/compare.js";
import { assessWaves, summarizeMarineByDay } from "../src/domain/marine.js";
import { sessionVerdict } from "../src/domain/summary.js";
import type { WindWindow } from "../src/domain/wind.js";
import { marineDay } from "./helpers.js";

describe("assessWaves", () => {
  it.each([
    [0.2, null, "flat", true],
    [0.6, 11, "small", true],
    [1.0, 10, "moderate", false],
    [2.0, 12, "large", false],
    [3.0, 14, "very_large", false],
  ] as const)("%d m @ %s s is %s", (height, period, seaState, beginnerFriendly) => {
    expect(assessWaves(height, period)).toMatchObject({ seaState, beginnerFriendly });
  });

  it("rates short-period chop harder than swell of the same height", () => {
    expect(assessWaves(0.6, 12).seaState).toBe("small");
    expect(assessWaves(0.6, 4).seaState).toBe("moderate");
  });
});

describe("summarizeMarineByDay", () => {
  it("rates each day by its biggest waves", () => {
    const hours = marineDay("2026-11-07", 0.5);
    hours[14]!.waveHeightM = 1.2;
    const [day] = summarizeMarineByDay(hours, 9, 18);
    expect(day).toMatchObject({
      date: "2026-11-07",
      maxWaveHeightM: 1.2,
      swellDirection: "W",
      seaTemperatureC: 28,
      assessment: { seaState: "moderate" },
    });
  });
});

const window = (overrides: Partial<WindWindow> = {}): WindWindow => ({
  date: "2026-11-07",
  start: "2026-11-07T12:00",
  end: "2026-11-07T16:00",
  durationHours: 4,
  avgWindKn: 15,
  maxWindKn: 17,
  maxGustKn: 20,
  direction: "W",
  gusty: false,
  ...overrides,
});

describe("sessionVerdict", () => {
  const base = { minWindKn: 12, minWindowHours: 2, thunderstormHours: 0, waves: assessWaves(0.5, 10) };

  it("says go for a solid window and small waves", () => {
    const result = sessionVerdict({ ...base, windows: [window()], maxWindKn: 17 });
    expect(result.verdict).toBe("go");
    expect(result.reasons[0]).toContain("4-hour window 12:00-16:00");
  });

  it("says no_go when the wind never reaches the minimum", () => {
    const result = sessionVerdict({ ...base, windows: [], maxWindKn: 8 });
    expect(result).toMatchObject({ verdict: "no_go" });
    expect(result.reasons[0]).toMatch(/Not enough wind: peaks at 8 kn/);
  });

  it("says no_go when it is too windy", () => {
    const result = sessionVerdict({ ...base, windows: [], maxWindKn: 35, maxWindLimitKn: 25 });
    expect(result.reasons[0]).toMatch(/Too windy/);
  });

  it("says no_go when the wind is in range only in short stretches", () => {
    const result = sessionVerdict({ ...base, windows: [], maxWindKn: 14 });
    expect(result.verdict).toBe("no_go");
    expect(result.reasons[0]).toMatch(/shorter than 2 hours/);
  });

  it("blames the wind direction when strength is right but the direction is excluded (#3)", () => {
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 16,
      rejections: { wrong_direction: 5 },
    });
    expect(result.verdict).toBe("no_go");
    expect(result.reasons[0]).toMatch(/right for 5 hour\(s\), but it blows from a direction you excluded/);
  });

  it("blames short stretches over 'too windy' when some hours are usable (#3)", () => {
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 25,
      maxWindLimitKn: 18,
      usableHours: 1,
      rejections: { too_strong: 3 },
    });
    expect(result.reasons[0]).toMatch(/1 hour\(s\) meet your wind criteria, but never 2 in a row/);
    expect(result.reasons[0]).not.toMatch(/Too windy/);
  });

  it("blames gusts when only the gust limit rejects the hours (#3)", () => {
    const result = sessionVerdict({ ...base, windows: [], maxWindKn: 15, rejections: { too_gusty: 4 } });
    expect(result.reasons[0]).toMatch(/gusts exceed your gust limit/);
  });

  it("flags unknown sea state as marginal when wave data failed to load (#2)", () => {
    const result = sessionVerdict({
      ...base,
      waves: null,
      waveGap: "failed",
      windows: [window()],
      maxWindKn: 17,
    });
    expect(result.verdict).toBe("marginal");
    expect(result.reasons.join(" ")).toMatch(/sea state is unknown/);
  });

  it("only notes missing wave data for inland points, without downgrading (#2)", () => {
    const result = sessionVerdict({
      ...base,
      waves: null,
      waveGap: "inland",
      windows: [window()],
      maxWindKn: 17,
    });
    expect(result.verdict).toBe("go");
    expect(result.reasons.join(" ")).toMatch(/inland or sheltered water/);
  });

  it("is marginal for gusty sessions and big waves", () => {
    expect(sessionVerdict({ ...base, windows: [window({ gusty: true })], maxWindKn: 15 }).verdict).toBe(
      "marginal",
    );
    expect(
      sessionVerdict({ ...base, windows: [window()], maxWindKn: 15, waves: assessWaves(2, 12) }).verdict,
    ).toBe("marginal");
  });

  it("thunderstorms always mean no_go", () => {
    const result = sessionVerdict({ ...base, windows: [window()], maxWindKn: 15, thunderstormHours: 2 });
    expect(result.verdict).toBe("no_go");
  });
});

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
