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
  override name = "LocationNotFoundError";

  /** @param candidates places with the right name that didn't match the region/country given */
  constructor(query: string, candidates: readonly string[] = []) {
    super(
      candidates.length > 0
        ? `No place called "${query}". Did you mean: ${candidates.join("; ")}?`
        : `Could not find a place called "${query}". Try a nearby town name, add the country ` +
            `(e.g. "Bucerias, Mexico"), or pass latitude/longitude instead.`,
    );
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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A qualifier matches a country code exactly, or a country/region name as whole
 * words. Substring matching is wrong: "us" is inside "australia".
 */
export function matchesQualifier(result: GeocodingResult, qualifier: string): boolean {
  if (result.country_code && normalize(result.country_code) === qualifier) return true;
  const wholeWords = new RegExp(`(^|[^a-z0-9])${escapeRegExp(qualifier)}($|[^a-z0-9])`);
  return [result.country, result.admin1, result.admin2, result.admin3]
    .filter((field): field is string => Boolean(field))
    .some((field) => wholeWords.test(normalize(field)));
}

const describeResult = (r: GeocodingResult) => [r.name, r.admin1, r.country].filter(Boolean).join(", ");

export function pickBestResult(
  results: GeocodingResult[],
  qualifiers: string[],
): GeocodingResult | undefined {
  // Open-Meteo already ranks by relevance/population; keep that order.
  return results.find((result) => qualifiers.every((q) => matchesQualifier(result, q)));
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
 * Geocoder with a small LRU cache: place names don't move, and agents tend to
 * ask several questions about the same spot in one conversation. The cache is
 * bounded so a long-running server can't grow without limit.
 */
export function createGeocoder(http: HttpOptions = {}, maxEntries = 500): Geocoder {
  const cache = new Map<string, Promise<ResolvedLocation>>();

  async function lookup(query: string): Promise<ResolvedLocation> {
    const { name, qualifiers } = parseLocationQuery(query);
    if (name.length < 2) throw new LocationNotFoundError(query);

    const response = await getJson<GeocodingResponse>(
      GEOCODING_URL,
      { name, count: 10, language: "en", format: "json" },
      http,
    );
    const results = response.results ?? [];
    const best = pickBestResult(results, qualifiers);
    if (!best) throw new LocationNotFoundError(query, results.slice(0, 3).map(describeResult));
    return toResolved(best);
  }

  return {
    resolve(query) {
      const key = normalize(query);
      let pending = cache.get(key);
      if (pending) {
        // Re-insert to mark as most recently used (Map keeps insertion order).
        cache.delete(key);
      } else {
        pending = lookup(query);
        // Don't cache failures: a timeout now shouldn't poison later calls.
        pending.catch(() => cache.delete(key));
      }
      cache.set(key, pending);
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return pending;
    },
  };
}
