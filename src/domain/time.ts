import { ToolInputError } from "./errors.js";

/**
 * Open-Meteo is queried with `timezone=auto`, so every timestamp is a naive
 * local ISO string ("2026-11-06T14:00") in the location's own time zone.
 * We keep them as strings and never let the host machine's time zone interfere.
 */

export const dateOf = (time: string): string => time.slice(0, 10);
export const hourOf = (time: string): number => Number(time.slice(11, 13));

/** Add whole hours to a naive local timestamp. */
export function addHours(time: string, hours: number): string {
  const date = new Date(`${time}:00Z`);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString().slice(0, 16);
}

export function addDays(date: string, days: number): string {
  return addHours(`${date}T00:00`, days * 24).slice(0, 10);
}

/** Start of the hour containing a local timestamp: "2026-11-06T16:30" -> "2026-11-06T16:00". */
export const floorToHour = (time: string): string => `${time.slice(0, 13)}:00`;

/** The current local hour at a place, from its UTC offset. */
export function localHourNow(utcOffsetSeconds: number, now: Date = new Date()): string {
  return floorToHour(new Date(now.getTime() + utcOffsetSeconds * 1000).toISOString().slice(0, 16));
}

/**
 * Drop hours that have already passed. The current hour is kept: it is still
 * partly ahead of us. A forecast is only useful for what is still to come.
 */
export function upcoming<T extends { time: string }>(hours: readonly T[], currentHour: string): T[] {
  return hours.filter((hour) => hour.time >= currentHour);
}

/**
 * True when the hour slot starting at `time` falls in [startHour, endHour).
 * `endHour` is exclusive: 9–18 means the 09:00 slot through the 17:00 slot.
 */
export function inHourRange(time: string, startHour: number, endHour: number): boolean {
  const hour = hourOf(time);
  return hour >= startHour && hour < endHour;
}

/**
 * Resolve "today", "tomorrow" or "YYYY-MM-DD" against the forecast's own
 * notion of today (its first local date), not the server's clock.
 */
export function resolveDay(day: string, forecastToday: string): string {
  const value = day.trim().toLowerCase();
  if (value === "today") return forecastToday;
  if (value === "tomorrow") return addDays(forecastToday, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new ToolInputError(`Unrecognised day "${day}". Use "today", "tomorrow" or a date like 2026-11-07.`);
}

export const MAX_FORECAST_DAYS = 16;

/**
 * How many forecast days to request so that `day` is covered, without always
 * fetching the maximum. Local "today" can differ from UTC today by a day either
 * way, so explicit dates get one day of slack.
 */
export function forecastDaysFor(day: string, now: Date = new Date()): number {
  const value = day.trim().toLowerCase();
  if (value === "today") return 1;
  if (value === "tomorrow") return 2;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 1; // resolveDay will reject it
  const utcToday = now.toISOString().slice(0, 10);
  const daysAhead = Math.round((Date.parse(value) - Date.parse(utcToday)) / 86_400_000);
  return Math.min(MAX_FORECAST_DAYS, Math.max(1, daysAhead + 2));
}
