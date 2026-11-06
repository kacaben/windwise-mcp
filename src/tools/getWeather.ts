import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { FORECAST_CAVEAT } from "../domain/disclaimers.js";
import { degreesToCompass } from "../domain/units.js";
import { describeWeatherCode } from "../domain/weatherCodes.js";
import type { WeatherService } from "../openmeteo/client.js";
import { READ_ONLY, describeLocation, jsonResult, safely, withLocation } from "./shared.js";

const inputSchema = withLocation({
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("How many hours ahead to return, starting from the current hour (1-168)."),
});

export function registerGetWeather(server: McpServer, service: WeatherService) {
  server.registerTool(
    "get_weather",
    {
      title: "Current weather and hourly forecast",
      description:
        "Current conditions plus an hourly forecast (temperature, rain, cloud, wind) for a place. " +
        "Use for general 'what's the weather' questions. Wind is in knots, times are local to the location. " +
        "For wind-sport planning prefer get_wind_forecast or find_wind_windows.",
      inputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ hours, ...where }) => {
      const location = await service.resolveLocation(where);
      const days = Math.min(16, Math.ceil(hours / 24) + 1);
      const forecast = await service.getWeather(location, days);

      const currentHour = `${forecast.currentTime.slice(0, 13)}:00`;
      const upcoming = forecast.hours.filter((h) => h.time >= currentHour).slice(0, hours);
      const c = forecast.current;

      return jsonResult({
        location: describeLocation(location, forecast.timezone),
        current: {
          time: forecast.currentTime,
          conditions: describeWeatherCode(c.weatherCode),
          temperatureC: c.temperatureC,
          feelsLikeC: c.feelsLikeC,
          cloudCoverPct: c.cloudCoverPct,
          precipitationMm: c.precipitationMm,
          windKn: c.windKn,
          gustKn: c.gustKn,
          windDirection: c.windDirectionDeg === null ? null : degreesToCompass(c.windDirectionDeg),
        },
        hourly: upcoming.map((h) => ({
          time: h.time,
          conditions: describeWeatherCode(h.weatherCode),
          temperatureC: h.temperatureC,
          rainChancePct: h.precipitationProbabilityPct,
          precipitationMm: h.precipitationMm,
          cloudCoverPct: h.cloudCoverPct,
          windKn: h.windKn,
          gustKn: h.gustKn,
          windDirection: h.windDirectionDeg === null ? null : degreesToCompass(h.windDirectionDeg),
        })),
        units: { wind: "knots", temperature: "°C", precipitation: "mm" },
        caveat: FORECAST_CAVEAT,
      });
    }),
  );
}
