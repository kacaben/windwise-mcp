import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  ACTIVITIES,
  ACTIVITY_PRESETS,
  type Activity,
  type ActivityPreset,
  DEFAULT_MIN_WIND_KN,
  resolveWindRange,
} from "../domain/activities.js";
import { ATTRIBUTION } from "../domain/disclaimers.js";
import { ToolInputError } from "../domain/errors.js";
import { COMPASS_POINTS, type CompassPoint } from "../domain/units.js";
import { DEFAULT_MIN_WINDOW_HOURS, type WindCriteria } from "../domain/wind.js";
import type { ResolvedLocation } from "../openmeteo/client.js";
import { LocationNotFoundError } from "../openmeteo/geocoding.js";
import { OpenMeteoError } from "../openmeteo/http.js";
import { NoMarineDataError } from "../openmeteo/marine.js";

// ---------------------------------------------------------------------------
// Input schemas shared by several tools
// ---------------------------------------------------------------------------

export const locationFields = {
  location: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe(
      'Place name, optionally with region/country to disambiguate, e.g. "Bucerias, Mexico" or ' +
        '"Springfield, US". Ignored for lookup when latitude and longitude are given (then only a label).',
    ),
  latitude: z.number().min(-90).max(90).optional().describe("Latitude in decimal degrees."),
  longitude: z.number().min(-180).max(180).optional().describe("Longitude in decimal degrees."),
};

type LocationShape = {
  location?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
};

/** Why a location input can't be used, or null when it is a name, a lat/lon pair, or both. */
export function locationProblem({ location, latitude, longitude }: LocationShape): string | null {
  const hasLat = latitude !== undefined;
  const hasLon = longitude !== undefined;
  // A lone coordinate would otherwise be silently ignored in favour of the name.
  if (hasLat !== hasLon) {
    return `Got ${hasLat ? "latitude" : "longitude"} without ${hasLat ? "longitude" : "latitude"}. Pass both, or neither.`;
  }
  if (!location && !hasLat) return "Provide a location name, or both latitude and longitude.";
  return null;
}

/** Build a tool input schema that requires a location name or a lat/lon pair. */
export function withLocation<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...locationFields, ...shape }).superRefine((input, ctx) => {
    const problem = locationProblem(input as LocationShape);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
}

export const startHour = (fallback: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(23)
    .default(fallback)
    .describe("Start of the time range, local hour 0-23 (inclusive).");

export const endHour = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(fallback)
    .describe("End of the time range, local hour 1-24 (exclusive): 18 means up to 18:00.");

export const forecastDays = (fallback: number, maximum = 7) =>
  z
    .number()
    .int()
    .min(1)
    .max(maximum)
    .default(fallback)
    .describe(`Number of days to cover, starting now (1-${maximum}). Hours already past are left out.`);

export const daySelector = z
  .union([z.enum(["today", "tomorrow"]), z.iso.date()])
  .default("today")
  .describe('Which day: "today", "tomorrow" or a local date "YYYY-MM-DD" (up to 15 days ahead).');

export const compassDirections = z
  .array(z.enum(COMPASS_POINTS))
  .min(1)
  .optional()
  .describe(
    'Only accept wind coming FROM these 16-point compass directions, e.g. ["W","WSW","SW"] ' +
      "for a beach facing south-west. Omit to accept any direction.",
  );

export const minWindowHours = z
  .number()
  .int()
  .min(1)
  .max(24)
  .default(DEFAULT_MIN_WINDOW_HOURS)
  .describe(
    `Ignore stretches of good wind shorter than this many hours (default ${DEFAULT_MIN_WINDOW_HOURS}).`,
  );

const presetList = ACTIVITIES.map((key) => {
  const p: ActivityPreset = ACTIVITY_PRESETS[key];
  return `${key} = ${p.minWindKn}${p.maxWindKn ? `-${p.maxWindKn}` : "+"} kn`;
}).join(", ");

/** Wind range inputs shared by find_wind_windows, compare_locations and get_weather_summary. */
export const windCriteriaFields = {
  activity: z
    .enum(ACTIVITIES)
    .optional()
    .describe(
      `Preset wind range for an activity (${presetList}). Explicit min/max/gust values override the preset.`,
    ),
  min_wind_knots: z
    .number()
    .min(0)
    .max(60)
    .optional()
    .describe(
      `Minimum sustained wind in knots. Defaults to the activity preset, or ${DEFAULT_MIN_WIND_KN} kn.`,
    ),
  max_wind_knots: z
    .number()
    .min(1)
    .max(80)
    .optional()
    .describe("Maximum sustained wind in knots. Defaults to the activity preset, or no upper limit."),
  max_gust_knots: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Reject hours whose gusts exceed this, in knots."),
  min_window_hours: minWindowHours,
};

export function assertHourRange(start: number, end: number) {
  if (end <= start) throw new ToolInputError(`end_hour (${end}) must be after start_hour (${start}).`);
}

/** The arguments every wind-range tool shares, as parsed by its input schema. */
export interface WindSearchArgs {
  activity?: Activity | undefined;
  min_wind_knots?: number | undefined;
  max_wind_knots?: number | undefined;
  max_gust_knots?: number | undefined;
  min_window_hours: number;
  start_hour: number;
  end_hour: number;
  directions?: readonly CompassPoint[] | undefined;
  /** Defaults to true: thunderstorm hours never count as rideable. */
  exclude_thunderstorms?: boolean | undefined;
}

/**
 * Validate and resolve the shared wind arguments once, for find_wind_windows,
 * compare_locations and get_weather_summary, so the three tools agree on what
 * a usable session is and report the range the same way.
 */
export function windSearch(args: WindSearchArgs) {
  assertHourRange(args.start_hour, args.end_hour);
  const range = resolveWindRange({
    activity: args.activity,
    minWindKn: args.min_wind_knots,
    maxWindKn: args.max_wind_knots,
    maxGustKn: args.max_gust_knots,
  });
  const criteria: WindCriteria = {
    minWindKn: range.minWindKn,
    maxWindKn: range.maxWindKn,
    maxGustKn: range.maxGustKn,
    startHour: args.start_hour,
    endHour: args.end_hour,
    directions: args.directions,
    minWindowHours: args.min_window_hours,
    excludeThunderstorms: args.exclude_thunderstorms ?? true,
  };
  /** How the range is echoed back in every tool's output. */
  const windRangeKn = {
    min: range.minWindKn,
    max: range.maxWindKn ?? null,
    maxGust: range.maxGustKn ?? null,
    minWindowHours: args.min_window_hours,
  };
  return { activity: range.activity, criteria, windRangeKn };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function describeLocation(location: ResolvedLocation, timezone?: string) {
  return {
    name: location.name,
    region: location.region,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: timezone ?? location.timezone,
  };
}

/**
 * Return data both as text (for clients that only read `content`) and as
 * `structuredContent`, which the SDK validates against the tool's `outputSchema`.
 * Passing the schema here makes TypeScript check `data` against it at compile time.
 */
export function jsonResult<Schema extends z.ZodType<{ attribution: string }>>(
  _schema: Schema,
  data: Omit<z.input<Schema>, "attribution">,
): CallToolResult {
  const payload = { ...data, attribution: ATTRIBUTION };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

const UNEXPECTED_ERROR =
  "WindWise hit an unexpected internal error while running this tool. The details were logged " +
  "on the server; retrying with different input may help.";

/**
 * Report an error: log what the developer needs to stderr, and return the text
 * the model should see.
 *
 * Known errors become a message the agent can act on. Anything else is a bug:
 * it is logged and the model gets a generic message rather than internals like
 * "Cannot read properties of undefined". A changed Open-Meteo response is
 * logged too.
 */
export function reportError(error: unknown): string {
  if (
    error instanceof ToolInputError ||
    error instanceof LocationNotFoundError ||
    error instanceof NoMarineDataError
  ) {
    return error.message;
  }
  if (error instanceof OpenMeteoError) {
    switch (error.kind) {
      case "bad_request":
        return `Open-Meteo rejected the request: ${error.message}`;
      case "invalid_response":
        // The API changed under us: the developer needs the details, the model does not.
        console.error("[windwise-mcp] unexpected Open-Meteo response:", error.message);
        return (
          "Open-Meteo answered in a format WindWise does not recognise, so the forecast could not " +
          "be read. Retrying will not help; the details were logged on the server."
        );
      case "cancelled":
        return "The request was cancelled before Open-Meteo answered.";
      default:
        return `Open-Meteo is unavailable right now (${error.message}). Try again shortly.`;
    }
  }
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error("[windwise-mcp] unexpected error:", error);
  return UNEXPECTED_ERROR;
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: reportError(error) }], isError: true };
}

/** A promise's outcome as a value, so a failure can be handled after other awaits. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** The part of the SDK's per-request context that handlers use. */
interface ToolContext {
  mcpReq: { signal: AbortSignal };
}

/**
 * Wrap a handler so failures come back as `isError` tool results the model can
 * read and recover from, instead of protocol-level errors. The handler also gets
 * the request's abort signal, so a cancelled call stops its Open-Meteo requests.
 */
export function safely<Args>(
  handler: (args: Args, signal: AbortSignal) => Promise<CallToolResult>,
): (args: Args, ctx: ToolContext) => Promise<CallToolResult> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx.mcpReq.signal);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;
