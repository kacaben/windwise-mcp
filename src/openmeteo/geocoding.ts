import { getJson, type HttpOptions } from "./http.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

export interface ResolvedLocation {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  region?: string;
  timezone?: string;
  /** How the coordinates were obtained. */
  source: "geocoded" | "coordinates";
}

interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  timezone?: string;
  population?: number;
}

interface GeocodingResponse {
  results?: GeocodingResult[];
}

export class LocationNotFoundError extends Error {
  constructor(query: string) {
    super(
      `Could not find a place called "${query}". Try a nearby town name, add the country ` +
        `(e.g. "Bucerias, Mexico"), or pass latitude/longitude instead.`,
    );
    this.name = "LocationNotFoundError";
  }
}

/** Lower-case and strip accents so "Bucerias" matches "Bucerías". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Split "Bucerias, Nayarit, Mexico" into a search term and qualifiers.
 * Open-Meteo's geocoder only searches by place name, so qualifiers are
 * applied client-side against country / region fields.
 */
export function parseLocationQuery(query: string): { name: string; qualifiers: string[] } {
  const [name = "", ...rest] = query.split(",").map((part) => part.trim());
  return { name, qualifiers: rest.filter(Boolean).map(normalize) };
}

function matchesQualifiers(result: GeocodingResult, qualifiers: string[]): boolean {
  const fields = [result.country, result.country_code, result.admin1, result.admin2, result.admin3]
    .filter((field): field is string => Boolean(field))
    .map(normalize);
  return qualifiers.every((qualifier) =>
    fields.some((field) => field === qualifier || field.includes(qualifier)),
  );
}

export function pickBestResult(
  results: GeocodingResult[],
  qualifiers: string[],
): GeocodingResult | undefined {
  // Open-Meteo already ranks by relevance/population; keep that order.
  return results.find((result) => matchesQualifiers(result, qualifiers));
}

function toResolved(result: GeocodingResult): ResolvedLocation {
  return {
    name: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    country: result.country,
    region: result.admin1,
    timezone: result.timezone,
    source: "geocoded",
  };
}

export interface Geocoder {
  resolve(query: string): Promise<ResolvedLocation>;
}

/**
 * Geocoder with an in-memory cache: place names don't move, and agents tend to
 * ask several questions about the same spot in one conversation.
 */
export function createGeocoder(http: HttpOptions = {}): Geocoder {
  const cache = new Map<string, Promise<ResolvedLocation>>();

  async function lookup(query: string): Promise<ResolvedLocation> {
    const { name, qualifiers } = parseLocationQuery(query);
    if (name.length < 2) throw new LocationNotFoundError(query);

    const response = await getJson<GeocodingResponse>(
      GEOCODING_URL,
      { name, count: 10, language: "en", format: "json" },
      http,
    );
    const best = pickBestResult(response.results ?? [], qualifiers);
    if (!best) throw new LocationNotFoundError(query);
    return toResolved(best);
  }

  return {
    resolve(query) {
      const key = normalize(query);
      let pending = cache.get(key);
      if (!pending) {
        pending = lookup(query);
        cache.set(key, pending);
        // Don't cache failures: a timeout now shouldn't poison later calls.
        pending.catch(() => cache.delete(key));
      }
      return pending;
    },
  };
}
