import { describe, expect, it } from "vitest";
import { selectSessionHours } from "../src/domain/session.js";
import {
  addDays,
  addHours,
  floorToHour,
  forecastDaysFor,
  inHourRange,
  localHourNow,
  resolveDay,
  upcoming,
} from "../src/domain/time.js";
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

  it("finds the current local hour from a UTC offset and drops past hours", () => {
    const now = new Date("2026-11-06T22:35:00Z");
    expect(localHourNow(-6 * 3600, now)).toBe("2026-11-06T16:00");
    expect(localHourNow(10 * 3600, now)).toBe("2026-11-07T08:00");
    expect(floorToHour("2026-11-06T16:45")).toBe("2026-11-06T16:00");
    const hours = ["2026-11-06T15:00", "2026-11-06T16:00", "2026-11-06T17:00"].map((time) => ({ time }));
    expect(upcoming(hours, "2026-11-06T16:00").map((h) => h.time)).toEqual([
      "2026-11-06T16:00",
      "2026-11-06T17:00",
    ]);
  });

  it("requests only as many forecast days as a day needs", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(forecastDaysFor("today", now)).toBe(1);
    expect(forecastDaysFor("tomorrow", now)).toBe(2);
    expect(forecastDaysFor("2026-11-09", now)).toBe(5); // 3 days ahead + today + 1 day of time-zone slack
    expect(forecastDaysFor("2026-12-31", now)).toBe(16);
    expect(forecastDaysFor("2026-11-01", now)).toBe(1);
  });

  it("resolves day names relative to the forecast's own today", () => {
    expect(resolveDay("today", "2026-11-06")).toBe("2026-11-06");
    expect(resolveDay("Tomorrow", "2026-11-06")).toBe("2026-11-07");
    expect(resolveDay("2026-11-10", "2026-11-06")).toBe("2026-11-10");
    expect(() => resolveDay("next friday", "2026-11-06")).toThrow(/Unrecognised day/);
  });
});

describe("selectSessionHours", () => {
  const hours = ["2026-11-06", "2026-11-07"].flatMap((date) =>
    Array.from({ length: 24 }, (_, h) => ({ time: `${date}T${String(h).padStart(2, "0")}:00` })),
  );
  const session = { startHour: 9, endHour: 18 };

  it("keeps only the remaining hours of today's session", () => {
    const today = selectSessionHours(hours, {
      ...session,
      date: "2026-11-06",
      currentHour: "2026-11-06T14:00",
    });
    expect(today.map((h) => h.time.slice(11))).toEqual(["14:00", "15:00", "16:00", "17:00"]);
  });

  it("explains when today's session is already over", () => {
    expect(() =>
      selectSessionHours(hours, { ...session, date: "2026-11-06", currentHour: "2026-11-06T19:00" }),
    ).toThrow(
      'The 09:00-18:00 session on 2026-11-06 is already over (local time now 19:00). Try day "tomorrow"',
    );
  });

  it("explains when the date is outside the forecast", () => {
    expect(() =>
      selectSessionHours(hours, { ...session, date: "2026-11-20", currentHour: "2026-11-06T08:00" }),
    ).toThrow("No forecast for 2026-11-20; the forecast covers 2026-11-06 to 2026-11-07.");
  });
});
