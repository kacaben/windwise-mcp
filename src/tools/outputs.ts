/**
 * Output schemas for every tool. They are advertised to clients as `outputSchema`
 * and the SDK validates each successful result against them at runtime.
 *
 * Schemas that mirror a domain type are annotated `z.ZodType<DomainType>`, so the
 * compiler fails if the domain type and the published schema drift apart.
 */
import * as z from "zod";
import type { DailyMarine, WaveAssessment } from "../domain/marine.js";
import { COMPASS_POINTS } from "../domain/units.js";
import type { DailyWind, WindWindow } from "../domain/wind.js";

const num = z.number().nullable();
const compass = z.enum(COMPASS_POINTS).nullable();
const attribution = z.string().describe("Required credit for the data source.");

export const locationOutput = z.object({
  name: z.string(),
  region: z.string().optional(),
  country: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().optional().describe("IANA time zone; all times are local to it."),
});

const hoursOutput = z.object({ start: z.number(), end: z.number(), note: z.string().optional() });
const unitsOutput = z.record(z.string(), z.string());

export const windWindowOutput: z.ZodType<WindWindow> = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string().describe("Exclusive end time."),
  durationHours: z.number(),
  avgWindKn: z.number(),
  maxWindKn: z.number(),
  maxGustKn: num,
  direction: compass,
  gusty: z.boolean(),
});

export const dailyWindOutput: z.ZodType<DailyWind> = z.object({
  date: z.string(),
  avgWindKn: num,
  maxWindKn: num,
  maxGustKn: num,
  peakTime: z.string().nullable(),
  direction: compass,
  peakBeaufort: z.string().nullable(),
});

const waveAssessmentOutput: z.ZodType<WaveAssessment> = z.object({
  seaState: z.enum(["flat", "small", "moderate", "large", "very_large"]),
  suitableFor: z.enum(["everyone", "beginners", "intermediate", "advanced", "experts_only"]),
  beginnerFriendly: z.boolean(),
  note: z.string(),
});

export const dailyMarineOutput: z.ZodType<DailyMarine> = z.object({
  date: z.string(),
  avgWaveHeightM: num,
  maxWaveHeightM: num,
  avgWavePeriodS: num,
  swellDirection: compass,
  avgSwellPeriodS: num,
  seaTemperatureC: num,
  maxCurrentKn: num,
  assessment: waveAssessmentOutput.nullable(),
});

const windRowOutput = z.object({
  time: z.string(),
  windKn: num,
  gustKn: num,
  directionDeg: num,
  direction: compass,
});

const windRangeOutput = z.object({ min: z.number(), max: num, maxGust: num, minWindowHours: z.number() });

// ---------------------------------------------------------------------------
// Per-tool outputs
// ---------------------------------------------------------------------------

export const getWeatherOutput = z.object({
  location: locationOutput,
  current: z.object({
    time: z.string(),
    conditions: z.string().nullable(),
    temperatureC: num,
    feelsLikeC: num,
    cloudCoverPct: num,
    precipitationMm: num,
    windKn: num,
    gustKn: num,
    windDirection: compass,
  }),
  hourly: z.array(
    z.object({
      time: z.string(),
      conditions: z.string().nullable(),
      temperatureC: num,
      rainChancePct: num,
      precipitationMm: num,
      cloudCoverPct: num,
      windKn: num,
      gustKn: num,
      windDirection: compass,
    }),
  ),
  units: unitsOutput,
  caveat: z.string(),
  attribution,
});

export const getWindForecastOutput = z.object({
  location: locationOutput,
  hours: hoursOutput,
  daily: z.array(dailyWindOutput),
  hourly: z.array(windRowOutput),
  units: unitsOutput,
  caveat: z.string(),
  attribution,
});

export const getMarineConditionsOutput = z.object({
  location: locationOutput,
  hours: hoursOutput,
  daily: z.array(dailyMarineOutput),
  hourly: z.array(
    z.object({
      time: z.string(),
      waveHeightM: num,
      wavePeriodS: num,
      swellHeightM: num,
      swellPeriodS: num,
      swellDirection: compass,
      seaTemperatureC: num,
      currentKn: num,
    }),
  ),
  units: unitsOutput,
  caveat: z.string(),
  attribution,
});

export const findWindWindowsOutput = z.object({
  location: locationOutput,
  criteria: z.object({
    activity: z.string().nullable(),
    windRangeKn: windRangeOutput,
    startHour: z.number(),
    endHour: z.number(),
    days: z.number(),
    directions: z.array(z.enum(COMPASS_POINTS)).nullable(),
    excludeThunderstorms: z.boolean(),
  }),
  found: z.boolean(),
  windowCount: z.number(),
  totalRideableHours: z.number(),
  bestWindow: windWindowOutput.nullable(),
  windows: z.array(windWindowOutput),
  whyNoWindows: z.record(z.string(), z.number()).optional().describe("Count of rejected hours by reason."),
  strongestHourInRange: windRowOutput.nullable().optional(),
  notes: z.array(z.string()),
  attribution,
});

export const compareLocationsOutput = z.object({
  date: z
    .string()
    .nullable()
    .describe("The compared date; null when the spots' time zones put the day on different dates."),
  hours: hoursOutput,
  activity: z.string().nullable(),
  windRangeKn: windRangeOutput,
  ranking: z.array(
    z.object({
      rank: z.number(),
      location: z.string(),
      resolvedAs: z.string(),
      date: z.string(),
      gridPoint: z.string().describe("Model grid cell used; equal values mean identical forecasts."),
      matchingHours: z.number(),
      longestWindowHours: z.number(),
      avgWindKn: num,
      maxGustKn: num,
      direction: compass,
      maxWaveHeightM: num,
    }),
  ),
  failures: z.array(z.object({ location: z.string(), error: z.string() })).optional(),
  notes: z.array(z.string()),
  attribution,
});

export const getWeatherSummaryOutput = z.object({
  location: locationOutput,
  date: z.string(),
  hours: hoursOutput,
  activity: z.string().nullable(),
  windRangeKn: windRangeOutput,
  verdict: z.enum(["go", "marginal", "no_go"]),
  reasons: z.array(z.string()),
  weather: z.object({
    conditions: z.string().nullable(),
    temperatureMinC: num,
    temperatureMaxC: num,
    maxRainChancePct: num,
    totalPrecipitationMm: num,
    thunderstormHours: z.number(),
  }),
  wind: dailyWindOutput.nullable(),
  bestWindWindow: windWindowOutput.nullable(),
  windWindows: z.array(windWindowOutput),
  marine: z.union([dailyMarineOutput, z.object({ unavailable: z.string() })]).nullable(),
  notes: z.array(z.string()),
  attribution,
});
