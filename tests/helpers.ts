import type { MarineForecast, WeatherForecast, WeatherService } from "../src/openmeteo/client.js";
import type { MarineHour } from "../src/openmeteo/marine.js";
import type { WeatherHour } from "../src/openmeteo/forecast.js";

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

/** A WeatherService backed by in-memory data, for testing tools without the network. */
export function fakeService(options: {
  weather: WeatherHour[];
  marine?: MarineHour[] | Error;
  /** Grid point returned per location name, to simulate different model cells. */
  grid?: Record<string, [number, number]>;
}): WeatherService {
  return {
    async resolveLocation(input) {
      if (input.latitude !== undefined && input.longitude !== undefined) {
        return { name: input.location ?? "point", latitude: input.latitude, longitude: input.longitude, source: "coordinates" };
      }
      if (input.location === "Nowhere") throw new Error('Could not find a place called "Nowhere".');
      const [latitude, longitude] = options.grid?.[input.location!] ?? [20.758, -105.336];
      return { name: input.location!, latitude, longitude, country: "Mexico", source: "geocoded" };
    },
    async getWeather(location): Promise<WeatherForecast> {
      const first = options.weather[0]!;
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: "America/Bahia_Banderas",
        currentTime: `${first.time.slice(0, 10)}T10:15`,
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
