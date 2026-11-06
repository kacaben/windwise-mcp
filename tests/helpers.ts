import type {
  ForecastRequest,
  MarineForecast,
  WeatherForecast,
  WeatherService,
} from "../src/openmeteo/client.js";
import type { WeatherHour } from "../src/openmeteo/forecast.js";
import { LocationNotFoundError } from "../src/openmeteo/geocoding.js";
import type { MarineHour } from "../src/openmeteo/marine.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** Build 24 hourly rows for a date; `wind[h]` is the wind at hour h (missing = 0 kn). */
export function weatherDay(
  date: string,
  wind: Partial<Record<number, number>>,
  overrides: Partial<Omit<WeatherHour, "time">> = {},
): WeatherHour[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const windKn = wind[hour] ?? 0;
    return {
      time: `${date}T${pad(hour)}:00`,
      temperatureC: 26,
      feelsLikeC: 27,
      precipitationProbabilityPct: 0,
      precipitationMm: 0,
      cloudCoverPct: 10,
      weatherCode: 0,
      windKn,
      gustKn: windKn + 4,
      windDirectionDeg: 270,
      ...overrides,
    };
  });
}

export function marineDay(date: string, waveHeightM: number, periodS = 10): MarineHour[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    time: `${date}T${pad(hour)}:00`,
    waveHeightM,
    waveDirectionDeg: 280,
    wavePeriodS: periodS,
    windWaveHeightM: 0.2,
    swellHeightM: waveHeightM,
    swellDirectionDeg: 280,
    swellPeriodS: periodS,
    seaTemperatureC: 28,
    currentKn: 0.2,
    currentDirectionDeg: 90,
  }));
}

/**
 * A WeatherService backed by in-memory data, for testing tools without the network.
 * "Now" defaults to 10:15 local on the first forecast day; `weatherRequests`
 * records what each tool asked for.
 */
export function fakeService(options: {
  weather: WeatherHour[];
  marine?: MarineHour[] | Error;
  /** Grid point returned per location name, to simulate different model cells. */
  grid?: Record<string, [number, number]>;
  /** Local "now", e.g. "2026-11-07T14:20". */
  now?: string;
}): WeatherService & { weatherRequests: ForecastRequest[] } {
  const now = options.now ?? `${options.weather[0]!.time.slice(0, 10)}T10:15`;
  const currentHour = `${now.slice(0, 13)}:00`;
  const weatherRequests: ForecastRequest[] = [];
  return {
    weatherRequests,
    async resolveLocation(input) {
      if (input.latitude !== undefined && input.longitude !== undefined) {
        return {
          name: input.location ?? "point",
          latitude: input.latitude,
          longitude: input.longitude,
          source: "coordinates",
        };
      }
      if (input.location === "Nowhere") throw new LocationNotFoundError("Nowhere");
      const [latitude, longitude] = options.grid?.[input.location!] ?? [20.758, -105.336];
      return { name: input.location!, latitude, longitude, country: "Mexico", source: "geocoded" };
    },
    async getWeather(location, request): Promise<WeatherForecast> {
      weatherRequests.push(request);
      const first = options.weather[0]!;
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: "America/Bahia_Banderas",
        currentTime: now,
        currentHour,
        current: { ...first },
        hours: options.weather,
      };
    },
    async getMarine(location): Promise<MarineForecast> {
      if (options.marine instanceof Error) throw options.marine;
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: "America/Bahia_Banderas",
        currentHour,
        hours: options.marine ?? [],
      };
    },
  };
}

/** Minimal Response stand-in for fetch fakes. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
