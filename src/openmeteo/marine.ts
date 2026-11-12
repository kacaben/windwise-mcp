import * as z from "zod";
import { localHourNow } from "../domain/time.js";
import { columnsToRows } from "./columns.js";
import { getJson, type HttpOptions } from "./http.js";
import { hourlyColumns, parseResponse } from "./schemas.js";

const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

const HOURLY_VARIABLES = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "wind_wave_height",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "sea_surface_temperature",
  "ocean_current_velocity",
  "ocean_current_direction",
] as const;

/** One marine forecast hour. Heights in metres, periods in seconds, currents in knots. */
export interface MarineHour {
  time: string;
  waveHeightM: number | null;
  waveDirectionDeg: number | null;
  wavePeriodS: number | null;
  windWaveHeightM: number | null;
  swellHeightM: number | null;
  swellDirectionDeg: number | null;
  swellPeriodS: number | null;
  seaTemperatureC: number | null;
  currentKn: number | null;
  currentDirectionDeg: number | null;
}

export interface MarineForecast {
  latitude: number;
  longitude: number;
  timezone: string;
  /** Start of the current local hour; hours before it have already passed. */
  currentHour: string;
  hours: MarineHour[];
}

const marineResponse = z.object({
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  utc_offset_seconds: z.number(),
  hourly: hourlyColumns(HOURLY_VARIABLES),
});

export class NoMarineDataError extends Error {
  constructor() {
    super(
      "Open-Meteo has no marine data for this point. It is probably inland or too far " +
        "inside a bay; try coordinates slightly offshore.",
    );
    this.name = "NoMarineDataError";
  }
}

export async function fetchMarineForecast(
  coords: { latitude: number; longitude: number },
  days: number,
  http: HttpOptions = {},
  signal?: AbortSignal,
): Promise<MarineForecast> {
  const body = await getJson<unknown>(
    MARINE_URL,
    {
      latitude: coords.latitude,
      longitude: coords.longitude,
      hourly: HOURLY_VARIABLES,
      // Also applies to ocean_current_velocity.
      wind_speed_unit: "kn",
      timezone: "auto",
      forecast_days: days,
    },
    http,
    signal,
  );
  const response = parseResponse(marineResponse, body, "marine");

  const hours = columnsToRows(response.hourly, HOURLY_VARIABLES).map(
    (row): MarineHour => ({
      time: row.time,
      waveHeightM: row.wave_height,
      waveDirectionDeg: row.wave_direction,
      wavePeriodS: row.wave_period,
      windWaveHeightM: row.wind_wave_height,
      swellHeightM: row.swell_wave_height,
      swellDirectionDeg: row.swell_wave_direction,
      swellPeriodS: row.swell_wave_period,
      seaTemperatureC: row.sea_surface_temperature,
      currentKn: row.ocean_current_velocity,
      currentDirectionDeg: row.ocean_current_direction,
    }),
  );

  // Inland points come back as a full time axis of nulls rather than an error.
  if (hours.every((hour) => hour.waveHeightM === null)) throw new NoMarineDataError();

  return {
    latitude: response.latitude,
    longitude: response.longitude,
    timezone: response.timezone,
    // The marine API has no "current" block, so derive local now from the offset.
    currentHour: localHourNow(response.utc_offset_seconds),
    hours,
  };
}
