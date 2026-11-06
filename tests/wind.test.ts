import { describe, expect, it } from "vitest";
import {
  explainRejections,
  findWindWindows,
  summarizeWindByDay,
  type WindCriteria,
} from "../src/domain/wind.js";
import { weatherDay } from "./helpers.js";

const criteria = (overrides: Partial<WindCriteria> = {}): WindCriteria => ({
  minWindKn: 12,
  startHour: 9,
  endHour: 18,
  minWindowHours: 1,
  excludeThunderstorms: true,
  ...overrides,
});

describe("findWindWindows", () => {
  it("groups consecutive matching hours into windows", () => {
    const hours = weatherDay("2026-11-07", { 11: 13, 12: 15, 13: 17, 14: 14, 16: 12 });
    const windows = findWindWindows(hours, criteria());

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      date: "2026-11-07",
      start: "2026-11-07T11:00",
      end: "2026-11-07T15:00",
      durationHours: 4,
      avgWindKn: 14.8,
      maxWindKn: 17,
      maxGustKn: 21,
      direction: "W",
      gusty: false,
    });
    expect(windows[1]).toMatchObject({ start: "2026-11-07T16:00", end: "2026-11-07T17:00", durationHours: 1 });
  });

  it("only considers the requested hours (end hour exclusive)", () => {
    const hours = weatherDay("2026-11-07", { 7: 20, 8: 20, 17: 20, 18: 20 });
    const windows = findWindWindows(hours, criteria());
    expect(windows).toEqual([expect.objectContaining({ start: "2026-11-07T17:00", durationHours: 1 })]);
  });

  it("applies max wind and max gust limits", () => {
    const hours = weatherDay("2026-11-07", { 10: 14, 11: 26, 12: 14 });
    hours[12]!.gustKn = 30;
    const windows = findWindWindows(hours, criteria({ maxWindKn: 22, maxGustKn: 25 }));
    expect(windows.map((w) => w.start)).toEqual(["2026-11-07T10:00"]);
  });

  it("filters by wind direction", () => {
    const hours = weatherDay("2026-11-07", { 10: 15, 11: 15, 12: 15 });
    hours[11]!.windDirectionDeg = 90; // easterly (offshore for a west-facing beach)
    const windows = findWindWindows(hours, criteria({ directions: ["W", "WSW", "WNW"] }));
    expect(windows.map((w) => w.durationHours)).toEqual([1, 1]);
  });

  it("drops windows shorter than minWindowHours", () => {
    const hours = weatherDay("2026-11-07", { 10: 15, 13: 15, 14: 15 });
    const windows = findWindWindows(hours, criteria({ minWindowHours: 2 }));
    expect(windows).toEqual([expect.objectContaining({ start: "2026-11-07T13:00", durationHours: 2 })]);
  });

  it("never counts thunderstorm hours", () => {
    const hours = weatherDay("2026-11-07", { 10: 18, 11: 18, 12: 18 });
    hours[11]!.weatherCode = 95;
    expect(findWindWindows(hours, criteria()).map((w) => w.durationHours)).toEqual([1, 1]);
    expect(findWindWindows(hours, criteria({ excludeThunderstorms: false }))[0]!.durationHours).toBe(3);
  });

  it("joins hours across midnight only when they are truly contiguous", () => {
    const hours = [
      ...weatherDay("2026-11-07", { 23: 15 }),
      ...weatherDay("2026-11-08", { 0: 15 }),
    ];
    const windows = findWindWindows(hours, criteria({ startHour: 0, endHour: 24 }));
    // 23:00 -> 00:00 is contiguous in time, so this is one window spanning midnight.
    expect(windows).toEqual([
      expect.objectContaining({ start: "2026-11-07T23:00", end: "2026-11-08T01:00", durationHours: 2 }),
    ]);

    const daytime = findWindWindows(
      [...weatherDay("2026-11-07", { 17: 15 }), ...weatherDay("2026-11-08", { 9: 15 })],
      criteria(),
    );
    expect(daytime).toHaveLength(2);
  });

  it("flags gusty windows", () => {
    const hours = weatherDay("2026-11-07", { 12: 12, 13: 12 });
    hours[13]!.gustKn = 25;
    expect(findWindWindows(hours, criteria())[0]!.gusty).toBe(true);
  });

  it("treats missing data as non-matching rather than crashing", () => {
    const hours = weatherDay("2026-11-07", { 10: 15, 11: 15 });
    hours[10]!.windKn = null;
    expect(findWindWindows(hours, criteria())).toEqual([
      expect.objectContaining({ start: "2026-11-07T11:00", durationHours: 1 }),
    ]);
  });
});

describe("explainRejections", () => {
  it("counts why in-range hours failed", () => {
    const hours = weatherDay("2026-11-07", { 9: 5, 10: 30, 11: 15 });
    hours[11]!.weatherCode = 96;
    expect(explainRejections(hours, criteria({ maxWindKn: 25 }))).toEqual({
      too_light: 7, // 09:00 plus the six calm hours 12:00-17:00
      too_strong: 1,
      thunderstorm: 1,
    });
  });
});

describe("summarizeWindByDay", () => {
  it("summarises each day within the hour range", () => {
    const hours = [
      ...weatherDay("2026-11-07", { 10: 8, 14: 16, 20: 30 }),
      ...weatherDay("2026-11-08", { 12: 11 }),
    ];
    const [day1, day2] = summarizeWindByDay(hours, 9, 18);
    expect(day1).toMatchObject({
      date: "2026-11-07",
      maxWindKn: 16, // the 30 kn at 20:00 is outside the range
      maxGustKn: 20,
      peakTime: "2026-11-07T14:00",
      direction: "W",
      peakBeaufort: "moderate breeze",
    });
    expect(day2).toMatchObject({ date: "2026-11-08", maxWindKn: 11 });
  });
});
