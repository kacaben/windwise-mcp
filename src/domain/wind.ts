import { groupBy, max, mean, present } from "./stats.js";
import { addHours, dateOf, inHourRange } from "./time.js";
import {
  beaufort,
  circularMeanDegrees,
  degreesToCompass,
  round,
  type CompassPoint,
} from "./units.js";
import { isThunderstorm } from "./weatherCodes.js";

/** The minimum an hour needs for wind analysis. `WeatherHour` satisfies it. */
export interface WindSample {
  time: string;
  windKn: number | null;
  gustKn: number | null;
  windDirectionDeg: number | null;
  weatherCode?: number | null;
}

export interface WindCriteria {
  minWindKn: number;
  maxWindKn?: number | undefined;
  maxGustKn?: number | undefined;
  /** Inclusive start hour, local time (0–23). */
  startHour: number;
  /** Exclusive end hour, local time (1–24). */
  endHour: number;
  /** Only accept these directions (where the wind comes FROM). */
  directions?: readonly CompassPoint[] | undefined;
  /** Drop windows shorter than this. */
  minWindowHours: number;
  /** Thunderstorm hours never count as rideable. */
  excludeThunderstorms: boolean;
}

export interface WindWindow {
  date: string;
  /** Local start of the first matching hour. */
  start: string;
  /** Local end of the last matching hour (exclusive). */
  end: string;
  durationHours: number;
  avgWindKn: number;
  maxWindKn: number;
  maxGustKn: number | null;
  direction: CompassPoint | null;
  /** Gusts more than 10 kn above the average wind make for a hard session. */
  gusty: boolean;
}

/** Why an hour failed the criteria. Useful for explaining "no windows found". */
export type RejectionReason =
  | "outside_hours"
  | "no_data"
  | "too_light"
  | "too_strong"
  | "too_gusty"
  | "wrong_direction"
  | "thunderstorm";

export function checkHour(hour: WindSample, criteria: WindCriteria): RejectionReason | null {
  if (!inHourRange(hour.time, criteria.startHour, criteria.endHour)) return "outside_hours";
  if (hour.windKn === null) return "no_data";
  if (criteria.excludeThunderstorms && isThunderstorm(hour.weatherCode ?? null)) {
    return "thunderstorm";
  }
  if (hour.windKn < criteria.minWindKn) return "too_light";
  if (criteria.maxWindKn !== undefined && hour.windKn > criteria.maxWindKn) return "too_strong";
  if (criteria.maxGustKn !== undefined && (hour.gustKn ?? hour.windKn) > criteria.maxGustKn) {
    return "too_gusty";
  }
  if (criteria.directions?.length) {
    if (hour.windDirectionDeg === null) return "no_data";
    if (!criteria.directions.includes(degreesToCompass(hour.windDirectionDeg))) {
      return "wrong_direction";
    }
  }
  return null;
}

export function dominantDirection(hours: readonly WindSample[]): CompassPoint | null {
  const mean = circularMeanDegrees(present(hours.map((h) => h.windDirectionDeg)));
  return mean === null ? null : degreesToCompass(mean);
}

function toWindow(run: WindSample[]): WindWindow {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const avgWindKn = mean(run.map((h) => h.windKn))!;
  const maxGustKn = max(run.map((h) => h.gustKn));
  return {
    date: dateOf(first.time),
    start: first.time,
    end: addHours(last.time, 1),
    durationHours: run.length,
    avgWindKn,
    maxWindKn: max(run.map((h) => h.windKn))!,
    maxGustKn,
    direction: dominantDirection(run),
    gusty: maxGustKn !== null && maxGustKn - avgWindKn > 10,
  };
}

/**
 * Find consecutive runs of hours that satisfy the criteria.
 * This is the core "business logic on top of the API" of WindWise.
 */
export function findWindWindows(hours: readonly WindSample[], criteria: WindCriteria): WindWindow[] {
  const windows: WindWindow[] = [];
  let run: WindSample[] = [];

  const flush = () => {
    if (run.length >= criteria.minWindowHours) windows.push(toWindow(run));
    run = [];
  };

  for (const hour of hours) {
    const previous = run[run.length - 1];
    const isContiguous = previous !== undefined && addHours(previous.time, 1) === hour.time;
    if (run.length && !isContiguous) flush();

    if (checkHour(hour, criteria) === null) run.push(hour);
    else flush();
  }
  flush();
  return windows;
}

/** Count rejection reasons among in-range hours, to explain empty results. */
export function explainRejections(
  hours: readonly WindSample[],
  criteria: WindCriteria,
): Partial<Record<RejectionReason, number>> {
  const counts: Partial<Record<RejectionReason, number>> = {};
  for (const hour of hours) {
    const reason = checkHour(hour, criteria);
    if (reason && reason !== "outside_hours") counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

export interface DailyWind {
  date: string;
  avgWindKn: number | null;
  maxWindKn: number | null;
  maxGustKn: number | null;
  /** Local time of the strongest sustained wind. */
  peakTime: string | null;
  direction: CompassPoint | null;
  peakBeaufort: string | null;
}

/** Per-day wind rollup restricted to an hour range (e.g. daylight 9–18). */
export function summarizeWindByDay(
  hours: readonly WindSample[],
  startHour = 0,
  endHour = 24,
): DailyWind[] {
  const inRange = hours.filter((h) => inHourRange(h.time, startHour, endHour));
  return [...groupBy(inRange, (h) => dateOf(h.time))].map(([date, dayHours]) => {
    const peak = dayHours.reduce<WindSample | null>(
      (best, h) => (h.windKn !== null && (best?.windKn ?? -1) < h.windKn ? h : best),
      null,
    );
    const maxWindKn = peak?.windKn ?? null;
    return {
      date,
      avgWindKn: mean(dayHours.map((h) => h.windKn)),
      maxWindKn,
      maxGustKn: max(dayHours.map((h) => h.gustKn)),
      peakTime: peak?.time ?? null,
      direction: dominantDirection(dayHours),
      peakBeaufort: maxWindKn === null ? null : beaufort(maxWindKn).description,
    };
  });
}

/** Compact row for returning hourly wind to an agent. */
export function windRow(hour: WindSample) {
  return {
    time: hour.time,
    windKn: hour.windKn,
    gustKn: hour.gustKn,
    directionDeg: hour.windDirectionDeg === null ? null : round(hour.windDirectionDeg, 0),
    direction: hour.windDirectionDeg === null ? null : degreesToCompass(hour.windDirectionDeg),
  };
}
