import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ATTRIBUTION } from "../domain/disclaimers.js";
import { COMPASS_POINTS } from "../domain/units.js";
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
      'Place name, optionally with region/country to disambiguate, e.g. "Bucerias, Mexico". ' +
        "Ignored for lookup when latitude and longitude are given (then used only as a label).",
    ),
  latitude: z.number().min(-90).max(90).optional().describe("Latitude in decimal degrees."),
  longitude: z.number().min(-180).max(180).optional().describe("Longitude in decimal degrees."),
};

type LocationShape = {
  location?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
};

const hasLocation = (input: LocationShape) =>
  Boolean(input.location) || (input.latitude !== undefined && input.longitude !== undefined);

/** Build a tool input schema that requires a location name or a lat/lon pair. */
export function withLocation<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...locationFields, ...shape }).refine((input) => hasLocation(input as LocationShape), {
    message: "Provide a location name, or both latitude and longitude.",
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
    .describe(`Number of days to cover, starting today (1-${maximum}).`);

export const daySelector = z
  .string()
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

export function assertHourRange(start: number, end: number) {
  if (end <= start) throw new RangeError(`end_hour (${end}) must be after start_hour (${start}).`);
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
 * `structuredContent` (for clients that can consume JSON directly).
 */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  const payload = { ...data, attribution: ATTRIBUTION };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Map domain/integration errors to a message the agent can act on. */
export function errorMessage(error: unknown): string {
  if (error instanceof LocationNotFoundError || error instanceof NoMarineDataError) {
    return error.message;
  }
  if (error instanceof OpenMeteoError) {
    return error.kind === "bad_request"
      ? `Open-Meteo rejected the request: ${error.message}`
      : `Open-Meteo is unavailable right now (${error.message}). Try again shortly.`;
  }
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
}

/**
 * Wrap a handler so failures come back as `isError` tool results the model can
 * read and recover from, instead of protocol-level errors.
 */
export function safely<Args>(
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
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
