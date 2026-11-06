import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { type LocationScore, rankLocations, sharedGridCells } from "../domain/compare.js";
import { FORECAST_CAVEAT, MARINE_CAVEAT } from "../domain/disclaimers.js";
import { ToolInputError } from "../domain/errors.js";
import { selectSessionHours } from "../domain/session.js";
import { max, mean } from "../domain/stats.js";
import { dateOf, forecastDaysFor, resolveDay } from "../domain/time.js";
import { dominantDirection, findWindWindows, type WindCriteria } from "../domain/wind.js";
import type { WeatherService } from "../openmeteo/client.js";
import { compareLocationsOutput as outputSchema } from "./outputs.js";
import {
  assertHourRange,
  daySelector,
  endHour,
  errorMessage,
  jsonResult,
  READ_ONLY,
  safely,
  startHour,
  windCriteriaFields,
  windRangeFrom,
} from "./shared.js";

const inputSchema = z.object({
  locations: z
    .array(z.string().min(2).max(120))
    .min(2)
    .max(5)
    .describe('2-5 place names to compare, e.g. ["Bucerias, Mexico", "La Cruz de Huanacaxtle"].'),
  day: daySelector,
  ...windCriteriaFields,
  start_hour: startHour(9),
  end_hour: endHour(18),
  include_marine: z
    .boolean()
    .default(true)
    .describe("Also fetch wave height (adds one request per location)."),
});

type Args = z.infer<typeof inputSchema>;

async function scoreLocation(
  service: WeatherService,
  name: string,
  args: Args,
  criteria: WindCriteria,
): Promise<LocationScore & { date: string; resolvedAs: string; gridPoint: string }> {
  const location = await service.resolveLocation({ location: name });
  const days = forecastDaysFor(args.day);
  const forecast = await service.getWeather(location, { days, cell: "sea" });
  const date = resolveDay(args.day, dateOf(forecast.hours[0]!.time));
  const session = {
    date,
    startHour: args.start_hour,
    endHour: args.end_hour,
    currentHour: forecast.currentHour,
  };
  const dayHours = selectSessionHours(forecast.hours, session);

  const windows = findWindWindows(dayHours, criteria);

  let maxWaveHeightM: number | null = null;
  if (args.include_marine) {
    try {
      const marine = await service.getMarine(location, days);
      maxWaveHeightM = max(selectSessionHours(marine.hours, session).map((h) => h.waveHeightM));
    } catch {
      // Marine data is a bonus here; an inland spot still gets a wind ranking.
    }
  }

  return {
    location: name,
    resolvedAs: [location.name, location.region, location.country].filter(Boolean).join(", "),
    date,
    // Open-Meteo snaps requests to the model grid and returns the cell it used.
    gridPoint: `${forecast.latitude.toFixed(3)},${forecast.longitude.toFixed(3)}`,
    matchingHours: windows.reduce((sum, w) => sum + w.durationHours, 0),
    longestWindowHours: Math.max(0, ...windows.map((w) => w.durationHours)),
    avgWindKn: mean(dayHours.map((h) => h.windKn)),
    maxGustKn: max(dayHours.map((h) => h.gustKn)),
    direction: dominantDirection(dayHours),
    maxWaveHeightM,
  };
}

export function registerCompareLocations(server: McpServer, service: WeatherService) {
  server.registerTool(
    "compare_locations",
    {
      title: "Compare spots",
      description:
        "Compare wind (and optionally waves) across 2-5 places for one day and rank them for a session. " +
        "Ranking: most hours in usable windows, then longest continuous window, then steadier wind, " +
        "then smaller waves. Set activity (e.g. dinghy_sailing) to rank for that wind range. " +
        "Use for 'Bucerias or La Cruz tomorrow?' questions.",
      inputSchema,
      outputSchema,
      annotations: READ_ONLY,
    },
    safely(async (args) => {
      assertHourRange(args.start_hour, args.end_hour);
      const range = windRangeFrom(args);
      const criteria: WindCriteria = {
        minWindKn: range.minWindKn,
        maxWindKn: range.maxWindKn,
        maxGustKn: range.maxGustKn,
        startHour: args.start_hour,
        endHour: args.end_hour,
        minWindowHours: args.min_window_hours,
        excludeThunderstorms: true,
      };

      // One bad place name shouldn't sink the whole comparison.
      const settled = await Promise.allSettled(
        args.locations.map((name) => scoreLocation(service, name, args, criteria)),
      );
      const scores = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failures = settled.flatMap((r, i) =>
        r.status === "rejected" ? [{ location: args.locations[i]!, error: errorMessage(r.reason) }] : [],
      );
      if (scores.length === 0) {
        throw new ToolInputError(
          `None of the locations could be compared: ${failures.map((f) => f.error).join(" ")}`,
        );
      }

      const sameCell = sharedGridCells(scores).map(
        (group) =>
          `${group.join(" and ")} fall in the same forecast-model grid cell, so their forecasts are ` +
          "identical; the model cannot tell them apart. Local knowledge decides between them.",
      );

      return jsonResult(outputSchema, {
        date: scores[0]!.date,
        hours: { start: args.start_hour, end: args.end_hour },
        activity: range.activity,
        windRangeKn: {
          min: range.minWindKn,
          max: range.maxWindKn ?? null,
          maxGust: range.maxGustKn ?? null,
          minWindowHours: args.min_window_hours,
        },
        ranking: rankLocations(scores),
        ...(failures.length > 0 && { failures }),
        notes: [...sameCell, FORECAST_CAVEAT, ...(args.include_marine ? [MARINE_CAVEAT] : [])],
      });
    }),
  );
}
