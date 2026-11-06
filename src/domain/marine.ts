import { groupBy, max, mean, present } from "./stats.js";
import { dateOf, inHourRange } from "./time.js";
import { circularMeanDegrees, degreesToCompass, type CompassPoint } from "./units.js";

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

/**
 * Rough sea-state rating for small-craft water sports (wing, kite, SUP, windsurf).
 * Thresholds are deliberately conservative, and short-period chop is rated one
 * step harder than long, rolling swell of the same height.
 */
export function assessWaves(heightM: number, periodS: number | null = null): WaveAssessment {
  const choppy = periodS !== null && periodS < 6 && heightM >= 0.5;

  if (heightM < 0.3) {
    return { seaState: "flat", suitableFor: "everyone", beginnerFriendly: true, note: "Flat water." };
  }
  if (heightM < 0.8 && !choppy) {
    return {
      seaState: "small",
      suitableFor: "beginners",
      beginnerFriendly: true,
      note: "Small waves; manageable for most beginners.",
    };
  }
  if (heightM < 1.5) {
    return {
      seaState: "moderate",
      suitableFor: "intermediate",
      beginnerFriendly: false,
      note: choppy
        ? "Short-period chop; tiring and awkward for beginners."
        : "Moderate waves; beginners should stay inside the break or skip it.",
    };
  }
  if (heightM < 2.5) {
    return {
      seaState: "large",
      suitableFor: "advanced",
      beginnerFriendly: false,
      note: "Large waves; advanced riders only.",
    };
  }
  return {
    seaState: "very_large",
    suitableFor: "experts_only",
    beginnerFriendly: false,
    note: "Very large waves; dangerous for most riders.",
  };
}

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
    const maxWave = max(dayHours.map((h) => h.waveHeightM));
    const avgPeriod = mean(dayHours.map((h) => h.wavePeriodS));
    const swellMean = circularMeanDegrees(present(dayHours.map((h) => h.swellDirectionDeg)));
    return {
      date,
      avgWaveHeightM: mean(dayHours.map((h) => h.waveHeightM), 2),
      maxWaveHeightM: maxWave,
      avgWavePeriodS: avgPeriod,
      swellDirection: swellMean === null ? null : degreesToCompass(swellMean),
      avgSwellPeriodS: mean(dayHours.map((h) => h.swellPeriodS)),
      seaTemperatureC: mean(dayHours.map((h) => h.seaTemperatureC)),
      maxCurrentKn: max(dayHours.map((h) => h.currentKn)),
      // Rate the day by its worst hour: that's the one that catches people out.
      assessment: maxWave === null ? null : assessWaves(maxWave, avgPeriod),
    };
  });
}
