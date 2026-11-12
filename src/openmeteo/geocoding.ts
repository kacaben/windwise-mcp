import * as z from "zod";
import { getJson, type HttpOptions } from "./http.js";
import { parseResponse } from "./schemas.js";

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

const geocodingResult = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  admin1: z.string().optional(),
  admin2: z.string().optional(),
  admin3: z.string().optional(),
  timezone: z.string().optional(),
  population: z.number().optional(),
});

type GeocodingResult = z.infer<typeof geocodingResult>;

/** Open-Meteo omits `results` entirely when nothing matches. */
const geocodingResponse = z.object({ results: z.array(geocodingResult).optional() });

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
 * Common ways people name a country that are neither its ISO code nor the name
 * Open-Meteo uses ("UK" is "GB", "USA" is "US"). Keys are normalised, without dots.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  uk: "gb",
  britain: "gb",
  "great britain": "gb",
  usa: "us",
  "united states of america": "us",
  uae: "ae",
  holland: "nl",
  "the netherlands": "nl",
  "czech republic": "cz",
  czechia: "cz",
};

/** The ISO country code a qualifier names, when it is a code or a known alias. */
const countryCodeFor = (qualifier: string) => {
  const bare = qualifier.replace(/\./g, "");
  return COUNTRY_ALIASES[bare] ?? bare;
};

/**
 * A qualifier matches a country code (or a common alias such as "UK" or "USA")
 * exactly, or a country/region name as whole words. Substring matching is wrong:
 * "us" is inside "australia".
 */
export function matchesQualifier(result: GeocodingResult, qualifier: string): boolean {
  if (result.country_code && normalize(result.country_code) === countryCodeFor(qualifier)) return true;
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

/** Results to request for a bare name; the first one is used. */
const RESULT_COUNT = 10;
/** Results to request when a region or country has to be matched (Open-Meteo allows up to 100). */
export const QUALIFIED_RESULT_COUNT = 50;

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

    // With a qualifier, the right place may be a small town that shares its name with
    // bigger ones, so look further down Open-Meteo's population-ranked list.
    const count = qualifiers.length > 0 ? QUALIFIED_RESULT_COUNT : RESULT_COUNT;
    const body = await getJson<unknown>(GEOCODING_URL, { name, count, language: "en", format: "json" }, http);
    const results = parseResponse(geocodingResponse, body, "geocoding").results ?? [];
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
        const lookingUp = lookup(query);
        pending = lookingUp;
        // Don't cache failures: a timeout now shouldn't poison later calls. Only remove
        // this lookup, not a newer one stored under the same key after an eviction.
        lookingUp.catch(() => {
          if (cache.get(key) === lookingUp) cache.delete(key);
        });
      }
      cache.set(key, pending);
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return pending;
    },
  };
}
