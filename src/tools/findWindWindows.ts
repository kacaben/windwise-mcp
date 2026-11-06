import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { FORECAST_CAVEAT } from "../domain/disclaimers.js";
import { inHourRange, upcoming } from "../domain/time.js";
import {
  explainRejections,
  findWindWindows,
  type WindCriteria,
  type WindWindow,
  windRow,
} from "../domain/wind.js";
import type { WeatherService } from "../openmeteo/client.js";
import { findWindWindowsOutput as outputSchema } from "./outputs.js";
import {
  assertHourRange,
  compassDirections,
  describeLocation,
  endHour,
  forecastDays,
  jsonResult,
  READ_ONLY,
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
        "Find continuous time windows from now on when the wind matches the criteria: an activity preset " +
        "(e.g. dinghy_sailing) or explicit min/max knots and max gusts, plus allowed directions and " +
        "time of day. Returns each window with its average/peak wind and direction, the best window, " +
        "and, when nothing matches, why each hour was rejected. Use for questions like " +
        "'will there be enough wind for wing foiling tomorrow?' or 'when can I go dinghy sailing this week?'.",
      inputSchema,
      outputSchema,
      annotations: READ_ONLY,
    },
    safely(async (args) => {
      assertHourRange(args.start_hour, args.end_hour);
      const range = windRangeFrom(args);

      const location = await service.resolveLocation(args);
      const forecast = await service.getWeather(location, { days: args.days, cell: "sea" });
      const ahead = upcoming(forecast.hours, forecast.currentHour);

      const criteria: WindCriteria = {
        minWindKn: range.minWindKn,
        maxWindKn: range.maxWindKn,
        maxGustKn: range.maxGustKn,
        startHour: args.start_hour,
        endHour: args.end_hour,
        directions: args.directions,
        minWindowHours: args.min_window_hours,
        excludeThunderstorms: args.exclude_thunderstorms,
      };

      const windows = findWindWindows(ahead, criteria);
      const strongest = ahead
        .filter((h) => inHourRange(h.time, criteria.startHour, criteria.endHour))
        .reduce<(typeof ahead)[number] | null>(
          (best, h) => (h.windKn !== null && (best?.windKn ?? -1) < h.windKn ? h : best),
          null,
        );

      return jsonResult(outputSchema, {
        location: describeLocation(location, forecast.timezone),
        criteria: {
          activity: range.activity,
          windRangeKn: {
            min: range.minWindKn,
            max: range.maxWindKn ?? null,
            maxGust: range.maxGustKn ?? null,
            minWindowHours: args.min_window_hours,
          },
          startHour: args.start_hour,
          endHour: args.end_hour,
          days: args.days,
          directions: args.directions ?? null,
          excludeThunderstorms: args.exclude_thunderstorms,
        },
        found: windows.length > 0,
        windowCount: windows.length,
        totalRideableHours: windows.reduce((sum, w) => sum + w.durationHours, 0),
        bestWindow: bestWindow(windows),
        windows,
        ...(windows.length === 0 && {
          whyNoWindows: explainRejections(ahead, criteria),
          strongestHourInRange: strongest ? windRow(strongest) : null,
        }),
        notes: [
          `Only hours from now on (local ${forecast.currentHour.slice(11)}) are considered; window end is exclusive.`,
          "Direction is where the wind comes FROM.",
          FORECAST_CAVEAT,
        ],
      });
    }),
  );
}
