/**
 * End-to-end smoke test against the real Open-Meteo API.
 *
 * Spawns the built server over stdio exactly like an MCP client (Claude Desktop,
 * Claude Code, Cursor...) would, lists the tools, and calls each one.
 *
 *   npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

interface SmokeCall {
  name: string;
  args: Record<string, unknown>;
  /** Whether the call should succeed or come back as a graceful tool error. */
  expect: "ok" | "error";
  /** Extra assertion on the parsed result; return a problem description, or nothing. */
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc checks on parsed JSON from a live tool call
  check?: (data: Record<string, any>) => string | undefined;
}

const calls: SmokeCall[] = [
  { name: "get_weather", args: { location: "Bucerias, Mexico", hours: 6 }, expect: "ok" },
  {
    name: "get_wind_forecast",
    args: { location: "Bucerias, Mexico", days: 2, start_hour: 10, end_hour: 17 },
    expect: "ok",
  },
  { name: "get_marine_conditions", args: { location: "Bucerias, Mexico", days: 1 }, expect: "ok" },
  {
    name: "find_wind_windows",
    args: { location: "Bucerias, Mexico", min_wind_knots: 0, start_hour: 0, end_hour: 24, days: 1 },
    expect: "ok",
    // Regression: windows must never start before the current hour.
    check: (d) => {
      const nowHour = d.notes[0].match(/local (\d\d:\d\d)/)?.[1];
      const first = d.windows[0]?.start.slice(11);
      return first && nowHour && first < nowHour
        ? `window starts at ${first}, before now (${nowHour})`
        : undefined;
    },
  },
  {
    name: "find_wind_windows",
    args: { location: "Bucerias, Mexico", activity: "dinghy_sailing", days: 7 },
    expect: "ok",
  },
  {
    name: "compare_locations",
    args: { locations: ["Bucerias, Mexico", "La Cruz de Huanacaxtle", "Sayulita"], day: "tomorrow" },
    expect: "ok",
  },
  { name: "get_weather_summary", args: { location: "Bucerias, Mexico", day: "tomorrow" }, expect: "ok" },
  {
    name: "get_weather",
    args: { location: "Sydney, US", hours: 1 },
    expect: "ok",
    // Regression: "us" must not match "Australia".
    check: (d) => (d.location.country === "United States" ? undefined : `resolved to ${d.location.country}`),
  },
  { name: "get_marine_conditions", args: { location: "Paris, France" }, expect: "error" },
  { name: "get_weather", args: { location: "Xyzzyqwerty" }, expect: "error" },
];

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "windwise-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Tools: ${tools.map((t) => t.name).join(", ")}\n`);

const problems: string[] = [];
for (const { name, args, expect, check } of calls) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  const status = result.isError ? "error" : "ok";
  const label = `${name} ${JSON.stringify(args)}`;

  if (status !== expect) problems.push(`${label}: expected ${expect}, got ${status}`);
  const problem = status === "ok" ? check?.(JSON.parse(text)) : undefined;
  if (problem) problems.push(`${label}: ${problem}`);

  console.log(`--- ${label} -> ${status}${problem ? ` (FAILED CHECK: ${problem})` : ""}`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n... (${text.length} chars)` : text);
  console.log();
}

await client.close();
if (problems.length > 0) {
  console.error(`Smoke test failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("Smoke test passed.");
