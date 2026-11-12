import { groupBy, max, mean, present } from "./stats.js";
import { dateOf, inHourRange } from "./time.js";
import { type CompassPoint, circularMeanDegrees, degreesToCompass, round } from "./units.js";

export interface MarineSample {
  time: string;
  waveHeightM: number | null;
  wavePeriodS: number | null;
  swellHeightM: number | null;
  swellDirectionDeg: number | null;
  swellPeriodS: number | null;
  seaTemperatureC: number | null;
  currentKn: number | null;
}

export type SeaState = "flat" | "small" | "moderate" | "large" | "very_large";

export interface WaveAssessment {
  seaState: SeaState;
  suitableFor: "everyone" | "beginners" | "intermediate" | "advanced" | "experts_only";
  beginnerFriendly: boolean;
  note: string;
}

/** Sea-state levels from calmest to roughest, with the wave height each one starts below. */
const SEA_STATES: ReadonlyArray<{ belowM: number; assessment: Omit<WaveAssessment, "note">; note: string }> =
  [
    {
      belowM: 0.3,
      assessment: { seaState: "flat", suitableFor: "everyone", beginnerFriendly: true },
      note: "Flat water.",
    },
    {
      belowM: 0.8,
      assessment: { seaState: "small", suitableFor: "beginners", beginnerFriendly: true },
      note: "Small waves; manageable for most beginners.",
    },
    {
      belowM: 1.5,
      assessment: { seaState: "moderate", suitableFor: "intermediate", beginnerFriendly: false },
      note: "Moderate waves; beginners should stay inside the break or skip it.",
    },
    {
      belowM: 2.5,
      assessment: { seaState: "large", suitableFor: "advanced", beginnerFriendly: false },
      note: "Large waves; advanced riders only.",
    },
    {
      belowM: Infinity,
      assessment: { seaState: "very_large", suitableFor: "experts_only", beginnerFriendly: false },
      note: "Very large waves; dangerous for most riders.",
    },
  ];

/** Shorter than this, waves are wind chop rather than swell. */
export const CHOP_PERIOD_S = 6;
/** Chop below this height is too small to matter. */
export const CHOP_MIN_HEIGHT_M = 0.5;

/**
 * Rough sea-state rating for small-craft water sports (wing, kite, windsurf).
 * Thresholds are deliberately conservative. Short-period chop of 0.5 m or more
 * is rated one level rougher than swell of the same height, because it is
 * steeper, closer together and harder to ride through.
 */
export function assessWaves(heightM: number, periodS: number | null = null): WaveAssessment {
  const choppy = periodS !== null && periodS < CHOP_PERIOD_S && heightM >= CHOP_MIN_HEIGHT_M;
  const byHeight = SEA_STATES.findIndex((level) => heightM < level.belowM);
  const level = SEA_STATES[Math.min(byHeight + (choppy ? 1 : 0), SEA_STATES.length - 1)]!;
  return {
    ...level.assessment,
    note: choppy ? `Short-period chop (${round(heightM, 1)} m). ${level.note}` : level.note,
  };
}

/** Index of a sea state from calmest (0) to roughest, for picking the worst hour. */
const severity = (state: SeaState) => SEA_STATES.findIndex((level) => level.assessment.seaState === state);

export interface DailyMarine {
  date: string;
  avgWaveHeightM: number | null;
  maxWaveHeightM: number | null;
  avgWavePeriodS: number | null;
  swellDirection: CompassPoint | null;
  avgSwellPeriodS: number | null;
  seaTemperatureC: number | null;
  maxCurrentKn: number | null;
  assessment: WaveAssessment | null;
}

export function summarizeMarineByDay(
  hours: readonly MarineSample[],
  startHour = 0,
  endHour = 24,
): DailyMarine[] {
  const inRange = hours.filter((h) => inHourRange(h.time, startHour, endHour));
  return [...groupBy(inRange, (h) => dateOf(h.time))].map(([date, dayHours]) => {
    const swellMean = circularMeanDegrees(present(dayHours.map((h) => h.swellDirectionDeg)));
    return {
      date,
      avgWaveHeightM: mean(
        dayHours.map((h) => h.waveHeightM),
        2,
      ),
      maxWaveHeightM: max(dayHours.map((h) => h.waveHeightM)),
      avgWavePeriodS: mean(dayHours.map((h) => h.wavePeriodS)),
      swellDirection: swellMean === null ? null : degreesToCompass(swellMean),
      avgSwellPeriodS: mean(dayHours.map((h) => h.swellPeriodS)),
      seaTemperatureC: mean(dayHours.map((h) => h.seaTemperatureC)),
      maxCurrentKn: max(dayHours.map((h) => h.currentKn)),
      assessment: worstHour(dayHours),
    };
  });
}

/**
 * Rate a day by its worst hour: that's the one that catches people out. Each
 * hour is rated with its own period, so 1.2 m of chop can outrank 1.4 m of swell.
 */
export function worstHour(hours: readonly MarineSample[]): WaveAssessment | null {
  let worst: WaveAssessment | null = null;
  for (const hour of hours) {
    if (hour.waveHeightM === null) continue;
    const assessment = assessWaves(hour.waveHeightM, hour.wavePeriodS);
    if (!worst || severity(assessment.seaState) > severity(worst.seaState)) worst = assessment;
  }
  return worst;
}
