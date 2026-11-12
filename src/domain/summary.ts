import type { WaveAssessment } from "./marine.js";
import { bestWindow, type RejectionReason, type WindWindow } from "./wind.js";

export type Verdict = "go" | "marginal" | "no_go";

/**
 * Why there is no wave assessment. "inland" means Open-Meteo has no marine data
 * for the point (a lake, say), which is normal; "failed" means we could not get
 * it, so the sea state is genuinely unknown.
 */
export type WaveGap = "inland" | "failed";

export interface VerdictInput {
  /** Windows already filtered to the minimum useful length. */
  windows: readonly WindWindow[];
  minWindowHours: number;
  /** Strongest sustained wind in the remaining session hours. */
  maxWindKn: number | null;
  minWindKn: number;
  maxWindLimitKn?: number | undefined;
  thunderstormHours: number;
  waves: WaveAssessment | null;
  /** Set when `waves` is null, to say whether that matters. */
  waveGap?: WaveGap | undefined;
  /** Hours in the session that meet every wind criterion, whatever the window length. */
  usableHours?: number | undefined;
  /** Rejected-hour counts, from `explainRejections`, to explain an empty result. */
  rejections?: Partial<Record<RejectionReason, number>> | undefined;
}

/** Rejection reasons that explain an empty result, in tie-break order (most specific first). */
const EXPLAINING_REASONS = ["wrong_direction", "too_gusty", "too_strong", "too_light", "no_data"] as const;

const REASON_LABELS: Record<(typeof EXPLAINING_REASONS)[number], string> = {
  wrong_direction: "from an excluded direction",
  too_gusty: "too gusty",
  too_strong: "too windy",
  too_light: "too light",
  no_data: "no data",
};

/**
 * Why no window was found. Leads with the reason that rejected the most hours
 * (one gusty hour should not hide eight calm ones) and lists the others after it.
 */
function noWindowReason(input: VerdictInput, maxWindKn: number | null): string {
  if (maxWindKn === null) return "No wind data for the requested hours.";
  if ((input.usableHours ?? 0) > 0) {
    return `${input.usableHours} hour(s) meet your wind criteria, but never ${input.minWindowHours} in a row.`;
  }

  const counted = EXPLAINING_REASONS.map((reason) => ({ reason, hours: input.rejections?.[reason] ?? 0 }))
    .filter((r) => r.hours > 0)
    // Array.sort is stable, so equal counts keep the tie-break order above.
    .sort((a, b) => b.hours - a.hours);
  const [main, ...others] = counted;
  const also =
    others.length > 0
      ? ` Other hours: ${others.map((r) => `${r.hours} ${REASON_LABELS[r.reason]}`).join(", ")}.`
      : "";

  switch (main?.reason) {
    case "wrong_direction":
      return (
        `The wind strength is right for ${main.hours} hour(s), but it blows from a direction you excluded.` +
        also
      );
    case "too_gusty":
      return `The average wind is in range for ${main.hours} hour(s), but gusts exceed your gust limit.${also}`;
    case "too_strong":
      return `Too windy: up to ${maxWindKn} kn, above the ${input.maxWindLimitKn} kn limit.${also}`;
    case "too_light":
      return maxWindKn < input.minWindKn
        ? `Not enough wind: peaks at ${maxWindKn} kn, below the ${input.minWindKn} kn minimum.${also}`
        : `Mostly not enough wind: ${main.hours} hour(s) are below the ${input.minWindKn} kn minimum.${also}`;
    case "no_data":
      return `No wind data for ${main.hours} of the session hours.${also}`;
    default:
      break;
  }

  // No per-hour breakdown (or only thunderstorm hours): judge from the peak wind alone.
  if ((input.rejections?.thunderstorm ?? 0) > 0) {
    return "Every hour that could count has thunderstorms forecast.";
  }
  if (maxWindKn < input.minWindKn) {
    return `Not enough wind: peaks at ${maxWindKn} kn, below the ${input.minWindKn} kn minimum.`;
  }
  if (input.maxWindLimitKn !== undefined && maxWindKn > input.maxWindLimitKn) {
    return `Too windy: up to ${maxWindKn} kn, above the ${input.maxWindLimitKn} kn limit.`;
  }
  return `The wind is in range only in stretches shorter than ${input.minWindowHours} hours, or is too gusty.`;
}

/**
 * Turn the numbers into a single go / marginal / no-go call with reasons.
 * Reasons are written for the agent to relay, not for a UI.
 */
export function sessionVerdict(input: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let verdict: Verdict = "go";
  const downgrade = (to: Verdict, reason: string) => {
    reasons.push(reason);
    if (to === "no_go" || (to === "marginal" && verdict === "go")) verdict = to;
  };

  if (input.thunderstormHours > 0) {
    downgrade("no_go", `Thunderstorms forecast in ${input.thunderstormHours} of the session hours.`);
  }

  if (input.windows.length === 0) {
    downgrade("no_go", noWindowReason(input, input.maxWindKn));
  } else {
    // The same pick as the tool's bestWindWindow, so the reason and the data agree.
    const best = bestWindow(input.windows)!;
    reasons.push(
      `${best.durationHours}-hour window ${best.start.slice(11)}-${best.end.slice(11)}, ` +
        `averaging ${best.avgWindKn} kn from ${best.direction ?? "variable directions"}.`,
    );
    if (input.windows.every((w) => w.gusty)) {
      downgrade("marginal", "Gusty: gusts run more than 10 kn above the average wind.");
    }
  }

  if (input.waves) {
    if (input.waves.seaState === "very_large") downgrade("no_go", input.waves.note);
    else if (input.waves.seaState === "large") downgrade("marginal", input.waves.note);
    else reasons.push(input.waves.note);
  } else if (input.waveGap === "failed") {
    downgrade(
      "marginal",
      "Wave data could not be retrieved, so the sea state is unknown. Check it before going.",
    );
  } else if (input.waveGap === "inland") {
    reasons.push(
      "No wave data for this point (inland or sheltered water), so the sea state was not assessed.",
    );
  }

  return { verdict, reasons };
}
