import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { FORECAST_CAVEAT } from "../domain/disclaimers.js";
import { inHourRange } from "../domain/time.js";
import {
  explainRejections,
  findWindWindows,
  windRow,
  type WindCriteria,
  type WindWindow,
} from "../domain/wind.js";
import type { WeatherService } from "../openmeteo/client.js";
import {
  READ_ONLY,
  assertHourRange,
  compassDirections,
  describeLocation,
  endHour,
  forecastDays,
  jsonResult,
  safely,
  startHour,
  windCriteriaFields,
  windRangeFrom,
  withLocation,
} from "./shared.js";

const inputSchema = withLocation({
  ...windCriteriaFields,
  start_hour: startHour(9),
  end_hour: endHour(18),
  days: forecastDays(3),
  directions: compassDirections,
  min_window_hours: z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(2)
    .describe("Ignore windows shorter than this many hours."),
  exclude_thunderstorms: z
    .boolean()
    .default(true)
    .describe("Never count hours with forecast thunderstorms as rideable."),
});

/** Longest window wins; ties go to the stronger average wind. */
export function bestWindow(windows: readonly WindWindow[]): WindWindow | null {
  return windows.reduce<WindWindow | null>(
    (best, w) =>
      !best ||
      w.durationHours > best.durationHours ||
      (w.durationHours === best.durationHours && w.avgWindKn > best.avgWindKn)
        ? w
        : best,
    null,
  );
}

export function registerFindWindWindows(server: McpServer, service: WeatherService) {
  server.registerTool(
    "find_wind_windows",
    {
      title: "Find rideable wind windows",
      description:
        "Find continuous time windows when the wind matches the criteria: an activity preset " +
        "(e.g. dinghy_sailing) or explicit min/max knots and max gusts, plus allowed directions and " +
        "time of day. Returns each window with its average/peak wind and direction, the best window, " +
        "and, when nothing matches, why each hour was rejected. Use for questions like " +
        "'will there be enough wind for wing foiling tomorrow?' or 'when can I go dinghy sailing this week?'.",
      inputSchema,
      annotations: READ_ONLY,
    },
    safely(async (args) => {
      const { location: _l, latitude: _a, longitude: _o, ...rest } = args;
      assertHourRange(rest.start_hour, rest.end_hour);
      const range = windRangeFrom(rest);

      const location = await service.resolveLocation(args);
      const forecast = await service.getWeather(location, rest.days);

      const criteria: WindCriteria = {
        minWindKn: range.minWindKn,
        maxWindKn: range.maxWindKn,
        maxGustKn: range.maxGustKn,
        startHour: rest.start_hour,
        endHour: rest.end_hour,
        directions: rest.directions,
        minWindowHours: rest.min_window_hours,
        excludeThunderstorms: rest.exclude_thunderstorms,
      };

      const windows = findWindWindows(forecast.hours, criteria);
      const inRange = forecast.hours.filter((h) =>
        inHourRange(h.time, criteria.startHour, criteria.endHour),
      );
      const strongest = inRange.reduce<(typeof inRange)[number] | null>(
        (best, h) => (h.windKn !== null && (best?.windKn ?? -1) < h.windKn ? h : best),
        null,
      );

      return jsonResult({
        location: describeLocation(location, forecast.timezone),
        criteria: {
          activity: range.activity,
          minWindKn: range.minWindKn,
          maxWindKn: range.maxWindKn ?? null,
          maxGustKn: range.maxGustKn ?? null,
          startHour: rest.start_hour,
          endHour: rest.end_hour,
          days: rest.days,
          directions: rest.directions ?? null,
          minWindowHours: rest.min_window_hours,
          excludeThunderstorms: rest.exclude_thunderstorms,
        },
        found: windows.length > 0,
        windowCount: windows.length,
        totalRideableHours: windows.reduce((sum, w) => sum + w.durationHours, 0),
        bestWindow: bestWindow(windows),
        windows,
        ...(windows.length === 0 && {
          whyNoWindows: explainRejections(forecast.hours, criteria),
          strongestHourInRange: strongest ? windRow(strongest) : null,
        }),
        notes: [
          "Times are local to the location; window end is exclusive.",
          "Direction is where the wind comes FROM.",
          FORECAST_CAVEAT,
        ],
      });
    }),
  );
}
