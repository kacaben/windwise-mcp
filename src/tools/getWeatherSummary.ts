import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { FORECAST_CAVEAT, MARINE_CAVEAT } from "../domain/disclaimers.js";
import { summarizeMarineByDay } from "../domain/marine.js";
import { max, min, sum } from "../domain/stats.js";
import { sessionVerdict } from "../domain/summary.js";
import { dateOf, inHourRange, resolveDay } from "../domain/time.js";
import { findWindWindows, summarizeWindByDay } from "../domain/wind.js";
import { describeWeatherCode, isThunderstorm } from "../domain/weatherCodes.js";
import type { MarineForecast, WeatherService } from "../openmeteo/client.js";
import { bestWindow, windCriteriaFields } from "./findWindWindows.js";
import {
  READ_ONLY,
  assertHourRange,
  compassDirections,
  daySelector,
  describeLocation,
  endHour,
  errorMessage,
  jsonResult,
  safely,
  startHour,
  withLocation,
} from "./shared.js";

const inputSchema = withLocation({
  day: daySelector,
  ...windCriteriaFields,
  min_wind_knots: windCriteriaFields.min_wind_knots.default(12),
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

export function registerGetWeatherSummary(server: McpServer, service: WeatherService) {
  server.registerTool(
    "get_weather_summary",
    {
      title: "Session summary for a day",
      description:
        "One-call briefing for a water-sports day at a place: weather, temperature range, rain and " +
        "thunderstorm risk, wind summary and best wind window, waves and sea state, and a " +
        "go / marginal / no_go verdict with reasons. Combines the weather and marine forecasts. " +
        "Start here for 'should I go out tomorrow?' questions.",
      inputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ day, location: name, latitude, longitude, ...criteriaArgs }) => {
      const { start_hour, end_hour } = criteriaArgs;
      assertHourRange(start_hour, end_hour);

      const location = await service.resolveLocation({ location: name, latitude, longitude });
      const days = day === "today" ? 1 : day === "tomorrow" ? 2 : 16;

      // Weather is required; marine is best-effort (inland spots, lakes).
      const [weather, marineResult] = await Promise.all([
        service.getWeather(location, days),
        service.getMarine(location, days).then(
          (value): { ok: true; value: MarineForecast } => ({ ok: true, value }),
          (error: unknown) => ({ ok: false as const, error: errorMessage(error) }),
        ),
      ]);

      const date = resolveDay(day, dateOf(weather.hours[0]!.time));
      const session = weather.hours.filter(
        (h) => dateOf(h.time) === date && inHourRange(h.time, start_hour, end_hour),
      );
      if (session.length === 0) {
        const last = dateOf(weather.hours[weather.hours.length - 1]!.time);
        throw new RangeError(`No forecast for ${date}; the forecast covers ${dateOf(weather.hours[0]!.time)} to ${last}.`);
      }

      const windows = findWindWindows(session, {
        minWindKn: criteriaArgs.min_wind_knots,
        maxWindKn: criteriaArgs.max_wind_knots,
        maxGustKn: criteriaArgs.max_gust_knots,
        startHour: start_hour,
        endHour: end_hour,
        directions: criteriaArgs.directions,
        minWindowHours: 1,
        excludeThunderstorms: true,
      });
      const wind = summarizeWindByDay(session, start_hour, end_hour)[0] ?? null;
      const marineDay = marineResult.ok
        ? (summarizeMarineByDay(marineResult.value.hours, start_hour, end_hour).find((d) => d.date === date) ?? null)
        : null;
      const thunderstormHours = session.filter((h) => isThunderstorm(h.weatherCode)).length;

      const { verdict, reasons } = sessionVerdict({
        windows,
        maxWindKn: wind?.maxWindKn ?? null,
        minWindKn: criteriaArgs.min_wind_knots,
        maxWindLimitKn: criteriaArgs.max_wind_knots,
        thunderstormHours,
        waves: marineDay?.assessment ?? null,
      });

      return jsonResult({
        location: describeLocation(location, weather.timezone),
        date,
        hours: { start: start_hour, end: end_hour, note: "Local time; end is exclusive." },
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
