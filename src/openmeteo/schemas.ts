/**
 * Zod schemas for the parts of Open-Meteo's responses that WindWise relies on.
 *
 * Checking the response at the boundary turns an API change (a renamed field,
 * a different time format) into one clear `invalid_response` error, instead of
 * nulls that read as "no data" or a crash deep inside the domain code.
 */
import * as z from "zod";
import { OpenMeteoError } from "./http.js";

/** A naive local timestamp, as returned with `timezone=auto`: "2026-11-06T14:00". */
export const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:MM");

const isNumberOrNull = (value: unknown) => value === null || typeof value === "number";

/**
 * Column-wise hourly data: a `time` axis plus one array per requested variable,
 * each with exactly one number (or null) per time step.
 */
export function hourlyColumns(keys: readonly string[]) {
  return z
    .object({ time: z.array(localTime).min(1, "no hourly time steps") })
    .catchall(z.unknown())
    .superRefine((columns, ctx) => {
      for (const key of keys) {
        const series = columns[key];
        if (!Array.isArray(series)) {
          ctx.addIssue({ code: "custom", path: [key], message: "missing hourly variable" });
        } else if (series.length !== columns.time.length) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `has ${series.length} values for ${columns.time.length} time steps`,
          });
        } else if (!series.every(isNumberOrNull)) {
          ctx.addIssue({ code: "custom", path: [key], message: "contains non-numeric values" });
        }
      }
    });
}

/** The `current` block: its time plus one number (or null) per requested variable. */
export function currentValues(keys: readonly string[]) {
  return z
    .object({ time: localTime })
    .catchall(z.unknown())
    .superRefine((current, ctx) => {
      for (const key of keys) {
        if (!(key in current) || !isNumberOrNull(current[key])) {
          ctx.addIssue({ code: "custom", path: [key], message: "missing or non-numeric current value" });
        }
      }
    });
}

/** Validate a response body, or throw an `invalid_response` OpenMeteoError naming what was wrong. */
export function parseResponse<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
  endpoint: string,
): z.output<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new OpenMeteoError(
      `Open-Meteo ${endpoint} response has an unexpected shape:\n${z.prettifyError(result.error)}`,
      "invalid_response",
    );
  }
  return result.data;
}
