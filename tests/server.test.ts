/**
 * Integration tests: a real MCP client talks to the real server over an
 * in-memory transport. Only the weather service is faked, so these cover
 * schemas, validation, tool wiring and error mapping without the network.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { WeatherService } from "../src/openmeteo/client.js";
import { NoMarineDataError } from "../src/openmeteo/marine.js";
import { createServer } from "../src/server.js";
import { fakeService, marineDay, weatherDay } from "./helpers.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(service: WeatherService) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(service).connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args });
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
}

const breezyDay = [
  ...weatherDay("2026-11-06", { 13: 9, 14: 10 }),
  ...weatherDay("2026-11-07", { 11: 13, 12: 15, 13: 17, 14: 16, 15: 12 }),
  ...weatherDay("2026-11-08", {}),
];

describe("WindWise MCP server", () => {
  it("lists all six tools with descriptions and read-only annotations", async () => {
    const c = await connect(fakeService({ weather: breezyDay }));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_locations",
      "find_wind_windows",
      "get_marine_conditions",
      "get_weather",
      "get_weather_summary",
      "get_wind_forecast",
    ]);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(50);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    // The activity presets are advertised to the model in all three wind-range tools.
    for (const name of ["find_wind_windows", "compare_locations", "get_weather_summary"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, { enum?: string[]; description?: string }>;
      };
      expect(schema.properties.activity?.enum).toEqual(["wing_foiling", "dinghy_sailing"]);
      expect(schema.properties.activity?.description).toContain("dinghy_sailing = 10-18 kn");
    }
  });

  it("find_wind_windows uses the dinghy_sailing preset (10-18 kn)", async () => {
    const weather = weatherDay("2026-11-07", { 10: 8, 11: 11, 12: 14, 13: 19, 14: 17, 15: 16, 16: 12 });
    const c = await connect(fakeService({ weather }));
    const { data } = await call(c, "find_wind_windows", { location: "Bucerias", activity: "dinghy_sailing" });

    expect(data.criteria).toMatchObject({ activity: "Dinghy sailing", minWindKn: 10, maxWindKn: 18 });
    // 10:00 is too light and 13:00 is too strong, so the day splits into two windows.
    expect(data.windows.map((w: { start: string; durationHours: number }) => [w.start, w.durationHours])).toEqual([
      ["2026-11-07T11:00", 2],
      ["2026-11-07T14:00", 3],
    ]);
  });

  it("explicit knots override the activity preset", async () => {
    const weather = weatherDay("2026-11-07", { 12: 14, 13: 19, 14: 17 });
    const c = await connect(fakeService({ weather }));
    const { data } = await call(c, "find_wind_windows", {
      location: "Bucerias",
      activity: "dinghy_sailing",
      max_wind_knots: 20,
    });
    expect(data.criteria).toMatchObject({ minWindKn: 10, maxWindKn: 20 });
    expect(data.bestWindow).toMatchObject({ start: "2026-11-07T12:00", durationHours: 3 });
  });

  it("get_weather_summary says too windy for dinghy sailing on a 25 kn day", async () => {
    const weather = weatherDay("2026-11-07", { 9: 22, 10: 24, 11: 25, 12: 25, 13: 24, 14: 23, 15: 22, 16: 21, 17: 20 });
    const c = await connect(fakeService({ weather, marine: marineDay("2026-11-07", 0.6) }));
    const { data } = await call(c, "get_weather_summary", {
      location: "Bucerias",
      day: "2026-11-07",
      activity: "dinghy_sailing",
    });
    expect(data).toMatchObject({ activity: "Dinghy sailing", windRangeKn: { min: 10, max: 18 }, verdict: "no_go" });
    expect(data.reasons[0]).toMatch(/Too windy: up to 25 kn, above the 18 kn limit/);
  });

  it("find_wind_windows returns the windows and the best one", async () => {
    const c = await connect(fakeService({ weather: breezyDay }));
    const { data } = await call(c, "find_wind_windows", { location: "Bucerias, Mexico", min_wind_knots: 12 });
    expect(data.found).toBe(true);
    expect(data.bestWindow).toMatchObject({
      start: "2026-11-07T11:00",
      end: "2026-11-07T16:00",
      durationHours: 5,
      maxWindKn: 17,
    });
    expect(data.attribution).toMatch(/Open-Meteo/);
  });

  it("find_wind_windows explains an empty result", async () => {
    const c = await connect(fakeService({ weather: breezyDay }));
    const { data } = await call(c, "find_wind_windows", { location: "Bucerias", min_wind_knots: 20 });
    expect(data.found).toBe(false);
    expect(data.whyNoWindows.too_light).toBeGreaterThan(0);
    expect(data.strongestHourInRange).toMatchObject({ time: "2026-11-07T13:00", windKn: 17 });
  });

  it("get_weather_summary combines weather and marine into a verdict", async () => {
    const service = fakeService({ weather: breezyDay, marine: marineDay("2026-11-07", 0.6) });
    const c = await connect(service);
    const { data } = await call(c, "get_weather_summary", { location: "Bucerias", day: "tomorrow" });
    expect(data).toMatchObject({
      date: "2026-11-07",
      verdict: "go",
      bestWindWindow: { durationHours: 5 },
      marine: { assessment: { seaState: "small", beginnerFriendly: true } },
    });
  });

  it("get_weather_summary still works when marine data is unavailable", async () => {
    const c = await connect(fakeService({ weather: breezyDay, marine: new NoMarineDataError() }));
    const { data } = await call(c, "get_weather_summary", { location: "Lake Somewhere", day: "2026-11-07" });
    expect(data.verdict).toBe("go");
    expect(data.marine.unavailable).toMatch(/no marine data/);
  });

  it("compare_locations ranks spots and flags shared grid cells", async () => {
    const service = fakeService({
      weather: breezyDay,
      marine: marineDay("2026-11-07", 0.6),
      grid: { "La Cruz": [20.758, -105.336], Bucerias: [20.758, -105.336], Sayulita: [20.87, -105.44] },
    });
    const c = await connect(service);
    const { data } = await call(c, "compare_locations", {
      locations: ["Bucerias", "La Cruz", "Sayulita", "Nowhere"],
      day: "tomorrow",
    });
    expect(data.ranking).toHaveLength(3);
    expect(data.failures).toEqual([{ location: "Nowhere", error: expect.stringContaining("Nowhere") }]);
    expect(data.notes[0]).toMatch(/Bucerias and La Cruz fall in the same forecast-model grid cell/);
  });

  it("rejects calls without a location", async () => {
    const c = await connect(fakeService({ weather: breezyDay }));
    const { isError, text } = await call(c, "get_wind_forecast", { days: 2 });
    expect(isError).toBe(true);
    expect(text).toMatch(/location name, or both latitude and longitude/);
  });

  it("rejects an inverted hour range with a clear message", async () => {
    const c = await connect(fakeService({ weather: breezyDay }));
    const { isError, text } = await call(c, "get_wind_forecast", { location: "Bucerias", start_hour: 18, end_hour: 9 });
    expect(isError).toBe(true);
    expect(text).toBe("end_hour (9) must be after start_hour (18).");
  });

  it("returns service failures as tool errors the model can read", async () => {
    const c = await connect(fakeService({ weather: breezyDay, marine: new NoMarineDataError() }));
    const { isError, text } = await call(c, "get_marine_conditions", { latitude: 48.85, longitude: 2.35 });
    expect(isError).toBe(true);
    expect(text).toMatch(/no marine data for this point/);
  });
});
