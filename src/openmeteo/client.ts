import { fetchWeatherForecast, type WeatherForecast } from "./forecast.js";
import { createGeocoder, type ResolvedLocation } from "./geocoding.js";
import type { HttpOptions } from "./http.js";
import { fetchMarineForecast, type MarineForecast } from "./marine.js";

export interface LocationInput {
  location?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
}

/**
 * Everything the MCP tools need from the outside world.
 * Tools depend on this interface, not on HTTP, so they can be tested with a fake.
 */
export interface WeatherService {
  resolveLocation(input: LocationInput): Promise<ResolvedLocation>;
  getWeather(location: ResolvedLocation, days: number): Promise<WeatherForecast>;
  getMarine(location: ResolvedLocation, days: number): Promise<MarineForecast>;
}

export function createOpenMeteoService(http: HttpOptions = {}): WeatherService {
  const geocoder = createGeocoder(http);

  return {
    async resolveLocation(input) {
      if (input.latitude !== undefined && input.longitude !== undefined) {
        return {
          name: input.location ?? `${input.latitude.toFixed(4)}, ${input.longitude.toFixed(4)}`,
          latitude: input.latitude,
          longitude: input.longitude,
          source: "coordinates",
        };
      }
      if (!input.location) {
        throw new Error("Provide either a location name or both latitude and longitude.");
      }
      return geocoder.resolve(input.location);
    },
    getWeather: (location, days) => fetchWeatherForecast(location, days, http),
    getMarine: (location, days) => fetchMarineForecast(location, days, http),
  };
}

export type { ResolvedLocation, WeatherForecast, MarineForecast };
