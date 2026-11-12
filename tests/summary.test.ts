import { describe, expect, it } from "vitest";
import { assessWaves } from "../src/domain/marine.js";
import { sessionVerdict } from "../src/domain/summary.js";
import type { WindWindow } from "../src/domain/wind.js";

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

describe("sessionVerdict and bestWindow agree", () => {
  it("cites the stronger of two equally long windows", () => {
    const light = window({
      start: "2026-11-07T10:00",
      end: "2026-11-07T12:00",
      durationHours: 2,
      avgWindKn: 13,
    });
    const strong = window({
      start: "2026-11-07T14:00",
      end: "2026-11-07T16:00",
      durationHours: 2,
      avgWindKn: 19,
    });
    const result = sessionVerdict({
      minWindKn: 12,
      minWindowHours: 2,
      thunderstormHours: 0,
      waves: null,
      windows: [light, strong],
      maxWindKn: 21,
    });
    expect(result.reasons[0]).toBe("2-hour window 14:00-16:00, averaging 19 kn from W.");
  });
});
