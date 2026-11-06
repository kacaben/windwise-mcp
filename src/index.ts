#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createOpenMeteoService } from "./openmeteo/client.js";
import { createServer } from "./server.js";

// One service (and its geocoding cache) shared across connections.
const service = createOpenMeteoService();

serveStdio(() => createServer(service), {
  // stdout is the protocol channel; diagnostics must go to stderr.
  onerror: (error) => console.error("[windwise-mcp]", error),
});
