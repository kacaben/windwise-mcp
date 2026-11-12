import { describe, expect, it } from "vitest";
import { beaufort, circularMeanDegrees, degreesToCompass } from "../src/domain/units.js";

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
