import { ToolInputError } from "./errors.js";

/**
 * Named wind ranges for common activities, so an agent (or a user) can ask for
 * "dinghy sailing" instead of remembering knots. Explicit knot values passed to
 * a tool always override the preset.
 */
export interface ActivityPreset {
  label: string;
  minWindKn: number;
  maxWindKn?: number;
  maxGustKn?: number;
}

export const ACTIVITY_PRESETS = {
  wing_foiling: { label: "Wing foiling", minWindKn: 12 },
  dinghy_sailing: { label: "Dinghy sailing", minWindKn: 10, maxWindKn: 18 },
} as const satisfies Record<string, ActivityPreset>;

export type Activity = keyof typeof ACTIVITY_PRESETS;
export const ACTIVITIES = Object.keys(ACTIVITY_PRESETS) as [Activity, ...Activity[]];

/** Used when neither an activity nor min_wind_knots is given. */
export const DEFAULT_MIN_WIND_KN = 12;

export interface ResolvedWindRange {
  activity: string | null;
  minWindKn: number;
  maxWindKn: number | undefined;
  maxGustKn: number | undefined;
}

/** Merge an optional preset with explicit overrides; explicit values win. */
export function resolveWindRange(input: {
  activity?: Activity | undefined;
  minWindKn?: number | undefined;
  maxWindKn?: number | undefined;
  maxGustKn?: number | undefined;
}): ResolvedWindRange {
  const preset: ActivityPreset | undefined = input.activity ? ACTIVITY_PRESETS[input.activity] : undefined;
  const range: ResolvedWindRange = {
    activity: preset?.label ?? null,
    minWindKn: input.minWindKn ?? preset?.minWindKn ?? DEFAULT_MIN_WIND_KN,
    maxWindKn: input.maxWindKn ?? preset?.maxWindKn,
    maxGustKn: input.maxGustKn ?? preset?.maxGustKn,
  };
  if (range.maxWindKn !== undefined && range.maxWindKn < range.minWindKn) {
    // Say where the limit came from: an inherited preset maximum is not something the caller typed.
    const inherited = input.maxWindKn === undefined && preset?.maxWindKn !== undefined;
    throw new ToolInputError(
      inherited
        ? `The ${preset!.label} preset caps wind at ${range.maxWindKn} kn, below your minimum of ` +
            `${range.minWindKn} kn. Also pass max_wind_knots (or omit activity) to set your own range.`
        : `Maximum wind (${range.maxWindKn} kn) is below the minimum (${range.minWindKn} kn).`,
    );
  }
  return range;
}
