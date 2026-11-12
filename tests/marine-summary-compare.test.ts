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

  it.each([
    [0.6, "small", "moderate"],
    [1.0, "moderate", "large"],
    [2.0, "large", "very_large"],
    [3.0, "very_large", "very_large"], // already the roughest level
  ] as const)("rates %d m of short-period chop one level above swell", (height, swell, chop) => {
    expect(assessWaves(height, 12).seaState).toBe(swell);
    expect(assessWaves(height, 4).seaState).toBe(chop);
  });

  it("says when the rating comes from chop", () => {
    expect(assessWaves(1.0, 4).note).toMatch(/^Short-period chop \(1 m\)\. Large waves/);
    expect(assessWaves(1.0, 10).note).not.toMatch(/chop/);
  });

  it("does not treat small or long-period waves as chop", () => {
    expect(assessWaves(0.4, 3).seaState).toBe("small"); // below the chop height
    expect(assessWaves(0.6, 6).seaState).toBe("small"); // 6 s is not short-period
    expect(assessWaves(0.2, 3).seaState).toBe("flat");
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

  it("rates each hour with its own period, so short chop can outrank taller swell", () => {
    const hours = marineDay("2026-11-07", 0.5, 12);
    // 1.4 m of long swell at 10:00 is "moderate"; 1.0 m of 4 s chop at 15:00 is "large".
    hours[10]!.waveHeightM = 1.4;
    hours[15]!.waveHeightM = 1.0;
    hours[15]!.wavePeriodS = 4;
    const [day] = summarizeMarineByDay(hours, 9, 18);
    expect(day).toMatchObject({ maxWaveHeightM: 1.4, assessment: { seaState: "large" } });
  });

  it("has no assessment for a day without wave data", () => {
    const hours = marineDay("2026-11-07", 0.5).map((h) => ({ ...h, waveHeightM: null }));
    expect(summarizeMarineByDay(hours)[0]!.assessment).toBeNull();
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

  it("blames the wind direction when strength is right but the direction is excluded", () => {
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 16,
      rejections: { wrong_direction: 5 },
    });
    expect(result.verdict).toBe("no_go");
    expect(result.reasons[0]).toMatch(/right for 5 hour\(s\), but it blows from a direction you excluded/);
  });

  it("blames short stretches over 'too windy' when some hours are usable", () => {
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

  it("blames gusts when only the gust limit rejects the hours", () => {
    const result = sessionVerdict({ ...base, windows: [], maxWindKn: 15, rejections: { too_gusty: 4 } });
    expect(result.reasons[0]).toMatch(/gusts exceed your gust limit/);
  });

  it("leads with the reason that rejected the most hours, and lists the rest", () => {
    // One gusty hour must not hide eight calm ones.
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 13,
      rejections: { too_light: 8, too_gusty: 1 },
    });
    expect(result.reasons[0]).toBe(
      "Mostly not enough wind: 8 hour(s) are below the 12 kn minimum. Other hours: 1 too gusty.",
    );
  });

  it("breaks ties with the more specific reason", () => {
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 15,
      rejections: { too_light: 3, wrong_direction: 3 },
    });
    expect(result.reasons[0]).toMatch(
      /^The wind strength is right for 3 hour\(s\).*Other hours: 3 too light\.$/,
    );
  });

  it("explains a session ruled out only by thunderstorms", () => {
    const result = sessionVerdict({
      ...base,
      windows: [],
      maxWindKn: 15,
      thunderstormHours: 9,
      rejections: { thunderstorm: 9 },
    });
    expect(result.reasons).toEqual([
      "Thunderstorms forecast in 9 of the session hours.",
      "Every hour that could count has thunderstorms forecast.",
      expect.any(String), // the wave note
    ]);
  });

  it("flags unknown sea state as marginal when wave data failed to load", () => {
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

  it("only notes missing wave data for inland points, without downgrading", () => {
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
