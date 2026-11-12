import { McpServer } from "@modelcontextprotocol/server";
import { createOpenMeteoService, type WeatherService } from "./openmeteo/client.js";
import { registerCompareLocations } from "./tools/compareLocations.js";
import { registerFindWindWindows } from "./tools/findWindWindows.js";
import { registerGetMarineConditions } from "./tools/getMarineConditions.js";
import { registerGetWeather } from "./tools/getWeather.js";
import { registerGetWeatherSummary } from "./tools/getWeatherSummary.js";
import { registerGetWindForecast } from "./tools/getWindForecast.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "windwise-mcp";
export const SERVER_VERSION = VERSION;

const INSTRUCTIONS = `WindWise gives you weather, wind and marine forecasts from Open-Meteo.
- Wind speeds are in knots; wind and swell directions say where they come FROM.
- All times are local to the location being asked about, never the user's own time zone.
- Start with get_weather_summary for "should I go out?" questions, find_wind_windows to find
  the best hours, and compare_locations to choose between spots.
- These are model forecasts. Always mention uncertainty and credit Open-Meteo when you
  present the data.`;

/** Every tool, in one place. Adding a tool = write a register function and list it here. */
const TOOLS = [
  registerGetWeather,
  registerGetWindForecast,
  registerGetMarineConditions,
  registerFindWindWindows,
  registerCompareLocations,
  registerGetWeatherSummary,
] as const;

export function createServer(service: WeatherService = createOpenMeteoService()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  for (const register of TOOLS) register(server, service);
  return server;
}
