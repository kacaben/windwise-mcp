import type { McpServer } from "@modelcontextprotocol/server";
import { FORECAST_CAVEAT } from "../domain/disclaimers.js";
import { inHourRange } from "../domain/time.js";
import { summarizeWindByDay, windRow } from "../domain/wind.js";
import type { WeatherService } from "../openmeteo/client.js";
import {
  READ_ONLY,
  assertHourRange,
  describeLocation,
  endHour,
  forecastDays,
  jsonResult,
  safely,
  startHour,
  withLocation,
} from "./shared.js";

const inputSchema = withLocation({
  days: forecastDays(3),
  start_hour: startHour(0),
  end_hour: endHour(24),
});

export function registerGetWindForecast(server: McpServer, service: WeatherService) {
  server.registerTool(
    "get_wind_forecast",
    {
      title: "Detailed wind forecast",
      description:
        "Hourly wind speed, gusts and direction in knots for up to 7 days, plus a per-day summary " +
        "(average, peak and peak time, strongest gust, prevailing direction). Restrict to daylight with " +
        "start_hour/end_hour (local time). Use this to answer 'when is the wind strongest' questions.",
      inputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ days, start_hour, end_hour, ...where }) => {
      assertHourRange(start_hour, end_hour);
      const location = await service.resolveLocation(where);
      const forecast = await service.getWeather(location, days);

      return jsonResult({
        location: describeLocation(location, forecast.timezone),
        hours: { start: start_hour, end: end_hour, note: "Local time; end is exclusive." },
        daily: summarizeWindByDay(forecast.hours, start_hour, end_hour),
        hourly: forecast.hours
          .filter((h) => inHourRange(h.time, start_hour, end_hour))
          .map(windRow),
        units: { wind: "knots", direction: "where the wind comes FROM" },
        caveat: FORECAST_CAVEAT,
      });
    }),
  );
}
