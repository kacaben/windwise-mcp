import { ToolInputError } from "./errors.js";
import { dateOf, inHourRange, upcoming } from "./time.js";

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/**
 * The hours of one day's session window that are still ahead of us.
 * Explains clearly when the date is outside the forecast or the session is over.
 */
export function selectSessionHours<T extends { time: string }>(
  hours: readonly T[],
  options: { date: string; startHour: number; endHour: number; currentHour: string },
): T[] {
  const { date, startHour, endHour, currentHour } = options;
  const first = hours[0]?.time;
  const last = hours[hours.length - 1]?.time;
  if (!first || !last || date < dateOf(first) || date > dateOf(last)) {
    throw new ToolInputError(
      `No forecast for ${date}; the forecast covers ${first ? dateOf(first) : "?"} to ${last ? dateOf(last) : "?"}.`,
    );
  }

  const session = upcoming(
    hours.filter((h) => dateOf(h.time) === date && inHourRange(h.time, startHour, endHour)),
    currentHour,
  );
  if (session.length === 0) {
    throw new ToolInputError(
      `The ${hh(startHour)}-${hh(endHour)} session on ${date} is already over ` +
        `(local time now ${currentHour.slice(11)}). Try day "tomorrow" or a later start.`,
    );
  }
  return session;
}
