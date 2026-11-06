import { describe, expect, it, vi } from "vitest";
import { columnsToRows } from "../src/openmeteo/columns.js";
import { fetchWeatherForecast } from "../src/openmeteo/forecast.js";
import {
  createGeocoder,
  LocationNotFoundError,
  parseLocationQuery,
  pickBestResult,
} from "../src/openmeteo/geocoding.js";
import { type FetchLike, getJson, OpenMeteoError } from "../src/openmeteo/http.js";
import { fetchMarineForecast, NoMarineDataError } from "../src/openmeteo/marine.js";
import { jsonResponse } from "./helpers.js";

const fastRetry = { retryDelayMs: 0 };

describe("getJson", () => {
  it("builds the query string, joining arrays with commas", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ ok: 1 }));
    await getJson("https://example.test/v1", { hourly: ["a", "b"], days: 2, skip: undefined }, { fetch });
    expect(fetch.mock.calls[0]![0]).toBe("https://example.test/v1?hourly=a%2Cb&days=2");
  });

  it("turns Open-Meteo error payloads into bad_request errors without retrying", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: true, reason: "Latitude must be in range of -90 to 90°." }, 400),
    );
    const error = await getJson<never>("https://example.test", {}, { fetch, ...fastRetry }).catch(
      (e: unknown) => e as OpenMeteoError,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect(error).toMatchObject({ kind: "bad_request", status: 400 });
    expect(error.message).toContain("Latitude must be in range");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on 5xx and then succeeds", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ error: true, reason: "busy" }, 503))
      .mockResolvedValueOnce(jsonResponse({ value: 42 }));
    await expect(getJson("https://example.test", {}, { fetch, ...fastRetry })).resolves.toEqual({
      value: 42,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured retries", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      getJson("https://example.test", {}, { fetch, retries: 2, ...fastRetry }),
    ).rejects.toMatchObject({
      kind: "network",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reports timeouts distinctly", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    await expect(
      getJson("https://example.test", {}, { fetch, timeoutMs: 20, retries: 0 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("columnsToRows", () => {
  it("pivots column arrays into rows and normalises missing values to null", () => {
    const rows = columnsToRows({ time: ["t0", "t1"], a: [1, null], b: [2] }, ["a", "b", "c"]);
    expect(rows).toEqual([
      { time: "t0", a: 1, b: 2, c: null },
      { time: "t1", a: null, b: null, c: null },
    ]);
  });
});

describe("geocoding", () => {
  const results = [
    {
      name: "San Jose",
      latitude: 37.3,
      longitude: -121.9,
      country: "United States",
      country_code: "US",
      admin1: "California",
    },
    {
      name: "San José",
      latitude: 9.9,
      longitude: -84.1,
      country: "Costa Rica",
      country_code: "CR",
      admin1: "San José",
    },
  ];

  it("splits a query into a name and qualifiers", () => {
    expect(parseLocationQuery(" Bucerias , Nayarit, México ")).toEqual({
      name: "Bucerias",
      qualifiers: ["nayarit", "mexico"],
    });
  });

  it("uses qualifiers to disambiguate, accent-insensitively", () => {
    expect(pickBestResult(results, [])?.country).toBe("United States");
    expect(pickBestResult(results, ["costa rica"])?.country).toBe("Costa Rica");
    expect(pickBestResult(results, ["cr"])?.country).toBe("Costa Rica");
    expect(pickBestResult(results, ["mexico"])).toBeUndefined();
  });

  it("matches country codes exactly and names as whole words (regression: 'Sydney, US')", () => {
    const sydneys = [
      {
        name: "Sydney",
        latitude: -33.9,
        longitude: 151.2,
        country: "Australia",
        country_code: "AU",
        admin1: "New South Wales",
      },
      {
        name: "Sydney",
        latitude: 46.1,
        longitude: -60.2,
        country: "Canada",
        country_code: "CA",
        admin1: "Nova Scotia",
      },
      {
        name: "Sydney",
        latitude: 47.7,
        longitude: -104.2,
        country: "United States",
        country_code: "US",
        admin1: "Montana",
      },
    ];
    // "us" is a substring of "australia"; it must not match it.
    expect(pickBestResult(sydneys, ["us"])?.admin1).toBe("Montana");
    expect(pickBestResult(sydneys, ["ca"])?.admin1).toBe("Nova Scotia");
    expect(pickBestResult(sydneys, ["south wales"])?.country).toBe("Australia");
    expect(pickBestResult(sydneys, ["wales"])?.country).toBe("Australia");
    expect(pickBestResult(sydneys, ["ales"])).toBeUndefined();
  });

  it("suggests candidates when the qualifier rules them all out", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ results }));
    await expect(createGeocoder({ fetch }).resolve("San Jose, Mexico")).rejects.toThrow(
      'No place called "San Jose, Mexico". Did you mean: San Jose, California, United States; San José, San José, Costa Rica?',
    );
  });

  it("keeps the cache bounded, evicting the least recently used place", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ results }));
    const geocoder = createGeocoder({ fetch }, 2);
    await geocoder.resolve("San Jose, US");
    await geocoder.resolve("San Jose, CR");
    await geocoder.resolve("San Jose, US"); // refreshes US, so CR is now the oldest
    await geocoder.resolve("San Jose, California"); // evicts CR
    expect(fetch).toHaveBeenCalledTimes(3);
    await geocoder.resolve("San Jose, US");
    expect(fetch).toHaveBeenCalledTimes(3);
    await geocoder.resolve("San Jose, CR");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("caches successful lookups and reports unknown places", async () => {
    const fetch = vi.fn<FetchLike>(async (url) => jsonResponse(url.includes("Nowhere") ? {} : { results }));
    const geocoder = createGeocoder({ fetch });

    const first = await geocoder.resolve("San Jose, Costa Rica");
    const second = await geocoder.resolve("san josé, costa rica");
    expect(first).toEqual(second);
    expect(first).toMatchObject({ latitude: 9.9, source: "geocoded" });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(geocoder.resolve("Nowhere")).rejects.toBeInstanceOf(LocationNotFoundError);
  });
});

describe("forecast and marine fetchers", () => {
  it("maps forecast columns to typed hours and requests knots in local time", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({
        latitude: 20.7,
        longitude: -105.27,
        timezone: "America/Bahia_Banderas",
        current: { time: "2026-11-06T16:30", wind_speed_10m: 7.3, weather_code: 0 },
        hourly: {
          time: ["2026-11-06T00:00"],
          wind_speed_10m: [4.2],
          wind_gusts_10m: [9],
          wind_direction_10m: [300],
        },
      }),
    );
    const forecast = await fetchWeatherForecast(
      { latitude: 20.75, longitude: -105.33 },
      { days: 2, cell: "sea" },
      { fetch },
    );

    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get("wind_speed_unit")).toBe("kn");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("forecast_days")).toBe("2");
    expect(url.searchParams.get("cell_selection")).toBe("sea");
    expect(forecast.currentHour).toBe("2026-11-06T16:00");
    expect(forecast.current.windKn).toBe(7.3);
    expect(forecast.hours[0]).toMatchObject({
      time: "2026-11-06T00:00",
      windKn: 4.2,
      gustKn: 9,
      temperatureC: null,
    });
  });

  it("raises NoMarineDataError for inland points (all-null wave data)", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({
        latitude: 48.8,
        longitude: 2.3,
        timezone: "Europe/Paris",
        utc_offset_seconds: 3600,
        hourly: { time: ["2026-11-06T00:00", "2026-11-06T01:00"], wave_height: [null, null] },
      }),
    );
    await expect(
      fetchMarineForecast({ latitude: 48.85, longitude: 2.35 }, 1, { fetch }),
    ).rejects.toBeInstanceOf(NoMarineDataError);
  });
});
