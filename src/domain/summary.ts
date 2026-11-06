import type { WaveAssessment } from "./marine.js";
import type { WindWindow } from "./wind.js";

export type Verdict = "go" | "marginal" | "no_go";

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
    if (input.maxWindKn === null) {
      downgrade("no_go", "No wind data for the requested hours.");
    } else if (input.maxWindKn < input.minWindKn) {
      downgrade(
        "no_go",
        `Not enough wind: peaks at ${input.maxWindKn} kn, below the ${input.minWindKn} kn minimum.`,
      );
    } else if (input.maxWindLimitKn !== undefined && input.maxWindKn > input.maxWindLimitKn) {
      downgrade(
        "no_go",
        `Too windy: up to ${input.maxWindKn} kn, above the ${input.maxWindLimitKn} kn limit.`,
      );
    } else {
      downgrade(
        "no_go",
        `The wind is in range only in stretches shorter than ${input.minWindowHours} hours, or is too gusty.`,
      );
    }
  } else {
    const longest = Math.max(...input.windows.map((w) => w.durationHours));
    const best = input.windows.find((w) => w.durationHours === longest)!;
    reasons.push(
      `${longest}-hour window ${best.start.slice(11)}-${best.end.slice(11)}, ` +
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
  }

  return { verdict, reasons };
}
