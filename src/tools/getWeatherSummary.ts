import type { McpServer } from "@modelcontextprotocol/server";
import { FORECAST_CAVEAT, MARINE_CAVEAT } from "../domain/disclaimers.js";
import { summarizeMarineByDay } from "../domain/marine.js";
import { selectSessionHours } from "../domain/session.js";
import { max, min, sum } from "../domain/stats.js";
import { sessionVerdict } from "../domain/summary.js";
import { dateOf, forecastDaysFor, resolveDay, upcoming } from "../domain/time.js";
import { describeWeatherCode, isThunderstorm } from "../domain/weatherCodes.js";
import {
  checkHour,
  explainRejections,
  findWindWindows,
  summarizeWindByDay,
  type WindCriteria,
} from "../domain/wind.js";
import type { MarineForecast, WeatherService } from "../openmeteo/client.js";
import { NoMarineDataError } from "../openmeteo/marine.js";
import { bestWindow } from "./findWindWindows.js";
import { getWeatherSummaryOutput as outputSchema } from "./outputs.js";
import {
  assertHourRange,
  compassDirections,
  daySelector,
  describeLocation,
  endHour,
  errorMessage,
  jsonResult,
  READ_ONLY,
  safely,
  startHour,
  windCriteriaFields,
  windRangeFrom,
  withLocation,
} from "./shared.js";

const inputSchema = withLocation({
  day: daySelector,
  ...windCriteriaFields,
  start_hour: startHour(9),
  end_hour: endHour(18),
  directions: compassDirections,
});

/** Most frequent value, used to describe "the" weather for a day. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

type MarineResult = { ok: true; value: MarineForecast } | { ok: false; error: string; inland: boolean };

export function registerGetWeatherSummary(server: McpServer, service: WeatherService) {
  server.registerTool(
    "get_weather_summary",
    {
      title: "Session summary for a day",
      description:
        "One-call briefing for a water-sports day at a place: weather, temperature range, rain and " +
        "thunderstorm risk, wind summary and best wind window, waves and sea state, and a " +
        "go / marginal / no_go verdict with reasons. Combines the weather and marine forecasts. " +
        "For today, only the remaining hours count. Set activity (e.g. dinghy_sailing) to judge the day " +
        "for that wind range. Start here for 'should I go out tomorrow?' questions.",
      inputSchema,
      outputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ day, location: name, latitude, longitude, ...args }) => {
      assertHourRange(args.start_hour, args.end_hour);
      const range = windRangeFrom(args);

      const location = await service.resolveLocation({ location: name, latitude, longitude });
      const days = forecastDaysFor(day);

      // Weather is required; marine is best-effort (inland spots, lakes).
      const [weather, marineResult] = await Promise.all([
        service.getWeather(location, { days, cell: "sea" }),
        service.getMarine(location, days).then<MarineResult, MarineResult>(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({
            ok: false,
            error: errorMessage(error),
            inland: error instanceof NoMarineDataError,
          }),
        ),
      ]);

      const date = resolveDay(day, dateOf(weather.hours[0]!.time));
      const session = selectSessionHours(weather.hours, {
        date,
        startHour: args.start_hour,
        endHour: args.end_hour,
        currentHour: weather.currentHour,
      });

      const criteria: WindCriteria = {
        minWindKn: range.minWindKn,
        maxWindKn: range.maxWindKn,
        maxGustKn: range.maxGustKn,
        startHour: args.start_hour,
        endHour: args.end_hour,
        directions: args.directions,
        minWindowHours: args.min_window_hours,
        excludeThunderstorms: true,
      };
      const windows = findWindWindows(session, criteria);
      const wind = summarizeWindByDay(session, args.start_hour, args.end_hour)[0] ?? null;
      const marineDay = marineResult.ok
        ? (summarizeMarineByDay(
            upcoming(marineResult.value.hours, marineResult.value.currentHour),
            args.start_hour,
            args.end_hour,
          ).find((d) => d.date === date) ?? null)
        : null;
      const thunderstormHours = session.filter((h) => isThunderstorm(h.weatherCode)).length;

      const { verdict, reasons } = sessionVerdict({
        windows,
        minWindowHours: args.min_window_hours,
        maxWindKn: wind?.maxWindKn ?? null,
        minWindKn: range.minWindKn,
        maxWindLimitKn: range.maxWindKn,
        thunderstormHours,
        waves: marineDay?.assessment ?? null,
        // A missing assessment is only harmless for inland points; otherwise sea state is unknown.
        waveGap: marineResult.ok || !marineResult.inland ? "failed" : "inland",
        usableHours: session.filter((h) => checkHour(h, criteria) === null).length,
        rejections: explainRejections(session, criteria),
      });

      return jsonResult(outputSchema, {
        location: describeLocation(location, weather.timezone),
        date,
        hours: {
          start: args.start_hour,
          end: args.end_hour,
          note: `Local time; end is exclusive. Judged from ${session[0]!.time.slice(11)} on.`,
        },
        activity: range.activity,
        windRangeKn: {
          min: range.minWindKn,
          max: range.maxWindKn ?? null,
          maxGust: range.maxGustKn ?? null,
          minWindowHours: args.min_window_hours,
        },
        verdict,
        reasons,
        weather: {
          conditions: describeWeatherCode(mode(session.map((h) => h.weatherCode)) ?? null),
          temperatureMinC: min(session.map((h) => h.temperatureC)),
          temperatureMaxC: max(session.map((h) => h.temperatureC)),
          maxRainChancePct: max(session.map((h) => h.precipitationProbabilityPct)),
          totalPrecipitationMm: sum(session.map((h) => h.precipitationMm)),
          thunderstormHours,
        },
        wind,
        bestWindWindow: bestWindow(windows),
        windWindows: windows,
        marine: marineResult.ok ? marineDay : { unavailable: marineResult.error },
        notes: [FORECAST_CAVEAT, ...(marineResult.ok ? [MARINE_CAVEAT] : [])],
      });
    }),
  );
}
