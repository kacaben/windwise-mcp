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
  throw new Error(`Unrecognised day "${day}". Use "today", "tomorrow" or a date like 2026-11-07.`);
}
