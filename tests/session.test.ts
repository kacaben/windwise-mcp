import { describe, expect, it } from "vitest";
import { selectSessionHours } from "../src/domain/session.js";

describe("selectSessionHours", () => {
  const hours = ["2026-11-06", "2026-11-07"].flatMap((date) =>
    Array.from({ length: 24 }, (_, h) => ({ time: `${date}T${String(h).padStart(2, "0")}:00` })),
  );
  const session = { startHour: 9, endHour: 18 };

  it("keeps only the remaining hours of today's session", () => {
    const today = selectSessionHours(hours, {
      ...session,
      date: "2026-11-06",
      currentHour: "2026-11-06T14:00",
    });
    expect(today.map((h) => h.time.slice(11))).toEqual(["14:00", "15:00", "16:00", "17:00"]);
  });

  it("explains when today's session is already over", () => {
    expect(() =>
      selectSessionHours(hours, { ...session, date: "2026-11-06", currentHour: "2026-11-06T19:00" }),
    ).toThrow(
      'The 09:00-18:00 session on 2026-11-06 is already over (local time now 19:00). Try day "tomorrow"',
    );
  });

  it("explains when the date is outside the forecast", () => {
    expect(() =>
      selectSessionHours(hours, { ...session, date: "2026-11-20", currentHour: "2026-11-06T08:00" }),
    ).toThrow("No forecast for 2026-11-20; the forecast covers 2026-11-06 to 2026-11-07.");
  });
});
