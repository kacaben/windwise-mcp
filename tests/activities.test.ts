import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_WIND_KN, resolveWindRange } from "../src/domain/activities.js";

describe("resolveWindRange", () => {
  it("uses the dinghy sailing preset of 10-18 kn", () => {
    expect(resolveWindRange({ activity: "dinghy_sailing" })).toEqual({
      activity: "Dinghy sailing",
      minWindKn: 10,
      maxWindKn: 18,
      maxGustKn: undefined,
    });
  });

  it("lets explicit values override the preset", () => {
    expect(resolveWindRange({ activity: "dinghy_sailing", minWindKn: 8, maxGustKn: 22 })).toMatchObject({
      minWindKn: 8,
      maxWindKn: 18,
      maxGustKn: 22,
    });
  });

  it("falls back to the default minimum with no activity", () => {
    expect(resolveWindRange({})).toEqual({
      activity: null,
      minWindKn: DEFAULT_MIN_WIND_KN,
      maxWindKn: undefined,
      maxGustKn: undefined,
    });
  });

  it("rejects a maximum below the minimum, including one created by an override", () => {
    expect(() => resolveWindRange({ minWindKn: 20, maxWindKn: 15 })).toThrow(/below the minimum/);
    expect(() => resolveWindRange({ activity: "dinghy_sailing", minWindKn: 20 })).toThrow(
      "Maximum wind (18 kn) is below the minimum (20 kn).",
    );
  });
});
