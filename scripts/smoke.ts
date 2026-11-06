/**
 * End-to-end smoke test against the real Open-Meteo API.
 *
 * Spawns the built server over stdio exactly like an MCP client (Claude Desktop,
 * Claude Code, Cursor...) would, lists the tools, and calls each one once.
 *
 *   npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const calls: Array<[name: string, args: Record<string, unknown>]> = [
  ["get_weather", { location: "Bucerias, Mexico", hours: 6 }],
  ["get_wind_forecast", { location: "Bucerias, Mexico", days: 2, start_hour: 10, end_hour: 17 }],
  ["get_marine_conditions", { location: "Bucerias, Mexico", days: 1 }],
  ["find_wind_windows", { location: "Bucerias, Mexico", min_wind_knots: 10, max_gust_knots: 25 }],
  ["compare_locations", { locations: ["Bucerias, Mexico", "La Cruz de Huanacaxtle", "Sayulita"], day: "tomorrow" }],
  ["get_weather_summary", { location: "Bucerias, Mexico", day: "tomorrow" }],
  // Expected to fail gracefully:
  ["get_marine_conditions", { location: "Paris, France" }],
  ["get_weather", { location: "Xyzzyqwerty" }],
];

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "windwise-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Tools: ${tools.map((t) => t.name).join(", ")}\n`);

let unexpected = 0;
for (const [index, [name, args]] of calls.entries()) {
  const expectError = index >= calls.length - 2;
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  const status = result.isError ? "ERROR" : "ok";
  if (Boolean(result.isError) !== expectError) unexpected++;
  console.log(`--- ${name} ${JSON.stringify(args)} -> ${status}`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n... (${text.length} chars)` : text);
  console.log();
}

await client.close();
if (unexpected > 0) {
  console.error(`${unexpected} call(s) did not behave as expected.`);
  process.exit(1);
}
console.log("Smoke test passed.");
