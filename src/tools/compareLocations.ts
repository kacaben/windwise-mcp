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
import { NoMarineDataError } from "../openmeteo/marine.js";
import { compareLocationsOutput as outputSchema } from "./outputs.js";
import {
  daySelector,
  endHour,
  jsonResult,
  READ_ONLY,
  reportError,
  safely,
  settle,
  startHour,
  windCriteriaFields,
  windSearch,
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

interface ScoredLocation extends LocationScore {
  date: string;
  resolvedAs: string;
  gridPoint: string;
  /** Why there is no wave height for this spot, when marine data was asked for but not available. */
  marineGap: string | null;
}

async function scoreLocation(
  service: WeatherService,
  name: string,
  args: Args,
  criteria: WindCriteria,
  signal?: AbortSignal,
): Promise<ScoredLocation> {
  const location = await service.resolveLocation({ location: name });
  const days = forecastDaysFor(args.day);
  // Start the marine request alongside the weather one; it only needs the place and the day count.
  const marineRequest = args.include_marine ? settle(service.getMarine(location, days, signal)) : null;
  const forecast = await service.getWeather(location, { days, cell: "sea" }, signal);
  const date = resolveDay(args.day, dateOf(forecast.hours[0]!.time));
  const session = {
    date,
    startHour: args.start_hour,
    endHour: args.end_hour,
    currentHour: forecast.currentHour,
  };
  const dayHours = selectSessionHours(forecast.hours, session);

  const windows = findWindWindows(dayHours, criteria);

  // Marine data is a bonus here: a spot without it still gets a wind ranking,
  // but the reason is reported, and unexpected errors are logged by reportError.
  let maxWaveHeightM: number | null = null;
  let marineGap: string | null = null;
  const marine = await marineRequest;
  if (marine?.ok) {
    try {
      maxWaveHeightM = max(selectSessionHours(marine.value.hours, session).map((h) => h.waveHeightM));
      if (maxWaveHeightM === null) marineGap = "no wave data for the session hours";
    } catch (error) {
      // The marine forecast may not reach the session (it ends earlier than the weather one).
      marineGap = reportError(error);
    }
  } else if (marine) {
    marineGap =
      marine.error instanceof NoMarineDataError
        ? "no marine data (inland or sheltered water)"
        : reportError(marine.error);
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
    marineGap,
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
    safely(async (args, signal) => {
      const { activity, criteria, windRangeKn } = windSearch(args);

      // One bad place name shouldn't sink the whole comparison.
      const settled = await Promise.allSettled(
        args.locations.map((name) => scoreLocation(service, name, args, criteria, signal)),
      );
      const scores = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failures = settled.flatMap((r, i) =>
        r.status === "rejected" ? [{ location: args.locations[i]!, error: reportError(r.reason) }] : [],
      );
      if (scores.length === 0) {
        throw new ToolInputError(
          `None of the locations could be compared.\n${failures.map((f) => `- ${f.location}: ${f.error}`).join("\n")}`,
        );
      }

      const sameCell = sharedGridCells(scores).map(
        (group) =>
          `${group.join(" and ")} fall in the same forecast-model grid cell, so their forecasts are ` +
          "identical; the model cannot tell them apart. Local knowledge decides between them.",
      );

      // "today" is resolved at each spot, so spots in different time zones can land on different dates.
      const dates = [...new Set(scores.map((s) => s.date))];
      const dateNote =
        dates.length > 1
          ? [
              `The spots are in different time zones, so "${args.day}" means different dates: ` +
                `${scores.map((s) => `${s.location} ${s.date}`).join(", ")}. Compare with an explicit date ` +
                "to rank the same day everywhere.",
            ]
          : [];
      const marineGaps = scores.flatMap((s) =>
        s.marineGap ? [`No wave height for ${s.location}: ${s.marineGap}.`] : [],
      );
      const anyWaves = scores.some((s) => s.maxWaveHeightM !== null);

      return jsonResult(outputSchema, {
        date: dates.length === 1 ? dates[0]! : null,
        hours: { start: args.start_hour, end: args.end_hour },
        activity,
        windRangeKn,
        ranking: rankLocations(scores).map(({ marineGap: _, ...row }) => row),
        ...(failures.length > 0 && { failures }),
        notes: [
          ...dateNote,
          ...sameCell,
          ...marineGaps,
          FORECAST_CAVEAT,
          ...(anyWaves ? [MARINE_CAVEAT] : []),
        ],
      });
    }),
  );
}
