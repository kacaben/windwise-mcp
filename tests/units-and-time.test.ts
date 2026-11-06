import { describe, expect, it } from "vitest";
import { addDays, addHours, inHourRange, resolveDay } from "../src/domain/time.js";
import {
  beaufort,
  circularMeanDegrees,
  degreesToCompass,
  kmhToKnots,
  knotsToKmh,
} from "../src/domain/units.js";

describe("degreesToCompass", () => {
  it.each([
    [0, "N"],
    [360, "N"],
    [11, "N"],
    [12, "NNE"],
    [90, "E"],
    [225, "SW"],
    [270, "W"],
    [349, "N"],
    [-90, "W"],
  ] as const)("%d° is %s", (deg, point) => {
    expect(degreesToCompass(deg)).toBe(point);
  });
});

describe("circularMeanDegrees", () => {
  it("averages across north correctly (350° and 10° is north, not south)", () => {
    expect(circularMeanDegrees([350, 10])).toBeCloseTo(0, 5);
  });

  it("returns null for no data or perfectly opposing winds", () => {
    expect(circularMeanDegrees([])).toBeNull();
    expect(circularMeanDegrees([90, 270])).toBeNull();
  });

  it("averages ordinary angles", () => {
    expect(circularMeanDegrees([260, 280])).toBeCloseTo(270, 5);
  });
});

describe("beaufort", () => {
  it("maps knots onto the Beaufort scale", () => {
    expect(beaufort(0)).toEqual({ force: 0, description: "calm" });
    expect(beaufort(10.9)).toEqual({ force: 3, description: "gentle breeze" });
    expect(beaufort(11)).toEqual({ force: 4, description: "moderate breeze" });
    expect(beaufort(16)).toEqual({ force: 4, description: "moderate breeze" });
    expect(beaufort(17)).toEqual({ force: 5, description: "fresh breeze" });
    expect(beaufort(63.9).force).toBe(11);
    expect(beaufort(70).force).toBe(12);
  });
});

describe("unit conversion", () => {
  it("round-trips knots and km/h", () => {
    expect(knotsToKmh(10)).toBeCloseTo(18.52);
    expect(kmhToKnots(knotsToKmh(17))).toBeCloseTo(17);
  });
});

describe("local time helpers", () => {
  it("adds hours across midnight and month ends without touching time zones", () => {
    expect(addHours("2026-11-06T23:00", 1)).toBe("2026-11-07T00:00");
    expect(addHours("2026-11-30T23:00", 2)).toBe("2026-12-01T01:00");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("treats end_hour as exclusive", () => {
    expect(inHourRange("2026-11-06T09:00", 9, 18)).toBe(true);
    expect(inHourRange("2026-11-06T17:00", 9, 18)).toBe(true);
    expect(inHourRange("2026-11-06T18:00", 9, 18)).toBe(false);
    expect(inHourRange("2026-11-06T23:00", 0, 24)).toBe(true);
  });

  it("resolves day names relative to the forecast's own today", () => {
    expect(resolveDay("today", "2026-11-06")).toBe("2026-11-06");
    expect(resolveDay("Tomorrow", "2026-11-06")).toBe("2026-11-07");
    expect(resolveDay("2026-11-10", "2026-11-06")).toBe("2026-11-10");
    expect(() => resolveDay("next friday", "2026-11-06")).toThrow(/Unrecognised day/);
  });
});
