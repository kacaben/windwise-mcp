import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { FORECAST_CAVEAT } from "../domain/disclaimers.js";
import { MAX_FORECAST_DAYS, upcoming } from "../domain/time.js";
import { degreesToCompass } from "../domain/units.js";
import { describeWeatherCode } from "../domain/weatherCodes.js";
import type { WeatherService } from "../openmeteo/client.js";
import { getWeatherOutput as outputSchema } from "./outputs.js";
import { describeLocation, jsonResult, READ_ONLY, safely, withLocation } from "./shared.js";

const inputSchema = withLocation({
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("How many hours ahead to return, starting from the current hour (1-168)."),
});

const compassOrNull = (deg: number | null) => (deg === null ? null : degreesToCompass(deg));

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
      outputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ hours, ...where }) => {
      const location = await service.resolveLocation(where);
      // Land cell: this tool is about the weather in town, not on the water.
      const days = Math.min(MAX_FORECAST_DAYS, Math.ceil(hours / 24) + 1);
      const forecast = await service.getWeather(location, { days, cell: "land" });
      const c = forecast.current;

      return jsonResult(outputSchema, {
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
          windDirection: compassOrNull(c.windDirectionDeg),
        },
        hourly: upcoming(forecast.hours, forecast.currentHour)
          .slice(0, hours)
          .map((h) => ({
            time: h.time,
            conditions: describeWeatherCode(h.weatherCode),
            temperatureC: h.temperatureC,
            rainChancePct: h.precipitationProbabilityPct,
            precipitationMm: h.precipitationMm,
            cloudCoverPct: h.cloudCoverPct,
            windKn: h.windKn,
            gustKn: h.gustKn,
            windDirection: compassOrNull(h.windDirectionDeg),
          })),
        units: { wind: "knots", temperature: "°C", precipitation: "mm" },
        caveat: FORECAST_CAVEAT,
      });
    }),
  );
}
