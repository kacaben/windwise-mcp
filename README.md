# WindWise MCP

[![CI](https://github.com/kacaben/windwise-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kacaben/windwise-mcp/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![MCP SDK](https://img.shields.io/badge/MCP%20SDK-v2-black)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

> A portfolio project, not production weather advice. Forecasts are model output; see
> [Limitations](#limitations-and-roadmap).

**An MCP server that lets AI agents answer "should I go out on the water?"** It combines
[Open-Meteo](https://open-meteo.com/)'s weather and marine forecasts and adds wind-sport
logic on top. It finds rideable wind windows, rates sea state, compares spots and gives
a go / marginal / no-go call with reasons.

It is not just a thin API wrapper. The API returns raw hourly columns. WindWise turns them
into the answers a wing-foiler, kiter or dinghy sailor actually needs, and is honest about
forecast uncertainty.

A real conversation in Claude, using the `dinghy_sailing` preset:

<p align="center">
  <img src="docs/Screenshot_windWiseMCP.png" alt="Claude answering &quot;When is a good time to go dinghy sailing tomorrow in Bucerías, Mexico?&quot; with WindWise: light wind peaking near 8 kn around 13:00, small waves, no thunderstorms, and a forecast caveat crediting Open-Meteo" width="760">
</p>

---

## Tools

| Tool                    | What it answers                                | Business logic beyond the API                                                                                       |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_weather`           | "What's the weather in Sayulita?"              | Weather codes → words, degrees → compass points, trims to the next _N_ hours                                        |
| `get_wind_forecast`     | "When is the wind strongest between 10 and 5?" | Per-day rollup: average/peak/peak time, strongest gust, **circular-mean** prevailing direction, Beaufort            |
| `get_marine_conditions` | "Are the waves OK for a beginner?"             | Hour-by-hour sea-state rating; short-period chop rates one level rougher than swell; detects inland points          |
| `find_wind_windows`     | "When is it 12–22 kn with gusts under 25?"     | Finds continuous windows across days, filters by direction and thunderstorms, **explains why** when nothing matches |
| `compare_locations`     | "Bucerías or La Cruz tomorrow?"                | Ranks 2–5 spots, tolerates partial failures, **flags spots in the same model grid cell**                            |
| `get_weather_summary`   | "Should I go out tomorrow?"                    | Combines weather and marine into a go / marginal / no-go verdict with human-readable reasons                        |

All tools are read-only (`readOnlyHint`) and validate their input with Zod. Each one publishes an
`outputSchema`, returns both text and `structuredContent`, and includes Open-Meteo attribution
and a forecast caveat. Forecasts always start from the current local hour, so a tool never
offers a wind window that has already passed.

### Activity presets

`find_wind_windows`, `compare_locations` and `get_weather_summary` accept an `activity`
instead of raw knots. Any explicit `min_wind_knots`, `max_wind_knots` or `max_gust_knots`
overrides the preset.

| `activity`       | Wind range   |
| ---------------- | ------------ |
| `wing_foiling`   | 12 kn and up |
| `dinghy_sailing` | 10–18 kn     |

With no activity and no `min_wind_knots`, the minimum defaults to 12 kn. All three tools
share `min_window_hours` (default 2), so they agree on what counts as a usable session.
To add a preset, add one line to `ACTIVITY_PRESETS` in `src/domain/activities.ts`. The tool
schemas and descriptions pick it up automatically.

A preset's maximum is not silently dropped: `activity: "dinghy_sailing"` with
`min_wind_knots: 20` fails with a message saying the 18 kn cap comes from the preset, and
asks you to pass `max_wind_knots` as well.

### Example: `find_wind_windows`

```jsonc
// Input
{
  "location": "Bucerias, Mexico",
  "min_wind_knots": 12,
  "max_wind_knots": 22,
  "max_gust_knots": 25,
  "start_hour": 9,
  "end_hour": 18,
  "directions": ["W", "WSW", "WNW", "SW"]   // onshore/cross-shore for this beach
}

// Output (example values, abridged)
{
  "found": true,
  "bestWindow": {
    "date": "2026-11-09", "start": "2026-11-09T13:00", "end": "2026-11-09T17:00",
    "durationHours": 4, "avgWindKn": 14.6, "maxWindKn": 16.8, "maxGustKn": 21.3,
    "direction": "WSW", "gusty": false
  },
  "windows": [ ... ],
  "attribution": "Weather data by Open-Meteo.com (CC BY 4.0) - https://open-meteo.com/"
}
```

When nothing matches, the tool still gives the agent something useful to say (example values):

```jsonc
{
  "found": false,
  "whyNoWindows": { "too_light": 27 },
  "strongestHourInRange": { "time": "2026-11-06T15:00", "windKn": 7.8, "gustKn": 21, "direction": "NNW" }
}
```

---

## How it's built

```
AI agent ──MCP over stdio──▶ tools/      6 tools · Zod input/output schemas · error mapping
                               ├──▶ domain/     pure functions: wind windows, sea state, verdicts, ranking
                               └──▶ openmeteo/  HTTP with timeouts and retry · response validation · geocoding cache
```

The highlights:

- **Tools depend on an interface, not on HTTP.** The integration tests run a real MCP client
  against the real server with a fake `WeatherService`, so there's no network and no `fetch` mocks.
- **Business logic is pure.** Everything in `domain/` takes arrays and returns data, and that is
  where most of the tests are.
- **Errors are for the model, bugs are for the developer.** Known failures return actionable
  `isError` results. Anything unexpected is logged and hidden from the model. Open-Meteo
  responses are validated with Zod, so an API change becomes one clear error rather than silent nulls.

  <img src="docs/Screenshot_windWiseMCP_error.png" alt="A WindWise tool call failing with &quot;Open-Meteo is unavailable right now (Could not reach Open-Meteo: fetch failed). Try again shortly.&quot;, followed by Claude calling the tools again" width="680">

  _When Open-Meteo could not be reached, the tool returned an `isError` result the model can
  read, not a crash or a stack trace. Claude read it and called the tools again on its own._
- **Forecasts start now, in the spot's local time.** Hours that have already passed are never
  offered, `days` means 24-hour periods from now, and times never pass through the server's time zone.
- **Honest about uncertainty.** Every answer carries a caveat, and `compare_locations` says when
  two towns share a forecast grid cell instead of pretending one is better.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the layer diagram, the source tree,
every design decision and how to add a tool.

---

## Getting started

Requires **Node.js 22 or newer**. No API key is needed.

```bash
git clone https://github.com/kacaben/windwise-mcp.git
cd windwise-mcp
npm install
npm run build
```

### Use it from Claude Code

```bash
claude mcp add windwise -- node /absolute/path/to/windwise-mcp/dist/index.js
```

### Use it from Claude Desktop (or any stdio MCP client)

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "windwise": {
      "command": "node",
      "args": ["/absolute/path/to/windwise-mcp/dist/index.js"]
    }
  }
}
```

Then try asking:

- _"Will there be enough wind for wing foiling in Bucerías tomorrow?"_
- _"Show me the wind forecast for the next three days between 10 AM and 5 PM."_
- _"Find 2-hour windows of 15–25 knots from the west in Cabarete this week."_
- _"When could I go dinghy sailing in Bucerías this week?"_
- _"Compare Bucerías, La Cruz de Huanacaxtle and Sayulita for tomorrow afternoon."_
- _"Are the waves likely to be manageable for a beginner in Sayulita?"_

You can also explore the tools interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Development

| Command             | What it does                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run dev`       | Run the server from source with `tsx`                                                                            |
| `npm run lint`      | Biome lint and format check, failing on warnings (`npm run format` fixes what it can)                            |
| `npm run typecheck` | Strict TypeScript check of `src`, `tests` and `scripts`                                                          |
| `npm run coverage`  | Tests with a V8 coverage report (about 97% of statements)                                                        |
| `npm test`          | Unit and integration tests (Vitest, no network)                                                                  |
| `npm run build`     | Compile to `dist/`                                                                                               |
| `npm run smoke`     | **Live** end-to-end test: spawns `dist/index.js` over stdio and calls every tool against the real Open-Meteo API |

### Tests

- **Domain unit tests:** wind windows (gaps, limits, direction filters, thunderstorms,
  midnight crossings, missing data), sea-state ratings including chop and worst-hour rating,
  verdict reasons, ranking, activity presets, units, local time and session-hour selection.
- **Integration-layer tests:** query building, Open-Meteo error payloads, retry/backoff,
  timeouts, response validation (missing variables, mismatched lengths, changed time format),
  cancellation, geocoding disambiguation (the "Sydney, US" regression and aliases such as
  "UK" and "USA"), "did you mean" suggestions, LRU eviction and inland detection. These use
  a fake `fetch`.
- **MCP server tests:** a real `Client` connected through `InMemoryTransport` checks every
  tool's output, input and output schemas, validation errors, past-hour filtering, grid-cell
  choice, partial failures in `compare_locations`, time-zone date mismatches and hidden
  internal errors, with a fake `WeatherService`.

There is one test file per module. `npm run coverage` prints a per-file report.

CI runs lint, typecheck, tests and build on Node 22 and 24 for every push and pull request. A
separate weekly workflow runs the live smoke test to catch upstream API changes.

### Adding a tool

See [Adding a tool](docs/ARCHITECTURE.md#adding-a-tool) in the architecture notes.

---

## Limitations and roadmap

- These are model forecasts. Sea breezes and thermal winds, which matter a lot in Banderas
  Bay, are often under-forecast by global models.
- Marine data has ~5 km resolution and is less reliable inside bays and near the shore.
- Wave ratings are deliberately simple and conservative: height bands, with short-period
  chop rated one level rougher than swell of the same height. They are a hint, not safety
  advice, and they don't account for wave direction or the shape of the beach.
- The go / marginal / no-go verdict looks at wind, gusts, thunderstorms and waves. It ignores
  rain, temperature and the rider's skill level.
- Any thunderstorm hour in the session makes the whole day `no_go`, even when a clean window
  comes before it. That is deliberately conservative; the windows are still listed.
- The wind tools use the sea grid cell, so the temperature and rain in `get_weather_summary`
  describe the water cell, not the town. `get_weather` uses the land cell.
- `compare_locations` takes place names only, not coordinates, and waves are just a
  tie-breaker in its ranking.
- Forecasts are not cached (only place lookups are), and a rate-limited request is retried
  once after a short delay, ignoring `Retry-After`.
- Prevailing direction is an unweighted vector mean, so a few calm hours from another
  direction can pull it around.

Ideas for later:

- [ ] Short-TTL forecast cache and `Retry-After` handling
- [ ] Coordinates and a direction filter for `compare_locations`; weigh waves in the ranking
- [ ] Skill-level input for the sea-state rating and verdict
- [ ] Compare several weather models (ECMWF, GFS, ICON) side by side to show forecast spread
- [ ] Verify past forecasts against Open-Meteo's historical data to measure local bias
- [ ] Tide data, and "offshore wind" warnings computed from each spot's beach orientation
- [ ] Streamable HTTP transport for remote deployment

---

## Attribution and license

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free Open-Meteo API is for
non-commercial use.

Code licensed under the [MIT License](LICENSE).
