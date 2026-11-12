import { describe, expect, it, vi } from "vitest";
import { createOpenMeteoService } from "../src/openmeteo/client.js";
import { columnsToRows } from "../src/openmeteo/columns.js";
import { fetchWeatherForecast } from "../src/openmeteo/forecast.js";
import {
  createGeocoder,
  LocationNotFoundError,
  parseLocationQuery,
  pickBestResult,
  QUALIFIED_RESULT_COUNT,
} from "../src/openmeteo/geocoding.js";
import { type FetchLike, getJson, OpenMeteoError } from "../src/openmeteo/http.js";
import { fetchMarineForecast, NoMarineDataError } from "../src/openmeteo/marine.js";
import { forecastBody, jsonResponse, marineBody } from "./helpers.js";

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

  it("reports a timeout while reading the body as a timeout, and retries it", async () => {
    const slowBody = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    } as unknown as Response;
    const fetch = vi.fn<FetchLike>(async () => slowBody);
    await expect(
      getJson("https://example.test", {}, { fetch, retries: 1, ...fastRetry }),
    ).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("still reports a genuinely non-JSON body as an upstream error", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(getJson("https://example.test", {}, { fetch, retries: 0 })).rejects.toMatchObject({
      kind: "upstream",
      status: 200,
    });
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
      jsonResponse(
        forecastBody(
          ["2026-11-06T00:00"],
          { wind_speed_10m: [4.2], wind_gusts_10m: [9], wind_direction_10m: [300] },
          { wind_speed_10m: 7.3, weather_code: 0 },
        ),
      ),
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
      jsonResponse(marineBody(["2026-11-06T00:00", "2026-11-06T01:00"])),
    );
    await expect(
      fetchMarineForecast({ latitude: 48.85, longitude: 2.35 }, 1, { fetch }),
    ).rejects.toBeInstanceOf(NoMarineDataError);
  });

  it("maps marine columns to typed hours", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse(marineBody(["2026-11-06T00:00"], { wave_height: [0.8], swell_wave_period: [11] })),
    );
    const marine = await fetchMarineForecast({ latitude: 20.7, longitude: -105.3 }, 1, { fetch });
    expect(marine.hours[0]).toMatchObject({ waveHeightM: 0.8, swellPeriodS: 11, currentKn: null });
  });
});

describe("response validation", () => {
  const times = ["2026-11-06T00:00", "2026-11-06T01:00"];
  const coords = { latitude: 20.7, longitude: -105.3 };

  async function forecastError(body: unknown) {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(body));
    const error = await fetchWeatherForecast(coords, { days: 1 }, { fetch, ...fastRetry }).then(
      () => {
        throw new Error("expected the response to be rejected");
      },
      (e: unknown) => e as OpenMeteoError,
    );
    return { error, calls: fetch.mock.calls.length };
  }

  it("names a hourly variable that disappeared from the response, and does not retry", async () => {
    const body = forecastBody(times);
    delete (body.hourly as Record<string, unknown>).wind_gusts_10m;
    const { error, calls } = await forecastError(body);
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain("wind_gusts_10m");
    expect(error.message).toContain("missing hourly variable");
    expect(calls).toBe(1);
  });

  it("rejects a series whose length does not match the time axis", async () => {
    const { error } = await forecastError(forecastBody(times, { wind_speed_10m: [5] }));
    expect(error.message).toContain("has 1 values for 2 time steps");
    expect(error.message).toContain("hourly.wind_speed_10m");
  });

  it("rejects non-numeric values and an unexpected time format", async () => {
    expect((await forecastError(forecastBody(times, { wind_speed_10m: ["5", 6] }))).error.message).toContain(
      "non-numeric",
    );
    expect(
      (await forecastError(forecastBody(["2026-11-06T00:00:00Z", "2026-11-06T01:00:00Z"]))).error.message,
    ).toContain("YYYY-MM-DDTHH:MM");
  });

  it("rejects an empty forecast instead of failing later on hours[0]", async () => {
    const body = forecastBody(times);
    body.hourly = { ...body.hourly, time: [] };
    for (const key of Object.keys(body.hourly)) {
      if (key !== "time") (body.hourly as Record<string, unknown>)[key] = [];
    }
    expect((await forecastError(body)).error.message).toContain("no hourly time steps");
  });

  it("rejects a missing current value", async () => {
    const body = forecastBody(times);
    delete (body.current as Record<string, unknown>).wind_speed_10m;
    expect((await forecastError(body)).error.message).toContain("missing or non-numeric current value");
  });

  it("validates marine and geocoding responses too", async () => {
    const marineFetch = vi.fn<FetchLike>(async () => jsonResponse({ hourly: { time: times } }));
    await expect(fetchMarineForecast(coords, 1, { fetch: marineFetch })).rejects.toMatchObject({
      kind: "invalid_response",
    });

    const geoFetch = vi.fn<FetchLike>(async () => jsonResponse({ results: [{ name: "Bucerias" }] }));
    await expect(createGeocoder({ fetch: geoFetch }).resolve("Bucerias")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});

describe("geocoder cache", () => {
  it("does not let an evicted, failing lookup remove a newer entry for the same place", async () => {
    let failFirst: (reason: Error) => void = () => {};
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockImplementation(async () =>
        jsonResponse({ results: [{ name: "San Jose", latitude: 37.3, longitude: -121.9 }] }),
      );
    const geocoder = createGeocoder({ fetch, retries: 0 }, 1);

    const first = geocoder.resolve("San Jose").catch(() => "failed");
    await geocoder.resolve("Other"); // evicts the pending "San Jose" lookup
    await geocoder.resolve("San Jose"); // a fresh lookup, now cached
    failFirst(new TypeError("fetch failed"));
    expect(await first).toBe("failed");

    const calls = fetch.mock.calls.length;
    await geocoder.resolve("San Jose");
    expect(fetch.mock.calls.length).toBe(calls); // still served from the cache
  });
});

describe("country aliases and result count", () => {
  const brightons = [
    { name: "Brighton", latitude: -37.9, longitude: 145.0, country: "Australia", country_code: "AU" },
    { name: "Brighton", latitude: 50.8, longitude: -0.1, country: "United Kingdom", country_code: "GB" },
    { name: "Brighton", latitude: 42.5, longitude: -83.8, country: "United States", country_code: "US" },
  ];

  it.each([
    ["uk", "GB"],
    ["u.k.", "GB"],
    ["great britain", "GB"],
    ["usa", "US"],
    ["u.s.a.", "US"],
    ["united states of america", "US"],
  ])("resolves the qualifier %s to country code %s", (qualifier, code) => {
    expect(pickBestResult(brightons, [qualifier])?.country_code).toBe(code);
  });

  it("asks Open-Meteo for more results when a qualifier has to be matched", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ results: brightons }));
    const geocoder = createGeocoder({ fetch });
    await geocoder.resolve("Brighton");
    await geocoder.resolve("Brighton, UK");
    const counts = fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("count"));
    expect(counts).toEqual(["10", String(QUALIFIED_RESULT_COUNT)]);
  });
});

describe("cancellation", () => {
  it("stops without retrying when the caller's signal aborts mid-request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          controller.abort();
        }),
    );
    await expect(
      getJson("https://example.test", {}, { fetch, retries: 2, ...fastRetry }, controller.signal),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start a request when already cancelled", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({}));
    await expect(getJson("https://example.test", {}, { fetch }, AbortSignal.abort())).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still reports its own timeout as a timeout when a caller signal is passed", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    await expect(
      getJson("https://example.test", {}, { fetch, timeoutMs: 20, retries: 0 }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("createOpenMeteoService", () => {
  it("uses coordinates as given, geocodes names, and passes the abort signal to fetch", async () => {
    const fetch = vi.fn<FetchLike>(async (url) =>
      url.includes("geocoding")
        ? jsonResponse({
            results: [{ name: "Bucerias", latitude: 20.75, longitude: -105.33, country: "Mexico" }],
          })
        : jsonResponse(forecastBody(["2026-11-06T00:00"])),
    );
    const service = createOpenMeteoService({ fetch });

    expect(await service.resolveLocation({ latitude: 20.7512, longitude: -105.3349 })).toMatchObject({
      name: "20.7512, -105.3349",
      source: "coordinates",
    });
    expect(await service.resolveLocation({ location: "Bucerias" })).toMatchObject({
      latitude: 20.75,
      source: "geocoded",
    });
    await expect(service.resolveLocation({})).rejects.toThrow(/location name or both latitude and longitude/);

    const controller = new AbortController();
    await service.getWeather(
      { name: "Bucerias", latitude: 20.75, longitude: -105.33, source: "geocoded" },
      { days: 1 },
      controller.signal,
    );
    const init = fetch.mock.calls.at(-1)![1]!;
    controller.abort();
    expect(init.signal!.aborted).toBe(true);
  });
});
