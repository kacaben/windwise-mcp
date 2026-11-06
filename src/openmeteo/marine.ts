import { columnsToRows, type Columns } from "./columns.js";
import { getJson, type HttpOptions } from "./http.js";

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
  hours: MarineHour[];
}

interface MarineResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  hourly: Columns;
}

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
): Promise<MarineForecast> {
  const response = await getJson<MarineResponse>(
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
  );

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
    hours,
  };
}
