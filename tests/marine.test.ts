import { describe, expect, it } from "vitest";
import { assessWaves, summarizeMarineByDay } from "../src/domain/marine.js";
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
