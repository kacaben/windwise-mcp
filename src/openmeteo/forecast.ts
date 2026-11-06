import { floorToHour } from "../domain/time.js";
import { type Columns, columnsToRows } from "./columns.js";
import { getJson, type HttpOptions } from "./http.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const HOURLY_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "cloud_cover",
  "weather_code",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
] as const;

const CURRENT_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation",
  "cloud_cover",
  "weather_code",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
] as const;

/** One forecast hour. Wind is in knots, temperature in °C, precipitation in mm. */
export interface WeatherHour {
  time: string;
  temperatureC: number | null;
  feelsLikeC: number | null;
  precipitationProbabilityPct: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
  weatherCode: number | null;
  windKn: number | null;
  gustKn: number | null;
  windDirectionDeg: number | null;
}

export interface WeatherForecast {
  latitude: number;
  longitude: number;
  timezone: string;
  /** Local time of the current observation, e.g. "2026-11-06T16:15". */
  currentTime: string;
  /** Start of the current local hour; hours before it have already passed. */
  currentHour: string;
  current: Omit<WeatherHour, "time" | "precipitationProbabilityPct">;
  hours: WeatherHour[];
}

interface ForecastResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current: Record<string, unknown> & { time: string };
  hourly: Columns;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Which model grid cell to use for a coastal point. Open-Meteo defaults to
 * "land"; "sea" picks a neighbouring water cell when there is one (inland
 * points are unaffected), which better represents wind over the water.
 */
export type CellSelection = "land" | "sea";

export interface ForecastRequest {
  days: number;
  cell?: CellSelection;
}

export async function fetchWeatherForecast(
  coords: { latitude: number; longitude: number },
  { days, cell = "land" }: ForecastRequest,
  http: HttpOptions = {},
): Promise<WeatherForecast> {
  const response = await getJson<ForecastResponse>(
    FORECAST_URL,
    {
      latitude: coords.latitude,
      longitude: coords.longitude,
      hourly: HOURLY_VARIABLES,
      current: CURRENT_VARIABLES,
      wind_speed_unit: "kn",
      timezone: "auto",
      forecast_days: days,
      cell_selection: cell,
    },
    http,
  );

  const hours = columnsToRows(response.hourly, HOURLY_VARIABLES).map(
    (row): WeatherHour => ({
      time: row.time,
      temperatureC: row.temperature_2m,
      feelsLikeC: row.apparent_temperature,
      precipitationProbabilityPct: row.precipitation_probability,
      precipitationMm: row.precipitation,
      cloudCoverPct: row.cloud_cover,
      weatherCode: row.weather_code,
      windKn: row.wind_speed_10m,
      gustKn: row.wind_gusts_10m,
      windDirectionDeg: row.wind_direction_10m,
    }),
  );

  const c = response.current;
  return {
    latitude: response.latitude,
    longitude: response.longitude,
    timezone: response.timezone,
    currentTime: c.time,
    currentHour: floorToHour(c.time),
    current: {
      temperatureC: num(c.temperature_2m),
      feelsLikeC: num(c.apparent_temperature),
      precipitationMm: num(c.precipitation),
      cloudCoverPct: num(c.cloud_cover),
      weatherCode: num(c.weather_code),
      windKn: num(c.wind_speed_10m),
      gustKn: num(c.wind_gusts_10m),
      windDirectionDeg: num(c.wind_direction_10m),
    },
    hours,
  };
}
