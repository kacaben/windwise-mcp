import type { McpServer } from "@modelcontextprotocol/server";
import { MARINE_CAVEAT } from "../domain/disclaimers.js";
import { summarizeMarineByDay } from "../domain/marine.js";
import { inHourRange } from "../domain/time.js";
import { degreesToCompass } from "../domain/units.js";
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
  days: forecastDays(2),
  start_hour: startHour(0),
  end_hour: endHour(24),
});

export function registerGetMarineConditions(server: McpServer, service: WeatherService) {
  server.registerTool(
    "get_marine_conditions",
    {
      title: "Waves, swell and sea temperature",
      description:
        "Marine forecast for a coastal location: wave height and period, swell height/direction/period, " +
        "sea surface temperature and ocean current. Each day includes a sea-state rating and whether it " +
        "is beginner-friendly. Only works for coastal or offshore points; inland places return an error.",
      inputSchema,
      annotations: READ_ONLY,
    },
    safely(async ({ days, start_hour, end_hour, ...where }) => {
      assertHourRange(start_hour, end_hour);
      const location = await service.resolveLocation(where);
      const marine = await service.getMarine(location, days);

      return jsonResult({
        location: describeLocation(location, marine.timezone),
        hours: { start: start_hour, end: end_hour, note: "Local time; end is exclusive." },
        daily: summarizeMarineByDay(marine.hours, start_hour, end_hour),
        hourly: marine.hours
          .filter((h) => inHourRange(h.time, start_hour, end_hour))
          .map((h) => ({
            time: h.time,
            waveHeightM: h.waveHeightM,
            wavePeriodS: h.wavePeriodS,
            swellHeightM: h.swellHeightM,
            swellPeriodS: h.swellPeriodS,
            swellDirection: h.swellDirectionDeg === null ? null : degreesToCompass(h.swellDirectionDeg),
            seaTemperatureC: h.seaTemperatureC,
            currentKn: h.currentKn,
          })),
        units: { height: "m", period: "s", temperature: "°C", current: "knots" },
        caveat: MARINE_CAVEAT,
      });
    }),
  );
}
