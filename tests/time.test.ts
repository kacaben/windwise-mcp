import { describe, expect, it } from "vitest";
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
    expect(resolveDay("tomorrow", "2026-11-06")).toBe("2026-11-07");
    expect(resolveDay("tomorrow", "2026-12-31")).toBe("2027-01-01");
    expect(resolveDay("2026-11-10", "2026-11-06")).toBe("2026-11-10");
    expect(() => resolveDay("next friday", "2026-11-06")).toThrow(/Unrecognised day/);
  });
});
